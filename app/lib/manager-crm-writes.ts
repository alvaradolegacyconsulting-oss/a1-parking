// Manager CRM write cores — extracted from app/manager/page.tsx per the
// Build-2 arc so the mobile view (app/manager/mobile) can reuse the same
// write semantics without a third resident-approve path.
//
// What's extracted:
//   • Shared machinery: callSyncOnAdd, notifyResidentDecision,
//     trimDepartedResidentVehicles (all moved verbatim).
//   • Batch primitive: approveVehiclesBatch — the loop-and-meter-once
//     shape composed by BOTH runBulkApprove phase-2 AND per-row cascade.
//     Meter-once (B147) discipline lives here in exactly one place.
//   • Read helper: listPendingVehiclesForUnit — surface fetches once
//     for its prompt count, passes the ids to approveVehiclesBatch.
//   • Write cores: approveResidentWrite, approveVehicleWrite,
//     declineResidentWrite, declineVehicleWrite. Atomic. NO setters,
//     NO alerts, NO refetch — surfaces own UI.
//   • Bulk orchestration: runBulkApprove — full 2-phase ordered
//     combined action + allow-list gate + one post-batch sync.
//     Anti-optimization comment lives on the function; do NOT
//     parallelize the phases.
//
// What stays in the surface (both desktop and mobile own):
//   • window.confirm dialogs (PM-only billing prompts, bulk-approve confirm)
//   • alert() calls (bulk summary, assign_space soft-fail)
//   • Setters (setResidentNotes, setUnitNotes, setPendingNotes,
//     setPendingResidentAssignSpaceId)
//   • Refetches (refreshCrmData, refetchSpacesDashboard)
//   • assign_space RPC (desktop per-row only — mobile never assigns spaces)
//   • Space-related state closures
//
// PM-only cascade on mobile: DO NOT cascade. Vehicles stay pending and
// appear in the mobile pending list; approving them is an explicit action.
// The pending list IS the confirmation on mobile — see
// feedback_mobile_pending_list_is_the_confirmation.md.
//
// Log tag convention preserved: [B147-sync-*], [approve_vehicle],
// [B166-owner-trim-*], [Manager approveAllPendingCrm], [resident-decision-email]
// — grep for these tags continues to work.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logAudit } from './audit'
import { escapeIlikeValue } from './supabase-query-escape'
import type { BulkApproveSummaryInput } from './bulk-approve-summary'
import type { OccupancyStamp, UnitOccupancyMap } from './unit-occupancy'
import { buildOccupancyStamp } from './unit-occupancy'
import {
  isValidResidentReason,
  isValidVehicleReason,
  reasonRequiresNote,
  DEACTIVATION_NOTE_MAX_LENGTH,
} from './deactivation-reasons'

// ══════════════════════════════════════════════════════════════════════
// Shared machinery
// ══════════════════════════════════════════════════════════════════════

export async function callSyncOnAdd(
  companyId: number,
  kind: 'property' | 'driver' | 'permit',
): Promise<{ ok: true; action: string } | { ok: false; reason: string }> {
  try {
    const res = await fetch('/api/billing/sync-on-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_id: companyId, kind }),
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok && json.ok) {
      return { ok: true, action: String(json.action ?? 'unknown') }
    }
    return { ok: false, reason: String(json.reason ?? json.error ?? `HTTP ${res.status}`) }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}

export async function notifyResidentDecision(args: {
  residentId: string
  decision: 'approved' | 'declined'
  note: string | null
}): Promise<{ ok: boolean; message_id: string | null }> {
  try {
    const res = await fetch('/api/manager/notify-resident-decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    const j = await res.json().catch(() => ({}))
    if (res.ok && j.ok) {
      return { ok: true, message_id: j.message_id || null }
    }
    console.error('[resident-decision-email] failed:', j.error || res.statusText)
    return { ok: false, message_id: null }
  } catch (e) {
    console.error('[resident-decision-email] threw:', e)
    return { ok: false, message_id: null }
  }
}

// B166 owner-trim — defensive UPDATE against any historical active vehicle
// owned by this email at (unit, property). Used by declineResidentWrite
// (and by DEACTIVATE_RESIDENT handler in the surface — that call site
// prepends supabase, keeps the rest of its positional args, matches the
// pre-extraction shape verbatim).
//
// 🔴 OWNERSHIP GUARD (added 2026-08-05 after Green Acres resident 690):
// Before trimming, check whether the email owns an OTHER active residency
// at the same property (regardless of unit spelling). If yes, this is a
// duplicate-identity case — the surviving row still needs those vehicles.
// Skip the trim entirely and log it. The log line is the deliverable —
// tells a human that duplicate identity blocked a cascade, which is
// exactly the signal the residents-duplicate-row-uniqueness backlog needs.
//
// The guard keys on (email, property) — NEVER on unit. Unit values are
// free-text with confirmed variance (`136` / `Apt 136` / `#67`); a guard
// keyed on unit would have the same blind spot as the cascade it protects.
//
// 🔴 EXPLICIT excludeResidentId (Mateo Aug 5): the guard would silently
// disable itself if trim were ever called from a path where the target
// resident is still is_active=TRUE — the guard would count that row as
// its own active sibling and skip every time, logging
// B166_OWNER_TRIM_SKIPPED while looking like it's working. Pass the
// deactivating resident's id here and the guard filters it out of the
// sibling count. Correct regardless of call ordering.
export async function trimDepartedResidentVehicles(
  supabase: SupabaseClient,
  rawEmail: string | null | undefined,
  rawUnit: string | null | undefined,
  rawProperty: string | null | undefined,
  sourceAction: string,
  excludeResidentId?: string | number | null,
): Promise<void> {
  if (!rawEmail || !rawUnit || !rawProperty) return
  const email = rawEmail.trim().toLowerCase()
  const unit = rawUnit.trim()
  const property = rawProperty.trim()
  if (!email || !unit || !property) return

  // Ownership guard — count ACTIVE residents at this property with the
  // same lowered email, EXCLUDING the resident being deactivated (see
  // header). Any hit = duplicate identity, another row of this person
  // still needs their vehicles. Skip the trim.
  let guardQuery = supabase
    .from('residents')
    .select('id', { count: 'exact', head: true })
    .eq('email', email)
    .ilike('property', escapeIlikeValue(property))
    .eq('is_active', true)
  if (excludeResidentId !== undefined && excludeResidentId !== null && excludeResidentId !== '') {
    guardQuery = guardQuery.neq('id', excludeResidentId)
  }
  const { count: siblingActive, error: guardErr } = await guardQuery
  if (guardErr) {
    console.error('[B166-owner-trim-guard-failed]', { sourceAction, email, property, error: guardErr.message })
    return
  }
  if ((siblingActive ?? 0) > 0) {
    console.warn('[B166-owner-trim-skipped-duplicate-identity]', {
      sourceAction, email, property, unit,
      sibling_active_residents: siblingActive,
      excluded_resident_id: excludeResidentId ?? null,
      reason: 'Owner still has an OTHER active residency at this property (possibly under a different unit spelling). Vehicles left untouched. See docs/backlog/residents-duplicate-row-uniqueness.md.',
    })
    await logAudit({
      action: 'B166_OWNER_TRIM_SKIPPED',
      table_name: 'vehicles',
      new_values: {
        source: sourceAction,
        reason: 'duplicate_identity_still_active',
        email,
        property,
        unit_of_deactivated_row: unit,
        excluded_resident_id: excludeResidentId ?? null,
        sibling_active_residents: siblingActive,
      },
    })
    return
  }
  // Email: .eq() on the lowercased value — forward stamps are all lowercase;
  // historical mixed-case rows wiped pre-launch; .eq() avoids ILIKE wildcard
  // injection (underscores in email local-parts would over-match on a
  // destructive UPDATE).
  // Unit/property: keep ILIKE for case-insensitivity but escape any embedded
  // % or _ in the user-entered values.
  const { data: matched, error } = await supabase
    .from('vehicles')
    .update({ is_active: false })
    .eq('resident_email', email)
    .ilike('unit', escapeIlikeValue(unit))
    .ilike('property', escapeIlikeValue(property))
    .eq('is_active', true)
    .select('id, plate')
  if (error) {
    console.error('[B166-owner-trim-failed]', { sourceAction, email, property, unit, error: error.message })
    return
  }
  const affected = matched?.length || 0
  if (affected > 0) {
    // F6 verify-after-write: re-SELECT the matched ids and confirm
    // is_active=false. Non-fatal; log mismatch.
    const { data: verify } = await supabase
      .from('vehicles')
      .select('id, is_active')
      .in('id', matched!.map(v => v.id))
    const mismatched = (verify || []).filter(v => v.is_active !== false)
    if (mismatched.length > 0) {
      console.error('[B166-owner-trim-verify-mismatch]', { sourceAction, email, property, unit, affected, mismatchedCount: mismatched.length })
    }
    await logAudit({
      action: 'B166_OWNER_TRIM',
      table_name: 'vehicles',
      new_values: {
        source: sourceAction,
        resident_email: email,
        property,
        unit,
        vehicles_affected: affected,
        plates: matched!.map(v => v.plate),
      },
    })
  }
}

// ══════════════════════════════════════════════════════════════════════
// Read helpers
// ══════════════════════════════════════════════════════════════════════

// Surface fetches this once for its prompt count and passes the ids to
// approveVehiclesBatch. Prevents the double-query shape (surface queries
// for count + primitive queries for ids).
export async function listPendingVehiclesForUnit(
  supabase: SupabaseClient,
  args: { unit: string; property: string },
): Promise<{ id: string; plate: string | null }[]> {
  const { unit, property } = args
  const { data, error } = await supabase
    .from('vehicles')
    .select('id, plate')
    .ilike('unit', escapeIlikeValue(unit))
    .ilike('property', escapeIlikeValue(property))
    .eq('status', 'pending')
  if (error) {
    console.error('[listPendingVehiclesForUnit] fetch failed', { unit, property, error })
    return []
  }
  return data ?? []
}

// ══════════════════════════════════════════════════════════════════════
// Batch primitive — the shared meter-once shape
// ══════════════════════════════════════════════════════════════════════

export type VehicleForBatch = { id: string; plate?: string | null; unit?: string | null }

// One loop, ONE post-batch sync. B147 meter-once discipline in exactly
// one place. Both runBulkApprove's phase-2 AND per-row cascade compose
// this — do NOT reintroduce per-item callSyncOnAdd; the whole point is
// one sync per batch (permit count is ABSOLUTE, not delta; N syncs
// would be redundant Stripe calls for the same final quantity).
//
// 2026-08-04 — unitOccupancy passed IN once (cheap map lookup per row),
// NOT called per row. The bulk lane is the "one payload feeds all"
// site: same map that drove the pre-loop aggregate now stamps each
// row's audit. Fail-quiet: null map means no stamps written — audits
// fall back to their existing shape.
export async function approveVehiclesBatch(
  supabase: SupabaseClient,
  args: {
    vehicles: VehicleForBatch[]
    property: string
    companyIdForSync: number | null
    logSite?: string  // caller identifier for [approve_vehicle] logs
    managerNote?: string | null  // per-row cascade currently passes null; bulk passes null
    unitOccupancy?: UnitOccupancyMap | null
  },
): Promise<{
  // RPC returned r.ok (includes action='approved' AND action='noop_already_active')
  // — used for summary "N approved" count so the manager sees consistent
  // per-row success regardless of whether it was a fresh approve or
  // idempotent replay of an already-approved row.
  succeeded: string[]
  // action === 'approved' (excludes noop) — used to gate the meter-once
  // sync. Noop shouldn't advance the Stripe quantity because nothing
  // changed on the permit count.
  approved: string[]
  failed: { id: string; plate?: string | null; error: unknown }[]
  syncFired: boolean
}> {
  const { vehicles, property, companyIdForSync, logSite = 'approveVehiclesBatch', managerNote = null, unitOccupancy = null } = args
  const succeeded: string[] = []
  const approved: string[] = []
  const failed: { id: string; plate?: string | null; error: unknown }[] = []
  await Promise.all(vehicles.map(async v => {
    const { data, error } = await supabase.rpc('approve_vehicle', {
      p_vehicle_id: v.id,
      p_manager_note: managerNote,
    })
    if (error) {
      console.error('[approve_vehicle] RPC error in batch:', error.message, { site: logSite, vehicleId: v.id, plate: v.plate })
      failed.push({ id: v.id, plate: v.plate ?? null, error: error.message })
      return
    }
    const r = data as { ok?: boolean; action?: string; error?: string; hint?: string } | null
    if (r?.ok) {
      console.info('[approve_vehicle]', { site: logSite, vehicleId: v.id, plate: v.plate, action: r.action })
      const stamp = buildOccupancyStamp(unitOccupancy, v.unit ?? null)
      await logAudit({
        action: 'APPROVE_VEHICLE',
        table_name: 'vehicles',
        record_id: v.id,
        new_values: {
          status: 'active',
          property,
          batch: logSite,
          ...(stamp ? { occupancy_at_decision: stamp } : {}),
        },
      })
      succeeded.push(v.id)
      if (r.action === 'approved') approved.push(v.id)
      return
    }
    console.error('[approve_vehicle] RPC returned not-ok:', r?.error, r?.hint, { site: logSite, vehicleId: v.id, plate: v.plate })
    failed.push({ id: v.id, plate: v.plate ?? null, error: r?.error ?? 'rpc_returned_not_ok' })
  }))
  console.info('[B147-sync-batch-summary]', { site: logSite, property, batchSize: vehicles.length, approvedCount: approved.length, willFireSync: approved.length > 0 })
  let syncFired = false
  if (approved.length > 0 && companyIdForSync) {
    const syncRes = await callSyncOnAdd(companyIdForSync, 'permit')
    syncFired = syncRes.ok
    console.info('[B147-sync-result]', { site: logSite, kind: 'permit', result: syncRes.ok ? syncRes.action : `failed:${syncRes.reason}` })
    if (!syncRes.ok) console.warn('[B147-sync-failed]', { context: logSite, approvedCount: approved.length, reason: syncRes.reason })
  }
  return { succeeded, approved, failed, syncFired }
}

// ══════════════════════════════════════════════════════════════════════
// Write cores — atomic, no UI
// ══════════════════════════════════════════════════════════════════════

// The residents UPDATE + notify + audit for one resident approval.
// Does NOT cascade to unit vehicles — surface owns the cascade decision
// (see feedback_mobile_pending_list_is_the_confirmation.md for the
// mobile PM-only rule).
export async function approveResidentWrite(
  supabase: SupabaseClient,
  args: {
    resident: { id: string; name?: string | null; unit?: string | null; email?: string | null }
    property: string
    managerNote?: string | null
    // 2026-08-04 — unit occupancy at click time (see unit-occupancy.ts).
    // Recorded in new_values.occupancy_at_decision so a later dispute
    // sees what the manager was shown when they decided. Fail-quiet:
    // null omits the key entirely rather than writing zeros.
    occupancyStamp?: OccupancyStamp | null
    // 2026-08-07 — reapproval-orphans decision at click time. Populated
    // by manager/page.tsx approveResident intercept when the resident
    // had plates on file that weren't currently authorized. Fields:
    //   shownPlateIds:   plates surfaced to the manager
    //   restoredPlateIds: plates the manager chose to restore
    //   skippedPlateIds:  shown BUT NOT chosen (the more interesting
    //                     fact in a later dispute — the manager saw
    //                     these and decided against restoring)
    // Omitted from audit when no orphans were surfaced.
    reapprovalOrphansDecision?: {
      shownPlateIds:    Array<string | number>
      restoredPlateIds: Array<string | number>
      skippedPlateIds:  Array<string | number>
    } | null
  },
): Promise<{ ok: boolean; emailSent: boolean; messageId: string | null; error?: unknown }> {
  const { resident, property, managerNote = null, occupancyStamp = null, reapprovalOrphansDecision = null } = args
  const { error: updErr } = await supabase.from('residents')
    .update({ is_active: true, status: 'active', manager_note: managerNote })
    .eq('id', resident.id)
  if (updErr) {
    console.error('[approveResidentWrite] residents UPDATE failed', { residentId: resident.id, error: updErr })
    return { ok: false, emailSent: false, messageId: null, error: updErr }
  }
  const emailResult = await notifyResidentDecision({ residentId: String(resident.id), decision: 'approved', note: null })
  await logAudit({
    action: 'APPROVE_RESIDENT',
    table_name: 'residents',
    record_id: resident.id,
    new_values: {
      name: resident.name,
      unit: resident.unit,
      property,
      email_sent: emailResult.ok,
      message_id: emailResult.message_id,
      ...(occupancyStamp ? { occupancy_at_decision: occupancyStamp } : {}),
      ...(reapprovalOrphansDecision ? { reapproval_orphans_decision: reapprovalOrphansDecision } : {}),
    },
  })
  return { ok: true, emailSent: emailResult.ok, messageId: emailResult.message_id }
}

// Per-row vehicle approval: approve_vehicle RPC + audit + sync-on-approve.
// INCLUDES per-call sync (per-row semantics). Bulk BYPASSES this and uses
// approveVehiclesBatch for meter-once discipline across N vehicles.
export async function approveVehicleWrite(
  supabase: SupabaseClient,
  args: {
    vehicleId: string
    property: string
    managerNote?: string | null
    companyIdForSync: number | null
    // 2026-08-04 — see approveResidentWrite's occupancyStamp comment.
    occupancyStamp?: OccupancyStamp | null
  },
): Promise<{
  ok: boolean
  action: 'approved' | 'noop_already_active' | string | null
  syncFired: boolean
  error?: unknown
}> {
  const { vehicleId, property, managerNote = null, companyIdForSync, occupancyStamp = null } = args
  const { data: rpcResult, error: rpcErr } = await supabase.rpc('approve_vehicle', {
    p_vehicle_id: vehicleId,
    p_manager_note: managerNote,
  })
  if (rpcErr) {
    console.error('[approve_vehicle] RPC error:', rpcErr.message)
    return { ok: false, action: null, syncFired: false, error: rpcErr.message }
  }
  const result = rpcResult as { ok?: boolean; action?: string; error?: string; hint?: string } | null
  if (!result?.ok) {
    console.error('[approve_vehicle] RPC returned error:', result?.error, result?.hint)
    return { ok: false, action: null, syncFired: false, error: result?.error ?? 'rpc_returned_not_ok' }
  }
  console.info('[approve_vehicle]', { site: 'approveVehicleWrite', vehicleId, action: result.action })
  await logAudit({
    action: 'APPROVE_VEHICLE',
    table_name: 'vehicles',
    record_id: vehicleId,
    new_values: {
      status: 'active',
      property,
      ...(occupancyStamp ? { occupancy_at_decision: occupancyStamp } : {}),
    },
  })
  let syncFired = false
  if (result.action === 'approved' && companyIdForSync) {
    const syncRes = await callSyncOnAdd(companyIdForSync, 'permit')
    syncFired = syncRes.ok
    console.info('[B147-sync-result]', { site: 'approveVehicleWrite', kind: 'permit', result: syncRes.ok ? syncRes.action : `failed:${syncRes.reason}` })
    if (!syncRes.ok) console.warn('[B147-sync-failed]', { context: 'approveVehicleWrite', reason: syncRes.reason })
  } else if (result.action === 'noop_already_active') {
    console.info('[B147-sync-skipped]', { site: 'approveVehicleWrite', reason: 'noop_already_active — vehicle was already approved; no quantity change' })
  }
  return { ok: true, action: result.action ?? null, syncFired }
}

// Resident decline: residents UPDATE + pending-vehicle UPDATE + notify
// + audit + owner-trim (B166). All cascades bundled because they're
// invariants of the decline shape.
export async function declineResidentWrite(
  supabase: SupabaseClient,
  args: {
    resident: { id: string; name?: string | null; unit?: string | null; email?: string | null }
    property: string
    managerNote?: string | null
  },
): Promise<{ ok: boolean; emailSent: boolean; messageId: string | null; error?: unknown }> {
  const { resident, property, managerNote = null } = args
  await supabase.from('residents')
    .update({ is_active: false, status: 'declined', manager_note: managerNote })
    .eq('id', resident.id)
  // Pending-vehicles cascade at (unit, property).
  await supabase.from('vehicles')
    .update({ is_active: false, status: 'declined' })
    .ilike('unit', escapeIlikeValue(resident.unit ?? ''))
    .ilike('property', escapeIlikeValue(property))
    .eq('status', 'pending')
  const emailResult = await notifyResidentDecision({ residentId: String(resident.id), decision: 'declined', note: managerNote })
  await logAudit({
    action: 'DECLINE_RESIDENT',
    table_name: 'residents',
    record_id: resident.id,
    new_values: {
      name: resident.name,
      unit: resident.unit,
      property,
      email_sent: emailResult.ok,
      message_id: emailResult.message_id,
    },
  })
  // B166 owner-trim: defensive against any historical active vehicle
  // owned by this email at this tuple (the pending-status filter above
  // only catches pending-status rows; an active row owned by a
  // re-appearing email would survive without this).
  await trimDepartedResidentVehicles(supabase, resident.email, resident.unit, property, 'DECLINE_RESIDENT')
  return { ok: true, emailSent: emailResult.ok, messageId: emailResult.message_id }
}

// Per-row vehicle decline: vehicles UPDATE + audit + residents-back-to-active
// at same (unit, property). Cascade bundled — same reason as decline resident.
export async function declineVehicleWrite(
  supabase: SupabaseClient,
  args: {
    vehicleId: string
    property: string
    managerNote?: string | null
  },
): Promise<{ ok: boolean; error?: unknown }> {
  const { vehicleId, property, managerNote = null } = args
  await supabase.from('vehicles')
    .update({ is_active: false, status: 'declined', manager_note: managerNote })
    .eq('id', vehicleId)
  await logAudit({ action: 'DECLINE_VEHICLE', table_name: 'vehicles', record_id: vehicleId, new_values: { status: 'declined', property } })
  const { data: veh } = await supabase.from('vehicles').select('unit, property').eq('id', vehicleId).single()
  if (veh) {
    await supabase.from('residents')
      .update({ status: 'active', is_active: true })
      .ilike('unit', escapeIlikeValue(veh.unit))
      .ilike('property', escapeIlikeValue(veh.property))
      .eq('status', 'pending')
  }
  return { ok: true }
}

// ══════════════════════════════════════════════════════════════════════
// Bulk orchestration
// ══════════════════════════════════════════════════════════════════════

// PM CRM bulk approve — ORDERED COMBINED ACTION (2026-07-30 arc per
// docs/backlog/manager-bulk-approve-ordered-combined.md).
//
// ── Ordering (do NOT parallelize the phases) ─────────────────────
//   Phase 1  approve pending residents; COLLECT PER-ROW RESULTS
//   Phase 2  approve pending vehicles whose resident is NOW active
//            (already-active at property, or SUCCEEDED in phase 1);
//            skip vehicles whose phase-1 resident FAILED, and skip
//            vehicles whose resident_email matches no active row
//            (allow-list, not deny-list)
//   Phase 3  meter-once sync (preserved from B147) — inside
//            approveVehiclesBatch, one call for the whole batch
//   Phase 4  return summary input for surface to render
//
// 🔴 Phase 2's eligibility gate is load-bearing: if a resident
// approval fails and their vehicle is approved anyway, there's now
// an authorized car for someone who isn't an approved resident.
// Gate on phase-1 RESULT, not on the pre-phase-1 snapshot.
//
// Resident-before-vehicle is OUR policy, NOT enforced by
// approve_vehicle. Do NOT "optimize" the phases into parallel — the
// ordering IS the safety.
//
// Meter-once accounting (Jose guardrail 2026-07-03) preserved:
// vehicle loop calls approveVehiclesBatch which uses approve_vehicle RPC
// direct (bypasses approveVehicleWrite's per-call sync — that would
// fire N times = double-billing); ONE callSyncOnAdd('permit')
// post-batch inside approveVehiclesBatch.
//
// Surface must gate on can_approve_vehicles before calling this. Function
// assumes the caller has already checked the gate.
export async function runBulkApprove(
  supabase: SupabaseClient,
  args: {
    property: string
    companyIdForSync: number | null
    pendingResidentsForBulk: { id: string; name?: string | null; email?: string | null; unit?: string | null }[]
    allPendingVehicles: { id: string; plate: string | null; resident_email: string | null; unit?: string | null }[]
    // 2026-08-04 — unit occupancy at click time; stamped onto every
    // row's audit in both phase-1 (residents) and phase-2 (vehicles).
    // Same map that drove the pre-loop bulk-lane aggregate. Fail-quiet:
    // null map → no stamps written, audits fall back to base shape.
    unitOccupancy?: UnitOccupancyMap | null
  },
): Promise<{ ok: true; summary: BulkApproveSummaryInput } | { ok: false; error: unknown }> {
  const { property, companyIdForSync, pendingResidentsForBulk, allPendingVehicles, unitOccupancy = null } = args

  // Active-residents snapshot for the allow-list. Feeds phase-2 eligibility
  // alongside phase-1's succeeded residents. Without this, a vehicle whose
  // resident is already active (later-added via +Request-Vehicle) would be
  // approved via a deny-list; that's the failure mode Mateo flagged
  // 2026-07-30. Allow-list requires known-good.
  const { data: activeResidents, error: activeErr } = await supabase
    .from('residents').select('email')
    .ilike('property', escapeIlikeValue(property)).eq('is_active', true)
  if (activeErr) {
    console.error('[runBulkApprove] active-residents snapshot failed', activeErr)
    return { ok: false, error: activeErr }
  }
  const alreadyActiveEmails = new Set(
    (activeResidents ?? []).map(r => (r.email || '').toLowerCase().trim()).filter(Boolean)
  )

  // ── Phase 1: parallel resident UPDATEs, per-row result capture ──
  // Duplicate-path note: approveResidentWrite is the per-row equivalent
  // and handles the same {is_active: true, status: 'active', manager_note}
  // write. The bulk loop reproduces the two-field write inline (minus
  // manager_note — no per-row note input at bulk lane) because per-row
  // result capture requires the raw error object per resident, and
  // approveResidentWrite's return shape is boolean-ok. Keep this write
  // in sync with approveResidentWrite when resident status semantics change.
  type ResidentResult = { r: { id: string; name?: string | null; email?: string | null; unit?: string | null }; ok: boolean }
  const residentResults: ResidentResult[] = await Promise.all(
    pendingResidentsForBulk.map(async (r): Promise<ResidentResult> => {
      const { error: updErr } = await supabase.from('residents')
        .update({ is_active: true, status: 'active' })
        .eq('id', r.id)
      if (updErr) {
        console.error('[runBulkApprove] resident UPDATE failed', { residentId: r.id, name: r.name, error: updErr })
        return { r, ok: false }
      }
      const emailResult = await notifyResidentDecision({ residentId: String(r.id), decision: 'approved', note: null })
      const stamp = buildOccupancyStamp(unitOccupancy, r.unit ?? null)
      await logAudit({
        action: 'APPROVE_RESIDENT',
        table_name: 'residents',
        record_id: r.id,
        new_values: {
          name: r.name, unit: r.unit, property,
          batch: 'crm_bulk',
          email_sent: emailResult.ok,
          message_id: emailResult.message_id,
          ...(stamp ? { occupancy_at_decision: stamp } : {}),
        },
      })
      return { r, ok: true }
    })
  )
  const failedResidents = residentResults.filter(x => !x.ok).map(x => x.r)
  const failedResidentEmails = new Set(
    failedResidents.map(r => (r.email || '').toLowerCase().trim()).filter(Boolean)
  )
  const phase1SucceededEmails = new Set(
    residentResults.filter(x => x.ok).map(x => (x.r.email || '').toLowerCase().trim()).filter(Boolean)
  )

  // ── Phase 2: eligibility-gated vehicle approvals (allow-list) ───
  // Vehicle is eligible only if its resident is NOW active:
  //   • already-active at property (alreadyActiveEmails), OR
  //   • succeeded in phase 1 (phase1SucceededEmails)
  // Vehicles with null resident_email pass through (unit-shared;
  // no resident to gate on).
  //
  // Allow-list not deny-list: a deny-list ("not in failedResidentEmails")
  // would approve any vehicle we never evaluated — pending resident
  // outside this batch, orphan resident_email with no matching row.
  // Correct by construction requires known-good.
  const activeResidentEmails = new Set<string>([
    ...alreadyActiveEmails,
    ...phase1SucceededEmails,
  ])
  const isEligible = (v: { resident_email: string | null }) => {
    const email = (v.resident_email || '').toLowerCase().trim()
    if (!email) return true    // unit-shared vehicle
    return activeResidentEmails.has(email)
  }
  const eligibleVehicles = allPendingVehicles.filter(isEligible)
  // Split skipped into two categories so the summary can name why:
  //   • resident approval failed (in this batch, phase 1 returned error)
  //   • resident not approved (resident_email matches no active row and
  //     wasn't in this batch — either pending outside the batch or
  //     orphan email with no matching residents row)
  const skippedFailedApproval = allPendingVehicles.filter(v => {
    const email = (v.resident_email || '').toLowerCase().trim()
    return !!email && failedResidentEmails.has(email)
  })
  const skippedResidentNotApproved = allPendingVehicles.filter(v => {
    const email = (v.resident_email || '').toLowerCase().trim()
    if (!email) return false
    return !activeResidentEmails.has(email) && !failedResidentEmails.has(email)
  })

  // Delegate the phase-2 loop-and-meter-once to the shared batch primitive.
  // unit is passed through so approveVehiclesBatch can attach the
  // occupancy_at_decision stamp per row using the same batch map.
  const batchResult = await approveVehiclesBatch(supabase, {
    vehicles: eligibleVehicles.map(v => ({ id: v.id, plate: v.plate, unit: v.unit ?? null })),
    property,
    companyIdForSync,
    logSite: 'runBulkApprove',
    unitOccupancy,
  })

  // Map batch failed ids back to the vehicle rows so the summary can
  // name plates using the input metadata (batch echoes plate too, but
  // this path preserves original plate strings from allPendingVehicles).
  const failedIdSet = new Set(batchResult.failed.map(f => f.id))
  const failedVehicles = eligibleVehicles.filter(v => failedIdSet.has(v.id))

  const summary: BulkApproveSummaryInput = {
    residentAttemptedCount: pendingResidentsForBulk.length,
    residentSuccessCount: residentResults.filter(x => x.ok).length,
    failedResidentLabels: failedResidents.map(r => r.name || r.email || `(id ${r.id})`),
    vehicleAttemptedCount: allPendingVehicles.length,
    vehicleSuccessCount: batchResult.succeeded.length,
    failedVehicleLabels: failedVehicles.map(v => v.plate || `(id ${v.id})`),
    skippedFailedApprovalLabels: skippedFailedApproval.map(v => v.plate || `(id ${v.id})`),
    skippedResidentNotApprovedLabels: skippedResidentNotApproved.map(v => v.plate || `(id ${v.id})`),
  }
  return { ok: true, summary }
}


// ══════════════════════════════════════════════════════════════════════
// deactivateResidentWrite — Task 3 Commit 2 (Mateo Aug 5 spec)
// ══════════════════════════════════════════════════════════════════════
//
// Replaces the inline residents.update() at manager/page.tsx:2316. The
// old shape did not check {error} — on failure, logAudit + all four
// cascades ran anyway, producing an active resident with all vehicles
// trimmed to is_active=false. Green Acres resident 690 is the live
// instance (via a different vector — see docs/backlog/residents-
// duplicate-row-uniqueness.md).
//
// This write core enforces the ordering the old inline code did not:
//   1. residents.update() → check the error
//   2. On failure: return { ok: false, error }. Caller does NOT run
//      audit, does NOT run cascades. Nothing happened.
//   3. On success: logAudit → return the row shape needed for cascades
//      → caller runs the cascades (which have their own guards now,
//      added in this commit alongside).
//
// Required reason (validated against RESIDENT_DEACTIVATION_REASONS).
// Note required when reason='other'. Note capped at
// DEACTIVATION_NOTE_MAX_LENGTH. Actor email required for the
// deactivated_by column (display-convenience, spoofable — see column
// COMMENT for why the trustworthy record is audit_logs).
export interface DeactivateResidentInput {
  supabase: SupabaseClient
  residentId: string | number
  reason:    string        // resident-reason code (validated below)
  note:      string | null
  actor:     string        // deactivating manager's email (for deactivated_by)
  property:  string        // for audit new_values shape parity with APPROVE_RESIDENT
}

export interface DeactivateResidentResult {
  ok:       boolean
  error?:   unknown
  reason?:  'validation' | 'read_failed' | 'update_failed'
  message?: string
  // On success, echo the fields the caller needs for the cascades
  // (trimDepartedResidentVehicles + cascadeVehiclesIfUnitVacant).
  // Read once here — the caller does not need a follow-up SELECT.
  residentSnapshot?: {
    email:    string | null
    unit:     string | null
    property: string | null
    name:     string | null
  }
}

export async function deactivateResidentWrite(
  args: DeactivateResidentInput,
): Promise<DeactivateResidentResult> {
  const { supabase, residentId, reason, note, actor, property } = args

  // ── Validation ─────────────────────────────────────────────────────
  if (!isValidResidentReason(reason)) {
    return { ok: false, reason: 'validation', message: `Invalid deactivation reason code: ${reason}` }
  }
  if (reasonRequiresNote(reason)) {
    if (!note || note.trim().length === 0) {
      return { ok: false, reason: 'validation', message: 'A note is required when the reason is "Other".' }
    }
  }
  const cleanNote = (note ?? '').slice(0, DEACTIVATION_NOTE_MAX_LENGTH).trim() || null

  // ── Read the resident snapshot BEFORE the write, so the caller can
  //    cascade even after a successful update (the update wouldn't
  //    change email/unit/property, but reading first also gives the
  //    ancillary fields the caller needs). ─────────────────────────
  const { data: snapshot, error: readErr } = await supabase
    .from('residents')
    .select('email, unit, property, name')
    .eq('id', residentId)
    .maybeSingle()
  if (readErr) {
    console.error('[deactivateResidentWrite] snapshot SELECT failed', { residentId, error: readErr })
    return { ok: false, reason: 'read_failed', error: readErr, message: readErr.message ?? 'Failed to read resident before deactivation.' }
  }

  // ── The write — CHECK the error ────────────────────────────────────
  // deactivated_at is a CLIENT clock (new Date().toISOString()). Same
  // display-vs-evidence rule as deactivated_by: a skewed laptop writes
  // a wrong timestamp onto a Chapter 2308-adjacent record. Column
  // COMMENT documents this — cite audit_logs.created_at (server clock)
  // as the trustworthy record of WHEN, and cite audit_logs.user_email
  // (RLS-attributed) for WHO. This field exists so the CRM can render
  // "deactivated on <date>" without joining to audit_logs on every row.
  const { error: updErr } = await supabase
    .from('residents')
    .update({
      is_active:           false,
      deactivation_reason: reason,
      deactivation_note:   cleanNote,
      deactivated_by:      actor,
      deactivated_at:      new Date().toISOString(),
    })
    .eq('id', residentId)

  if (updErr) {
    console.error('[deactivateResidentWrite] residents UPDATE failed', { residentId, error: updErr })
    // Deliberately do NOT logAudit here. The old inline shape wrote
    // DEACTIVATE_RESIDENT even on failure, producing an audit row
    // asserting "someone deactivated this" against a row that never
    // moved. That's the intent-vs-outcome split — audit is written
    // ONLY on success. See docs/backlog/ca-msgbox-severity-derived-
    // from-text.md class rule.
    return { ok: false, reason: 'update_failed', error: updErr, message: updErr.message ?? 'The database rejected the deactivation.' }
  }

  // ── Success — write the audit row, extended shape ─────────────────
  // Extends the historically-thin DEACTIVATE_RESIDENT shape (which
  // carried only {is_active, property}) to parity with APPROVE_RESIDENT
  // plus the new deactivation fields. This is the June 17 follow-up #2
  // delivery vehicle.
  await logAudit({
    action:     'DEACTIVATE_RESIDENT',
    table_name: 'residents',
    record_id:  String(residentId),
    new_values: {
      is_active:           false,
      property,
      name:                snapshot?.name ?? null,
      unit:                snapshot?.unit ?? null,
      deactivation_reason: reason,
      deactivation_note:   cleanNote,
      deactivated_by:      actor,
    },
  })

  return {
    ok: true,
    residentSnapshot: {
      email:    snapshot?.email ?? null,
      unit:     snapshot?.unit ?? null,
      property: snapshot?.property ?? null,
      name:     snapshot?.name ?? null,
    },
  }
}

// ══════════════════════════════════════════════════════════════════════
// deactivateVehicleWrite — Task 3 Commit 3 (2026-08-06)
// ══════════════════════════════════════════════════════════════════════
//
// Routes through the deactivate_vehicle DEFINER RPC (20260806) which
// carries role + authority + scope + reason validation on the SERVER.
// Closes the render-side-only gap from Task 1 (1c1ce5a) — a manager
// without can_approve_vehicles is now rejected by the RPC, not only
// the button.
//
// Client-side responsibilities are minimal:
//   - Validate reason against isValidVehicleReason (fast-fail before
//     round-trip; the RPC re-validates for real)
//   - Cap note at 256 chars
//   - Call the RPC
//   - Write the audit row on success (RPC does not write audit)
//
// RPC returns `{ok:true, action, vehicle}` on success or
// `{error, hint?}` on failure. Failure surface treated as a
// user-friendly error message; no audit row is written on failure
// (consistent with the audit-after-unchecked-write discipline).
//
// Vehicle deactivation cascades NONE (confirmed 2026-08-06 §1c
// report). No trim, no space-tie cleanup, no guest-auth cascade.
// Success returns snapshot for the CRM refresh path.
// ══════════════════════════════════════════════════════════════════════

export interface DeactivateVehicleInput {
  supabase:  SupabaseClient
  vehicleId: string | number
  reason:    string      // vehicle-reason code (validated + re-validated at RPC)
  note:      string | null
  actor:     string      // deactivating manager's email (for audit + client-side deactivated_by echo)
  property:  string      // for audit new_values shape parity with APPROVE_VEHICLE
}

export interface DeactivateVehicleResult {
  ok:       boolean
  error?:   unknown
  reason?:  'validation' | 'rpc_error'
  message?: string
  // On success, echo the fields the caller may want for a refresh
  // context (plate, unit, resident_email).
  vehicleSnapshot?: {
    plate:          string | null
    unit:           string | null
    resident_email: string | null
    property:       string | null
  }
}

export async function deactivateVehicleWrite(
  args: DeactivateVehicleInput,
): Promise<DeactivateVehicleResult> {
  const { supabase, vehicleId, reason, note, actor, property } = args

  // ── Client-side fast-fail (RPC re-validates for real) ──────────────
  if (!isValidVehicleReason(reason)) {
    return { ok: false, reason: 'validation', message: `Invalid vehicle deactivation reason code: ${reason}` }
  }
  if (reasonRequiresNote(reason)) {
    if (!note || note.trim().length === 0) {
      return { ok: false, reason: 'validation', message: 'A note is required when the reason is "Other".' }
    }
  }
  const cleanNote = (note ?? '').slice(0, DEACTIVATION_NOTE_MAX_LENGTH).trim() || null

  // ── Call the DEFINER RPC ───────────────────────────────────────────
  const { data, error: rpcErr } = await supabase.rpc('deactivate_vehicle', {
    p_vehicle_id: vehicleId,
    p_reason:     reason,
    p_note:       cleanNote,
  })
  if (rpcErr) {
    console.error('[deactivateVehicleWrite] rpc call failed', { vehicleId, error: rpcErr })
    return { ok: false, reason: 'rpc_error', error: rpcErr, message: rpcErr.message ?? 'The database rejected the deactivation.' }
  }
  // The RPC returns jsonb; supabase-js unwraps to a plain object.
  const result = data as { ok?: boolean; error?: string; hint?: string; action?: string; vehicle?: any } | null
  if (!result || result.error) {
    const errMsg = result?.hint ?? result?.error ?? 'The database rejected the deactivation.'
    console.error('[deactivateVehicleWrite] rpc returned error', { vehicleId, result })
    return { ok: false, reason: 'rpc_error', error: result?.error ?? 'unknown', message: errMsg }
  }

  const v = result.vehicle ?? {}

  // ── Audit — extended shape (Task 3 Commit 3) ──────────────────────
  // Prior shape: {is_active, status, property, meter_fired, note}.
  // Adds: plate, unit, deactivation_reason, deactivation_note,
  // deactivated_by. Keeps meter_fired (still false — deactivate does
  // not fire callSyncOnAdd; count decrements at cycle close via
  // reconcileAtRenewal). RPC did the write; this row records
  // manager-initiated intent + outcome.
  await logAudit({
    action:     'DEACTIVATE_VEHICLE',
    table_name: 'vehicles',
    record_id:  String(vehicleId),
    new_values: {
      is_active:           false,
      status:              'deactivated',
      property,
      meter_fired:         false,
      plate:               v.plate ?? null,
      unit:                v.unit ?? null,
      deactivation_reason: reason,
      deactivation_note:   cleanNote,
      deactivated_by:      actor,
    },
  })

  return {
    ok: true,
    vehicleSnapshot: {
      plate:          v.plate ?? null,
      unit:           v.unit ?? null,
      resident_email: v.resident_email ?? null,
      property:       v.property ?? null,
    },
  }
}

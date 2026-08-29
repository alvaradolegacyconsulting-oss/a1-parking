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
  reasonNotifies,
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

// 2026-08-09 Commit C — deactivation-email client wrapper. Mirror of
// notifyResidentDecision. Called from deactivateResidentWrite after
// the residents UPDATE + audit have landed.
//
// Returns the outcome the writer records in its audit row. The route
// itself gates on the reason's notifies field via the caller — this
// wrapper is only invoked when the writer has already decided a send
// is warranted (notify=true, reasonNotifies(reason)=true, email
// present).
//
// Dedup is enforced at the route (defense-in-depth) and upstream at
// the writer (same-reason no-op check).
export async function notifyResidentDeactivation(args: {
  residentId: string
}): Promise<{
  ok:            boolean
  outcome:       'sent' | 'overridden' | 'failed' | 'no-email-on-file'
  message_id:    string | null
  dedup_skipped: boolean
  error:         string | null
}> {
  try {
    const res = await fetch('/api/manager/notify-resident-deactivation', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(args),
    })
    const j = await res.json().catch(() => ({}))
    if (res.ok && j.ok) {
      return {
        ok:            true,
        outcome:       j.outcome,       // 'sent' | 'overridden' | 'no-email-on-file'
        message_id:    j.message_id ?? null,
        dedup_skipped: !!j.dedup_skipped,
        error:         null,
      }
    }
    console.error('[resident-deactivation-email] failed:', j.error || res.statusText)
    return {
      ok:            false,
      outcome:       'failed',
      message_id:    null,
      dedup_skipped: false,
      error:         j.error || res.statusText || 'unknown error',
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[resident-deactivation-email] threw:', msg)
    return {
      ok:            false,
      outcome:       'failed',
      message_id:    null,
      dedup_skipped: false,
      error:         msg,
    }
  }
}

// 2026-08-09 Commit D — vehicle-deactivation email client wrapper.
// Mirror of notifyResidentDeactivation above. Called from
// deactivateVehicleWrite AFTER the deactivate_vehicle RPC + local
// audit have landed.
//
// Same "invoked only when writer has already decided a send is
// warranted" discipline: notify=true, reasonNotifies('vehicle', reason)
// =true, snapshot.resident_email present. Dedup enforced at the route
// (defense-in-depth) and upstream at the writer (same-reason no-op).
export async function notifyVehicleDeactivation(args: {
  vehicleId: string
}): Promise<{
  ok:            boolean
  outcome:       'sent' | 'overridden' | 'failed' | 'no-email-on-file'
  message_id:    string | null
  dedup_skipped: boolean
  error:         string | null
}> {
  try {
    const res = await fetch('/api/manager/notify-vehicle-deactivation', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(args),
    })
    const j = await res.json().catch(() => ({}))
    if (res.ok && j.ok) {
      return {
        ok:            true,
        outcome:       j.outcome,       // 'sent' | 'overridden' | 'no-email-on-file'
        message_id:    j.message_id ?? null,
        dedup_skipped: !!j.dedup_skipped,
        error:         null,
      }
    }
    console.error('[vehicle-deactivation-email] failed:', j.error || res.statusText)
    return {
      ok:            false,
      outcome:       'failed',
      message_id:    null,
      dedup_skipped: false,
      error:         j.error || res.statusText || 'unknown error',
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[vehicle-deactivation-email] threw:', msg)
    return {
      ok:            false,
      outcome:       'failed',
      message_id:    null,
      dedup_skipped: false,
      error:         msg,
    }
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
  // ── 2026-08-28 A1-cluster Item 3 Commit 2 — Site 1 RESCOPED ──────
  //
  // 🔴 If a future reader thinks this cascade should key on (unit,
  // property), IT SHOULD NOT. Read this before touching it.
  //
  // Was:
  //   .ilike('unit', escapeIlikeValue(resident.unit ?? ''))
  //   .ilike('property', escapeIlikeValue(property))
  //   .eq('status', 'pending')
  //
  // Cross-resident collateral: at a shared unit, declining resident A
  // wrote status='declined' onto resident B's pending vehicles too.
  // Green Acres unit 144 was the live case — vehicles 766 (José, TWS7703)
  // and 767 (José, HHT7083) were declined by cascade off Arely (695)
  // 2026-08-02 without audit rows naming them.
  //
  // 🔴 Rescoping to just `email` was rejected in favor of KEEPING a
  // `property` predicate because residents can hold rows at more than
  // one property (July 25 multi-residency arc). Email-only would
  // decline the resident's vehicles at OTHER properties too. Kept
  // property, dropped unit — unit is what created the collateral.
  //
  // Comparison shape:
  //   resident_email → .eq() on the LOWERED value (residents.email is
  //                    forward-stamped lowercase; historical mixed-case
  //                    rows wiped pre-launch). .eq() avoids ILIKE
  //                    wildcard injection on % / _ / \ in local-parts.
  //   property       → .ilike(escapeIlikeValue()) — matches the
  //                    convention in the sibling B166 owner-trim at
  //                    :298-304 within this same function. Deliberate
  //                    consistency: a grep for either convention finds
  //                    both cascades. Do NOT drift to lower(trim())
  //                    equality here without moving B166 too.
  //
  // 🔴 Per-vehicle audit rows — the provenance rescue for future
  // un-decline / cleanup. Distinct action name (DECLINE_VEHICLE_CASCADE)
  // + source='DECLINE_RESIDENT' so cascade-declined and manager-declined
  // stay distinguishable forever. Without this distinction, un-decline
  // cannot tell a resident's own declined vehicles from ones caught as
  // collateral off a unit-mate. Provenance is what makes recovery
  // possible.
  //
  // NOTE for backlog: this is another name-keyed property resolution
  // site. Rescoping to resident_email doesn't remove that. Add
  // declineResidentWrite to the property_id refactor list.
  const declinedEmail = (resident.email ?? '').trim().toLowerCase()
  if (declinedEmail) {
    const { data: cascaded, error: cascadeErr } = await supabase.from('vehicles')
      .update({ is_active: false, status: 'declined' })
      .eq('resident_email', declinedEmail)
      .ilike('property', escapeIlikeValue(property))
      .eq('status', 'pending')
      .select('id, plate, unit')
    if (cascadeErr) {
      console.error('[decline-resident-cascade-failed]', {
        residentId: resident.id, email: declinedEmail, property,
        error: cascadeErr.message,
      })
    } else if ((cascaded ?? []).length > 0) {
      await logAudit({
        action: 'DECLINE_VEHICLE_CASCADE',
        table_name: 'vehicles',
        new_values: {
          source: 'DECLINE_RESIDENT',
          resident_email: declinedEmail,
          property,
          declined_resident_id: resident.id,
          vehicles_affected: cascaded!.length,
          plates:      cascaded!.map(v => v.plate),
          vehicle_ids: cascaded!.map(v => v.id),
          units:       cascaded!.map(v => v.unit),
        },
      })
    }
  }
  // else: resident row without an email cannot have vehicles owned by
  // that email; cascade is a structural no-op. No audit row emitted
  // (nothing happened to record).
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
  // ── 2026-08-28 A1-cluster Item 3 Commit 1 — SITE 2 REMOVED ────────
  //
  // 🔴 If a future reader thinks a residents-back-to-active cascade
  // belongs here, IT DOES NOT. Read this before touching it.
  //
  // Original intent (f142973, 2026-05-06, "resident portal access
  // after vehicle decline"): un-lock the portal for a pending resident
  // whose vehicle got declined. At the time, pending residents
  // (is_active=false, status='pending') hit the portal account gate
  // and were locked out; the fix flipped them to active so they could
  // retry.
  //
  // Superseded by 1aa70b2 (2026-07-27): hydrateResidency now skips the
  // account gate for status='pending' via GATE_EXEMPT_STATUSES
  // (resident/page.tsx:318). The "Registration Pending" banner at
  // resident/page.tsx:882 renders correctly for a pending resident.
  // No approval status change is needed to keep the portal reachable
  // — the read path handles it, where it belongs.
  //
  // Email-scoping the old cascade (Option B in the Aug 28 gate report)
  // was REJECTED, not because the shape was harmless, but because
  // "declining a vehicle approves its owner" is the Change 2 class
  // Mateo rejected in July: a write destroys pending-ness and lets a
  // later read interpret its absence as approval. Rescoping narrows
  // the blast radius while preserving the mechanism. Same class.
  //
  // Correct sequence today: manager declines the vehicle → resident
  // stays in the pending queue → manager still owes them Approve or
  // Decline. If the resident's only vehicle was declined and that
  // becomes a real workflow gap, surface it in the queue ("resident's
  // only vehicle was declined") — don't flip status behind the
  // manager's back.
  //
  // Site 2's audit history: 3 DECLINE_VEHICLE rows total (all
  // 2026-07-24, test tenant). Never fired in production. Full
  // rationale in the Item 3 gate report + Mateo's Option-A ruling
  // (Aug 28).
  return { ok: true }
}

// ══════════════════════════════════════════════════════════════════════
// undeclineResidentWrite — 2026-08-28 A1-cluster Item 3 Commit 3
// ══════════════════════════════════════════════════════════════════════
//
// Un-decline handler for accidentally-declined residents. Moves the
// resident from (is_active=false, status='declined') back to
// (is_active=false, status='pending') — returning them to the pending
// queue for a real Approve/Decline decision by a manager. Restores
// this resident's OWN declined vehicles to pending alongside.
//
// 🔴 TWO LOAD-BEARING GUARDRAILS — DO NOT WEAKEN
//
// (1) Writes status='pending', NOT 'active'.
//     Writing 'active' would recreate the Site 2 / Change 2 class Mateo
//     rejected — a write destroys pending-ness and grants portal
//     access without a manager decision. Un-decline restores the
//     manager's *ability* to decide; it does not decide for them.
//     Symmetric with the Commit 2 cascade: decline moves pending →
//     declined, un-decline moves declined → pending. Both keep
//     is_active=false; approval remains a separate manager act.
//
// (2) Scoped to the resident's OWN vehicles by resident_email.
//     A vehicle caught as collateral off a unit-mate (pre-Commit-2
//     historical row at Green Acres unit 144: vehicles 766/767 belong
//     to José, declined via cascade off Arely) does NOT belong to the
//     resident being un-declined. resident_email scoping gives this
//     for free — José's vehicles stay put when Arely is un-declined.
//     They need their own restoration path (data cleanup or manager
//     manual action per Jose's ruling).
//
// ── PROVENANCE LIMITATION (documented; not fixable in code) ──────────
//
// For vehicles declined AFTER Commit 2 ships, DECLINE_VEHICLE_CASCADE
// audit rows make provenance clean. For historical rows (2026-07-30
// through Commit 2 landing), no per-vehicle audit exists — but the
// resident_email scoping means un-decline still does the right thing:
// it only touches this resident's vehicles regardless of what caused
// them to be declined. Historical collateral vehicles owned by OTHER
// residents remain declined and need explicit restoration.
//
// ── SHAPE CONSISTENCY WITH SIBLING WRITES ─────────────────────────────
//
// resident_email  → .eq() on lowered value. Matches Commit 2 + B166.
// property        → .ilike(escapeIlikeValue()). Matches Commit 2 + B166.
// Both audit action names distinct (UNDECLINE_RESIDENT and
// UNDECLINE_VEHICLE_CASCADE) so decline/un-decline are pairable
// forever via distinct action tags in audit_logs.
export async function undeclineResidentWrite(
  supabase: SupabaseClient,
  args: {
    resident: { id: string; name?: string | null; email?: string | null }
    property: string
  },
): Promise<{
  ok: boolean
  vehiclesRestored: number
  restoredPlates: string[]
  error?: unknown
}> {
  const { resident, property } = args
  const email = (resident.email ?? '').trim().toLowerCase()

  // 1. Resident row: declined → pending. Kept is_active=false; approval
  //    is a manager act separate from un-decline.
  const { error: rErr } = await supabase.from('residents')
    .update({ is_active: false, status: 'pending' })
    .eq('id', resident.id)
  if (rErr) {
    console.error('[undecline-resident-failed]', { residentId: resident.id, error: rErr.message })
    return { ok: false, vehiclesRestored: 0, restoredPlates: [], error: rErr }
  }

  // 2. Vehicle restore: this resident's OWN declined vehicles at this
  //    property go declined → pending. Email-scoped by construction so
  //    collateral vehicles (owned by others, declined via cascade off
  //    someone else) are correctly untouched.
  let restoredVehicles: { id: number; plate: string }[] = []
  if (email) {
    const { data: restored, error: vErr } = await supabase
      .from('vehicles')
      .update({ is_active: false, status: 'pending' })
      .eq('resident_email', email)
      .ilike('property', escapeIlikeValue(property))
      .eq('status', 'declined')
      .select('id, plate')
    if (vErr) {
      console.error('[undecline-vehicles-restore-failed]', {
        residentId: resident.id, email, property, error: vErr.message,
      })
      // Non-fatal — resident is un-declined; the vehicle restore is a
      // convenience cascade. Manager can add vehicles individually
      // if this half fails. Surface via return payload.
    } else {
      restoredVehicles = (restored as { id: number; plate: string }[]) || []
    }
  }

  // 3. Audit: UNDECLINE_RESIDENT (single row) + UNDECLINE_VEHICLE_CASCADE
  //    (single per-invocation row if any vehicles restored). Mirrors
  //    the DECLINE_RESIDENT / DECLINE_VEHICLE_CASCADE pair from Commit 2
  //    so decline/un-decline audit trails are structurally symmetric.
  await logAudit({
    action: 'UNDECLINE_RESIDENT',
    table_name: 'residents',
    record_id: resident.id,
    new_values: {
      name: resident.name,
      email,
      property,
      new_status: 'pending',
      vehicles_restored: restoredVehicles.length,
      restored_plates: restoredVehicles.map(v => v.plate),
      restored_vehicle_ids: restoredVehicles.map(v => v.id),
    },
  })
  if (restoredVehicles.length > 0) {
    await logAudit({
      action: 'UNDECLINE_VEHICLE_CASCADE',
      table_name: 'vehicles',
      new_values: {
        source: 'UNDECLINE_RESIDENT',
        resident_email: email,
        property,
        undeclined_resident_id: resident.id,
        vehicles_affected: restoredVehicles.length,
        plates:      restoredVehicles.map(v => v.plate),
        vehicle_ids: restoredVehicles.map(v => v.id),
        new_status:  'pending',
      },
    })
  }

  return {
    ok: true,
    vehiclesRestored: restoredVehicles.length,
    restoredPlates: restoredVehicles.map(v => v.plate),
  }
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
          // 🔴 AUDIT-TAG ASYMMETRY — Item 1 grep-mismatch resolution
          // (Mateo Aug 28-29). Phase 1 (RESIDENTS side, this row) tags
          // batch='crm_bulk'. Phase 2 (VEHICLES side, via
          // approveVehiclesBatch → logSite='runBulkApprove' at :787,
          // stamped into APPROVE_VEHICLE new_values.batch) tags
          // batch='runBulkApprove'. Different strings, same operation.
          // If you're greping the audit log for bulk-approve activity,
          // check BOTH tags. Mateo's Item 1 report thought bulk cascade
          // had never fired; the real cause was greping only crm_bulk
          // on the vehicles side, where it had never appeared.
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
  // 2026-08-09 Commit C — deactivation-email hook decision. Required,
  // no default. Manager-initiated call sites pass true; admin cascade
  // at admin/page.tsx:481 is a bulk `.update()` that never calls the
  // writer, so it's exempt by construction. The parameter exists so
  // if anyone later routes a cascade through the writer, they must
  // pass the notify decision explicitly — cannot inherit silence,
  // cannot inherit a send. (Same discipline as reason+notifies being
  // one object in deactivation-reasons.ts.)
  //
  // notify=true means CONSIDER sending; the reason code's `notifies`
  // field is the final gate. `duplicate_record`, `registered_in_error`,
  // `resident_requested` all suppress even under notify=true.
  notify:    boolean
}

// 2026-08-09 Commit D — email decision vocabulary. Six outcomes,
// each meaning exactly one thing. Deliberately does NOT include a
// 'no-op' value — the no-op case made NO email decision at all and
// is modeled via the discriminated union below (result.noop === true
// on that branch omits emailDecision entirely, so TypeScript
// prevents callers from reading a value that was never assigned).
export type EmailDecision =
  | 'sent'
  | 'overridden'
  | 'suppressed-by-reason'
  | 'suppressed-by-cascade'
  | 'no-email-on-file'
  | 'failed'

export interface ResidentSnapshotEcho {
  email:    string | null
  unit:     string | null
  property: string | null
  name:     string | null
}

// Discriminated union — TypeScript narrows via `ok` and `noop`:
//   !result.ok                          → failure member (reason/message)
//   result.ok && result.noop            → no-op member — NO emailDecision
//                                         (msgBox class: don't claim
//                                         a value for a decision that
//                                         was never made)
//   result.ok && !result.noop           → normal success — emailDecision
//                                         present + email* fields set
export type DeactivateResidentResult =
  | { ok: false
      reason: 'validation' | 'read_failed' | 'not_visible' | 'update_failed'
      error?: unknown
      message: string }
  | { ok: true
      noop: true
      residentSnapshot: ResidentSnapshotEcho }
  | { ok: true
      noop?: false
      residentSnapshot: ResidentSnapshotEcho
      emailDecision:  EmailDecision
      emailMessageId: string | null
      emailError:     string | null }

export async function deactivateResidentWrite(
  args: DeactivateResidentInput,
): Promise<DeactivateResidentResult> {
  const { supabase, residentId, reason, note, actor, property, notify } = args

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

  // ── Read the resident snapshot BEFORE the write ────────────────────
  // Extended 2026-08-09 (Commit C) to include is_active + current
  // deactivation_reason so we can detect a no-op re-write of the SAME
  // deactivation state and skip the email hook. Probe 6's "hook twice
  // on one deactivation → one email" property depends on this.
  const { data: snapshot, error: readErr } = await supabase
    .from('residents')
    .select('email, unit, property, name, is_active, deactivation_reason')
    .eq('id', residentId)
    .maybeSingle()
  if (readErr) {
    console.error('[deactivateResidentWrite] snapshot SELECT failed', { residentId, error: readErr })
    return { ok: false, reason: 'read_failed', error: readErr, message: readErr.message ?? 'Failed to read resident before deactivation.' }
  }
  // 🔴 Mateo Aug 9 Item 1 — parallel to the vehicle writer. `.maybeSingle()`
  // returns `{data: null, error: null}` for zero rows; treating that as
  // a snapshot with null fields is the D-8 conflation class. Zero rows
  // here means the resident doesn't exist OR RLS hid the row from the
  // caller (e.g. the resident's property changed and no longer overlaps
  // the manager's scoped-properties list). Bail before any field access
  // — the subsequent `.update().eq('id', residentId)` would silently
  // affect zero rows under the same RLS, but only after the writer had
  // already made a snapshot-based no-op decision on undefined fields.
  if (snapshot === null) {
    console.warn('[deactivateResidentWrite] snapshot not visible (RLS-hidden or missing row)', { residentId })
    return {
      ok: false,
      reason: 'not_visible',
      message: 'Resident is not visible to your session. If it was just modified elsewhere, refresh and try again; otherwise contact support.',
    }
  }

  // ── No-op detection — same deactivation state already applied ────
  // If the row is already is_active=false AND the reason matches, this
  // is a re-fire (probe 6 shape). Return ok WITHOUT running UPDATE,
  // audit, or notify. Preserves the "one email per deactivation event"
  // invariant.
  //
  // 🔴 Return shape: `noop: true` and NO emailDecision. Prior to
  // Mateo Aug 9 correction #1 this branch reported emailDecision:'sent'
  // which is dishonest — no email was sent. Discriminated union
  // (see DeactivateResidentResult) prevents callers from reading a
  // value that was never assigned. Audit reader sees no repeat
  // DEACTIVATE_RESIDENT row for this second call — the first call's
  // audit is the record.
  const isNoop = snapshot?.is_active === false && snapshot?.deactivation_reason === reason
  if (isNoop) {
    return {
      ok: true,
      noop: true,
      residentSnapshot: {
        email:    snapshot?.email ?? null,
        unit:     snapshot?.unit ?? null,
        property: snapshot?.property ?? null,
        name:     snapshot?.name ?? null,
      },
    }
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

  // ── Email decision (Commit C) ────────────────────────────────────
  // Six outcomes at the writer per Mateo Aug 9. The helper
  // sendCompanyScopedEmail's narrower three ('sent'|'overridden'|'failed')
  // don't become the audit vocabulary here — suppression outcomes
  // live at the writer, BEFORE the helper is called.
  //
  // Order:
  //   notify=false                            → suppressed-by-cascade
  //   !reasonNotifies('resident', reason)     → suppressed-by-reason
  //   !snapshot.email                         → no-email-on-file
  //   else                                    → call notify route
  //                                             → outcome from route
  let emailDecision:  'sent' | 'overridden' | 'suppressed-by-reason' | 'suppressed-by-cascade' | 'no-email-on-file' | 'failed'
  let emailMessageId: string | null = null
  let emailError:     string | null = null

  if (!notify) {
    emailDecision = 'suppressed-by-cascade'
  } else if (!reasonNotifies('resident', reason)) {
    emailDecision = 'suppressed-by-reason'
  } else if (!snapshot?.email) {
    emailDecision = 'no-email-on-file'
  } else {
    const sendResult = await notifyResidentDeactivation({ residentId: String(residentId) })
    if (!sendResult.ok) {
      emailDecision = 'failed'
      emailError    = sendResult.error
    } else if (sendResult.outcome === 'no-email-on-file') {
      // Route independently discovered no email (race: snapshot.email
      // was populated at read but the row was updated between snapshot
      // and route call). Trust the route.
      emailDecision = 'no-email-on-file'
    } else {
      emailDecision  = sendResult.outcome  // 'sent' | 'overridden'
      emailMessageId = sendResult.message_id
    }
  }

  // ── Success — write the audit row ─────────────────────────────────
  // Extends the historically-thin DEACTIVATE_RESIDENT shape (which
  // carried only {is_active, property}) to parity with APPROVE_RESIDENT
  // plus the new deactivation fields plus the email decision.
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
      // Commit C — email decision recorded alongside every deactivation.
      // Six values matching Mateo Aug 9's audit vocabulary. Silent
      // no-op is not an acceptable outcome; every path here writes one.
      email_decision:      emailDecision,
      email_message_id:    emailMessageId,
      email_error:         emailError,
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
    emailDecision,
    emailMessageId,
    emailError,
  }
}

// ══════════════════════════════════════════════════════════════════════
// deactivateVehicleWrite — Task 3 Commit 3 (2026-08-06)
//                         + Commit D email hook (2026-08-09)
// ══════════════════════════════════════════════════════════════════════
//
// Routes through the deactivate_vehicle DEFINER RPC (20260806) which
// carries role + authority + scope + reason validation on the SERVER.
// Closes the render-side-only gap from Task 1 (1c1ce5a) — a manager
// without can_approve_vehicles is now rejected by the RPC, not only
// the button.
//
// Client-side responsibilities:
//   - Validate reason against isValidVehicleReason (fast-fail before
//     round-trip; the RPC re-validates for real)
//   - Cap note at 256 chars
//   - Read vehicle snapshot for the no-op check + email decision inputs
//   - Call the RPC
//   - Route the email decision (6-outcome vocabulary — same discipline
//     as deactivateResidentWrite)
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
//
// ── No-op path (same-reason re-fire) — UI-unreachable ──────────────
// PmResidentCrm's Deactivate affordance renders only when
// resident.status === 'active' AND resident.is_active AND !isReadOnly
// (:640). Only render site — one caller at manager/page.tsx:4438.
// The vehicle equivalent is symmetric: VehicleCard's Deactivate hides
// on already-deactivated rows. So the writer's no-op guard below
// (snapshot.is_active === false && snapshot.deactivation_reason ===
// reason) is unreachable via the manager portal today. It exists as
// defense-in-depth for RPC-direct callers, future surfaces, and race
// conditions — same rationale as the route-level dedup precondition.
//
// STRUCTURAL VERIFICATION ONLY (Mateo Aug 9). Probe D-6 was originally
// scoped to hand-drive the writer twice from a terminal — that's a
// library function, not reachable outside the app. Same disposition as
// Commit C's Finding 1: verified by reading the isNoop branch below;
// the return shape (`ok: true, noop: true, vehicleSnapshot` — no
// emailDecision) is enforced by the DeactivateVehicleResult
// discriminated union, so a caller reading emailDecision on the noop
// branch is a compile error.
//
// (See also: docs/backlog/crm6-editable-deactivation-reason.md — the
// "wrong-reason correction" workflow will need in-place amendment
// audit, not a repeat DEACTIVATE_VEHICLE; keeps the no-op path a
// true no-op.)
// ══════════════════════════════════════════════════════════════════════

export interface DeactivateVehicleInput {
  supabase:  SupabaseClient
  vehicleId: string | number
  reason:    string      // vehicle-reason code (validated + re-validated at RPC)
  note:      string | null
  actor:     string      // deactivating manager's email (for audit + client-side deactivated_by echo)
  property:  string      // for audit new_values shape parity with APPROVE_VEHICLE
  // 2026-08-09 Commit D — required-no-default, matching Commit C's
  // discipline. Cascade paths (trimDepartedResidentVehicles, admin
  // property cascade, unit-vacant cascade) are exempt-by-construction
  // — they bypass the writer entirely, so they don't need to pass
  // notify=false. Parameter exists so that any future path routing
  // through the writer must decide send/suppress explicitly.
  //
  // notify=true means CONSIDER sending; the reason code's `notifies`
  // field is the final gate. `plate_superseded` and
  // `registered_in_error` both suppress even under notify=true.
  notify:    boolean
}

export interface VehicleSnapshotEcho {
  plate:          string | null
  unit:           string | null
  resident_email: string | null
  property:       string | null
}

// Discriminated union — same narrowing shape as
// DeactivateResidentResult above. See EmailDecision header for the
// msgBox-class rationale on why the no-op branch omits emailDecision.
export type DeactivateVehicleResult =
  | { ok: false
      reason: 'validation' | 'read_failed' | 'not_visible' | 'rpc_error'
      error?: unknown
      message: string }
  | { ok: true
      noop: true
      vehicleSnapshot: VehicleSnapshotEcho }
  | { ok: true
      noop?: false
      vehicleSnapshot: VehicleSnapshotEcho
      emailDecision:  EmailDecision
      emailMessageId: string | null
      emailError:     string | null }

export async function deactivateVehicleWrite(
  args: DeactivateVehicleInput,
): Promise<DeactivateVehicleResult> {
  const { supabase, vehicleId, reason, note, actor, property, notify } = args

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

  // ── Read snapshot BEFORE the RPC (Commit D) ────────────────────────
  // Needed for no-op detection (is_active + deactivation_reason) and
  // for the email decision (resident_email presence drives the
  // no-email-on-file suppression at the writer). The RPC's returned
  // `vehicle` object doesn't reveal PRIOR state — we need to know
  // whether the row was already deactivated before the RPC ran.
  //
  // A read failure here is treated as a hard failure BEFORE any write
  // — the alternative (skip the check, run the RPC, potentially
  // trigger a duplicate email) is worse than surfacing the read error.
  const { data: snapshot, error: readErr } = await supabase
    .from('vehicles')
    .select('plate, unit, resident_email, property, is_active, deactivation_reason')
    .eq('id', vehicleId)
    .maybeSingle()
  if (readErr) {
    console.error('[deactivateVehicleWrite] snapshot SELECT failed', { vehicleId, error: readErr })
    return { ok: false, reason: 'read_failed', error: readErr, message: readErr.message ?? 'Failed to read vehicle before deactivation.' }
  }
  // 🔴 Mateo Aug 9 Item 1: snapshot === null is its own outcome.
  // `.maybeSingle()` distinguishes error (readErr) from zero rows;
  // treating "zero rows" as a snapshot whose fields happen to be null
  // is the D-8 conflation class (see [[feedback_null_safe_operator_
  // conflates_missing_row]] in memory). Zero rows here means:
  //   - The row doesn't exist at all, OR
  //   - RLS hid it from the caller's session (e.g. property = NULL
  //     → property-scoped RLS predicate returns NULL → row filtered).
  // Both cases mean we cannot make a safe no-op decision AND cannot
  // safely fall through — the RPC could still succeed (via SECURITY
  // DEFINER) and produce a mislabeled outcome. Return hard-fail
  // before any field access.
  if (snapshot === null) {
    console.warn('[deactivateVehicleWrite] snapshot not visible (RLS-hidden or missing row)', { vehicleId })
    return {
      ok: false,
      reason: 'not_visible',
      message: 'Vehicle is not visible to your session. If it was just modified elsewhere, refresh and try again; otherwise contact support.',
    }
  }

  // ── No-op detection — same deactivation state already applied ────
  // If the row is already is_active=false AND the reason matches, this
  // is a re-fire. Return ok WITHOUT running the RPC, audit, or notify.
  // Preserves the "one email per deactivation event" invariant. See
  // header note on UI-unreachability — this is defense-in-depth.
  //
  // 🔴 Return shape: `noop: true` and NO emailDecision (same
  // correction as resident writer). No email was sent; claiming
  // emailDecision:'sent' here would be msgBox-class dishonesty.
  const isNoop = snapshot?.is_active === false && snapshot?.deactivation_reason === reason
  if (isNoop) {
    return {
      ok: true,
      noop: true,
      vehicleSnapshot: {
        plate:          snapshot?.plate ?? null,
        unit:           snapshot?.unit ?? null,
        resident_email: snapshot?.resident_email ?? null,
        property:       snapshot?.property ?? null,
      },
    }
  }

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

  // ── Email decision (Commit D + D-8 fix) ──────────────────────────
  // Six outcomes at the writer per Mateo Aug 9. Same order and
  // vocabulary as deactivateResidentWrite (:915-945).
  //
  // Order:
  //   notify=false                             → suppressed-by-cascade
  //   !reasonNotifies('vehicle', reason)       → suppressed-by-reason
  //   !v.resident_email                        → no-email-on-file
  //   else                                     → call notify route
  //                                              → outcome from route
  //
  // 🔴 D-8 FIX (Mateo Aug 9): resident_email is read from `v` (the
  // RPC's post-UPDATE row) NOT from `snapshot`. The snapshot is a
  // session-scoped SELECT; when RLS hides the row from the caller
  // (e.g. NULL property → property-scoped RLS predicate returns NULL
  // → row filtered), `snapshot` is `null` and `snapshot?.resident_email`
  // evaluates to `undefined`, which `!` then coerces to true — a
  // silent mislabel as `no-email-on-file` for a row that actually has
  // a perfectly valid email. `v` comes from the SECURITY DEFINER
  // deactivate_vehicle RPC's `RETURNING *`, which bypasses RLS and
  // gives the true row state. Same rationale for `v.property`
  // downstream: the route re-reads via service-role and applies the
  // `!v.property → failed` branch correctly, which the pre-fix code
  // could not reach.
  //
  // Reason split for vehicles (from VEHICLE_DEACTIVATION_REASONS):
  //   SEND    moved_out · vehicle_sold · not_permitted ·
  //           exceeds_allowance · violation · other
  //   SUPPRESS plate_superseded · registered_in_error
  let emailDecision:  'sent' | 'overridden' | 'suppressed-by-reason' | 'suppressed-by-cascade' | 'no-email-on-file' | 'failed'
  let emailMessageId: string | null = null
  let emailError:     string | null = null

  if (!notify) {
    emailDecision = 'suppressed-by-cascade'
  } else if (!reasonNotifies('vehicle', reason)) {
    emailDecision = 'suppressed-by-reason'
  } else if (!v.resident_email) {
    emailDecision = 'no-email-on-file'
  } else {
    const sendResult = await notifyVehicleDeactivation({ vehicleId: String(vehicleId) })
    if (!sendResult.ok) {
      emailDecision = 'failed'
      emailError    = sendResult.error
    } else if (sendResult.outcome === 'no-email-on-file') {
      // Route independently discovered no email (race: snapshot had
      // resident_email at read but the row was updated between snapshot
      // and route call — or the missing-property branch downgraded).
      // Trust the route.
      emailDecision = 'no-email-on-file'
    } else {
      emailDecision  = sendResult.outcome  // 'sent' | 'overridden'
      emailMessageId = sendResult.message_id
    }
  }

  // ── Audit — extended shape (Task 3 Commit 3 + Commit D email decision) ──
  // Prior shape: {is_active, status, property, meter_fired, note}.
  // Adds: plate, unit, deactivation_reason, deactivation_note,
  // deactivated_by. Keeps meter_fired (still false — deactivate does
  // not fire callSyncOnAdd; count decrements at cycle close via
  // reconcileAtRenewal). RPC did the write; this row records
  // manager-initiated intent + outcome.
  //
  // Commit D adds email_decision/email_message_id/email_error — six
  // outcomes matching Mateo Aug 9's audit vocabulary. Silent no-op is
  // not an acceptable outcome; every path here writes one.
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
      email_decision:      emailDecision,
      email_message_id:    emailMessageId,
      email_error:         emailError,
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
    emailDecision,
    emailMessageId,
    emailError,
  }
}

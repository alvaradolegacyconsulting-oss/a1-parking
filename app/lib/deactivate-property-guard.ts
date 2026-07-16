'use client'

import type { SupabaseClient } from '@supabase/supabase-js'
import { escapeIlikeValue } from './supabase-query-escape'

// ════════════════════════════════════════════════════════════════════
// deactivate-property-guard — shared confirm dialog for property
// deactivation (Option A honest-copy force-confirm)
// 2026-07-16
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────
// Two property-deactivate paths exist with different cascade behaviors:
//   • admin/toggleProperty       → cascade-writes is_active=false on
//                                  user_roles, residents, vehicles +
//                                  swift-handler auth-bans PMs/LAs.
//   • company_admin/togglePropertyActive → no cascade, derived-access-
//                                  only via get_my_effective_active().
//
// The divergent paths are a design wart the FK migration retires
// (project_fk_property_id_migration). Until then, a CA deactivating
// a property silently affects everyone assigned without a confirm
// step. This shared helper unifies the confirm surface — both paths
// call it before their existing cascade writes. Fires on deactivate
// only (activate needs no guard).
//
// ── WHY THE COPY IS DIFFERENT AT ≥1 RESIDENTS ────────────────────────
// Reactivation is NOT fully symmetric (see project_deactivation_model
// 2026-07-16 update): residents.is_active flip restores login access
// AND owner-trim-symmetric vehicles, but:
//   • space_residents rows DELETEd by trigger, no inverse
//   • pending space_requests + guest_authorizations → declined
//     (terminal, not restored)
// Copy B (residents present) names this asymmetry honestly. Copy A
// (no residents) doesn't need to — no space/guest state to lose.
//
// ── WHY NOT SERVER-SIDE p_confirmed FLAG ────────────────────────────
// The guard is UX, not a security boundary. The cascade paths are
// already secured by RLS + role check. A rogue caller who bypasses
// the confirm (dev-tool, scripted client) still hits the same authorized
// destructive action they could have hit before this helper existed.
// Server-side p_confirmed would be a separate architectural change
// (unified deactivate RPC) — filed alongside the FK migration.
// ════════════════════════════════════════════════════════════════════

export interface DeactivatePropertyGuardOpts {
  supabase:     SupabaseClient
  propertyName: string
  company:      string
}

/**
 * Prompt the operator to confirm a property deactivation, showing the
 * count of accounts that will be suspended and (when residents are
 * present) the honest note about what won't auto-restore on reactivate.
 *
 * Returns `true` if the operator confirmed; `false` if they cancelled.
 * On confirm the caller proceeds with its existing cascade + write.
 *
 * Does NOT itself write anything. Pure UX guard.
 */
export async function promptDeactivatePropertyConfirm(
  opts: DeactivatePropertyGuardOpts,
): Promise<boolean> {
  const { supabase, propertyName, company } = opts

  // Parallel count over the three assignment carriers, scoped by
  // company. Escape ILIKE wildcards on `company` (some carriers use
  // ILIKE for tenancy match; escaping is safe on `.eq()` too). Include
  // is_active=false suspended rows — the guard cares about who WILL be
  // affected by the toggle, and re-suspending an already-suspended
  // account is still a change in the operator's mental model.
  const escCompany = escapeIlikeValue(company)
  const [pmRes, driverRes, residentRes] = await Promise.all([
    // Managers + leasing_agents whose assignment array contains this
    // property. Mirrors admin/toggleProperty's own probe shape.
    supabase.from('user_roles').select('email', { count: 'exact', head: true })
      .contains('property', [propertyName])
      .in('role', ['manager', 'leasing_agent'])
      .ilike('company', escCompany),
    supabase.from('drivers').select('id', { count: 'exact', head: true })
      .contains('assigned_properties', [propertyName])
      .ilike('company', escCompany),
    supabase.from('residents').select('id', { count: 'exact', head: true })
      .eq('property', propertyName)
      .ilike('company', escCompany),
  ])

  const pmLaCount   = pmRes.count       ?? 0
  const driverCount = driverRes.count   ?? 0
  const residentCount = residentRes.count ?? 0
  const totalAccounts = pmLaCount + driverCount + residentCount

  // Build the affected-lines list (only show role types that have refs;
  // "0 residents" line in a confirm is noise).
  const lines: string[] = []
  if (pmLaCount > 0)     lines.push(` • ${pmLaCount} property manager${pmLaCount === 1 ? '' : 's'} / leasing agent${pmLaCount === 1 ? '' : 's'}`)
  if (driverCount > 0)   lines.push(` • ${driverCount} driver${driverCount === 1 ? '' : 's'}`)
  if (residentCount > 0) lines.push(` • ${residentCount} resident${residentCount === 1 ? '' : 's'} (plus their vehicles)`)

  // Copy A/B/C:
  //   A — zero refs across all carriers: no suspension impact; still
  //       confirm the destructive action, but keep it short.
  //   B — has residents: honest asymmetry note about space/guest state.
  //   C — has PMs/LAs and/or drivers but no residents: no asymmetry
  //       note needed (nothing to lose beyond login access).
  let body: string
  if (totalAccounts === 0) {
    body =
      `Deactivate "${propertyName}"?\n\n` +
      `No users are currently assigned to this property. It can be REACTIVATED later.\n\n` +
      `Proceed?`
  } else if (residentCount > 0) {
    body =
      `Deactivate "${propertyName}"?\n\n` +
      `This will suspend account access for:\n${lines.join('\n')}\n\n` +
      `Reactivation will restore LOGIN ACCESS — but note: any resident parking-space ` +
      `assignments and pending space/guest requests will NOT auto-restore and will need ` +
      `to be re-created.\n\n` +
      `Proceed with deactivation?`
  } else {
    body =
      `Deactivate "${propertyName}"?\n\n` +
      `This will suspend account access for:\n${lines.join('\n')}\n\n` +
      `They can be REACTIVATED later to restore login access.\n\n` +
      `Proceed?`
  }

  return typeof window !== 'undefined' ? window.confirm(body) : false
}

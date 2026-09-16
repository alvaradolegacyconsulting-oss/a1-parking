// ════════════════════════════════════════════════════════════════════
// Assign a newly-created property to drivers — ADDITIVE ONLY.
//
// Extracted rather than inlined so the constraint below can be proven
// against a fake store, element-wise, without a database. The surface
// owns the UI; this owns the array semantics.
//
// ── 🔴 THE CONSTRAINT ───────────────────────────────────────────────
// This adds ONE property name to the assigned_properties of the drivers
// the CA checked. It never removes, reorders, or rewrites anything
// already in any driver's array.
//
//   · unchecking a driver means DO NOT ADD this property to them. It
//     does NOT mean touch their existing assignments.
//   · a driver not in the list at all — inactive, or created after the
//     list was rendered — is not written to.
//   · re-running must not duplicate an entry.
//
// Why it is spelled out this way: `assigned_properties` is the driver's
// entire scope. A write that replaced the array instead of appending to
// it would silently revoke a driver's access to every OTHER property,
// and the symptom — "driver can't see a property" — is the exact
// complaint that started this feature. It would look like the bug it
// was meant to fix.
//
// ── WHY APPEND CLIENT-SIDE RATHER THAN A DB ARRAY OP ────────────────
// PostgREST cannot express `array_append` in an UPDATE, so the append
// happens here on a per-driver freshly-read array. That makes it
// read-modify-write, and therefore racy against a concurrent edit of
// the SAME driver from the Edit Driver screen: last writer wins, and
// the loser's change is lost.
//
// Accepted, narrowly: the window is milliseconds, the concurrent editor
// would have to be a second CA on the same driver at the same moment,
// and the damage is a missing append rather than a wrong array. The
// durable fix is a DEFINER RPC doing array_append server-side — filed,
// not built, because it turns a UI change into a migration.
// (feedback_last_write_wins_race_on_state_fetch is the same class.)
//
// 🔴 The read is done PER DRIVER AT WRITE TIME, not taken from the list
// the UI rendered. A stale list is how an append silently drops an
// assignment somebody made while this dialog was open.
// ════════════════════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js'

export type AssignOutcome = {
  driver_id: string | number
  driver_name: string
  // 'added'          — the property was appended
  // 'already_had_it' — present before; no write issued (re-run safety)
  // 'failed'         — read or write refused; array untouched
  result: 'added' | 'already_had_it' | 'failed'
  before: string[]
  after: string[]
  error?: string
}

export type AssignSummary = {
  requested: number
  added: number
  already_had_it: number
  failed: number
  outcomes: AssignOutcome[]
}

// Case-insensitive, whitespace-tolerant membership. The DB carries
// trg_drivers_assigned_properties_trim, so stored values are trimmed —
// but a property name differing only by case must still count as
// present, or a re-run appends a near-duplicate that no lookup matches
// consistently. (feedback_property_name_whitespace_class)
export function alreadyAssigned(arr: string[], property: string): boolean {
  const target = property.trim().toLowerCase()
  return arr.some(p => String(p ?? '').trim().toLowerCase() === target)
}

export async function assignPropertyToDrivers(
  supabase: SupabaseClient,
  input: { property: string; driverIds: (string | number)[]; driverNamesById?: Record<string, string> },
): Promise<AssignSummary> {
  const property = input.property.trim()
  const summary: AssignSummary = { requested: input.driverIds.length, added: 0, already_had_it: 0, failed: 0, outcomes: [] }
  if (!property || input.driverIds.length === 0) return summary

  for (const id of input.driverIds) {
    const name = input.driverNamesById?.[String(id)] ?? String(id)
    // ── Fresh read. Never the list the UI rendered. ────────────────
    const { data: row, error: readErr } = await supabase
      .from('drivers')
      .select('id, name, assigned_properties')
      .eq('id', id)
      .maybeSingle()

    if (readErr || !row) {
      summary.failed++
      summary.outcomes.push({
        driver_id: id, driver_name: name, result: 'failed', before: [], after: [],
        // maybeSingle() distinguishes error from zero rows, and zero
        // rows here is an RLS filter or a deleted driver — both mean
        // "do not write", neither means "array is empty".
        error: readErr?.message ?? 'driver row not visible (RLS filter or deleted)',
      })
      continue
    }

    const before: string[] = Array.isArray(row.assigned_properties) ? [...row.assigned_properties] : []

    if (alreadyAssigned(before, property)) {
      summary.already_had_it++
      summary.outcomes.push({ driver_id: id, driver_name: row.name ?? name, result: 'already_had_it', before, after: before })
      continue
    }

    // 🔴 APPEND. Spread-then-push, so every prior element keeps its
    // position and its exact value. Not a rebuild, not a Set, not a
    // sort — each of those would silently normalize or reorder someone
    // else's data.
    const after = [...before, property]

    const { data: updated, error: writeErr } = await supabase
      .from('drivers')
      .update({ assigned_properties: after })
      .eq('id', id)
      .select('id, assigned_properties')

    if (writeErr || !updated || updated.length === 0) {
      // Zero rows returned is the silent-write case: RLS filtered the
      // UPDATE and Supabase reports no error. Never count it as added.
      summary.failed++
      summary.outcomes.push({
        driver_id: id, driver_name: row.name ?? name, result: 'failed', before, after: before,
        error: writeErr?.message ?? 'UPDATE returned 0 rows (RLS filter or stale row)',
      })
      continue
    }

    summary.added++
    summary.outcomes.push({
      driver_id: id, driver_name: row.name ?? name, result: 'added',
      before,
      // The array as the DATABASE has it after the trim trigger, not
      // the array we sent. Those can differ, and the caller's gate
      // compares against reality.
      after: Array.isArray(updated[0]?.assigned_properties) ? updated[0].assigned_properties : after,
    })
  }

  return summary
}

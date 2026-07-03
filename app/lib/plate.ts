// Single source of truth for license-plate normalization.
// Strip everything that isn't [A-Z0-9] and uppercase. Apply at three points:
//   1. onChange handlers — normalize as user types (real-time).
//   2. Before DB writes (insert/update) — defensive normalize.
//   3. Before plate query/search comparisons — so search for "ABC-123"
//      finds plates stored as "ABC123".
export function normalizePlate(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/[^A-Z0-9]/gi, '').toUpperCase()
}

// Slice-4 close-out (Jose 2026-07-03) — enforcement-integrity guard for
// vehicle-add call sites. Two vehicles authorized under one plate at
// one property = ambiguous driver plate lookup, which breaks the whole
// authorization determination. Same-property scope, case-insensitive,
// scoped to authorized-set (active + under_review + is_active=true) so
// deactivated / declined vehicles' plates remain reusable.
//
// Server side, submit_plate_change (the plate-change RPC path) already
// enforces this via its own guard — this helper protects the two legacy
// direct-INSERT client paths in manager/page.tsx (addVehicle at ~L1607
// and the addResident cascade at ~L1724). Returns a message string to
// surface to the operator on collision, or null when clear.
//
// Caller pattern:
//   const err = await assertPlateUniqueAtProperty(supabase, plate, property)
//   if (err) { alert(err); return }
//   await supabase.from('vehicles').insert(...)
//
// Race with concurrent inserts still exists at the client (< 500ms
// window); closing that would need a DB-level partial unique index —
// flagged in the collision-guard migration comment as future hardening.
import type { SupabaseClient } from '@supabase/supabase-js'

export async function assertPlateUniqueAtProperty(
  supabase: SupabaseClient,
  plate: string,
  property: string,
  excludeVehicleId?: number | string,
): Promise<string | null> {
  const normalized = normalizePlate(plate)
  if (!normalized || !property) return null
  const { data } = await supabase
    .from('vehicles')
    .select('id, plate')
    .ilike('property', property)
    .ilike('plate', normalized)
    .eq('is_active', true)
    .in('status', ['active', 'under_review'])
  const dupes = (data ?? []).filter((v: any) => String(v.id) !== String(excludeVehicleId))
  if (dupes.length > 0) {
    return `Plate ${normalized} is already authorized on another vehicle at ${property}. It can't be authorized on two vehicles at once at the same property.`
  }
  return null
}

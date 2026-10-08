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
  // 2026-08-08 — SELECT widened to include unit + resident_email so
  // the collision message can name the owning row within the manager's
  // scope. Safe: the partial unique index
  // (upper(plate), property) WHERE is_active AND status IN ('active','under_review')
  // is PER-PROPERTY, so any collision surfaced here is at the CALLER's
  // property — the caller already has RLS SELECT on those rows. No
  // cross-company or cross-property leak.
  const { data } = await supabase
    .from('vehicles')
    .select('id, plate, unit, resident_email')
    .ilike('property', property)
    .ilike('plate', normalized)
    .eq('is_active', true)
    .in('status', ['active', 'under_review'])
  const dupes = (data ?? []).filter((v: any) => String(v.id) !== String(excludeVehicleId))
  if (dupes.length > 0) {
    const d = dupes[0] as { unit: string | null; resident_email: string | null }
    const unit  = (d.unit && d.unit.trim().length > 0) ? d.unit : '—'
    const email = (d.resident_email && d.resident_email.trim().length > 0) ? d.resident_email : 'unit-level (no owner on file)'
    return `Plate ${normalized} is already authorized at ${property} · Unit ${unit} · ${email}. It can't be authorized on two vehicles at once at the same property.`
  }
  return null
}

// ════════════════════════════════════════════════════════════════════
// normalizeUnit — unit comparison, format-insensitive
// ════════════════════════════════════════════════════════════════════
//
// 🔴 WHY. `unit` is free text that residents and managers both type.
// Green Acres currently holds the same unit as "Traila# 191" and
// "Traila #191" — one resident, one trailer, two spellings. Comparing
// those with equality classified a plain same-resident re-submission as
// a DIFFERENT resident/unit collision, which is the difference between
// "clear this duplicate silently" and "escalate to the property office".
//
// Live shapes this has to survive, all from A1's production data:
//   "116"  "#55"  "Unit 81"  "Unidad #115"  "Trlr 155"  "1012 unit 2"
//
// Deliberately the same aggressive strip as normalizePlate: drop
// everything that is not a letter or digit, then uppercase. "Traila# 191"
// and "Traila #191" both become "TRAILA191".
//
// 🔴 NOT for display and NOT for storage. The typed value is what the
// resident and the manager recognise, so it stays on the row. This is a
// comparison key only.
//
// 🔴 NOT a uniqueness rule either. "Unit 1" and "Unit 01" are different
// units here (1 vs 01) because digits are preserved — zero-padding is a
// real distinction in some buildings and guessing otherwise would merge
// two households.
export function normalizeUnit(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/[^A-Z0-9]/gi, '').toUpperCase()
}

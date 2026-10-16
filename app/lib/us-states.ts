// ════════════════════════════════════════════════════════════════════
// Plate states — ONE list, and a select that cannot lose a value
// ════════════════════════════════════════════════════════════════════
//
// 🔴 WHY THIS EXISTS. Before this file the product had FOUR different
// plate-state vocabularies:
//
//   manager/page.tsx ×3 sites   10 states: TX CA FL NY GA OH IL PA NC AZ
//   AddVehicleForResidentModal  50 states, its own copy
//   register/page.tsx           50 states, a second copy
//   resident/page.tsx           a third list
//   company_admin guest auth    free text, .slice(0,2)
//
// They disagreed with each other AND with production, which holds LA,
// TN, MO, MS, MI and 84 rows spelled "Texas". Two consequences, both
// live before this landed:
//
//   • a manager could not ADD an LA or TN vehicle at all — the option
//     did not exist in their form;
//   • 🔴 opening one of those 11 out-of-state rows in a form and saving
//     it SILENTLY REWROTE the state to TX, because a <select> whose
//     value matches no <option> falls back to the first one. No audit
//     evidence it has fired yet, but nothing stopped it.
//
// ── THE ACTUAL FIX IS PlateStateSelect, NOT THE LIST ────────────────
// A shared list removes today's known gaps. It does nothing about the
// NEXT odd value. So the select renders any unrecognised stored value
// as a selected option labelled "(as recorded)" — saving without
// touching the field keeps it byte-identical. That property is what the
// gate asserts, and it holds for values nobody has thought of.

/**
 * 50 states + DC, then MX.
 *
 * 🔴 MX ADDED 2026-10-16, AND IT HAD A PREREQUISITE. A1 is in Texas and
 * Mexican plates park in these lots; before this the product could not
 * record one anywhere, so the upload copy could not honestly tell a
 * customer what to do with the car. Adding the code alone was not safe:
 * resident/page.tsx kept its own 50-code array for the EDIT form, so a
 * vehicle stored as MX (or DC, which that array also lacked) rendered
 * with no matching option — an empty State box on a vehicle that has
 * one. That array is gone in the same commit. Nothing in the product
 * branches on the value: every `state === …` in the codebase is
 * account_state, and enforcement matches on plate alone.
 *
 * No territories and no Canadian provinces yet — one code, deliberately.
 */
export const PLATE_STATES: readonly string[] = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI',
  'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN',
  'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY',
  // Not a US state, so it sits after the block rather than sorted into
  // it, and it carries a spelled-out label below.
  'MX',
]

/**
 * Labels that are not just the code. A bare "MX" in a list of states
 * reads as a typo; the label says what it is.
 */
const PLATE_STATE_LABELS: Record<string, string> = { MX: 'Mexico (MX)' }

export const DEFAULT_PLATE_STATE = 'TX'

/** Is this exactly one of the accepted codes? Case/space tolerant. */
export function isKnownPlateState(v: string | null | undefined): boolean {
  if (!v) return false
  return PLATE_STATES.includes(v.trim().toUpperCase())
}

/**
 * The options a select must render so it cannot lose `current`.
 *
 * 🔴 Returns the stored value FIRST when it is not a known code, so the
 * browser's "value matches no option" fallback can never fire. The label
 * says "(as recorded)" rather than hiding the oddity: the operator sees
 * that this row holds something unusual, and sees it preserved.
 */
export function plateStateOptions(current: string | null | undefined): { value: string; label: string }[] {
  const cur = (current ?? '').trim()
  const known = PLATE_STATES.map(s => ({ value: s, label: PLATE_STATE_LABELS[s] ?? s }))
  if (!cur || isKnownPlateState(cur)) return known
  return [{ value: cur, label: `${cur} (as recorded)` }, ...known]
}

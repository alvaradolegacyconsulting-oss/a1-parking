// ════════════════════════════════════════════════════════════════════
// display-name — what to show when a resident has no name
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16: a bulk-uploaded row needs only ONE of first_name /
// last_name. The other is stored BLANK — not 'TBD', not 'Unknown' —
// and displayed as a dash.
//
// 🔴 WHY BLANK AND NOT A PLACEHOLDER. residents has a single `name`
// column and the loader concatenates and trims, so ('','Draper')
// becomes 'Draper' and ('','') becomes ''. A placeholder would be a
// value somebody later has to recognise as not-a-name: it sorts among
// real names, it matches a search for it, it gets printed on a notice,
// and the day someone is actually called TBD it is indistinguishable.
// The empty string already means exactly what it means.
//
// 🔴 AND THE DASH IS A RENDER CONCERN ONLY. Nothing writes it. A row
// whose name is '—' in the database would be the placeholder problem
// with a prettier glyph.
//
// Measured 2026-10-16 before this existed: 0 of 654 residents contain
// 'TBD', 0 have a blank name, and 14 have a single-word name — so the
// single-name shape was already present and already stored correctly.

/** An em dash, matching the '—' the rest of the console uses for absent values. */
export const NO_VALUE = '—'

/**
 * A resident's name for display, or a dash when there is none.
 *
 * Takes the stored `name` — the single column — rather than a pair,
 * because the pair only ever existed in the upload template.
 */
export function residentDisplayName(name: string | null | undefined): string {
  const v = (name ?? '').trim()
  return v === '' ? NO_VALUE : v
}

/**
 * `Name (email)` for a dropdown option, which is the other shape a
 * blank name breaks: without this it renders as a leading space and a
 * parenthesis, and the reader cannot tell a missing name from a
 * rendering bug.
 */
export function residentOptionLabel(
  name: string | null | undefined, email: string | null | undefined,
): string {
  return `${residentDisplayName(name)} (${(email ?? '').trim() || NO_VALUE})`
}

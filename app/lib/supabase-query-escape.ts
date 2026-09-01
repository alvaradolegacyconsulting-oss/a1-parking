// PostgREST `.ilike()` argument escaping + write-time metacharacter
// rejection.
//
// SQL LIKE (and PostgREST `.ilike()`) interprets `%` and `_` as
// wildcards; `\` is the LIKE escape char. When the value is
// user-entered (unit / property / email local-part / company name),
// an embedded metachar silently over-matches — a wrong-row WRITE
// hazard on destructive UPDATE/DELETE paths (B166 owner-trim was the
// incident that surfaced this at read time).
//
// Two complementary defenses live here:
//   escapeIlikeValue    — READ-time defensive escape for legacy rows
//                         that already have a metachar in them (pre-
//                         validator writes). Wrap every user-entered
//                         value going into a `.ilike()` call.
//   nameMetacharError   — WRITE-time rejection at name-input forms.
//                         New companies + properties should never
//                         accept a metachar name; server-side CHECK
//                         constraint (companies_name_no_sql_metachar
//                         + properties_name_no_sql_metachar, migration
//                         20260901) is the enforcement boundary; this
//                         is the UX layer so users see a readable
//                         message instead of raw 23514.
//
// Historically escapeIlikeValue lived in `app/manager/page.tsx`
// (line ~76 pre-2026-07-10). Do NOT re-inline either helper in a new
// call site — import from here.

export function escapeIlikeValue(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}

// Write-time validator. Returns a user-facing error string naming the
// SPECIFIC failing character, or null if the name is clean.
//
// 🔴 Rejects EXACTLY three characters: `%`, `_`, `\`. Nothing else.
// Apostrophes, ampersands, hyphens, periods, unicode — all legitimate
// in real names (Mateo Sep 1 §5: "a validator that blocks a
// legitimate name blocks A1's Q4 rollout").
//
// Copy shape names the failing character (not the class) so a user
// who typed `Smith_Lot` sees "the character `_`" and fixes it on the
// first try. No SQL jargon — the input field doesn't have to explain
// wildcards.
export function nameMetacharError(raw: string, kind: 'company' | 'property'): string | null {
  const match = raw.match(/[%_\\]/)
  if (!match) return null
  const label = kind === 'company' ? 'Company' : 'Property'
  return `${label} names can't include the character \`${match[0]}\`. Please remove it and try again.`
}

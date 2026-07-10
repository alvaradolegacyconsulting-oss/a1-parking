// PostgREST `.ilike()` argument escaping.
//
// `.ilike()` interprets `%` and `_` as SQL wildcards. When the value
// is user-entered (unit / property / email local-part), an embedded
// `%` or `_` silently over-matches — a wrong-row WRITE hazard on
// destructive UPDATE/DELETE paths (B166 owner-trim was the incident
// that surfaced this).
//
// Historically defined locally in `app/manager/page.tsx` (line ~76
// pre-2026-07-10); extracted here so CA + admin surfaces can share
// the same helper. Do NOT re-inline this in a new call site — import
// from here.

export function escapeIlikeValue(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}

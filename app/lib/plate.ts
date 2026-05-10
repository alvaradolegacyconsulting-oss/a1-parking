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

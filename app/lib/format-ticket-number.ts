// ══════════════════════════════════════════════════════════════════════
// format-ticket-number — single source of truth for the ticket
// number a person reads back over the phone
// ══════════════════════════════════════════════════════════════════════
//
// Motivation (Mateo lock 2026-08-03):
//
// Three surfaces, one column (violations.id), two formats:
//
//   driver print HTML       "338"        (String(id).substring(0,8).toUpperCase())
//   /ticket/pm/[id]         "00000338"   (String(id).padStart(8,'0').substring(0,8).toUpperCase())
//   /ticket/view/[token]    "00000338"   (same padded formula)
//
// Standardize on the UNPADDED form. The paper wins:
//   • Printed tickets carrying "338" are already on windshields —
//     the hosted surfaces must match what a person is holding.
//   • "338" is what someone reads aloud. "Zero-zero-zero-zero-zero-
//     three-three-eight" invites transcription errors into an
//     enforcement record.
//
// substring(0, 8) preserved for defense-in-depth — violations.id is
// bigint, and at some far-future volume the display could otherwise
// overflow a ticket-number column. toUpperCase() preserved because
// the driver's paper does it — matching the paper verbatim beats
// stripping decoration.

/**
 * The number a person reads back over the phone.
 *
 * Renders: 338 → "338", 12345678 → "12345678", 123456789 → "12345678"
 * (last case truncates — matches the pre-existing driver print
 * behaviour, kept as a load-bearing display cap).
 */
export function formatTicketNumber(id: number | string): string {
  return String(id).substring(0, 8).toUpperCase()
}

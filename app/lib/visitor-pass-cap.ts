// ══════════════════════════════════════════════════════════════════════
// visitor-pass-cap — shared computations for the rolling-30 cap.
// ══════════════════════════════════════════════════════════════════════
//
// One place, one formula. Used by the manager at-cap view
// (fetchAtCapData in manager/page.tsx) and the resident portal's
// pass-limit message. Same formula, same trigger-matching arithmetic,
// same oldest-first contract — divergence would produce a manager and
// a resident being told different dates for the same cap.
//
// ── ELIGIBLE-AGAIN FORMULA ───────────────────────────────────────────
//
// With N passes against limit L (N ≥ L), sorted oldest-first, the
// count drops below L when the (N − L + 1)th oldest pass ages out.
// Zero-indexed: eligible_at = passes[N - L].created_at + 30 days.
//
//   N = L exactly → oldest + 30d (the naive case; visible in prod
//                   as ATCAP03 = 8/17 in the at-cap V1 verify pass).
//   N > L         → later pass than the oldest (limit lowered mid-
//                   window, or plate un-exempted). min() + 30d would
//                   tell the operator a date they'd STILL be blocked
//                   on. General form prevents that.
//
// ── ARITHMETIC — FIXED 30 × 86,400,000 ms (verified 2026-08-08) ───────
//
// The Postgres trigger uses `created_at > now() - interval '30 days'`.
// Interval arithmetic on `timestamptz` depends on the session
// `TimeZone`, which the trigger does NOT set (only `search_path`).
// The Supabase project's session TimeZone was verified 2026-08-08 by
// Jose running the boundary query below:
//
//   SHOW timezone;
//
//   SELECT ('2026-12-01 00:30:00-06'::timestamptz - interval '30 days')
//            AT TIME ZONE 'America/Chicago' AS thirty_days_before_local;
//
//   Result:  2026-11-01 01:30:00
//
// `01:30` means the trigger's `interval '30 days'` is a FIXED 720
// hours (session TimeZone is UTC-equivalent, no DST). So the helper
// below matches the trigger by using `getTime() + 30 * 86400000`.
//
// ── ADR ──────────────────────────────────────────────────────────────
//
// The first implementation of this helper used calendar-aware
// arithmetic in `PROPERTY_TIME_ZONE` on the assumption that the
// trigger did the same. That assumption was WRONG in the direction
// opposite to the naive fixed-ms bug the guard was written against.
// The verification query in this header was the check that caught
// the miss inside an hour — the pattern (write the assumption AND
// the query that would refute it) worked; the miss is what got
// recorded rather than the escape.
//
// NEITHER shape is durable. Both are JS reimplementations of Postgres
// interval semantics, which is the class this codebase has spent the
// week eliminating (see the resident_row_precedence + trigger-mirror
// discipline in the at-cap V1 arc). The durable fix is server-side
// compute — an RPC that returns `eligible_at` directly. Not built:
//
//   - Anon `/visitor` cannot receive `eligible_at` — publishing it
//     creates a visit-enumeration oracle (eligible_at − 30 days = the
//     exact created_at of a specific past pass). Ruled out per the
//     August 8 preflight; withheld from `/visitor` + `/api/visitor/
//     create-pass` by deliberate trade.
//   - Authenticated resident + manager COULD compute server-side; a
//     small RPC that returns `eligible_at` per (property, plate) with
//     RLS-gated `SELECT visitor_passes` would remove the divergence
//     risk entirely. Deferred: the exposure this fixed-ms shape
//     retains is a session-TimeZone change on the Supabase side —
//     unlikely, but if the session flips to `America/Chicago` this
//     helper drifts by an hour twice a year for late-night passes.
//
// If the session TimeZone ever changes, re-run the boundary query
// above and swap this body accordingly. The state of that assumption
// belongs in this file, not in anyone's head.
// ══════════════════════════════════════════════════════════════════════

export function eligibleAgainAt(
  passesOldestFirst: Array<{ created_at: string }>,
  limit: number,
): Date | null {
  const N = passesOldestFirst.length
  if (N < limit) return null
  const kIndex = N - limit
  return addFixedDays(new Date(passesOldestFirst[kIndex].created_at), 30)
}

// Fixed-days addition — matches Postgres `interval '30 days'` when the
// session TimeZone is UTC-equivalent (verified 2026-08-08). See file
// header for the verification query and the swap path if that ever
// changes.
function addFixedDays(source: Date, days: number): Date {
  return new Date(source.getTime() + days * 86_400_000)
}

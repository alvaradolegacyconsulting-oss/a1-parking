// ══════════════════════════════════════════════════════════════════════
// visitor-pass-cap — shared computations for the rolling-30 cap.
// ══════════════════════════════════════════════════════════════════════
//
// One place, one formula. Used by the manager at-cap view
// (fetchAtCapData in manager/page.tsx) and the resident portal's
// pass-limit message. Same formula, same DST behavior, same
// oldest-first contract — divergence would produce a manager and a
// resident being told different dates for the same cap.
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
// ── 🔴 CALENDAR ARITHMETIC (DST-AWARE), NOT FIXED MILLISECONDS ────────
//
// A pass created between midnight and 1 AM CDT during the ~14 days
// before the fall-back transition can be off by a full calendar day
// under fixed-ms arithmetic:
//
//   Pass created:  Nov 1, 2026 00:30 CDT  = 2026-11-01T05:30:00Z
//   + 30 * 86400000 ms →                    2026-12-01T05:30:00Z
//   In America/Chicago (CST, UTC-6) →       2026-11-30 23:30 CST
//   Displayed date:                         "Nov 30, 2026"  ❌
//
//   Trigger with interval '30 days' releases at:
//     2026-12-01 00:30 CST → date "Dec 1, 2026"  ✓
//
// Off by one day. Manager tells visitor Nov 30; trigger releases
// Dec 1. Third timezone finding this week in the same shape
// (see app/lib/format-time.ts header for the tow-time arc).
//
// This helper uses Intl.DateTimeFormat to extract the wall-clock
// Y-M-D in PROPERTY_TIME_ZONE, then adds days via Date's UTC calendar
// rollover (Date.UTC accepts day overflow like 32 → next month), and
// returns a Date anchored at noon UTC on the resulting Y-M-D. Noon UTC
// is 6-7 AM in Chicago on the target date — safely inside the same
// calendar day when rendered by formatDate() under PROPERTY_TIME_ZONE.
//
// ── 🔴 DIVERGENCE RISK — VERIFY BEFORE RELYING (Mateo 2026-08-08) ─────
//
// This helper does CHICAGO-CALENDAR arithmetic. Whether the Postgres
// trigger agrees depends on the session `TimeZone`, which the trigger
// does NOT set (it sets search_path only):
//
//   Session TimeZone = 'America/Chicago' → interval '30 days' is
//     calendar-aware (wall-clock preserving) → THIS HELPER MATCHES
//     the trigger.
//   Session TimeZone = 'UTC' (common Supabase default) → interval
//     '30 days' is exactly 720 hours (UTC has no DST) → THIS HELPER
//     DISAGREES with the trigger, in the OPPOSITE direction from the
//     fixed-ms bug above.
//
// To verify at any time (Supabase SQL Editor):
//
//   SHOW timezone;
//
//   -- Direct fall-back-boundary test:
//   SELECT ('2026-12-01 00:30:00-06'::timestamptz - interval '30 days')
//            AT TIME ZONE 'America/Chicago' AS thirty_days_before_local;
//   -- '2026-11-01 00:30' means wall-clock-preserving (calendar).
//   -- '2026-11-01 01:30' means fixed 720 hours.
//
// If the answer is UTC/720-hours, swap the helper body to fixed
// arithmetic (`getTime() + 30*86400000`) and update this header
// accordingly.
//
// A JS reimplementation of Postgres interval arithmetic is a second
// implementation by definition — the class this codebase has spent
// the week eliminating. The durable fix is to compute the date
// server-side where the semantics are the trigger's by construction.
// Not done here because the exposure is a one-hour window on passes
// created near midnight, twice a year, and the anon-side RPC
// extension for /visitor was ruled out on visit-enumeration grounds.
// If a manager ever reports an off-by-one date, this header is the
// answer.
// ══════════════════════════════════════════════════════════════════════

import { PROPERTY_TIME_ZONE } from './format-time'

export function eligibleAgainAt(
  passesOldestFirst: Array<{ created_at: string }>,
  limit: number,
): Date | null {
  const N = passesOldestFirst.length
  if (N < limit) return null
  const kIndex = N - limit
  return addCalendarDaysInTz(new Date(passesOldestFirst[kIndex].created_at), 30, PROPERTY_TIME_ZONE)
}

function addCalendarDaysInTz(source: Date, days: number, tz: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year:  'numeric',
    month: '2-digit',
    day:   '2-digit',
  }).formatToParts(source)
  const y = parseInt(parts.find(p => p.type === 'year')!.value,  10)
  const m = parseInt(parts.find(p => p.type === 'month')!.value, 10)
  const d = parseInt(parts.find(p => p.type === 'day')!.value,   10)
  return new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0))
}

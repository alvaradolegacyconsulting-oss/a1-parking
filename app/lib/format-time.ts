// ══════════════════════════════════════════════════════════════════════
// format-time — single source of truth for user-visible timestamps
// ══════════════════════════════════════════════════════════════════════
//
// Motivation (Mateo diagnostic 2026-08-03):
//
// Same tow, two surfaces, five hours apart at Green Acres. The two
// hosted tow-ticket pages (`/ticket/pm/[id]`, `/ticket/view/[token]`)
// are async server components rendering on Vercel Node — runtime
// timezone UTC. The rest of the app renders client-side in the
// browser — runtime timezone whatever the user is in. Same
// `.toLocaleString()` call, different runtime, five-hour delta in
// summer, six in winter. On a Chapter 2308 record a timestamp that
// reads differently depending on who opens it is an evidentiary
// problem.
//
// The fix (Mateo lock 2026-08-03):
//   1. Pin the timezone explicitly on every user-visible render
//   2. Print the zone abbreviation so the reader knows what they're
//      looking at (`CDT` in summer, `CST` in winter — from the same
//      formatter, so label can never disagree with the value it
//      labels)
//   3. Centralize both in a helper so the next surface can't drift
//      the way three call sites did to produce this incident
//
// Locale is pinned deliberately. A bare .toLocaleString() also
// inherits the runtime LOCALE, so a server render can differ from a
// browser render in date ORDER as well as in zone. Both defaults are
// the bug.
//
// ── PROPERTY_TIME_ZONE — Texas-only today ────────────────────────────
//
// Texas is MOSTLY Central. El Paso and Hudspeth counties are Mountain
// Time. B3 confirmed no `time_zone` column exists on `properties` or
// `companies` today. When a property in one of those counties onboards,
// this constant becomes the default for a per-property column, and one
// file changes. Not built now — Mateo lock.

export const PROPERTY_TIME_ZONE = 'America/Chicago'

/**
 * Full timestamp (date + time + zone abbreviation).
 *
 * Renders: "8/2/2026, 7:11:48 PM CDT"
 *
 * `null` / `undefined` / invalid dates render as em-dash rather than
 * "Invalid Date" or a crash. Empty visitor_pass rows, un-issued
 * ticket rows, and missing snapshot fields all take this path.
 */
export function formatTimestamp(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    timeZone: PROPERTY_TIME_ZONE,
    timeZoneName: 'short',
    year:   'numeric',
    month:  'numeric',
    day:    'numeric',
    hour:   'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * Date-only (no time, no zone label).
 *
 * Renders: "8/2/2026"
 *
 * A UTC instant of `2026-08-03T00:11:48Z` renders as `8/3` on a
 * server default and `8/2` in a Houston browser. Every late-evening
 * tow lands on the wrong calendar day on any date-only surface that
 * ever server-renders. Same root cause as the full-timestamp bug,
 * quieter symptom.
 *
 * NO zone label — a bare date with "CDT" appended reads oddly and
 * there is no time to disambiguate.
 */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', {
    timeZone: PROPERTY_TIME_ZONE,
  })
}

/**
 * Time-only (HH:MM AM/PM).
 *
 * Renders: "7:11 PM"
 *
 * For contexts where the date is separately labelled and only the
 * time-of-day matters (Active Passes list, activity feed rows).
 */
export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('en-US', {
    timeZone: PROPERTY_TIME_ZONE,
    hour:   'numeric',
    minute: '2-digit',
  })
}

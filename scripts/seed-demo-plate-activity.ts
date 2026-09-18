// ════════════════════════════════════════════════════════════════════
// seed-demo-plate-activity — persistent demo rows for the CA Plate
// Activity tab, so the SCREEN can be judged rather than the logic.
//
//   npx tsx --env-file=.env.local scripts/seed-demo-plate-activity.ts
//
// Cleanup ships in the same commit:
//   npx tsx --env-file=.env.local scripts/cleanup-demo-plate-activity.ts
//
// ── 🔴 THESE ROWS PERSIST IN PRODUCTION ─────────────────────────────
// The verification seeds inside BEGIN/ROLLBACK, which proves the logic
// and leaves nothing to look at. This is the opposite: rows that stay.
// That means real rows in a real database, so two rules hold.
//
// 1. THE MARKER LIVES IN THE DATA, NOT IN A LIST OF IDS.
//    Every pass carries `DEMO — ` in visitor_name; every violation
//    carries it in `notes`. Cleanup keys on the marker. Ids drift — a
//    re-seed, a partial run, someone deleting one by hand — and a
//    cleanup that misses rows is how fixture data becomes permanent.
//    chris.tobar94+new@gmail.com is still in production across two
//    properties for exactly that reason.
//
// 2. TEST-LEGACY ONLY. Never A1. Fake violations on a live customer's
//    property land in their counts, their exports and their tow log.
//
// ── WHAT IS BEING JUDGED ────────────────────────────────────────────
// Not correctness — the gates cover that. LEGIBILITY. Does six passes
// and two violations read clearly? Is the 30-day window obvious without
// hunting for it? Does a live pass look different from an expired one
// at a glance? Is an empty result reassuring rather than ambiguous?
//
// ── COLUMN SHAPES, CHECKED NOT REMEMBERED ───────────────────────────
// From the PostgREST OpenAPI spec, 2026-09-18:
//   visitor_passes NOT NULL beyond identity : none
//   violations     NOT NULL beyond identity : is_confirmed,
//                                             was_authorized_at_time,
//                                             status
// All three are supplied explicitly rather than left to defaults —
// `status` especially, because the tab RENDERS it and a null would look
// like a display bug rather than bad fixture data. Values match real
// rows: status 'new', is_confirmed true, was_authorized_at_time false.
//
// 🔴 Neither table has a NOT NULL business column, so nothing would
// stop a malformed row. That is a filed finding
// (docs/backlog/empty-insert-accepted-visitor-passes-violations-
// 2026-09-17.md), and it is why every field here is explicit.
// ════════════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js'

const PROPERTY = 'Test Legacy Property'
const COMPANY  = 'Test-LEGACY'
export const MARKER = 'DEMO — '

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const daysAgo  = (d: number) => new Date(Date.now() - d * 86400_000).toISOString()
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
const hoursOn  = (h: number) => new Date(Date.now() + h * 3600_000).toISOString()

// created_at is set EXPLICITLY on every row. The spread across 30 days
// is the entire point of the fixture and a default now() would collapse
// all of it onto today.
type Pass = { plate: string; visitor_name: string; visiting_unit: string; duration_hours: number; expires_at: string; is_active: boolean; property: string; created_at: string }
type Viol = { plate: string; violation_type: string; property: string; is_confirmed: boolean; was_authorized_at_time: boolean; status: string; notes: string; created_at: string }

// 🔴 FIVE PASSES FOR DEMO0001, NOT SIX — AND THE SIXTH IS THE POINT.
// The brief asked for six. The first run was REFUSED by the database:
//
//   This vehicle has already been issued 5 visitor passes at this
//   property in the last 30 days.
//
// Test Legacy Property carries visitor_pass_limit = 5, and
// enforce_visitor_pass_limit counts per NORMALIZED plate per property
// per rolling 30 days — so the punctuated DEMO-0001 row counts toward
// DEMO0001's total, exactly as designed.
//
// That is the Ask 1 smoke, performed by accident and passed: a limit
// set, passes issued up to it, the next one refused with plain-language
// copy and no partial write (all-or-nothing insert — verified zero rows
// landed). The feature nobody had exercised yet, exercised.
//
// So the fixture respects the real limit instead of working around it.
// The alternatives were both worse: temporarily clearing a live config
// column and trusting a finally to restore it, or moving to a property
// with no limit and losing the CA/driver setup this one already has.
// Five passes across three units plus two violations is still
// unmistakably the repeat-visitor pattern.
const passes: Pass[] = [
  // ── DEMO0001 — the abuse case. The guest who keeps coming back, and
  //    the reason this feature exists. Five passes in 30 days across
  //    THREE units: one plate visiting several units is the pattern a
  //    CA would actually be suspicious of.
  { plate: 'DEMO0001', visitor_name: MARKER + 'Repeat visitor',  visiting_unit: '12B', duration_hours: 24, expires_at: daysAgo(22), is_active: true,  property: PROPERTY, created_at: daysAgo(23) },
  { plate: 'DEMO0001', visitor_name: MARKER + 'Repeat visitor',  visiting_unit: '4A',  duration_hours: 48, expires_at: daysAgo(15), is_active: true,  property: PROPERTY, created_at: daysAgo(17) },
  { plate: 'DEMO0001', visitor_name: MARKER + 'Repeat visitor',  visiting_unit: '4A',  duration_hours: 24, expires_at: daysAgo(10), is_active: true,  property: PROPERTY, created_at: daysAgo(11) },
  // 🔴 Stored PUNCTUATED. The tab normalizes on both sides, so a search
  //    for DEMO0001 must still find this row — normalization proven in
  //    the UI, not only in E1.
  { plate: 'DEMO-0001', visitor_name: MARKER + 'Repeat visitor', visiting_unit: '7C',  duration_hours: 24, expires_at: daysAgo(5),  is_active: true,  property: PROPERTY, created_at: daysAgo(6)  },
  // The live one. is_active AND expires_at in the future — liveness is
  // both predicates, and this row is what makes that visible.
  { plate: 'DEMO0001', visitor_name: MARKER + 'Repeat visitor',  visiting_unit: '7C',  duration_hours: 12, expires_at: hoursOn(8),  is_active: true,  property: PROPERTY, created_at: hoursAgo(4) },

  // ── DEMO0002 — the ordinary case. A clean result has to LOOK clean.
  //    If one uneventful visit reads as alarming, the design is wrong
  //    in the other direction.
  { plate: 'DEMO0002', visitor_name: MARKER + 'One-time guest',  visiting_unit: '2A',  duration_hours: 24, expires_at: daysAgo(9),  is_active: true,  property: PROPERTY, created_at: daysAgo(10) },

  // ── DEMO0003 — the window boundary. The pair that proves the 30-day
  //    cut, because a window that silently includes too much looks
  //    identical to one that works.
  { plate: 'DEMO0003', visitor_name: MARKER + 'Boundary — INSIDE (29d, must appear)',  visiting_unit: '9D', duration_hours: 24, expires_at: daysAgo(28), is_active: true, property: PROPERTY, created_at: daysAgo(29) },
  { plate: 'DEMO0003', visitor_name: MARKER + 'Boundary — OUTSIDE (31d, must NOT appear)', visiting_unit: '9D', duration_hours: 24, expires_at: daysAgo(30), is_active: true, property: PROPERTY, created_at: daysAgo(31) },
]

const violations: Viol[] = [
  { plate: 'DEMO0001', violation_type: 'fire_lane',      property: PROPERTY, is_confirmed: true, was_authorized_at_time: false, status: 'new',      notes: MARKER + 'demo fixture', created_at: daysAgo(20) },
  { plate: 'DEMO0001', violation_type: 'handicap_zone',  property: PROPERTY, is_confirmed: true, was_authorized_at_time: false, status: 'resolved', notes: MARKER + 'demo fixture', created_at: daysAgo(8)  },
  { plate: 'DEMO0003', violation_type: 'no_parking_zone',property: PROPERTY, is_confirmed: true, was_authorized_at_time: false, status: 'new',      notes: MARKER + 'demo fixture — OUTSIDE window (32d, must NOT appear)', created_at: daysAgo(32) },
]

async function main() {
  // Guard: never seed anywhere but the test tenant, whatever the
  // constants above say.
  const { data: prop } = await admin.from('properties').select('name, company')
    .eq('name', PROPERTY).maybeSingle()
  if (!prop) { console.error(`FIXTURE FAIL: property "${PROPERTY}" not found.`); process.exit(1) }
  if (String(prop.company).toLowerCase() !== COMPANY.toLowerCase()) {
    console.error(`REFUSING: "${PROPERTY}" belongs to ${prop.company}, not ${COMPANY}. Demo rows never go on a live customer's property.`)
    process.exit(1)
  }

  const { data: p, error: pErr } = await admin.from('visitor_passes').insert(passes).select('id')
  if (pErr) { console.error('pass insert failed:', pErr.message); process.exit(1) }
  const { data: v, error: vErr } = await admin.from('violations').insert(violations).select('id')
  if (vErr) { console.error('violation insert failed:', vErr.message); process.exit(1) }

  console.log(`seeded into ${PROPERTY} (${COMPANY})`)
  console.log(`   visitor_passes : ${p?.length ?? 0}`)
  console.log(`   violations     : ${v?.length ?? 0}`)
  console.log(`\nwhat to expect in the tab (30-day window):`)
  console.log(`   DEMO0001  5 passes (1 live now, 1 stored punctuated as DEMO-0001) + 2 violations
     ↑ five, not six: the property's own visitor_pass_limit=5 refused the sixth.
       That refusal IS the Ask 1 smoke, and it passed.`)
  console.log(`   DEMO0002  1 pass, expired, no violations`)
  console.log(`   DEMO0003  1 pass (29d) — and the 31d pass + 32d violation must be ABSENT`)
  console.log(`\ncleanup: npx tsx --env-file=.env.local scripts/cleanup-demo-plate-activity.ts`)
}
main()

// ════════════════════════════════════════════════════════════════════
// cleanup-demo-plate-activity — removes what seed-demo-plate-activity
// created. Written in the SAME COMMIT as the seed, deliberately: a seed
// script with no companion is how chris.tobar94+new@gmail.com ended up
// in production data across two properties.
//
//   npx tsx --env-file=.env.local scripts/cleanup-demo-plate-activity.ts
//
// 🔴 KEYS ON THE MARKER IN THE DATA, NEVER ON A LIST OF IDS. Ids drift —
// a re-seed, a partial run, a row deleted by hand — and a cleanup that
// misses rows is how fixture data becomes permanent.
//
// Scoped to the property as well as the marker, so it cannot reach
// anything outside the test tenant even if a marker string appeared
// elsewhere.
//
// Both deletes use .select() so the COUNT comes back: a run that
// deleted nothing must be distinguishable from one that deleted
// everything. Zero is a legitimate result (already clean) and is
// reported as such, not as success-by-silence.
// ════════════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js'

const PROPERTY = 'Test Legacy Property'
const MARKER   = 'DEMO — '

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function main() {
  const { data: p, error: pErr } = await admin
    .from('visitor_passes').delete()
    .eq('property', PROPERTY).like('visitor_name', `${MARKER}%`)
    .select('id, plate')
  if (pErr) { console.error('pass delete failed:', pErr.message); process.exit(1) }

  const { data: v, error: vErr } = await admin
    .from('violations').delete()
    .eq('property', PROPERTY).like('notes', `${MARKER}%`)
    .select('id, plate')
  if (vErr) { console.error('violation delete failed:', vErr.message); process.exit(1) }

  console.log(`visitor_passes deleted : ${p?.length ?? 0}`)
  console.log(`violations deleted     : ${v?.length ?? 0}`)

  // Verify-after-delete. A delete that reports rows but leaves some
  // behind is the failure this catches — the same reason the tow-log
  // smoke asserted with RETURNING rather than trusting the call.
  const { data: leftP } = await admin.from('visitor_passes').select('id')
    .eq('property', PROPERTY).like('visitor_name', `${MARKER}%`)
  const { data: leftV } = await admin.from('violations').select('id')
    .eq('property', PROPERTY).like('notes', `${MARKER}%`)
  const left = (leftP?.length ?? 0) + (leftV?.length ?? 0)

  if (left > 0) { console.error(`\n🔴 ${left} marked row(s) REMAIN after the delete. Investigate before re-seeding.`); process.exit(1) }
  console.log(`\n✅ no marked rows remain at ${PROPERTY}`)
  if ((p?.length ?? 0) + (v?.length ?? 0) === 0) console.log('   (nothing to delete — already clean, not a failure)')
}
main()

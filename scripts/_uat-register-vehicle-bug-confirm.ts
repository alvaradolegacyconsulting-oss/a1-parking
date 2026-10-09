// UAT diagnostic — confirm the /register companion-vehicle insert hypothesis.
// Read-only. No writes.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

const TEST_EMAIL = 'alvaradolegacyconsutling+addres@gmail.com'
const TEST_UNIT = '503'
const TEST_PROPERTY = 'Bayou Heights Apartments'

async function main() {
  console.log(`Test triplet:`)
  console.log(`  email:    ${TEST_EMAIL}`)
  console.log(`  unit:     ${TEST_UNIT}`)
  console.log(`  property: ${TEST_PROPERTY}`)
  console.log('')

  // ── Q1.A — does any vehicles row exist for this resident? ──
  console.log('── Q1.A — vehicles rows matching this resident ──')
  const { data: vByEmail, error: vErr } = await supabase
    .from('vehicles')
    .select('id, plate, status, is_active, property, unit, resident_email, created_at')
    .ilike('resident_email', TEST_EMAIL)
    .order('created_at', { ascending: false })
  if (vErr) { console.error('vehicles by email query failed:', vErr.message); process.exit(1) }
  console.log(`Match by resident_email: ${vByEmail?.length ?? 0} rows`)
  if (vByEmail && vByEmail.length > 0) console.log(JSON.stringify(vByEmail, null, 2))

  console.log('\n── Q1.B — vehicles rows on this (unit, property) regardless of owner ──')
  const { data: vByLoc, error: vlErr } = await supabase
    .from('vehicles')
    .select('id, plate, status, is_active, property, unit, resident_email, created_at')
    .ilike('unit', TEST_UNIT)
    .ilike('property', TEST_PROPERTY)
    .order('created_at', { ascending: false })
  if (vlErr) { console.error('vehicles by location query failed:', vlErr.message); process.exit(1) }
  console.log(`Match by (unit, property): ${vByLoc?.length ?? 0} rows`)
  if (vByLoc && vByLoc.length > 0) console.log(JSON.stringify(vByLoc, null, 2))

  // ── Q1.C — residents row exists (cross-reference) ──
  console.log('\n── Q1.C — residents row for this email ──')
  const { data: resRow, error: rErr } = await supabase
    .from('residents')
    .select('id, email, name, status, is_active, property, unit, created_at')
    .ilike('email', TEST_EMAIL)
  if (rErr) { console.error('residents query failed:', rErr.message); process.exit(1) }
  console.log(`Match: ${resRow?.length ?? 0} rows`)
  if (resRow && resRow.length > 0) console.log(JSON.stringify(resRow, null, 2))

  // ── Q1.D — user_roles row exists ──
  console.log('\n── Q1.D — user_roles row ──')
  const { data: urRow } = await supabase
    .from('user_roles')
    .select('email, role, company, property, is_active, created_at')
    .ilike('email', TEST_EMAIL)
  console.log(`Match: ${urRow?.length ?? 0} rows`)
  if (urRow && urRow.length > 0) console.log(JSON.stringify(urRow, null, 2))

  // ── Q1.E — auth.users record exists (auth side of the signup) ──
  console.log('\n── Q1.E — auth.users record ──')
  const { data: authList } = await supabase.auth.admin.listUsers()
  const match = authList?.users?.find(u => u.email?.toLowerCase() === TEST_EMAIL.toLowerCase())
  if (match) {
    console.log(JSON.stringify({
      id: match.id,
      email: match.email,
      email_confirmed_at: match.email_confirmed_at,
      banned_until: (match as any).banned_until,
      created_at: match.created_at,
    }, null, 2))
  } else {
    console.log('No auth.users record for this email')
  }
}

main().catch(e => { console.error(e); process.exit(1) })

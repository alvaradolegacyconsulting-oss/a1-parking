// PM CRM slice 3 preflight — CO-RESIDENT RELEASE proof.
//
// Purpose: prove that free_space(space_id, 'manual_free', resident_email)
// deletes ONLY the caller's tie from space_residents. Co-residents survive;
// the space stays assigned. This is the correctness invariant slice 3
// relies on for the Release button.
//
// Approach:
//   1. Provision a throwaway property + 2 throwaway residents + 1 throwaway
//      space, tied to BOTH residents via space_residents.
//   2. Sign in as a manager whose user_roles.property[] includes that
//      property, call free_space(space_id, 'manual_free', resident_A_email).
//   3. Query space_residents post-call: resident B's tie should remain;
//      resident A's tie should be gone; space.status should still be
//      'assigned'; audit_logs should show mode='per_resident'.
//   4. Cleanup: delete the temp space + residents (also removes B's tie by
//      FK cascade), remove property scope from the manager, delete the
//      temp property.
//
// Read-only until the temp rows are inserted; self-cleaning at end;
// non-destructive to real data by construction (temp-only names).
//
// Run: npx tsx --env-file=.env.local scripts/probe-crm-slice3-coresident-release.ts

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const MANAGER = 'chris.tobar94+happy@gmail.com'   // has manager role at French Quarter (A1 Test Run 2)

const PROBE_TAG = `__probe_coresident_release_${process.env.USER || 'run'}__`
const PROP_NAME = `${PROBE_TAG}_prop`
const RES_A_EMAIL = `${PROBE_TAG}_a@example.com`
const RES_B_EMAIL = `${PROBE_TAG}_b@example.com`

async function main() {
  const admin: SupabaseClient = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('══ CO-RESIDENT RELEASE PROBE ══════════════════════════════════════\n')
  console.log(`Manager: ${MANAGER}`)
  console.log(`Tag: ${PROBE_TAG}\n`)

  // Look up manager's user_roles row to reuse their company for scoping.
  const { data: mgrRole } = await admin.from('user_roles')
    .select('email, role, property, company').ilike('email', MANAGER).maybeSingle()
  if (!mgrRole) { console.error('manager not found'); process.exit(2) }
  console.log(`Manager company: ${mgrRole.company}`)
  console.log(`Manager properties: ${JSON.stringify(mgrRole.property)}`)

  const originalProperties = (mgrRole.property || []) as string[]

  // ── 1. Provision throwaway property + residents + space ──────────
  console.log('\n─── 1. Provisioning temp property + 2 residents + 1 space ────')
  const { data: propIns, error: propErr } = await admin.from('properties')
    .insert({ name: PROP_NAME, company: mgrRole.company })
    .select('id, name, company').single()
  if (propErr) { console.error('property insert failed:', propErr.message); process.exit(3) }
  console.log(`  ✓ property id=${propIns.id} name=${propIns.name}`)

  // Grant manager access to this property temporarily.
  await admin.from('user_roles')
    .update({ property: Array.from(new Set([...originalProperties, PROP_NAME])) })
    .ilike('email', MANAGER)
  console.log(`  ✓ manager granted temp property scope`)

  const { data: resAIns, error: aErr } = await admin.from('residents')
    .insert({
      email: RES_A_EMAIL, name: 'Probe A', unit: '999', property: PROP_NAME,
      company: mgrRole.company, status: 'active', is_active: true,
    })
    .select('id, email').single()
  if (aErr) { console.error('resident A insert failed:', aErr.message); process.exit(4) }
  const { data: resBIns, error: bErr } = await admin.from('residents')
    .insert({
      email: RES_B_EMAIL, name: 'Probe B', unit: '999', property: PROP_NAME,
      company: mgrRole.company, status: 'active', is_active: true,
    })
    .select('id, email').single()
  if (bErr) { console.error('resident B insert failed:', bErr.message); process.exit(5) }
  console.log(`  ✓ resident A id=${resAIns.id} email=${resAIns.email}`)
  console.log(`  ✓ resident B id=${resBIns.id} email=${resBIns.email}`)

  const { data: spaceIns, error: sErr } = await admin.from('spaces')
    .insert({
      label: 'P-999', type: 'regular', status: 'assigned', is_active: true,
      property: PROP_NAME, company: mgrRole.company,
      assigned_to_resident_email: RES_A_EMAIL,  // legacy field: whichever tie was made first
      assigned_at: new Date().toISOString(),
      assigned_by_email: MANAGER,
      created_by_email: MANAGER,
    })
    .select('id, label, status, assigned_to_resident_email').single()
  if (sErr) { console.error('space insert failed:', sErr.message); process.exit(6) }
  console.log(`  ✓ space id=${spaceIns.id} label=${spaceIns.label}`)

  // Insert BOTH ties in space_residents.
  const { error: tiesErr } = await admin.from('space_residents').insert([
    { space_id: spaceIns.id, resident_email: RES_A_EMAIL, added_by_email: MANAGER },
    { space_id: spaceIns.id, resident_email: RES_B_EMAIL, added_by_email: MANAGER },
  ])
  if (tiesErr) { console.error('ties insert failed:', tiesErr.message); process.exit(7) }
  console.log(`  ✓ both residents tied to space via space_residents\n`)

  // Verify starting state.
  const { data: startTies } = await admin.from('space_residents').select('resident_email').eq('space_id', spaceIns.id)
  console.log(`  START: space_residents ties = ${JSON.stringify(startTies?.map(t => t.resident_email))}`)

  // ── 2. Sign in as manager, release A's tie ────────────────────────
  console.log('\n─── 2. Manager releases A only (via free_space PER-TIE path) ──')
  const linkRes = await admin.auth.admin.generateLink({ type: 'magiclink', email: MANAGER })
  if (linkRes.error || !linkRes.data?.properties) { console.error('generateLink failed:', linkRes.error?.message); process.exit(8) }
  const tokenHash = (linkRes.data.properties as any).hashed_token
  const anon = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  const otpRes = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
  if (otpRes.error) { console.error('verifyOtp failed:', otpRes.error.message); process.exit(9) }
  console.log(`  ✓ signed in as manager`)

  const relRes = await anon.rpc('free_space', {
    p_space_id: spaceIns.id,
    p_reason: 'manual_free',
    p_resident_email: RES_A_EMAIL,
  })
  if (relRes.error) { console.error('free_space RPC error:', relRes.error.message); process.exit(10) }
  console.log(`  ✓ free_space returned: ${JSON.stringify(relRes.data)}`)

  await anon.auth.signOut()

  // ── 3. Verify: A gone, B remains, space still assigned ────────────
  console.log('\n─── 3. Verify co-resident retained ────────────────────────────')
  const { data: endTies } = await admin.from('space_residents').select('resident_email').eq('space_id', spaceIns.id)
  const remainingEmails = (endTies ?? []).map(t => (t.resident_email as string).toLowerCase())
  const aStillTied = remainingEmails.includes(RES_A_EMAIL.toLowerCase())
  const bStillTied = remainingEmails.includes(RES_B_EMAIL.toLowerCase())
  console.log(`  END: space_residents ties = ${JSON.stringify(endTies?.map(t => t.resident_email))}`)
  console.log(`  A tie present? ${aStillTied ? '❌ YES (BUG)' : '✓ NO (correct — released)'}`)
  console.log(`  B tie present? ${bStillTied ? '✓ YES (correct — co-resident retained)' : '❌ NO (BUG — dropped)'}`)

  const { data: spaceEnd } = await admin.from('spaces').select('id, status, assigned_to_resident_email').eq('id', spaceIns.id).single()
  console.log(`  space.status = ${spaceEnd?.status}`)
  console.log(`  space.assigned_to_resident_email = ${JSON.stringify(spaceEnd?.assigned_to_resident_email)}  (should be B, dual-write from remaining=1)`)

  const { data: auditRows } = await admin.from('audit_logs')
    .select('action, new_values, created_at')
    .eq('table_name', 'spaces')
    .eq('record_id', spaceIns.id)
    .order('created_at', { ascending: false })
    .limit(3)
  console.log(`  audit rows for this space (last 3):`)
  for (const row of auditRows ?? []) {
    console.log(`    · ${row.created_at} · action=${row.action} · new_values=${JSON.stringify(row.new_values)}`)
  }

  const passed = !aStillTied && bStillTied && spaceEnd?.status === 'assigned'
  console.log(`\n  VERDICT: ${passed ? '🟢 PASS — per-tie release semantics correct' : '🔴 FAIL — investigate'}`)

  // ── 4. Cleanup ────────────────────────────────────────────────────
  console.log('\n─── 4. Cleanup ────────────────────────────────────────────────')
  await admin.from('space_residents').delete().eq('space_id', spaceIns.id)
  await admin.from('spaces').delete().eq('id', spaceIns.id)
  await admin.from('residents').delete().eq('id', resAIns.id)
  await admin.from('residents').delete().eq('id', resBIns.id)
  await admin.from('user_roles')
    .update({ property: originalProperties })
    .ilike('email', MANAGER)
  await admin.from('properties').delete().eq('id', propIns.id)
  // Purge audit rows we created so cleanup doesn't leave probe droppings.
  await admin.from('audit_logs').delete().eq('table_name', 'spaces').eq('record_id', spaceIns.id)
  console.log('  ✓ cleaned up temp property, residents, space, ties, audit rows, manager scope\n')

  process.exit(passed ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })

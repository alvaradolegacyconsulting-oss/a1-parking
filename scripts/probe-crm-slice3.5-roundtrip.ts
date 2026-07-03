// PM CRM Slice 3.5 — E2E round-trip probe.
//
// Proves the resident-side of the space workflow reads from the same
// source of truth the PM CRM writes to (spaces + space_residents). Two
// scenarios end-to-end:
//   (A) APPROVE path:
//       provision resident A + space + pending space_request → PM approves
//       via approve_space_request → sign in as resident A → verify the
//       resident-side query returns the assigned space (as if My Info were
//       rendering it) + the space_request status = 'approved'
//   (B) DECLINE path:
//       provision resident B + pending space_request → PM declines with a
//       reason via decline_space_request → sign in as resident B → verify
//       the resident-side query returns NO assigned spaces + the space
//       request status = 'declined' + decline_reason surfaced
//
// Only the DB reads the resident-portal code makes are simulated (the fetch
// from spaces + space_residents at loadResident). The UI itself is not
// exercised — the round-trip is: data written on PM side → data readable
// by resident with correct values.
//
// Self-cleaning: temp property + residents + spaces + requests + audit
// rows removed at end.
//
// Run: npx tsx --env-file=.env.local scripts/probe-crm-slice3.5-roundtrip.ts

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const MANAGER = 'chris.tobar94+happy@gmail.com'

const TAG = `__probe_slice35_roundtrip_${process.env.USER || 'run'}__`
const PROP_NAME = `${TAG}_prop`
const RES_A_EMAIL = `${TAG}_a@example.com`
const RES_B_EMAIL = `${TAG}_b@example.com`

// Mirrors app/resident/page.tsx loadResident's space fetch. If this ever
// drifts, the resident will see something different from what the CRM
// wrote — the exact class we're guarding against.
async function residentSideFetchSpaces(client: SupabaseClient, email: string, property: string) {
  const emailLower = email.toLowerCase()
  const [{ data: ties }, { data: legacyRows }] = await Promise.all([
    client.from('space_residents').select('space_id').ilike('resident_email', emailLower),
    client.from('spaces').select('id').ilike('assigned_to_resident_email', emailLower),
  ])
  const spaceIds = Array.from(new Set([
    ...(ties ?? []).map((t: any) => t.space_id as number),
    ...(legacyRows ?? []).map((r: any) => r.id as number),
  ]))
  if (spaceIds.length === 0) return []
  const { data: fullRows } = await client
    .from('spaces')
    .select('id, label, type')
    .in('id', spaceIds)
    .eq('is_active', true)
    .eq('status', 'assigned')
    .ilike('property', property)
  return (fullRows ?? []).map((r: any) => ({
    id: r.id, label: r.label, type: r.type,
  }))
}

async function residentSideFetchSpaceRequest(client: SupabaseClient, email: string) {
  const { data } = await client
    .from('space_requests')
    .select('id, status, decline_reason, resident_read')
    .ilike('resident_email', email)
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data
}

async function cleanup(admin: SupabaseClient, originalProperties: string[]) {
  // Nuke everything tagged with the probe prefix. Idempotent.
  await admin.from('space_requests').delete().ilike('resident_email', `%${TAG}%`)
  await admin.from('space_residents').delete().ilike('resident_email', `%${TAG}%`)
  await admin.from('user_roles').delete().ilike('email', `%${TAG}%`)
  await admin.from('residents').delete().ilike('email', `%${TAG}%`)
  await admin.from('spaces').delete().ilike('property', `${TAG}%`)
  await admin.from('properties').delete().ilike('name', `${TAG}%`)
  await admin.from('user_roles').update({ property: originalProperties }).ilike('email', MANAGER)
  await admin.from('audit_logs').delete().ilike('user_email', MANAGER).ilike('action', 'AUTH_SPACE_%').gte('created_at', new Date(Date.now() - 60_000).toISOString())
}

async function main() {
  const admin: SupabaseClient = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('══ SLICE 3.5 ROUND-TRIP PROBE ═══════════════════════════════════\n')
  console.log(`Manager: ${MANAGER}`)
  console.log(`Tag: ${TAG}\n`)

  const { data: mgrRole } = await admin.from('user_roles')
    .select('property, company').ilike('email', MANAGER).maybeSingle()
  if (!mgrRole) { console.error('manager not found'); process.exit(2) }
  const originalProperties = (mgrRole.property || []) as string[]
  const company = mgrRole.company as string

  // Pre-clean any stray probe rows from previous runs.
  await cleanup(admin, originalProperties)

  // ── Provision ─────────────────────────────────────────────────────
  console.log('─── 1. Provisioning ──────────────────────────────────────────')
  const { data: propIns } = await admin.from('properties')
    .insert({ name: PROP_NAME, company }).select('id, name').single()
  console.log(`  ✓ property id=${propIns!.id} name=${propIns!.name}`)

  await admin.from('user_roles')
    .update({ property: Array.from(new Set([...originalProperties, PROP_NAME])) })
    .ilike('email', MANAGER)

  const { data: resAIns } = await admin.from('residents').insert({
    email: RES_A_EMAIL, name: 'Probe A', unit: '801', property: PROP_NAME,
    company, status: 'active', is_active: true,
  }).select('id').single()
  const { data: resBIns } = await admin.from('residents').insert({
    email: RES_B_EMAIL, name: 'Probe B', unit: '802', property: PROP_NAME,
    company, status: 'active', is_active: true,
  }).select('id').single()
  console.log(`  ✓ residents id=A:${resAIns!.id} B:${resBIns!.id}`)

  // user_roles entries — critical for RLS. get_my_role() returns the role
  // from user_roles for lower(email)=lower(jwt.email). Without these rows,
  // the throwaway auth session has no role → no policy admits reads.
  await admin.from('user_roles').insert([
    { email: RES_A_EMAIL, role: 'resident', company, property: [PROP_NAME] },
    { email: RES_B_EMAIL, role: 'resident', company, property: [PROP_NAME] },
  ])
  console.log(`  ✓ user_roles rows for both residents (role='resident')`)

  // Available space for A to be assigned into.
  const { data: spaceIns } = await admin.from('spaces').insert({
    label: 'S-801', type: 'regular', status: 'available', is_active: true,
    property: PROP_NAME, company,
    created_by_email: MANAGER,
  }).select('id, label').single()
  console.log(`  ✓ space id=${spaceIns!.id} label=${spaceIns!.label}`)

  // Pending space request for A and for B. Real schema has no
  // requested_space_id/label columns (resident asks generically; PM picks
  // the space at approval time). Note: partial UNIQUE(resident_email)
  // WHERE status='pending' means only one pending per resident-email — OK
  // here because A and B are distinct residents.
  const { data: reqAIns, error: reqAErr } = await admin.from('space_requests').insert({
    resident_email: RES_A_EMAIL, property: PROP_NAME, status: 'pending',
    note: 'Probe: request from A',
  }).select('id').single()
  if (reqAErr) { console.error('space_requests A insert failed:', reqAErr.message); await cleanup(admin, originalProperties); process.exit(3) }
  const { data: reqBIns, error: reqBErr } = await admin.from('space_requests').insert({
    resident_email: RES_B_EMAIL, property: PROP_NAME, status: 'pending',
    note: 'Probe: request from B',
  }).select('id').single()
  if (reqBErr) { console.error('space_requests B insert failed:', reqBErr.message); await cleanup(admin, originalProperties); process.exit(4) }
  console.log(`  ✓ space_requests id=A:${reqAIns!.id} B:${reqBIns!.id}\n`)

  // ── Manager session ──────────────────────────────────────────────
  const linkRes = await admin.auth.admin.generateLink({ type: 'magiclink', email: MANAGER })
  const tokenHash = (linkRes.data!.properties as any).hashed_token
  const mgrClient = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  await mgrClient.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })

  // ── (A) APPROVE path ──────────────────────────────────────────────
  console.log('─── 2. APPROVE path — PM approves A → resident A sees space ──')
  const approveRes = await mgrClient.rpc('approve_space_request', {
    p_request_id: reqAIns!.id,
    p_space_id: spaceIns!.id,
  })
  if (approveRes.error) { console.error('approve_space_request failed:', approveRes.error.message); await cleanup(admin, originalProperties); process.exit(3) }
  console.log(`  ✓ approve_space_request returned: ${JSON.stringify(approveRes.data)}`)

  // Now sign in as resident A and simulate the loadResident space-fetch.
  const linkA = await admin.auth.admin.createUser({ email: RES_A_EMAIL, email_confirm: true })
    .catch(() => admin.auth.admin.generateLink({ type: 'magiclink', email: RES_A_EMAIL }))
  const linkA2 = await admin.auth.admin.generateLink({ type: 'magiclink', email: RES_A_EMAIL })
  const tokenA = (linkA2.data!.properties as any).hashed_token
  const clientA = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  const otpA = await clientA.auth.verifyOtp({ token_hash: tokenA, type: 'magiclink' })
  if (otpA.error) { console.error('resident A signin failed:', otpA.error.message); await cleanup(admin, originalProperties); process.exit(4) }
  console.log(`  ✓ signed in as resident A`)

  const aSpaces = await residentSideFetchSpaces(clientA, RES_A_EMAIL, PROP_NAME)
  const aRequest = await residentSideFetchSpaceRequest(clientA, RES_A_EMAIL)
  console.log(`  resident A sees assignedSpaces = ${JSON.stringify(aSpaces)}`)
  console.log(`  resident A sees space_request  = ${JSON.stringify({ status: aRequest?.status, decline_reason: aRequest?.decline_reason })}`)
  await clientA.auth.signOut()

  const approvePass =
    aSpaces.length === 1 && aSpaces[0].label === 'S-801' &&
    aRequest?.status === 'approved'
  console.log(`  APPROVE VERDICT: ${approvePass ? '🟢 PASS — resident sees assigned space + status=approved' : '🔴 FAIL'}\n`)

  // ── (B) DECLINE path ──────────────────────────────────────────────
  console.log('─── 3. DECLINE path — PM declines B with reason → resident sees ──')
  const declineReason = 'This space was assigned to another resident before your request was reviewed.'
  const declineRes = await mgrClient.rpc('decline_space_request', {
    p_request_id: reqBIns!.id,
    p_decline_reason: declineReason,
  })
  if (declineRes.error) { console.error('decline_space_request failed:', declineRes.error.message); await cleanup(admin, originalProperties); process.exit(5) }
  console.log(`  ✓ decline_space_request returned: ${JSON.stringify(declineRes.data)}`)

  const linkB = await admin.auth.admin.createUser({ email: RES_B_EMAIL, email_confirm: true })
    .catch(() => admin.auth.admin.generateLink({ type: 'magiclink', email: RES_B_EMAIL }))
  const linkB2 = await admin.auth.admin.generateLink({ type: 'magiclink', email: RES_B_EMAIL })
  const tokenB = (linkB2.data!.properties as any).hashed_token
  const clientB = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  const otpB = await clientB.auth.verifyOtp({ token_hash: tokenB, type: 'magiclink' })
  if (otpB.error) { console.error('resident B signin failed:', otpB.error.message); await cleanup(admin, originalProperties); process.exit(6) }
  console.log(`  ✓ signed in as resident B`)

  const bSpaces = await residentSideFetchSpaces(clientB, RES_B_EMAIL, PROP_NAME)
  const bRequest = await residentSideFetchSpaceRequest(clientB, RES_B_EMAIL)
  console.log(`  resident B sees assignedSpaces = ${JSON.stringify(bSpaces)}`)
  console.log(`  resident B sees space_request  = ${JSON.stringify({ status: bRequest?.status, decline_reason: bRequest?.decline_reason })}`)
  await clientB.auth.signOut()

  const declinePass =
    bSpaces.length === 0 &&
    bRequest?.status === 'declined' &&
    bRequest?.decline_reason === declineReason
  console.log(`  DECLINE VERDICT: ${declinePass ? '🟢 PASS — resident sees status=declined + reason' : '🔴 FAIL'}\n`)

  // ── Cleanup ───────────────────────────────────────────────────────
  console.log('─── 4. Cleanup ──────────────────────────────────────────────')
  await mgrClient.auth.signOut()
  // Delete throwaway auth users if we created them (best-effort; ignore errors).
  const { data: authUsers } = await admin.auth.admin.listUsers({ perPage: 200 })
  for (const u of authUsers?.users ?? []) {
    if (u.email && (u.email.endsWith('_a@example.com') || u.email.endsWith('_b@example.com')) && u.email.includes('__probe_slice35_')) {
      await admin.auth.admin.deleteUser(u.id).catch(() => {})
    }
  }
  await cleanup(admin, originalProperties)
  console.log('  ✓ cleaned up temp property, residents, spaces, ties, requests, audit rows, manager scope, auth users\n')

  const passed = approvePass && declinePass
  console.log(`OVERALL: ${passed ? '🟢🟢 BOTH PATHS PASS — round-trip verified' : '🔴 FAIL — investigate above'}`)
  process.exit(passed ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })

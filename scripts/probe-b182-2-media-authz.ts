// B182 #2 — media authz close: regression probe.
//
// Validates the post-migration state of UPDATE authority on
// violation_photos + violation_videos:
//
//   • Manager CANNOT soft-delete a violation photo or video via a
//     direct supabase-js .update({removed_at: ...}) call — the policy
//     that previously allowed this is DROPped (the UAT-surfaced server
//     gap, not just the UI affordance).
//   • Manager CAN still SELECT both — the inherits_violation SELECT
//     policy is untouched, so evidence VIEW (the legitimate PM use
//     case) is preserved.
//   • Leasing_agent spot-check — same shape as manager (the pre-A2
//     manager policy only matched get_my_role()='manager', so
//     leasing_agent was already blocked; this regression-gates the
//     post-A2 state too).
//   • Company_admin CAN still UPDATE both — dispute resolution
//     authority preserved.
//   • Admin CAN still UPDATE both via FOR-ALL admin_all policies.
//   • Driver B18 regression gate — PRECONFIRM photo UPDATE works,
//     CONFIRMED photo UPDATE blocked. The B18 review-screen path
//     (driver removes evidence before submit) must keep working.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-b182-2-media-authz.ts
//
// PRECONDITION: migration 20260615_b182_2_media_authz_close.sql applied
// to the target project.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const RUN_TAG  = `b182-2-${Date.now()}`
const COMPANY  = 'Demo Towing LLC'
const PROPERTY = `B182-2_${RUN_TAG}_Property`

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

type Check = { id: string; pass: boolean; detail: string }
const checks: Check[] = []
const record = (id: string, pass: boolean, detail: string) => {
  checks.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}
const cleanup: Array<() => Promise<void>> = []

interface Persona { email: string; client: SupabaseClient; authId: string }

async function spawnAuthUser(suffix: string): Promise<Persona> {
  const email = `mateo+${RUN_TAG}-${suffix}@example.com`
  const pw    = `B182_2_${RUN_TAG}_${suffix}!`
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password: pw, email_confirm: true,
  })
  if (cErr || !created.user) throw new Error(`auth create ${suffix}: ${cErr?.message}`)
  cleanup.push(async () => { await admin.auth.admin.deleteUser(created.user!.id) })
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: pw })
  if (sErr) throw new Error(`signIn ${suffix}: ${sErr.message}`)
  return { email, client, authId: created.user.id }
}

async function spawnManager(properties: string[]): Promise<Persona> {
  const p = await spawnAuthUser('mgr')
  const { error } = await admin.from('user_roles').insert({
    email: p.email, role: 'manager', company: COMPANY, property: properties,
  })
  if (error) throw new Error(`user_roles manager insert: ${error.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

async function spawnLeasingAgent(properties: string[]): Promise<Persona> {
  const p = await spawnAuthUser('leasing')
  const { error } = await admin.from('user_roles').insert({
    email: p.email, role: 'leasing_agent', company: COMPANY, property: properties,
  })
  if (error) throw new Error(`user_roles leasing_agent insert: ${error.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

async function spawnCompanyAdmin(): Promise<Persona> {
  const p = await spawnAuthUser('ca')
  const { error } = await admin.from('user_roles').insert({
    email: p.email, role: 'company_admin', company: COMPANY,
  })
  if (error) throw new Error(`user_roles company_admin insert: ${error.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

async function spawnAdmin(): Promise<Persona> {
  const p = await spawnAuthUser('adm')
  const { error } = await admin.from('user_roles').insert({
    email: p.email, role: 'admin', company: COMPANY,
  })
  if (error) throw new Error(`user_roles admin insert: ${error.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

async function spawnDriver(): Promise<Persona> {
  const p = await spawnAuthUser('drv')
  const { error } = await admin.from('user_roles').insert({
    email: p.email, role: 'driver', company: COMPANY,
  })
  if (error) throw new Error(`user_roles driver insert: ${error.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

// Service-role seeds a properties row so CA + driver SELECT policies on
// violations resolve (their USING expression scopes by `property IN
// (SELECT name FROM properties WHERE company ~~* get_my_company())`).
// Without this seed, CA + driver fail the EXISTS-violations subquery
// inside the photos/videos UPDATE policies and the case looks like a
// false-fail. Manager doesn't need this — manager's violations SELECT
// policy uses get_my_properties() (reads user_roles.property[]) instead.
async function seedProperty(name: string): Promise<void> {
  const { error } = await admin.from('properties').insert({
    name, company: COMPANY, address: 'B182-2 probe property',
  })
  if (error && !error.message.toLowerCase().includes('duplicate')) {
    throw new Error(`properties insert: ${error.message}`)
  }
  cleanup.push(async () => { await admin.from('properties').delete().eq('name', name) })
}

// Service-role seeds a violation + attached photo + video.
async function seedViolationWithMedia(args: {
  property: string
  is_confirmed: boolean
}): Promise<{ violationId: number; photoId: number; videoId: number }> {
  const { data: vData, error: vErr } = await admin.from('violations').insert({
    plate: `B1822${Math.floor(Math.random() * 10000)}`,
    property: args.property,
    violation_type: 'B182 #2 Probe Smoke',
    location: 'Test Spot',
    notes: 'B182 #2 probe-managed throwaway',
    driver_name: 'mateo+b182-2-probe@example.com',
    is_confirmed: args.is_confirmed,
  }).select('id').single()
  if (vErr || !vData) throw new Error(`violations insert: ${vErr?.message}`)
  cleanup.push(async () => { await admin.from('violations').delete().eq('id', vData.id) })

  const { data: pData, error: pErr } = await admin.from('violation_photos').insert({
    violation_id: vData.id,
    photo_url: `https://example.com/probe-${RUN_TAG}.jpg`,
  }).select('id').single()
  if (pErr || !pData) throw new Error(`violation_photos insert: ${pErr?.message}`)
  cleanup.push(async () => { await admin.from('violation_photos').delete().eq('id', pData.id) })

  const { data: dData, error: dErr } = await admin.from('violation_videos').insert({
    violation_id: vData.id,
    video_url: `https://example.com/probe-${RUN_TAG}.mp4`,
  }).select('id').single()
  if (dErr || !dData) throw new Error(`violation_videos insert: ${dErr?.message}`)
  cleanup.push(async () => { await admin.from('violation_videos').delete().eq('id', dData.id) })

  return { violationId: vData.id as number, photoId: pData.id as number, videoId: dData.id as number }
}

// supabase-js doesn't always surface RLS-zero-rows as an error — for
// block-cases we read the row server-side to confirm the bypass attempt
// didn't actually land.
async function readPhoto(id: number): Promise<{ removed_at: string | null } | null> {
  const { data } = await admin.from('violation_photos').select('removed_at').eq('id', id).maybeSingle()
  return data as { removed_at: string | null } | null
}

async function readVideo(id: number): Promise<{ removed_at: string | null } | null> {
  const { data } = await admin.from('violation_videos').select('removed_at').eq('id', id).maybeSingle()
  return data as { removed_at: string | null } | null
}

async function cleanupAll(): Promise<void> {
  console.log('\n── CLEANUP ──')
  for (const fn of cleanup.reverse()) {
    try { await fn() } catch (e) { console.error('cleanup error:', (e as Error).message) }
  }
}

async function main(): Promise<void> {
  console.log(`B182 #2 media-authz probe · ${RUN_TAG}`)
  console.log(`Project: ${url}\n`)

  console.log('── SETUP ──')
  let mgr: Persona, leasing: Persona, ca: Persona, sysAdmin: Persona, drv: Persona
  let confirmed: { violationId: number; photoId: number; videoId: number }
  let preconfirm: { violationId: number; photoId: number; videoId: number }
  try {
    await seedProperty(PROPERTY)
    mgr        = await spawnManager([PROPERTY])
    leasing    = await spawnLeasingAgent([PROPERTY])
    ca         = await spawnCompanyAdmin()
    sysAdmin   = await spawnAdmin()
    drv        = await spawnDriver()
    confirmed  = await seedViolationWithMedia({ property: PROPERTY, is_confirmed: true })
    preconfirm = await seedViolationWithMedia({ property: PROPERTY, is_confirmed: false })
    console.log(`  manager:        ${mgr.email}`)
    console.log(`  leasing_agent:  ${leasing.email}`)
    console.log(`  company_admin:  ${ca.email}`)
    console.log(`  admin:          ${sysAdmin.email}`)
    console.log(`  driver:         ${drv.email}`)
    console.log(`  confirmed violation:  id=${confirmed.violationId} (photo=${confirmed.photoId}, video=${confirmed.videoId})`)
    console.log(`  preconfirm violation: id=${preconfirm.violationId} (photo=${preconfirm.photoId}, video=${preconfirm.videoId})`)
  } catch (e) {
    console.error('SETUP FAILED:', (e as Error).message)
    await cleanupAll()
    process.exit(1)
  }

  const isoNow = new Date().toISOString()

  // ── 1. Manager CANNOT soft-delete photo (the close) ──────────────────────
  console.log('\n── CASE 1 — manager UPDATE violation_photos.removed_at (the close) ──')
  await mgr.client.from('violation_photos').update({
    removed_at: isoNow, removed_by_email: mgr.email, removed_by_role: 'manager',
  } as unknown as never).eq('id', confirmed.photoId)
  const p1 = await readPhoto(confirmed.photoId)
  if (p1?.removed_at == null) {
    record('b182_2.manager_cannot_update_photo', true,
      'BLOCKED — removed_at still NULL (no UPDATE policy for manager)')
  } else {
    record('b182_2.manager_cannot_update_photo', false,
      `BYPASS — removed_at=${p1.removed_at}; manager_update policy may still be live`)
  }

  // ── 2. Manager CANNOT soft-delete video ──────────────────────────────────
  console.log('\n── CASE 2 — manager UPDATE violation_videos.removed_at ──')
  await mgr.client.from('violation_videos').update({
    removed_at: isoNow, removed_by_email: mgr.email, removed_by_role: 'manager',
  } as unknown as never).eq('id', confirmed.videoId)
  const v2 = await readVideo(confirmed.videoId)
  if (v2?.removed_at == null) {
    record('b182_2.manager_cannot_update_video', true,
      'BLOCKED — removed_at still NULL')
  } else {
    record('b182_2.manager_cannot_update_video', false,
      `BYPASS — removed_at=${v2.removed_at}`)
  }

  // ── 3. Manager CAN still SELECT photo (VIEW intact) ──────────────────────
  console.log('\n── CASE 3 — manager SELECT violation_photos (VIEW intact) ──')
  const { data: pSel, error: pSelErr } = await mgr.client.from('violation_photos')
    .select('id, photo_url').eq('id', confirmed.photoId).maybeSingle()
  if (pSelErr) {
    record('b182_2.manager_can_select_photo', false, `unexpected error: ${pSelErr.message}`)
  } else if (pSel?.id === confirmed.photoId) {
    record('b182_2.manager_can_select_photo', true,
      `manager SELECT returns photo_url — evidence VIEW preserved`)
  } else {
    record('b182_2.manager_can_select_photo', false,
      'manager SELECT returned null — VIEW regressed; check inherits_violation policy')
  }

  // ── 4. Manager CAN still SELECT video ────────────────────────────────────
  console.log('\n── CASE 4 — manager SELECT violation_videos ──')
  const { data: vSel, error: vSelErr } = await mgr.client.from('violation_videos')
    .select('id, video_url').eq('id', confirmed.videoId).maybeSingle()
  if (vSelErr) {
    record('b182_2.manager_can_select_video', false, `unexpected error: ${vSelErr.message}`)
  } else if (vSel?.id === confirmed.videoId) {
    record('b182_2.manager_can_select_video', true,
      'manager SELECT returns video_url — VIEW preserved')
  } else {
    record('b182_2.manager_can_select_video', false,
      'manager SELECT returned null')
  }

  // ── 5. Leasing_agent CANNOT update either (the manager policy never covered
  //       leasing_agent; this confirms the post-drop state mirrors that) ─────
  console.log('\n── CASE 5 — leasing_agent UPDATE both photo + video → blocked ──')
  await leasing.client.from('violation_photos').update({
    removed_at: isoNow,
  } as unknown as never).eq('id', confirmed.photoId)
  await leasing.client.from('violation_videos').update({
    removed_at: isoNow,
  } as unknown as never).eq('id', confirmed.videoId)
  const pLeasing = await readPhoto(confirmed.photoId)
  const vLeasing = await readVideo(confirmed.videoId)
  if (pLeasing?.removed_at == null && vLeasing?.removed_at == null) {
    record('b182_2.leasing_agent_cannot_update_either', true,
      'BLOCKED — neither row touched')
  } else {
    record('b182_2.leasing_agent_cannot_update_either', false,
      `BYPASS — photo.removed_at=${pLeasing?.removed_at} video.removed_at=${vLeasing?.removed_at}`)
  }

  // ── 6. Company_admin CAN soft-delete photo (no-regression) ───────────────
  console.log('\n── CASE 6 — company_admin UPDATE violation_photos.removed_at ──')
  const { error: e6 } = await ca.client.from('violation_photos').update({
    removed_at: isoNow, removed_by_email: ca.email, removed_by_role: 'company_admin',
  } as unknown as never).eq('id', confirmed.photoId)
  const p6 = await readPhoto(confirmed.photoId)
  if (e6) {
    record('b182_2.ca_can_update_photo', false, `unexpected error: ${e6.message}`)
  } else if (p6?.removed_at != null) {
    record('b182_2.ca_can_update_photo', true,
      `removed_at set by CA — dispute-resolution authority preserved`)
  } else {
    record('b182_2.ca_can_update_photo', false,
      `update did not land — removed_at still NULL`)
  }

  // ── 7. Company_admin CAN soft-delete video ───────────────────────────────
  console.log('\n── CASE 7 — company_admin UPDATE violation_videos.removed_at ──')
  const { error: e7 } = await ca.client.from('violation_videos').update({
    removed_at: isoNow, removed_by_email: ca.email, removed_by_role: 'company_admin',
  } as unknown as never).eq('id', confirmed.videoId)
  const v7 = await readVideo(confirmed.videoId)
  if (e7) {
    record('b182_2.ca_can_update_video', false, `unexpected error: ${e7.message}`)
  } else if (v7?.removed_at != null) {
    record('b182_2.ca_can_update_video', true, 'removed_at set by CA')
  } else {
    record('b182_2.ca_can_update_video', false, 'update did not land')
  }

  // ── 8. Admin CAN soft-delete via FOR-ALL (no-regression) ─────────────────
  // Use a fresh photo on the preconfirm violation so we don't conflict with
  // CA's earlier removal of the confirmed photo.
  console.log('\n── CASE 8 — admin UPDATE violation_photos.removed_at on preconfirm ──')
  const { error: e8 } = await sysAdmin.client.from('violation_photos').update({
    removed_at: isoNow, removed_by_email: sysAdmin.email, removed_by_role: 'admin',
  } as unknown as never).eq('id', preconfirm.photoId)
  const p8 = await readPhoto(preconfirm.photoId)
  if (e8) {
    record('b182_2.admin_can_update_photo', false, `unexpected error: ${e8.message}`)
  } else if (p8?.removed_at != null) {
    record('b182_2.admin_can_update_photo', true, 'removed_at set by admin (FOR ALL policy)')
  } else {
    record('b182_2.admin_can_update_photo', false, 'admin update did not land')
  }

  // Reset for case 9 — clear the preconfirm photo's removed_at so the driver
  // can attempt their own UPDATE on a clean slate.
  await admin.from('violation_photos').update({ removed_at: null, removed_by_email: null, removed_by_role: null }).eq('id', preconfirm.photoId)

  // ── 9. Driver B18 regression — CAN update preconfirm photo ──────────────
  console.log('\n── CASE 9 — driver UPDATE preconfirm violation_photos (B18 regression-gate) ──')
  const { error: e9 } = await drv.client.from('violation_photos').update({
    removed_at: isoNow, removed_by_email: drv.email, removed_by_role: 'driver',
  } as unknown as never).eq('id', preconfirm.photoId)
  const p9 = await readPhoto(preconfirm.photoId)
  if (e9) {
    record('b182_2.driver_can_update_preconfirm_photo', false, `unexpected error: ${e9.message}`)
  } else if (p9?.removed_at != null) {
    record('b182_2.driver_can_update_preconfirm_photo', true,
      'driver UPDATE on preconfirm landed — B18 review-screen path intact')
  } else {
    record('b182_2.driver_can_update_preconfirm_photo', false,
      'driver UPDATE on preconfirm did not land — B18 regression')
  }

  // ── 10. Driver B18 regression — CANNOT update CONFIRMED photo ───────────
  console.log('\n── CASE 10 — driver UPDATE confirmed violation_photos → blocked (B18 regression-gate) ──')
  const pBefore = await readPhoto(confirmed.photoId)
  await drv.client.from('violation_photos').update({
    removed_at: new Date(Date.now() + 1000).toISOString(),
    removed_by_email: drv.email, removed_by_role: 'driver',
  } as unknown as never).eq('id', confirmed.photoId)
  const pAfter = await readPhoto(confirmed.photoId)
  // confirmed.photoId already has removed_at set by CA in CASE 6; we check
  // that the driver's UPDATE didn't OVERWRITE it (different timestamp).
  if (pAfter?.removed_at === pBefore?.removed_at) {
    record('b182_2.driver_cannot_update_confirmed_photo', true,
      'BLOCKED — driver UPDATE on confirmed photo did not modify removed_at (preconfirm-only policy held)')
  } else {
    record('b182_2.driver_cannot_update_confirmed_photo', false,
      `BYPASS — driver wrote on confirmed photo (removed_at changed: ${pBefore?.removed_at} → ${pAfter?.removed_at})`)
  }

  await cleanupAll()

  const passed = checks.filter(c => c.pass).length
  console.log(`\n── RESULT — ${passed}/${checks.length} passed ──`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.id}`)
  }
  process.exit(passed === checks.length ? 0 : 1)
}

main().catch(async (e) => {
  console.error('UNHANDLED:', (e as Error).message)
  await cleanupAll()
  process.exit(1)
})

// B155.2 RPC-path probe — escalation + scope + self-reg + admin + legit-path
// regression gate.
//
// Sibling to scripts/probe-b155-2-escalation.ts (which covers the direct
// .from('user_roles').insert(...) RLS path). This probe covers the
// .rpc('insert_user_role', ...) SECURITY DEFINER path that the original
// probe never tested.
//
// PRE-FIX BEHAVIOR (Dashboard-applied insert_user_role, 2026-06-13)
//   • LANGUAGE sql, SECURITY DEFINER, no SET search_path
//   • Body: bare INSERT INTO user_roles, no guards
//   • An authenticated CA could mint admin / company_admin / arbitrary
//     role strings — empirically confirmed by this probe before fix.
//
// POST-FIX BEHAVIOR (this probe is the regression gate)
//   • escalation.* / scope.* / denial.* — must PASS (denial returns the
//     right exception class)
//   • legit.tenant_* / legit.self_reg_resident — must PASS (row lands +
//     name persists)
//   • admin.* — must PASS (admin bypass branch works for all role+company
//     combos, including admin-minting-admin)
//
// COVERS ALL FOUR CALLER BRANCHES in the post-2026-06-13 body:
//   • v_caller_role = 'admin'                          → tested via testAdminPath
//   • v_caller_role IN (company_admin/manager/leasing) → tested via testEscalations,
//                                                        testScope, testLegitTenantPaths
//   • v_caller_role IS NULL (self-reg)                 → tested via testSelfRegPaths
//   • else-deny                                        → covered by the legit-path
//                                                        absence of failures
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-b155-2-rpc-escalation.ts
//
// Standing-practice intended use: re-run on ANY change to insert_user_role
// AND as part of every pre-onboard checklist for new tenants. Same posture
// as the sibling probe-b155-2-escalation.ts.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const RUN_TAG = `b155-rpc-${Date.now()}`
const CA_COMPANY = 'Demo Towing LLC'  // canonical test seed

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

type Check = { id: string; pass: boolean; detail: string }
const checks: Check[] = []
const record = (id: string, pass: boolean, detail: string) => {
  checks.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}
const cleanup: Array<() => Promise<void>> = []

async function spawnAuthUser(emailPrefix: string): Promise<{ email: string; client: SupabaseClient; authId: string }> {
  const email = `mateo+${RUN_TAG}-${emailPrefix}@example.com`
  const pw = `B155_${RUN_TAG}_${emailPrefix}!`
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password: pw, email_confirm: true,
  })
  if (cErr || !created.user) throw new Error(`auth create ${emailPrefix}: ${cErr?.message}`)
  cleanup.push(async () => { await admin.auth.admin.deleteUser(created.user!.id) })

  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: pw })
  if (sErr) throw new Error(`signIn ${emailPrefix}: ${sErr.message}`)
  return { email, client, authId: created.user.id }
}

async function spawnCA(): Promise<{ email: string; client: SupabaseClient }> {
  const { email, client } = await spawnAuthUser('ca')
  const { error: rErr } = await admin.from('user_roles').insert({
    email, role: 'company_admin', company: CA_COMPANY,
  })
  if (rErr) throw new Error(`user_roles CA insert: ${rErr.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', email) })
  await client.auth.refreshSession()
  return { email, client }
}

async function spawnAdmin(): Promise<{ email: string; client: SupabaseClient }> {
  // Throwaway admin user. Admin role rows historically carry company=NULL
  // (see production audit — admin@alc.com row 19 has no company). Mirror
  // that posture so the v_caller_role='admin' branch fires correctly
  // (admin bypass is identity-based, not scope-based).
  const { email, client } = await spawnAuthUser('admin')
  const { error: rErr } = await admin.from('user_roles').insert({
    email, role: 'admin', company: null,
  })
  if (rErr) throw new Error(`user_roles admin insert: ${rErr.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', email) })
  await client.auth.refreshSession()
  return { email, client }
}

async function readUserRoleRow(email: string) {
  const { data } = await admin.from('user_roles').select('id, role, company, name').ilike('email', email).maybeSingle()
  return data
}

async function testEscalations(ca: { email: string; client: SupabaseClient }) {
  console.log('\n── ESCALATION DENIAL TESTS (CA caller, illegal roles) ──')

  // 1.1 — CA → role='admin'
  const t1 = `mateo+${RUN_TAG}-rpc-admin@example.com`
  const { data: d1, error: e1 } = await ca.client.rpc('insert_user_role', {
    p_email: t1, p_role: 'admin', p_company: CA_COMPANY, p_property: [],
  })
  const gt1 = await readUserRoleRow(t1)
  if (gt1) {
    cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', t1) })
    record('escalation.admin_insert', false,
      `ESCALATION SUCCEEDED — CA wrote role=admin via RPC; id=${gt1.id}. RPC: data=${JSON.stringify(d1)} error=${e1?.message ?? 'null'}`)
  } else {
    record('escalation.admin_insert', true,
      `Denied: error=${e1?.message ?? '(no error, no row)'}`)
  }

  // 1.2 — CA → role='company_admin'
  const t2 = `mateo+${RUN_TAG}-rpc-ca@example.com`
  const { data: d2, error: e2 } = await ca.client.rpc('insert_user_role', {
    p_email: t2, p_role: 'company_admin', p_company: CA_COMPANY, p_property: [],
  })
  const gt2 = await readUserRoleRow(t2)
  if (gt2) {
    cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', t2) })
    record('escalation.company_admin_insert', false,
      `ESCALATION SUCCEEDED — CA wrote role=company_admin via RPC; id=${gt2.id}. RPC: data=${JSON.stringify(d2)} error=${e2?.message ?? 'null'}`)
  } else {
    record('escalation.company_admin_insert', true,
      `Denied: error=${e2?.message ?? '(no error, no row)'}`)
  }

  // 1.3 — CA → role='noop' (arbitrary string)
  const t3 = `mateo+${RUN_TAG}-rpc-noop@example.com`
  const { error: e3 } = await ca.client.rpc('insert_user_role', {
    p_email: t3, p_role: 'noop', p_company: CA_COMPANY, p_property: [],
  })
  const gt3 = await readUserRoleRow(t3)
  if (gt3) {
    cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', t3) })
    record('escalation.noop_insert', false,
      `BODY GUARD ABSENT — RPC accepted role='noop'. id=${gt3.id}`)
  } else {
    record('escalation.noop_insert', true,
      `Denied: error=${e3?.message ?? '(no error, no row)'}`)
  }
}

async function testScope(ca: { email: string; client: SupabaseClient }) {
  console.log('\n── SCOPE DENIAL TESTS (CA caller, cross-company) ──')

  // 2.1 — CA tries to insert manager into a DIFFERENT company
  const t1 = `mateo+${RUN_TAG}-rpc-xcomp@example.com`
  const { error: e1 } = await ca.client.rpc('insert_user_role', {
    p_email: t1, p_role: 'manager', p_company: 'Some Other Company', p_property: [],
  })
  const gt1 = await readUserRoleRow(t1)
  if (gt1) {
    cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', t1) })
    record('scope.cross_company', false,
      `SCOPE VIOLATION SUCCEEDED — CA wrote into "${gt1.company}". id=${gt1.id}`)
  } else {
    record('scope.cross_company', true,
      `Denied: error=${e1?.message ?? '(no error, no row)'}`)
  }
}

async function testLegitTenantPaths(ca: { email: string; client: SupabaseClient }) {
  console.log('\n── LEGIT TENANT-PROVISIONER PATHS (CA + own company, valid roles, p_name persists) ──')

  // 3.1 — CA inserts manager with name (control / Add-User parity)
  const t1 = `mateo+${RUN_TAG}-rpc-mgr@example.com`
  const { error: e1 } = await ca.client.rpc('insert_user_role', {
    p_email: t1, p_role: 'manager', p_company: CA_COMPANY, p_property: ['Bayou Heights Apartments'], p_name: 'Test Manager',
  })
  const gt1 = await readUserRoleRow(t1)
  if (gt1) cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', t1) })
  const pass1 = gt1?.role === 'manager' && gt1?.name === 'Test Manager'
  record('legit.tenant_manager_with_name', pass1,
    pass1
      ? `inserted (id=${gt1!.id}, name="${gt1!.name}")`
      : `expected manager+name="Test Manager", got role=${gt1?.role ?? 'no row'} name=${JSON.stringify(gt1?.name)} error=${e1?.message ?? 'null'}`)

  // 3.2 — CA inserts driver with name (bulk-invite per-row parity)
  const t2 = `mateo+${RUN_TAG}-rpc-drv@example.com`
  const { error: e2 } = await ca.client.rpc('insert_user_role', {
    p_email: t2, p_role: 'driver', p_company: CA_COMPANY, p_property: [], p_name: 'Test Driver',
  })
  const gt2 = await readUserRoleRow(t2)
  if (gt2) cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', t2) })
  const pass2 = gt2?.role === 'driver' && gt2?.name === 'Test Driver'
  record('legit.tenant_driver_with_name', pass2,
    pass2
      ? `inserted (id=${gt2!.id}, name="${gt2!.name}")`
      : `expected driver+name="Test Driver", got role=${gt2?.role ?? 'no row'} name=${JSON.stringify(gt2?.name)} error=${e2?.message ?? 'null'}`)
}

async function testAdminPath(adm: { email: string; client: SupabaseClient }) {
  console.log('\n── ADMIN-CALLER PATHS (bypass: any role, any company, p_name persists) ──')

  // 5.1 — admin mints role='admin' (legit admin Add-User dropdown choice)
  const t1 = `mateo+${RUN_TAG}-admin-mint-admin@example.com`
  const { error: e1 } = await adm.client.rpc('insert_user_role', {
    p_email: t1, p_role: 'admin', p_company: 'Brand New Co', p_property: [], p_name: 'Minted Admin',
  })
  const gt1 = await readUserRoleRow(t1)
  if (gt1) cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', t1) })
  const pass1 = gt1?.role === 'admin' && gt1?.name === 'Minted Admin'
  record('admin.mint_admin', pass1,
    pass1
      ? `inserted (id=${gt1!.id}, role=admin, name="${gt1!.name}", company="${gt1!.company}")`
      : `expected role=admin+name="Minted Admin", got role=${gt1?.role ?? 'no row'} name=${JSON.stringify(gt1?.name)} error=${e1?.message ?? 'null'}`)

  // 5.2 — admin mints role='company_admin' (legit admin Add-User dropdown choice)
  const t2 = `mateo+${RUN_TAG}-admin-mint-ca@example.com`
  const { error: e2 } = await adm.client.rpc('insert_user_role', {
    p_email: t2, p_role: 'company_admin', p_company: 'Brand New Co', p_property: [], p_name: 'Minted CA',
  })
  const gt2 = await readUserRoleRow(t2)
  if (gt2) cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', t2) })
  const pass2 = gt2?.role === 'company_admin' && gt2?.name === 'Minted CA'
  record('admin.mint_company_admin', pass2,
    pass2
      ? `inserted (id=${gt2!.id}, role=company_admin, name="${gt2!.name}", company="${gt2!.company}")`
      : `expected role=company_admin+name="Minted CA", got role=${gt2?.role ?? 'no row'} name=${JSON.stringify(gt2?.name)} error=${e2?.message ?? 'null'}`)

  // 5.3 — admin cross-company mint (admin bypasses the scope guard tenant
  // roles hit at scope.cross_company) — same email pattern but for a tenant
  // role in a company different from the admin's NULL home company.
  const t3 = `mateo+${RUN_TAG}-admin-cross-comp@example.com`
  const { error: e3 } = await adm.client.rpc('insert_user_role', {
    p_email: t3, p_role: 'manager', p_company: 'Some Cross Company', p_property: ['Some Property'], p_name: 'Cross-Co Mgr',
  })
  const gt3 = await readUserRoleRow(t3)
  if (gt3) cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', t3) })
  const pass3 = gt3?.role === 'manager' && gt3?.name === 'Cross-Co Mgr' && gt3?.company === 'Some Cross Company'
  record('admin.cross_company_with_name', pass3,
    pass3
      ? `inserted (id=${gt3!.id}, role=manager, name="${gt3!.name}", company="${gt3!.company}")`
      : `expected role=manager+name="Cross-Co Mgr"+company="Some Cross Company", got role=${gt3?.role ?? 'no row'} name=${JSON.stringify(gt3?.name)} company=${JSON.stringify(gt3?.company)} error=${e3?.message ?? 'null'}`)
}

async function testSelfRegPaths() {
  console.log('\n── SELF-REG PATHS (roleless authenticated caller) ──')

  // Strategy: spawn a fresh roleless tenant for each subtest where a
  // successful insert would change the caller's role context. The denial
  // subtests can share since denial leaves the caller still roleless.
  const u = await spawnAuthUser('selfreg')

  // 4.1 — denial: roleless caller tries to mint someone else's email
  const otherEmail = `mateo+${RUN_TAG}-rpc-selfreg-other@example.com`
  const { error: e1 } = await u.client.rpc('insert_user_role', {
    p_email: otherEmail, p_role: 'resident', p_company: CA_COMPANY, p_property: [], p_name: 'Other',
  })
  const gt1 = await readUserRoleRow(otherEmail)
  if (gt1) {
    cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', otherEmail) })
    record('denial.self_reg_other_email', false,
      `SELF-REG SCOPE VIOLATION — roleless wrote other-email row. id=${gt1.id}`)
  } else {
    record('denial.self_reg_other_email', true,
      `Denied: error=${e1?.message ?? '(no error, no row)'}`)
  }

  // 4.2 — denial: roleless caller tries to mint role='manager' on own email
  const { error: e2 } = await u.client.rpc('insert_user_role', {
    p_email: u.email, p_role: 'manager', p_company: CA_COMPANY, p_property: [], p_name: 'Pretend Mgr',
  })
  const gt2 = await readUserRoleRow(u.email)
  if (gt2) {
    cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', u.email) })
    record('denial.self_reg_other_role', false,
      `SELF-REG ROLE VIOLATION — roleless wrote role=${gt2.role}. id=${gt2.id}`)
  } else {
    record('denial.self_reg_other_role', true,
      `Denied: error=${e2?.message ?? '(no error, no row)'}`)
  }

  // 4.3 — legit: roleless caller mints own resident row with name
  const { error: e3 } = await u.client.rpc('insert_user_role', {
    p_email: u.email, p_role: 'resident', p_company: CA_COMPANY, p_property: ['Bayou Heights Apartments'], p_name: 'Self Reg Resident',
  })
  const gt3 = await readUserRoleRow(u.email)
  if (gt3) cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', u.email) })
  const pass3 = gt3?.role === 'resident' && gt3?.name === 'Self Reg Resident'
  record('legit.self_reg_resident', pass3,
    pass3
      ? `inserted (id=${gt3!.id}, name="${gt3!.name}")`
      : `expected resident+name="Self Reg Resident", got role=${gt3?.role ?? 'no row'} name=${JSON.stringify(gt3?.name)} error=${e3?.message ?? 'null'}`)
}

async function cleanupAll() {
  for (const op of cleanup.reverse()) {
    try { await op() } catch (e) { console.error('cleanup:', (e as Error).message) }
  }
}

async function main() {
  console.log(`B155.2 RPC-path probe (escalation + legit-path) · ${RUN_TAG}`)
  console.log(`Project: ${url}\n`)

  let ca: { email: string; client: SupabaseClient }
  let adm: { email: string; client: SupabaseClient }
  try {
    ca = await spawnCA()
    adm = await spawnAdmin()
  } catch (e) {
    console.error('SETUP FAILED:', (e as Error).message); await cleanupAll(); process.exit(1)
  }

  try {
    await testEscalations(ca)
    await testScope(ca)
    await testLegitTenantPaths(ca)
    await testSelfRegPaths()
    await testAdminPath(adm)
  } catch (e) {
    console.error('PROBE THREW:', (e as Error).message)
  } finally {
    await cleanupAll()
  }

  console.log('\n── SUMMARY ──')
  const passed = checks.filter(c => c.pass).length
  const failed = checks.length - passed
  console.log(`${passed}/${checks.length} PASS (${failed} FAIL)`)
  console.log('\nINTERPRETATION:')
  console.log('  escalation.* / scope.cross_company / denial.* — PASS = denied (good); FAIL = guard absent (BAD)')
  console.log('  legit.tenant_* / legit.self_reg_resident / admin.* — PASS = legit path works (good); FAIL = guard over-tightened')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error('UNHANDLED:', e); process.exit(2) })

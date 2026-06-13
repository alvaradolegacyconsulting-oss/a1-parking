// B155.2 RPC-path escalation verification — companion to
// probe-b155-2-escalation.ts.
//
// The original B155.2 probe (probe-b155-2-escalation.ts) ONLY tested the
// direct .from('user_roles').insert(...) RLS-gated path. It NEVER tested
// the .rpc('insert_user_role', ...) SECURITY DEFINER path.
//
// pg_get_functiondef(insert_user_role) at the time this probe was written
// (2026-06-13) showed: LANGUAGE sql, SECURITY DEFINER, no SET search_path,
// body = bare INSERT INTO user_roles with no role-IN-set guard. SECURITY
// DEFINER bypasses RLS. The probe confirmed empirically: an authenticated
// CA could call rpc({p_role:'admin', ...}) and write an admin row.
//
// The closure migration (apply atomically with D2 schema change) moves
// the role + caller-company guards INTO the function body so SECURITY
// DEFINER bypass of RLS no longer matters. After apply:
//   • Tests 1.1 / 1.2 / 1.4 must flip FAIL → PASS (role-IN-set denial).
//   • Test 1.3 (control) stays PASS (manager + p_company matches CA's
//     own company → both guards pass).
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
const CA_EMAIL = `mateo+${RUN_TAG}-ca@example.com`
const CA_PW    = `B155_${RUN_TAG}!`

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

type Check = { id: string; pass: boolean; detail: string }
const checks: Check[] = []
const record = (id: string, pass: boolean, detail: string) => {
  checks.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}
const cleanup: Array<() => Promise<void>> = []

async function setupCA(): Promise<SupabaseClient> {
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: CA_EMAIL, password: CA_PW, email_confirm: true,
  })
  if (cErr || !created.user) throw new Error(`auth create CA: ${cErr?.message}`)
  cleanup.push(async () => { await admin.auth.admin.deleteUser(created.user!.id) })

  const { error: rErr } = await admin.from('user_roles').insert({
    email: CA_EMAIL, role: 'company_admin', company: 'Demo Towing LLC',
  })
  if (rErr) throw new Error(`user_roles insert: ${rErr.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', CA_EMAIL) })

  const tenant = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: sErr } = await tenant.auth.signInWithPassword({ email: CA_EMAIL, password: CA_PW })
  if (sErr) throw new Error(`signIn CA: ${sErr.message}`)
  return tenant
}

async function testRpcEscalation(tenant: SupabaseClient) {
  console.log('\n── RPC-PATH ESCALATION TESTS (insert_user_role SECURITY DEFINER) ──')

  // 1.1 — admin
  const t1a = `mateo+${RUN_TAG}-rpc-admin@example.com`
  const { data: d1a, error: e1a } = await tenant.rpc('insert_user_role', {
    p_email: t1a, p_role: 'admin', p_company: 'Demo Towing LLC', p_property: [],
  })
  const { data: gt1a } = await admin.from('user_roles').select('id, role').eq('email', t1a).maybeSingle()
  if (gt1a?.role === 'admin') {
    cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', t1a) })
    record('RPC.admin INSERT', false,
      `ESCALATION SUCCEEDED — CA wrote a role=admin row via RPC; id=${gt1a.id}. RPC return: data=${JSON.stringify(d1a)} error=${e1a?.message ?? 'null'}`)
  } else {
    record('RPC.admin INSERT', true,
      `Denied: error=${e1a?.message ?? '(no error, no row)'}; ground-truth role=${gt1a?.role ?? 'no row'}`)
  }

  // 1.2 — company_admin
  const t1b = `mateo+${RUN_TAG}-rpc-ca@example.com`
  const { data: d1b, error: e1b } = await tenant.rpc('insert_user_role', {
    p_email: t1b, p_role: 'company_admin', p_company: 'Demo Towing LLC', p_property: [],
  })
  const { data: gt1b } = await admin.from('user_roles').select('id, role').eq('email', t1b).maybeSingle()
  if (gt1b?.role === 'company_admin') {
    cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', t1b) })
    record('RPC.company_admin INSERT', false,
      `ESCALATION SUCCEEDED — CA wrote a role=company_admin row via RPC; id=${gt1b.id}. RPC return: data=${JSON.stringify(d1b)} error=${e1b?.message ?? 'null'}`)
  } else {
    record('RPC.company_admin INSERT', true,
      `Denied: error=${e1b?.message ?? '(no error, no row)'}; ground-truth role=${gt1b?.role ?? 'no row'}`)
  }

  // 1.3 — control: manager (should succeed pre AND post fix)
  const t1c = `mateo+${RUN_TAG}-rpc-mgr@example.com`
  const { error: e1c } = await tenant.rpc('insert_user_role', {
    p_email: t1c, p_role: 'manager', p_company: 'Demo Towing LLC', p_property: ['Bayou Heights Apartments'],
  })
  const { data: gt1c } = await admin.from('user_roles').select('id, role').eq('email', t1c).maybeSingle()
  if (gt1c?.role === 'manager') {
    cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', t1c) })
    record('RPC.manager INSERT (control)', true,
      `Legit-path PASSED — manager INSERT succeeded via RPC (id=${gt1c.id})`)
  } else {
    record('RPC.manager INSERT (control)', false,
      `Legit-path FAILED — manager INSERT via RPC didn't land. error=${e1c?.message ?? 'unknown'}; ground-truth role=${gt1c?.role ?? 'no row'}`)
  }

  // 1.4 — invented role 'noop' (probes the absence/presence of the role-IN-set body guard)
  const t1d = `mateo+${RUN_TAG}-rpc-noop@example.com`
  const { error: e1d } = await tenant.rpc('insert_user_role', {
    p_email: t1d, p_role: 'noop', p_company: 'Demo Towing LLC', p_property: [],
  })
  const { data: gt1d } = await admin.from('user_roles').select('id, role').eq('email', t1d).maybeSingle()
  if (gt1d) {
    cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', t1d) })
    record('RPC.noop INSERT (body-guard absence)', false,
      `BODY GUARD ABSENT — RPC accepted role='noop' (an arbitrary string). id=${gt1d.id}`)
  } else {
    record('RPC.noop INSERT (body-guard absence)', true,
      `Denied: error=${e1d?.message ?? '(no error, no row)'}`)
  }

  // 2.1 — cross-company scope (post-fix only; pre-fix would have inserted into
  // "Some Other Company" without any check). Should FAIL with
  // company_scope_violation after the closure migration applies.
  const t2a = `mateo+${RUN_TAG}-rpc-xcomp@example.com`
  const { error: e2a } = await tenant.rpc('insert_user_role', {
    p_email: t2a, p_role: 'manager', p_company: 'Some Other Company', p_property: [],
  })
  const { data: gt2a } = await admin.from('user_roles').select('id, role, company').eq('email', t2a).maybeSingle()
  if (gt2a) {
    cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', t2a) })
    record('RPC.cross_company (scope guard)', false,
      `CROSS-COMPANY SCOPE VIOLATION — CA wrote into company "${gt2a.company}" (id=${gt2a.id})`)
  } else {
    record('RPC.cross_company (scope guard)', true,
      `Denied: error=${e2a?.message ?? '(no error, no row)'}`)
  }
}

async function cleanupAll() {
  for (const op of cleanup.reverse()) {
    try { await op() } catch (e) { console.error('cleanup:', (e as Error).message) }
  }
}

async function main() {
  console.log(`B155.2 RPC-path escalation · ${RUN_TAG}`)
  console.log(`Project: ${url}\n`)
  let tenant: SupabaseClient
  try { tenant = await setupCA() } catch (e) {
    console.error('SETUP FAILED:', (e as Error).message); await cleanupAll(); process.exit(1)
  }
  try { await testRpcEscalation(tenant) } catch (e) {
    console.error('PROBE THREW:', (e as Error).message)
  } finally { await cleanupAll() }

  console.log('\n── SUMMARY ──')
  const failed = checks.filter(c => !c.pass).length
  console.log(`${checks.length - failed}/${checks.length} PASS (${failed} FAIL)`)
  console.log('\nINTERPRETATION:')
  console.log('  RPC.admin / company_admin / noop / cross_company — PASS = denied (good); FAIL = guard absent (BAD)')
  console.log('  RPC.manager (control) — PASS = legit path works; FAIL = guard over-tightened')

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error('UNHANDLED:', e); process.exit(2) })

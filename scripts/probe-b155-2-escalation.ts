// B155.2 escalation verification — diagnostic only, no fix.
// Tests the 3 CA → super-admin escalation paths:
//   1. CA INSERTs a user_roles row with role='admin' or 'company_admin'
//   2. CA UPDATEs their own user_roles row to escalate role
//   3. CA UPDATEs another user's user_roles row (scope violation)
//
// Also dumps the live RLS policy state on user_roles so we can compare
// against the B155.4-shipped expectations (memory says SHIPPED 2026-06-04
// via cde22f2; per [[before-recommending-from-memory]], verify before
// trusting).
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-b155-2-escalation.ts

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const RUN_TAG = `b155-esc-${Date.now()}`
const THROWAWAY_CA_EMAIL    = `mateo+${RUN_TAG}-ca@example.com`
const THROWAWAY_CA_PASSWORD = `B155_${RUN_TAG}!`
const ESCALATION_TARGET_EMAIL = `mateo+${RUN_TAG}-target@example.com`

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

type Check = { id: string; pass: boolean; detail: string }
const checks: Check[] = []
const record = (id: string, pass: boolean, detail: string) => {
  checks.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}
const cleanupOps: Array<() => Promise<void>> = []

async function setupThrowawayCA(): Promise<SupabaseClient> {
  console.log('\n── SETUP: throwaway company_admin on Demo Towing LLC ──')
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: THROWAWAY_CA_EMAIL,
    password: THROWAWAY_CA_PASSWORD,
    email_confirm: true,
  })
  if (createErr || !created.user) throw new Error(`auth createUser failed: ${createErr?.message}`)
  const authId = created.user.id
  cleanupOps.push(async () => { await admin.auth.admin.deleteUser(authId) })

  const { error: roleErr } = await admin.from('user_roles').insert({
    email: THROWAWAY_CA_EMAIL,
    role: 'company_admin',
    company: 'Demo Towing LLC',
  })
  if (roleErr) throw new Error(`user_roles insert (CA seat) failed: ${roleErr.message}`)
  cleanupOps.push(async () => { await admin.from('user_roles').delete().eq('email', THROWAWAY_CA_EMAIL) })

  const tenant = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: signErr } = await tenant.auth.signInWithPassword({
    email: THROWAWAY_CA_EMAIL,
    password: THROWAWAY_CA_PASSWORD,
  })
  if (signErr) throw new Error(`CA tenant signIn failed: ${signErr.message}`)
  console.log(`Tenant CA session established (${THROWAWAY_CA_EMAIL})`)
  return tenant
}

async function policyDump() {
  console.log('\n── RLS POLICY STATE: user_roles ────────────────────────')
  // Probe via a SECURITY DEFINER-style proxy isn't available; surface
  // policies via a sample read with service role + describe approach is
  // not feasible. Instead, we observe behavior — the policy dump itself
  // is best obtained from SQL Editor via:
  //   SELECT policyname, cmd, qual, with_check FROM pg_policies
  //    WHERE schemaname='public' AND tablename='user_roles';
  // This script tests EFFECTIVE BEHAVIOR — that's what matters for B155.2.
  console.log('(policy dump skipped — observed via behavior probes below)')
  console.log('(for explicit policy listing, paste in SQL Editor:')
  console.log('   SELECT policyname, cmd, qual, with_check FROM pg_policies')
  console.log("    WHERE schemaname='public' AND tablename='user_roles' ORDER BY policyname;)")
}

async function escalationProbes(tenant: SupabaseClient) {
  console.log('\n── PROBE 1: CA INSERT user_roles with role=admin/company_admin ──')

  // 1a. INSERT a new user_roles row with role='admin' on a new email.
  const target1a = `${ESCALATION_TARGET_EMAIL}-1a-${Date.now()}`
  const { data: ins1a, error: err1a } = await tenant
    .from('user_roles')
    .insert({
      email: target1a,
      role: 'admin',
      company: 'Demo Towing LLC',
    })
    .select('id, email, role')
  if (ins1a && ins1a.length > 0) {
    cleanupOps.push(async () => { await admin.from('user_roles').delete().eq('email', target1a) })
    record('P1.1 INSERT admin', false,
      `ESCALATION SUCCEEDED — CA wrote a role=admin row on a new email; id=${ins1a[0].id}`)
  } else {
    record('P1.1 INSERT admin', true,
      `Denied: error="${err1a?.message ?? '(empty data, no error)'}"`)
  }

  // 1b. INSERT a new user_roles row with role='company_admin' on a new email.
  const target1b = `${ESCALATION_TARGET_EMAIL}-1b-${Date.now()}`
  const { data: ins1b, error: err1b } = await tenant
    .from('user_roles')
    .insert({
      email: target1b,
      role: 'company_admin',
      company: 'Demo Towing LLC',
    })
    .select('id, email, role')
  if (ins1b && ins1b.length > 0) {
    cleanupOps.push(async () => { await admin.from('user_roles').delete().eq('email', target1b) })
    record('P1.2 INSERT company_admin', false,
      `ESCALATION SUCCEEDED — CA wrote a role=company_admin row; id=${ins1b[0].id}`)
  } else {
    record('P1.2 INSERT company_admin', true,
      `Denied: error="${err1b?.message ?? '(empty data, no error)'}"`)
  }

  // 1c. Control case — INSERT a new user_roles row with role='manager' on a
  // new email. This is the legitimate path; expected to PASS (the CA can
  // provision lower-privilege users on their company). If THIS fails, the
  // policy is over-tightened and the CA portal addUser flow is broken too.
  const target1c = `${ESCALATION_TARGET_EMAIL}-1c-${Date.now()}`
  const { data: ins1c, error: err1c } = await tenant
    .from('user_roles')
    .insert({
      email: target1c,
      role: 'manager',
      company: 'Demo Towing LLC',
      property: ['Bayou Heights Apartments'],
    })
    .select('id, email, role')
  if (ins1c && ins1c.length > 0) {
    cleanupOps.push(async () => { await admin.from('user_roles').delete().eq('email', target1c) })
    record('P1.3 control INSERT manager', true,
      `Legit-path PASSED — CA can provision a manager (id=${ins1c[0].id}); confirms policy isn't over-tightened`)
  } else {
    record('P1.3 control INSERT manager', false,
      `Legit-path FAILED — CA cannot provision a manager; policy is over-tightened. error="${err1c?.message}"`)
  }

  console.log('\n── PROBE 2: CA UPDATE own user_roles to escalate role ──')

  // 2. UPDATE the CA's own row to role='admin'.
  const { error: updOwnErr, data: updOwn } = await tenant
    .from('user_roles')
    .update({ role: 'admin' })
    .ilike('email', THROWAWAY_CA_EMAIL)
    .select('id, email, role')
  if (updOwn && updOwn.length > 0 && updOwn[0].role === 'admin') {
    record('P2.1 self-escalate to admin', false,
      `ESCALATION SUCCEEDED — CA self-promoted to admin (id=${updOwn[0].id})`)
  } else {
    // Read ground truth via service-role to confirm row didn't actually flip.
    const { data: gt } = await admin
      .from('user_roles')
      .select('role')
      .ilike('email', THROWAWAY_CA_EMAIL)
      .maybeSingle()
    if (gt?.role === 'admin') {
      record('P2.1 self-escalate to admin', false,
        `ESCALATION SUCCEEDED (ground-truth) — DB row now has role=admin despite update appearing to fail to client`)
    } else {
      record('P2.1 self-escalate to admin', true,
        `Denied: error="${updOwnErr?.message ?? '(no error, no rows affected)'}"; ground-truth role still "${gt?.role}"`)
    }
  }

  console.log('\n── PROBE 3: CA UPDATE another role row (out-of-scope) ──')

  // 3. Create a target row via service-role on a DIFFERENT company
  // (out-of-scope for our CA), then have the CA try to update it.
  const outOfScopeEmail = `${ESCALATION_TARGET_EMAIL}-oos-${Date.now()}`
  await admin.from('user_roles').insert({
    email: outOfScopeEmail,
    role: 'manager',
    company: 'A1 Wrecker (UAT)',
    property: ['SOME_OTHER_PROPERTY'],
  })
  cleanupOps.push(async () => { await admin.from('user_roles').delete().eq('email', outOfScopeEmail) })

  const { error: updOosErr, data: updOos } = await tenant
    .from('user_roles')
    .update({ role: 'admin' })
    .ilike('email', outOfScopeEmail)
    .select('id, email, role')
  if (updOos && updOos.length > 0) {
    record('P3.1 cross-company escalate', false,
      `CROSS-COMPANY ESCALATION SUCCEEDED — CA flipped a non-own-company row to role=admin (id=${updOos[0].id})`)
  } else {
    const { data: gt } = await admin
      .from('user_roles')
      .select('role')
      .ilike('email', outOfScopeEmail)
      .maybeSingle()
    if (gt?.role === 'admin') {
      record('P3.1 cross-company escalate', false,
        `CROSS-COMPANY ESCALATION SUCCEEDED (ground-truth) — DB row flipped despite client thinking it didn't`)
    } else {
      record('P3.1 cross-company escalate', true,
        `Denied: error="${updOosErr?.message ?? '(no error, no rows affected)'}"; ground-truth role still "${gt?.role}"`)
    }
  }
}

async function cleanupAll() {
  console.log('\n── CLEANUP ───────────────────────────────────────────')
  for (const op of cleanupOps.reverse()) {
    try { await op() } catch (e) { console.error('cleanup failed:', (e as Error).message) }
  }
  console.log('Cleanup complete.')
}

async function main() {
  console.log(`B155.2 escalation verification · ${RUN_TAG}`)
  console.log(`Project: ${url}`)

  await policyDump()

  let tenant: SupabaseClient
  try {
    tenant = await setupThrowawayCA()
  } catch (e) {
    console.error('SETUP FAILED:', (e as Error).message)
    await cleanupAll()
    process.exit(1)
  }

  try {
    await escalationProbes(tenant)
  } catch (e) {
    console.error('Probes threw:', (e as Error).message)
  } finally {
    await cleanupAll()
  }

  console.log('\n── SUMMARY ────────────────────────────────────────────')
  const passed = checks.filter(c => c.pass).length
  const failed = checks.length - passed
  console.log(`${passed}/${checks.length} checks passed (${failed} failed)`)
  console.log('')
  console.log('INTERPRETATION:')
  console.log('  • Probe 1.1 + 1.2 + 2 + 3 are ESCALATION TESTS — PASS = denied (good); FAIL = escalation succeeded (BAD)')
  console.log('  • Probe 1.3 is a CONTROL — PASS = legit path works (good); FAIL = policy over-tightened')

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error('UNHANDLED:', e); process.exit(2) })

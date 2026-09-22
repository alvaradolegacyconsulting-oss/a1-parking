// ════════════════════════════════════════════════════════════════════
// GATE SUITE — swift-handler caller authorization (2026-09-21)
// ════════════════════════════════════════════════════════════════════
//
// Calls the DEPLOYED function over HTTP. Nothing here reads the source:
// the live function and any copy of it are different artifacts, and the
// whole reason this fix exists is that a comment claiming a guard was
// true about one branch and read as true about the file.
//
// 🔴 RUN IT BEFORE THE PASTE TOO. Before, N1 must FAIL (that failure is
// the open hole, reproduced). After, everything must pass. A suite only
// run afterwards cannot tell you it was ever testing the right thing.
//
// 🔴 POSITIVE CONTROLS ARE NOT OPTIONAL. A function that denies everyone
// passes every negative assertion in this file. P1-P6 are what prove the
// product still works, and the manager pair (P5/P6) is what proves the
// two call sites that used to send the anon key still function.
//
// Mutating targets are disposable +aliased addresses on the TEST domain.
// Nothing touches A1, Demo, or any live customer account.
//
// Usage:  npx tsx scripts/verify-swift-handler-auth.ts
import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const FN = g('NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL')
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL')
const ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const SERVICE = g('SUPABASE_SERVICE_ROLE_KEY')
const admin = createClient(URL_, SERVICE)

let failures = 0
const pass = (id: string, n: string) => console.log(`✅ ${id}  ${n}`)
const fail = (id: string, n: string) => { failures++; console.log(`❌ ${id}  ${n}`) }

// ── Fixture accounts. Created here, torn down at the end. ───────────
const STAMP = Date.now().toString(36)
const dom = 'test.shieldmylot.com'
const F = {
  admin:        { email: `gate-${STAMP}-admin@${dom}`,   role: 'admin' },
  companyAdmin: { email: `gate-${STAMP}-ca@${dom}`,      role: 'company_admin' },
  manager:      { email: `gate-${STAMP}-mgr@${dom}`,     role: 'manager' },
  manager2:     { email: `gate-${STAMP}-mgr2@${dom}`,    role: 'manager' },
  driver:       { email: `gate-${STAMP}-drv@${dom}`,     role: 'driver' },
  resident:     { email: `gate-${STAMP}-res@${dom}`,     role: 'resident' },
}
const COMPANY = 'Test-LEGACY'
const PW = 'Gate' + STAMP + '!aB9'
const created: string[] = []
const tokens: Record<string, string> = {}

async function call(token: string | null, body: Record<string, unknown>) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) { headers.Authorization = `Bearer ${token}`; headers.apikey = ANON }
  const res = await fetch(FN + '/swift-handler', { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, text }
}

const expect = (id: string, got: { status: number; text: string }, want: number, note: string) => {
  if (got.status === want) pass(id, `${note} → ${want}`)
  else fail(id, `${note} → expected ${want}, got ${got.status}: ${got.text.slice(0, 160)}`)
}

async function mintSession(email: string): Promise<string | null> {
  const { data: link, error: lErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  const hashed = (link as unknown as { properties?: { hashed_token?: string } })?.properties?.hashed_token
  if (lErr || !hashed) { console.log(`     generateLink failed for ${email}: ${lErr?.message ?? 'no hashed_token'}`); return null }
  const { data, error } = await createClient(URL_, ANON).auth.verifyOtp({ token_hash: hashed, type: 'magiclink' })
  if (error || !data.session) { console.log(`     verifyOtp failed for ${email}: ${error?.message}`); return null }
  return data.session.access_token
}

async function setup() {
  console.log('── building fixtures ──')
  for (const k of Object.keys(F) as (keyof typeof F)[]) {
    const { email, role } = F[k]
    const { error } = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true })
    if (error) { console.log(`  🔴 could not create ${email}: ${error.message}`); continue }
    created.push(email)
    const { error: rErr } = await admin.from('user_roles').insert([{ email, role, company: COMPANY }])
    if (rErr) console.log(`  🔴 role row for ${email}: ${rErr.message}`)
    // 🔴 NOT signInWithPassword. Supabase has CAPTCHA protection enabled
    // on auth, so a script cannot sign in: it returns "captcha protection:
    // request disallowed". The 2026-09-21 run of this suite hit exactly
    // that, every fixture came back token-less, and because call() omits
    // the header when the token is falsy, every "positive control" ran as
    // an ANONYMOUS request and passed for the wrong reason. See the
    // assertTokens() guard below — that failure must never be silent again.
    //
    // generateLink + verifyOtp is the server-side path that works: the
    // service-role client mints a magiclink, and exchanging its
    // hashed_token yields a genuine user session.
    const tok = await mintSession(email)
    if (!tok) console.log(`  🔴 could not mint a session for ${email}`)
    else tokens[k] = tok
    console.log(`  ${email.padEnd(46)} ${role.padEnd(14)} token=${tokens[k] ? 'yes' : 'NO'}`)
  }
}

// 🔴 THE LESSON FROM THE 2026-09-21 RUN, MADE STRUCTURAL.
// call() omits the Authorization header when the token is falsy. So a
// fixture that failed to get a session does not produce a failing test —
// it produces an ANONYMOUS request, which against the ungated function
// returns 200 and reads as a PASSING positive control. The suite reported
// P1-P7 green while proving nothing at all.
//
// A missing token is a BROKEN SUITE, not a result. Stop before asserting.
function assertTokens() {
  const missing = (Object.keys(F) as (keyof typeof F)[]).filter(k => !tokens[k])
  if (missing.length === 0) { pass('F0', `all ${Object.keys(F).length} fixtures hold a real session token`); return true }
  fail('F0', `🔴 NO TOKEN for: ${missing.join(', ')} — every token-bearing assertion below would run ANONYMOUSLY and be meaningless. Suite aborted.`)
  return false
}

async function teardown() {
  console.log('\n── teardown ──')
  const { data: del } = await admin.from('user_roles').delete().ilike('email', `gate-${STAMP}-%`).select('email')
  console.log(`  user_roles rows removed: ${(del || []).length}`)
  // Sweep by PREFIX as well as by the tracked list — belt and braces
  // after the 2026-09-21 leak. Anything this suite created is gate-<stamp>-.
  try {
    let page = 1
    for (;;) {
      const { data } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
      const users = data?.users ?? []
      for (const u of users) if (u.email && u.email.startsWith(`gate-${STAMP}-`) && !created.includes(u.email)) created.push(u.email)
      if (users.length < 1000) break
      page++
    }
  } catch { /* fall back to the tracked list */ }

  let gone = 0, absent = 0, stuck: string[] = []
  for (const email of created) {
    const { data } = await admin.rpc('get_auth_user_id_by_email', { p_email: email })
    if (!data) { absent++; continue }   // never created — its gate refused, which is a PASS
    const { error } = await admin.auth.admin.deleteUser(data as string)
    if (error) stuck.push(email); else gone++
  }
  // Distinguish "was never there" from "could not remove it". Collapsing
  // them reads as a partial failure on a clean run — post-paste, the
  // addresses the NEGATIVE cases name are never created at all, because
  // the gate now refuses them.
  console.log(`  auth users: ${gone} removed, ${absent} never existed (their gate refused — expected post-paste)`)
  if (stuck.length) fail('T0', `🔴 could not delete: ${stuck.join(', ')}`)
  const { data: left } = await admin.from('user_roles').select('email').ilike('email', `gate-${STAMP}-%`)
  if ((left || []).length === 0) pass('T1', 'teardown verified — no fixture rows remain')
  else fail('T1', `🔴 ${(left || []).length} fixture role row(s) REMAIN: ${JSON.stringify(left)}`)
}

async function main() {
  if (!FN || !ANON || !SERVICE) { console.error('missing env'); process.exit(2) }
  await setup()

  console.log('')
  if (!assertTokens()) {
    await teardown()
    console.log('\n❌ SUITE ABORTED — fixtures had no sessions. Nothing below was measured.')
    process.exit(1)
  }

  console.log('\n══ NEGATIVE — the hole, must now be closed ══')

  // N1 — THE HEADLINE. This exact request is what is open today.
  //
  // 🔴 Registered for teardown BEFORE the call. Pre-paste this request
  // SUCCEEDS — that is the whole point of running the suite first — so it
  // mints a real auth user. The 2026-09-21 run leaked exactly this address
  // because teardown only knew about addresses the POSITIVE cases created.
  // A negative case that is expected to fail today still has side effects
  // today.
  const nx = `gate-${STAMP}-x@${dom}`
  created.push(nx)
  expect('N1', await call(null, { action: 'create_user', email: nx, password: PW }),
         401, 'no Authorization header · create_user')

  // N1b — the anon key is a valid JWT with no user behind it. This is
  // precisely what manager:2745/2876 used to send.
  expect('N1b', await call(ANON, { action: 'create_user', email: nx, password: PW }),
         401, 'anon key as the bearer · create_user')

  expect('N1c', await call('not-a-real-token', { action: 'reset_password', email: F.manager.email, new_password: PW }),
         401, 'garbage token · reset_password')

  // N2 — authenticated but too low a role.
  expect('N2', await call(tokens.driver, { action: 'create_user', email: nx, password: PW }),
         403, 'driver · create_user')
  expect('N2b', await call(tokens.resident, { action: 'create_user', email: nx, password: PW }),
         403, 'resident · create_user')

  // N3 — 🔴 SAME RANK. manager → a DIFFERENT manager. Denied.
  expect('N3', await call(tokens.manager, { action: 'reset_password', email: F.manager2.email, new_password: PW }),
         403, 'manager · reset_password on another MANAGER (same rank)')
  expect('N3b', await call(tokens.manager, { action: 'deactivate_user', email: F.manager2.email }),
         403, 'manager · deactivate another MANAGER (same rank)')

  // N4 — upward.
  expect('N4', await call(tokens.manager, { action: 'reset_password', email: F.companyAdmin.email, new_password: PW }),
         403, 'manager · reset_password on a COMPANY_ADMIN (upward)')
  expect('N4b', await call(tokens.companyAdmin, { action: 'reset_password', email: F.admin.email, new_password: PW }),
         403, 'company_admin · reset_password on an ADMIN (upward)')
  expect('N4c', await call(tokens.driver, { action: 'deactivate_user', email: F.manager.email }),
         403, 'driver · deactivate a MANAGER (upward)')

  console.log('\n══ POSITIVE CONTROLS — a deny-everything gate passes every test above ══')

  // P1-P3 — admin does each action on a lower target.
  const p1 = `gate-${STAMP}-p1@${dom}`
  expect('P1', await call(tokens.admin, { action: 'create_user', email: p1, password: PW }),
         200, 'admin · create_user')
  created.push(p1)
  expect('P2', await call(tokens.admin, { action: 'deactivate_user', email: F.driver.email }),
         200, 'admin · deactivate a driver')
  expect('P3', await call(tokens.admin, { action: 'activate_user', email: F.driver.email }),
         200, 'admin · activate a driver')

  // P4 — company_admin creates, and resets a manager in-company.
  const p4 = `gate-${STAMP}-p4@${dom}`
  expect('P4', await call(tokens.companyAdmin, { action: 'create_user', email: p4, password: PW }),
         200, 'company_admin · create_user (the manager-creation path)')
  created.push(p4)
  // 🔴 TARGETS manager2, NOT manager. A password reset REVOKES that
  // user's existing sessions — verified 2026-09-22: a token that
  // resolved cleanly returns "Auth session missing!" immediately after
  // an admin password change.
  //
  // The first post-paste run had this pointed at F.manager, so P5, P6 and
  // P7 all sent a token this very assertion had just killed and came back
  // 401. Three red lines that said nothing about the gate. manager2 is
  // only ever a TARGET (N3/N3b, where it is denied and its password is
  // therefore never changed), so using it here costs nothing.
  expect('P4b', await call(tokens.companyAdmin, { action: 'reset_password', email: F.manager2.email, new_password: PW }),
         200, 'company_admin · reset_password on a MANAGER (downward)')

  // Belt and braces: re-mint every token that a preceding assertion could
  // have invalidated, so re-pointing a target later cannot silently
  // reintroduce the same failure. A test whose credentials an earlier test
  // destroyed reports a defect that does not exist — which is worse than
  // no test, because it sends you looking at working code.
  for (const k of ['manager', 'manager2'] as const) {
    const t = await mintSession(F[k].email)
    if (t) tokens[k] = t
    else fail('P4c', `could not re-mint the ${k} session after the reset — P5/P6/P7 below would be meaningless`)
  }

  // P5/P6 — 🔴 the two call sites that used to send the anon key.
  const p5 = `gate-${STAMP}-p5@${dom}`
  expect('P5', await call(tokens.manager, { action: 'create_user', email: p5, password: PW }),
         200, "manager · create_user — manager:2761's real workflow")
  created.push(p5)
  expect('P6', await call(tokens.manager, { action: 'deactivate_user', email: F.resident.email }),
         200, "manager · deactivate a resident — manager:2892's rollback path")

  // P7 — 🔴 THE SUBTLE PAIR. Same action, same rank; only the email
  // compared differs. N3 denied manager→manager2; this must ALLOW
  // manager→manager. If both pass or both fail, the self rule and the
  // same-rank rule are not being distinguished and neither is tested.
  expect('P7', await call(tokens.manager, { action: 'reset_password', email: F.manager.email, new_password: PW }),
         200, 'manager · reset_password on THEMSELVES (self case)')

  await teardown()
  console.log('')
  console.log(failures === 0 ? '✅ ALL GATES PASS' : `❌ ${failures} GATE(S) FAILED`)
  console.log('')
  console.log('Reminder: run this BEFORE the paste as well. N1 failing beforehand')
  console.log('is what proves the suite is exercising the real hole.')
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(async e => { console.error('SUITE ERROR —', e.message); await teardown().catch(() => {}); process.exit(2) })

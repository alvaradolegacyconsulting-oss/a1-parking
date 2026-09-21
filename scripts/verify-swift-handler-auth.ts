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

async function setup() {
  console.log('── building fixtures ──')
  for (const k of Object.keys(F) as (keyof typeof F)[]) {
    const { email, role } = F[k]
    const { error } = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true })
    if (error) { console.log(`  🔴 could not create ${email}: ${error.message}`); continue }
    created.push(email)
    const { error: rErr } = await admin.from('user_roles').insert([{ email, role, company: COMPANY }])
    if (rErr) console.log(`  🔴 role row for ${email}: ${rErr.message}`)
    const anonC = createClient(URL_, ANON)
    const { data, error: sErr } = await anonC.auth.signInWithPassword({ email, password: PW })
    if (sErr || !data.session) console.log(`  🔴 could not sign in ${email}: ${sErr?.message}`)
    else tokens[k] = data.session.access_token
    console.log(`  ${email.padEnd(46)} ${role.padEnd(14)} token=${tokens[k] ? 'yes' : 'NO'}`)
  }
}

async function teardown() {
  console.log('\n── teardown ──')
  const { data: del } = await admin.from('user_roles').delete().ilike('email', `gate-${STAMP}-%`).select('email')
  console.log(`  user_roles rows removed: ${(del || []).length}`)
  let gone = 0
  for (const email of created) {
    const { data } = await admin.rpc('get_auth_user_id_by_email', { p_email: email })
    if (data) { const { error } = await admin.auth.admin.deleteUser(data as string); if (!error) gone++ }
  }
  console.log(`  auth users removed: ${gone} of ${created.length}`)
  const { data: left } = await admin.from('user_roles').select('email').ilike('email', `gate-${STAMP}-%`)
  if ((left || []).length === 0) pass('T1', 'teardown verified — no fixture rows remain')
  else fail('T1', `🔴 ${(left || []).length} fixture role row(s) REMAIN: ${JSON.stringify(left)}`)
}

async function main() {
  if (!FN || !ANON || !SERVICE) { console.error('missing env'); process.exit(2) }
  await setup()

  console.log('\n══ NEGATIVE — the hole, must now be closed ══')

  // N1 — THE HEADLINE. This exact request is what is open today.
  expect('N1', await call(null, { action: 'create_user', email: `gate-${STAMP}-x@${dom}`, password: PW }),
         401, 'no Authorization header · create_user')

  // N1b — the anon key is a valid JWT with no user behind it. This is
  // precisely what manager:2745/2876 used to send.
  expect('N1b', await call(ANON, { action: 'create_user', email: `gate-${STAMP}-x@${dom}`, password: PW }),
         401, 'anon key as the bearer · create_user')

  expect('N1c', await call('not-a-real-token', { action: 'reset_password', email: F.manager.email, new_password: PW }),
         401, 'garbage token · reset_password')

  // N2 — authenticated but too low a role.
  expect('N2', await call(tokens.driver, { action: 'create_user', email: `gate-${STAMP}-x@${dom}`, password: PW }),
         403, 'driver · create_user')
  expect('N2b', await call(tokens.resident, { action: 'create_user', email: `gate-${STAMP}-x@${dom}`, password: PW }),
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
  expect('P4b', await call(tokens.companyAdmin, { action: 'reset_password', email: F.manager.email, new_password: PW }),
         200, 'company_admin · reset_password on a MANAGER (downward)')

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

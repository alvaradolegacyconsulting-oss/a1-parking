// ════════════════════════════════════════════════════════════════════
// GATE — /api/register/create-user must not mint a session for an
//        email that already has records behind it
// ════════════════════════════════════════════════════════════════════
//
// THE ASSERTION: a POST carrying an email that has a live `residents`
// row and NO auth user must NOT come back with a token_hash.
//
// Why that is the whole question. The route hands token_hash to the
// BROWSER, which verifyOtps it into a session — the email is never
// verified. That was made safe on 2026-09-11 by deleting
// resolveExistingAuthUserId ("that was the takeover"), so a token is
// minted only when the request created the account. The reasoning
// holds because a brand-new email owns nothing. The bulk import breaks
// that premise: an imported resident has no auth account AND their
// unit and cars.
//
// 🔴 THE CANARY IS A ROW THIS SCRIPT CREATES. Not one of the 35 real
// Demo/Test-LEGACY residents, though the ruling allowed it: minting a
// session against a real record leaves an auth user and a claimed
// identity on somebody's demo tenant, and the standing rule is that a
// gate never proves a hole by exploiting a real row. A fresh row gives
// the identical proof and nothing to restore. Never A1 — the canary is
// pinned to a Test-LEGACY property and the script refuses otherwise.
//
// 🔴 THE CAPTCHA IS ISOLATED, NOT DEFEATED. The server is started with
// Cloudflare's published always-pass TESTING secret
// (1x0000000000000000000000000000000AA), so siteverify succeeds for a
// dummy token. That is deliberate: Turnstile is a bot gate, and the
// question here is whether the route consults `residents` at all. The
// real secret is never read and production is never called.
//
// 🔴 THIS GATE STARTS ITS OWN SERVER AND REFUSES A LEAKED ONE. A
// server someone else left running may be a stale build, and a stale
// build reports green. Port busy → exit 2, not pass.
//
// Usage: npm run verify:createuserguard

import { createClient } from '@supabase/supabase-js'
import { spawn, type ChildProcess } from 'child_process'
import net from 'net'
import fs from 'fs'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 3987
const BASE = `http://127.0.0.1:${PORT}`
// Cloudflare's documented testing secret: always passes.
const TEST_SECRET = '1x0000000000000000000000000000000AA'
const CO = 'Test-LEGACY'
const S = Date.now()
const CANARY_EMAIL = `zz-canary-rb-${S}@test.invalid`
// 🔴 The privileged variant. A user_roles row with no auth user is also
// a records-bearing identity, and a session for it is NOT a resident:
// get_my_role() does not check is_active, so the role comes back live.
// One such row exists in production today — a manager at A1 — so this
// canary mirrors it on a test tenant. A1's address is never touched.
const CANARY_MGR = `zz-canary-mgr-${S}@test.invalid`

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }

let server: ChildProcess | null = null
let residentId: number | null = null
let vehicleId: number | null = null
let mintedUid: string | null = null
let mintedMgrUid: string | null = null
let mgrRoleId: number | null = null
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') console.error(`\n🔴 cleanup (${why})`)
  // Auth user first: it is the thing that must not be left behind.
  if (mintedUid) {
    const r = await db.auth.admin.deleteUser(mintedUid).catch(e => ({ error: e }))
    if ((r as { error?: unknown }).error) console.error(`   🔴 could not delete minted auth user ${mintedUid}`)
    else console.log(`   ↩ deleted the auth user the probe minted (${mintedUid})`)
    const back = await db.auth.admin.listUsers({ perPage: 1000 })
    if ((back.data?.users ?? []).some(u => u.id === mintedUid)) { console.error('   🔴 auth user STILL PRESENT'); fails++ }
  }
  if (mintedMgrUid) {
    const r = await db.auth.admin.deleteUser(mintedMgrUid).catch(e => ({ error: e }))
    if ((r as { error?: unknown }).error) console.error(`   🔴 could not delete minted manager auth user ${mintedMgrUid}`)
    else console.log(`   ↩ deleted the manager auth user the probe minted (${mintedMgrUid})`)
  }
  for (const e of [CANARY_EMAIL, CANARY_MGR]) {
    const ur = await db.from('user_roles').delete().ilike('email', e).select('id')
    if ((ur.data ?? []).length) console.log(`   ↩ removed ${(ur.data ?? []).length} user_roles row(s) for ${e.slice(0, 22)}…`)
  }
  mgrRoleId = null
  if (vehicleId !== null) {
    const r = await db.from('vehicles').delete().eq('id', vehicleId).select('id')
    if (r.error || (r.data ?? []).length !== 1) { console.error(`   🔴 canary vehicle ${vehicleId} NOT removed`); fails++ }
    else console.log(`   ↩ removed the canary vehicle (${vehicleId})`)
  }
  if (residentId !== null) {
    const r = await db.from('residents').delete().eq('id', residentId).select('id')
    if (r.error || (r.data ?? []).length !== 1) { console.error(`   🔴 canary residents row ${residentId} NOT removed`); fails++ }
    else console.log(`   ↩ removed the canary residents row (${residentId})`)
  }
  // Belt: anything carrying this probe's marker.
  const stray = await db.from('residents').delete().ilike('email', 'zz-canary-rb-%').select('id')
  if ((stray.data ?? []).length) console.error(`   ⚠ swept ${(stray.data ?? []).length} stray canary row(s)`)
  if (server && !server.killed) { server.kill('SIGTERM'); console.log('   ↩ stopped the server this gate started') }
}

// 🔴 `finally` does not run on a signal. Armed before anything is created.
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => { if (dying) return; dying = true
    cleanup(sig).then(() => process.exit(2)).catch(() => process.exit(2)) })
}
process.on('uncaughtException', e => {
  console.error('🔴 uncaught:', (e as Error).message)
  cleanup('uncaughtException').then(() => process.exit(2)).catch(() => process.exit(2))
})

const portBusy = () => new Promise<boolean>(res => {
  const s = net.createServer()
  s.once('error', () => res(true))
  s.once('listening', () => s.close(() => res(false)))
  s.listen(PORT, '127.0.0.1')
})

async function waitFor(ms: number) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/register/create-user`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      if (r.status === 400) return true     // route compiled, rejected the empty body
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 700))
  }
  return false
}

const main = async () => {
  if (await portBusy()) {
    console.error(`🔴 something is already listening on ${PORT}.`)
    console.error(`   Refusing to run: a server this gate did not start may be a stale build, and a stale build reports green.`)
    process.exit(2)
  }

  // ── the canary: a fresh records-bearing identity with no login ────
  const { data: props } = await db.from('properties').select('id,name,company,is_active')
  const prop = props?.find(p => p.company === CO && p.name === 'Test Legacy Property' && p.is_active)
  if (!prop) { console.error(`🔴 no active ${CO} canary property`); process.exit(2) }
  if ((prop.company ?? '').toLowerCase().includes('a1')) { console.error('🔴 refusing: canary property belongs to A1'); process.exit(2) }

  const ins = await db.from('residents').insert({
    name: `ZZ Canary ${S}`, email: CANARY_EMAIL, unit: '101',
    property: prop.name, company: CO, is_active: true, status: 'active',
  }).select('id').single()
  if (ins.error) { console.error('🔴 canary insert:', ins.error.message); process.exit(2) }
  residentId = ins.data.id as number

  // 🔴 A vehicle on the canary, so "their unit and their cars" is
  // MEASURED and not inferred. The first run reported 0 vehicles
  // readable simply because the canary owned none — which proves
  // nothing either way, and reads like reassurance.
  const vins = await db.from('vehicles').insert({
    plate: `ZZCNRY${String(S).slice(-5)}`, state: 'TX', property: prop.name, company: CO,
    status: 'active', is_active: true, unit: '101', resident_email: CANARY_EMAIL,
  }).select('id,plate').single()
  if (vins.error) { console.error('🔴 canary vehicle insert:', vins.error.message); await cleanup('end'); process.exit(2) }
  vehicleId = vins.data.id as number
  console.log(`canary: residents #${residentId} ${CANARY_EMAIL} at ${prop.name} [${CO}] — live, one vehicle (${vins.data.plate}), and NO auth user\n`)

  const before = await db.auth.admin.listUsers({ perPage: 1000 })
  chk('the canary email has no auth user to begin with',
    !(before.data?.users ?? []).some(u => (u.email ?? '').toLowerCase() === CANARY_EMAIL), 'precondition')

  try {
    // ── the server this gate starts, with the TEST captcha secret ──
    console.log(`starting next dev on ${PORT} with Cloudflare's always-pass testing secret…`)
    server = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
      env: { ...process.env, TURNSTILE_SECRET_KEY: TEST_SECRET, NODE_ENV: 'development' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    server.stderr?.on('data', d => { const s = String(d); if (/error|Error/.test(s)) process.stderr.write(`   [server] ${s}`) })
    if (!(await waitFor(90_000))) { console.error('🔴 server did not come up'); await cleanup('end'); process.exit(2) }
    console.log('server up\n')

    // ── the probe ──────────────────────────────────────────────────
    const res = await fetch(`${BASE}/api/register/create-user`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: CANARY_EMAIL, password: `Zz!canary${S}q`, captchaToken: 'dummy' }),
    })
    const body = await res.json().catch(() => ({})) as { ok?: boolean; token_hash?: string; error?: string; reason?: string }
    console.log(`POST /api/register/create-user → ${res.status} ${JSON.stringify({ ...body, token_hash: body.token_hash ? `${body.token_hash.slice(0, 10)}…` : undefined })}\n`)

    if (body.reason === 'missing_secret' || body.reason === 'network_error') {
      console.error(`🔴 the captcha did not verify (${body.reason}) — the route never reached createUser, so this run proves nothing.`)
      await cleanup('end'); process.exit(2)
    }

    // THE ASSERTION
    chk('🔴 the route REFUSES to mint a session for a records-bearing email',
      !body.token_hash,
      body.token_hash
        ? '🔴 OPEN — it returned a token_hash for an email whose resident record it never looked at'
        : 'refused')

    const after = await db.auth.admin.listUsers({ perPage: 1000 })
    const made = (after.data?.users ?? []).find(u => (u.email ?? '').toLowerCase() === CANARY_EMAIL)
    if (made) mintedUid = made.id
    chk('no auth user was created for the records-bearing email', !made,
      made ? `🔴 created ${made.id}` : 'none')

    // If a token came back, show what it actually buys — on the
    // canary's own record, which is this script's row and nobody else's.
    if (body.token_hash) {
      const c = createClient(URL_, ANON, { auth: { persistSession: false } })
      const v = await c.auth.verifyOtp({ token_hash: body.token_hash, type: 'magiclink' })
      if (!v.error && v.data.session) {
        const seen = await c.from('residents').select('id,name,unit,property').ilike('email', CANARY_EMAIL)
        const cars = await c.from('vehicles').select('plate,unit,property').ilike('resident_email', CANARY_EMAIL)
        console.log(`\n   🔴 the token establishes a real session for that email.`)
        console.log(`      as that session, residents rows visible for it: ${JSON.stringify(seen.data)}`)
        console.log(`      and THEIR OWN vehicles readable as that session: ${JSON.stringify(cars.data)}`)

        // 🔴 THE D1 DELTA, MEASURED. Resident vehicle RLS needs a
        // user_roles row, which the register flow creates client-side
        // AFTER the session — so a bare takeover sees the record and
        // not the cars. The proposal that the LOADER create that row
        // would hand the same session the vehicles too. Measure the
        // difference instead of reasoning about it.
        const roleIns = await db.from('user_roles').insert({
          email: CANARY_EMAIL, role: 'resident', company: CO, property: [prop.name], is_active: true,
        }).select('id').single()
        if (roleIns.error) {
          console.log(`      (could not add the user_roles row to measure the D1 delta: ${roleIns.error.message})`)
        } else {
          const cars2 = await c.from('vehicles').select('plate,unit').ilike('resident_email', CANARY_EMAIL)
          const res2 = await c.from('residents').select('id').ilike('email', CANARY_EMAIL)
          console.log(`\n   🔴 D1 DELTA — with a user_roles resident row present (what the loader would create):`)
          console.log(`      vehicles readable as that session: ${JSON.stringify(cars2.data)}`)
          console.log(`      residents readable as that session: ${(res2.data ?? []).length} row(s)`)
          console.log(`      So D1 widens this takeover from "their record" to "their record AND their cars".`)
          console.log(`      Jose's ordering — #1 closed and gated before D1 — is load-bearing, not a formality.`)
        }
        console.log(`      For an imported resident this is their unit and their cars, to anyone`)
        console.log(`      who knows the address and can solve one captcha.`)
      } else {
        console.log(`\n   (token returned but verifyOtp failed: ${v.error?.message})`)
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 🔴 THE PRIVILEGED VARIANT — measured, on a canary, never on A1
    // ══════════════════════════════════════════════════════════════
    // Production holds one user_roles row with no auth user: a manager
    // at A1 Wrecker llc, is_active=false. This mirrors it on
    // Test-LEGACY. The question is what get_my_role() returns for a
    // session on such a row — because it does not check is_active.
    const mr = await db.from('user_roles').insert({
      email: CANARY_MGR, role: 'manager', company: CO,
      property: [prop.name], is_active: false,
    }).select('id').single()
    if (mr.error) {
      console.log(`\n   (could not create the manager canary: ${mr.error.message})`)
    } else {
      mgrRoleId = mr.data.id as number
      const resM = await fetch(`${BASE}/api/register/create-user`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: CANARY_MGR, password: `Zz!mgr${S}q`, captchaToken: 'dummy' }),
      })
      const bodyM = await resM.json().catch(() => ({})) as { token_hash?: string }
      chk('🔴 the route REFUSES an email holding a user_roles ROLE with no auth user',
        !bodyM.token_hash,
        bodyM.token_hash ? '🔴 OPEN — a role-bearing identity can be claimed by anyone who knows the address' : 'refused')

      const afterM = await db.auth.admin.listUsers({ perPage: 1000 })
      const madeM = (afterM.data?.users ?? []).find(u => (u.email ?? '').toLowerCase() === CANARY_MGR)
      if (madeM) mintedMgrUid = madeM.id

      if (bodyM.token_hash) {
        const cm = createClient(URL_, ANON, { auth: { persistSession: false } })
        const vm = await cm.auth.verifyOtp({ token_hash: bodyM.token_hash, type: 'magiclink' })
        if (!vm.error && vm.data.session) {
          const role = await cm.rpc('get_my_role')
          const company = await cm.rpc('get_my_company')
          console.log(`\n   🔴🔴 THIS IS NOT A RESIDENT SESSION.`)
          console.log(`      get_my_role()    → ${JSON.stringify(role.data)}   (the row is is_active=false; this helper does not check it)`)
          console.log(`      get_my_company() → ${JSON.stringify(company.data)}`)
          console.log(`      Every RLS policy written as get_my_role() = 'manager' now evaluates`)
          console.log(`      in the caller's favour. Production has one such row today, at A1.`)
        }
      }
    }

    // Control: an email with NO residents row is the case the route was
    // designed for and must keep working, or the fix has broken signup.
    const freshEmail = `zz-canary-new-${S}@test.invalid`
    const res2 = await fetch(`${BASE}/api/register/create-user`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: freshEmail, password: `Zz!fresh${S}q`, captchaToken: 'dummy' }),
    })
    const body2 = await res2.json().catch(() => ({})) as { token_hash?: string }
    chk('POSITIVE CONTROL: a brand-new email still gets a token (signup is not broken)',
      !!body2.token_hash, body2.token_hash ? 'ok' : '🔴 the ordinary signup path is refused too')
    const after2 = await db.auth.admin.listUsers({ perPage: 1000 })
    const made2 = (after2.data?.users ?? []).find(u => (u.email ?? '').toLowerCase() === freshEmail)
    if (made2) { await db.auth.admin.deleteUser(made2.id).catch(() => {}) }

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ the route refuses records-bearing emails' : `❌ ${fails} failed — see above`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })

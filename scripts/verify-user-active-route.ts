// ════════════════════════════════════════════════════════════════════
// GATE — per-user deactivate/reactivate route: it revokes, and it
//        restores, and a ban failure is never reported as done
// ════════════════════════════════════════════════════════════════════
//
// 🔴 BOTH DIRECTIONS, because the dangerous half is reactivation. A ban
// that silently fails leaves a deactivated user with access (the A1
// manager, 2026-08-10 → signed in 2026-08-21). An UNban that silently
// fails leaves a reactivated user locked out while the screen says
// they are back — same bug, worse outcome, and no one would look for
// it in the deactivation code.
//
// 🔴 THE REFRESH CHECK IS THE ONE THAT MATTERS. Deactivation used to
// revoke nothing at the data layer: the session survived,
// get_my_role() still returned the role, and direct PostgREST still
// read tenant rows. So this asserts the refresh is REFUSED after
// deactivation, not merely that a flag moved.
//
// 🔴 STARTS ITS OWN SERVER, REFUSES A LEAKED ONE. Port busy → exit 2.
// A server someone else left running may be a stale build.
//
// The caller's session cookie is produced BY @supabase/ssr itself —
// a server client with a capturing cookie adapter — rather than
// hand-rolled. The format is chunked base64 of the session and is an
// SDK internal; a gate that reimplements it breaks on a version bump
// and proves nothing about the product.
//
// Usage: npm run verify:useractive

import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { spawn, type ChildProcess } from 'child_process'
import net from 'net'
import fs from 'fs'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 3988
const BASE = `http://127.0.0.1:${PORT}`
const CO = 'Test-LEGACY'
const OTHER_CO = 'Demo Company'
const S = Date.now()

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }

let server: ChildProcess | null = null
const made: { email: string; uid: string | null; roleId: number }[] = []
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') console.error(`\n🔴 cleanup (${why})`)
  for (const m of made) {
    const r = await db.from('user_roles').delete().eq('id', m.roleId).select('id')
    if (r.error || (r.data ?? []).length !== 1) console.error(`   🔴 user_roles ${m.roleId} NOT removed`)
    if (m.uid) {
      await db.auth.admin.deleteUser(m.uid).catch(() => {})
      const back = await db.auth.admin.listUsers({ perPage: 1000 })
      if ((back.data?.users ?? []).some(u => u.id === m.uid)) { console.error(`   🔴 auth user ${m.uid} STILL PRESENT`); fails++ }
    }
  }
  const stray = await db.from('user_roles').delete().ilike('email', 'zz-ua-%').select('id')
  if ((stray.data ?? []).length) console.error(`   ⚠ swept ${(stray.data ?? []).length} stray role row(s)`)
  await db.from('audit_logs').delete().ilike('record_id', 'zz-ua-%').select('id')
  console.log(`   ↩ removed ${made.length} canaries`)
  if (server && !server.killed) { server.kill('SIGTERM'); console.log('   ↩ stopped the server this gate started') }
}
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

async function actor(tag: string, role: string, company = CO, withAuth = true) {
  const email = `zz-ua-${tag}-${S}@test.invalid`
  let uid: string | null = null
  let session: { access_token: string; refresh_token: string } | null = null
  if (withAuth) {
    const { data: u, error } = await db.auth.admin.createUser({ email, password: `Zz!u${S}q`, email_confirm: true })
    if (error || !u.user) throw new Error(`createUser ${tag}: ${error?.message}`)
    uid = u.user.id
  }
  const ins = await db.from('user_roles').insert({
    email, role, company, property: ['Test Legacy Property'], is_active: true,
  }).select('id').single()
  if (ins.error) throw new Error(`user_roles ${tag}: ${ins.error.message}`)
  made.push({ email, uid, roleId: ins.data.id as number })
  if (withAuth) {
    const c = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: link } = await db.auth.admin.generateLink({ type: 'magiclink', email })
    const v = await c.auth.verifyOtp({ token_hash: link!.properties!.hashed_token!, type: 'magiclink' })
    if (v.error) throw new Error(`otp ${tag}: ${v.error.message}`)
    session = { access_token: v.data.session!.access_token, refresh_token: v.data.session!.refresh_token }
  }
  return { email, uid, roleId: ins.data.id as number, session }
}

/** The cookie header a real browser would send, serialized by the SDK. */
async function cookieFor(session: { access_token: string; refresh_token: string }) {
  const jar: { name: string; value: string }[] = []
  const c = createServerClient(URL_, ANON, {
    cookies: {
      getAll: () => jar,
      setAll: xs => { for (const x of xs) { const i = jar.findIndex(j => j.name === x.name); if (i >= 0) jar[i] = { name: x.name, value: x.value }; else jar.push({ name: x.name, value: x.value }) } },
    },
  })
  const r = await c.auth.setSession(session)
  if (r.error) throw new Error(`setSession: ${r.error.message}`)
  if (!jar.length) throw new Error('the SDK emitted no cookies — the gate cannot authenticate')
  return jar.map(j => `${j.name}=${j.value}`).join('; ')
}

const call = async (cookie: string | null, email: string, active: boolean) => {
  const r = await fetch(`${BASE}/api/admin/user-active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ email, active }),
    redirect: 'manual',
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}

const bannedState = async (uid: string) => {
  const u = await db.auth.admin.getUserById(uid)
  const b = (u.data?.user as { banned_until?: string } | undefined)?.banned_until ?? null
  return b !== null && new Date(b).getTime() > Date.now()
}

const refreshWorks = async (refresh_token: string) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const r = await c.auth.refreshSession({ refresh_token })
  return { ok: !r.error && !!r.data.session, err: r.error?.message ?? null }
}

const main = async () => {
  if (await portBusy()) {
    console.error(`🔴 something is already listening on ${PORT}. Refusing: it may be a stale build.`)
    process.exit(2)
  }

  try {
    const ca   = await actor('ca', 'company_admin')
    const adm  = await actor('adm', 'admin')
    const mgr  = await actor('mgr', 'manager')
    const caT  = await actor('tca', 'company_admin')
    const admT = await actor('tadm', 'admin')
    const xCo  = await actor('xco', 'manager', OTHER_CO)
    const noAu = await actor('noauth', 'manager', CO, false)

    console.log(`starting next dev on ${PORT}…`)
    server = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
      env: { ...process.env, NODE_ENV: 'development' }, stdio: ['ignore', 'ignore', 'pipe'],
    })
    server.stderr?.on('data', d => { const s = String(d); if (/error|Error/.test(s)) process.stderr.write(`   [server] ${s}`) })
    const until = Date.now() + 90_000
    let up = false
    while (Date.now() < until && !up) {
      // Any HTTP answer means the server is serving. Middleware
      // intercepts /api/admin/* for an unauthenticated caller and
      // redirects, so this must not insist on 400/401 — the first
      // version did, and read a working server as "did not come up".
      try { const r = await fetch(`${BASE}/api/admin/user-active`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual' }); up = r.status > 0 } catch {}
      if (!up) await new Promise(r => setTimeout(r, 700))
    }
    if (!up) { console.error('🔴 server did not come up'); await cleanup('end'); process.exit(2) }
    console.log('server up\n')

    const caCookie  = await cookieFor(ca.session!)
    const admCookie = await cookieFor(adm.session!)
    const mgrCookie = await cookieFor(mgr.session!)

    // ── 1. who may call it ──────────────────────────────────────────
    console.log('── 1. who may call it ──')
    // Middleware catches an unauthenticated /api/admin/* call and
    // redirects to /login before the route runs, so a 307 is the
    // refusal here and a 401 would be too. Either is fine; a 200 is not.
    const a0 = await call(null, mgr.email, false)
    chk('anon refused', a0.status === 401 || a0.status === 307 || a0.status === 302,
      `HTTP ${a0.status} ${a0.body.error ?? '(redirected by middleware)'}`)
    const m0 = await call(mgrCookie, noAu.email, false)
    chk('a manager caller refused', m0.status === 403 && m0.body.error === 'not_permitted', `HTTP ${m0.status} ${m0.body.error ?? ''}`)

    // ── 2. 🔴 scope: the route mirrors RLS, it does not widen it ────
    console.log('\n── 2. scope (the sweep said CA may touch mgr/leasing/driver/resident only) ──')
    const s1 = await call(caCookie, caT.email, false)
    chk('CA refused on a company_admin target', s1.status === 403, `HTTP ${s1.status} ${s1.body.error ?? ''}`)
    const s2 = await call(caCookie, admT.email, false)
    chk('CA refused on an admin target', s2.status === 403, `HTTP ${s2.status} ${s2.body.error ?? ''}`)
    const s3 = await call(caCookie, xCo.email, false)
    chk(`CA refused on a target in ${OTHER_CO}`, s3.status === 403, `HTTP ${s3.status} ${s3.body.error ?? ''}`)
    chk('   ...and all three give the SAME refusal, so neither fact leaks',
      s1.body.message === s2.body.message && s2.body.message === s3.body.message,
      String(s1.body.message ?? '').slice(0, 54))

    // ── 3. 🔴 DEACTIVATION REVOKES ─────────────────────────────────
    console.log('\n── 3. deactivation actually revokes ──')
    const before = await refreshWorks(mgr.session!.refresh_token)
    chk('BASELINE: the target can refresh while active', before.ok, before.err ?? 'works')
    const d1 = await call(caCookie, mgr.email, false)
    chk('CA deactivates a manager', d1.status === 200 && d1.body.ok === true && d1.body.changed === true,
      `HTTP ${d1.status} ${JSON.stringify(d1.body.ban_applied ?? d1.body.error)}`)
    chk('   ...user_roles.is_active is false',
      (await db.from('user_roles').select('is_active').eq('id', mgr.roleId).single()).data?.is_active === false)
    chk('   ...the auth user is really banned (read back, not assumed)', await bannedState(mgr.uid!))
    const after = await refreshWorks(mgr.session!.refresh_token)
    chk('🔴 ...and their refresh is REFUSED', !after.ok, after.err ?? '🔴 STILL REFRESHES — deactivation revoked nothing')

    // ── 4. 🔴 REACTIVATION UNBANS — the positive control ───────────
    console.log('\n── 4. reactivation restores the login (the half that locks people out) ──')
    const r1 = await call(caCookie, mgr.email, true)
    chk('CA reactivates the manager', r1.status === 200 && r1.body.ok === true && r1.body.changed === true,
      `HTTP ${r1.status} ${JSON.stringify(r1.body.ban_applied ?? r1.body.error)}`)
    chk('   ...user_roles.is_active is true',
      (await db.from('user_roles').select('is_active').eq('id', mgr.roleId).single()).data?.is_active === true)
    chk('🔴 ...the auth user is UNBANNED', !(await bannedState(mgr.uid!)),
      'otherwise reactivating a user locks them out permanently')
    // A fresh session, because the old refresh token was invalidated by the ban.
    const { data: link } = await db.auth.admin.generateLink({ type: 'magiclink', email: mgr.email })
    const fresh = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
    const v = await fresh.auth.verifyOtp({ token_hash: link!.properties!.hashed_token!, type: 'magiclink' })
    chk('🔴 ...and they can sign in again', !v.error && !!v.data.session, v.error?.message ?? 'session acquired')

    // ── 5. a target with no login ──────────────────────────────────
    console.log('\n── 5. a records-only target (no auth user) ──')
    const n1 = await call(caCookie, noAu.email, false)
    chk('reported as no_auth_user, not as a failure and not as a ban',
      n1.status === 200 && n1.body.ban_applied === 'no_auth_user',
      `HTTP ${n1.status} ${JSON.stringify(n1.body.ban_applied ?? n1.body.error)}`)

    // ── 6. idempotence and the admin caller ────────────────────────
    console.log('\n── 6. idempotence, and an admin caller ──')
    const i1 = await call(caCookie, noAu.email, false)
    chk('deactivating an already-deactivated user says so, changed:false',
      i1.status === 200 && i1.body.changed === false, JSON.stringify(i1.body.message ?? ''))
    const ad1 = await call(admCookie, caT.email, false)
    chk('an admin CAN deactivate a company_admin (CA cannot)', ad1.status === 200 && ad1.body.ok === true,
      `HTTP ${ad1.status} ${ad1.body.error ?? ''}`)
    if (ad1.status === 200) await call(admCookie, caT.email, true)

    // ── 7. the audit row says what happened ────────────────────────
    console.log('\n── 7. the audit trail ──')
    const au = await db.from('audit_logs').select('action,record_id,new_values')
      .ilike('record_id', `%zz-ua-mgr-${S}%`).order('created_at', { ascending: false }).limit(5)
    const rows = au.data ?? []
    chk('deactivate and reactivate are both audited', rows.length >= 2, `${rows.length} row(s)`)
    chk('🔴 ban_applied records the TRUTH, not an intention',
      rows.every(r => (r.new_values as Record<string, unknown>)?.ban_applied === true),
      JSON.stringify(rows.map(r => (r.new_values as Record<string, unknown>)?.ban_applied)))

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })

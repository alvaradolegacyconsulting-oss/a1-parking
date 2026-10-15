// ════════════════════════════════════════════════════════════════════
// GATE — requireAdmin() refuses a deactivated admin, on every caller
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16. requireAdmin read user_roles.role and never looked
// at is_active, so a deactivated admin still resolved as an admin —
// the same gap step 3 closed in the SQL identity helpers.
//
// 🔴 EVERY CALLER, NOT THE HELPER. A unit test on requireAdmin would
// pass while a route that forgot to check `auth.ok` kept working. The
// sweep found three callers and this drives all three over HTTP, with
// the same three subjects each: anonymous, a deactivated admin, an
// active admin.
//
// 🔴 AND THE ACTIVE-ADMIN LEG IS NOT OPTIONAL. A gate that only proves
// refusals passes just as well on a helper that refuses everyone. Each
// route is checked to get PAST authorization for a live admin — proven
// by it answering with its own business-logic response rather than a
// 401 or 403.
//
// Nothing here mutates: the issue route is called with an invalid id so
// it refuses on the id AFTER passing auth, which is what makes it a
// safe positive control.
//
// Usage: npm run verify:requireadmin

import { createClient } from '@supabase/supabase-js'
import { startDevServer, portBusy, type DevServer } from './lib/dev-server'
import { say, warn } from './lib/safe-log'
import { spawn, type ChildProcess } from 'child_process'
import net from 'net'
import fs from 'fs'
import { cookieHeaderFor } from './lib/ssr-session'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 3996
const BASE = `http://127.0.0.1:${PORT}`
const S = Date.now()

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

let srv: DevServer | null = null
const mintedUids: string[] = []
const mintedEmails: string[] = []
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') warn(`\n🔴 cleanup (${why})`)
  // 🔴 Live privilege first. This gate mints TWO admin role rows; one
  // surviving a crash is a standing super-admin nobody created on
  // purpose. Ordered and verified for that reason.
  if (mintedEmails.length) {
    const r = await db.from('user_roles').delete().in('email', mintedEmails).select('id')
    if (r.error || (r.data ?? []).length !== mintedEmails.length) {
      warn(`   🔴 role rows: removed ${(r.data ?? []).length}/${mintedEmails.length}`); fails++
    } else say(`   ↩ removed ${(r.data ?? []).length} role row(s)`)
  }
  for (const uid of mintedUids) {
    const r = await db.auth.admin.deleteUser(uid).catch(e => ({ error: e }))
    if ((r as { error?: unknown }).error) { warn(`   🔴 could not delete auth user ${uid}`); fails++ }
  }
  if (mintedUids.length) say(`   ↩ deleted ${mintedUids.length} auth user(s)`)
  const left = await db.from('user_roles').select('id,email,role').in('email', mintedEmails)
  if ((left.data ?? []).length > 0) {
    warn(`   🔴 ${(left.data ?? []).length} ADMIN ROLE ROW(S) STILL PRESENT: ${JSON.stringify(left.data)}`); fails++
  }
  if (srv) { await srv.stop(); srv = null; say('   ↩ stopped the server this gate started (whole process group)') }
}
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => { if (dying) return; dying = true
    cleanup(sig).then(() => process.exit(2)).catch(() => process.exit(2)) })
}
process.on('uncaughtException', e => {
  warn(`🔴 uncaught: ${(e as Error).message}`)
  cleanup('uncaughtException').then(() => process.exit(2)).catch(() => process.exit(2))
})


async function mint(label: string, active: boolean) {
  const email = `zz-ra-${label}-${S}@test.invalid`
  const u = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${S}q` })
  if (u.error || !u.data.user) throw new Error(`createUser(${email}): ${u.error?.message}`)
  mintedUids.push(u.data.user.id); mintedEmails.push(email)
  const ins = await db.from('user_roles').insert({ email, role: 'admin', company: null, property: [], is_active: active }).select('id')
  if (ins.error) throw new Error(`user_roles(${email}): ${ins.error.message}`)
  // 🔴 The session is minted while the row is ACTIVE for both subjects,
  // then one row is flipped off. A token issued before the flip is
  // exactly the case this check exists for — minting it after would
  // prove nothing a login refusal does not already.
  const { cookie } = await cookieHeaderFor(db, URL_, ANON, email)
  return { email, cookie }
}

// The three callers the sweep found, with a request that is safe to
// send and still proves authorization was passed.
const ROUTES = [
  { path: '/api/admin/stripe-mode', method: 'GET' as const, body: null,
    note: 'reads the Stripe mode' },
  { path: '/api/proposal-codes/0/issue', method: 'POST' as const, body: {},
    note: 'issues a proposal code — called with id 0 so it refuses on the id AFTER auth' },
  { path: '/api/proposal-codes/0/preview-pdf', method: 'POST' as const, body: {},
    note: 'a 501 stub today, but the same gate' },
]

const call = (r: typeof ROUTES[number], cookie?: string) => fetch(`${BASE}${r.path}`, {
  method: r.method, redirect: 'manual',
  headers: { ...(r.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
  ...(r.body ? { body: JSON.stringify(r.body) } : {}),
})

const main = async () => {
  if (await portBusy(PORT)) {
    warn(`🔴 something is already listening on ${PORT}. Refusing: it may be a stale build.`)
    process.exit(2)
  }

  // 🔴 The helper must actually have the check, or this gate's refusals
  // would be measuring something else (a redirect, an RLS denial).
  const src = fs.readFileSync('app/lib/server-auth.ts', 'utf8')
  const inReq = src.slice(src.indexOf('export async function requireAdmin'),
                          src.indexOf('export type AnyAuthResult'))
  if (!/\bis_active\b/.test(inReq)) {
    warn('🔴 requireAdmin() does not mention is_active. Refusing to report on the unfixed helper.')
    process.exit(2)
  }

  try {
    const active = await mint('live', true)
    const dead = await mint('dead', true)
    // Flip AFTER the session exists.
    const off = await db.from('user_roles').update({ is_active: false })
      .eq('email', dead.email).select('is_active').maybeSingle()
    if (off.error || off.data?.is_active !== false) throw new Error('could not deactivate the canary')
    say(`two admins minted; ${dead.email} deactivated AFTER its session was issued\n`)

    say(`starting next dev on ${PORT}…`)
    srv = await startDevServer(PORT)
    if (!srv) { warn('🔴 server did not come up'); await cleanup('end'); process.exit(2) }
    say('server up\n')

    for (const r of ROUTES) {
      console.log(`── ${r.path} ──`)
      console.log(`   ${r.note}`)

      const anon = await call(r)
      chk('   anonymous is refused', anon.status === 307 || anon.status === 302 || anon.status === 401,
        `HTTP ${anon.status}${anon.headers.get('location') ? ` → ${anon.headers.get('location')}` : ''}`)

      const deadRes = await call(r, dead.cookie)
      const deadBody = await deadRes.text()
      chk('🔴 a DEACTIVATED admin is refused',
        deadRes.status === 403,
        `HTTP ${deadRes.status} ${deadBody.slice(0, 140)}`)
      chk('      ...and the refusal says why, so an operator can diagnose it',
        /deactivated/i.test(deadBody),
        deadBody.slice(0, 140) + ' — "admin required" for a deactivated account sends them hunting for a role problem')

      // 🔴 THE POSITIVE CONTROL. Without it this gate passes on a
      // helper that refuses everyone.
      const liveRes = await call(r, active.cookie)
      const liveBody = await liveRes.text()
      chk('🔴 an ACTIVE admin gets PAST authorization',
        liveRes.status !== 401 && liveRes.status !== 403
        && !(liveRes.status === 307 && /\/login/.test(liveRes.headers.get('location') ?? '')),
        `HTTP ${liveRes.status} ${liveBody.slice(0, 120)} — not a 401/403/login, so the route reached its own logic`)
      console.log('')
    }

    // ── 🔴 the fourth site the sweep found, measured not fixed ──────
    // app/company_admin/layout.tsx reads select('role') with no
    // is_active either. It is not a requireAdmin caller, so it is
    // outside the ruling — but it is the same shape, and where a
    // deactivated CA should LAND is a product decision (/login,
    // /deactivated, or the blank portal they get today). Measured here
    // so the report is not a guess.
    console.log('── the fourth site: /company_admin for a deactivated CA ──')
    const { data: demo } = await db.from('companies').select('name').eq('company_env', 'demo').limit(1).maybeSingle()
    const caEmail = `zz-ra-ca-${S}@test.invalid`
    const cu = await db.auth.admin.createUser({ email: caEmail, email_confirm: true, password: `Zz!${S}q` })
    if (cu.error || !cu.data.user) throw new Error(`createUser(${caEmail}): ${cu.error?.message}`)
    mintedUids.push(cu.data.user.id); mintedEmails.push(caEmail)
    await db.from('user_roles').insert({ email: caEmail, role: 'company_admin', company: demo!.name, property: [], is_active: true })
    const caSession = await cookieHeaderFor(db, URL_, ANON, caEmail)
    await db.from('user_roles').update({ is_active: false }).eq('email', caEmail)
    const caRes = await fetch(`${BASE}/company_admin`, { redirect: 'manual', headers: { Cookie: caSession.cookie } })
    const loc = caRes.headers.get('location') ?? ''
    chk('   a deactivated CA is not sent to /deactivated',
      true,
      `HTTP ${caRes.status}${loc ? ` → ${loc}` : ''} — reported, not asserted: this route's gate reads role without is_active, so what stops a deactivated CA is RLS returning nothing, not the gate. Where they SHOULD land is a product decision.`)

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { warn(`🔴 ${(e as Error).message}`); await cleanup('throw'); process.exit(2) })

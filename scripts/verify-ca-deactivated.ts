// ════════════════════════════════════════════════════════════════════
// GATE — a deactivated CA lands on /deactivated, not a blank portal
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16. app/company_admin/layout.tsx read user_roles.role
// and nothing else, and a deactivated CA can still READ their own role
// row — so the gate passed them and what stopped them was RLS
// returning nothing for every subsequent query. They reached the portal
// and saw a blank one, which looks like a broken product rather than
// removed access.
//
// 🔴 THE POSITIVE CONTROL IS THE DANGEROUS HALF. A gate that only
// proves the refusal passes equally well on a layout that redirects
// EVERY CA, which would be a total outage for the one role that
// administers the account. So an active CA is checked on the same run,
// with consent in place, and must reach the portal.
//
// 🔴 NO CONSENT IS SET UP, DELIBERATELY. The first version of this gate
// copied consent rows onto both canaries so they would reach the portal
// — which inserted into user_consents, a table this gate's cleanup did
// not clean, and coupled it to that table's schema for no gain.
//
// It is not needed, because the ordering is the point. The deactivation
// check runs BEFORE the consent check, so the deactivated canary lands
// on /deactivated whether or not it has consented — and that it does
// NOT land on /consent is exactly what is asserted. The active canary
// is asserted only not to land on /deactivated, which holds whether it
// reaches the portal or the consent screen.
//
// A gate should write the least state that still proves the claim.
//
// Usage: npm run verify:cadeactivated

import { createClient } from '@supabase/supabase-js'
import { say, warn } from './lib/safe-log'
import { startDevServer, portBusy, type DevServer } from './lib/dev-server'
import fs from 'fs'
import { cookieHeaderFor } from './lib/ssr-session'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 3997
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
  // Live privilege first — these are company_admin rows at a real
  // company, and one surviving a crash is an account nobody created.
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
  const left = await db.from('user_roles').select('id,email').in('email', mintedEmails)
  if ((left.data ?? []).length > 0) {
    warn(`   🔴 ${(left.data ?? []).length} CA ROLE ROW(S) STILL PRESENT: ${JSON.stringify(left.data)}`); fails++
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

const main = async () => {
  if (await portBusy(PORT)) {
    warn(`🔴 something is already listening on ${PORT}. Refusing: it may be a stale build.`)
    process.exit(2)
  }

  // The layout must actually have the check, or the refusals below
  // would be measuring the consent gate instead.
  const src = fs.readFileSync('app/company_admin/layout.tsx', 'utf8')
  if (!/get_my_effective_active/.test(src)) {
    warn('🔴 company_admin/layout.tsx does not call get_my_effective_active. Refusing to report on the unfixed layout.')
    process.exit(2)
  }

  const { data: demo } = await db.from('companies').select('id,name,account_state')
    .eq('company_env', 'demo').limit(1).maybeSingle()
  if (!demo) { warn("🔴 no company with company_env='demo'. Refusing."); process.exit(2) }
  say(`subject company: ${demo.name} (account_state=${demo.account_state})\n`)

  try {
    // ── the two canaries, both consented ───────────────────────────
    const make = async (label: string) => {
      const email = `zz-cad-${label}-${S}@test.invalid`
      const u = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${S}q` })
      if (u.error || !u.data.user) throw new Error(`createUser(${email}): ${u.error?.message}`)
      mintedUids.push(u.data.user.id); mintedEmails.push(email)
      const ins = await db.from('user_roles').insert({
        email, role: 'company_admin', company: demo.name, property: [], is_active: true,
      }).select('id')
      if (ins.error) throw new Error(`user_roles(${email}): ${ins.error.message}`)
      const { cookie } = await cookieHeaderFor(db, URL_, ANON, email)
      return { email, uid: u.data.user.id, cookie }
    }
    const live = await make('live')
    const dead = await make('dead')

    // Deactivate ONE, after its session exists. A token issued before
    // the flip is the case this gate is about.
    const off = await db.from('user_roles').update({ is_active: false })
      .eq('email', dead.email).select('is_active').maybeSingle()
    if (off.error || off.data?.is_active !== false) throw new Error('could not deactivate the canary')
    say(`\n${dead.email} deactivated AFTER its session was issued\n`)

    srv = await startDevServer(PORT)
    if (!srv) { warn('🔴 server did not come up'); await cleanup('end'); process.exit(2) }
    say('server up\n')

    const visit = async (cookie: string) => {
      const r = await fetch(`${BASE}/company_admin`, { redirect: 'manual', headers: { Cookie: cookie } })
      return { status: r.status, loc: r.headers.get('location') ?? '' }
    }

    console.log('── 🔴 the deactivated CA ──')
    const d = await visit(dead.cookie)
    chk('🔴 is redirected to /deactivated',
      /\/deactivated/.test(d.loc),
      `HTTP ${d.status} → ${d.loc || '(no redirect — they reached the portal)'}`)
    chk('   ...with their role, so the page shows CA-scoped escalation',
      /role=company_admin/.test(d.loc),
      `${d.loc} — /deactivated switches its copy on ?role=`)
    chk('🔴 ...and NOT to /consent',
      !/\/consent/.test(d.loc),
      'being asked to sign a SaaS agreement for an account you no longer have access to is the wrong order; deactivation is the earlier fact')
    chk('   ...and NOT to the portal itself',
      d.status !== 200,
      `HTTP ${d.status} — a blank portal looks like a broken product rather than removed access`)

    console.log('\n── 🔴 the ACTIVE CA, which is the half that matters more ──')
    const a = await visit(live.cookie)
    chk('🔴 reaches the portal, unchanged',
      a.status === 200 || (a.status === 307 && !/\/deactivated/.test(a.loc)),
      `HTTP ${a.status}${a.loc ? ` → ${a.loc}` : ''} — if this ever fails, the fix is an outage for the one role that administers the account`)
    chk('   ...and is not sent to /deactivated',
      !/\/deactivated/.test(a.loc),
      a.loc || 'no redirect')
    if (a.status === 307) {
      say(`   note: HTTP 307 → ${a.loc}. Expected, and not a failure of this gate.`)
      say('   The layout\'s consent check runs AFTER the one under test, and a')
      say('   freshly-minted CA has signed nothing — B118 working. What is asserted')
      say('   here is only that an active CA is NOT sent to /deactivated.')
    }

    // ── the RPC behind it, for the record ─────────────────────────
    console.log('\n── the chain check itself ──')
    for (const [label, who] of [['active', live], ['deactivated', dead]] as const) {
      const { accessToken } = await cookieHeaderFor(db, URL_, ANON, who.email)
      const c = createClient(URL_, ANON, { auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${accessToken}` } } })
      const r = await c.rpc('get_my_effective_active')
      chk(`get_my_effective_active() is ${label === 'active' ? 'true' : 'false'} for the ${label} CA`,
        r.data === (label === 'active'),
        `= ${JSON.stringify(r.data)}${r.error ? ` err=${r.error.message}` : ''}`)
    }
    // 🔴 Why user_roles.is_active alone was not enough to diagnose this.
    const { accessToken } = await cookieHeaderFor(db, URL_, ANON, dead.email)
    const dc = createClient(URL_, ANON, { auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } } })
    const own = await dc.from('user_roles').select('role,is_active').ilike('email', dead.email)
    chk('🔴 a deactivated CA can STILL read their own role row — which is why the old gate passed them',
      (own.data ?? []).length === 1 && own.data![0].role === 'company_admin',
      `${JSON.stringify(own.data)} — the layout selected only \`role\`, saw 'company_admin', and let them through`)

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { warn(`🔴 ${(e as Error).message}`); await cleanup('throw'); process.exit(2) })

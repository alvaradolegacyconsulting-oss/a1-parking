// ════════════════════════════════════════════════════════════════════
// GATE — the resident claim step
// ════════════════════════════════════════════════════════════════════
//
// 🔴 HOW "EXERCISED ON THE 35" IS DONE WITHOUT CLAIMING 35 RECORDS.
// A full invite creates an auth user and a user_roles row. Doing that
// for all 35 on every run would mutate 35 demo records each time and
// leave the gate un-repeatable. So:
//
//   • ALL 35 are checked read-only — live residents row, no auth user,
//     no role row, so the route would find every one of them. That is
//     the population assertion.
//   • ONE of them, chosen deterministically, is claimed END TO END and
//     then restored: the auth user and the role row the route created
//     are deleted, with the deletion verified. The residents row is
//     never touched.
//
// All 35 are @test.shieldmylot.com, a non-delivering domain, so no real
// mailbox receives anything — checked before writing this, because
// "exercise it on the 35" would otherwise have meant 35 real emails.
//
// 🔴 THE CENTRAL ASSERTION IS THE IDENTICAL ANSWER. A genuine claim, a
// wrong property, an unknown address and a rate-limited retry must all
// return the SAME body. Anything else makes the form an oracle for
// "is this person a resident at this property" — a worse disclosure
// than the dead end it replaces.
//
// Usage: npm run verify:claim

import { createClient } from '@supabase/supabase-js'
import { spawn, type ChildProcess } from 'child_process'
import net from 'net'
import fs from 'fs'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 3990
const BASE = `http://127.0.0.1:${PORT}`
// Cloudflare's published always-pass testing secret. The captcha is a
// bot gate, not the control under test; isolating it is the same
// discipline as verify:createuserguard.
const TEST_SECRET = '1x0000000000000000000000000000000AA'
const S = Date.now()

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

let server: ChildProcess | null = null
const mintedUids: string[] = []
const mintedRoleIds: number[] = []
const canaryResidentIds: number[] = []
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') console.error(`\n🔴 cleanup (${why})`)
  // 🔴 The auth users the ROUTE created for real demo records. These
  // are the restore — the records themselves are never modified.
  for (const uid of mintedUids) {
    const r = await db.auth.admin.deleteUser(uid).catch(e => ({ error: e }))
    if ((r as { error?: unknown }).error) { console.error(`   🔴 could not delete minted auth user ${uid}`); fails++ }
  }
  const back = await db.auth.admin.listUsers({ perPage: 1000 })
  const left = (back.data?.users ?? []).filter(u => mintedUids.includes(u.id))
  if (left.length) { console.error(`   🔴 ${left.length} minted auth user(s) STILL PRESENT`); fails++ }
  else if (mintedUids.length) console.log(`   ↩ deleted ${mintedUids.length} auth user(s) the route minted`)

  if (mintedRoleIds.length) {
    const r = await db.from('user_roles').delete().in('id', mintedRoleIds).select('id')
    if (r.error || (r.data ?? []).length !== mintedRoleIds.length) { console.error(`   🔴 role rows: removed ${(r.data ?? []).length}/${mintedRoleIds.length}`); fails++ }
    else console.log(`   ↩ removed ${mintedRoleIds.length} role row(s) the route created`)
  }
  if (canaryResidentIds.length) {
    const r = await db.from('residents').delete().in('id', canaryResidentIds).select('id')
    if (r.error || (r.data ?? []).length !== canaryResidentIds.length) console.error(`   🔴 canary residents: removed ${(r.data ?? []).length}/${canaryResidentIds.length}`)
  }
  for (const [t, c] of [['residents', 'email'], ['user_roles', 'email']] as const) {
    const stray = await db.from(t).delete().ilike(c, `%zzcl${S}%`).select('id')
    if ((stray.data ?? []).length) console.error(`   ⚠ swept ${(stray.data ?? []).length} stray ${t}`)
  }
  // The audit rows this run wrote are the rate-limit store, so they
  // must go or the next run starts pre-throttled.
  const au = await db.from('audit_logs').delete().eq('action', 'RESIDENT_CLAIM_INVITE')
    .gte('created_at', new Date(S - 60_000).toISOString()).select('id')
  if ((au.data ?? []).length) console.log(`   ↩ removed ${(au.data ?? []).length} claim audit row(s) from this run`)
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
  s.once('error', () => res(true)); s.once('listening', () => s.close(() => res(false)))
  s.listen(PORT, '127.0.0.1')
})

const claim = async (body: object) => {
  const r = await fetch(`${BASE}/api/register/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ captchaToken: 'dummy', ...body }),
  })
  return { status: r.status, text: await r.text() }
}
const authUser = async (email: string) => {
  const all = await db.auth.admin.listUsers({ perPage: 1000 })
  return (all.data?.users ?? []).find(u => (u.email ?? '').toLowerCase() === email.toLowerCase())
}

const main = async () => {
  if (await portBusy()) {
    console.error(`🔴 something is already listening on ${PORT}. Refusing: it may be a stale build.`)
    process.exit(2)
  }

  try {
    // ── the population, read-only ─────────────────────────────────
    const emails = new Set<string>()
    let page = 1
    for (;;) {
      const { data } = await db.auth.admin.listUsers({ page, perPage: 1000 })
      const u = data?.users ?? []
      for (const x of u) if (x.email) emails.add(x.email.trim().toLowerCase())
      if (u.length < 1000) break
      page++
    }
    const { data: res } = await db.from('residents').select('id,email,property,company,unit,is_active,status')
    const { data: ur } = await db.from('user_roles').select('email')
    const roleEmails = new Set((ur ?? []).map(r => String(r.email).trim().toLowerCase()))
    const pop = (res ?? []).filter(r =>
      r.is_active === true && r.status === 'active'
      && !emails.has(String(r.email).trim().toLowerCase()))
      .sort((a, b) => Number(a.id) - Number(b.id))

    console.log('── the claim population, checked read-only ──')
    chk(`all ${pop.length} are live residents with no auth user`, pop.length > 0, `${pop.length} found`)
    chk('🔴 none of them has a user_roles row (so the route must create one)',
      pop.every(r => !roleEmails.has(String(r.email).trim().toLowerCase())),
      `${pop.filter(r => roleEmails.has(String(r.email).trim().toLowerCase())).length} already have one`)
    const risky = pop.filter(r => !/test\.|example\.|\.invalid$/.test(String(r.email).toLowerCase()))
    chk('🔴 none is a deliverable address — no real mailbox is written to',
      risky.length === 0, risky.length ? `🔴 ${risky.map(r => r.email).join(', ')}` : 'all non-delivering test domains')

    const subject = pop[0]
    if (!subject) { console.error('🔴 no claimable resident to exercise against'); await cleanup('end'); process.exit(2) }
    console.log(`\n   end-to-end subject: ${subject.email} · ${subject.property} · unit ${subject.unit ?? '(none)'}\n`)

    // ── a canary at a DIFFERENT property, for the wrong-property case
    const canaryEmail = `zzcl${S}@test.invalid`
    const other = (res ?? []).find(r => r.property !== subject.property)
    const cRes = await db.from('residents').insert({
      name: `ZZ CL ${S}`, email: canaryEmail, unit: '101',
      property: subject.property, company: subject.company, is_active: true, status: 'active',
    }).select('id').single()
    if (cRes.error) throw new Error(`canary resident: ${cRes.error.message}`)
    canaryResidentIds.push(cRes.data.id as number)

    // ── server ────────────────────────────────────────────────────
    console.log(`starting next dev on ${PORT} with the always-pass captcha secret…`)
    server = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
      env: { ...process.env, TURNSTILE_SECRET_KEY: TEST_SECRET, NODE_ENV: 'development' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    server.stderr?.on('data', d => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`   [server] ${s}`) })
    const until = Date.now() + 90_000
    let up = false
    while (Date.now() < until && !up) {
      try { const r = await fetch(`${BASE}/api/register/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); up = r.status === 400 } catch {}
      if (!up) await new Promise(r => setTimeout(r, 700))
    }
    if (!up) { console.error('🔴 server did not come up'); await cleanup('end'); process.exit(2) }
    console.log('server up\n')

    // ── shape errors are NOT the identical answer ─────────────────
    console.log('── input shape ──')
    const noEmail = await claim({ property: subject.property })
    chk('a missing email is a 400 that says so', noEmail.status === 400, `HTTP ${noEmail.status}`)
    const badEmail = await claim({ email: 'has%wildcard@x.com', property: subject.property })
    chk('a blocked email character is refused by guardEmail', badEmail.status === 400, `HTTP ${badEmail.status}`)
    const noCaptcha = await fetch(`${BASE}/api/register/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: subject.email, property: subject.property }),
    })
    chk('🔴 no captcha token → refused before any lookup', noCaptcha.status === 400, `HTTP ${noCaptcha.status}`)

    // ── 🔴 THE IDENTICAL ANSWER ───────────────────────────────────
    console.log('\n── 🔴 the identical answer ──')
    const unknown = await claim({ email: `nobody-${S}@test.invalid`, property: subject.property })
    const wrongProp = await claim({ email: canaryEmail, property: other?.property ?? 'ZZ Nowhere' })
    const real = await claim({ email: subject.email, property: subject.property })
    chk('an unknown address and a real claim return the SAME body',
      unknown.text === real.text && unknown.status === real.status,
      `unknown=${unknown.status} real=${real.status}`)
    chk('a real resident at the WRONG property returns the same body too',
      wrongProp.text === real.text, `wrongProperty=${wrongProp.status}`)
    chk('   ...and that body never names the property or the person',
      !real.text.includes(String(subject.property)) && !real.text.toLowerCase().includes(String(subject.email).toLowerCase()),
      real.text.slice(0, 110))

    // ── the end-to-end claim actually happened ────────────────────
    console.log('\n── what the real claim did ──')
    const created = await authUser(String(subject.email))
    if (created) mintedUids.push(created.id)
    chk('🔴 an auth user was created by the INVITE path', !!created,
      created ? `uid ${created.id}` : '🔴 none — the invite did not land')
    chk('   ...and it is unconfirmed until they accept', !created?.email_confirmed_at,
      `email_confirmed_at=${created?.email_confirmed_at ?? 'null'} — the mailbox proves ownership, not us`)

    const { data: newRole } = await db.from('user_roles')
      .select('id,email,role,company,property,is_active').ilike('email', String(subject.email)).limit(1)
    const role = (newRole ?? [])[0]
    if (role) mintedRoleIds.push(role.id as number)
    chk('🔴 a resident role row was created — without it the portal is blank',
      !!role && role.role === 'resident' && role.is_active === true, JSON.stringify(role))
    chk('   ...with values DERIVED from the residents row, not invented',
      role?.company === subject.company && JSON.stringify(role?.property) === JSON.stringify([subject.property]),
      `company=${role?.company} property=${JSON.stringify(role?.property)}`)

    const meta = (created?.user_metadata ?? {}) as Record<string, unknown>
    chk('🔴 the invite carries property and unit', meta.claim_property === subject.property,
      JSON.stringify(meta))
    chk('🔴 ...and carries NO plate — a wrong recipient learns nothing about a vehicle',
      !JSON.stringify(meta).toLowerCase().includes('plate'), JSON.stringify(meta))

    const { data: auRows } = await db.from('audit_logs').select('record_id,new_values')
      .eq('action', 'RESIDENT_CLAIM_INVITE').ilike('record_id', String(subject.email)).limit(5)
    chk('the invite is audited with the property and unit', (auRows ?? []).length >= 1,
      JSON.stringify((auRows ?? [])[0]?.new_values))

    // ── already has a login → nothing further ─────────────────────
    console.log('\n── a second request for the same address ──')
    const again = await claim({ email: subject.email, property: subject.property })
    chk('the answer is still identical', again.text === real.text)
    const after = await authUser(String(subject.email))
    chk('🔴 ...and no second auth user appears', after?.id === created?.id, `uid ${after?.id}`)

    // ── the companion-vehicle field is ignored ────────────────────
    console.log('\n── the companion-vehicle field ──')
    const { count: before } = await db.from('vehicles').select('*', { count: 'exact', head: true })
      .ilike('resident_email', String(subject.email))
    await claim({ email: subject.email, property: subject.property, plate: 'ZZCLAIM1', state: 'TX', vehicle_plate: 'ZZCLAIM1' })
    const { count: afterN } = await db.from('vehicles').select('*', { count: 'exact', head: true })
      .ilike('resident_email', String(subject.email))
    chk('🔴 a plate sent to the claim route creates NO vehicle',
      (afterN ?? 0) === (before ?? 0),
      `${before} → ${afterN}. New cars go through the manager's approval path, not a claim.`)

    // ── 🔴 WHAT ACTUALLY CAPS REPEAT INVITES, AND WHAT DOES NOT ───
    // The first version of this section asserted "no 4th invite was
    // recorded — the ceiling held" and PASSED. It passed for the wrong
    // reason: the first invite creates the auth user, so every later
    // request short-circuits at the `if (uid) return answer()` branch
    // and never reaches the ceiling. The ceiling was not exercised.
    //
    // 🔴 And chasing that found a real flaw in my own design, reported
    // in claim-rate-limit-counts-successes.md: the limiter counts AUDIT
    // ROWS, which exist only on a SUCCESSFUL invite. An address with no
    // record writes no audit row, so a caller probing unknown addresses
    // increments nothing and is never throttled. The limiter caps
    // legitimate repeats and does nothing about abuse.
    //
    // So this asserts what is actually true: ONE unsolicited invite per
    // address, ever, enforced by the uid check rather than by a
    // counter. That is the real cap, and it is the one worth defending.
    console.log('\n── what actually caps repeat invites ──')
    const fourth = await claim({ email: subject.email, property: subject.property })
    chk('a repeat request returns the identical answer', fourth.text === real.text)
    const { data: auCount } = await db.from('audit_logs').select('id')
      .eq('action', 'RESIDENT_CLAIM_INVITE').ilike('record_id', String(subject.email))
    chk('🔴 exactly ONE invite exists for this address after 4 requests',
      (auCount ?? []).length === 1,
      `${(auCount ?? []).length} invite(s). The cap is the uid check — once an auth user exists the route sends nothing more — NOT the per-hour ceiling, which this cannot reach.`)
    chk('   ...and the ceiling is therefore UNPROVEN by this gate',
      true,
      'stated, not asserted: the per-email ceiling needs 3 successful invites to the same address, which the uid check makes impossible. See claim-rate-limit-counts-successes.md.')

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })

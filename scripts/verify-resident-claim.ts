// ════════════════════════════════════════════════════════════════════
// GATE — the resident claim step, and the /claim door
// ════════════════════════════════════════════════════════════════════
//
// Two things are gated here, because they share one route:
//   • the claim STEP — the tokenless handoff inside /register, which
//     stays as the safety net for anyone who scans the old QR;
//   • the /claim DOOR — the separate per-property entry point a CA
//     prints as its own flyer for a property it bulk-loaded. Its four
//     assertions are the last four sections: one identical body, one
//     timing class, an email for records-bearing only, and /register
//     unchanged.
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

    // ── 🔴 THE RECOVERY PATH, PROVEN BY EXECUTION ─────────────────
    // The one-invite-per-address cap creates a question: what happens
    // to a resident whose invite expired or went missing? If recovery
    // did not work for an invited-but-never-accepted user, that cap
    // would be a dead end and the claim screen would need a "resend"
    // affordance with a cooldown.
    //
    // It works. Asserted here rather than left as a one-off probe,
    // because it is Supabase behaviour we depend on and would not
    // notice changing.
    console.log('\n── the recovery path for an invited, never-accepted user ──')
    const recEmail = `zzcl-rec-${S}@test.invalid`
    const recRes = await db.from('residents').insert({
      name: `ZZ CL REC ${S}`, email: recEmail, unit: '104',
      property: subject.property, company: subject.company, is_active: true, status: 'active',
    }).select('id').single()
    if (recRes.error) throw new Error(`recovery canary resident: ${recRes.error.message}`)
    canaryResidentIds.push(recRes.data.id as number)

    const recClaim = await claim({ email: recEmail, property: subject.property })
    chk('the canary is invited (identical answer)', recClaim.text === real.text)
    const recUser = await authUser(recEmail)
    if (recUser) mintedUids.push(recUser.id)
    const { data: recRole } = await db.from('user_roles').select('id').ilike('email', recEmail).limit(1)
    if ((recRole ?? [])[0]) mintedRoleIds.push((recRole ?? [])[0].id as number)
    chk('   ...and is UNCONFIRMED, never signed in',
      !!recUser && !recUser.email_confirmed_at && !recUser.last_sign_in_at,
      `confirmed=${recUser?.email_confirmed_at ?? 'null'} last_sign_in=${recUser?.last_sign_in_at ?? 'never'}`)

    const recLink = await db.auth.admin.generateLink({ type: 'recovery', email: recEmail })
    chk('🔴 Supabase ISSUES a recovery link for that user', !recLink.error && !!recLink.data?.properties?.hashed_token,
      recLink.error ? `🔴 REFUSED: ${recLink.error.message} — the cap IS a dead end; the claim screen needs a resend affordance` : 'issued')
    if (recLink.data?.properties?.hashed_token) {
      const rc = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
      const rv = await rc.auth.verifyOtp({ token_hash: recLink.data.properties.hashed_token, type: 'recovery' })
      chk('🔴 ...it establishes a session', !rv.error && !!rv.data.session, rv.error?.message ?? 'ok')
      if (rv.data.session) {
        const up = await rc.auth.updateUser({ password: `Zz!rec${S}q` })
        chk('   ...a password can be set', !up.error, up.error?.message ?? 'ok')
        const role = await rc.rpc('get_my_role')
        chk('🔴 ...and they resolve to "resident", not NULL', role.data === 'resident',
          `get_my_role() → ${JSON.stringify(role.data)} — this is why the role row is created before the invite`)
        const conf = await authUser(recEmail)
        chk('   ...and accepting recovery CONFIRMS the email', !!conf?.email_confirmed_at,
          `email_confirmed_at=${conf?.email_confirmed_at ?? 'still null'}`)
      }
    }
    // 🔴 What this does NOT prove: that the user-facing
    // resetPasswordForEmail DISPATCHES for an unconfirmed user. That
    // call is refused by the project captcha before user state is
    // considered, so it cannot be tested from here, and delivery needs
    // a real mailbox. The token mechanism above is proven; the send is
    // GoTrue's own behaviour on the endpoint /forgot-password already
    // uses in production.

    // ════════════════════════════════════════════════════════════════
    // 🔴 THE /claim DOOR — one answer, one timing class, one send
    // ════════════════════════════════════════════════════════════════
    // Ruled 2026-10-15. /claim is a SEPARATE entry point for a
    // bulk-loaded property, printed by the CA as its own flyer. The
    // normal QR /register flow is untouched, which the last section of
    // this gate asserts rather than assumes.
    //
    // Four inputs must be indistinguishable from the outside:
    //   records-bearing · unknown · staff · already-claimed
    // and exactly ONE of them may cause an email.
    console.log('\n── 🔴 /claim: the four cases, built as canaries ──')

    // A staff canary: a residents row AND a staff role on one address.
    // 🔴 This is the ONLY branch that needs a resident record to exist
    // in order to be reached — the route checks the record first, so a
    // staff address with no record would exit through the no-match
    // branch and prove nothing about the staff exclusion. The shape is
    // amandacanchol@gmail.com's: a live resident record beside a
    // manager role.
    const staffEmail = `zzcl-staff-${S}@test.invalid`
    const sResB = await db.from('residents').insert({
      name: `ZZ CL STAFF ${S}`, email: staffEmail, unit: '201',
      property: subject.property, company: subject.company, is_active: true, status: 'active',
    }).select('id').single()
    if (sResB.error) throw new Error(`staff canary resident: ${sResB.error.message}`)
    canaryResidentIds.push(sResB.data.id as number)
    const sRole = await db.from('user_roles').insert({
      email: staffEmail, role: 'manager', company: subject.company,
      property: [subject.property], is_active: true,
    }).select('id').single()
    if (sRole.error) throw new Error(`staff canary role: ${sRole.error.message}`)
    mintedRoleIds.push(sRole.data.id as number)
    chk('a staff canary exists: live resident record + manager role on one address',
      true, `${staffEmail} — the amandacanchol shape`)

    // A records-bearing canary with no auth user: the one case that
    // MAY send. Fresh, because `subject` has been claimed above and is
    // now the already-claimed case.
    const sendEmail = `zzcl-send-${S}@test.invalid`
    const sendRes = await db.from('residents').insert({
      name: `ZZ CL SEND ${S}`, email: sendEmail, unit: '202',
      property: subject.property, company: subject.company, is_active: true, status: 'active',
    }).select('id').single()
    if (sendRes.error) throw new Error(`send canary resident: ${sendRes.error.message}`)
    canaryResidentIds.push(sendRes.data.id as number)

    // ── 🔴 ZERO EMAILS FOR EVERYTHING BUT RECORDS-BEARING ───────────
    // Measured as: no auth user appears for that address, and no
    // RESIDENT_CLAIM_INVITE audit row is written. inviteUserByEmail is
    // the route's only send, and it cannot send without creating the
    // user — so an absent auth user IS an absent email. The audit row
    // is the second, independent witness, so a change that moved the
    // send off inviteUserByEmail could not pass this silently.
    console.log('\n── 🔴 zero emails except for records-bearing ──')
    const invitesFor = async (e: string) => {
      const { data } = await db.from('audit_logs').select('id')
        .eq('action', 'RESIDENT_CLAIM_INVITE').ilike('record_id', e)
      return (data ?? []).length
    }
    const subjectInvitesBefore = await invitesFor(String(subject.email))

    const timed = async (body: object) => {
      const t = Date.now()
      const r = await claim(body)
      return { ...r, ms: Date.now() - t }
    }
    const unknownEmail = `zzcl-none-${S}@test.invalid`
    const caseSend    = await timed({ email: sendEmail,    property: subject.property })
    const caseUnknown = await timed({ email: unknownEmail, property: subject.property })
    const caseStaff   = await timed({ email: staffEmail,   property: subject.property })
    const caseClaimed = await timed({ email: subject.email, property: subject.property })

    const sendUser = await authUser(sendEmail)
    if (sendUser) mintedUids.push(sendUser.id)
    const { data: sendRole } = await db.from('user_roles').select('id,role').ilike('email', sendEmail).limit(1)
    if ((sendRole ?? [])[0]) mintedRoleIds.push((sendRole ?? [])[0].id as number)
    chk('🔴 records-bearing → an invite WAS sent (auth user + audit row)',
      !!sendUser && (await invitesFor(sendEmail)) === 1,
      `uid=${sendUser?.id ?? 'none'} invites=${await invitesFor(sendEmail)}`)
    chk('   ...and its role row is resident, not the canary manager role',
      (sendRole ?? [])[0]?.role === 'resident', JSON.stringify((sendRole ?? [])[0]))

    chk('🔴 unknown → NO auth user and NO invite audit row',
      !(await authUser(unknownEmail)) && (await invitesFor(unknownEmail)) === 0,
      `an address with no record is never mailed, which is what stops this page relaying spam`)
    chk('🔴 staff → NO auth user and NO invite audit row',
      !(await authUser(staffEmail)) && (await invitesFor(staffEmail)) === 0,
      `a manager role beside a resident record is refused: the claim path writes role:'resident' and would shadow staff authority`)
    chk('🔴 already-claimed → no SECOND invite audit row',
      (await invitesFor(String(subject.email))) === subjectInvitesBefore,
      `${subjectInvitesBefore} → ${await invitesFor(String(subject.email))}; a re-invite is a surprise password reset for someone who can already sign in`)

    // ── 🔴 IDENTICAL BODY ACROSS ALL FOUR ───────────────────────────
    console.log('\n── 🔴 identical response body across all four cases ──')
    const bodies = { send: caseSend, unknown: caseUnknown, staff: caseStaff, claimed: caseClaimed }
    const distinct = new Set(Object.values(bodies).map(b => `${b.status}|${b.text}`))
    chk('🔴 all four return one byte-identical status+body',
      distinct.size === 1,
      distinct.size === 1
        ? `HTTP ${caseSend.status} · ${caseSend.text.slice(0, 90)}`
        : `🔴 ${distinct.size} distinct answers:\n       ` + Object.entries(bodies).map(([k, v]) => `${k}=${v.status} ${v.text.slice(0, 60)}`).join('\n       '))
    chk('   ...and the body is the ruled copy, verbatim',
      caseSend.text.includes('Check your email. If your property set you up, your setup link arrives within a few minutes.'),
      caseSend.text.slice(0, 140))
    chk('   ...and it names no property, no unit and no address',
      !caseSend.text.includes(String(subject.property)) && !caseSend.text.includes(sendEmail) && !caseSend.text.includes('202'),
      caseSend.text.slice(0, 140))

    // ── 🔴 TIMING CLASS — AND WHAT THAT PHRASE CAN HONESTLY MEAN ────
    // 🔴 THIS IS A FLOOR, NOT CONSTANT TIME, and the gate asserts the
    // floor rather than pretending otherwise. The route pads every
    // answer to FLOOR_MS before returning, so the fast branches cannot
    // be told from the slow one by being quick. A send that takes
    // LONGER than the floor still takes longer — Supabase's invite call
    // is a network round-trip and no padding hides that — so what is
    // defended is: nothing is distinguishably FAST, and the
    // send-nothing branches (which is every branch an attacker can
    // reach for an address they are probing) are one indistinguishable
    // group.
    const FLOOR = 900
    console.log('\n── 🔴 timing class (a floor, not constant time) ──')
    console.log(`   send=${caseSend.ms}ms unknown=${caseUnknown.ms}ms staff=${caseStaff.ms}ms claimed=${caseClaimed.ms}ms`)
    chk(`🔴 every one of the four takes at least the ${FLOOR}ms floor`,
      [caseSend, caseUnknown, caseStaff, caseClaimed].every(c => c.ms >= FLOOR - 40),
      `min=${Math.min(...[caseSend, caseUnknown, caseStaff, caseClaimed].map(c => c.ms))}ms (40ms tolerance for the clock around fetch)`)
    const noSend = [caseUnknown.ms, caseStaff.ms, caseClaimed.ms]
    const spread = Math.max(...noSend) - Math.min(...noSend)
    chk('🔴 the three send-nothing branches are one indistinguishable group',
      spread < 250,
      `spread=${spread}ms across unknown/staff/already-claimed. These are the branches a prober reaches; if they separated, the page would be an oracle for "is this person a resident here" despite the identical copy.`)
    chk('   ...and the send branch is not distinguishable by being FASTER',
      caseSend.ms >= Math.min(...noSend) - 40,
      `send=${caseSend.ms}ms vs fastest send-nothing=${Math.min(...noSend)}ms. Stated plainly: a send may be SLOWER, and the floor does not hide that. Constant time would need the invite moved off the request path.`)

    // ── 🔴 NON-REGRESSION: /register IS UNTOUCHED ───────────────────
    // The ruling is explicit that the normal QR flow stays as it is for
    // everyone, with its tokenless-card handoff as the safety net. A
    // new door that quietly changed the old one would be the failure
    // mode, so both are rendered and compared.
    console.log('\n── 🔴 non-regression: the normal /register flow ──')
    const qs = `property=${encodeURIComponent(String(subject.property))}&company=${encodeURIComponent(String(subject.company))}`
    const regRes = await fetch(`${BASE}/register?${qs}`)
    const regHtml = await regRes.text()
    chk('/register still renders', regRes.status === 200, `HTTP ${regRes.status}`)
    // 🔴 The first marker I reached for was the plate input's
    // placeholder, and it FAILED: the plate field is on step 3, so a
    // GET of /register never renders it. The assertion had come off a
    // grep line instead of off the render — the same mistake as
    // control 9, and the gate caught it this time. The marker that is
    // actually in the initial render is the step-1 heading, which is
    // also the better one: "Step 1 of 3" IS the three-screen flow the
    // complaint was about, so its presence here and absence on /claim
    // is exactly the difference the ruling asked for.
    chk('🔴 ...and it is still the full three-step form, not the claim form',
      regHtml.includes('Step 1 of 3') && !regHtml.includes('claim-email'),
      `step-1 heading present=${regHtml.includes('Step 1 of 3')} claim form present=${regHtml.includes('claim-email')}`)
    // Source-level, because the tokenless card renders only after a
    // submit with no token and cannot be reached by a GET. Counted, so
    // that a deletion cannot hide behind a surviving mention.
    const regSrc = fs.readFileSync('app/register/page.tsx', 'utf8')
    const offerHits = (regSrc.match(/\bofferClaim\b/g) ?? []).length
    chk('🔴 ...and the tokenless-card handoff is still wired (the safety net stays)',
      offerHits >= 2, `offerClaim appears ${offerHits}× (state + render); the ruling keeps this as the fallback for anyone who scans the old QR`)

    const clmRes = await fetch(`${BASE}/claim?${qs}`)
    const clmHtml = await clmRes.text()
    chk('/claim renders', clmRes.status === 200, `HTTP ${clmRes.status}`)
    chk('🔴 ...asking for an email and nothing else — no password, no unit, no plate',
      clmHtml.includes('claim-email') && !/Step 1 of 3/.test(clmHtml) && !/type="password"/.test(clmHtml),
      `email field=${clmHtml.includes('claim-email')} three-step flow=${/Step 1 of 3/.test(clmHtml)} password=${/type="password"/.test(clmHtml)}`)
    chk('   ...and it names the property it was printed for',
      clmHtml.includes(String(subject.property)),
      `the flyer is per-property, and the "Register here" fallback must land on the SAME property`)
    chk('🔴 ...and offers the Register-here fallback before anything is typed',
      /Register here/.test(clmHtml) && clmHtml.includes(`/register?property=${encodeURIComponent(String(subject.property))}`),
      'a resident the import missed must not hit a dead end')

    const noProp = await fetch(`${BASE}/claim`)
    const noPropHtml = await noProp.text()
    chk('a /claim link with no property says so instead of asking for an email',
      noProp.status === 200 && /incomplete/i.test(noPropHtml) && !noPropHtml.includes('claim-email'),
      `HTTP ${noProp.status} — the route would answer a propertyless claim with "Please enter your email address", advice the user cannot act on`)

    // ── the public-path allowlist ───────────────────────────────────
    const mw = fs.readFileSync('middleware.ts', 'utf8')
    chk("🔴 '/claim' is in middleware publicPaths — an imported resident has no login yet",
      /'\/claim'/.test(mw), 'without it the one audience for this page is redirected to /login')
    const expMap = fs.readFileSync('scripts/route-exposure-map.ts', 'utf8')
    chk("   ...and '/claim' is declared in the route-exposure map",
      /'\/claim':/.test(expMap), 'an undeclared public route fails verify:routes')

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })

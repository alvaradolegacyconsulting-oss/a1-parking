// ════════════════════════════════════════════════════════════════════
// PROBE (report-only, changes no product code) — can a DEACTIVATED
// user still sign in and pass get_my_role()-based policies?
// ════════════════════════════════════════════════════════════════════
//
// get_my_role() is:
//   SELECT role FROM user_roles WHERE lower(email)=lower(auth.jwt()->>'email') LIMIT 1
// No is_active term. The question is whether that is reachable.
//
// 🔴 CANARY ONLY. A manager role row this script creates on
// Test-LEGACY, with its own auth user. Never A1, never an existing
// row — the script refuses if the property is not Test-LEGACY's.
//
// Measures four things, in order:
//   1. does the canary's password sign-in work while active
//   2. after a per-user deactivation (the exact UPDATE the CA portal
//      issues: user_roles.is_active = false, auth user untouched),
//      does sign-in still work
//   3. what get_my_role() / get_my_company() return in that session
//   4. whether real tenant data comes back through direct PostgREST
//      for that session — the portal gate is client-side, so this is
//      the only question that matters
// Then the same again with auth.users.banned_until set, which is what
// company-level deactivation does, to see whether THAT path holds.

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const CO = 'Test-LEGACY'
const S = Date.now()
const EMAIL = `zz-deact-${S}@test.invalid`
const PASS = `Zz!deact${S}q`

let uid: string | null = null
let roleId: number | null = null
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') console.error(`\n🔴 cleanup (${why})`)
  if (roleId !== null) {
    const r = await db.from('user_roles').delete().eq('id', roleId).select('id')
    console.log(r.error || (r.data ?? []).length !== 1 ? `   🔴 user_roles ${roleId} NOT removed` : `   ↩ removed user_roles ${roleId}`)
  }
  await db.from('user_roles').delete().ilike('email', 'zz-deact-%').select('id')
  if (uid) {
    await db.auth.admin.deleteUser(uid).catch(() => {})
    const back = await db.auth.admin.listUsers({ perPage: 1000 })
    console.log((back.data?.users ?? []).some(u => u.id === uid) ? `   🔴 auth user ${uid} STILL PRESENT` : `   ↩ deleted auth user ${uid}`)
  }
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

// 🔴 SESSION ACQUISITION IS NOT THE THING UNDER TEST, SO IT MUST NOT
// BE THE THING THAT REFUSES.
//
// The first run of this probe used signInWithPassword and every
// attempt — including the ACTIVE baseline — came back
// "captcha protection: request disallowed". signInWithPassword is
// captcha-gated project-wide (the create-user route says so in its own
// comments). Reporting those refusals as "deactivation blocks sign-in"
// would have been the MIME-allowlist mistake over again: a refusal
// from a bot gate read as an access control. The ACTIVE baseline is
// what caught it, which is the reason to always have one.
//
// generateLink + verifyOtp is the ungated path (confirmed by a prod
// probe 2026-06-29 and relied on by /register today). It is also the
// honest path to test: an attacker with a token does not need a
// password, so the question is what the SESSION can do, not how it was
// obtained.
const PASSWORD_IS_CAPTCHA_GATED = true
const signIn = async () => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
  if (lErr || !link?.properties?.hashed_token) {
    return { c, ok: false, err: `generateLink refused: ${lErr?.message ?? 'no token'}` }
  }
  const r = await c.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  return { c, ok: !r.error && !!r.data.session, err: r.error?.message ?? null }
}

const look = async (c: ReturnType<typeof createClient>, label: string) => {
  const role = await c.rpc('get_my_role')
  const company = await c.rpc('get_my_company')
  // PostgrestFilterBuilder is a thenable, not a Promise — no .catch on it.
  const props = await c.rpc('get_my_properties')
  const residents = await c.from('residents').select('id,name,unit,email').limit(5)
  const vehicles = await c.from('vehicles').select('id,plate,unit').limit(5)
  console.log(`   ${label}`)
  console.log(`     get_my_role()       → ${JSON.stringify(role.data)}${role.error ? ' err=' + role.error.message.slice(0, 40) : ''}`)
  console.log(`     get_my_company()    → ${JSON.stringify(company.data)}`)
  console.log(`     get_my_properties() → ${props.error ? 'err=' + props.error.message.slice(0, 40) : JSON.stringify(props.data)}`)
  console.log(`     residents readable  → ${residents.error ? 'refused: ' + residents.error.message.slice(0, 44) : `🔴 ${residents.data?.length} row(s)` }`)
  if (!residents.error && (residents.data ?? []).length) console.log(`        e.g. ${JSON.stringify(residents.data![0])}`)
  console.log(`     vehicles readable   → ${vehicles.error ? 'refused: ' + vehicles.error.message.slice(0, 44) : `🔴 ${vehicles.data?.length} row(s)` }`)
}

const main = async () => {
  const { data: props } = await db.from('properties').select('id,name,company,is_active')
  const prop = props?.find(p => p.company === CO && p.name === 'Test Legacy Property' && p.is_active)
  if (!prop) { console.error(`🔴 no active ${CO} property`); process.exit(2) }
  if (/a1/i.test(prop.company ?? '')) { console.error('🔴 refusing: canary property is A1'); process.exit(2) }

  const { data: u, error: uErr } = await db.auth.admin.createUser({ email: EMAIL, password: PASS, email_confirm: true })
  if (uErr || !u.user) { console.error('🔴 createUser:', uErr?.message); process.exit(2) }
  uid = u.user.id
  const ins = await db.from('user_roles').insert({
    email: EMAIL, role: 'manager', company: CO, property: [prop.name], is_active: true,
  }).select('id').single()
  if (ins.error) { console.error('🔴 user_roles:', ins.error.message); await cleanup('end'); process.exit(2) }
  roleId = ins.data.id as number

  try {
    console.log(`canary: manager ${EMAIL} at ${prop.name} [${CO}], own auth user, is_active=true\n`)

    console.log('── 1. ACTIVE — the baseline, so the comparison means something ──')
    console.log(`   (signInWithPassword is captcha-gated here: ${PASSWORD_IS_CAPTCHA_GATED}. Using the`)
    console.log(`    ungated generateLink + verifyOtp path so the captcha cannot be mistaken`)
    console.log(`    for the control under test.)`)
    const a = await signIn()
    console.log(`   session acquired: ${a.ok ? 'yes' : 'no — ' + a.err}`)
    if (a.ok) await look(a.c, 'as an ACTIVE manager:')

    console.log('\n── 2. DEACTIVATED the way the portals actually do it ──')
    console.log('   (UPDATE user_roles SET is_active = false — the exact call at')
    console.log('    admin/page.tsx:500 and company_admin/page.tsx:3022; the auth')
    console.log('    user is NOT touched by any of those four call sites)')
    const d = await db.from('user_roles').update({ is_active: false }).eq('id', roleId).select('is_active').single()
    if (d.error || d.data?.is_active !== false) { console.error('🔴 could not deactivate'); await cleanup('end'); process.exit(2) }
    const ban = await db.auth.admin.listUsers({ perPage: 1000 })
    const me = (ban.data?.users ?? []).find(x => x.id === uid) as { banned_until?: string } | undefined
    console.log(`   auth.users.banned_until after deactivation: ${JSON.stringify(me?.banned_until ?? null)}`)

    const b = await signIn()
    console.log(`\n   🔴 session acquired while DEACTIVATED: ${b.ok ? 'YES' : 'no — ' + b.err}`)
    if (b.ok) await look(b.c, '🔴 as a DEACTIVATED manager:')

    console.log('\n── 3. with auth.users.banned_until set (what COMPANY deactivation does) ──')
    const { error: banErr } = await db.auth.admin.updateUserById(uid!, { ban_duration: '876000h' })
    if (banErr) console.log(`   (could not ban via the admin API: ${banErr.message})`)
    const c3 = await signIn()
    console.log(`   session acquired while BANNED: ${c3.ok ? '🔴 YES' : 'no — ' + c3.err}`)
    if (c3.ok) await look(c3.c, '🔴 as a BANNED manager:')
    // and does an already-issued session survive the ban?
    if (b.ok) {
      const after = await b.c.from('residents').select('id').limit(1)
      console.log(`   a session issued BEFORE the ban, used after it: ${after.error ? 'refused: ' + after.error.message.slice(0, 40) : `🔴 still reads ${after.data?.length} row(s)`}`)
    }
  } finally {
    await cleanup('end')
  }
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })

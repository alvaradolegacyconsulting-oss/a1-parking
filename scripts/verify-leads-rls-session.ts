// ════════════════════════════════════════════════════════════════════
// The assertion G7 could not make (2026-09-23)
// ════════════════════════════════════════════════════════════════════
//
// The SQL editor runs as a superuser role that BYPASSES RLS, so G7 could
// prove admin_select_leads has the right command, roles and predicate —
// but not that a real non-admin session is actually refused. Only a live
// authenticated session can answer that. This is that test.
//
// 🔴 A REFUSAL AND A BROKEN FIXTURE LOOK IDENTICAL. An RLS denial returns
// {data: [], error: null} — an empty set, not an error. So "the manager
// saw nothing" is also what a manager who was never given a session, or
// a table that is simply empty, would produce. G-ADMIN is therefore not
// optional: a real lead row must be SEEN by the admin in the same run,
// through the same client shape, or the non-admin empty set proves
// nothing at all.
//
// Fixtures are disposable +stamped accounts on test.shieldmylot.com and
// one throwaway lead row, all removed at the end with the removal
// verified by re-query.
import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL')
const ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const admin = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'))

const S = Date.now().toString(36)
const DOM = 'test.shieldmylot.com'
const F = {
  admin:        { email: `lrls-${S}-admin@${DOM}`, role: 'admin' },
  companyAdmin: { email: `lrls-${S}-ca@${DOM}`,    role: 'company_admin' },
  manager:      { email: `lrls-${S}-mgr@${DOM}`,   role: 'manager' },
  driver:       { email: `lrls-${S}-drv@${DOM}`,   role: 'driver' },
  noRole:       { email: `lrls-${S}-none@${DOM}`,  role: null },
}
const PROBE_EMAIL = `lrls-${S}-lead@verification.invalid`

let failures = 0
const pass = (id: string, n: string) => console.log(`✅ ${id}  ${n}`)
const fail = (id: string, n: string) => { failures++; console.log(`❌ ${id}  ${n}`) }

async function session(email: string): Promise<string | null> {
  const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  const hashed = (link as unknown as { properties?: { hashed_token?: string } })?.properties?.hashed_token
  if (error || !hashed) return null
  const { data } = await createClient(URL_, ANON).auth.verifyOtp({ token_hash: hashed, type: 'magiclink' })
  return data?.session?.access_token ?? null
}

async function main() {
  const created: string[] = []
  let probeId: number | null = null
  const tokens: Record<string, string> = {}

  try {
    console.log('── fixtures ──')
    for (const k of Object.keys(F) as (keyof typeof F)[]) {
      const { email, role } = F[k]
      const { error } = await admin.auth.admin.createUser({ email, password: 'Lrls' + S + '!aB9', email_confirm: true })
      if (error) { console.log(`  🔴 ${email}: ${error.message}`); continue }
      created.push(email)
      // noRole deliberately gets NO user_roles row — authenticated but
      // unassigned is its own case, and it must also be refused.
      if (role) await admin.from('user_roles').insert([{ email, role, company: 'Test-LEGACY' }])
      const t = await session(email)
      if (t) tokens[k] = t
      console.log(`  ${email.padEnd(40)} role=${String(role).padEnd(14)} session=${t ? 'yes' : '🔴 NO'}`)
    }

    const missing = (Object.keys(F) as (keyof typeof F)[]).filter(k => !tokens[k])
    if (missing.length) {
      fail('F0', `no session for ${missing.join(', ')} — every read below would be unauthenticated and meaningless`)
      return
    }
    pass('F0', 'all five fixtures hold a real session token')

    const { data: ins, error: insErr } = await admin.from('leads')
      .insert([{ email: PROBE_EMAIL, track: 'enforcement', company_name: 'RLS Probe Co' }])
      .select('id').single()
    if (insErr || !ins) { fail('F1', `could not seed a probe lead: ${insErr?.message}`); return }
    probeId = (ins as { id: number }).id
    pass('F1', `probe lead seeded (id ${probeId}) — there IS something to see`)

    const readAs = async (tok: string) => {
      const c = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${tok}` } } })
      return await c.from('leads').select('id, email, company_name')
    }

    console.log('\n══ NON-ADMIN SESSIONS MUST SEE NOTHING ══')
    for (const k of ['companyAdmin', 'manager', 'driver', 'noRole'] as const) {
      const { data, error } = await readAs(tokens[k])
      const n = (data ?? []).length
      const sawProbe = (data ?? []).some((r: { id: number }) => r.id === probeId)
      if (error) {
        pass(`N-${k}`, `${F[k].role ?? 'no role row'} refused with ${error.code}: ${error.message.slice(0, 60)}`)
      } else if (n === 0) {
        pass(`N-${k}`, `${F[k].role ?? 'no role row'} → 0 rows, no error (RLS filtered, as designed)`)
      } else {
        fail(`N-${k}`, `🔴 ${F[k].role ?? 'no role row'} READ ${n} LEAD ROW(S)${sawProbe ? ' INCLUDING THE PROBE' : ''} — prospect PII is exposed`)
      }
    }

    console.log('\n══ 🔴 POSITIVE CONTROL — admin MUST see it ══')
    {
      const { data, error } = await readAs(tokens.admin)
      const sawProbe = (data ?? []).some((r: { id: number }) => r.id === probeId)
      if (error) fail('G-ADMIN', `admin was REFUSED (${error.code}: ${error.message}) — the empty sets above prove nothing`)
      else if (!sawProbe) fail('G-ADMIN', `admin saw ${(data ?? []).length} row(s) but NOT the probe — the empty sets above prove nothing`)
      else pass('G-ADMIN', `admin read the probe row back (${(data ?? []).length} row(s) total) — the refusals above are real`)
    }
  } finally {
    console.log('\n── teardown ──')
    if (probeId !== null) {
      const { data: del } = await admin.from('leads').delete().eq('id', probeId).select('id')
      console.log(`  probe lead removed: ${(del ?? []).length}`)
    }
    const { data: roles } = await admin.from('user_roles').delete().ilike('email', `lrls-${S}-%`).select('email')
    let gone = 0
    for (const email of created) {
      const { data: id } = await admin.rpc('get_auth_user_id_by_email', { p_email: email })
      if (id) { const { error } = await admin.auth.admin.deleteUser(id as string); if (!error) gone++ }
    }
    console.log(`  role rows removed: ${(roles ?? []).length}   auth users removed: ${gone}/${created.length}`)
    const { data: leftLeads } = await admin.from('leads').select('id').ilike('email', '%@verification.invalid')
    const { data: leftRoles } = await admin.from('user_roles').select('email').ilike('email', `lrls-${S}-%`)
    if ((leftLeads ?? []).length === 0 && (leftRoles ?? []).length === 0) pass('T1', 'teardown verified — no fixture rows remain')
    else fail('T1', `🔴 remains: ${(leftLeads ?? []).length} lead(s), ${(leftRoles ?? []).length} role row(s)`)
  }

  console.log('')
  console.log(failures === 0 ? '✅ ALL GATES PASS' : `❌ ${failures} GATE(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main()

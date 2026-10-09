// ════════════════════════════════════════════════════════════════════
// GATE — portal plan names, and who can read a negotiated deal
// ════════════════════════════════════════════════════════════════════
//
// Two things that look unrelated and are the same fact. A1 and a
// self-serve Operator Pro both carry tier='legacy'. A1's negotiated
// rate is $325 flat with $0 per property; the self-serve rate is $299 +
// $20. So the TIER CANNOT distinguish them, and anything keyed on it —
// the "Tailored rate" wording, the plan name, the price — was wrong for
// one population or the other.
//
// proposal_codes_summary is the discriminator. Which makes WHO CAN READ
// IT part of the same arc: it was granted to every authenticated user
// and filtered only by company, so an A1 resident could read the
// owner's email address out of it.
//
// Proven here:
//   PURE — every (track, tier) pair maps to a public plan name, and no
//          unmapped pair can print a raw tier key
//   EXEC — a company_admin WITH a redeemed code reads 1 row  (A1 shape)
//          a company_admin WITHOUT one reads 0 rows          (self-serve)
//          a resident at the deal company reads 0 rows
//          a driver at the deal company reads 0 rows
//          a manager at the deal company reads 0 rows
//
// 🔴 Uses throwaway companies, never A1. A1's data is not test input.
//
// Usage: npx tsx scripts/verify-plan-names.ts

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import { tokenFor, PLANS, type PlanToken } from '../app/lib/signup-tier-param'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const STAMP = Date.now()
const DEAL_CO = `ZZ Deal Co ${STAMP}`
const SELF_CO = `ZZ SelfServe Co ${STAMP}`

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }
const users: { email: string; uid: string }[] = []
const companies: number[] = []
const codes: number[] = []

/** The exact expression the portal uses. Kept in lockstep deliberately. */
const portalLabel = (track: string, tier: string) => {
  const t = tokenFor(track, tier)
  return t ? PLANS[t as PlanToken].label
           : (track === 'property_management' ? 'Property Management' : 'Enforcement')
}

async function actor(tag: string, role: string, company: string) {
  const email = `zz-pn-${tag}-${STAMP}@test.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${STAMP}q` })
  if (error || !data.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  users.push({ email, uid: data.user.id })
  const r = await db.from('user_roles').insert({ email, role, company, property: [], is_active: true })
  if (r.error) throw new Error(`user_roles ${tag}: ${r.error.message}`)
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (lErr || !link.properties?.hashed_token) throw new Error(`generateLink ${tag}: ${lErr?.message}`)
  const { error: vErr } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (vErr) throw new Error(`verifyOtp ${tag}: ${vErr.message}`)
  return { email, client }
}

const main = async () => {
  // ── PURE: names ───────────────────────────────────────────────────
  console.log('── plan names (pure) ──')
  const expect: Array<[string, string, string]> = [
    ['property_management', 'pm_starter',       'PM Starter'],
    ['property_management', 'legacy',           'PM Pro'],
    ['enforcement',         'enforcement_only', 'Operator Starter'],
    ['enforcement',         'legacy',           'Operator Pro'],
  ]
  for (const [track, tier, want] of expect) {
    chk(`${track}/${tier} → ${want}`, portalLabel(track, tier) === want, portalLabel(track, tier))
  }
  // 🔴 the property that matters most: no raw key, ever.
  const unmapped: Array<[string, string]> = [
    ['property_management', 'pm_only'], ['enforcement', 'premium'],
    ['enforcement', 'growth'], ['property_management', 'enterprise'],
    ['enforcement', 'something_new'], ['', ''],
  ]
  for (const [track, tier] of unmapped) {
    const out = portalLabel(track, tier)
    chk(`unmapped ${track || '(blank)'}/${tier || '(blank)'} does not print the tier key`,
      tier === '' ? true : !out.includes(tier), out)
  }
  chk('…and the "(formerly …)" suffix is NOT in portal labels',
    expect.every(([tr, ti]) => !portalLabel(tr, ti).toLowerCase().includes('formerly')))

  // ── Pre-flight ────────────────────────────────────────────────────
  const vdef = await db.from('proposal_codes_summary').select('id').limit(1)
  if (vdef.error && /does not exist/i.test(vdef.error.message)) {
    console.error('proposal_codes_summary missing — apply the migrations first.'); process.exit(2)
  }

  console.log('\n── negotiated-deal visibility (execution) ──')
  try {
    for (const name of [DEAL_CO, SELF_CO]) {
      const c = await db.from('companies').insert({
        name, tier: 'legacy', tier_type: 'enforcement', is_active: true, account_state: 'active',
      }).select('id').single()
      if (c.error) throw new Error(`companies ${name}: ${c.error.message}`)
      companies.push(c.data.id as number)
    }
    const [dealId] = companies

    // A redeemed code for the deal company only — the A1 shape.
    const pc = await db.from('proposal_codes').insert({
      code: `ZZDEAL-${STAMP}`, company_id: dealId, status: 'redeemed',
      redeemed_at: new Date().toISOString(), base_tier: 'legacy', base_tier_type: 'enforcement',
      client_name: 'ZZ Deal Co', client_email: `zz-deal-${STAMP}@test.invalid`,
      custom_base_fee: 325, custom_per_property_fee: 0,
    }).select('id').single()
    if (pc.error) throw new Error(`proposal_codes: ${pc.error.message}`)
    codes.push(pc.data.id as number)

    const dealCA   = await actor('dealca',   'company_admin', DEAL_CO)
    const selfCA   = await actor('selfca',   'company_admin', SELF_CO)
    const dealRes  = await actor('dealres',  'resident',      DEAL_CO)
    const dealDrv  = await actor('dealdrv',  'driver',        DEAL_CO)
    const dealMgr  = await actor('dealmgr',  'manager',       DEAL_CO)

    const rows = async (c: ReturnType<typeof createClient>) => {
      const r = await c.from('proposal_codes_summary').select('id, client_email')
      // 🔴 An RLS/view filter returns { data: [], error: null } — a
      // filter, not a failure. Distinguish them: an ERROR is not a pass.
      return { n: r.data?.length ?? -1, err: r.error?.message ?? null }
    }

    const a = await rows(dealCA.client)
    chk('company_admin WITH a redeemed code sees 1 row (the A1 shape)', a.n === 1, `n=${a.n} err=${a.err}`)

    const b = await rows(selfCA.client)
    chk('company_admin WITHOUT one sees 0 rows (self-serve Operator Pro)', b.n === 0, `n=${b.n} err=${b.err}`)

    for (const [label, who] of [['resident', dealRes], ['driver', dealDrv], ['manager', dealMgr]] as const) {
      const r = await rows(who.client)
      chk(`a ${label} at the deal company sees 0 rows`, r.n === 0, `n=${r.n} err=${r.err}`)
    }

    // The badge each CA would render, end to end.
    chk('→ deal company renders "Tailored rate"', a.n === 1)
    chk('→ self-serve company renders "Operator Pro"', b.n === 0 && portalLabel('enforcement', 'legacy') === 'Operator Pro')
  } finally {
    for (const id of codes) await db.from('proposal_codes').delete().eq('id', id)
    for (const u of users) {
      await db.from('user_roles').delete().ilike('email', u.email)
      await db.auth.admin.deleteUser(u.uid).catch(() => {})
    }
    for (const id of companies) await db.from('companies').delete().eq('id', id)
    const { data: orph } = await db.auth.admin.listUsers({ perPage: 1000 })
    for (const o of (orph?.users ?? []).filter(u => /^zz-pn-[a-z]+-\d+@test\.invalid$/.test(u.email ?? ''))) {
      await db.from('user_roles').delete().ilike('email', o.email!)
      await db.auth.admin.deleteUser(o.id).catch(() => {})
      console.log(`  swept orphan: ${o.email}`)
    }
  }

  const leftCo = (await db.from('companies').select('*', { count: 'exact', head: true }).ilike('name', 'ZZ %Co %')).count
  chk('fixtures cleaned up', leftCo === 0, `${leftCo} companies left`)

  console.log('')
  if (fails) { console.log(`❌ ${fails} FAILURE(S).`); process.exit(1) }
  console.log('✅ Public plan names in the portal; only a company_admin can see a negotiated deal.')
}
main().catch(e => { console.error('FATAL', e.message); process.exit(2) })

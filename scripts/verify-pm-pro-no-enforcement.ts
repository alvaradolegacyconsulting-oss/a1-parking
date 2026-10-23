// ════════════════════════════════════════════════════════════════════
// GATE — PM Pro has no enforcement, and the direct inserts are closed
// ════════════════════════════════════════════════════════════════════
//
// The execution half of wip-20261023_pm_pro_loses_enforcement.sql. The
// SQL verification covers the helper's truth table (including A1,
// read-only) and the trigger's structure. What only this can do is
// prove the ROLE paths, because the trigger's entire mechanism is
// current_user:
//
//   a signed-in PostgREST insert  → refused
//   service_role                  → allowed (trusted server code)
//   a SECURITY DEFINER RPC        → allowed by the trigger, and gated
//                                   inside the RPC instead
//
// 🔴 TRIGGER ORDER MATTERS AND THE PROBE IS BUILT AROUND IT. Postgres
// fires BEFORE INSERT triggers in NAME order, so
// violations_reject_dead_property runs first. If the probe property
// were inactive or unassigned, that guard would refuse the insert and
// this gate would go green on the wrong refusal. So the probe property
// is active AND assigned to the probe driver, and every refusal is
// discriminated on MESSAGE TEXT, never on sqlstate — 42501 is shared
// across RLS, table grants, column grants and any custom RAISE.
//
// 🔴 A1 IS NEVER WRITTEN TO. Its enforcement flags are asserted from
// TIER_CONFIG, and its server-side answer is the SQL verification's job.
//
// Usage: npx tsx --env-file=.env.local scripts/verify-pm-pro-no-enforcement.ts

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { TIER_CONFIG } from '../app/lib/tier-config'
import { FEATURE_FLAGS } from '../app/lib/feature-flags'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const db = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

// 🔴 Date.now() alone is not unique across concurrent runs — two
// instances in the same millisecond collide on
// companies_name_ci_unique. Same defect found in verify:passtoken on
// 2026-10-23 by running two at once.
const S = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`
let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

const companies: string[] = []
const emails: string[] = []
const extraDriverEmails: string[] = []
const uids: string[] = []
const props: number[] = []
const viols: number[] = []

async function cleanup(why: string) {
  if (viols.length) await db.from('violations').delete().in('id', viols)
  for (const c of companies) await db.from('violations').delete().eq('property', `ZZprop-${c}`)
  if (props.length) await db.from('properties').delete().in('id', props)
  for (const e of [...emails, ...extraDriverEmails]) {
    await db.from('drivers').delete().eq('email', e)
    await db.from('user_roles').delete().eq('email', e)
  }
  for (const u of uids) await db.auth.admin.deleteUser(u).catch(() => {})
  if (companies.length) await db.from('companies').delete().in('name', companies)

  const leftCo = await db.from('companies').select('id').in('name', companies.length ? companies : ['-'])
  const leftUr = await db.from('user_roles').select('id').in('email', emails.length ? emails : ['-'])
  const leftPr = await db.from('properties').select('id').in('id', props.length ? props : [-1])
  // 🔴 Citations too. While the trigger is unapplied the refused inserts
  // SUCCEED, so a sweep that checked only companies and properties would
  // report clean while probe citations sat in the table.
  const leftVi = await db.from('violations').select('id')
    .in('property', companies.length ? companies.map(c => `ZZprop-${c}`) : ['-'])
  chk('probes removed, read back',
    (leftCo.data ?? []).length === 0 && (leftUr.data ?? []).length === 0
      && (leftPr.data ?? []).length === 0 && (leftVi.data ?? []).length === 0,
    `${(leftCo.data ?? []).length} compan(ies), ${(leftUr.data ?? []).length} role(s), ${(leftPr.data ?? []).length} propert(ies), ${(leftVi.data ?? []).length} citation(s) left — cleanup reason: ${why}`)
}

// 🔴 `finally` does not run on a signal, so the handlers are explicit.
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => {
    if (dying) return; dying = true
    console.error(`\n🔴 ${sig} — cleaning up probes before exit.`)
    cleanup(sig).then(() => process.exit(2)).catch(() => process.exit(2))
  })
}

/** A probe tenant with one active property and a signed-in driver on it. */
async function tenant(tag: string, tier: string, track: string, role: 'driver' | 'company_admin') {
  const name = `ZZ ${tag} ${S}`
  const prop = `ZZprop-${name}`
  const email = `zz-${tag.toLowerCase()}-${S}@test.invalid`

  const co = await db.from('companies').insert({
    name, tier, tier_type: track, is_active: true, company_env: 'test',
  }).select('id').single()
  if (co.error) throw new Error(`company ${tag}: ${co.error.message}`)
  companies.push(name)

  const pr = await db.from('properties').insert({
    name: prop, company: name, is_active: true,
  }).select('id').single()
  if (pr.error) throw new Error(`property ${tag}: ${pr.error.message}`)
  props.push(pr.data.id as number)

  const u = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${S}q` })
  if (u.error || !u.data.user) throw new Error(`createUser ${tag}: ${u.error?.message}`)
  uids.push(u.data.user.id); emails.push(email)

  const ur = await db.from('user_roles').insert({
    email, role, company: name, property: [prop], is_active: true,
  })
  if (ur.error) throw new Error(`user_roles ${tag}: ${ur.error.message}`)

  // 🔴 Only for drivers. The dead-property guard's assignment check
  // applies when get_my_role() = 'driver', so a driver probe needs a
  // drivers row carrying the property or THAT guard refuses first and
  // this gate would measure the wrong refusal. A company_admin probe
  // must NOT have one: the drivers table refuses a PM-track row
  // outright, which is asserted separately below.
  if (role === 'driver') {
    const dr = await db.from('drivers').insert({
      email, name: `ZZ ${tag} Driver`, company: name,
      assigned_properties: [prop], is_active: true,
    })
    if (dr.error) throw new Error(`drivers ${tag}: ${dr.error.message}`)
  }

  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const link = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (link.error || !link.data.properties?.hashed_token) throw new Error(`link ${tag}: ${link.error?.message}`)
  const otp = await client.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'magiclink' })
  if (otp.error) throw new Error(`otp ${tag}: ${otp.error.message}`)

  return { name, prop, email, client }
}

const payload = (prop: string, plate: string) => ({
  plate, violation_type: 'No Permit', location: 'probe', property: prop,
  driver_name: 'ZZ Probe Driver', is_confirmed: false,
})

/** Discriminate on message text. sqlstate alone cannot tell these apart. */
const refusedForTier = (msg: string | undefined) => !!msg && /tier_not_permitted/i.test(msg)
const refusedForProperty = (msg: string | undefined) => !!msg && /property|enforceab|assigned/i.test(msg)

async function main() {
  console.log('\n══ PM Pro has no enforcement ══\n')

  // ── the flags (render half), including A1 without touching it ──────
  console.log('── flags ──')
  const ENF = ['AI_PLATE_SCANNING', 'VIOLATION_DOCUMENTATION', 'TOW_TICKET_GENERATION',
               'DRIVER_PORTAL', 'STORAGE_FACILITY_MANAGEMENT', 'TOWBOOK_CSV_EXPORT'] as const
  const flag = (track: string, tier: string, f: string) =>
    (TIER_CONFIG as never as Record<string, Record<string, Record<string, unknown>>>)[track]?.[tier]?.[(FEATURE_FLAGS as Record<string, string>)[f]]

  const pmProOn = ENF.filter(f => flag('property_management', 'legacy', f) === true)
  chk('🔴 PM Pro carries NO enforcement flag', pmProOn.length === 0,
    pmProOn.length ? `🔴 still on: ${pmProOn.join(', ')}` : ENF.join(', ') + ' all off')
  chk('   ...so the CA Activity tab is hidden for PM Pro',
    flag('property_management', 'legacy', 'VIOLATION_DOCUMENTATION') === false, 'VIOLATION_DOCUMENTATION = false')

  for (const [label, track, tier] of [['Operator Pro (A1’s plan)', 'enforcement', 'legacy'],
                                      ['Operator Starter', 'enforcement', 'enforcement_only']] as const) {
    const off = ENF.filter(f => flag(track, tier, f) !== true)
    chk(`positive control: ${label} keeps every enforcement flag`, off.length === 0,
      off.length ? `🔴 lost: ${off.join(', ')}` : 'all six present')
  }

  // ── the server half ────────────────────────────────────────────────
  console.log('\n── the write paths ──')
  // PM Pro probe is a COMPANY ADMIN, not a driver, and that is the
  // point: the drivers table already refuses a PM-track row (asserted
  // below), so no driver can exist on PM Pro and the RPC path is
  // unreachable. The remaining exposure was the CA-side direct insert,
  // which needs no drivers row and which the dead-property guard does
  // not touch, because its assignment check only applies to drivers.
  const pm = await tenant('PMPro', 'legacy', 'property_management', 'company_admin')
  const op = await tenant('OpPro', 'legacy', 'enforcement', 'driver')

  // 0. the pre-existing protection, pinned so a later change cannot
  //    quietly remove it and widen this hole back out.
  extraDriverEmails.push(`zz-pmdrv-${S}@test.invalid`)
  const drv = await db.from('drivers').insert({
    email: `zz-pmdrv-${S}@test.invalid`, name: 'ZZ PM Driver', company: pm.name,
    assigned_properties: [pm.prop], is_active: true,
  })
  chk('a drivers row is already refused on the PM track',
    !!drv.error && /Property Management plan/i.test(drv.error.message),
    drv.error ? drv.error.message.slice(0, 110) : '🔴 a driver was created on a PM-track company')

  // 1. the driver fallback shape, inserted directly
  const d1 = await pm.client.from('violations').insert([{ ...payload(pm.prop, `ZZ2${S % 100000}`), snapshot_status: 'failed' }]).select('id')
  chk('🔴 PM Pro is refused on the driver-fallback direct insert', refusedForTier(d1.error?.message),
    d1.error ? `${d1.error.code}: ${d1.error.message}` : '🔴 NOT refused — the insert succeeded')

  // 2. the CA-portal direct insert — the real remaining hole
  const d2 = await pm.client.from('violations').insert([payload(pm.prop, `ZZ3${S % 100000}`)]).select('id')
  chk('🔴 PM Pro is refused on the CA-portal direct insert', refusedForTier(d2.error?.message),
    d2.error ? `${d2.error.code}: ${d2.error.message}` : '🔴 NOT refused — the insert succeeded')

  // 3. service_role is exempt ON PURPOSE — prospect-demo and server
  //    routes seed enforcement rows and carry no JWT company context.
  const sr = await db.from('violations').insert([payload(pm.prop, `ZZ4${S % 100000}`)]).select('id').single()
  if (sr.data?.id) viols.push(sr.data.id as number)
  chk('service_role may still write at a PM Pro property — the exemption is deliberate',
    !sr.error && !!sr.data?.id, sr.error ? `🔴 ${sr.error.code}: ${sr.error.message}` : `inserted id=${sr.data?.id}`)

  // 4. positive control: an enforcement/legacy driver still writes, by
  //    the RPC and directly. Red here means the change reached A1.
  const okRpc = await op.client.rpc('driver_create_violation_with_snapshot', {
    p_violation: payload(op.prop, `ZZ5${S % 100000}`), p_snapshot: [],
  })
  const okId = Number((okRpc.data as Record<string, unknown>)?.violation_id ?? (okRpc.data as Record<string, unknown>)?.id ?? 0)
  if (okId) viols.push(okId)
  chk('🔴 positive control: Operator Pro (A1\u2019s plan shape) is NOT tier-refused on the RPC path',
    !refusedForTier(okRpc.error?.message),
    okRpc.error ? `refused by something else: ${okRpc.error.message.slice(0, 110)}` : `ok: ${JSON.stringify(okRpc.data).slice(0, 100)}`)

  const okIns = await op.client.from('violations').insert([payload(op.prop, `ZZ6${S % 100000}`)]).select('id').single()
  if (okIns.data?.id) viols.push(okIns.data.id as number)
  chk('   ...and its direct insert is not tier-refused either',
    !refusedForTier(okIns.error?.message),
    okIns.error ? `refused by something else: ${okIns.error.message.slice(0, 110)}` : `inserted id=${okIns.data?.id}`)

  // 🔴 Prove the refusals above were the TIER guard and not the
  // dead-property guard firing first. If this is ever true, every
  // refusal in this run is suspect.
  const wrongGuard = [d1, d2].some(r => !refusedForTier(r.error?.message) && refusedForProperty(r.error?.message))
  chk('🔴 no refusal came from the dead-property guard instead', !wrongGuard,
    wrongGuard ? '🔴 a refusal mentioned the property, so the probe fixture is wrong and this gate measured nothing'
               : 'all refusals named tier_not_permitted')
}

main()
  .catch(e => { console.error('\n🔴 FATAL:', (e as Error).message); fails++ })
  .finally(async () => {
    await cleanup('end of run')
    console.log(fails ? `\n❌ ${fails} failed` : '\n✅ all green')
    process.exit(fails ? 1 : 0)
  })

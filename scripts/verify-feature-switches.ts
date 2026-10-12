// ════════════════════════════════════════════════════════════════════
// GATE — Piece 0, property feature switches
// ════════════════════════════════════════════════════════════════════
//
// 🔴 The assertion that matters is the one the SQL verification cannot
// make: a MANAGER is refused. properties_manager_update is FOR UPDATE
// TO authenticated for manager AND leasing_agent on their own
// properties, so before this piece a manager could flip either switch
// with a direct PATCH. The guard keys on auth.jwt(), and a SQL session
// has none — so only a real manager session proves it.
//
// Both paths are tested: the RPC (refused by its role gate) and a
// DIRECT PATCH on properties (refused by the trigger), because the
// second is the one the RLS policy would otherwise allow.
//
// Usage: npx tsx scripts/verify-feature-switches.ts

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const STAMP = Date.now()
const COMPANY = 'Test-LEGACY', PROPERTY = 'Test Legacy Property'
let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }
const users: { email: string; uid: string }[] = []
type R = Record<string, unknown>

async function actor(tag: string, role: string) {
  const email = `zz-sw-${tag}-${STAMP}@test.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${STAMP}q` })
  if (error || !data.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  users.push({ email, uid: data.user.id })
  const r = await db.from('user_roles').insert({ email, role, company: COMPANY, property: [PROPERTY], is_active: true })
  if (r.error) throw new Error(`user_roles ${tag}: ${r.error.message}`)
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (lErr || !link.properties?.hashed_token) throw new Error(`generateLink ${tag}: ${lErr?.message}`)
  const { error: vErr } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (vErr) throw new Error(`verifyOtp ${tag}: ${vErr.message}`)
  return { email, client }
}

const main = async () => {
  const probe = await db.rpc('set_property_feature_switch', { p_property: PROPERTY, p_switch: 'parking_tags', p_enabled: false })
  if (probe.error && /Could not find the function/i.test(probe.error.message)) {
    console.error('set_property_feature_switch missing — apply')
    console.error('  migrations/20261012_piece0_property_feature_switches.sql  first.')
    process.exit(2)
  }

  const before = (await db.from('properties').select('parking_tags_enabled, printable_visitor_passes_enabled').eq('name', PROPERTY).single()).data
  let CA: Awaited<ReturnType<typeof actor>> | null = null
  let MGR: Awaited<ReturnType<typeof actor>> | null = null
  try {
    CA  = await actor('ca',  'company_admin')
    MGR = await actor('mgr', 'manager')

    // ── CA can flip BOTH ──
    for (const sw of ['parking_tags', 'printable_visitor_passes'] as const) {
      const on = (await CA.client.rpc('set_property_feature_switch', { p_property: PROPERTY, p_switch: sw, p_enabled: true })).data as R
      chk(`CA can turn ${sw} ON`, on?.ok === true && on?.enabled === true, JSON.stringify(on?.error ?? on?.enabled))
    }
    const mid = (await db.from('properties').select('parking_tags_enabled, printable_visitor_passes_enabled').eq('name', PROPERTY).single()).data
    chk('…and the columns really changed', mid?.parking_tags_enabled === true && mid?.printable_visitor_passes_enabled === true, JSON.stringify(mid))

    // ── MANAGER is refused, both ways ──
    const mRpc = (await MGR.client.rpc('set_property_feature_switch', { p_property: PROPERTY, p_switch: 'parking_tags', p_enabled: false })).data as R
    chk('🔴 a manager is refused by the RPC', mRpc?.error === 'role_not_permitted', JSON.stringify(mRpc))

    // 🔴 The direct PATCH — the path properties_manager_update allows.
    const mPatch = await MGR.client.from('properties')
      .update({ parking_tags_enabled: false }).eq('name', PROPERTY).select('id')
    chk('🔴 a manager is refused by the TRIGGER on a direct PATCH',
      !!mPatch.error && /feature_switch_not_permitted/.test(mPatch.error.message),
      mPatch.error ? mPatch.error.message.slice(0, 70) : `NO ERROR — updated ${mPatch.data?.length} row(s)`)

    const afterMgr = (await db.from('properties').select('parking_tags_enabled').eq('name', PROPERTY).single()).data
    chk('…and the switch is unchanged by the attempt', afterMgr?.parking_tags_enabled === true, JSON.stringify(afterMgr))

    // 🔴 POSITIVE CONTROL on the trigger: a manager can still write
    // OTHER property columns. A guard that refuses every manager UPDATE
    // would pass the checks above and break the manager portal.
    const other = await MGR.client.from('properties')
      .update({ notes: `zz-switch-gate ${STAMP}` }).eq('name', PROPERTY).select('id')
    chk('CONTROL a manager can still edit other property columns',
      !other.error && (other.data?.length ?? 0) === 1, other.error?.message ?? 'ok')

    // ── Unknown switch, and scope ──
    const bad = (await CA.client.rpc('set_property_feature_switch', { p_property: PROPERTY, p_switch: 'nope', p_enabled: true })).data as R
    chk('an unknown switch name is refused', bad?.error === 'unknown_switch', JSON.stringify(bad?.error))
    const foreign = (await CA.client.rpc('set_property_feature_switch', { p_property: 'A1 Wrecker llc', p_switch: 'parking_tags', p_enabled: true })).data as R
    chk('a CA cannot flip a switch outside their company',
      foreign?.error === 'property_not_found_or_not_yours', JSON.stringify(foreign?.error))

    // ── Audit, with the prior value ──
    const aud = (await db.from('audit_logs').select('id, user_email, old_values, new_values')
      .eq('action', 'PROPERTY_FEATURE_SWITCH_SET').eq('user_email', CA.email)).data
    chk('audited with who, and with the PRIOR value', (aud?.length ?? 0) >= 2
      && (aud![0].old_values as R)?.enabled !== undefined, `${aud?.length} rows`)

    // ── Turning OFF keeps data (ruled) ──
    const off = (await CA.client.rpc('set_property_feature_switch', { p_property: PROPERTY, p_switch: 'parking_tags', p_enabled: false })).data as R
    chk('CA can turn it back OFF', off?.ok === true && off?.enabled === false, JSON.stringify(off?.enabled))
    chk('…and the RPC reports it actually changed', off?.changed === true, JSON.stringify(off?.changed))
    const resave = (await CA.client.rpc('set_property_feature_switch', { p_property: PROPERTY, p_switch: 'parking_tags', p_enabled: false })).data as R
    chk('a re-save reports changed:false (distinguishable from a real flip)', resave?.changed === false, JSON.stringify(resave?.changed))
  } finally {
    // Restore the property exactly as found.
    await db.from('properties').update({
      parking_tags_enabled: before?.parking_tags_enabled ?? false,
      printable_visitor_passes_enabled: before?.printable_visitor_passes_enabled ?? false,
      notes: null,
    }).eq('name', PROPERTY)
    await db.from('audit_logs').delete().eq('action', 'PROPERTY_FEATURE_SWITCH_SET').in('user_email', users.map(u => u.email))
    for (const u of users) {
      await db.from('user_roles').delete().ilike('email', u.email)
      await db.auth.admin.deleteUser(u.uid).catch(() => {})
    }
    const { data: orph } = await db.auth.admin.listUsers({ perPage: 1000 })
    for (const o of (orph?.users ?? []).filter(u => /^zz-sw-[a-z]+-\d+@test\.invalid$/.test(u.email ?? ''))) {
      await db.from('user_roles').delete().ilike('email', o.email!)
      await db.auth.admin.deleteUser(o.id).catch(() => {})
      console.log(`  swept orphan: ${o.email}`)
    }
  }

  const restored = (await db.from('properties').select('parking_tags_enabled, printable_visitor_passes_enabled, notes').eq('name', PROPERTY).single()).data
  chk('property restored to how it was found',
    restored?.parking_tags_enabled === (before?.parking_tags_enabled ?? false)
    && restored?.printable_visitor_passes_enabled === (before?.printable_visitor_passes_enabled ?? false)
    && !restored?.notes, JSON.stringify(restored))

  console.log('')
  if (fails) { console.log(`❌ ${fails} FAILURE(S).`); process.exit(1) }
  console.log('✅ Only a company admin can flip the switches — by RPC or by direct PATCH.')
}
main().catch(e => { console.error('FATAL', e.message); process.exit(2) })

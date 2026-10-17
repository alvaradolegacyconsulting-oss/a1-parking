// ════════════════════════════════════════════════════════════════════
// GATE — a renewal is a new pass, a double tap is not, and the guest
//        is never shown a time the row does not carry
// ════════════════════════════════════════════════════════════════════
//
// THE INCIDENT (2026-10-17, A1 / Green Acres, XGJ5870). The Oct 9
// dedup had no time window, so a renewal 21 hours later returned the
// old row unextended — and /visitor computed "Issued" and "Valid
// Until" in the browser, so the guest was told they were covered until
// 8:30 PM the next day while their pass lapsed at 11:01 PM that night.
// A driver looked the plate up at 12:16 AM, correctly found nothing,
// and a citation was written at 12:35 AM.
//
// 🔴 TWO HALVES, AND BOTH HAVE TO HOLD. The RPC half is behavioural
// and is exercised against the database. The display half is
// source-text, because the confirmation is a client component with no
// server surface and no render test installed — so the gate asserts
// that nothing on those screens computes a time.
//
// 🔴 THE AUDIT ASSERTIONS ARE NOT BOOKKEEPING. Before this fix a dedup
// hit wrote nothing at all, which is why the incident could not be
// sized from the database: we could not count how many guests had been
// shown a false expiry. An outcome that leaves no trace is the failure
// this gate exists to prevent recurring.
//
// Runs against a throwaway property at a TEST tenant, with its own
// limit, so no real configuration is read or changed.
//
// Usage: npx tsx --env-file=.env.local scripts/verify-visitor-renewal.ts

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } })

const S = Date.now()
const PROPERTY = `zzrenew-${S}`
const PLATE = 'ZZRENEW01'
const UNIT = '9001'
let propertyId: number | null = null

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

type Out = {
  ok?: boolean; action?: string; pass_id?: number | null
  created_at?: string | null; expires_at?: string | null; has_active_pass?: boolean
}
const issue = async (hours = 4): Promise<Out> => {
  const { data, error } = await db.rpc('issue_visitor_pass', {
    p_plate: PLATE, p_visitor_name: 'Probe', p_visiting_unit: UNIT,
    p_property: PROPERTY, p_vehicle_desc: 'probe', p_duration_hours: hours,
  })
  if (error) return { action: `ERROR: ${error.message}` }
  return (data ?? {}) as Out
}
const rows = async () => {
  const { count } = await db.from('visitor_passes').select('*', { count: 'exact', head: true }).eq('property', PROPERTY)
  return count ?? 0
}
const audits = async () => {
  const { data } = await db.from('audit_logs').select('new_values')
    .eq('action', 'VISITOR_TOS_ACCEPTED')
  return (data ?? []).filter(a => (a.new_values as Record<string, unknown>)?.property === PROPERTY)
    .map(a => String((a.new_values as Record<string, unknown>)?.outcome))
}
/** Push the last row's created_at back, so the next call is outside the window. */
const ageRows = async () => {
  await db.from('visitor_passes')
    .update({ created_at: new Date(Date.now() - 10 * 60_000).toISOString() })
    .eq('property', PROPERTY)
}

async function teardown() {
  const p = await db.from('visitor_passes').delete().eq('property', PROPERTY).select('id')
  const { data: aud } = await db.from('audit_logs').select('id,new_values').eq('action', 'VISITOR_TOS_ACCEPTED')
  const mine = (aud ?? []).filter(a => (a.new_values as Record<string, unknown>)?.property === PROPERTY).map(a => a.id)
  if (mine.length) await db.from('audit_logs').delete().in('id', mine)
  if (propertyId !== null) await db.from('properties').delete().eq('id', propertyId)
  console.log(`   ↩ removed ${p.data?.length ?? 0} pass(es), ${mine.length} audit row(s), the probe property`)
  // 🔴 Read back rather than trust the deletes.
  const left = await rows()
  const leftAud = (await audits()).length
  const leftProp = propertyId === null ? 0 : ((await db.from('properties').select('id').eq('id', propertyId)).data ?? []).length
  chk('probes are gone, read back', left === 0 && leftAud === 0 && leftProp === 0,
    `passes=${left} audits=${leftAud} property=${leftProp}`)
}

async function main() {
  console.log('\n══ visitor pass renewal ══\n')
  try {
    const { data: co } = await db.from('companies').select('name').eq('company_env', 'test').order('id').limit(1).maybeSingle()
    if (!co) throw new Error('no test-env company')
    const ins = await db.from('properties').insert({
      name: PROPERTY, company: co.name, is_active: true, visitor_pass_limit: 2,
    }).select('id').single()
    if (ins.error) throw new Error(`probe property: ${ins.error.message}`)
    propertyId = ins.data.id as number
    console.log(`probe property ${PROPERTY} at ${co.name}, visitor_pass_limit = 2\n`)

    // ── 1. first pass ────────────────────────────────────────────────
    const r1 = await issue()
    chk('a first request issues a pass', r1.action === 'issued', `action=${r1.action}`)
    chk('   ...and the response carries created_at AND expires_at',
      !!r1.created_at && !!r1.expires_at,
      `created_at=${r1.created_at} expires_at=${r1.expires_at} — the confirmation has nothing else to render`)

    // ── 2. double tap ────────────────────────────────────────────────
    const r2 = await issue()
    chk('🔴 an immediate identical request is a double tap, not a renewal',
      r2.action === 'double_tap', `action=${r2.action}`)
    chk('   ...it returns the SAME pass', r2.pass_id === r1.pass_id, `${r1.pass_id} vs ${r2.pass_id}`)
    chk('   ...and created no row', await rows() === 1, `${await rows()} row(s)`)

    // ── 3. four concurrent calls ─────────────────────────────────────
    const before = await rows()
    const burst = await Promise.all([issue(), issue(), issue(), issue()])
    chk('🔴 4 concurrent calls create no row (the Oct 9 guarantee holds)',
      await rows() === before,
      `${before} → ${await rows()}; actions: ${burst.map(b => b.action).join(', ')}`)

    // ── 4. renewal outside the window ────────────────────────────────
    await ageRows()
    const r3 = await issue()
    chk('🔴 a renewal outside the window creates a NEW pass',
      r3.action === 'issued' && await rows() === 2,
      `action=${r3.action}, ${await rows()} row(s)`)
    const { data: row3 } = await db.from('visitor_passes')
      .select('created_at,expires_at').eq('id', r3.pass_id!).maybeSingle()
    chk('🔴 the returned times ARE the row\'s times — the incident in one assertion',
      !!row3 && new Date(String(row3.expires_at)).getTime() === new Date(String(r3.expires_at)).getTime()
            && new Date(String(row3.created_at)).getTime() === new Date(String(r3.created_at)).getTime(),
      `returned ${r3.created_at} / ${r3.expires_at}\n       row      ${row3?.created_at} / ${row3?.expires_at}`)

    // ── 5. at the limit ─────────────────────────────────────────────
    await ageRows()
    const r4 = await issue()
    chk('🔴 at the limit the request is REFUSED', r4.action === 'limit_reached', `action=${r4.action}`)
    chk('   ...ok is false — a refusal must not read as a success', r4.ok === false, `ok=${r4.ok}`)
    chk('   ...and no row was created', await rows() === 2, `${await rows()} row(s)`)
    chk('   ...and it carries the REAL current expiry', !!r4.expires_at,
      `expires_at=${r4.expires_at} — found with is_active AND expires_at > now(), both`)

    // ── 6. every outcome is audited ─────────────────────────────────
    const got = await audits()
    for (const want of ['issued', 'double_tap', 'limit_reached']) {
      chk(`🔴 an audit row exists for outcome '${want}'`, got.includes(want),
        got.includes(want) ? `${got.filter(g => g === want).length} row(s)` : `🔴 absent — outcomes: ${got.join(', ')}`)
    }

    // ── 7. the display half ─────────────────────────────────────────
    console.log('\n── the confirmation renders server values only ──')
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
    const vis = strip(fs.readFileSync('app/visitor/page.tsx', 'utf8'))

    // 🔴 Comments stripped first: this file's own comments quote
    // `new Date()` while explaining why it must not be used.
    const tileBlock = vis.slice(vis.indexOf("step === 'success'"))
    chk('🔴 no new Date() anywhere in the success / refusal screens',
      !/new Date\(\s*\)/.test(tileBlock),
      !/new Date\(\s*\)/.test(tileBlock) ? 'the tiles read issued.created_at / issued.expires_at'
        : '🔴 a time is being computed on the screen that tells a guest whether they are covered')
    chk('   ...and the tiles read the RPC result',
      /issued\?\.created_at/.test(vis) && /issued\?\.expires_at/.test(vis),
      'issued?.created_at and issued?.expires_at')
    chk('   ...and the dead client-side expiry helper is gone',
      !/function formatExpiry/.test(vis),
      'formatExpiry(hours) computed now+duration and was the function to reach for next')
    const resi = strip(fs.readFileSync('app/resident/page.tsx', 'utf8'))
    chk('the resident page prints the RPC expiry too',
      /result\?\.expires_at/.test(resi) && /limit_reached/.test(resi),
      'result?.expires_at, with a limit_reached branch')

    // ── 8. the limit is server-side ─────────────────────────────────
    console.log('\n── the limit cannot be bypassed ──')
    // 🔴 SELF-SUFFICIENT, NOT DEPENDENT ON THE LEGS ABOVE. Written as
    // "insert one more and expect a refusal" this leg passed or failed
    // according to how many rows the earlier assertions happened to
    // leave — against the unmigrated RPC it reported a bypass that was
    // simply the second of two allowed rows. It now fills to the limit
    // itself, with the fill asserted, so the refusal it measures is the
    // limit and nothing else.
    const LIMIT = 2
    while (await rows() < LIMIT) {
      const pad = await db.from('visitor_passes').insert({
        plate: PLATE, visitor_name: 'fill', visiting_unit: UNIT, property: PROPERTY,
        duration_hours: 4, created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        expires_at: new Date(Date.now() + 4 * 3600_000).toISOString(), is_active: true,
      }).select('id')
      if (pad.error) break
    }
    chk(`the probe property is filled to its limit of ${LIMIT} before the bypass attempt`,
      await rows() === LIMIT, `${await rows()} row(s) — the next insert is the one over`)

    const direct = await db.from('visitor_passes').insert({
      plate: PLATE, visitor_name: 'bypass', visiting_unit: UNIT, property: PROPERTY,
      duration_hours: 4, created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 4 * 3600_000).toISOString(), is_active: true,
    }).select('id')
    chk('🔴 a direct insert past the limit is refused by the trigger, not by the RPC',
      !!direct.error, direct.error ? `${direct.error.code}: ${direct.error.message.slice(0, 90)}` : `🔴 ACCEPTED id ${direct.data?.[0]?.id}`)
    if (direct.data?.length) await db.from('visitor_passes').delete().in('id', direct.data.map(d => d.id))
  } catch (e) {
    console.log(`🔴 ${(e as Error).message}`)
    fails++
  } finally {
    console.log('')
    await teardown()
  }

  console.log(fails === 0 ? '\n✅ all green\n' : `\n❌ ${fails} failed\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(e => { console.error('🔴', (e as Error).message); process.exit(2) })

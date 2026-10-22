// ════════════════════════════════════════════════════════════════════
// GATE — enforcement stops at a deactivated property, on every path
// ════════════════════════════════════════════════════════════════════
//
// Confirmed by Jose 2026-10-22: a deactivated property blocks the
// citation AND the tow.
//
// WHAT WAS MEASURED (2026-10-16), and what each half of this gate
// therefore has to prove:
//
//   • the driver dropdown, plate lookup and tag lookup all keyed on the
//     NAME in drivers.assigned_properties and never joined properties,
//     so a deactivated property stayed selectable;
//   • driver_create_violation_with_snapshot checked assignment
//     membership and nothing about is_active;
//   • the client's fallback INSERT bypassed that guard entirely;
//   • none of set_violation_status / stamp_tow_ticket /
//     regenerate_tow_ticket consulted is_active.
//
//   Proved by execution on Test-LEGACY's deactivated "Alias Probe Two":
//   the RPC wrote violation 438 and the fallback insert wrote 439.
//
// 🔴 THE FIRST ASSERTIONS ARE THE POSITIVE ONES, READ-ONLY, ON A1. A
// guard that refuses everything passes every negative test. 18 (active
// A1 driver × active assigned property) pairs must keep working, and
// this gate reads them and asserts every one is still active before it
// looks at a single refusal. It writes nothing to A1, ever.
//
// Negatives run on test-tenant canaries only, and are removed with a
// read-back.
//
// Usage: npx tsx --env-file=.env.local scripts/verify-driver-property-guard.ts

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import { sessionAs } from './lib/smoke-auth'

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } })

const A1 = 'A1 Wrecker llc'
const DRIVER = 'legacy-driver@test.shieldmylot.com'   // Test-LEGACY
const DEAD_PROP = 'Alias Probe Two'                   // Test-LEGACY, is_active = false
const PLATE = 'ZZGUARDTS'
const made: number[] = []

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

const payload = (property: string) => ({
  plate: PLATE, violation_type: 'No Permit', location: 'CANARY — gate', notes: null,
  property, driver_name: 'Gate', driver_license: 'N/A', video_url: null,
  vehicle_color: null, vehicle_make: null, vehicle_model: null, vehicle_year: null,
  is_confirmed: false, was_authorized_at_time: false, decline_reason: null,
  decline_reason_note: null, scanned_at: new Date().toISOString(),
  headline_status_at_scan: 'notfound',
})

async function cleanup() {
  if (made.length) await db.from('violations').delete().in('id', made)
  const { data } = await db.from('violations').select('id').ilike('plate', `${PLATE}%`)
  chk('canary citations removed, read back', (data ?? []).length === 0, `${(data ?? []).length} remaining`)
}

async function main() {
  console.log('\n══ enforcement stops at a deactivated property ══\n')
  try {
    // ── 1. THE POSITIVE CONTROLS, READ-ONLY, ON A1 ───────────────────
    console.log('── 1. 🔴 the A1 pairs that must keep working (read-only) ──')
    const { data: drv } = await db.from('drivers').select('email,assigned_properties,is_active').ilike('company', '%A1%')
    const { data: props } = await db.from('properties').select('name,is_active').eq('company', A1)
    const active = new Map((props ?? []).map(p => [String(p.name), p.is_active === true]))
    let work = 0, refuse = 0, stale = 0
    for (const d of drv ?? []) {
      if (d.is_active !== true) continue
      for (const p of (d.assigned_properties as string[]) ?? []) {
        const a = active.get(p)
        if (a === undefined) stale++
        else if (a) work++
        else refuse++
      }
    }
    chk('every active A1 driver is assigned only to ACTIVE properties',
      refuse === 0 && stale === 0,
      `${work} pair(s) must keep working · ${refuse} would start refusing · ${stale} stale assignment(s)`)
    chk('   ...and no A1 driver relies on the removed [All] fallback',
      ((await db.from('user_roles').select('email').eq('role', 'driver').eq('company', A1)).data ?? [])
        .every(r => (drv ?? []).some(d => String(d.email).toLowerCase() === String(r.email).toLowerCase())),
      'every A1 driver role has a drivers row — nobody is locked out by failing closed')

    // ── 2. the negatives, on a test tenant ──────────────────────────
    console.log('\n── 2. the refusals, on a test-tenant canary ──')
    const dead = await db.from('properties').select('id,is_active,company').eq('name', DEAD_PROP).maybeSingle()
    chk(`the canary property ${DEAD_PROP} is deactivated and not A1`,
      dead.data?.is_active === false && !String(dead.data?.company).includes('A1'),
      `is_active=${dead.data?.is_active} company=${dead.data?.company}`)

    const s = await sessionAs(DRIVER, { targetEnv: 'test' })

    const rpc = await s.client.rpc('driver_create_violation_with_snapshot',
      { p_violation: payload(DEAD_PROP), p_snapshot: [] })
    const out = (rpc.data ?? {}) as Record<string, unknown>
    if (typeof out.id === 'number') made.push(out.id as number)
    chk('🔴 the RPC refuses a citation at a deactivated assigned property',
      !!rpc.error || out.ok !== true,
      rpc.error ? `refused: ${rpc.error.message.slice(0, 90)}`
                : out.ok === true ? `🔴 WROTE violation ${out.id}` : `refused: ${JSON.stringify(out).slice(0, 90)}`)

    const ins = await s.client.from('violations').insert([{
      plate: `${PLATE}2`, violation_type: 'No Permit', location: 'CANARY — gate',
      property: DEAD_PROP, driver_name: 'Gate', driver_license: 'N/A',
      is_confirmed: false, snapshot_status: 'failed',
    }]).select('id')
    for (const r of ins.data ?? []) made.push(r.id as number)
    chk('🔴 the FALLBACK insert refuses it too — the path that bypassed the RPC',
      !!ins.error,
      ins.error ? `refused: ${ins.error.code} ${ins.error.message.slice(0, 80)}`
                : `🔴 WROTE ${JSON.stringify(ins.data)}`)

    // 🔴 AN ACTIVE PROPERTY IN THE DRIVER'S OWN COMPANY THAT THEY ARE
    // NOT ASSIGNED TO. The first version of this leg used a Demo
    // Company property and passed with sqlstate 42501 — which is RLS
    // refusing a CROSS-COMPANY write, a rule that was already in place
    // and has nothing to do with assignment. It passed for the wrong
    // reason, and would have gone on passing if the assignment half
    // were never built. Same tenant, unassigned, is the case that
    // actually needs the guard.
    const { data: mine } = await db.from('drivers').select('assigned_properties')
      .ilike('email', DRIVER).maybeSingle()
    const assigned = new Set(((mine?.assigned_properties as string[]) ?? []).map(x => x.toLowerCase()))
    const { data: sameCo } = await db.from('properties').select('name')
      .eq('company', 'Test-LEGACY').eq('is_active', true)
    const foreign = String((sameCo ?? []).map(p => String(p.name))
      .find(n => !assigned.has(n.toLowerCase())) ?? '')
    const ins2 = await s.client.from('violations').insert([{
      plate: `${PLATE}3`, violation_type: 'No Permit', location: 'CANARY — gate',
      property: foreign, driver_name: 'Gate', driver_license: 'N/A',
      is_confirmed: false, snapshot_status: 'failed',
    }]).select('id')
    for (const r of ins2.data ?? []) made.push(r.id as number)
    chk('🔴 an ACTIVE but UNASSIGNED property in the same company is refused',
      !!ins2.error && foreign !== '',
      foreign === ''
        ? '🔴 inconclusive: no active unassigned Test-LEGACY property to test with'
        : ins2.error
          ? `refused at ${foreign}: ${ins2.error.code} ${ins2.error.message.slice(0, 70)}`
          : `🔴 WROTE at ${foreign} — same company, not assigned`)

    // ── 3. the tow guard ────────────────────────────────────────────
    console.log('\n── 3. the tow, on a citation written while the property was live ──')
    const { data: liveProp } = await db.from('properties').select('name')
      .eq('company', 'Test-LEGACY').eq('is_active', true).limit(1).maybeSingle()
    const lp = String(liveProp?.name ?? '')
    const seed = await db.from('violations').insert([{
      plate: `${PLATE}4`, violation_type: 'No Permit', location: 'CANARY — gate',
      property: lp, driver_name: 'Gate', driver_license: 'N/A', is_confirmed: true,
    }]).select('id')
    if (seed.error) {
      chk('a citation can still be written at an ACTIVE property (the control)', false,
        `🔴 ${seed.error.message.slice(0, 100)} — the guard would break live enforcement`)
    } else {
      const vid = seed.data![0].id as number
      made.push(vid)
      chk('a citation can still be written at an ACTIVE property (the control)', true, `violation ${vid}`)
      // deactivate, then attempt the tow
      await db.from('properties').update({ is_active: false }).eq('name', lp)
      const tow = await db.from('violations').update({ tow_ticket_generated: true }).eq('id', vid).select('id')
      await db.from('properties').update({ is_active: true }).eq('name', lp)
      const back = await db.from('properties').select('is_active').eq('name', lp).maybeSingle()
      chk('🔴 the TOW is refused once the property is deactivated',
        !!tow.error, tow.error ? `refused: ${tow.error.code} ${tow.error.message.slice(0, 80)}` : '🔴 STAMPED')
      chk(`   ↩ ${lp} restored to active, read back`, back.data?.is_active === true, `is_active=${back.data?.is_active}`)
      // and the corrective path still works
      const res = await db.from('violations').update({ status: 'resolved' }).eq('id', vid).select('id')
      chk('   ...while resolve still works on it — a deactivation must not strand a ticket',
        !res.error, res.error ? `🔴 ${res.error.message.slice(0, 80)}` : 'resolved')
    }
  } catch (e) {
    console.log(`🔴 ${(e as Error).message}`)
    fails++
  } finally {
    console.log('')
    await cleanup()
  }

  // ── 4. the read layer ─────────────────────────────────────────────
  console.log('\n── 4. the [All] fallback is gone from the client ──')
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
  const drvSrc = strip(fs.readFileSync('app/driver/page.tsx', 'utf8'))
  chk("🔴 assigned_properties never defaults to ['All']",
    !/assigned_properties:\s*\['All'\]/.test(drvSrc),
    "a missing drivers row yields an empty list, which is what the server already says")
  chk('   ...and the violations query is ALWAYS property-filtered',
    !/if\s*\(!properties\.includes\('All'\)\)/.test(drvSrc),
    'the skip-the-filter branch is gone; an empty assignment yields an empty result')

  console.log(fails === 0 ? '\n✅ all green\n' : `\n❌ ${fails} failed\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup(); process.exit(2) })

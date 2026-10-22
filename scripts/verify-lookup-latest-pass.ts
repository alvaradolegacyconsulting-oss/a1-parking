// ════════════════════════════════════════════════════════════════════
// GATE — every authorization lookup picks the pass that expires LATEST
// ════════════════════════════════════════════════════════════════════
//
// 🔴 WHY TWO LIVE PASSES IS THE NORMAL CASE NOW. Until 2026-10-17 a
// renewal returned the existing row, so a plate had one live pass. The
// renewal fix creates a NEW row while the previous one is still
// unexpired — so every renewing guest holds two live passes for a
// while, and any lookup that assumed one row started meeting two.
//
// The CA plate lookup used .single() with no ordering. Two live passes
// made it error PGRST116, the error was discarded, and the page
// rendered 'notfound' — a covered guest shown as uncovered, which is
// the Oct 17 harm in a different surface.
//
// 🔴 EXECUTED, NOT GREPPED. Each path is run against two real live
// passes with different expiries and must name the later one. The
// source-text half only covers what cannot be executed from here.
//
// Probes: two passes on an existing demo property, removed and read
// back. No role rows are touched and no property is created.
//
// Usage: npx tsx --env-file=.env.local scripts/verify-lookup-latest-pass.ts

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import { sessionAs } from './lib/smoke-auth'

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } })

const PROPERTY = 'Northgate Commerce Center'   // demo tenant, no visitor_pass_limit
const MANAGER = 'demo-manager@test.shieldmylot.com'
const PLATE = 'ZZLOOK77'
const UNIT = '7777'
const made: number[] = []

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

async function cleanup() {
  if (made.length) await db.from('visitor_passes').delete().in('id', made)
  const { data } = await db.from('visitor_passes').select('id').ilike('plate', PLATE)
  chk('probe passes removed, read back', (data ?? []).length === 0, `${(data ?? []).length} remaining`)
}

async function main() {
  console.log('\n══ authorization lookups pick the latest-expiring pass ══\n')
  let earlier = '', later = ''
  try {
    // Two LIVE passes, 2h apart — exactly what a renewal leaves behind.
    for (const [h, label] of [[2, 'earlier'], [6, 'later']] as [number, string][]) {
      const exp = new Date(Date.now() + h * 3600_000).toISOString()
      const r = await db.from('visitor_passes').insert({
        plate: PLATE, visitor_name: label, visiting_unit: UNIT, property: PROPERTY,
        duration_hours: h, created_at: new Date().toISOString(), expires_at: exp, is_active: true,
      }).select('id,expires_at').single()
      if (r.error) throw new Error(`seed ${label}: ${r.error.message}`)
      made.push(r.data.id as number)
      if (label === 'earlier') earlier = String(r.data.expires_at); else later = String(r.data.expires_at)
    }
    console.log(`two live passes for ${PLATE} @ ${PROPERTY}`)
    console.log(`  earlier expires ${hhmm(earlier)}   later expires ${hhmm(later)}\n`)

    const now = new Date().toISOString()

    // ── 1. driver plate lookup (branchLivePass) ──────────────────────
    const drv = await db.from('visitor_passes').select('plate,created_at,expires_at')
      .ilike('plate', PLATE).ilike('property', PROPERTY)
      .eq('is_active', true).gt('expires_at', now)
      .order('expires_at', { ascending: false }).limit(1).maybeSingle()
    chk('driver plate lookup names the LATER pass',
      !drv.error && drv.data != null && new Date(String(drv.data.expires_at)).getTime() === new Date(later).getTime(),
      drv.error ? `🔴 ${drv.error.code}: ${drv.error.message.slice(0, 70)}` : `picked ${hhmm(String(drv.data?.expires_at))}`)

    // ── 2. CA plate lookup — the one that was broken ─────────────────
    const ca = await db.from('visitor_passes').select('*')
      .ilike('plate', PLATE).eq('is_active', true).gte('expires_at', now)
      .in('property', [PROPERTY])
      .order('expires_at', { ascending: false }).limit(1).maybeSingle()
    chk('🔴 CA plate lookup names the LATER pass, and does not error',
      !ca.error && ca.data != null && new Date(String(ca.data.expires_at)).getTime() === new Date(later).getTime(),
      ca.error ? `🔴 ${ca.error.code}: ${ca.error.message.slice(0, 80)}` : `picked ${hhmm(String(ca.data?.expires_at))}`)

    // ── 3. pm_plate_lookup, as a real manager ───────────────────────
    const s = await sessionAs(MANAGER, { targetEnv: 'demo' })
    const pm = await s.client.rpc('pm_plate_lookup', { p_plate: PLATE, p_viewing_property: PROPERTY })
    const out = (pm.data ?? {}) as Record<string, unknown>
    chk('pm_plate_lookup resolves the plate as a visitor, with two live passes present',
      !pm.error && out.result_type === 'visitor',
      pm.error ? `🔴 ${pm.error.message.slice(0, 80)}` : `result_type=${out.result_type} unit=${JSON.stringify(out.unit_number)}`)

    // ── 4. the recently-expired branch tolerates repeats ────────────
    // 🔴 vehicles_plate_norm_uniq is scoped to status IN (active,
    // under_review), so INACTIVE rows repeat freely — measured 5 plates
    // with multiple declined rows at A1, one with six. This asserts the
    // shape that reads them cannot error on a repeat.
    const vehShape = await db.from('vehicles').select('id,plate,status')
      .eq('is_active', false).neq('status', 'deactivated')
      .order('id', { ascending: false }).limit(1).maybeSingle()
    chk('the inactive-vehicle read is ordered + limited, so repeats cannot error it',
      !vehShape.error, vehShape.error ? `🔴 ${vehShape.error.code}` : 'one row, newest first')
  } catch (e) {
    console.log(`🔴 ${(e as Error).message}`)
    fails++
  } finally {
    console.log('')
    await cleanup()
  }

  // ── the source-text half ──────────────────────────────────────────
  console.log('\n── no unordered single-row read on an authorization table ──')
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
  const TABLES = ['visitor_passes', 'guest_authorizations']
  const offenders: string[] = []
  const files = ['app/driver/page.tsx', 'app/company_admin/page.tsx', 'app/manager/page.tsx', 'app/resident/page.tsx']
  for (const f of files) {
    const lines = strip(fs.readFileSync(f, 'utf8')).split('\n')
    lines.forEach((l, i) => {
      for (const t of TABLES) {
        if (!l.includes(`from('${t}')`)) continue
        const block = lines.slice(i, i + 10).join('\n')
        const single = /\.single\(\)|\.maybeSingle\(\)/.test(block)
        const ordered = /\.order\(/.test(block) && /\.limit\(/.test(block)
        if (single && !ordered) offenders.push(`${f}:${i + 1} (${t})`)
      }
    })
  }
  chk('🔴 every single-row read of visitor_passes / guest_authorizations is ordered and limited',
    offenders.length === 0,
    offenders.length === 0
      ? `${files.length} portal files checked`
      : `🔴 ${offenders.join(', ')} — a second live row makes these error, and the error reads as "not found"`)

  console.log(fails === 0 ? '\n✅ all green\n' : `\n❌ ${fails} failed\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup(); process.exit(2) })

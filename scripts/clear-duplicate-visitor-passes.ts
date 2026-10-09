// ════════════════════════════════════════════════════════════════════
// Clear duplicate visitor passes from submit bursts
// ════════════════════════════════════════════════════════════════════
//
// 22 bursts, 27 extra rows, 4 properties, back to 2026-08-09. Two
// causes: no in-flight guard on the resident button (sub-2s bursts) and
// no confirmation that made people re-submit (20-109s bursts). Both are
// fixed by 20261009_issue_visitor_pass_dedup.sql plus the button guard;
// this removes what they already produced.
//
// 🔴 is_active = false, not a delete. visitor_passes has no
// deactivation_reason column and revocation is already recorded by
// flipping this flag (the only 3 false rows in the table were revoked
// by hand). The kept pass is named in an audit row instead.
//
// 🔴 KEEP THE LOWEST ID, not the earliest created_at. created_at was
// supplied by the browser clock on the resident path until 2026-10-09,
// which is why ids 2203/2205/2204/2206 are out of chronological order.
// The id is the only ordering the database assigned.
//
// 🔴 ONLY ROWS THAT ARE STILL FLAGGED ACTIVE. An expired pass is
// already spent; flipping its flag changes nothing a human can see and
// would churn history. But an expired duplicate still counts against
// the rolling-30 limit — which the limit trigger counts regardless of
// is_active, deliberately — so the before/after report below covers the
// count, not just the flag.
//
// Usage: npx tsx scripts/clear-duplicate-visitor-passes.ts [--apply]

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import { normalizePlate, normalizeUnit } from '../app/lib/plate'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const db = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const APPLY = process.argv.includes('--apply')
const ACTOR = 'clear-duplicate-visitor-passes script'
const BURST_WINDOW_SEC = 60

const key = (s: unknown) => (s ?? '').toString().trim().toLowerCase()
type Pass = { id: number; plate: string; visitor_name: string | null; visiting_unit: string | null; property: string; duration_hours: number | null; created_at: string; expires_at: string; is_active: boolean }

async function all<T>(t: string, c: string): Promise<T[]> {
  const out: unknown[] = []
  let from = 0
  for (;;) {
    const { data, error } = await db.from(t).select(c).range(from, from + 999)
    if (error) throw new Error(`${t}: ${error.message}`)
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
    from += 1000
  }
  return out as T[]
}

/** Per-plate rolling-30 counts at properties that actually set a limit. */
async function rollingReport(label: string, plates: Set<string>) {
  const props = (await all<{ name: string; visitor_pass_limit: number | null }>('properties', 'name, visitor_pass_limit'))
    .filter(p => p.visitor_pass_limit != null)
  const vp = await all<Pass>('visitor_passes', 'id, plate, visiting_unit, property, created_at')
  const cutoff = Date.now() - 30 * 864e5
  console.log(`\n${label} — rolling-30 counts at limited properties:`)
  let shown = 0
  for (const p of props) {
    const rows = vp.filter(r => key(r.property) === key(p.name) && new Date(r.created_at).getTime() > cutoff)
    const byPlate = new Map<string, Pass[]>()
    for (const r of rows) {
      const kk = normalizePlate(r.plate)
      byPlate.set(kk, [...(byPlate.get(kk) ?? []), r])
    }
    for (const [plate, rs] of byPlate) {
      if (!plates.has(plate)) continue
      shown++
      console.log(`   ${p.name} (limit ${p.visitor_pass_limit}) — ${plate}: ${rs.length}/${p.visitor_pass_limit}`)
    }
  }
  if (!shown) console.log('   (none of the affected plates fall in a limited property\'s 30-day window)')
}

const main = async () => {
  console.log(APPLY ? '── APPLYING ──' : '── DRY RUN (pass --apply to write) ──')

  const vp = await all<Pass>('visitor_passes', 'id, plate, visitor_name, visiting_unit, property, duration_hours, created_at, expires_at, is_active')

  // ── Find bursts: same (property, plate, unit), <=60s apart ──
  const byKey = new Map<string, Pass[]>()
  for (const r of vp) {
    const kk = `${key(r.property)}||${normalizePlate(r.plate)}||${normalizeUnit(r.visiting_unit)}`
    byKey.set(kk, [...(byKey.get(kk) ?? []), r])
  }
  type Burst = { keep: Pass; drop: Pass[] }
  const bursts: Burst[] = []
  for (const [, rows] of byKey) {
    const byTime = [...rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    let group: Pass[] = [byTime[0]]
    const flush = () => {
      if (group.length < 2) return
      // lowest id wins — see header
      const ordered = [...group].sort((a, b) => a.id - b.id)
      bursts.push({ keep: ordered[0], drop: ordered.slice(1) })
    }
    for (let i = 1; i < byTime.length; i++) {
      const gap = (new Date(byTime[i].created_at).getTime() - new Date(group[group.length - 1].created_at).getTime()) / 1000
      if (gap <= BURST_WINDOW_SEC) group.push(byTime[i])
      else { flush(); group = [byTime[i]] }
    }
    flush()
  }

  const allDrop = bursts.flatMap(b => b.drop)
  const stillFlagged = allDrop.filter(r => r.is_active === true)
  const alreadyFalse = allDrop.filter(r => r.is_active !== true)
  const affectedPlates = new Set(allDrop.map(r => normalizePlate(r.plate)))

  console.log(`\nbursts: ${bursts.length}   duplicate rows: ${allDrop.length}   (of ${vp.length} passes)`)
  if (alreadyFalse.length) console.log(`  ${alreadyFalse.length} already is_active=false — skipping: ${alreadyFalse.map(r => r.id).join(', ')}`)

  console.log(`\n═══ WILL FLIP is_active = false — ${stillFlagged.length} rows ═══`)
  for (const b of bursts.sort((a, b2) => b2.keep.id - a.keep.id)) {
    const drops = b.drop.filter(r => r.is_active === true)
    if (!drops.length) continue
    const live = new Date(b.keep.expires_at).getTime() > Date.now()
    console.log(`  ${b.keep.created_at.slice(0, 19)}  ${b.keep.plate} u:${b.keep.visiting_unit} @ ${b.keep.property}`)
    console.log(`     keep  ${String(b.keep.id).padStart(5)}  (expires ${b.keep.expires_at.slice(0, 19)}${live ? ' — STILL LIVE' : ' — expired'})`)
    for (const d of drops) console.log(`     drop  ${String(d.id).padStart(5)}  created ${d.created_at.slice(0, 19)}`)
  }

  await rollingReport('BEFORE', affectedPlates)

  if (!APPLY) { console.log('\nDry run — nothing written.'); return }
  if (!stillFlagged.length) { console.log('\nNothing to flip.'); return }

  const beforeFlagged = (await db.from('visitor_passes').select('*', { count: 'exact', head: true }).eq('is_active', true)).count

  // One row at a time so the audit names the kept pass per row, and so
  // a row someone revoked between read and write is skipped alone.
  const done: { id: number; keep: number }[] = []
  const skipped: { id: number; why: string }[] = []
  for (const b of bursts) {
    for (const d of b.drop.filter(r => r.is_active === true)) {
      const { data, error } = await db.from('visitor_passes')
        .update({ is_active: false })
        .eq('id', d.id)
        .eq('is_active', true)
        .select('id')
      if (error) { console.error(`\nUPDATE failed on ${d.id}:`, error.message); process.exit(2) }
      if (!data?.length) { skipped.push({ id: d.id, why: 'already is_active=false at write time' }); continue }
      done.push({ id: d.id, keep: b.keep.id })
    }
  }

  console.log(`\nflipped: ${done.length} of ${stillFlagged.length}`)
  for (const d of done) console.log(`   ${String(d.id).padStart(5)} -> is_active=false (duplicate of pass #${d.keep})`)
  for (const sk of skipped) console.log(`   ⚠️  ${sk.id} SKIPPED — ${sk.why}`)

  const { error: aErr } = await db.from('audit_logs').insert({
    user_email: ACTOR,
    action: 'DUPLICATE_VISITOR_PASSES_CLEARED',
    table_name: 'visitor_passes',
    record_id: null,
    old_values: { is_active: true, ids: done.map(d => d.id) },
    new_values: {
      cleared: done.map(d => ({ pass_id: d.id, duplicate_of: d.keep })),
      skipped,
      bursts: bursts.length,
      rule: `same (property, normalized plate, normalized unit) within ${BURST_WINDOW_SEC}s; lowest id kept`,
    },
    notes: 'Submit bursts on both pass surfaces: no in-flight guard on the resident button (sub-2s) and no confirmation that made visitors re-submit (20-109s). Rows flipped to is_active=false rather than deleted — visitor_passes has no reason column and revocation is already recorded by this flag. Lowest id kept because created_at came from the browser clock on the resident path until 2026-10-09. Duplicates still count toward enforce_visitor_pass_limit, which counts every row in 30 days regardless of is_active by design, so the flag does not restore the allowance.',
  })
  if (aErr) { console.error('audit insert failed:', aErr.message); process.exit(2) }
  console.log('audit row written (DUPLICATE_VISITOR_PASSES_CLEARED)')

  const afterFlagged = (await db.from('visitor_passes').select('*', { count: 'exact', head: true }).eq('is_active', true)).count
  console.log(`\nis_active=true: ${beforeFlagged} -> ${afterFlagged} (${(beforeFlagged ?? 0) - (afterFlagged ?? 0)} fewer)`)

  await rollingReport('AFTER', affectedPlates)
  console.log('\n🔴 The rolling-30 counts are UNCHANGED on purpose: enforce_visitor_pass_limit')
  console.log('   counts every row created in 30 days regardless of is_active ("Do NOT re-add')
  console.log('   is_active = TRUE — that reopens issue-revoke-reissue"). Flipping the flag')
  console.log('   does NOT hand the allowance back. If a resident should get those slots')
  console.log('   returned, that is a deliberate decision and needs a different mechanism.')
}
main().catch(e => { console.error('FATAL', e.message); process.exit(2) })

// ════════════════════════════════════════════════════════════════════
// Clear duplicate PENDING vehicle submissions
// ════════════════════════════════════════════════════════════════════
//
// WHY THESE ROWS EXIST. request_my_vehicle inserted a new pending row
// every time a resident submitted, with no duplicate check. Residents
// who saw no confirmation re-submitted. The rows sat harmless until a
// manager clicked Approve, at which point vehicles_plate_norm_uniq
// raised 23505, PostgREST returned 409, and the button hung on
// "Approving…" forever (A1 live, 2026-10-07).
//
// 🔴 DEACTIVATED, NOT DECLINED. The resident portal fetches
//     is_active = true OR status = 'declined'
// so a declined row shows the resident a red rejection card for
// something they did nothing wrong in. status='deactivated' matches
// neither clause: the duplicate leaves their list quietly, the original
// active plate stays, and the PM still sees it in the CRM restore
// panel. Reason 'registered_in_error' — labelled "Registered in error /
// duplicate", already notifies:false.
//
// 🔴 SILENT BY CONSTRUCTION, not by suppression. declineVehicleWrite
// has never called notifyResidentDecision, so no vehicle decision has
// ever emailed a resident. Nothing is being turned off here.
//
// 🔴 WHAT IT REFUSES TO TOUCH. A pending row whose colliding active
// plate belongs to a DIFFERENT resident is a real dispute — two people
// claiming one plate, or a plate that moved households. Those are left
// for A1's office and printed as such. At the time of writing that is
// 1024, 1082 and 1510.
//
// Usage: npx tsx scripts/clear-duplicate-pending-vehicles.ts [--apply]
//        default is a DRY RUN that prints the exact rows.

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import { normalizePlate, normalizeUnit } from '../app/lib/plate'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const db = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const APPLY = process.argv.includes('--apply')
const REASON = 'registered_in_error'
const ACTOR = 'clear-duplicate-pending-vehicles script'

// Explicitly named so a re-run after A1's office resolves them cannot
// sweep them up by accident.
const LEAVE_FOR_OFFICE = new Set([1024, 1082, 1510])

// 🔴 THE REVIEWED SET. Jose read these 20 rows on 2026-10-07 and
// approved exactly these.
//
// The rule is recomputed at apply time against live data — residents
// keep submitting — but nothing outside this list is ever written. A
// row that newly matches the rule is REPORTED and left alone, because
// "the script decided it qualified" is not the same as "a person looked
// at it", and this is a destructive write on a live customer's data.
//
// To clear a newly-found duplicate, review it and add its id here.
const REVIEWED: ReadonlyMap<number, number> = new Map([
  // pending id -> the id whose plate is being kept
  [796, 855], [831, 816], [953, 952], [959, 929], [1068, 1140],
  [1069, 1089], [1087, 1086], [1094, 1106], [1103, 1106], [1131, 1107],
  [1141, 1067], [1221, 1222], [1224, 1222], [1349, 1350], [1355, 1325],
  [1426, 1417],
  // pending-vs-pending, keeping the oldest
  [1526, 1503], [1527, 1524], [1534, 1533], [1535, 1400],
])

const key = (s: unknown) => (s ?? '').toString().trim().toLowerCase()

async function all(t: string, c: string) {
  const out: Record<string, unknown>[] = []
  let from = 0
  for (;;) {
    const { data, error } = await db.from(t).select(c).range(from, from + 999)
    if (error) throw new Error(`${t}: ${error.message}`)
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
    from += 1000
  }
  return out as any[]
}

const main = async () => {
  console.log(APPLY ? '── APPLYING ──\n' : '── DRY RUN (pass --apply to write) ──\n')

  const vehs = await all('vehicles', 'id, plate, property, unit, resident_email, status, is_active, created_at')
  const props = await all('properties', 'name, company')
  const coOf = new Map(props.map(p => [key(p.name), p.company as string]))

  const active = vehs.filter(v => v.status === 'active' && v.is_active === true)
  const pending = vehs.filter(v => v.status === 'pending')

  const activeBy = new Map<string, any[]>()
  for (const v of active) {
    const k = `${key(v.property)}||${normalizePlate(v.plate)}`
    activeBy.set(k, [...(activeBy.get(k) ?? []), v])
  }

  type Item = { row: any; against: any; why: string; co: string }
  const clear: Item[] = []
  const office: Item[] = []

  // ── Pending colliding with an ACTIVE plate ──
  for (const p of pending) {
    const hits = activeBy.get(`${key(p.property)}||${normalizePlate(p.plate)}`) ?? []
    if (!hits.length) continue
    const a = hits[0]
    const co = coOf.get(key(p.property)) ?? '(unknown company)'
    const sameResident = key(a.resident_email) === key(p.resident_email)
    // 🔴 Format-insensitive. "Traila# 191" vs "Traila #191" is one unit.
    const sameUnit = normalizeUnit(a.unit) === normalizeUnit(p.unit)
    if (sameResident && sameUnit) clear.push({ row: p, against: a, why: 'duplicate of own active plate', co })
    else office.push({ row: p, against: a, why: sameResident ? 'same resident, DIFFERENT unit' : 'DIFFERENT resident', co })
  }

  // ── Pending vs pending: keep the oldest, clear the rest ──
  // Not yet colliding, but the second row 23505s the moment the first
  // is approved — the same hang, one click later.
  const pendBy = new Map<string, any[]>()
  for (const v of pending) {
    const k = `${key(v.property)}||${normalizePlate(v.plate)}`
    pendBy.set(k, [...(pendBy.get(k) ?? []), v])
  }
  const alreadyClearing = new Set(clear.map(c => c.row.id))
  for (const [, group] of [...pendBy.entries()].filter(([, a]) => a.length > 1)) {
    const uniform = group.every(x =>
      key(x.resident_email) === key(group[0].resident_email) &&
      normalizeUnit(x.unit) === normalizeUnit(group[0].unit))
    if (!uniform) {
      for (const x of group) if (!alreadyClearing.has(x.id))
        office.push({ row: x, against: group[0], why: 'pending-vs-pending with MIXED residents/units', co: coOf.get(key(x.property)) ?? '?' })
      continue
    }
    const sorted = [...group].sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)) || x.id - y.id)
    for (const x of sorted.slice(1)) {
      if (alreadyClearing.has(x.id)) continue
      clear.push({ row: x, against: sorted[0], why: `duplicate pending (keeping ${sorted[0].id})`, co: coOf.get(key(x.property)) ?? '?' })
    }
  }

  // ── Honour the hold-outs ──
  const held = clear.filter(c => LEAVE_FOR_OFFICE.has(Number(c.row.id)))
  const toClear = clear.filter(c => !LEAVE_FOR_OFFICE.has(Number(c.row.id)))
  if (held.length) {
    console.log(`⚠️  ${held.length} row(s) matched the clear rule but are on the hold-out list — skipping: ${held.map(h => h.row.id).join(', ')}\n`)
  }

  // ── Reviewed vs newly found ───────────────────────────────────────
  const reviewed = toClear.filter(c => REVIEWED.has(Number(c.row.id)))
  const unreviewed = toClear.filter(c => !REVIEWED.has(Number(c.row.id)))
  const missing = [...REVIEWED.keys()].filter(id => !toClear.some(c => Number(c.row.id) === id))

  // 🔴 A reviewed id that no longer matches the rule is NOT silently
  // dropped. It means the row was approved, declined or edited since
  // the review — which is information, not noise.
  if (missing.length) {
    console.log(`⚠️  ${missing.length} reviewed id(s) no longer match the duplicate rule — NOT written: ${missing.join(', ')}`)
    for (const id of missing) {
      const row = vehs.find(v => Number(v.id) === id)
      console.log(`     ${id}: ${row ? `status=${row.status} is_active=${row.is_active}` : 'row is gone'}`)
    }
    console.log('')
  }

  if (unreviewed.length) {
    console.log(`⚠️  ${unreviewed.length} NEW duplicate(s) found since the review — REPORTED, NOT CLEARED:`)
    for (const c of unreviewed.sort((a, b) => a.row.id - b.row.id)) {
      console.log(`     ${c.row.id} ${c.row.plate} @ ${c.row.property} u:${JSON.stringify(c.row.unit)} <${c.row.resident_email}>`)
      console.log(`        └─ ${c.why} (would keep ${c.against.id}). Review it and add [${c.row.id}, ${c.against.id}] to REVIEWED.`)
    }
    console.log('')
  }

  console.log(`═══ WILL CLEAR — ${reviewed.length} reviewed rows ═══`)
  console.log(`  ${'id'.padStart(5)}  ${'plate'.padEnd(10)} ${'property'.padEnd(24)} ${'unit'.padEnd(16)} resident / why`)
  for (const c of reviewed.sort((a, b) => a.row.id - b.row.id)) {
    console.log(`  ${String(c.row.id).padStart(5)}  ${String(c.row.plate).padEnd(10)} ${String(c.row.property).padEnd(24)} ${String(c.row.unit ?? '').padEnd(16)} ${c.row.resident_email}`)
    console.log(`         └─ ${c.why} (keeping ${c.against.id}, unit ${JSON.stringify(c.against.unit)})`)
  }

  console.log(`\n═══ LEFT ALONE — ${office.length} rows (A1's office) ═══`)
  for (const o of office.sort((a, b) => a.row.id - b.row.id)) {
    console.log(`  🔴 ${o.row.id} ${o.row.plate} @ ${o.row.property} u:${JSON.stringify(o.row.unit)} <${o.row.resident_email}>`)
    console.log(`         └─ ${o.why}; collides with ${o.against.id} u:${JSON.stringify(o.against.unit)} <${o.against.resident_email}>`)
  }

  const byCo = new Map<string, number>()
  for (const c of reviewed) byCo.set(c.co, (byCo.get(c.co) ?? 0) + 1)
  console.log(`\nby company: ${[...byCo.entries()].map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`)

  if (!APPLY) { console.log('\nDry run — nothing written.'); return }
  if (!reviewed.length) { console.log('\nNothing reviewed left to clear.'); return }

  // ── Before counts ─────────────────────────────────────────────────
  const countPending = async () => (await db.from('vehicles').select('*', { count: 'exact', head: true }).eq('status', 'pending')).count
  const countDeact = async () => (await db.from('vehicles').select('*', { count: 'exact', head: true }).eq('status', 'deactivated')).count
  const beforePending = await countPending()
  const beforeDeact = await countDeact()
  console.log(`\nBEFORE — pending: ${beforePending}   deactivated: ${beforeDeact}`)

  // ── Write, ONE ROW AT A TIME ──────────────────────────────────────
  // 🔴 Not a bulk .in() update: the note has to name the specific row
  // being kept ("duplicate of #855"), and a single UPDATE cannot write
  // 20 different notes. A per-row write also means a row that stopped
  // being pending between the read and the write is skipped
  // individually instead of silently narrowing a bulk result.
  //
  // `.eq('status','pending')` is re-asserted on every row so a vehicle
  // approved in the meantime is never clobbered.
  const ids = reviewed.map(c => Number(c.row.id))
  const done: { id: number; plate: string; note: string }[] = []
  const skipped: { id: number; why: string }[] = []
  const stamp = new Date().toISOString()
  for (const c of reviewed.sort((a, b) => a.row.id - b.row.id)) {
    const keptId = REVIEWED.get(Number(c.row.id))
    if (keptId !== Number(c.against.id)) {
      // The reviewed pairing no longer describes reality. Refuse rather
      // than write a note that names the wrong row.
      skipped.push({ id: Number(c.row.id), why: `reviewed as duplicate of #${keptId} but now collides with #${c.against.id}` })
      continue
    }
    const note = `duplicate of #${keptId}`
    const { data, error } = await db.from('vehicles')
      .update({
        is_active: false,
        status: 'deactivated',
        deactivation_reason: REASON,
        deactivation_note: note,
        deactivated_by: ACTOR,
        deactivated_at: stamp,
      })
      .eq('id', c.row.id)
      .eq('status', 'pending')
      .select('id, plate, status, deactivation_reason, deactivation_note, deactivated_by')
    if (error) { console.error(`\nUPDATE failed on ${c.row.id}:`, error.message); process.exit(2) }
    if (!data?.length) { skipped.push({ id: Number(c.row.id), why: 'no longer pending at write time' }); continue }
    done.push({ id: data[0].id as number, plate: data[0].plate as string, note: data[0].deactivation_note as string })
  }

  console.log(`\ncleared: ${done.length} of ${ids.length} reviewed`)
  for (const d of done) console.log(`   ${String(d.id).padStart(5)} ${String(d.plate).padEnd(10)} -> deactivated / ${REASON} / "${d.note}"`)
  const missed = skipped.map(x => x.id)
  for (const sk of skipped) console.log(`   ⚠️  ${sk.id} SKIPPED — ${sk.why}`)

  const { error: aErr } = await db.from('audit_logs').insert({
    user_email: ACTOR,
    action: 'DUPLICATE_PENDING_VEHICLES_CLEARED',
    table_name: 'vehicles',
    record_id: null,
    old_values: { status: 'pending', requested_ids: ids },
    new_values: {
      cleared: done,
      not_updated: skipped,
      newly_found_not_cleared: unreviewed.map(c => ({ id: c.row.id, plate: c.row.plate, would_keep: c.against.id })),
      reason: REASON,
      left_for_office: [...LEAVE_FOR_OFFICE],
    },
    notes: 'Residents re-submitted plates because request_my_vehicle had no duplicate check and the portal gave no confirmation. Approving one raised 23505 on vehicles_plate_norm_uniq and hung the manager button. Cleared as deactivated (not declined) so the resident is not shown a rejection for a duplicate; originals left active. Cross-resident collisions deliberately untouched.',
  })
  if (aErr) { console.error('audit insert failed:', aErr.message); process.exit(2) }
  console.log('audit row written (DUPLICATE_PENDING_VEHICLES_CLEARED)')

  const afterPending = await countPending()
  const afterDeact = await countDeact()
  console.log(`\nAFTER  — pending: ${afterPending} (${(beforePending ?? 0) - (afterPending ?? 0)} fewer)   deactivated: ${afterDeact} (${(afterDeact ?? 0) - (beforeDeact ?? 0)} more)`)
  if ((beforePending ?? 0) - (afterPending ?? 0) !== done.length) {
    console.log(`   ⚠️  pending fell by ${(beforePending ?? 0) - (afterPending ?? 0)} but ${done.length} rows were cleared — someone else wrote during the sweep.`)
  }

  // ── Verify: no pending row still collides with an active plate ──
  const after = await all('vehicles', 'id, plate, property, unit, resident_email, status, is_active')
  const aBy = new Map<string, any[]>()
  for (const v of after.filter(v => v.status === 'active' && v.is_active === true)) {
    const k = `${key(v.property)}||${normalizePlate(v.plate)}`
    aBy.set(k, [...(aBy.get(k) ?? []), v])
  }
  const left = after.filter(v => v.status === 'pending')
    .filter(p => (aBy.get(`${key(p.property)}||${normalizePlate(p.plate)}`) ?? []).length > 0)
  console.log(`\nAFTER — pending rows still colliding with an active plate: ${left.length} (expect ${office.filter(o => o.row.status === 'pending' && o.why !== 'pending-vs-pending with MIXED residents/units').length}, the office hold-outs)`)
  for (const l of left) console.log(`   ${l.id} ${l.plate} <${l.resident_email}>`)
}
main().catch(e => { console.error('FATAL', e.message); process.exit(2) })

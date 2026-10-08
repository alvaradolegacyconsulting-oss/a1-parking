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
const ACTOR = 'system_duplicate_cleanup'
// Explicitly named so a re-run after A1's office resolves them cannot
// sweep them up by accident.
const LEAVE_FOR_OFFICE = new Set([1024, 1082, 1510])

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

  console.log(`═══ WILL CLEAR — ${toClear.length} rows ═══`)
  console.log(`  ${'id'.padStart(5)}  ${'plate'.padEnd(10)} ${'property'.padEnd(24)} ${'unit'.padEnd(16)} resident / why`)
  for (const c of toClear.sort((a, b) => a.row.id - b.row.id)) {
    console.log(`  ${String(c.row.id).padStart(5)}  ${String(c.row.plate).padEnd(10)} ${String(c.row.property).padEnd(24)} ${String(c.row.unit ?? '').padEnd(16)} ${c.row.resident_email}`)
    console.log(`         └─ ${c.why} (active/kept ${c.against.id}, unit ${JSON.stringify(c.against.unit)})`)
  }

  console.log(`\n═══ LEFT ALONE — ${office.length} rows (A1's office) ═══`)
  for (const o of office.sort((a, b) => a.row.id - b.row.id)) {
    console.log(`  🔴 ${o.row.id} ${o.row.plate} @ ${o.row.property} u:${JSON.stringify(o.row.unit)} <${o.row.resident_email}>`)
    console.log(`         └─ ${o.why}; collides with ${o.against.id} u:${JSON.stringify(o.against.unit)} <${o.against.resident_email}>`)
  }

  const byCo = new Map<string, number>()
  for (const c of toClear) byCo.set(c.co, (byCo.get(c.co) ?? 0) + 1)
  console.log(`\nby company: ${[...byCo.entries()].map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`)

  if (!APPLY) { console.log('\nDry run — nothing written.'); return }
  if (!toClear.length) { console.log('\nNothing to clear.'); return }

  // ── Write. Re-assert status='pending' so a row approved between the
  // read and the write is never clobbered. ──
  const ids = toClear.map(c => Number(c.row.id))
  const { data: updated, error } = await db.from('vehicles')
    .update({
      is_active: false,
      status: 'deactivated',
      deactivation_reason: REASON,
      deactivation_note: 'Duplicate submission cleared in the 2026-10-07 sweep; the resident\'s original plate remains active.',
      deactivated_by: ACTOR,
      deactivated_at: new Date().toISOString(),
    })
    .in('id', ids)
    .eq('status', 'pending')
    .select('id, plate, property, unit, status, deactivation_reason')
  if (error) { console.error('\nUPDATE failed:', error.message); process.exit(2) }

  console.log(`\ncleared: ${updated?.length ?? 0} of ${ids.length} requested`)
  for (const u of updated ?? []) console.log(`   ${u.id} ${u.plate} -> ${u.status}/${u.deactivation_reason}`)
  const missed = ids.filter(i => !(updated ?? []).some(u => u.id === i))
  if (missed.length) console.log(`   ⚠️  not updated (no longer pending — approved or changed since the read): ${missed.join(', ')}`)

  const { error: aErr } = await db.from('audit_logs').insert({
    user_email: ACTOR,
    action: 'DUPLICATE_PENDING_VEHICLES_CLEARED',
    table_name: 'vehicles',
    record_id: null,
    old_values: { status: 'pending', requested_ids: ids },
    new_values: {
      cleared: (updated ?? []).map(u => ({ id: u.id, plate: u.plate, property: u.property, unit: u.unit })),
      not_updated: missed,
      reason: REASON,
      left_for_office: [...LEAVE_FOR_OFFICE],
    },
    notes: 'Residents re-submitted plates because request_my_vehicle had no duplicate check and the portal gave no confirmation. Approving one raised 23505 on vehicles_plate_norm_uniq and hung the manager button. Cleared as deactivated (not declined) so the resident is not shown a rejection for a duplicate; originals left active. Cross-resident collisions deliberately untouched.',
  })
  if (aErr) { console.error('audit insert failed:', aErr.message); process.exit(2) }
  console.log('audit row written (DUPLICATE_PENDING_VEHICLES_CLEARED)')

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

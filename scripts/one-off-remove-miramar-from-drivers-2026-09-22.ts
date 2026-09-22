// ════════════════════════════════════════════════════════════════════
// ONE-OFF — remove "Miramar Apartments" from two A1 drivers (2026-09-22)
// ════════════════════════════════════════════════════════════════════
//
// WHY: Miramar Apartments is is_active=false but still sits in the
// assigned_properties of two ACTIVE A1 drivers, so the portal lists it,
// they can select it, and enforcement fires against it. Miramar has 0
// residents and 0 vehicles, so every plate scanned there returns "no
// authorized vehicle" → tow-eligible, for lack of data rather than lack
// of authorization.
//
// This is NOT a workaround. It applies by hand the end-state
// deactivate-property-guard should have produced: it warns that N
// drivers are assigned and then never removes the name. The queued P1
// (driver portal never validates assigned_properties) makes it
// automatic; this closes the live exposure tonight.
//
// 🔴 DISCIPLINE
//  • Two hardcoded emails. alexsandra.hidalgo is DELIBERATELY excluded —
//    inactive driver, no session, no exposure, and touching it adds risk
//    for nothing.
//  • Per-driver FRESH read immediately before the write. No array is
//    carried from an earlier query.
//  • Refuses to write unless the removal changes exactly ONE element.
//  • Re-reads after the write and asserts every other element survived
//    in the same ORDER and the same SPELLING — not just the same count.
//    A count check passes if one name silently became another.
//
// Reversible: if A1 reactivates Miramar, re-add it (there is an additive
// helper at app/lib/driver-property-assign.ts).
import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const sb = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'))

const TARGETS = ['josesalvro98022@gmail.com', 'fairprince@ymail.com']
const REMOVE = 'Miramar Apartments'
const key = (s: string) => s.trim().toLowerCase()

let failures = 0
const fail = (m: string) => { failures++; console.log(`❌ ${m}`) }

async function run(email: string) {
  console.log(`\n══ ${email} ══`)

  const { data: rows, error } = await sb.from('drivers')
    .select('id, name, email, is_active, assigned_properties').ilike('email', email)
  if (error) { fail(`read failed: ${error.message}`); return }
  if ((rows || []).length !== 1) { fail(`expected exactly 1 drivers row, got ${(rows || []).length}`); return }

  const row = rows![0]
  const before: string[] = Array.isArray(row.assigned_properties) ? [...row.assigned_properties] : []
  const after = before.filter(p => key(String(p)) !== key(REMOVE))

  console.log(`  BEFORE (${before.length}):`)
  before.forEach(p => console.log(`     ${key(String(p)) === key(REMOVE) ? '🔴 REMOVING → ' : '              '}${p}`))

  if (before.length - after.length !== 1) {
    fail(`refusing to write — removal would change ${before.length - after.length} elements, expected exactly 1`)
    return
  }

  const { data: updated, error: uErr } = await sb.from('drivers')
    .update({ assigned_properties: after }).eq('id', row.id).select('id, assigned_properties')
  if (uErr) { fail(`write failed: ${uErr.message}`); return }
  if ((updated || []).length !== 1) { fail(`update returned ${(updated || []).length} rows`); return }

  // Fresh re-read — not the update's echo. The echo is what the server
  // says it wrote; this is what is actually stored.
  const { data: post } = await sb.from('drivers').select('assigned_properties').eq('id', row.id)
  const now: string[] = Array.isArray(post?.[0]?.assigned_properties) ? post![0].assigned_properties : []

  console.log(`  AFTER  (${now.length}):`)
  now.forEach(p => console.log(`                    ${p}`))

  // Order AND spelling, element by element. A length check alone passes
  // if one name quietly became a different one.
  const expected = before.filter(p => key(String(p)) !== key(REMOVE))
  const identical = now.length === expected.length && expected.every((v, i) => now[i] === v)
  const miramarGone = !now.some(p => key(String(p)) === key(REMOVE))

  console.log(`  ${miramarGone ? '✅' : '❌'} "${REMOVE}" removed`)
  console.log(`  ${identical ? '✅' : '❌'} the other ${expected.length} survived in the same order and spelling`)
  if (!miramarGone) fail(`${email}: Miramar still present`)
  if (!identical) fail(`${email}: remaining properties DIVERGED\n     expected ${JSON.stringify(expected)}\n     got      ${JSON.stringify(now)}`)

  await sb.from('audit_logs').insert([{
    user_email: 'alvaradolegacyconsulting@gmail.com',
    action: 'DRIVER_PROPERTY_UNASSIGNED_MANUAL',
    table_name: 'drivers',
    record_id: String(row.id),
    old_values: { assigned_properties: before },
    new_values: {
      assigned_properties: now,
      removed: REMOVE,
      reason: 'Miramar Apartments is_active=false; driver portal lists deactivated properties and enforcement fires against them. Manual close pending the queued P1 fix.',
    },
  }])
}

async function main() {
  console.log(`Removing "${REMOVE}" from ${TARGETS.length} drivers. alexsandra.hidalgo deliberately excluded.`)
  for (const e of TARGETS) await run(e)

  console.log('\n══ system-wide re-check ══')
  const { data: all } = await sb.from('drivers').select('email, is_active, assigned_properties')
  const still = (all || []).filter((d: any) =>
    (Array.isArray(d.assigned_properties) ? d.assigned_properties : []).some((p: string) => key(String(p)) === key(REMOVE)))
  if (still.length === 0) console.log('  no driver holds Miramar')
  for (const d of still) console.log(`  ${d.email}  driver_active=${d.is_active}  ${d.is_active ? '🔴 STILL EXPOSED' : '✅ inactive driver — intentionally left'}`)

  console.log('')
  console.log(failures === 0 ? '✅ DONE — all assertions passed' : `❌ ${failures} PROBLEM(S)`)
  process.exit(failures === 0 ? 0 : 1)
}
main()

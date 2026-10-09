// PM CRM slice 2 preflight probes — vehicle-matching investigation
// for jes/may/joe, roommate cross-check (Unit 505 Dani G / Chris H if
// applicable), and general shape of vehicles for residents at French
// Quarter.
//
// Read-only. Service role. Print raw values so any case/whitespace/null
// drift is visible.
//
// Run: npx tsx --env-file=.env.local scripts/probe-crm-slice2-preflight.ts

import { createClient } from '@supabase/supabase-js'

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

const PROPERTY = 'French Quarter'

async function main() {
  console.log('══ residents at French Quarter (super-user) ══════════════════════\n')
  const { data: residents } = await admin
    .from('residents')
    .select('id, email, name, unit, property, status, is_active, created_at')
    .ilike('property', PROPERTY)
    .order('unit')
  for (const r of residents ?? []) {
    console.log(`  · id=${r.id}  email=${JSON.stringify(r.email)}  unit=${JSON.stringify(r.unit)}  status=${r.status}  active=${r.is_active}`)
  }

  console.log('\n══ vehicles at French Quarter (super-user) ═══════════════════════\n')
  const { data: vehicles } = await admin
    .from('vehicles')
    .select('id, plate, resident_email, unit, property, status, is_active, created_at')
    .ilike('property', PROPERTY)
    .order('unit')
  for (const v of vehicles ?? []) {
    console.log(`  · id=${v.id}  plate=${JSON.stringify(v.plate)}  email=${JSON.stringify(v.resident_email)}  unit=${JSON.stringify(v.unit)}  status=${v.status}  active=${v.is_active}`)
  }

  console.log('\n══ target residents — jes/may/joe cross-lookups ══════════════════\n')
  for (const nick of ['jes', 'may', 'joe']) {
    const email = `chris.tobar94+${nick}@gmail.com`
    const { data: rRow } = await admin
      .from('residents')
      .select('id, email, unit, is_active, status')
      .ilike('email', email)
      .maybeSingle()
    if (!rRow) { console.log(`  ${nick}: NO RESIDENT ROW`); continue }
    console.log(`  ${nick}:  resident.email=${JSON.stringify(rRow.email)}  unit=${JSON.stringify(rRow.unit)}`)

    // Match by email
    const { data: vByEmail } = await admin
      .from('vehicles')
      .select('id, plate, resident_email, unit, property, status, is_active')
      .ilike('resident_email', email)
    console.log(`         vehicles by email  (${vByEmail?.length ?? 0}):`)
    for (const v of vByEmail ?? []) console.log(`           - id=${v.id} plate=${JSON.stringify(v.plate)} unit=${JSON.stringify(v.unit)} property=${JSON.stringify(v.property)} status=${v.status} active=${v.is_active}`)

    // Match by unit at property
    if (rRow.unit) {
      const { data: vByUnit } = await admin
        .from('vehicles')
        .select('id, plate, resident_email, unit, property, status, is_active')
        .ilike('unit', rRow.unit)
        .ilike('property', PROPERTY)
      console.log(`         vehicles by unit  (${vByUnit?.length ?? 0}):`)
      for (const v of vByUnit ?? []) console.log(`           - id=${v.id} plate=${JSON.stringify(v.plate)} email=${JSON.stringify(v.resident_email)} status=${v.status} active=${v.is_active}`)
    }
    console.log('')
  }

  console.log('══ roommate cross-check — units with >1 active resident ══════════\n')
  // Group residents by unit
  const byUnit = new Map<string, any[]>()
  for (const r of residents ?? []) {
    if (!r.is_active) continue
    const u = (r.unit ?? '').toLowerCase()
    if (!u) continue
    const list = byUnit.get(u) ?? []
    list.push(r); byUnit.set(u, list)
  }
  const sharedUnits = [...byUnit.entries()].filter(([, rs]) => rs.length > 1)
  if (sharedUnits.length === 0) {
    console.log('  (no shared units at French Quarter today — roommate case not present)')
  } else {
    for (const [unit, rs] of sharedUnits) {
      console.log(`  Unit ${unit}:`)
      for (const r of rs) {
        const { data: vByEmail } = await admin
          .from('vehicles')
          .select('id, plate, resident_email')
          .ilike('resident_email', r.email)
          .ilike('property', PROPERTY)
        console.log(`    · ${r.name} (${r.email}) — ${vByEmail?.length ?? 0} vehicles by email`)
      }
      const { data: unitVehicles } = await admin
        .from('vehicles')
        .select('id, plate, resident_email')
        .ilike('unit', unit)
        .ilike('property', PROPERTY)
      const nullEmail = (unitVehicles ?? []).filter(v => !v.resident_email)
      if (nullEmail.length > 0) {
        console.log(`    ⚠ ${nullEmail.length} vehicles at unit ${unit} with NULL resident_email — would hit unit fallback and be misattributed`)
        for (const v of nullEmail) console.log(`       - id=${v.id} plate=${JSON.stringify(v.plate)}`)
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(99) })

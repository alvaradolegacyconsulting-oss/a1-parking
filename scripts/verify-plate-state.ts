// ════════════════════════════════════════════════════════════════════
// GATE — a plate-state select cannot rewrite what it cannot show
// ════════════════════════════════════════════════════════════════════
//
// 🔴 THE INVARIANT: for EVERY value `vehicles.state` actually holds,
// the options the select renders must contain that value. If they do
// not, the browser falls back to the first <option> and the next save
// silently overwrites a field nobody edited.
//
// This is asserted against production's real distinct values, not a
// hand-written list — the bug existed precisely because four
// hand-written lists disagreed with the data.
//
// Usage: npm run verify:platestate

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import { PLATE_STATES, plateStateOptions, isKnownPlateState } from '../app/lib/us-states'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const db = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }

// What the OLD manager select offered, kept here as the NEGATIVE
// CONTROL: the gate must be able to demonstrate the bug it prevents.
const OLD_MANAGER_LIST = ['TX', 'CA', 'FL', 'NY', 'GA', 'OH', 'IL', 'PA', 'NC', 'AZ']

const main = async () => {
  chk(`the shared list is 50 states + DC (${PLATE_STATES.length})`, PLATE_STATES.length === 51,
    PLATE_STATES.includes('DC') ? 'DC present' : '🔴 DC missing')
  chk('no territories, Canada or MX yet (ruled)',
    !['PR', 'VI', 'GU', 'AS', 'MP', 'MX', 'ON', 'QC', 'BC'].some(c => PLATE_STATES.includes(c)))

  // ── the real values ───────────────────────────────────────────────
  const { data, error } = await db.from('vehicles').select('state, plate, property')
  if (error) { console.error('db unreachable:', error.message); process.exit(2) }
  const rows = data as Array<{ state: string | null; plate: string; property: string }>
  const distinct = [...new Set(rows.map(r => r.state ?? '(null)'))]
  console.log(`\n── every distinct vehicles.state in production (${distinct.length}) ──`)

  let unknown = 0
  for (const v of distinct) {
    const stored = v === '(null)' ? null : v
    const opts = plateStateOptions(stored)
    const values = opts.map(o => o.value)
    const held = stored ?? ''
    // The decisive assertion.
    const preserved = held === '' ? true : values.includes(held)
    if (stored && !isKnownPlateState(stored)) unknown++
    const n = rows.filter(r => (r.state ?? '(null)') === v).length
    chk(`${String(v).padEnd(10)} (${String(n).padStart(3)} rows) is renderable, so a save cannot lose it`,
      preserved,
      preserved
        ? (stored && !isKnownPlateState(stored) ? `shown first as "${opts[0].label}"` : '')
        : '🔴 NOT in the options — the select would fall back to the first entry and overwrite it')
  }

  // ── 🔴 NEGATIVE CONTROL: prove the gate has teeth ─────────────────
  console.log('\n── NEGATIVE CONTROL: what the OLD lists would have done ──')
  const victims = distinct.filter(v => v !== '(null)' && !OLD_MANAGER_LIST.includes(v))
  const victimRows = rows.filter(r => r.state && !OLD_MANAGER_LIST.includes(r.state)).length
  chk(`the old 10-state list could NOT render ${victims.length} of today's values (${victimRows} rows)`,
    victims.length > 0,
    `${JSON.stringify(victims)} → all would have been saved as "${OLD_MANAGER_LIST[0]}"`)
  chk('…and the shared list renders every one of them',
    victims.every(v => plateStateOptions(v).map(o => o.value).includes(v)))

  // ── end-to-end: the save path writes back what the select holds ───
  console.log('\n── END TO END: a save that does not touch the field ──')
  const probe = await db.from('vehicles').insert({
    plate: `ZZPS${Date.now() % 100000}`, state: 'Texas', make: 'P', model: 'State',
    property: 'Test Legacy Property', company: 'Test-LEGACY', unit: 'PS',
    resident_email: 'zz-ps-res@test.invalid', status: 'pending', is_active: false,
  }).select('id, state').single()
  if (probe.error) { console.error('probe insert failed:', probe.error.message); process.exit(2) }
  const pid = (probe.data as { id: number }).id
  try {
    // What the select renders for a stored 'Texas' is its first option —
    // that exact string is what a save without an edit submits.
    const submitted = plateStateOptions('Texas')[0].value
    chk('the value a save would submit for a stored "Texas" is "Texas", not a fallback',
      submitted === 'Texas', `submitted=${JSON.stringify(submitted)}`)
    await db.from('vehicles').update({ state: submitted }).eq('id', pid)
    const after = (await db.from('vehicles').select('state').eq('id', pid).single()).data as { state: string }
    chk('…and the stored value is unchanged after that save', after.state === 'Texas', `now=${JSON.stringify(after.state)}`)

    // and the same for a real out-of-state code
    await db.from('vehicles').update({ state: 'LA' }).eq('id', pid)
    const sub2 = plateStateOptions('LA').map(o => o.value)
    chk('an out-of-state code is in the options, so it survives a save too', sub2.includes('LA'))
  } finally {
    await db.from('audit_logs').delete().eq('record_id', String(pid))
    await db.from('vehicles').delete().eq('id', pid)
    const left = (await db.from('vehicles').select('id').ilike('plate', 'ZZPS%')).data
    chk('probe vehicle removed', (left?.length ?? 0) === 0, JSON.stringify(left))
  }

  // ── static: one list, not five ────────────────────────────────────
  console.log('\n── static: a single source of truth ──')
  let copies = 0
  for (const f of ['app/manager/page.tsx', 'app/resident/page.tsx', 'app/register/page.tsx',
                   'app/company_admin/page.tsx', 'app/components/AddVehicleForResidentModal.tsx']) {
    const src = fs.readFileSync(f, 'utf8')
    if (/const US_STATES\s*=|\['TX','CA','FL','NY','GA'/.test(src)) { copies++; console.log(`   🔴 ${f} still defines its own list`) }
  }
  chk('no surface defines its own plate-state list', copies === 0, `${copies} copies found`)

  console.log('')
  if (fails) { console.log(`❌ ${fails} FAILURE(S).`); process.exit(1) }
  console.log(`✅ Every one of production's ${distinct.length} distinct state values is renderable, including ${unknown} the accepted list does not contain.`)
  console.log('   A save that does not touch the field cannot change it.')
}
main().catch(e => { console.error('FATAL', e.message); process.exit(2) })

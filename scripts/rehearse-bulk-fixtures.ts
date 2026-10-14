// ════════════════════════════════════════════════════════════════════
// REHEARSAL — the Alden Park fixtures through the real validator
// ════════════════════════════════════════════════════════════════════
//
// Runs exactly what /api/bulk-onboarding/preview runs — parseBulkCsv,
// then bulk_validate_rows with a real company_admin JWT, then
// validateBulkRows + dbFlagErrors — against the architect's anonymized
// Alden Park fixtures, and checks the result against the expectations
// he published with them.
//
// 🔴 THE EXPECTED SET IS THE POINT. A validator that finds the eight
// defects is not proven by finding eight things; it is proven by
// finding THOSE eight and nothing else. Any extra row is a false
// positive and this script names it.
//
// The HTTP layer is not exercised here — that is the route gate that
// ships with the CA page. This is the validator.
//
// Usage: npm run rehearse:bulk

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import { parseBulkCsv, BULK_CSV_COLUMNS } from '../app/lib/bulk-onboarding'
import {
  validateBulkRows, dbFlagErrors,
  type BulkRowInput, type BulkDbFlags, type BulkError,
} from '../app/lib/bulk-validator'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const CO = 'Test-LEGACY'
const DIR = 'docs/bulk-onboarding/fixtures'
const S = Date.now()

// From the architect's expectations table, published with the fixtures.
const EXPECTED_DIRTY = [7, 11, 79, 133, 167, 204, 322, 355]
const MUST_PASS_DIRTY = [328, 329, 360, 361]   // '#7201', '#1105', '3-3302' x2

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }

const users: { email: string; uid: string }[] = []
const flipped: string[] = []
let cleaned = false

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') console.error(`\n🔴 cleanup (${why})`)
  while (flipped.length) {
    const co = flipped[flipped.length - 1]
    let ok = false
    for (let i = 1; i <= 3 && !ok; i++) {
      const r = await db.from('companies').update({ bulk_onboarding_enabled: false })
        .eq('name', co).select('bulk_onboarding_enabled')
      if (!r.error && r.data?.[0]?.bulk_onboarding_enabled === false) {
        ok = true; console.log(`   ↩ ${co}.bulk_onboarding_enabled restored to false (verified)`)
      }
    }
    if (!ok) { console.error(`\n🔴🔴 MANUAL: UPDATE public.companies SET bulk_onboarding_enabled = FALSE WHERE name = '${co}';`); fails++ }
    flipped.pop()
  }
  for (const u of users) {
    await db.from('user_roles').delete().ilike('email', u.email)
    await db.auth.admin.deleteUser(u.uid).catch(() => {})
  }
}

let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => { if (dying) return; dying = true
    cleanup(sig).then(() => process.exit(2)).catch(() => process.exit(2)) })
}
process.on('uncaughtException', e => {
  console.error('🔴 uncaught:', (e as Error).message)
  cleanup('uncaughtException').then(() => process.exit(2)).catch(() => process.exit(2))
})

const main = async () => {
  // Refuse to report on a missing RPC: "function not found" is an
  // error, and an error would read as a clean file here.
  const ping = await db.rpc('bulk_validate_rows', { p_property_id: 0, p_rows: [] })
  if (ping.error && /could not find the function|does not exist/i.test(ping.error.message)) {
    console.error('🔴 bulk_validate_rows is not installed. Apply wip-20261015_bulk_validate_rows.sql first.')
    process.exit(2)
  }

  const { data: props } = await db.from('properties').select('id,name,company,is_active')
  const target = props?.find(p => p.company === CO && p.name === 'Test Legacy Property' && p.is_active)
  if (!target) { console.error(`🔴 no active ${CO} target property`); process.exit(2) }

  const { count: vCount } = await db.from('vehicles').select('*', { count: 'exact', head: true })
    .eq('property', target.name).eq('is_active', true)
  const { count: rCount } = await db.from('residents').select('*', { count: 'exact', head: true })
    .eq('property', target.name)
  console.log(`rehearsing against ${target.name} (id ${target.id}) — it already holds ${vCount ?? '?'} active vehicles and ${rCount ?? '?'} residents\n`)

  const email = `zz-rh-ca-${S}@test.invalid`
  const { data: u, error: uErr } = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${S}q` })
  if (uErr || !u.user) { console.error('🔴 createUser:', uErr?.message); process.exit(2) }
  users.push({ email, uid: u.user.id })
  await db.from('user_roles').insert({ email, role: 'company_admin', company: CO, property: [target.name], is_active: true })
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: link } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  await client.auth.verifyOtp({ token_hash: link!.properties!.hashed_token!, type: 'magiclink' })

  const f = await db.from('companies').update({ bulk_onboarding_enabled: true })
    .eq('name', CO).select('bulk_onboarding_enabled')
  if (f.error || f.data?.[0]?.bulk_onboarding_enabled !== true) { console.error('🔴 could not enable the flag'); await cleanup('end'); process.exit(2) }
  flipped.push(CO)

  try {
    for (const file of ['alden_fixture_clean.csv', 'alden_fixture_dirty.csv']) {
      console.log(`\n═══ ${file} ═══`)
      const text = fs.readFileSync(`${DIR}/${file}`, 'utf8')
      const parsed = parseBulkCsv(text)
      if (!parsed.ok) { chk('parses', false, `${parsed.code}: ${parsed.message}`); continue }

      const col = (r: string[], n: typeof BULK_CSV_COLUMNS[number]) => (r[BULK_CSV_COLUMNS.indexOf(n)] ?? '').trim()
      const rpc = await client.rpc('bulk_validate_rows', {
        p_property_id: target.id,
        p_rows: parsed.dataRows.map((r, i) => ({ i, email: col(r, 'email'), plate: col(r, 'plate') })),
      })
      if (rpc.error) { chk('bulk_validate_rows', false, rpc.error.message.slice(0, 90)); continue }
      const flags = (rpc.data ?? []) as BulkDbFlags[]
      const norm = new Map(flags.map(x => [x.row_index, x.plate_norm]))

      const rows: BulkRowInput[] = parsed.dataRows.map((r, i) => ({
        index: i, unit: col(r, 'unit'), first_name: col(r, 'first_name'), last_name: col(r, 'last_name'),
        email: col(r, 'email'), phone: col(r, 'phone'), plate: col(r, 'plate'),
        plate_state: col(r, 'plate_state'), make: col(r, 'make'), model: col(r, 'model'),
        color: col(r, 'color'), tag_number: col(r, 'tag_number'), plateNorm: norm.get(i) ?? '',
      }))

      const fieldErrors = validateBulkRows(rows)
      const dbErrors = dbFlagErrors(rows, flags)
      const all: BulkError[] = [...fieldErrors, ...dbErrors]

      console.log(`   ${parsed.dataRows.length} rows · ${parsed.residentCount} residents · ${parsed.vehicleCount} vehicles · ${flags.length} rows checked by the database`)
      chk('every row came back from the database', flags.length === parsed.dataRows.length,
        `${flags.length} of ${parsed.dataRows.length}`)

      // 🔴 The DB half is reported SEPARATELY. The expectations are
      // about the file, so a conflict with whatever already lives at
      // this test property is not a validator fault — but it must be
      // visible, not quietly folded into the count.
      if (dbErrors.length > 0) {
        console.log(`   ⚠ ${dbErrors.length} error(s) from this property's EXISTING data, not from the file:`)
        for (const e of dbErrors.slice(0, 6)) console.log(`       row ${e.row} ${e.code}: ${e.message.slice(0, 72)}`)
      }

      if (file.includes('clean')) {
        chk('358 data rows', parsed.dataRows.length === 358, String(parsed.dataRows.length))
        chk('228 residents', parsed.residentCount === 228, String(parsed.residentCount))
        chk('358 vehicles', parsed.vehicleCount === 358, String(parsed.vehicleCount))
        chk('🔴 validates clean — zero errors from the file itself', fieldErrors.length === 0,
          fieldErrors.length === 0 ? 'ok' : fieldErrors.slice(0, 8).map(e => `row ${e.row} ${e.code}`).join(', '))
      } else {
        const got = [...new Set(fieldErrors.map(e => e.row))].sort((a, b) => a - b)
        console.log(`\n   errors from the file, by row:`)
        for (const e of fieldErrors) console.log(`     row ${String(e.row).padStart(3)} · ${e.column.padEnd(11)} · ${e.message}`)

        const missing = EXPECTED_DIRTY.filter(r => !got.includes(r))
        const extra = got.filter(r => !EXPECTED_DIRTY.includes(r))
        console.log('')
        chk(`exactly the 8 expected rows flagged (${EXPECTED_DIRTY.join(', ')})`,
          missing.length === 0 && extra.length === 0,
          missing.length || extra.length
            ? `missing ${missing.join(', ') || 'none'} · 🔴 FALSE POSITIVES ${extra.join(', ') || 'none'}`
            : `got ${got.join(', ')}`)
        for (const r of MUST_PASS_DIRTY) {
          const hit = fieldErrors.filter(e => e.row === r)
          chk(`row ${r} passes (it must — the unit rule as corrected)`, hit.length === 0,
            hit.length ? `🔴 ${hit[0].code}: ${hit[0].message.slice(0, 60)}` : 'ok')
        }
        chk('nothing would load from the dirty file', all.length > 0, `${all.length} errors total`)
      }
    }
  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ rehearsal green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })

// ════════════════════════════════════════════════════════════════════
// Seed two submitted batches for the production demo send
// ════════════════════════════════════════════════════════════════════
// Jose drives the clicks in production so the real Vercel configuration
// is exercised. This only puts two batches in the queue for him.
//
// 🔴 THE FILES MUST BE GENUINELY CLEAN, NOT JUST WELL-FORMED. Approve
// and Load RE-VALIDATE against live records, so a file that merely
// parses will be refused as stale at the moment Jose presses Load — in
// production, mid-demo. The notification gate already learned this the
// cheap way: alden_fixture_clean got `use_return`, "4 rows no longer fit
// the records at Sunset Ridge Apartments". So every row is checked here
// against the same predicates the RPC uses before anything is inserted:
//
//   • plate not active at the target property, and not active at any of
//     the company's OTHER properties (the RPC's sibling scope)
//   • plate not under a live prohibition at the property
//   • email not already a resident at the property
//   • unit written plainly, state TX, plate ≥ MIN_PLATE normalized
//
// If any row fails, nothing is seeded and it says which.
//
// Usage: npx tsx --env-file=.env.local scripts/seed-demo-send-batches.ts [--apply]

import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { BULK_CSV_HEADER } from '../app/lib/bulk-onboarding'
import { validateBulkRows, type BulkRowInput } from '../app/lib/bulk-validator'

const APPLY = process.argv.includes('--apply')
// --only a | --only b seeds a single batch. The Reply-To verify needs one
// rejectable batch, not a pair, and seeding a spare leaves a live row in
// the queue that somebody then has to clean up.
const ONLY = (() => {
  const i = process.argv.indexOf('--only')
  const v = i >= 0 ? process.argv[i + 1] : null
  return v === 'a' || v === 'b' ? v : null
})()
const TAGS: ('a' | 'b')[] = ONLY ? [ONLY] : ['a', 'b']
const PROPERTY = 'Northgate Commerce Center'
const ROWS = 4
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } })

/** Two files, distinct in content so their hashes differ. */
function rowsFor(tag: 'a' | 'b') {
  // 🔴 + addresses only. Loading batch B creates real resident rows
  // whose claim emails these are; a stray real address would send a
  // stranger a login-setup invitation for a demo property.
  const base = tag === 'a' ? 10 : 20
  return Array.from({ length: ROWS }, (_, i) => {
    const n = base + i
    return {
      unit: `${7000 + n}`,
      first_name: tag === 'a' ? 'Demo' : 'Load',
      last_name: `Send ${n}`,
      email: `alvaradolegacyconsulting+demo${n}@gmail.com`,
      phone: '',
      plate: `ZD${tag.toUpperCase()}${String(n).padStart(3, '0')}`,
      plate_state: 'TX',
      make: 'Honda', model: 'Civic', color: 'Blue', tag_number: '',
    }
  })
}

const csvOf = (rows: ReturnType<typeof rowsFor>) =>
  Buffer.from([BULK_CSV_HEADER, ...rows.map(r =>
    [r.unit, r.first_name, r.last_name, r.email, r.phone, r.plate, r.plate_state,
     r.make, r.model, r.color, r.tag_number].join(','))].join('\n') + '\n', 'utf8')

async function main() {
  const { data: co } = await db.from('companies').select('id,name,bulk_onboarding_enabled')
    .eq('company_env', 'demo').limit(1).maybeSingle()
  if (!co) throw new Error('no demo company')
  const { data: prop } = await db.from('properties').select('id,name,is_active')
    .eq('company', co.name).eq('name', PROPERTY).maybeSingle()
  if (!prop) throw new Error(`${PROPERTY} not found at ${co.name}`)
  console.log(`target: ${co.name} (${co.id}) / ${PROPERTY} (${prop.id})`)
  console.log(`  property active=${prop.is_active}  bulk_onboarding_enabled=${co.bulk_onboarding_enabled}\n`)
  if (co.bulk_onboarding_enabled !== true) {
    console.log('🔴 the flag is OFF for the demo company — the operator routes will refuse. Stopping.')
    process.exit(2)
  }

  // Sibling properties, exactly as the RPC derives them.
  const { data: sibs } = await db.from('properties').select('name')
    .ilike('company', co.name).neq('name', PROPERTY)
  const siblingNames = (sibs ?? []).map(s => String(s.name))

  const problems: string[] = []
  for (const tag of TAGS) {
    for (const r of rowsFor(tag)) {
      const { data: norm } = await db.rpc('normalize_plate', { p: r.plate })
      const plateNorm = String(norm ?? '')

      // 🔴 The shared validator first, so the file cannot fail on a rule
      // this script does not know about. plateNorm comes from the
      // DATABASE function, as the real path does.
      const input: BulkRowInput = { index: 0, ...r, plateNorm }
      for (const e of validateBulkRows([input])) problems.push(`${tag} ${r.plate}: ${e.code} — ${e.message}`)

      // active at this property, or at a sibling — one read per scope
      for (const [scope, names] of [['this property', [PROPERTY]], ['a sibling property', siblingNames]] as const) {
        if (names.length === 0) continue
        const { data: hit } = await db.from('vehicles').select('plate,property')
          .in('property', names as string[]).eq('is_active', true).in('status', ['active', 'under_review'])
        for (const v of hit ?? []) {
          const { data: vn } = await db.rpc('normalize_plate', { p: String(v.plate) })
          if (String(vn ?? '') === plateNorm) problems.push(`${tag} ${r.plate}: already active at ${scope} (${v.property})`)
        }
      }
      const { data: pro } = await db.from('property_plate_prohibitions').select('id')
        .eq('property_id', prop.id).eq('plate', plateNorm).is('removed_at', null)
      if ((pro ?? []).length) problems.push(`${tag} ${r.plate}: under a live prohibition`)

      const { data: res } = await db.from('residents').select('id')
        .eq('property', PROPERTY).ilike('email', r.email)
      if ((res ?? []).length) problems.push(`${tag} ${r.email}: already a resident at ${PROPERTY}`)
    }
  }

  if (problems.length) {
    console.log(`🔴 ${problems.length} problem(s) — nothing seeded:`)
    for (const p of problems) console.log(`   ${p}`)
    process.exit(1)
  }
  console.log(`✅ both files are clean against live records (${ROWS} rows each, validator + 4 DB predicates)\n`)

  if (!APPLY) {
    for (const tag of TAGS) {
      console.log(`── batch ${tag.toUpperCase()} would contain ──`)
      for (const r of rowsFor(tag)) console.log(`   unit ${r.unit}  ${r.plate}  ${r.email}`)
    }
    console.log('\nmeasure-only: pass --apply to seed.')
    return
  }

  const { data: ca } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const demoCa = (ca?.users ?? []).find(u => (u.email ?? '').toLowerCase() === 'demo-ca@test.shieldmylot.com')
  if (!demoCa) throw new Error('demo-ca@test.shieldmylot.com has no auth user')

  for (const tag of TAGS) {
    const bytes = csvOf(rowsFor(tag))
    const sha = crypto.createHash('sha256').update(bytes).digest('hex')
    const ins = await db.from('import_batches').insert({
      company_id: co.id, property_id: prop.id,
      source_filename: `demo_send_${tag}.csv`, storage_path: `batches/demo_send_${tag}.csv`,
      file_sha256: sha,
      attested_by_user_id: demoCa.id,
      attested_name: 'Demo Company Administrator', attested_title: 'Property Manager',
      status: 'submitted', resident_count: ROWS, vehicle_count: ROWS,
    }).select('id').single()
    if (ins.error) throw new Error(`seed ${tag}: ${ins.error.message}`)
    const id = ins.data.id as number
    const path = `batches/${id}.csv`
    const up = await db.storage.from('bulk-onboarding').upload(path, bytes, { contentType: 'text/csv', upsert: true })
    if (up.error) throw new Error(`upload ${tag}: ${up.error.message}`)
    const fix = await db.from('import_batches').update({ storage_path: path }).eq('id', id).select('storage_path').single()
    if (fix.error) throw new Error(`storage_path ${tag}: ${fix.error.message}`)
    // Read back: the row, the object, and the hash agreeing.
    const back = await db.from('import_batches').select('id,status,file_sha256,storage_path,resident_count,vehicle_count')
      .eq('id', id).single()
    const dl = await db.storage.from('bulk-onboarding').download(path)
    const liveSha = dl.data ? crypto.createHash('sha256').update(Buffer.from(await dl.data.arrayBuffer())).digest('hex') : 'MISSING'
    console.log(`batch ${tag.toUpperCase()} = #${id}  status=${back.data?.status}  ${back.data?.resident_count} residents / ${back.data?.vehicle_count} vehicles`)
    console.log(`   storage=${back.data?.storage_path}  hash agrees=${liveSha === back.data?.file_sha256}`)
    for (const r of rowsFor(tag)) console.log(`     unit ${r.unit}  ${r.plate}  ${r.email}`)
  }
}

main().catch(e => { console.error('🔴', (e as Error).message); process.exit(1) })

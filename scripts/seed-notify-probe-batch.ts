// ════════════════════════════════════════════════════════════════════
// A disposable submitted batch, so the notification path can be run
// through the REAL route
// ════════════════════════════════════════════════════════════════════
// The notify code is in app/lib and carries 'server-only', so it cannot
// be imported into a script — by design. The only honest way to
// exercise it is the way an operator does: a submitted batch, and the
// reject route called over HTTP.
//
// 🔴 REJECT, NOT LOAD. A reject moves a status and sends mail; it
// writes no resident, vehicle or role row. Running the notification
// path therefore costs nothing that has to be rolled back before
// midnight.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/seed-notify-probe-batch.ts
//   npm run queue:act -- "Northgate Commerce Center" reject "<reason>"
//   npx tsx --env-file=.env.local scripts/seed-notify-probe-batch.ts --report

import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import fs from 'fs'

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } })

const PROPERTY = 'Northgate Commerce Center'
const MARKER = 'zz_notify_probe'
const FIXTURE = 'docs/bulk-onboarding/fixtures/alden_fixture_clean.csv'

async function findProbe() {
  const { data } = await db.from('import_batches').select('*')
    .eq('source_filename', `${MARKER}.csv`).order('id', { ascending: false }).limit(1).maybeSingle()
  return data
}

async function seed() {
  const { data: co } = await db.from('companies').select('id,name').eq('company_env', 'demo').limit(1).maybeSingle()
  if (!co) throw new Error('no demo company')
  const { data: prop } = await db.from('properties').select('id,name').eq('company', co.name).eq('name', PROPERTY).maybeSingle()
  if (!prop) throw new Error(`${PROPERTY} not found at ${co.name}`)

  // The submitting CA must be a real account, because the notification
  // resolves its recipient from attested_by_user_id.
  const { data: us } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const ca = (us?.users ?? []).find(u => (u.email ?? '').toLowerCase() === 'demo-ca@test.shieldmylot.com')
  if (!ca) throw new Error('demo-ca@test.shieldmylot.com has no auth user')

  const bytes = fs.readFileSync(FIXTURE)
  const sha = crypto.createHash('sha256').update(bytes).digest('hex')

  const ins = await db.from('import_batches').insert({
    company_id: co.id, property_id: prop.id,
    source_filename: `${MARKER}.csv`, storage_path: `batches/${MARKER}.csv`,
    file_sha256: sha,
    attested_by_user_id: ca.id, attested_name: 'Notification Probe', attested_title: 'Automated',
    status: 'submitted', resident_count: 0, vehicle_count: 0,
  }).select('id').single()
  if (ins.error) throw new Error(`insert: ${ins.error.message}`)
  const id = ins.data.id as number

  // The route re-reads and re-hashes batches/{id}.csv, so the object has
  // to be there under the id, with the bytes the row's hash describes.
  const path = `batches/${id}.csv`
  const up = await db.storage.from('bulk-onboarding').upload(path, bytes, { contentType: 'text/csv', upsert: true })
  if (up.error) throw new Error(`upload: ${up.error.message}`)
  const fix = await db.from('import_batches').update({ storage_path: path }).eq('id', id).select('storage_path').single()
  if (fix.error) throw new Error(`storage_path: ${fix.error.message}`)

  console.log(`seeded batch ${id} · ${co.name} / ${PROPERTY} · submitted · sha ${sha.slice(0, 16)}…`)
  console.log(`  CA on the attestation: ${ca.email} (${ca.id.slice(0, 8)})`)
  console.log(`\nnow: npm run queue:act -- ${JSON.stringify(PROPERTY)} reject "notification path verification"`)
}

async function report() {
  const b = await findProbe()
  if (!b) { console.log('no probe batch found'); return }
  console.log(`\n── batch ${b.id} after the reject ──`)
  console.log(`  status               ${b.status}`)
  console.log(`  reject_reason        ${JSON.stringify(b.reject_reason)}`)
  console.log(`  notify_ca_outcome    ${JSON.stringify(b.notify_ca_outcome)}`)
  console.log(`  notify_admin_outcome ${JSON.stringify(b.notify_admin_outcome)}`)
  console.log(`  notify_error         ${JSON.stringify(b.notify_error)}`)
  console.log(`  notified_at          ${String(b.notified_at ?? '-').slice(0, 19)}`)

  // ── cleanup, verified ───────────────────────────────────────────
  const rm = await db.storage.from('bulk-onboarding').remove([String(b.storage_path)])
  const del = await db.from('import_batches').delete().eq('id', b.id).select('id')
  const aud = await db.from('audit_logs').delete()
    .eq('table_name', 'import_batches').eq('record_id', String(b.id)).select('id')
  console.log(`\n   ↩ removed ${del.data?.length ?? 0} batch row(s), ${rm.data?.length ?? 0} storage object(s), ${aud.data?.length ?? 0} audit row(s)`)
  const still = await db.from('import_batches').select('id').eq('id', b.id)
  console.log(`   ↩ read back: ${(still.data ?? []).length} probe batch(es) remaining`)
}

const main = process.argv.includes('--report') ? report : seed
main().catch(e => { console.error('🔴', (e as Error).message); process.exit(1) })

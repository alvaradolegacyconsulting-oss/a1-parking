// Commit 2 verification — spot-check timing + row-set equivalence on
// violations + visitor_passes under manager/CA/admin/driver/resident
// sessions at French Quarter.
//
// Target: <500ms per query per role, no 57014, row counts match
// super-user baseline (byte-for-byte modulo the space_requests
// case-parity fix rolled into Commit 2).
//
// Run: npx tsx --env-file=.env.local scripts/probe-commit2-timing.ts

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const PROPERTY = 'French Quarter'
const COMPANY  = 'A1 Test Run 2'
const MANAGER  = 'chris.tobar94+happy@gmail.com'
const RESIDENT = 'chris.tobar94+jes@gmail.com'
const NEG_MGR  = 'manager.edge@democorp.com'

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T, elapsedMs: number }> {
  const start = process.hrtime.bigint()
  const result = await fn()
  const end = process.hrtime.bigint()
  return { result, elapsedMs: Number((end - start) / 1000000n) }
}

async function signInAs(admin: SupabaseClient, email: string): Promise<{ client: SupabaseClient | null, err?: string }> {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (error) return { client: null, err: error.message }
  const tokenHash = (data?.properties as any)?.hashed_token
  if (!tokenHash) return { client: null, err: 'no hashed_token' }
  const c = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: otpErr } = await c.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
  if (otpErr) return { client: null, err: otpErr.message }
  return { client: c }
}

function fmt(res: any, ms: number, target?: number): string {
  const err = res.error
  if (err) return `❌ ${ms}ms · code=${err.code || '?'} · ${JSON.stringify(err.message)}`
  const n = Array.isArray(res.data) ? res.data.length : 0
  const timing = target && ms > target ? `⚠ ${ms}ms` : `✓ ${ms}ms`
  return `${timing} · rows=${n}`
}

async function main() {
  const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('════════════════════════════════════════════════════════')
  console.log('Commit 2 verification — timing + row-set spot-check')
  console.log('════════════════════════════════════════════════════════\n')

  // Super-user baseline (ground truth for row counts)
  const B_vio  = await admin.from('violations').select('*', { count: 'exact', head: true }).ilike('property', PROPERTY)
  const B_pas  = await admin.from('visitor_passes').select('*', { count: 'exact', head: true }).ilike('property', PROPERTY)
  const B_veh  = await admin.from('vehicles').select('*', { count: 'exact', head: true }).ilike('property', PROPERTY)
  const B_gth  = await admin.from('guest_authorizations').select('*', { count: 'exact', head: true }).ilike('property', PROPERTY)
  const B_sreq = await admin.from('space_requests').select('*', { count: 'exact', head: true }).ilike('property', PROPERTY)
  console.log(`Baseline @ "${PROPERTY}": violations=${B_vio.count}  passes=${B_pas.count}  vehicles=${B_veh.count}  guest_auths=${B_gth.count}  space_requests=${B_sreq.count}\n`)

  // Auto-pick CA + admin + a driver
  const { data: caRow } = await admin.from('user_roles').select('email').eq('role', 'company_admin').ilike('company', COMPANY).limit(1)
  const CA = caRow?.[0]?.email
  const { data: adminRow } = await admin.from('user_roles').select('email').eq('role', 'admin').limit(1)
  const ADMIN = adminRow?.[0]?.email
  const { data: driverRow } = await admin.from('user_roles').select('email').eq('role', 'driver').ilike('company', COMPANY).limit(1)
  const DRIVER = driverRow?.[0]?.email

  console.log(`Sessions:  MGR=${MANAGER}  CA=${CA}  ADMIN=${ADMIN}  DRIVER=${DRIVER || '(none)'}  RES=${RESIDENT}  NEG=${NEG_MGR}\n`)

  const ROLES = [
    { label: 'MANAGER      ', email: MANAGER,  expVio: B_vio.count,  expPas: B_pas.count },
    { label: 'CA-A1        ', email: CA,       expVio: B_vio.count,  expPas: B_pas.count },
    { label: 'ADMIN        ', email: ADMIN,    expVio: B_vio.count,  expPas: B_pas.count },
    { label: 'DRIVER-A1    ', email: DRIVER,   expVio: B_vio.count,  expPas: B_pas.count },
    { label: 'RESIDENT(jes)', email: RESIDENT, expVio: null,          expPas: 0 },
    { label: 'NEG_MGR(edge)', email: NEG_MGR,  expVio: 0,             expPas: 0 },
  ]

  for (const R of ROLES) {
    console.log(`── ${R.label}  (${R.email || 'n/a'}) ──`)
    if (!R.email) { console.log('   skipped — no email\n'); continue }
    const { client, err } = await signInAs(admin, R.email)
    if (!client) { console.log(`   sign-in failed: ${err}\n`); continue }

    // violations
    const vio = await timed(() => client.from('violations').select('*').ilike('property', PROPERTY))
    const expVio = R.expVio == null ? '?' : R.expVio
    console.log(`   violations         · ilike '${PROPERTY}'  →  ${fmt(vio.result, vio.elapsedMs, 500)} (expected ${expVio})`)

    // visitor_passes
    const pas = await timed(() => client.from('visitor_passes').select('*').ilike('property', PROPERTY))
    console.log(`   visitor_passes     · ilike '${PROPERTY}'  →  ${fmt(pas.result, pas.elapsedMs, 500)} (expected ${R.expPas})`)

    // vehicles (also swept in Commit 2 — worth confirming under same session)
    const veh = await timed(() => client.from('vehicles').select('id').ilike('property', PROPERTY))
    console.log(`   vehicles           · ilike '${PROPERTY}'  →  ${fmt(veh.result, veh.elapsedMs, 500)}`)

    // guest_authorizations
    const gth = await timed(() => client.from('guest_authorizations').select('id').ilike('property', PROPERTY))
    console.log(`   guest_authorizations · ilike '${PROPERTY}'  →  ${fmt(gth.result, gth.elapsedMs, 500)}`)

    // space_requests (parity fix here)
    const sreq = await timed(() => client.from('space_requests').select('id').ilike('property', PROPERTY))
    console.log(`   space_requests     · ilike '${PROPERTY}'  →  ${fmt(sreq.result, sreq.elapsedMs, 500)}`)

    await client.auth.signOut()
    console.log('')
  }

  console.log('════════════════════════════════════════════════════════')
  console.log('DONE — any ⚠ or ❌ means halt. Only push if all ✓.')
  console.log('════════════════════════════════════════════════════════')
}

main().catch(e => { console.error(e); process.exit(99) })

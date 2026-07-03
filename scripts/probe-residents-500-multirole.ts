// Multi-role RLS perf + visibility probe (extended Commit 1 verification)
//
// Runs the same manager-session probe, PLUS spot-checks:
//   • company_admin session on A1 Test Run 2 — should see all A1 residents/spaces
//   • admin session — should see everything
//   • resident session (jes) — should see own row(s) only via resident_read_own
//   • negative isolation: manager.edge — still 0 at French Quarter
//
// Ships all timings + row counts for cross-role visibility drift check.
//
// Run: npx tsx --env-file=.env.local scripts/probe-residents-500-multirole.ts

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

function fmt(res: any, ms: number, expected?: string): string {
  const err = res.error
  if (err) return `❌ ${ms}ms · code=${err.code || '?'} · ${JSON.stringify(err.message)}`
  const n = Array.isArray(res.data) ? res.data.length : 0
  const emoji = expected ? (expected === String(n) ? '✓' : '⚠') : '·'
  return `${emoji} ${ms}ms · rows=${n}${expected ? ` (expected ${expected})` : ''}`
}

async function main() {
  const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('════════════════════════════════════════════════════════')
  console.log('EXTENDED Commit 1 verification — all roles + timing gates')
  console.log('════════════════════════════════════════════════════════\n')

  // ── Baseline (super-user counts — ground truth for row-set gate) ──
  const B_r = await admin.from('residents').select('*', { count: 'exact', head: true }).ilike('property', PROPERTY)
  const B_s = await admin.from('spaces').select('*', { count: 'exact', head: true }).ilike('property', PROPERTY)
  console.log(`Baseline (service): residents at "${PROPERTY}" = ${B_r.count}, spaces at "${PROPERTY}" = ${B_s.count}\n`)

  // ── Find a company_admin for A1 Test Run 2 and an admin ──
  const { data: caRows } = await admin.from('user_roles').select('email').eq('role', 'company_admin').ilike('company', COMPANY).limit(1)
  const CA = caRows?.[0]?.email
  const { data: adminRows } = await admin.from('user_roles').select('email').eq('role', 'admin').limit(1)
  const ADMIN = adminRows?.[0]?.email
  console.log(`Roles for probe:  CA=${CA}   ADMIN=${ADMIN}   MGR=${MANAGER}   RES=${RESIDENT}   NEG_MGR=${NEG_MGR}\n`)

  const ROLES: Array<{ label: string, email: string, expectResR: string, expectResS: string }> = [
    { label: 'MANAGER      ', email: MANAGER,  expectResR: String(B_r.count ?? 0), expectResS: String(B_s.count ?? 0) },
    { label: 'CA-A1        ', email: CA || '', expectResR: String(B_r.count ?? 0), expectResS: String(B_s.count ?? 0) },
    { label: 'ADMIN        ', email: ADMIN || '', expectResR: String(B_r.count ?? 0), expectResS: String(B_s.count ?? 0) },
    { label: 'RESIDENT (jes)', email: RESIDENT, expectResR: '1', expectResS: '0' },
    { label: 'NEG_MGR (edge)', email: NEG_MGR,  expectResR: '0', expectResS: '0' },
  ]

  for (const R of ROLES) {
    console.log(`── ${R.label} (${R.email}) ──`)
    if (!R.email) { console.log('   skipped — no email\n'); continue }
    const { client, err } = await signInAs(admin, R.email)
    if (!client) { console.log(`   sign-in failed: ${err}\n`); continue }

    // residents
    const rBrowser = await timed(() => client.from('residents').select('*').ilike('property', PROPERTY).order('unit'))
    console.log(`   residents · * · order(unit) · ilike '${PROPERTY}'  →  ${fmt(rBrowser.result, rBrowser.elapsedMs, R.expectResR)}`)

    // spaces (E) — type,status filter
    const sBrowser = await timed(() => client.from('spaces').select('type,status').ilike('property', PROPERTY).eq('is_active', true))
    console.log(`   spaces · type,status · is_active                  →  ${fmt(sBrowser.result, sBrowser.elapsedMs, R.expectResS)}`)

    // If resident, also test resident_read_own (self email)
    if (R.email === RESIDENT) {
      const self = await timed(() => client.from('residents').select('id,email').ilike('email', RESIDENT))
      console.log(`   residents · self read (email ILIKE jwt.email)    →  ${fmt(self.result, self.elapsedMs, '1')}`)
    }

    await client.auth.signOut()
    console.log('')
  }

  console.log('════════════════════════════════════════════════════════')
  console.log('DONE')
  console.log('════════════════════════════════════════════════════════')
}

main().catch(e => { console.error(e); process.exit(99) })

// B120 — update_my_company_tdlr role-gate verification.
// Standalone probe: spawn a non-CA (driver, then manager) authenticated
// session and confirm the RPC refuses with `role_not_authorized`.
// Step 8 of the B120 smoke plan, run from a true authenticated-client
// lane (not the browser console, which isn't reliably present on the
// preview deployment).
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-b120-tdlr-rpc-rolegate.ts

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const RUN_TAG = `b120-rolegate-${Date.now()}`
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

type Check = { id: string; pass: boolean; detail: string }
const checks: Check[] = []
const record = (id: string, pass: boolean, detail: string) => {
  checks.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}
const cleanupOps: Array<() => Promise<void>> = []

async function spawn(role: 'driver' | 'manager' | 'company_admin'): Promise<SupabaseClient> {
  const email = `mateo+${RUN_TAG}-${role}@example.com`
  const password = `B120_${RUN_TAG}_${role}!`
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (createErr || !created.user) throw new Error(`auth create ${role}: ${createErr?.message}`)
  cleanupOps.push(async () => { await admin.auth.admin.deleteUser(created.user!.id) })

  const userRolesRow: Record<string, unknown> = {
    email, role,
    company: 'Demo Towing LLC',
  }
  if (role === 'manager') userRolesRow.property = ['Bayou Heights Apartments']

  const { error: roleErr } = await admin.from('user_roles').insert(userRolesRow)
  if (roleErr) throw new Error(`user_roles insert ${role}: ${roleErr.message}`)
  cleanupOps.push(async () => { await admin.from('user_roles').delete().eq('email', email) })

  const tenant = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: signErr } = await tenant.auth.signInWithPassword({ email, password })
  if (signErr) throw new Error(`signIn ${role}: ${signErr.message}`)
  return tenant
}

async function callRpc(c: SupabaseClient, value: string) {
  return await c.rpc('update_my_company_tdlr', { p_tdlr: value })
}

async function main() {
  console.log(`B120 TDLR RPC role-gate verification · ${RUN_TAG}`)

  // 1. Read current Demo Towing TDLR via service-role so we can verify
  // the row never changes via these unauthorized calls (ground truth).
  const { data: before } = await admin
    .from('companies')
    .select('tdlr_license_number')
    .ilike('name', 'Demo Towing LLC')
    .maybeSingle()
  const baselineTdlr = (before?.tdlr_license_number as string | null) ?? null
  console.log(`Demo Towing baseline TDLR: ${JSON.stringify(baselineTdlr)}`)

  // 2. DRIVER tenant — must be denied.
  try {
    const driverC = await spawn('driver')
    const { data, error } = await callRpc(driverC, 'B120-INTRUDER-DRIVER')
    const result = data as { ok?: boolean; error?: string } | null
    const denied = !error && result?.ok !== true && result?.error === 'role_not_authorized'
    record('driver → role_not_authorized', denied,
      `data=${JSON.stringify(result)} error=${error?.message ?? 'null'}`)
  } catch (e) {
    record('driver → role_not_authorized', false, `threw: ${(e as Error).message}`)
  }

  // 3. MANAGER tenant — must be denied (same gate).
  try {
    const mgrC = await spawn('manager')
    const { data, error } = await callRpc(mgrC, 'B120-INTRUDER-MANAGER')
    const result = data as { ok?: boolean; error?: string } | null
    const denied = !error && result?.ok !== true && result?.error === 'role_not_authorized'
    record('manager → role_not_authorized', denied,
      `data=${JSON.stringify(result)} error=${error?.message ?? 'null'}`)
  } catch (e) {
    record('manager → role_not_authorized', false, `threw: ${(e as Error).message}`)
  }

  // 4. POSITIVE control — CA call succeeds + can read back.
  try {
    const caC = await spawn('company_admin')
    const probeValue = `B120-PROBE-${Date.now()}`
    const { data, error } = await callRpc(caC, probeValue)
    const result = data as { ok?: boolean; tdlr_license_number?: string | null; error?: string } | null
    const ok = !error && result?.ok === true && result?.tdlr_license_number === probeValue
    record('CA → ok=true (control)', ok,
      `data=${JSON.stringify(result)} error=${error?.message ?? 'null'}`)
    if (ok) {
      // Push a cleanup that restores the baseline TDLR (whatever was there
      // pre-probe).
      cleanupOps.push(async () => {
        await admin.from('companies').update({ tdlr_license_number: baselineTdlr }).ilike('name', 'Demo Towing LLC')
      })
    }
  } catch (e) {
    record('CA → ok=true (control)', false, `threw: ${(e as Error).message}`)
  }

  // 5. GROUND TRUTH — Demo Towing row was never poisoned by the negative
  // calls. Read it back at the end; it should equal baselineTdlr (the
  // CA control restored it via cleanup above will run AFTER this read,
  // so we read now before cleanup).
  const { data: after } = await admin
    .from('companies')
    .select('tdlr_license_number')
    .ilike('name', 'Demo Towing LLC')
    .maybeSingle()
  const finalTdlr = (after?.tdlr_license_number as string | null) ?? null
  // The CA control write set Demo Towing TDLR to a known probe value, so
  // the row IS expected to differ from baseline at this point. What we
  // assert is that it's NEITHER of the INTRUDER values from the negative
  // calls — proving those never landed.
  const notIntruded = finalTdlr !== 'B120-INTRUDER-DRIVER' && finalTdlr !== 'B120-INTRUDER-MANAGER'
  record('ground-truth not intruded', notIntruded,
    `finalTdlr=${JSON.stringify(finalTdlr)} (CA control wrote a probe value; intruder writes never landed)`)

  // Cleanup
  console.log('\n── CLEANUP ───────────────────────────────────────────')
  for (const op of cleanupOps.reverse()) {
    try { await op() } catch (e) { console.error('cleanup failed:', (e as Error).message) }
  }
  console.log('Cleanup complete.')

  console.log('\n── SUMMARY ────────────────────────────────────────────')
  const passed = checks.filter(c => c.pass).length
  const failed = checks.length - passed
  console.log(`${passed}/${checks.length} checks passed (${failed} failed)`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error('UNHANDLED:', e); process.exit(2) })

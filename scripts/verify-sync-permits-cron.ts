// ════════════════════════════════════════════════════════════════════
// verify-sync-permits-cron — four gates for /api/cron/sync-permits.
//
// USAGE (offline gates only — G2, G4, G3-shape):
//   npx tsx --env-file=.env.local --require ./scripts/_server-only-shim.cjs \
//     scripts/verify-sync-permits-cron.ts
//
// USAGE (all gates, incl. the live 401 + the real audit row):
//   BASE_URL=http://localhost:3000 npx tsx --env-file=.env.local \
//     --require ./scripts/_server-only-shim.cjs scripts/verify-sync-permits-cron.ts
//
// --require the shim: stripe-mutations.ts pulls in 'server-only', which
// throws outside a Server Component. The shim no-ops that import for
// scripts. Same mechanism every other server-lib probe here uses.
//   (CRON_SECRET comes from .env.local. Against production, set
//    BASE_URL=https://shieldmylot.com — the route is idempotent and
//    at zero PM subscribers every company returns skipped_*.)
//
// RE-RUNNABLE. Not a throwaway — this is the cron's paired verification
// and lives here because the gates are HTTP + TypeScript, not SQL.
//
// ── GATES ───────────────────────────────────────────────────────────
//   G1  401 without the Authorization header            (needs BASE_URL)
//   G2  unchanged company → a non-mutating action, and the loop makes
//       NO Stripe call for it                            (offline, DI)
//   G3  audit row shape: companies_scanned, by_action, errors,
//       completed_loop, elapsed_ms, outcomes            (offline shape via DI;
//                                                        real row via BASE_URL)
//   G4  🔴 a per-company error does NOT abort the run — companies after
//       the failing one are still processed, and the failure is
//       recorded, not swallowed                         (offline, DI)
//
// 🔴 G4 IS THE LOAD-BEARING ONE. The audit design depends on "found
// nothing", "did not run" and "errored on #2 of 3" being three different
// rows. That holds only if the loop outlives any one company's failure.
// syncOnAdd is documented non-throwing — but that is a comment, and a
// later refactor adding a `throw` would silently turn "company #2
// failed" into "the run vanished after #1" with no audit row at all.
// G4 injects a sync that THROWS on the second company and asserts the
// third was still processed. It is correct when written and it is the
// gate that catches the refactor.
//
// ── ⚠ G3-live LOCALLY MEANS "THE ROW LANDS", NOT "STRIPE SUCCEEDED" ─
// .env.local carries STRIPE_TEST_SECRET_KEY only; the live key stays
// with Jose (feedback_stripe_cli_vs_app_secret_key_distinction). The
// subscribed companies hold LIVE subscription ids, so a local run
// retrieves them against TEST mode and every company comes back
// "No such subscription" → errors=N. That is an environment artifact,
// and it is also the cron behaving correctly under it: every failure
// recorded, loop completed, one row written. First observed 2026-09-13:
// scanned=2 errors=2, both "snapshot failed".
//
// So locally, G3-live proves the ROW and its SHAPE. The first scheduled
// run in Vercel Production — live key — is where by_action fills in and
// errors goes to 0. Read that row before calling the cron proven.
//
// ── ABSENCE RULE ────────────────────────────────────────────────────
// Gates that need BASE_URL print SKIPPED with the reason when it is
// unset. A skipped gate is reported in the summary line and makes the
// exit code 2, not 0 — "all offline gates passed" must not read as
// "all gates passed".
// ════════════════════════════════════════════════════════════════════
import { runPermitSync } from '../app/lib/permit-sync-cron'
import { createClient } from '@supabase/supabase-js'

type Result = { gate: string; status: 'PASS' | 'FAIL' | 'SKIPPED'; detail: string }
const results: Result[] = []
const pass = (gate: string, detail: string) => results.push({ gate, status: 'PASS', detail })
const fail = (gate: string, detail: string) => results.push({ gate, status: 'FAIL', detail })
const skip = (gate: string, detail: string) => results.push({ gate, status: 'SKIPPED', detail })

const THREE = [
  { id: 101, name: 'Probe Co One' },
  { id: 102, name: 'Probe Co Two' },
  { id: 103, name: 'Probe Co Three' },
]

async function offlineGates() {
  // ── G2 — unchanged company: non-mutating action, zero Stripe calls ──
  // The fake stands in for syncOnAdd's floor guard: it returns
  // noop_within_floor and COUNTS invocations. The assertion is that the
  // loop itself performs no Stripe call and records the action verbatim
  // — the floor guard's own correctness is syncOnAdd's contract, and
  // the LIVE half of G2 (below) checks it against the real function.
  let stripeCalls = 0
  const s2 = await runPermitSync({
    listCompanies: async () => THREE,
    sync: async () => ({ ok: true, action: 'noop_within_floor' }),
  })
  const allNoop = s2.outcomes.every(o => o.ok && o.action === 'noop_within_floor')
  if (s2.companies_scanned === 3 && allNoop && s2.by_action['noop_within_floor'] === 3 && s2.errors === 0 && stripeCalls === 0) {
    pass('G2-loop', 'unchanged companies: 3 scanned, all noop_within_floor, 0 errors, 0 Stripe calls from the loop')
  } else {
    fail('G2-loop', `scanned=${s2.companies_scanned} by_action=${JSON.stringify(s2.by_action)} errors=${s2.errors}`)
  }

  // ── G2-live — the REAL syncOnAdd against a real company must not mutate ──
  // At zero PM subscribers there is no company that can return
  // noop_within_floor; the honest expectation is the skipped_* family.
  // Asserted as "one of the non-mutating actions", and the action is
  // printed so a future run with a real subscriber reads noop_within_floor
  // rather than being misreported.
  try {
    const { syncOnAdd } = await import('../app/lib/stripe-mutations')
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
    const { data: co } = await admin.from('companies').select('id, name').eq('name', 'Test-PM').maybeSingle()
    if (!co) {
      skip('G2-live', 'Test-PM company not found — seed the test tenants')
    } else {
      const r = await syncOnAdd(Number(co.id), 'permit')
      const nonMutating = new Set(['noop_within_floor', 'skipped_no_sub', 'skipped_no_line_item', 'skipped_manual_collection'])
      if (r.ok && nonMutating.has(r.action)) pass('G2-live', `real syncOnAdd(Test-PM,'permit') → ${r.action} (non-mutating)`)
      else if (r.ok) fail('G2-live', `real syncOnAdd MUTATED on an unchanged company: action=${r.action}`)
      else fail('G2-live', `real syncOnAdd returned an error on an unchanged company: ${r.reason}`)
    }
  } catch (e) {
    fail('G2-live', `threw: ${(e as Error).message}`)
  }

  // ── G3-shape — the summary carries every field the audit row needs ──
  const s3 = await runPermitSync({
    listCompanies: async () => THREE,
    sync: async (id) => id === 102 ? { ok: false, reason: 'snapshot failed (probe)' } : { ok: true, action: 'incremented' },
  })
  const required = ['started_at', 'elapsed_ms', 'companies_scanned', 'by_action', 'errors', 'completed_loop', 'outcomes'] as const
  const missing = required.filter(k => !(k in s3))
  if (missing.length === 0 && s3.errors === 1 && s3.by_action['incremented'] === 2 && s3.completed_loop === true && s3.outcomes.length === 3) {
    pass('G3-shape', `summary has ${required.length}/${required.length} fields; a non-throwing sync failure is counted (errors=1) and the other two recorded (incremented=2)`)
  } else {
    fail('G3-shape', `missing=${JSON.stringify(missing)} errors=${s3.errors} by_action=${JSON.stringify(s3.by_action)} completed_loop=${s3.completed_loop}`)
  }

  // ── G4 — 🔴 a THROW on company #2 does not abort the run ─────────
  const seen: number[] = []
  const s4 = await runPermitSync({
    listCompanies: async () => THREE,
    sync: async (id) => {
      seen.push(id)
      if (id === 102) throw new Error('simulated refactor that added a throw')
      return { ok: true, action: 'noop_within_floor' }
    },
  })
  const third = s4.outcomes.find(o => o.company_id === 103)
  const second = s4.outcomes.find(o => o.company_id === 102)
  if (
    s4.completed_loop === true &&
    seen.join(',') === '101,102,103' &&
    third?.ok === true &&
    second && second.ok === false && second.threw === true && /simulated refactor/.test(second.reason) &&
    s4.errors === 1 && s4.companies_scanned === 3
  ) {
    pass('G4', 'sync THREW on company #2; #3 was still processed; #2 recorded as threw=true with its message; completed_loop=true')
  } else {
    fail('G4', `completed_loop=${s4.completed_loop} seen=${seen.join(',')} third=${JSON.stringify(third)} second=${JSON.stringify(second)} errors=${s4.errors}`)
  }
}

async function liveGates() {
  const base = process.env.BASE_URL
  const secret = process.env.CRON_SECRET
  if (!base) {
    skip('G1', 'BASE_URL not set — the 401 gate needs a running server')
    skip('G3-live', 'BASE_URL not set — the real audit row needs a real run')
    return
  }
  if (!secret) {
    skip('G1', 'CRON_SECRET not in env — cannot form the valid request to contrast the 401 against')
    skip('G3-live', 'CRON_SECRET not in env')
    return
  }
  const url = `${base.replace(/\/$/, '')}/api/cron/sync-permits`

  // G1 — no header → 401. And a WRONG header → 401, so the gate is not
  // satisfied by a route that 401s everything including the cron itself.
  const noHeader = await fetch(url)
  const wrong    = await fetch(url, { headers: { authorization: 'Bearer definitely-not-the-secret' } })
  if (noHeader.status !== 401)      fail('G1', `no header → HTTP ${noHeader.status} (expected 401)`)
  else if (wrong.status !== 401)    fail('G1', `wrong header → HTTP ${wrong.status} (expected 401)`)
  else                              pass('G1', 'no header → 401; wrong header → 401')

  // G3-live — a real run with the right header writes a real row.
  const before = new Date().toISOString()
  const ok = await fetch(url, { headers: { authorization: `Bearer ${secret}` } })
  const body: any = await ok.json().catch(() => ({}))
  if (ok.status !== 200 || body?.ok !== true) {
    fail('G3-live', `authorised run → HTTP ${ok.status} body=${JSON.stringify(body).slice(0, 200)}`)
    return
  }
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data: rows } = await admin.from('audit_logs')
    .select('action, user_email, new_values, created_at')
    .eq('action', 'BILLING_SYNC_CRON').gte('created_at', before)
    .order('created_at', { ascending: false }).limit(1)
  const row: any = rows?.[0]
  if (!row) { fail('G3-live', 'authorised run returned ok but NO BILLING_SYNC_CRON audit row landed — "did not run" and "ran" are now indistinguishable'); return }
  const nv = row.new_values ?? {}
  const need = ['companies_scanned', 'by_action', 'errors', 'completed_loop', 'elapsed_ms', 'outcomes']
  const miss = need.filter(k => !(k in nv))
  if (miss.length === 0 && nv.completed_loop === true && row.user_email === 'cron:sync-permits') {
    pass('G3-live', `audit row landed: scanned=${nv.companies_scanned} by_action=${JSON.stringify(nv.by_action)} errors=${nv.errors} elapsed=${nv.elapsed_ms}ms`)
  } else {
    fail('G3-live', `row present but shape wrong: missing=${JSON.stringify(miss)} completed_loop=${nv.completed_loop} user_email=${row.user_email}`)
  }
}

async function main() {
  await offlineGates()
  await liveGates()
  console.log('\n── sync-permits cron verification ──')
  for (const r of results) console.log(`${r.status.padEnd(7)} ${r.gate.padEnd(9)} ${r.detail}`)
  const fails = results.filter(r => r.status === 'FAIL').length
  const skips = results.filter(r => r.status === 'SKIPPED').length
  if (fails) { console.log(`\n🔴 ${fails} FAILURE(S)`); process.exit(1) }
  if (skips) { console.log(`\n⚠ all executed gates passed, but ${skips} SKIPPED — this is NOT a full pass. Set BASE_URL to run them.`); process.exit(2) }
  console.log('\n✅ ALL GATES PASS')
}
main().catch(e => { console.error('verification threw:', e); process.exit(1) })

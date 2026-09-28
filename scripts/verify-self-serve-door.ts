// ════════════════════════════════════════════════════════════════════
// GATE — the self-serve door shows ONLY when signup is actually open
// ════════════════════════════════════════════════════════════════════
//
// Both states are asserted, which is the point: "hidden today" is easy
// to demonstrate by accident (anything broken hides it), so the gate
// must also prove the line APPEARS when the check says open. A guard
// that refuses everything passes every negative test.
//
// The decision is a pure function precisely so the open state can be
// exercised with the probe mocked, without flipping a production flag.
//
// Usage:  npx tsx scripts/verify-self-serve-door.ts
import { shouldShowSelfServe, probeSelfServeOpen } from '../app/lib/self-serve-door'

let failures = 0
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(62)} got ${String(got)}, want ${String(want)}`)
}

// ── The rule ────────────────────────────────────────────────────────
check('S1  { open: true } shows the door',            shouldShowSelfServe({ open: true }), true)
check('S2  { open: false } hides it',                 shouldShowSelfServe({ open: false }), false)
check('S3  {} hides it (absence is not yes)',         shouldShowSelfServe({}), false)
check('S4  null hides it',                            shouldShowSelfServe(null), false)
check('S5  "true" the STRING hides it',               shouldShowSelfServe({ open: 'true' }), false)
check('S6  { open: 1 } hides it',                     shouldShowSelfServe({ open: 1 }), false)

// ── The probe, with fetch mocked in both directions ─────────────────
const res = (ok: boolean, body: unknown) =>
  ({ ok, json: async () => body }) as unknown as Response

const main = async () => {
  check('P1  200 { open: true }  → SHOWS',
    await probeSelfServeOpen(async () => res(true, { open: true })), true)
  check('P2  200 { open: false } → hides',
    await probeSelfServeOpen(async () => res(true, { open: false })), false)
  check('P3  non-200 → hides (could not check is not yes)',
    await probeSelfServeOpen(async () => res(false, { open: true })), false)
  check('P4  fetch throws → hides',
    await probeSelfServeOpen(async () => { throw new Error('offline') }), false)
  check('P5  body is not JSON → hides',
    await probeSelfServeOpen(async () => ({ ok: true, json: async () => { throw new Error('bad json') } }) as unknown as Response), false)

  console.log('')
  if (failures) { console.log(`❌ ${failures} FAILURE(S).`); process.exit(1) }
  console.log('✅ ALL SELF-SERVE DOOR GATES PASS — hidden by default, shown only on an explicit open.')
}
main().catch(e => { console.error('FATAL', e); process.exit(2) })

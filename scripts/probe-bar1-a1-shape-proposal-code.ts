// BAR-1 fix probe — A1-shape proposal-code line-item derivation.
//
// Verifies the launch-critical fix in app/lib/proposal-code-stripe.ts
// (lineItemsForCode) that unblocks A1's code generation:
//   1. per_driver retirement — Enforcement no longer iterates a stale
//      per_driver row (was throwing on platform_settings resolution).
//   2. Legacy $0-override omit — Architect Option (b): when admin sets
//      an EXPLICIT $0 override on a Legacy code, that line is omitted
//      entirely so the subscription is base-only (A1's shape).
//
// Pure-function probe — no Stripe API calls, no DB. Runs in ms. Complements
// (does not replace) Jose's throwaway A1-shape live redemption dry-run,
// which validates the end-to-end Stripe path.
//
// Assertions:
//   [1] A1's shape (Enforcement / Legacy / base=set / per_property=$0)
//       → line items = ['base'] ONLY. No per_driver, no per_property.
//   [2] Enforcement / enforcement_only (non-Legacy) → ['base','per_property'].
//       Confirms per_driver is fully retired for non-Legacy Enforcement.
//   [3] Legacy Enforcement with per_property > $0 override → ['base','per_property'].
//       $0-omit does NOT fire when the override is positive.
//   [4] Legacy PM-Only with per_property = $0 override → ['base'].
//       Same omit logic works on the PM track.
//   [5] Legacy Enforcement with per_property override = NULL (fallback) →
//       ['base','per_property']. Guardrail: NEVER omit based on a
//       fallback-resolved-to-0; omit fires ONLY on an EXPLICIT $0 override.
//   [6] Non-Legacy enforcement_only with per_property override = 0 →
//       ['base','per_property']. Non-Legacy codes always get the full
//       track set regardless of override value.
//
// Run: npx tsx scripts/probe-bar1-a1-shape-proposal-code.ts

import { lineItemsForCode } from '../app/lib/proposal-code-stripe'

function eq(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function main() {
  console.log('══ BAR-1 A1-SHAPE PROPOSAL-CODE PROBE ══════════════════════════')
  console.log('  Pure-function probe on lineItemsForCode() — no Stripe/DB.\n')

  // ── [1] A1's shape — the exact scenario blocking launch ────────────
  console.log('─── [1] A1 shape (Enforcement Legacy, base custom, per_property=$0) ─')
  const a1 = lineItemsForCode({
    base_tier_type: 'enforcement', base_tier: 'legacy',
    custom_base_fee: 199, custom_per_property_fee: 0,
  })
  const test1 = eq(a1, ['base'])
  console.log(`  result: ${JSON.stringify(a1)} (expect ['base'])`)
  console.log(`  [1] ${test1 ? '🟢 PASS — A1 shape base-only' : '🔴 FAIL'}\n`)

  // ── [2] Enforcement-Only (non-Legacy) — per_driver retired ─────────
  console.log('─── [2] Enforcement / enforcement_only — per_driver retired ─────')
  const enfOnly = lineItemsForCode({
    base_tier_type: 'enforcement', base_tier: 'enforcement_only' as any,
    custom_base_fee: null, custom_per_property_fee: null,
  })
  const test2 = eq(enfOnly, ['base', 'per_property'])
  console.log(`  result: ${JSON.stringify(enfOnly)} (expect ['base','per_property'])`)
  console.log(`  [2] ${test2 ? '🟢 PASS — no per_driver in loop' : '🔴 FAIL'}\n`)

  // ── [3] Legacy Enforcement with per_property > $0 override ─────────
  console.log('─── [3] Legacy Enforcement, per_property=$15 override — no omit ─')
  const legEnfPosPP = lineItemsForCode({
    base_tier_type: 'enforcement', base_tier: 'legacy',
    custom_base_fee: 150, custom_per_property_fee: 15,
  })
  const test3 = eq(legEnfPosPP, ['base', 'per_property'])
  console.log(`  result: ${JSON.stringify(legEnfPosPP)} (expect ['base','per_property'])`)
  console.log(`  [3] ${test3 ? '🟢 PASS — positive override kept' : '🔴 FAIL'}\n`)

  // ── [4] Legacy PM-Only with per_property=$0 override ───────────────
  console.log('─── [4] Legacy PM-Only, per_property=$0 override — omit fires ───')
  const legPmZeroPP = lineItemsForCode({
    base_tier_type: 'property_management', base_tier: 'legacy',
    custom_base_fee: 250, custom_per_property_fee: 0,
  })
  const test4 = eq(legPmZeroPP, ['base'])
  console.log(`  result: ${JSON.stringify(legPmZeroPP)} (expect ['base'])`)
  console.log(`  [4] ${test4 ? '🟢 PASS — PM $0-omit works too' : '🔴 FAIL'}\n`)

  // ── [5] Legacy Enforcement with per_property=NULL — GUARDRAIL ──────
  console.log('─── [5] GUARDRAIL — NULL override does NOT trigger omit ──────────')
  const legEnfNullPP = lineItemsForCode({
    base_tier_type: 'enforcement', base_tier: 'legacy',
    custom_base_fee: 200, custom_per_property_fee: null,
  })
  const test5 = eq(legEnfNullPP, ['base', 'per_property'])
  console.log(`  result: ${JSON.stringify(legEnfNullPP)} (expect ['base','per_property'])`)
  console.log(`  [5] ${test5 ? '🟢 PASS — NULL override triggers fallback, not omit' : '🔴 FAIL — CRITICAL: NULL misinterpreted as $0'}\n`)

  // ── [6] Non-Legacy with $0 override — omit does NOT fire ───────────
  console.log('─── [6] GUARDRAIL — non-Legacy $0 override does NOT omit ────────')
  const nonLegZeroPP = lineItemsForCode({
    base_tier_type: 'enforcement', base_tier: 'enforcement_only' as any,
    custom_base_fee: null, custom_per_property_fee: 0,
  })
  const test6 = eq(nonLegZeroPP, ['base', 'per_property'])
  console.log(`  result: ${JSON.stringify(nonLegZeroPP)} (expect ['base','per_property'])`)
  console.log(`  [6] ${test6 ? '🟢 PASS — omit gated on Legacy only' : '🔴 FAIL — CRITICAL: silently drops line on non-Legacy'}\n`)

  const allPass = test1 && test2 && test3 && test4 && test5 && test6
  console.log('════════════════════════════════════════════════════════════════')
  console.log(`OVERALL: ${allPass ? '🟢🟢 ALL PASS' : '🔴 FAIL — investigate above'}`)
  console.log(`[1] A1 shape: ${test1 ? '🟢' : '🔴'}  [2] per_driver retired: ${test2 ? '🟢' : '🔴'}  [3] positive override kept: ${test3 ? '🟢' : '🔴'}  [4] PM $0-omit: ${test4 ? '🟢' : '🔴'}  [5] NULL guardrail: ${test5 ? '🟢' : '🔴'}  [6] non-Legacy guardrail: ${test6 ? '🟢' : '🔴'}`)
  process.exit(allPass ? 0 : 1)
}

main()

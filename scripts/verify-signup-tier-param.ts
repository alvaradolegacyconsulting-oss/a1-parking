// ════════════════════════════════════════════════════════════════════
// GATE — /signup plan tokens → (track, backend tier)
// ════════════════════════════════════════════════════════════════════
//
// Runs against a page that is LIVE AND TAKING SIGNUPS, and the pair a
// token resolves to is persisted into user_metadata.intended_tier and
// read to pick Stripe Price IDs. The two things that must hold:
//
//   • every token resolves to the RIGHT pair — in particular the two
//     that share the `legacy` tier and differ only by track, which is
//     the whole reason the map replaced a one-line heuristic;
//   • everything else falls back to the default rather than passing
//     through. create-checkout-session validates intended_tier's shape
//     but NOT its vocabulary, so an unrecognised tier would pass its
//     400 and fail later as a 503 — after the account exists.
//
// Usage:  npx tsx scripts/verify-signup-tier-param.ts
import {
  resolveInitialToken, DEFAULT_TOKEN, planFor, displayName, isPlanToken,
  PLANS, PICKER_TOKENS, FORMERLY_LABELS_ON, type PlanToken,
} from '../app/lib/signup-tier-param'

let failures = 0
const chk = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(58)} ${ok ? '' : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

// ── Every token → (track, tier). The whole table, not a sample. ─────
const EXPECTED: Record<PlanToken, { track: string; tier: string }> = {
  pm_starter:       { track: 'property_management', tier: 'pm_starter' },
  pm_pro:           { track: 'property_management', tier: 'legacy' },
  operator_starter: { track: 'enforcement',         tier: 'enforcement_only' },
  operator_pro:     { track: 'enforcement',         tier: 'legacy' },
  enforcement_only: { track: 'enforcement',         tier: 'enforcement_only' },
}
for (const t of Object.keys(EXPECTED) as PlanToken[]) {
  const p = planFor(t)
  chk(`M  ${t}`, { track: p.track, tier: p.tier }, EXPECTED[t])
}

// 🔴 The pair that a tier alone cannot distinguish. If these two ever
// collapse to the same track, PM Pro buyers go to the enforcement
// catalog and are charged the wrong plan.
chk('M  pm_pro and operator_pro share the tier',
  planFor('pm_pro').tier === planFor('operator_pro').tier, true)
chk('M  ...but NOT the track',
  planFor('pm_pro').track !== planFor('operator_pro').track, true)

// 🔴 The alias. Links already exist in the wild — the PM page's
// self-serve line, anything printed, anything shared. If this stops
// resolving, those links silently land on the default plan.
chk('M  enforcement_only resolves identically to operator_starter',
  { ...planFor('enforcement_only'), token: null, label: null, formerly: null },
  { ...planFor('operator_starter'), token: null, label: null, formerly: null })

// ── Accepted from the URL ───────────────────────────────────────────
chk('T1  ?tier=pm_starter',          resolveInitialToken('?tier=pm_starter'), 'pm_starter')
chk('T2  ?tier=pm_pro',              resolveInitialToken('?tier=pm_pro'), 'pm_pro')
chk('T3  ?tier=operator_starter',    resolveInitialToken('?tier=operator_starter'), 'operator_starter')
chk('T4  ?tier=operator_pro',        resolveInitialToken('?tier=operator_pro'), 'operator_pro')
chk('T5  ?tier=enforcement_only',    resolveInitialToken('?tier=enforcement_only'), 'enforcement_only')
chk('T6  alongside other params',    resolveInitialToken('?src=haa-print&tier=pm_pro'), 'pm_pro')
chk('T7  surrounding whitespace',    resolveInitialToken('?tier=%20pm_pro%20'), 'pm_pro')

// ── Ignored — every one lands on the default ────────────────────────
chk('T8  absent',                    resolveInitialToken('?src=haa-print'), DEFAULT_TOKEN)
chk('T9  empty search',              resolveInitialToken(''), DEFAULT_TOKEN)
chk('T10 null',                      resolveInitialToken(null), DEFAULT_TOKEN)
chk('T11 ?tier= (empty value)',      resolveInitialToken('?tier='), DEFAULT_TOKEN)
chk('T12 a retired tier name',       resolveInitialToken('?tier=pm_only'), DEFAULT_TOKEN)
chk('T13 the BACKEND tier legacy',   resolveInitialToken('?tier=legacy'), DEFAULT_TOKEN)
chk('T14 custom_quote',              resolveInitialToken('?tier=custom_quote'), DEFAULT_TOKEN)
chk('T15 case variant',              resolveInitialToken('?tier=PM_PRO'), DEFAULT_TOKEN)
chk('T16 junk',                      resolveInitialToken('?tier=%3Cscript%3E'), DEFAULT_TOKEN)
chk('T17 repeated param takes first',resolveInitialToken('?tier=pm_pro&tier=legacy'), 'pm_pro')

// 🔴 `legacy` is a BACKEND tier, never a URL token. T13 proves a link
// written with the backend name does not select a plan — it falls back,
// because `legacy` alone cannot say which track it means.
chk('T18 isPlanToken rejects legacy', isPlanToken('legacy'), false)

// ── The picker and the transition labels ────────────────────────────
chk('P1  four cards, in order', PICKER_TOKENS,
  ['pm_starter', 'pm_pro', 'operator_starter', 'operator_pro'])
chk('P2  the alias is NOT a fifth card', PICKER_TOKENS.includes('enforcement_only' as PlanToken), false)
chk('P3  every card has copy for its own token',
  PICKER_TOKENS.every(t => !!PLANS[t]), true)
// The switch, asserted in BOTH positions, so flipping it later is a
// change someone has to mean rather than discover.
chk('P4  formerly-labels switch is currently ON', FORMERLY_LABELS_ON, true)
chk('P5  ...and it is what adds the suffix', displayName('operator_pro'),
  FORMERLY_LABELS_ON ? 'Operator Pro (formerly Legacy)' : 'Operator Pro')
chk('P6  plans with no former name never get a suffix', displayName('pm_pro'), 'PM Pro')

// ── The default itself, asserted not assumed ───────────────────────
chk('D1  DEFAULT_TOKEN is operator_starter', DEFAULT_TOKEN, 'operator_starter')

console.log('')
if (failures) { console.log(`❌ ${failures} FAILURE(S).`); process.exit(1) }
console.log('✅ ALL PLAN-TOKEN GATES PASS — every token maps, everything else falls back.')

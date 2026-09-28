// ════════════════════════════════════════════════════════════════════
// GATE — /signup ?tier= preselect. Allowlist, and the default survives.
// ════════════════════════════════════════════════════════════════════
//
// This runs against a page that is LIVE AND TAKING SIGNUPS, and the
// value it picks is persisted into user_metadata.intended_tier and read
// later to resolve Stripe Price IDs. The two things that must hold:
//
//   • the two real values are accepted, and
//   • EVERYTHING else falls back to today's default rather than being
//     passed through.
//
// The second matters more than it looks: create-checkout-session
// validates intended_tier's shape but NOT its vocabulary, so an
// unrecognised tier would pass its 400 gate and fail later as a 503 at
// catalog resolution — after the account exists.
//
// Usage:  npx tsx scripts/verify-signup-tier-param.ts
import { resolveInitialTier, DEFAULT_TIER } from '../app/lib/signup-tier-param'

let failures = 0
const check = (name: string, got: string, want: string) => {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(56)} got ${got.padEnd(17)} want ${want}`)
}

// ── Accepted ────────────────────────────────────────────────────────
check('T1  ?tier=pm_starter',            resolveInitialTier('?tier=pm_starter'), 'pm_starter')
check('T2  ?tier=enforcement_only',      resolveInitialTier('?tier=enforcement_only'), 'enforcement_only')
check('T3  alongside other params',      resolveInitialTier('?src=haa-print&tier=pm_starter'), 'pm_starter')
check('T4  surrounding whitespace',      resolveInitialTier('?tier=%20pm_starter%20'), 'pm_starter')

// ── Ignored — every one of these must land on the default ───────────
check('T5  absent',                      resolveInitialTier('?src=haa-print'), DEFAULT_TIER)
check('T6  empty search',                resolveInitialTier(''), DEFAULT_TIER)
check('T7  null',                        resolveInitialTier(null), DEFAULT_TIER)
check('T8  ?tier= (empty value)',        resolveInitialTier('?tier='), DEFAULT_TIER)
check('T9  a retired tier name',         resolveInitialTier('?tier=pm_only'), DEFAULT_TIER)
check('T10 legacy (never self-serve)',   resolveInitialTier('?tier=legacy'), DEFAULT_TIER)
check('T11 custom_quote routing card',   resolveInitialTier('?tier=custom_quote'), DEFAULT_TIER)
check('T12 case variant',                resolveInitialTier('?tier=PM_STARTER'), DEFAULT_TIER)
check('T13 junk',                        resolveInitialTier('?tier=%3Cscript%3E'), DEFAULT_TIER)
check('T14 repeated param takes first',  resolveInitialTier('?tier=pm_starter&tier=legacy'), 'pm_starter')

// 🔴 The default itself is asserted, not assumed. If someone changes it,
// this fails and they have to mean it.
check('T15 DEFAULT_TIER is unchanged',   DEFAULT_TIER, 'enforcement_only')

console.log('')
if (failures) { console.log(`❌ ${failures} FAILURE(S).`); process.exit(1) }
console.log('✅ ALL TIER-PARAM GATES PASS — two values accepted, everything else falls back.')

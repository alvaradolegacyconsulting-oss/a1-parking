// ════════════════════════════════════════════════════════════════════
// GATE — priority support is Elite only
// ════════════════════════════════════════════════════════════════════
//
// 🔴 The CA Plan tab renders a "Priority support" row straight off this
// flag (company_admin/page.tsx), so the flag IS the customer-facing
// claim. Before 2026-10-22 it was true on PM Starter ($149) and false
// on Operator Starter ($199) — a $50-cheaper plan advertising more
// support than the dearer one, and all of it contradicting the help
// docs. Jose's ruling: no self-serve plan shows it.
//
// Elite gets it through its proposal code's feature_overrides, which
// hasFeature() consults BEFORE the tier map — so this gate asserts the
// tier map only, and asserting the override path would need a code.
//
// Imports app/lib/tier.ts, whose module graph pulls in the browser
// Supabase client, so it needs the env file even though hasFeature is pure.
//
// Usage: npx tsx --env-file=.env.local scripts/verify-priority-support-elite-only.ts

import fs from 'fs'
import { TIER_CONFIG } from '../app/lib/tier-config'
import { FEATURE_FLAGS } from '../app/lib/feature-flags'
import { hasFeature } from '../app/lib/tier'

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

console.log('\n══ priority support: Elite only ══\n')

const SELF_SERVE: [string, 'enforcement' | 'property_management', string][] = [
  ['PM Starter', 'property_management', 'pm_starter'],
  ['PM Pro', 'property_management', 'legacy'],
  ['Operator Starter', 'enforcement', 'enforcement_only'],
  ['Operator Pro', 'enforcement', 'legacy'],
]

for (const [label, track, tier] of SELF_SERVE) {
  const v = hasFeature(FEATURE_FLAGS.PRIORITY_SUPPORT, { tier: tier as never, tier_type: track, proposal_code: null })
  chk(`🔴 ${label} does NOT have priority support`, v === false, `flag = ${String(v)}`)
}

// 🔴 The override path must still work, or Elite has no way to get it.
// Proven by construction rather than assumed: a code carrying the
// override flips the same call to true.
const withOverride = hasFeature(FEATURE_FLAGS.PRIORITY_SUPPORT, {
  tier: 'legacy' as never, tier_type: 'enforcement',
  proposal_code: { feature_overrides: { [FEATURE_FLAGS.PRIORITY_SUPPORT]: true } } as never,
})
chk('the proposal-code override still grants it — that is how Elite gets it',
  withOverride === true, `with override = ${String(withOverride)}`)

// A tier that is simply missing the key would also read false, which is
// the right answer but for the wrong reason. Assert the key is present
// and explicitly false on the two shapes that used to carry true.
const src = fs.readFileSync('app/lib/tier-config.ts', 'utf8')
const explicit = (src.match(/\[F\.PRIORITY_SUPPORT\]: false/g) ?? []).length
chk('🔴 the flag is written explicitly, not left to inheritance', explicit >= 5,
  `${explicit} explicit false(s) — inheritance alone would silently flip back if a base shape changed`)

// 🔴 SCOPED TO THE FOUR SELF-SERVE PLANS, deliberately. Jose's ruling
// covers what a self-serve subscriber is shown. pm_only is negotiated-
// only and unreachable from /signup, and premium/enterprise are dead
// back-compat values kept for displaying old proposal codes — asserting
// over those would force changes nobody ruled on. They are PRINTED
// below instead of asserted, so nothing hides behind the narrower scope.
const selfServeKeys = SELF_SERVE.map(([, t, ti]) => `${t}/${ti}`)
const others: string[] = []
for (const [track, tiers] of Object.entries(TIER_CONFIG)) {
  for (const [tier, cfg] of Object.entries(tiers)) {
    const k = `${track}/${tier}`
    if (selfServeKeys.includes(k)) continue
    if ((cfg as Record<string, unknown>)[FEATURE_FLAGS.PRIORITY_SUPPORT] === true) others.push(k)
  }
}
console.log(`\nℹ️  non-self-serve tiers still carrying the flag: ${others.length ? others.join(', ') : 'none'}`)
console.log('   (negotiated + dead back-compat values; not part of this ruling)')

console.log(fails ? `\n❌ ${fails} failed` : '\n✅ all green')
process.exit(fails ? 1 : 0)

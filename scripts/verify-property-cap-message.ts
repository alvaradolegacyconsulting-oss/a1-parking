// ════════════════════════════════════════════════════════════════════
// GATE — the property ceiling names the right next step, in one place
// ════════════════════════════════════════════════════════════════════
//
// 🔴 The defect this closes was not a wrong string, it was THREE strings
// where one was needed. The pre-flight layer fires before the trigger
// translation, so the pre-flight's "Elite" answer was the only one a PM
// Starter subscriber ever saw, while the correct PM Pro copy sat
// unreachable behind it. So this gate asserts both the wording AND that
// the call sites stay collapsed onto the shared helper.
//
// Usage: npx tsx scripts/verify-property-cap-message.ts

import fs from 'fs'
import { propertyCapMessage } from '../app/lib/property-cap-message'

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

console.log('\n══ property cap: one message, right next step ══\n')

// ── PM Starter points at PM Pro, never at Elite ─────────────────────
for (const mode of ['add', 'reactivate'] as const) {
  const m = propertyCapMessage('pm_starter', 1, mode)
  chk(`pm_starter/${mode} names PM Pro`, m.includes('PM Pro'), m)
  chk(`pm_starter/${mode} 🔴 never says Elite`, !/Elite/i.test(m), m)
  chk(`pm_starter/${mode} uses support@, the subscriber address`,
    m.includes('support@shieldmylot.com') && !m.includes('hello@'), m)
}

// ── the 50-property plans point at Elite ────────────────────────────
for (const tier of ['legacy', 'enforcement_only', 'pm_only']) {
  const m = propertyCapMessage(tier, 50, 'add')
  chk(`${tier} names Elite and the sizing page`,
    /Elite/.test(m) && m.includes('/property-managers'), m)
  chk(`${tier} 🔴 never tells a 50-property account to move to PM Pro`,
    !m.includes('PM Pro'), m)
}

// ── an unresolved limit must not print a number it does not have ────
// getEffectivePropertyLimit returns null when it cannot resolve, and the
// DB is still enforcing. The copy omits the figure rather than printing
// "null" or guessing one.
const nul = propertyCapMessage('legacy', null, 'add')
chk('🔴 an unresolved limit prints no number, and never the word null',
  !/null|undefined|NaN/.test(nul) && !/\d/.test(nul), nul)

// ── reactivation says so, or the user retries the same click ────────
chk('reactivation copy says it cannot be reactivated',
  propertyCapMessage('legacy', 50, 'reactivate').includes("can't be reactivated"),
  propertyCapMessage('legacy', 50, 'reactivate'))

// ── the call sites stay collapsed ───────────────────────────────────
const src = fs.readFileSync('app/company_admin/page.tsx', 'utf8')
const calls = (src.match(/propertyCapMessage\(/g) ?? []).length
// The import carries no paren, so this counts calls only. Asserting the
// COUNT — not merely "at least one" — means a fourth refusal layer
// cannot be added with its own inlined copy without turning this red.
chk('🔴 exactly 3 call sites route through the helper', calls === 3,
  `found ${calls} call(s): pre-flight add, trigger translation, reactivation`)

const strays = [
  'contact us about upgrading',
  'Contact us about expanding',
  "property limit was reached. Contact us",
].filter(t => src.includes(t))
chk('🔴 no inlined property-cap copy left in the portal', strays.length === 0,
  strays.length ? `still present: ${strays.join(' | ')}` : 'none')

// ── the published doc quotes what the portal actually shows ─────────
// REVIEW_NOTES #8: doc 04 quotes this refusal verbatim. A quote that
// drifts from the code is worse than no quote, because a reader trusts it.
const doc = 'docs/backlog/help-docs-v2/04-adding-properties.md'
if (fs.existsSync(doc)) {
  const d = fs.readFileSync(doc, 'utf8')
  const shipped = propertyCapMessage('pm_starter', 1, 'add')
  chk('🔴 doc 04 quotes the shipped PM Starter refusal verbatim',
    d.includes(shipped), d.includes(shipped) ? 'matches' : `doc does not contain:\n       ${shipped}`)
  chk('   ...and no longer quotes hello@ for this refusal',
    !/refuse the create and show:[\s\S]{0,400}hello@/.test(d), 'checked the quote block only')
} else {
  chk('🔴 doc 04 quotes the shipped PM Starter refusal verbatim', false,
    '🔴 NOT EXERCISED: docs/backlog/help-docs-v2/04-adding-properties.md not found')
}

console.log(fails ? `\n❌ ${fails} failed` : '\n✅ all green')
process.exit(fails ? 1 : 0)

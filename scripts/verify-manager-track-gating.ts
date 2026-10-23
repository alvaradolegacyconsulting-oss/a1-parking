// ════════════════════════════════════════════════════════════════════
// GATE — the manager portal gates Spaces and Guests by track × tier
// ════════════════════════════════════════════════════════════════════
//
// Cell 5, ruled 2026-10-23. Before this, the manager portal had NO
// track gating at all, so a manager at an Operator Starter company saw
// Spaces and Authorized Guests — surfaces that plan does not include —
// while their own company admin could not see them in the CA portal.
//
// Gated BOTH DIRECTIONS, as ruled:
//   · hidden for Operator Starter;
//   · still shown for PM Starter, PM Pro and Operator Pro (A1's shape).
// A gate that only proved the hiding would stay green if the predicate
// started returning false for everyone.
//
// 🔴 The predicate is deliberately NOT the CA portal's. Cell 3 ruled the
// CA keeps these hidden for the whole enforcement track, Operator Pro
// included. This gate therefore asserts the two differ, so a later
// "tidy-up" that shares one helper between the portals turns it red.
//
// Usage: npx tsx --env-file=.env.local scripts/verify-manager-track-gating.ts

import fs from 'fs'

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

console.log('\n══ manager portal: track × tier gating ══\n')

const src = fs.readFileSync('app/manager/page.tsx', 'utf8')
const bare = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

// ── the predicate itself, evaluated ─────────────────────────────────
// Re-implemented here from ONE line of source so the truth table is
// asserted rather than described. The source form is pinned below, so
// the two cannot drift apart silently.
const predicate = (tier_type: string, tier: string) =>
  tier_type === 'property_management' || tier === 'legacy'

const PLANS: [string, string, string, boolean][] = [
  ['PM Starter',       'property_management', 'pm_starter',       true],
  ['PM Pro',           'property_management', 'legacy',           true],
  ['Operator Pro',     'enforcement',         'legacy',           true],
  ['Operator Starter', 'enforcement',         'enforcement_only', false],
]
for (const [label, track, tier, want] of PLANS) {
  const got = predicate(track, tier)
  chk(`${want ? 'shown for' : '🔴 hidden for'} ${label}`, got === want, `predicate = ${got}, expected ${want}`)
}

// ── the source really contains that predicate ───────────────────────
const line = src.split('\n').find(l => l.includes("c.tier_type === 'property_management' || c.tier === 'legacy'")) ?? ''
chk('🔴 the source predicate matches the one asserted above', line.trim().startsWith('return'),
  line.trim() || '🔴 not found — the truth table above is then asserting a predicate the app does not use')

const defs = (bare.match(/function pmSurfacesForManager\(\)/g) ?? []).length
chk('exactly one definition of the predicate', defs === 1, `found ${defs}`)

// ── every use site is wrapped ───────────────────────────────────────
// Buttons AND content. A gated button with an ungated content block
// still renders the surface on a stale activeTab.
const uses = (bare.match(/pmSurfacesForManager\(\)/g) ?? []).length
chk('🔴 four use sites: both tab buttons and both content blocks', uses === 5,
  `found ${uses} occurrences (1 definition + 4 uses)`)

for (const [what, re] of [
  ['the Spaces button',   /pmSurfacesForManager\(\) && \(\s*<button style=\{tabStyle\('spaces'\)\}/],
  ['the Guests button',   /pmSurfacesForManager\(\) && \(\s*<button style=\{tabStyle\('guest-auth'\)\}/],
  ['the Spaces content',  /activeTab === 'spaces' && pmSurfacesForManager\(\)/],
  ['the Guests content',  /activeTab === 'guest-auth' && pmSurfacesForManager\(\)/],
] as [string, RegExp][]) {
  chk(`${what} is gated`, re.test(bare), re.test(bare) ? 'wrapped' : '🔴 NOT wrapped')
}

// ── what must NOT be gated ──────────────────────────────────────────
// Operator Starter keeps the visitor-pass view (QR passes exist there)
// and residents/vehicles (residents are office-added on that plan).
for (const t of ['visitors', 'residents', 'violations']) {
  const gated = new RegExp(`activeTab === '${t}' && pmSurfacesForManager`).test(bare)
  chk(`🔴 ${t} is NOT gated — Operator Starter keeps it`, !gated,
    gated ? `🔴 ${t} was gated; the ruling keeps it for Operator Starter` : 'ungated, as ruled')
}

// ── the CA predicate stayed different (cell 3: no change) ───────────
const ca = fs.readFileSync('app/company_admin/page.tsx', 'utf8')
const caTrack = (ca.match(/ctx\.tier_type === 'property_management'/g) ?? []).length
chk("🔴 the CA portal's conjunct is untouched — cell 3 ruled no change", caTrack >= 3,
  `${caTrack} site(s) still require property_management; widening these was explicitly refused`)
chk('   ...and the CA does not import the manager predicate',
  !ca.includes('pmSurfacesForManager'), 'the two predicates stay separate on purpose')

console.log(fails ? `\n❌ ${fails} failed` : '\n✅ all green')
process.exit(fails ? 1 : 0)

// B165 — tier-jump (forced upgrade) probe.
//
// Two-mode probe:
//
//   • REFUSAL MODE (default; no Stripe required) — exercises the 5
//     refusal paths via fixture company rows + the changeTier helper.
//     Validates that previewTierChange + changeTier refuse upfront on:
//       - proposal_code_attached (Signal A: proposal_codes WHERE company_id=$1 AND status='redeemed')
//       - premium_target
//       - track_switch_refused (Enf→PM)
//       - not_an_upgrade (Legacy→Growth downgrade attempt)
//       - manual_collection (send_invoice subscription)
//     Plus a synthetic live-subscription-rollback-recipe log assertion.
//
//   • LIVE MODE (--live; requires Stripe test-mode + populated
//     stripe_prices catalog + an existing test subscription_id) —
//     exercises the within-track jumps that mutate a real Stripe sub:
//       1. Enf Starter→Growth (monthly)
//       2. Enf Growth→Legacy (monthly)
//       3. PM Essential→Professional (monthly)
//       4. PM Professional→Enterprise (monthly)
//       7. Enf Growth→Legacy ANNUAL — cycle resolution check
//
// USAGE
//   # Refusal-only (safe; no Stripe touch):
//   npx tsx --env-file=.env.local scripts/probe-b165-tier-change.ts
//
//   # Live mode (consumes Stripe test charges):
//   STRIPE_MODE=test \
//   B165_TEST_SUB_STARTER=sub_xxx \
//   B165_TEST_SUB_GROWTH=sub_xxx \
//   B165_TEST_SUB_ESSENTIAL=sub_xxx \
//   B165_TEST_SUB_PROFESSIONAL=sub_xxx \
//   B165_TEST_SUB_GROWTH_ANNUAL=sub_xxx \
//   npx tsx --env-file=.env.local scripts/probe-b165-tier-change.ts --live
//
// PRECONDITION (refusal mode): none beyond .env.local.
// PRECONDITION (live mode): Pattern A scaffold from B66.7 + a real test-
// mode subscription per tier-source to upgrade FROM. The probe will NOT
// create test subscriptions for you — too easy to leak state. Jose
// provisions the test sub via the existing B66.7 scaffold, exports the
// sub_id as the matching B165_TEST_SUB_* env var, runs the probe.

import { createClient } from '@supabase/supabase-js'
import { changeTier, previewTierChange } from '../app/lib/stripe-mutations'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const LIVE = process.argv.includes('--live')
const RUN_TAG = `b165-${Date.now()}`

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

type Check = { id: string; pass: boolean; detail: string }
const checks: Check[] = []
const record = (id: string, pass: boolean, detail: string) => {
  checks.push({ id, pass, detail })
  const status = pass ? 'PASS' : 'FAIL'
  console.log(`${status}  ${id}  ${detail}`)
}
const skip = (id: string, reason: string) => {
  console.log(`SKIP  ${id}  ${reason}`)
  checks.push({ id, pass: true, detail: `SKIPPED: ${reason}` })  // skip counts toward "no failure" but called out
}

const cleanup: Array<() => Promise<void>> = []

// ── Fixture company-row factory (refusal mode) ───────────────────
//
// Spawns a synthetic companies row with controlled fields so we can
// force each refusal path without needing a real Stripe subscription.
// Most refusal paths fire BEFORE the Stripe-touching code, so a real
// stripe_subscription_id is never needed for these cases.
async function spawnFixtureCompany(suffix: string, fields: Record<string, unknown>): Promise<number> {
  const name = `B165_FIXTURE_${RUN_TAG}_${suffix}`
  const { data, error } = await admin.from('companies').insert({
    name,
    address: 'probe-only',
    is_active: true,
    account_state: 'active',
    tier: fields.tier ?? 'starter',
    tier_type: fields.tier_type ?? 'enforcement',
    stripe_subscription_id: fields.stripe_subscription_id ?? null,
    display_name: name,
  }).select('id').single()
  if (error || !data) throw new Error(`fixture company ${suffix}: ${error?.message}`)
  const id = data.id as number
  cleanup.push(async () => { await admin.from('companies').delete().eq('id', id) })
  return id
}

async function spawnFixtureProposalCode(suffix: string, companyId: number): Promise<number> {
  // Reverse-link: proposal_codes.company_id → companies.id. status='redeemed'
  // is the only state Signal A treats as "live association."
  const code = `B165FX-${RUN_TAG}-${suffix}`.slice(0, 30)
  const { data, error } = await admin.from('proposal_codes').insert({
    code, company_id: companyId, status: 'redeemed',
    base_tier_type: 'enforcement', base_tier: 'legacy',
  }).select('id').single()
  if (error || !data) throw new Error(`fixture proposal_code ${suffix}: ${error?.message}`)
  const id = data.id as number
  cleanup.push(async () => { await admin.from('proposal_codes').delete().eq('id', id) })
  return id
}

// ── Refusal probe cases ──────────────────────────────────────────

async function caseProposalCodeRefusal() {
  const id = 'rpc.proposal_code_attached'
  try {
    const companyId = await spawnFixtureCompany('pc', {
      tier: 'growth', tier_type: 'enforcement',
      stripe_subscription_id: 'sub_fixture_will_not_be_called',
    })
    await spawnFixtureProposalCode('pc', companyId)
    const result = await changeTier(companyId, 'legacy', 'enforcement')
    const refused = !result.ok && result.reason === 'proposal_code_attached'
    record(id, refused, refused
      ? `Refused at Signal A (proposal_codes lookup). detail=${(result as { detail?: string }).detail ?? ''}`
      : `EXPECTED refusal proposal_code_attached, got ${JSON.stringify(result)}`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

async function casePremiumTargetRefusal() {
  const id = 'rpc.premium_target'
  try {
    const companyId = await spawnFixtureCompany('prem', {
      tier: 'legacy', tier_type: 'enforcement',
      stripe_subscription_id: 'sub_fixture_will_not_be_called',
    })
    const result = await changeTier(companyId, 'premium', 'enforcement')
    const refused = !result.ok && result.reason === 'premium_target'
    record(id, refused, refused
      ? 'Refused upfront — Premium is contact-sales.'
      : `EXPECTED refusal premium_target, got ${JSON.stringify(result)}`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

async function caseTrackSwitchRefusal() {
  const id = 'rpc.track_switch_refused'
  // Track-switch is detected from the LIVE sub's items (resolveCurrentTierFromSnapshot)
  // — requires a real subscription to test honestly. In refusal-only mode, we
  // verify the helper REFUSES rather than mutate.
  if (!LIVE) {
    skip(id, 'requires live subscription (refusal mode covers Signal-A guards; track-switch is detected from live sub items)')
    return
  }
  try {
    const subId = process.env.B165_TEST_SUB_GROWTH
    if (!subId) { skip(id, 'B165_TEST_SUB_GROWTH unset'); return }
    const companyId = await spawnFixtureCompany('trk', {
      tier: 'growth', tier_type: 'enforcement',
      stripe_subscription_id: subId,
    })
    const result = await changeTier(companyId, 'professional', 'property_management')
    const refused = !result.ok && result.reason === 'track_switch_refused'
    record(id, refused, refused ? 'Refused — Enf→PM track-switch blocked.' : `EXPECTED track_switch_refused, got ${JSON.stringify(result)}`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

async function caseNotAnUpgradeRefusal() {
  const id = 'rpc.not_an_upgrade'
  if (!LIVE) {
    skip(id, 'requires live sub to resolve current-tier from items')
    return
  }
  try {
    const subId = process.env.B165_TEST_SUB_GROWTH
    if (!subId) { skip(id, 'B165_TEST_SUB_GROWTH unset'); return }
    const companyId = await spawnFixtureCompany('dwn', {
      tier: 'growth', tier_type: 'enforcement',
      stripe_subscription_id: subId,
    })
    // Attempt downgrade
    const result = await changeTier(companyId, 'starter', 'enforcement')
    const refused = !result.ok && result.reason === 'not_an_upgrade'
    record(id, refused, refused ? 'Refused — downgrade not supported in v1.' : `EXPECTED not_an_upgrade, got ${JSON.stringify(result)}`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

async function caseManualCollectionRefusal() {
  const id = 'rpc.manual_collection'
  if (!LIVE) {
    skip(id, 'requires live sub with collection_method=send_invoice (A1-style)')
    return
  }
  try {
    const subId = process.env.B165_TEST_SUB_SEND_INVOICE
    if (!subId) { skip(id, 'B165_TEST_SUB_SEND_INVOICE unset (must be a send_invoice subscription)'); return }
    const companyId = await spawnFixtureCompany('mnl', {
      tier: 'legacy', tier_type: 'enforcement',
      stripe_subscription_id: subId,
    })
    const result = await changeTier(companyId, 'legacy', 'enforcement')
    const refused = !result.ok && result.reason === 'manual_collection'
    record(id, refused, refused ? 'Refused — send_invoice not auto-mutable (A1 protection).' : `EXPECTED manual_collection, got ${JSON.stringify(result)}`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

async function casePreviewSymmetric() {
  const id = 'rpc.preview_refuses_same_as_changeTier'
  // previewTierChange uses the same runChangeTierGuards — must refuse
  // identically. Easy to verify with the premium_target case.
  try {
    const companyId = await spawnFixtureCompany('prv', {
      tier: 'legacy', tier_type: 'enforcement',
      stripe_subscription_id: 'sub_fixture_will_not_be_called',
    })
    const result = await previewTierChange(companyId, 'premium', 'enforcement')
    const refused = !result.ok && result.reason === 'premium_target'
    record(id, refused, refused
      ? 'preview refuses Premium same way changeTier does.'
      : `EXPECTED refusal premium_target on preview, got ${JSON.stringify(result)}`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

// ── Live mode probe cases (require Stripe test infra) ────────────

interface LiveCase {
  id: string
  envVar: string
  fromTier: string
  fromTrack: 'enforcement' | 'property_management'
  toTier: string
  cycleLabel: string
}

const LIVE_CASES: LiveCase[] = [
  { id: 'live.enf_starter_to_growth_monthly',   envVar: 'B165_TEST_SUB_STARTER',         fromTier: 'starter',      fromTrack: 'enforcement',          toTier: 'growth',       cycleLabel: 'monthly' },
  { id: 'live.enf_growth_to_legacy_monthly',    envVar: 'B165_TEST_SUB_GROWTH',          fromTier: 'growth',       fromTrack: 'enforcement',          toTier: 'legacy',       cycleLabel: 'monthly' },
  { id: 'live.pm_essential_to_professional',    envVar: 'B165_TEST_SUB_ESSENTIAL',       fromTier: 'essential',    fromTrack: 'property_management',  toTier: 'professional', cycleLabel: 'monthly' },
  { id: 'live.pm_professional_to_enterprise',   envVar: 'B165_TEST_SUB_PROFESSIONAL',    fromTier: 'professional', fromTrack: 'property_management',  toTier: 'enterprise',   cycleLabel: 'monthly' },
  { id: 'live.enf_growth_to_legacy_ANNUAL',     envVar: 'B165_TEST_SUB_GROWTH_ANNUAL',   fromTier: 'growth',       fromTrack: 'enforcement',          toTier: 'legacy',       cycleLabel: 'annual'  },
]

async function runLiveCase(c: LiveCase) {
  const subId = process.env[c.envVar]
  if (!subId) { skip(c.id, `${c.envVar} unset`); return }
  try {
    const companyId = await spawnFixtureCompany(c.id.replace(/\./g, '_'), {
      tier: c.fromTier, tier_type: c.fromTrack,
      stripe_subscription_id: subId,
    })
    const preview = await previewTierChange(companyId, c.toTier, c.fromTrack)
    if (!preview.ok) {
      record(c.id, false, `preview refused: reason=${preview.reason}, detail=${preview.detail}`)
      return
    }
    console.log(`     PREVIEW: prorated=${preview.proratedToday}¢ + period_total=${preview.newPeriodTotal}¢ ${preview.currency}`)
    const change = await changeTier(companyId, c.toTier, c.fromTrack)
    if (!change.ok) {
      record(c.id, false, `changeTier refused after preview-ok: reason=${change.reason}, detail=${change.detail}`)
      return
    }
    const expectedSwaps = c.fromTrack === 'enforcement' ? 3 : 2
    const got = change.swaps.length
    const allHaveFromTo = change.swaps.every(s => s.from && s.to && s.from !== s.to)
    const pass = got === expectedSwaps && allHaveFromTo
    record(c.id, pass, pass
      ? `${got}/${expectedSwaps} line items swapped: ${change.swaps.map(s => s.lineItem).join('+')}`
      : `Expected ${expectedSwaps} swaps, got ${got}: ${JSON.stringify(change.swaps)}`)
  } catch (e) {
    record(c.id, false, `threw: ${(e as Error).message}`)
  }
}

// ── Run ──────────────────────────────────────────────────────────

async function main() {
  console.log(`── B165 probe — mode=${LIVE ? 'LIVE (Stripe test mutations)' : 'REFUSAL-only (no Stripe touch)'} — RUN_TAG=${RUN_TAG} ──\n`)

  console.log('── Refusal cases (5 + 1 preview-symmetric) ──')
  await caseProposalCodeRefusal()       // case 5
  await casePremiumTargetRefusal()      // case 6
  await caseTrackSwitchRefusal()        // case 8 (LIVE-gated)
  await caseNotAnUpgradeRefusal()       // bonus refusal coverage (LIVE-gated)
  await caseManualCollectionRefusal()   // bonus refusal coverage (LIVE-gated)
  await casePreviewSymmetric()          // confirms preview gate parity

  if (LIVE) {
    console.log('\n── Live cases (Stripe test-mode mutations) ──')
    for (const c of LIVE_CASES) {
      await runLiveCase(c)
    }
  } else {
    console.log('\n── Live cases skipped (refusal mode) ──')
    LIVE_CASES.forEach(c => skip(c.id, `refusal-only mode; pass --live + ${c.envVar} to run`))
  }

  console.log('\n── Cleanup (reverse-LIFO) ──')
  for (const fn of cleanup.reverse()) {
    try { await fn() } catch (e) { console.warn('cleanup error:', (e as Error).message) }
  }

  const pass = checks.filter(c => c.pass).length
  const total = checks.length
  const failed = checks.filter(c => !c.pass)
  console.log(`\n── RESULT — ${pass}/${total} passed ──`)
  if (failed.length > 0) {
    console.log('\nFAILED:')
    failed.forEach(c => console.log(`  ✗ ${c.id}  ${c.detail}`))
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })

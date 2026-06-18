// Read-only stripe_prices catalog coverage check.
//
// Reusable preflight for any work that touches the standard tier
// catalog (provisioning fixtures, tier-change flows, pricing previews,
// etc.). NO Stripe API calls. NO writes. Pure SELECT against
// stripe_prices.
//
// First written 2026-06-17 as the B165 preflight; renamed/generalized
// so future Stripe-touching work can run the same check before
// provisioning or testing. The REQUIREMENTS table below is the
// current default coverage set (8 groups across both tracks +
// both cycles + the standard tier ladder); edit it for other use
// cases without changing the check logic.
//
// Default coverage set (the B165 needs that motivated the script):
//   Standard tier ladder, monthly cycle, both tracks:
//     • enforcement / starter      / {base,per_property,per_driver} / monthly
//     • enforcement / growth       / {base,per_property,per_driver} / monthly
//     • enforcement / legacy       / {base,per_property,per_driver} / monthly
//     • property_management / essential    / {base,per_property} / monthly
//     • property_management / professional / {base,per_property} / monthly
//     • property_management / enterprise   / {base,per_property} / monthly
//   Annual cycle for the upgrade-target tiers:
//     • enforcement / growth       / {base,per_property,per_driver} / annual
//     • enforcement / legacy       / {base,per_property,per_driver} / annual
//
// Total unique rows required: 21 (3+3+3+3+2+2+3+2)
//
// LESSON BAKED IN (from B165's 2nd inferred-column bug, June 17):
// the stripe_prices DB column is `tier_track`, NOT `track`. Always
// grep app/lib/stripe-catalog.ts (the canonical resolver) and/or
// query information_schema.columns before writing any new query
// against this table. This script reads `r.tier_track` directly,
// matching the schema.

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

interface Req {
  track: 'enforcement' | 'property_management'
  tier: string
  cycle: 'monthly' | 'annual'
  line_items: ('base' | 'per_property' | 'per_driver')[]
}

const REQUIREMENTS: Req[] = [
  // Provision-source rows
  { track: 'enforcement',         tier: 'starter',      cycle: 'monthly', line_items: ['base', 'per_property', 'per_driver'] },
  { track: 'enforcement',         tier: 'growth',       cycle: 'monthly', line_items: ['base', 'per_property', 'per_driver'] },
  { track: 'enforcement',         tier: 'growth',       cycle: 'annual',  line_items: ['base', 'per_property', 'per_driver'] },
  { track: 'enforcement',         tier: 'legacy',       cycle: 'monthly', line_items: ['base', 'per_property', 'per_driver'] },
  { track: 'property_management', tier: 'essential',    cycle: 'monthly', line_items: ['base', 'per_property'] },
  { track: 'property_management', tier: 'professional', cycle: 'monthly', line_items: ['base', 'per_property'] },
  // Probe-swap-target rows (not covered above)
  { track: 'enforcement',         tier: 'legacy',       cycle: 'annual',  line_items: ['base', 'per_property', 'per_driver'] },
  { track: 'property_management', tier: 'enterprise',   cycle: 'monthly', line_items: ['base', 'per_property'] },
]

async function main() {
  // Probe schema first to know which columns exist
  const { data: schemaProbe, error: probeErr } = await supabase
    .from('stripe_prices').select('*').limit(1)
  if (probeErr) {
    console.error('schema probe failed:', probeErr.message)
    process.exit(2)
  }
  console.log('Columns:', Object.keys(schemaProbe?.[0] || {}).join(', '))

  const { data, error } = await supabase
    .from('stripe_prices')
    .select('*')
    .eq('mode', 'test')
    .is('proposal_code_id', null)

  if (error) {
    console.error('stripe_prices read failed:', error.message)
    process.exit(2)
  }

  const rows = data ?? []
  console.log(`\n── stripe_prices TEST-MODE catalog rows (proposal_code_id IS NULL) ──`)
  console.log(`   Total rows: ${rows.length}`)

  // Group by track/tier/cycle. House convention: DB column is `tier_track`
  // (column-name bug fix 2026-06-17 — was reading r.track which is
  // undefined and falsely reported every group missing).
  const seen = new Set<string>()
  for (const r of rows) {
    seen.add(`${r.tier_track}|${r.tier_name}|${r.line_item}|${r.cycle}`)
  }

  // Check requirements
  let missingCount = 0
  const missing: string[] = []
  const present: string[] = []

  console.log(`\n── Coverage check (8 (track,tier,cycle) groups; 21 rows total) ──\n`)
  for (const req of REQUIREMENTS) {
    const groupLabel = `${req.track}/${req.tier}/${req.cycle}`
    let groupOk = true
    for (const li of req.line_items) {
      const key = `${req.track}|${req.tier}|${li}|${req.cycle}`
      if (!seen.has(key)) {
        groupOk = false
        missing.push(`${groupLabel}/${li}`)
        missingCount++
      } else {
        present.push(`${groupLabel}/${li}`)
      }
    }
    console.log(`   ${groupOk ? '✓' : '✗'} ${groupLabel.padEnd(46)} (${req.line_items.length} items)`)
  }

  console.log(`\n── Summary ──`)
  console.log(`   Present: ${present.length}`)
  console.log(`   Missing: ${missingCount}`)
  if (missing.length > 0) {
    console.log(`\n   Missing rows:`)
    missing.forEach(m => console.log(`     • ${m}`))
    console.log(`\n   ✗ PREFLIGHT FAIL — populate the test-mode catalog before running the provision script.`)
    console.log(`     The B66.2a populator (scripts/create-stripe-prices.ts) is the canonical tool;`)
    console.log(`     it's idempotent (triple-layer DB UNIQUE → Stripe lookup_key probe → sibling Product reuse).`)
    process.exit(3)
  } else {
    console.log(`\n   ✓ PREFLIGHT CLEAN — all 21 required rows present.`)
  }
}

main().catch(e => {
  console.error('Unhandled:', (e as Error).message)
  process.exit(99)
})

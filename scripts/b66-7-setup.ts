// B66.7 E2E smoke — Phase 1 setup.
// Flips stripe_billing_enabled, creates a draft proposal code with
// Legacy Enforcement tier + included_properties=1 + included_drivers=1,
// then runs the real issue-time path to create 3 test-mode Stripe Prices.
//
// USAGE: npx tsx --env-file=.env.local scripts/b66-7-setup.ts

import { createClient } from '@supabase/supabase-js'
import { createStripePricesForProposalCode, type ProposalCodeForStripe } from '../app/lib/proposal-code-stripe'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

const ts = Math.floor(Date.now() / 1000).toString(36).toUpperCase()
const CODE = `E2E-${ts}`
const THROWAWAY_EMAIL = `e2e+june13-${ts.toLowerCase()}@shieldmylot.com`

async function main() {
  console.log(`B66.7 setup · code=${CODE} · throwaway=${THROWAWAY_EMAIL}`)

  // 1. Flip stripe_billing_enabled = true (and capture original for restore).
  const { data: psBefore } = await admin
    .from('platform_settings')
    .select('stripe_billing_enabled,public_signup_open')
    .eq('id', 1)
    .single()
  console.log(`platform_settings BEFORE: ${JSON.stringify(psBefore)}`)

  if (psBefore?.stripe_billing_enabled !== true) {
    const { error } = await admin
      .from('platform_settings')
      .update({ stripe_billing_enabled: true })
      .eq('id', 1)
    if (error) throw new Error(`flag flip failed: ${error.message}`)
    console.log('stripe_billing_enabled → true (will restore to false at cleanup)')
  }

  // 2. Insert draft proposal code.
  // Use base_tier='legacy' + base_tier_type='enforcement' (A1's actual tier).
  // included_properties=1 + included_drivers=1 (exercises both line items at qty=1).
  // expires_at far future so it's redeemable.
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()  // 30 days

  const { data: draft, error: insErr } = await admin
    .from('proposal_codes')
    .insert({
      code: CODE,
      status: 'draft',
      base_tier: 'legacy',
      base_tier_type: 'enforcement',
      client_name: `E2E Smoke ${ts}`,
      client_email: THROWAWAY_EMAIL,
      included_properties: 1,
      included_drivers: 1,
      expires_at: expiresAt,
      collection_method: 'charge_automatically',
      prefix: 'E2E',
      generated_by: 'b66-7-setup',
    })
    .select('id, code, base_tier, base_tier_type, client_name, custom_base_fee, custom_per_property_fee, custom_per_driver_fee')
    .single()

  if (insErr || !draft) throw new Error(`proposal_code insert failed: ${insErr?.message}`)
  console.log(`draft proposal_code id=${draft.id} code=${draft.code}`)

  // 3. Create 3 Stripe Prices via the real issue-time helper.
  const codeForStripe: ProposalCodeForStripe = {
    id: draft.id,
    code: draft.code,
    client_name: draft.client_name,
    base_tier: draft.base_tier as 'legacy',
    base_tier_type: draft.base_tier_type as 'enforcement',
    custom_base_fee: draft.custom_base_fee,
    custom_per_property_fee: draft.custom_per_property_fee,
    custom_per_driver_fee: draft.custom_per_driver_fee,
  }

  let issueResult
  try {
    issueResult = await createStripePricesForProposalCode(codeForStripe)
  } catch (e) {
    throw new Error(`createStripePricesForProposalCode failed: ${(e as Error).message}`)
  }
  console.log(`Stripe Prices: created=${issueResult.created} recovered=${issueResult.recovered} skipped=${issueResult.skipped}`)
  for (const p of issueResult.prices) {
    console.log(`  ${p.line_item}: ${p.stripe_price_id} (${p.lookup_key}) ${p.unit_amount_cents}¢ [${p.action}]`)
  }

  // 4. Flip status draft → issued so /signup/redeem accepts it.
  const { error: issueErr } = await admin
    .from('proposal_codes')
    .update({ status: 'issued', issued_at: new Date().toISOString(), issued_by: 'b66-7-setup' })
    .eq('id', draft.id)
  if (issueErr) throw new Error(`status flip failed: ${issueErr.message}`)
  console.log(`proposal_code status: draft → issued`)

  // 5. Verify the linked stripe_prices rows.
  const { data: priceRows } = await admin
    .from('stripe_prices')
    .select('line_item,stripe_price_id,lookup_key,unit_amount_cents,mode')
    .eq('proposal_code_id', draft.id)
    .order('line_item')
  console.log(`stripe_prices rows linked: ${priceRows?.length ?? 0}`)
  for (const r of priceRows ?? []) {
    console.log(`  ${r.line_item}: ${r.stripe_price_id} (${r.lookup_key}) mode=${r.mode}`)
  }

  // 6. Output the redeem URL + smoke instructions.
  console.log('')
  console.log('────────────────────────────────────────────────────────')
  console.log('REDEEM URL (Step 1):')
  console.log(`  http://localhost:3000/signup/redeem?code=${CODE}`)
  console.log('')
  console.log('THROWAWAY EMAIL (use exactly this):')
  console.log(`  ${THROWAWAY_EMAIL}`)
  console.log('')
  console.log('Code id (Mateo reference):', draft.id)
  console.log('────────────────────────────────────────────────────────')
}

main().catch(e => { console.error('SETUP FAILED:', e.message); process.exit(1) })

// Quick probe: is 20260901_platform_settings_pm_starter_pricing applied?
// Reports both column presence AND seed value so the operator knows
// whether create-stripe-prices.ts amendment can safely run.
//
// USAGE: npx tsx --env-file=.env.local scripts/probe-starter-permit-tiers-applied.ts

import { createClient } from '@supabase/supabase-js'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const { data, error } = await sb
    .from('platform_settings')
    .select('id, price_pm_starter_base, starter_permit_tiers, price_pm_only_base, price_pm_only_per_property, permit_tiers')
    .eq('id', 1)
    .single()

  if (error) {
    console.error('[probe] platform_settings read failed:', error.message)
    if (error.message.includes('starter_permit_tiers') || error.message.includes('price_pm_starter_base')) {
      console.error('[probe] → §2-DB (20260901_platform_settings_pm_starter_pricing) has NOT been applied.')
    }
    process.exit(1)
  }
  console.log('[probe] platform_settings row 1:')
  console.log('  price_pm_only_base:         ', data.price_pm_only_base, '(preserved from before)')
  console.log('  price_pm_only_per_property: ', data.price_pm_only_per_property, '(preserved from before)')
  console.log('  price_pm_starter_base:      ', data.price_pm_starter_base, '(expect 149)')
  console.log('  starter_permit_tiers:       ', JSON.stringify(data.starter_permit_tiers))
  console.log('                                 (expect [{up_to:500,rate_cents:0},{up_to:null,rate_cents:125}])')
  console.log('  permit_tiers (pm_only):     ', JSON.stringify(data.permit_tiers))

  const applied = data.price_pm_starter_base === 149 && Array.isArray(data.starter_permit_tiers) && data.starter_permit_tiers.length === 2
  console.log('')
  console.log(applied ? '✓ §2-DB APPLIED — safe to run create-stripe-prices.ts' : '✗ §2-DB NOT APPLIED or partial — do NOT run create-stripe-prices.ts yet')
  process.exit(applied ? 0 : 2)
}

main().catch(e => { console.error('[probe] fatal:', e); process.exit(1) })

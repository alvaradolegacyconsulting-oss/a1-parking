// Quick probe: current values of public_signup_open + stripe_billing_enabled
// in platform_settings, and where they live.
//
// USAGE: npx tsx --env-file=.env.local scripts/probe-signup-flags.ts

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
    .select('*')
    .eq('id', 1)
    .single()

  if (error) {
    console.error('[probe] platform_settings read failed:', error.message)
    process.exit(1)
  }

  console.log('[probe] platform_settings row 1 — dormancy flags')
  console.log('  public_signup_open:      ', data.public_signup_open)
  console.log('  stripe_billing_enabled:  ', data.stripe_billing_enabled)
  console.log('')
  console.log('[probe] All boolean/flag-shaped columns in row 1:')
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'boolean') {
      console.log(`  ${k}: ${v}`)
    }
  }
}

main().catch(e => { console.error('[probe] fatal:', e); process.exit(1) })

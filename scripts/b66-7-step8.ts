// B66.7 Step 8 — cleanup. Reverses everything Phase 1 + Steps 4-7 created.
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const stripeKey  = process.env.STRIPE_TEST_SECRET_KEY!
const c = createClient(url, serviceKey, { auth: { persistSession: false } })
const stripe = new Stripe(stripeKey, { apiVersion: '2026-04-22.dahlia' })

const COMPANY_ID = 54
const COMPANY_NAME = 'A1 Test E2E'
const SUB_ID = 'sub_1Thv0c3UC9fdqhGiSwWfEejq'
const CUS_ID = 'cus_UhJd9qT0tflQjM'
const EMAIL = 'alvaradolegacyconsulting+e2e@gmail.com'
const CODE = 'E2E-TGKWRN'
const PROPOSAL_CODE_ID = 27

async function main() {
  const ops: string[] = []

  // 1. Cancel Stripe subscription
  try {
    const sub = await stripe.subscriptions.cancel(SUB_ID)
    ops.push(`stripe sub cancelled: status=${sub.status}`)
  } catch (e) { ops.push(`stripe sub cancel: ${(e as Error).message}`) }

  // 2. Delete Stripe customer (test mode allows this)
  try {
    await stripe.customers.del(CUS_ID)
    ops.push(`stripe customer deleted`)
  } catch (e) { ops.push(`stripe customer delete: ${(e as Error).message}`) }

  // 3. Deactivate the 3 E2E Stripe Prices (Stripe doesn't allow deletion of Prices)
  const { data: priceRows } = await c.from('stripe_prices')
    .select('stripe_price_id').eq('proposal_code_id', PROPOSAL_CODE_ID)
  for (const r of priceRows ?? []) {
    try {
      await stripe.prices.update(r.stripe_price_id, { active: false })
      ops.push(`stripe price ${r.stripe_price_id} deactivated`)
    } catch (e) { ops.push(`stripe price deactivate ${r.stripe_price_id}: ${(e as Error).message}`) }
  }

  // 4. Delete DB-side records (preserving evidence as needed)
  // properties + drivers
  const { data: deletedProps } = await c.from('properties').delete().eq('company', COMPANY_NAME).select('id')
  ops.push(`properties deleted: ${deletedProps?.length ?? 0}`)
  const { data: deletedDrivers } = await c.from('drivers').delete().eq('company', COMPANY_NAME).select('id')
  ops.push(`drivers deleted: ${deletedDrivers?.length ?? 0}`)

  // stripe_prices linked to the proposal code
  const { data: deletedPrices } = await c.from('stripe_prices')
    .delete().eq('proposal_code_id', PROPOSAL_CODE_ID).select('id')
  ops.push(`stripe_prices DB rows deleted: ${deletedPrices?.length ?? 0}`)

  // user_roles
  const { data: deletedRoles } = await c.from('user_roles').delete().ilike('email', EMAIL).select('id')
  ops.push(`user_roles deleted: ${deletedRoles?.length ?? 0}`)

  // companies row
  const { data: deletedCompany } = await c.from('companies').delete().eq('id', COMPANY_ID).select('id')
  ops.push(`companies deleted: ${deletedCompany?.length ?? 0}`)

  // proposal_code row (full delete — frees the code for re-use)
  const { data: deletedCode } = await c.from('proposal_codes')
    .delete().eq('id', PROPOSAL_CODE_ID).select('id')
  ops.push(`proposal_codes deleted: ${deletedCode?.length ?? 0}`)

  // auth user
  const { data: page } = await c.auth.admin.listUsers({ page:1, perPage:200 })
  const u = page.users.find(x => x.email === EMAIL)
  if (u) {
    const { error } = await c.auth.admin.deleteUser(u.id)
    ops.push(`auth user deleted: ${error?.message ?? 'ok'}`)
  } else { ops.push('auth user already absent') }

  // 5. Restore stripe_billing_enabled = false
  const { error: flagErr } = await c.from('platform_settings')
    .update({ stripe_billing_enabled: false }).eq('id', 1)
  ops.push(`stripe_billing_enabled → false: ${flagErr?.message ?? 'ok'}`)

  // Verification — read final state
  const { data: psFinal } = await c.from('platform_settings').select('stripe_billing_enabled,public_signup_open').eq('id',1).single()
  const { data: companyCheck } = await c.from('companies').select('id').eq('id', COMPANY_ID).maybeSingle()
  const { data: codeCheck } = await c.from('proposal_codes').select('id').eq('id', PROPOSAL_CODE_ID).maybeSingle()
  const stillThere = page.users.find(x => x.email === EMAIL)

  console.log('── CLEANUP OPS ──')
  for (const op of ops) console.log(`  ${op}`)
  console.log('')
  console.log('── FINAL STATE ──')
  console.log(`  platform_settings: ${JSON.stringify(psFinal)}`)
  console.log(`  companies row 54:        ${companyCheck ? 'STILL THERE' : 'GONE ✓'}`)
  console.log(`  proposal_codes row 27:   ${codeCheck ? 'STILL THERE' : 'GONE ✓'}`)
  console.log(`  auth user ${EMAIL}: ${stillThere ? 'STILL THERE' : 'GONE ✓ (or never existed in this page)'}`)
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1) })

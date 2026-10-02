// ════════════════════════════════════════════════════════════════════
// GATE — first-invoice amounts for all four plans, from STRIPE
// ════════════════════════════════════════════════════════════════════
//
// 🔴 It asks Stripe to price the line items rather than computing the
// bands here. The graduated 20/50 step is Stripe's arithmetic, so a
// local calculation would only prove this script agrees with itself —
// the exact mistake that would let a wrong band ship.
//
// Usage: STRIPE_MODE=test npx tsx scripts/verify-pricing-sweep.ts
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const MODE = (process.env.STRIPE_MODE === 'live' ? 'live' : 'test') as 'live' | 'test'
const key = MODE === 'live' ? process.env.STRIPE_LIVE_SECRET_KEY : (process.env.STRIPE_TEST_SECRET_KEY || g('STRIPE_TEST_SECRET_KEY'))
if (!key) { console.error('no Stripe key'); process.exit(2) }
const stripe = new Stripe(key)
const db = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

type Plan = { label: string; track: string; tier: string; expect: Record<number, number> }
const PLANS: Plan[] = [
  { label: 'PM Starter',       track: 'property_management', tier: 'pm_starter',       expect: { 1: 149 } },
  { label: 'PM Pro',           track: 'property_management', tier: 'legacy',           expect: { 1: 264, 20: 549, 21: 549, 50: 549 } },
  { label: 'Operator Starter', track: 'enforcement',         tier: 'enforcement_only', expect: { 1: 214, 20: 499, 21: 499, 50: 499 } },
  { label: 'Operator Pro',     track: 'enforcement',         tier: 'legacy',           expect: { 1: 319, 20: 699, 21: 699, 50: 699 } },
]

let fails = 0
const money = (c: number) => '$' + (c / 100).toFixed(2)

const main = async () => {
  console.log(`mode=${MODE}\n`)
  for (const p of PLANS) {
    for (const cycle of ['monthly', 'annual'] as const) {
      const { data: lines, error } = await db.from('stripe_prices')
        .select('line_item, stripe_price_id, price_model')
        .eq('tier_track', p.track).eq('tier_name', p.tier)
        .eq('cycle', cycle).eq('mode', MODE)
        .is('proposal_code_id', null).eq('is_active', true)
      if (error) { console.log(`❌ ${p.label}/${cycle}: catalog read failed: ${error.message}`); fails++; continue }
      if (!lines?.length) { console.log(`❌ ${p.label}/${cycle}: NO catalog rows`); fails++; continue }

      for (const n of Object.keys(p.expect).map(Number)) {
        // Same quantity rule as create-checkout-session.
        const items = lines.map(l => ({
          price: l.stripe_price_id,
          quantity: l.line_item === 'per_property' ? n : 1,
        }))
        let subtotal: number
        try {
          // Stripe prices it. No customer → no tax, so this is the
          // pre-tax subtotal, which is what the decision table states.
          const prev = await (stripe.invoices as unknown as {
            createPreview: (a: unknown) => Promise<{ subtotal: number }>
          }).createPreview({
            currency: 'usd',
            subscription_details: { items },
          })
          subtotal = prev.subtotal
        } catch (e) {
          console.log(`❌ ${p.label}/${cycle}/${n}: preview failed: ${(e as Error).message}`)
          fails++; continue
        }
        const want = cycle === 'monthly' ? p.expect[n] * 100 : p.expect[n] * 100 * 10
        const ok = subtotal === want
        if (!ok) fails++
        console.log(`${ok ? '✅' : '❌'} ${p.label.padEnd(17)} ${cycle.padEnd(8)} ${String(n).padStart(2)} properties  ${money(subtotal).padStart(10)}   want ${money(want)}`)
      }
    }
  }
  console.log('')
  if (fails) { console.log(`❌ ${fails} MISMATCH(ES). Do not let anyone buy a Pro plan.`); process.exit(1) }
  console.log('✅ EVERY PLAN MATCHES THE DECISION TABLE, monthly and annual (annual = ×10).')
}
main().catch(e => { console.error('FATAL', e); process.exit(2) })

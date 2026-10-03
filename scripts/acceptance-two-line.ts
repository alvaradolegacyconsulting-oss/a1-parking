// ════════════════════════════════════════════════════════════════════
// Live two-line acceptance — Operator Pro, 2 properties
// ════════════════════════════════════════════════════════════════════
//
// Pairs with docs/RUNBOOK_live_two_line_acceptance.md. Jose runs it.
//
// Closes the long-open P1: a base + per-property subscription has never
// run live. A1's code is base-only, so every Pro customer would
// otherwise be the first real test of that path.
//
// 🔴 TEARDOWN REFUSES ANYTHING THAT IS NOT THE THROWAWAY. It matches on
// the exact company name and on a subscription whose customer carries
// that name. A1 shares the same Stripe account; a teardown that trusted
// "the most recent subscription" could cancel the only paying customer.
//
// Usage: npx tsx scripts/acceptance-two-line.ts <before|after|after-add|teardown>
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const THROWAWAY = 'ZZ Two Line Acceptance'
const A1_SUB = 'sub_1Tsa6zKM2PcfaFN9dZ64CQVR'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const key = process.env.STRIPE_LIVE_SECRET_KEY
if (!key) { console.error('STRIPE_LIVE_SECRET_KEY is not set. See the runbook, step 1.'); process.exit(2) }
const stripe = new Stripe(key)
const db = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
const money = (c: number | null | undefined) => c == null ? '—' : '$' + (c / 100).toFixed(2)

async function printSub(id: string, label: string) {
  const s = await stripe.subscriptions.retrieve(id)
  console.log(`  ${label}: ${s.id}  status=${s.status}  items=${s.items.data.length}`)
  for (const it of s.items.data) {
    const t = it.price.tiers_mode ? ' graduated' : ''
    console.log(`     ${it.price.id}  qty=${it.quantity}  unit=${money(it.price.unit_amount)}${t}`)
  }
  return s
}

async function findThrowawaySub(): Promise<Stripe.Subscription | null> {
  const { data } = await db.from('companies').select('stripe_subscription_id').eq('name', THROWAWAY).maybeSingle()
  if (!data?.stripe_subscription_id) return null
  return stripe.subscriptions.retrieve(data.stripe_subscription_id)
}

const main = async () => {
  const mode = process.argv[2]

  if (mode === 'before') {
    console.log('=== A1 — the thing that must not change ===')
    await printSub(A1_SUB, 'A1')
    const { count } = await db.from('companies').select('id', { count: 'exact', head: true })
    console.log(`  companies rows: ${count}`)
    return
  }

  if (mode === 'after' || mode === 'after-add') {
    const sub = await findThrowawaySub()
    if (!sub) { console.log(`❌ no subscription recorded for "${THROWAWAY}" — did checkout complete?`); process.exit(1) }
    console.log('=== the throwaway subscription ===')
    await printSub(sub.id, THROWAWAY)
    const perProp = sub.items.data.find(i => i.price.tiers_mode)
    const wantQty = mode === 'after' ? 2 : 3
    const ok = perProp?.quantity === wantQty
    console.log(`${ok ? '✅' : '❌'} per-property quantity = ${perProp?.quantity}, want ${wantQty}`)

    if (mode === 'after') {
      const invs = await stripe.invoices.list({ subscription: sub.id, limit: 1 })
      const inv = invs.data[0]
      console.log(`  first invoice ${inv?.id}  subtotal=${money(inv?.subtotal)}  total=${money(inv?.total)}  (total includes TX tax)`)
      const sub_ok = inv?.subtotal === 33900
      console.log(`${sub_ok ? '✅' : '❌'} subtotal is $339.00 ($299 base + 2 × $20)`)
      console.log(`  line items on that invoice: ${inv?.lines.data.length}`)
      inv?.lines.data.forEach(l => console.log(`     ${l.description} — ${money(l.amount)}`))
      if (!sub_ok || (inv?.lines.data.length ?? 0) < 2) process.exit(1)
    } else {
      // The proration for the 3rd property sits on the NEXT invoice.
      const up = await (stripe.invoices as unknown as { createPreview: (a: unknown) => Promise<Stripe.Invoice> })
        .createPreview({ subscription: sub.id })
      console.log(`  upcoming invoice preview: subtotal=${money(up.subtotal)}`)

      // 🔴 DETECT THE PRORATION BY ARITHMETIC, NOT BY A FLAG.
      //
      // This filtered on `line.proration`, which does not exist on our
      // pinned API version — so it reported "0 prorated lines" and
      // printed a red X against an upcoming subtotal of $379 that was
      // exactly right. A false red on correct behaviour, on the live
      // acceptance run (2026-10-02). Same defect, same fix, as
      // verify-annual-proration.ts.
      //
      // A clean next cycle is base + 3 × per-property = $359. Anything
      // above that is catch-up for the mid-cycle add. The arithmetic
      // cannot go stale when Stripe renames or drops a field.
      //
      // It also now GATES. The flag version printed ❌ and exited 0,
      // because only the quantity check fed `ok` — so the one assertion
      // most likely to be wrong was the one that could not fail the run.
      const cleanRecurring = 29900 + 3 * 2000
      const extra = (up.subtotal ?? 0) - cleanRecurring
      const pro_ok = extra > 0
      console.log(`${pro_ok ? '✅' : '❌'} a proration is PENDING on the next invoice — ` +
        `upcoming ${money(up.subtotal)} vs clean recurring ${money(cleanRecurring)} → ${money(extra)} of catch-up`)
      up.lines.data.forEach(l => console.log(`     ${l.description} — ${money(l.amount)}`))
      if (!pro_ok) process.exit(1)
    }
    if (!ok) process.exit(1)
    return
  }

  if (mode === 'teardown') {
    const { data: co } = await db.from('companies').select('id, name, stripe_subscription_id, stripe_customer_id').eq('name', THROWAWAY).maybeSingle()
    if (!co) { console.log('nothing to tear down — no such company'); return }
    // 🔴 The refusal. Name must match exactly, and the subscription must
    // not be A1's. A1 lives in the same Stripe account.
    if (co.name !== THROWAWAY) { console.log('ABORT — company name mismatch'); process.exit(1) }
    if (co.stripe_subscription_id === A1_SUB) { console.log('ABORT — that is A1\'s subscription'); process.exit(1) }

    if (co.stripe_subscription_id) {
      const sub = await stripe.subscriptions.retrieve(co.stripe_subscription_id)
      const invs = await stripe.invoices.list({ subscription: sub.id, limit: 10 })
      for (const inv of invs.data) {
        const chargeId = (inv as unknown as { charge?: string }).charge
        if (chargeId) {
          const r = await stripe.refunds.create({ charge: chargeId })
          console.log(`  refunded ${chargeId} → ${r.id} ${money(r.amount)} status=${r.status}`)
        }
      }
      await stripe.subscriptions.cancel(sub.id)
      console.log(`  cancelled ${sub.id}`)
    }

    const props = await db.from('properties').delete().eq('company', THROWAWAY).select('id')
    const roles = await db.from('user_roles').delete().eq('company', THROWAWAY).select('email')
    const comp  = await db.from('companies').delete().eq('name', THROWAWAY).select('id')
    console.log(`  deleted: properties=${props.data?.length ?? 0} user_roles=${roles.data?.length ?? 0} companies=${comp.data?.length ?? 0}`)
    console.log('  (Stripe Customer left in place — the refund record lives on it)')
    return
  }

  console.log('usage: before | after | after-add | teardown')
  process.exit(2)
}
main().catch(e => { console.error('FATAL', e instanceof Error ? e.message : String(e)); process.exit(1) })

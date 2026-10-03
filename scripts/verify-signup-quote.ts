// ════════════════════════════════════════════════════════════════════
// GATE — the price we SHOW equals the price Stripe CHARGES
// ════════════════════════════════════════════════════════════════════
//
// 🔴 WHAT THIS EXISTS TO CATCH. On 2026-10-02 a live acceptance run
// reached Stripe Checkout and found it correct — Operator Pro, 2
// properties, $299 + 2 × $20 = $339. Our own /signup page, one click
// earlier, said "$199.00 — $199/mo base + $0/property × 2". Checkout
// was right and every screen before it was wrong, because the display
// read hardcoded TIER_PRICING constants while the charge read
// stripe_prices. verify:pricing already proved Stripe charges the right
// amount. Nothing proved we SHOW it.
//
// So this gate drives the real display path — quoteFromLines(), the
// same function app/signup and app/signup/verify render from — over
// the real catalog rows, and checks each cell THREE ways:
//
//   1. against the published decision table, declared below and not
//      derived from anything the app computes;
//   2. against Stripe's own invoice preview for the same line items,
//      so the graduated band arithmetic is validated by the engine that
//      will actually run it rather than by agreeing with itself;
//   3. against the sentence a buyer reads, so "$0/property" under a
//      correct total cannot pass.
//
// 4 plans × 2 cycles × 5 property counts = 40 cells.
//
// Usage: STRIPE_MODE=test npx tsx scripts/verify-signup-quote.ts

import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import { quoteFromLines, describeQuote, formatUsd, PROPERTY_CEILING, type QuoteLine } from '../app/lib/pricing-quote'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const MODE = (process.env.STRIPE_MODE === 'live' ? 'live' : 'test') as 'live' | 'test'
const key = MODE === 'live' ? process.env.STRIPE_LIVE_SECRET_KEY : (process.env.STRIPE_TEST_SECRET_KEY || g('STRIPE_TEST_SECRET_KEY'))
if (!key) { console.error('no Stripe key'); process.exit(2) }
const stripe = new Stripe(key)
const db = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

// ── The decision table (DECISION_pricing_selfserve_pro_tiers_oct2_2026)
// Monthly dollars. Annual is the same figure × 10 — the catalog holds
// separate annual Prices at ten times the monthly rate.
// PM Starter has NO per-property axis: one property by definition, so
// its total does not move with the count. The missing line is the
// correct shape, not an omission — and the quote must not invent a
// per-property charge for it at 20 or 50.
const COUNTS = [1, 2, 20, 21, 50]
type Plan = { label: string; track: string; tier: string; base: number; perProp: number | null }
const PLANS: Plan[] = [
  { label: 'PM Starter',       track: 'property_management', tier: 'pm_starter',       base: 149, perProp: null },
  { label: 'PM Pro',           track: 'property_management', tier: 'legacy',           base: 249, perProp: 15 },
  { label: 'Operator Starter', track: 'enforcement',         tier: 'enforcement_only', base: 199, perProp: 15 },
  { label: 'Operator Pro',     track: 'enforcement',         tier: 'legacy',           base: 299, perProp: 20 },
]
// The 20/50 step: the per-property rate applies to the first 20 only.
const BAND_CUTOFF = 20
const ANNUAL_MULT = 10

function expectedDollars(p: Plan, n: number, cycle: 'monthly' | 'annual'): number {
  const billable = p.perProp === null ? 0 : Math.min(n, BAND_CUTOFF) * p.perProp
  const monthly = p.base + billable
  return cycle === 'monthly' ? monthly : monthly * ANNUAL_MULT
}

let fails = 0
const fail = (m: string) => { console.log(`❌ ${m}`); fails++ }

async function main() {
  console.log(`mode=${MODE}\n`)

  // ── Structural: the projection still carries the bands ────────────
  // getStandardCatalogLines went years without selecting price_model or
  // tiers, which is why no caller could price a graduated line and why
  // the display grew its own constants. If that select narrows again
  // the arithmetic below silently returns base-only totals.
  const helper = fs.readFileSync('app/lib/stripe-catalog.ts', 'utf8')
  const sel = helper.match(/\.select\('([^']+)'\)/)?.[1] ?? ''
  for (const col of ['price_model', 'tiers', 'unit_amount_cents', 'line_item']) {
    if (!sel.includes(col)) fail(`stripe-catalog select is missing '${col}' — graduated lines cannot be priced`)
  }

  // ── The "properties 21-50 are free" copy must match the real cap ──
  // PROPERTY_CEILING only writes a sentence; the migration enforces the
  // limit. If the cap moves and the copy does not, we advertise a range
  // we do not honour.
  const capSql = fs.readFileSync('migrations/20261002_property_ceiling_50_with_a1_override.sql', 'utf8')
  const capDeclared = [...capSql.matchAll(/RETURN (\d+);\s*--\s*\u0001?.*ceiling/gi)].map(m => Number(m[1]))
  const caps = capDeclared.length ? capDeclared : [...capSql.matchAll(/RETURN (\d+);/g)].map(m => Number(m[1]))
  if (!caps.includes(PROPERTY_CEILING)) {
    fail(`PROPERTY_CEILING is ${PROPERTY_CEILING} but the applied ceiling migration returns ${caps.join('/')} — the "21-${PROPERTY_CEILING} are free" copy is lying`)
  } else {
    console.log(`✅ property ceiling copy matches the applied migration (${PROPERTY_CEILING})\n`)
  }

  // ── Neither page may compute a price locally any more ──────────────
  for (const page of ['app/signup/page.tsx', 'app/signup/verify/page.tsx']) {
    const src = fs.readFileSync(page, 'utf8')
    const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    if (/getTierPricing\s*\(/.test(code)) fail(`${page} still calls getTierPricing — the display must not hold a price`)
    if (/\.perProp\b/.test(code) || /\?\.base\b/.test(code)) fail(`${page} still reads a price off OFFERINGS`)
  }

  // ── Every cell ────────────────────────────────────────────────────
  for (const p of PLANS) {
    for (const cycle of ['monthly', 'annual'] as const) {
      const { data: rows, error } = await db.from('stripe_prices')
        .select('line_item, stripe_price_id, stripe_product_id, unit_amount_cents, lookup_key, price_model, tiers')
        .eq('tier_track', p.track).eq('tier_name', p.tier)
        .eq('cycle', cycle).eq('mode', MODE)
        .is('proposal_code_id', null).eq('is_active', true)
        .order('line_item')
      if (error) { fail(`${p.label}/${cycle}: catalog read failed: ${error.message}`); continue }
      if (!rows?.length) { fail(`${p.label}/${cycle}: NO catalog rows`); continue }

      for (const n of COUNTS) {
        const want = expectedDollars(p, n, cycle) * 100

        // (1) what the PAGES render, through the real display function
        const quote = quoteFromLines(rows as unknown as QuoteLine[], n)
        const shown = quote.total_cents
        const sentence = describeQuote(quote.lines)

        // (2) what STRIPE makes of the same basket
        const items = rows.map(l => ({
          price: l.stripe_price_id as string,
          quantity: l.line_item === 'per_property' ? n : 1,
        })).filter(i => i.quantity > 0)
        let charged: number | null = null
        try {
          const prev = await (stripe.invoices as unknown as {
            createPreview: (a: unknown) => Promise<{ subtotal: number }>
          }).createPreview({ currency: 'usd', subscription_details: { items } })
          charged = prev.subtotal
        } catch (e) {
          fail(`${p.label}/${cycle}/${n}: Stripe preview failed: ${(e as Error).message}`)
        }

        const okTable  = shown === want
        const okStripe = charged !== null && shown === charged
        // (3) the explanation must not contradict the figure
        const okWords  = !/× \$0\.00/.test(sentence)

        const ok = okTable && okStripe && okWords
        if (!ok) fails++
        const detail = [
          okTable  ? '' : ` TABLE wants ${formatUsd(want)}`,
          okStripe ? '' : ` STRIPE charges ${charged === null ? '??' : formatUsd(charged)}`,
          okWords  ? '' : ` WORDS claim a $0.00 rate`,
        ].join('')
        console.log(`${ok ? '✅' : '❌'} ${p.label.padEnd(17)} ${cycle.padEnd(8)} ${String(n).padStart(2)}p  shown ${formatUsd(shown).padStart(11)}  "${sentence}"${detail}`)
      }
    }
  }

  // ── The exact cell that was wrong in production ───────────────────
  // Named explicitly so a regression reads as itself in CI output
  // rather than as one anonymous row among forty.
  const { data: opro } = await db.from('stripe_prices')
    .select('line_item, unit_amount_cents, price_model, tiers')
    .eq('tier_track', 'enforcement').eq('tier_name', 'legacy')
    .eq('cycle', 'monthly').eq('mode', MODE)
    .is('proposal_code_id', null).eq('is_active', true)
  const regression = quoteFromLines((opro ?? []) as unknown as QuoteLine[], 2)
  if (regression.total_cents !== 33900) {
    fail(`REGRESSION: Operator Pro / monthly / 2 properties shows ${formatUsd(regression.total_cents)}, must be $339.00 (this is the live-run defect)`)
  } else {
    console.log(`\n✅ regression cell: Operator Pro / monthly / 2 properties = $339.00 — "${describeQuote(regression.lines)}"`)
  }

  console.log('')
  if (fails) { console.log(`❌ ${fails} FAILURE(S). The page may be quoting a price nobody will be charged.`); process.exit(1) }
  console.log('✅ ALL 40 CELLS: what we show = the decision table = what Stripe charges.')
}
main().catch(e => { console.error('FATAL', e); process.exit(2) })

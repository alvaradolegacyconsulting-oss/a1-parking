import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient, requireAdmin } from '../../../../lib/server-auth'
import {
  createStripePricesForProposalCode,
  isPremiumCode,
  ProposalStripeError,
  type CreatedPrice,
  type ProposalCodeForStripe,
} from '../../../../lib/proposal-code-stripe'

// Server-side Puppeteer PDF generation was attempted five times on
// Vercel (c7a6115 / 46ec4af / a661159 / 3524c8d and a bundled-binary
// variant) and consistently failed with libnss3.so load errors.
// Locked decision (May 13): hand-generate proposal PDFs until the
// Phase 2 web acceptance page lands. This endpoint performs the
// status transition + Stripe Price creation (B66.2b); the PDF is
// uploaded manually per docs/hand-gen-pdf.md.
//
// ── B66.2b commit 2 extension ────────────────────────────────────────
// At draft→issued transition, non-Premium codes get one Stripe Price
// created per line item (3 Enforcement / 2 PM) via the helper at
// app/lib/proposal-code-stripe.ts. Stripe Price creation must succeed
// before status flips to 'issued' — failure leaves the code in draft
// state for retry. Triple-layer idempotency in the helper makes retry
// safe (orphan Stripe Prices from a partial failure recover via
// lookup_key probe on next click).
//
// Premium codes (B89, contact-sales) skip Stripe Price creation
// entirely — manual invoice path. They still transition draft→issued
// normally and surface a "Premium — manual invoice path" message in
// the response. The stripe_prices.tier_name CHECK (B66.2a) doesn't
// admit 'premium', so any future Premium-via-Stripe work needs a
// schema change first (out of scope here).
//
// Server-side defense-in-depth: re-validates PM track ≠ per_driver
// override (Cluster 2.1). Form already blocks this client-side at
// app/admin/proposal-codes/new/page.tsx:252 and the [code] draft
// editor, but defense in depth covers direct-API access and stale
// client state.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin()
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id: idStr } = await ctx.params
  const id = Number(idStr)
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 })

  const supabase = await createSupabaseServerClient()

  const { data: row, error: rowErr } = await supabase
    .from('proposal_codes')
    .select('id, code, status, client_name, base_tier_type, base_tier, custom_base_fee, custom_per_property_fee, custom_per_driver_fee')
    .eq('id', id)
    .single()
  if (rowErr || !row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (row.status !== 'draft') {
    return NextResponse.json({ error: `cannot issue from status=${row.status}` }, { status: 409 })
  }
  if (!row.base_tier_type || !row.base_tier) {
    return NextResponse.json({ error: 'code missing base_tier_type or base_tier' }, { status: 400 })
  }
  if (row.base_tier_type === 'property_management' && row.custom_per_driver_fee != null) {
    return NextResponse.json(
      { error: 'property_management codes cannot have per_driver pricing (Cluster 2.1)' },
      { status: 400 }
    )
  }

  let prices: CreatedPrice[] = []
  let priceFlow: 'completed' | 'skipped_premium' = 'completed'
  let counts = { created: 0, recovered: 0, skipped: 0 }

  if (isPremiumCode(row as ProposalCodeForStripe)) {
    priceFlow = 'skipped_premium'
  } else {
    try {
      const result = await createStripePricesForProposalCode(row as ProposalCodeForStripe)
      prices = result.prices
      counts = { created: result.created, recovered: result.recovered, skipped: result.skipped }
    } catch (e) {
      if (e instanceof ProposalStripeError) {
        const status = e.stage === 'stripe' ? 502 : e.stage === 'db' ? 500 : 400
        return NextResponse.json({ error: e.message, stage: e.stage }, { status })
      }
      throw e
    }
  }

  // Status flip happens only after Stripe + DB writes complete (or
  // are bypassed for Premium). pdf_url stays NULL — manual hand-gen
  // per existing convention.
  const { error: updErr } = await supabase
    .from('proposal_codes')
    .update({
      status: 'issued',
      issued_at: new Date().toISOString(),
      issued_by: auth.email,
    })
    .eq('id', id)
  if (updErr) return NextResponse.json({ error: 'row update failed: ' + updErr.message }, { status: 500 })

  return NextResponse.json({
    success: true,
    code: row.code,
    pdf_pending: true,
    price_flow: priceFlow,
    prices,
    counts,
    message: priceFlow === 'skipped_premium'
      ? 'Code issued. Premium tier uses manual invoice path — no Stripe Prices created. PDF generation pending — see docs/hand-gen-pdf.md.'
      : `Code issued with ${prices.length} Stripe Prices (created ${counts.created}, recovered ${counts.recovered}, skipped ${counts.skipped}). PDF generation pending — see docs/hand-gen-pdf.md.`,
  })
}

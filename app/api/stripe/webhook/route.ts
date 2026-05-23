import 'server-only'
import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getStripe } from '../../../lib/stripe'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { getStripeBillingEnabled } from '../../../lib/platform-flags'
import { handleCheckoutSessionCompleted } from '../../../lib/stripe-event-handlers'

// B66.1 — Stripe webhook endpoint scaffold.
//
// Single endpoint for both test + live events (Cluster 1.1). Internal
// routing based on which signing secret validates the payload:
//   • TEST_WEBHOOK_SECRET validates → mode='test'
//   • LIVE_WEBHOOK_SECRET validates → mode='live'
//   • Neither validates → 400.
//
// Once verified, the event is persisted to stripe_events with
// processed=false. The background processor (B66.5+ work) handles
// state updates asynchronously. B66.1 only persists — does not process.
//
// Behavior when STRIPE_BILLING_ENABLED=false: signature is still
// verified (to reject malformed callers), then 200 OK no-op without
// inserting. This prevents test-mode webhook noise from accumulating
// in the events table during pre-launch, and prevents Stripe retry
// storms if our DB has issues.
//
// SECURITY MODEL:
//   • Stripe is the only legitimate caller (signature verification).
//   • No auth headers, no JWT — middleware allowlist required
//     (see middleware.ts publicPaths).
//   • Raw body via request.text() — Stripe signature verification
//     requires unmodified UTF-8 bytes.
//
// FAILURE MODES:
//   • Missing/invalid signature → 400 (Stripe doesn't retry on 4xx).
//   • Verification failure → 400.
//   • DB insert failure → log + 200 OK (NOT 5xx — we don't want
//     Stripe retry storms triggered by our DB hiccups). Lost events
//     are recoverable from Stripe Dashboard event log.
//   • Duplicate event.id → caught by UNIQUE constraint, log + 200 OK
//     (idempotent per Cluster 6.2).

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text().catch(() => null)
  if (rawBody === null) {
    console.log('[stripe webhook] body read failed')
    return NextResponse.json({ error: 'body unreadable' }, { status: 400 })
  }

  const signature = request.headers.get('stripe-signature')
  if (!signature) {
    console.log('[stripe webhook] missing stripe-signature header')
    return NextResponse.json({ error: 'missing signature' }, { status: 400 })
  }

  const testSecret = process.env.STRIPE_TEST_WEBHOOK_SECRET
  const liveSecret = process.env.STRIPE_LIVE_WEBHOOK_SECRET

  if (!testSecret && !liveSecret) {
    console.log('[stripe webhook] no webhook secrets configured — rejecting all')
    return NextResponse.json({ error: 'webhook not configured' }, { status: 400 })
  }

  const stripe = getStripe()
  let event: Stripe.Event | null = null
  let mode: 'test' | 'live' | null = null

  // Try TEST secret first if configured, then LIVE. Whichever validates
  // determines the event's mode. Stripe's static constructEvent does
  // not depend on the SDK's instantiated keypair, so this is safe.
  if (testSecret) {
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, testSecret)
      mode = 'test'
    } catch {
      event = null
    }
  }
  if (!event && liveSecret) {
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, liveSecret)
      mode = 'live'
    } catch {
      event = null
    }
  }

  if (!event || !mode) {
    // Truncated signature hash for log correlation without leaking the full sig.
    const sigPrefix = signature.slice(0, 20)
    console.log('[stripe webhook] signature verification failed', { sigPrefix })
    return NextResponse.json({ error: 'signature verification failed' }, { status: 400 })
  }

  // Layer 2 dormancy check — verified but billing disabled = no-op.
  const billingEnabled = await getStripeBillingEnabled()
  if (!billingEnabled) {
    console.log('[stripe webhook] billing disabled — no-op ack', {
      eventId: event.id,
      eventType: event.type,
      mode,
    })
    return NextResponse.json({ received: true, processed: false, reason: 'billing_disabled' })
  }

  // Persist the event. Caller is Stripe (signature-verified) and has
  // no JWT — service_role bypasses RLS for the insert.
  const supabase = createSupabaseServiceClient()
  const { error } = await supabase.from('stripe_events').insert({
    stripe_event_id: event.id,
    event_type: event.type,
    mode,
    raw_event: event as unknown as Record<string, unknown>,
  })

  if (error) {
    // Duplicate event.id from a Stripe retry — already persisted; idempotent ack.
    // Postgres UNIQUE violation code is 23505.
    if (error.code === '23505') {
      console.log('[stripe webhook] duplicate event — idempotent ack', {
        eventId: event.id,
        eventType: event.type,
        mode,
      })
      return NextResponse.json({ received: true, processed: false, reason: 'duplicate' })
    }
    // Any other DB error — log + 200 OK (NOT 5xx). Stripe retries on 5xx
    // and we don't want our DB hiccups to cause Stripe-side retry storms.
    // The event is recoverable from Stripe Dashboard if needed.
    console.log('[stripe webhook] db insert failed — ack-and-drop', {
      eventId: event.id,
      eventType: event.type,
      mode,
      errCode: error.code,
      errMsg: error.message,
    })
    return NextResponse.json({ received: true, processed: false, reason: 'db_error' })
  }

  console.log('[stripe webhook] persisted', {
    eventId: event.id,
    eventType: event.type,
    mode,
  })

  // ── B66.3 inline event-type routing ─────────────────────────────────
  // Single handler dispatched here today (checkout.session.completed →
  // creates the self-serve company). Per Jose's B66.5+ refactor note:
  // each handler is self-contained in app/lib/stripe-event-handlers.ts
  // so the future out-of-band processor can lift the dispatch logic
  // wholesale (just swap `await handleX(event)` for
  // `await enqueue(event)` here; processor calls the same handlers).
  // Failures are logged + acked 200 OK (consistent with B66.1's fail-
  // closed posture against Stripe retry storms); processed state is
  // recorded on stripe_events for B66.5+ recovery/replay.
  if (event.type === 'checkout.session.completed') {
    const result = await handleCheckoutSessionCompleted(event)
    if (result.ok) {
      await supabase
        .from('stripe_events')
        .update({ processed: true, processed_at: new Date().toISOString() })
        .eq('stripe_event_id', event.id)
      console.log('[stripe webhook] checkout.session.completed processed', {
        eventId: event.id, companyId: result.companyId,
      })
      return NextResponse.json({ received: true, processed: true, companyId: result.companyId })
    } else {
      await supabase
        .from('stripe_events')
        .update({ process_error: result.reason, process_attempts: 1 })
        .eq('stripe_event_id', event.id)
      console.error('[stripe webhook] checkout.session.completed FAILED', {
        eventId: event.id, reason: result.reason,
      })
      // 200 OK despite handler failure — event is persisted with error
      // state for B66.5+ replay/manual reconciliation. Returning 5xx
      // would trigger Stripe retry storms, which compounds the problem.
      return NextResponse.json({ received: true, processed: false, reason: 'handler_error', error: result.reason })
    }
  }

  return NextResponse.json({ received: true, processed: false, reason: 'persisted' })
}

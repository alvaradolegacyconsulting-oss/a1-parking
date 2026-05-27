import 'server-only'
import type Stripe from 'stripe'
import type { EventHandler } from './types'

import { handleCheckoutSessionCompleted } from './checkout-session-completed'
import { handleSubscriptionUpdated } from './subscription-updated'
import { handleSubscriptionDeleted } from './subscription-deleted'
import { handleCustomerUpdated } from './customer-updated'
import { handleInvoicePaymentFailed } from './invoice-payment-failed'
import { handleInvoicePaymentSucceeded } from './invoice-payment-succeeded'
import { handleInvoicePaymentActionRequired } from './invoice-payment-action-required'

// Re-exports — handlers stay individually importable for tests + future
// processor lift (per B66.5 pre-flight: when the out-of-band processor
// arrives, it imports these directly; no route refactor needed).
export {
  handleCheckoutSessionCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleCustomerUpdated,
  handleInvoicePaymentFailed,
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentActionRequired,
}
export type { HandlerResult, SyncResult, SkipResult, EventResult, EventHandler } from './types'

// ════════════════════════════════════════════════════════════════════
// Centralized dispatch map (B66.5 Decision 2b1) — single source of truth
// for "which event types we handle." Adding a new event type = adding
// one entry here + one handler file.
//
// Cast safety: Stripe's event.type IS the discriminator on Stripe.Event.
// Looking up by event.type in this map guarantees the matched handler's
// typed parameter is correct. The cast is a TS-level necessity (the
// dispatch map can't be typed per-key without a much more complex
// mapped-type setup); the runtime invariant holds.
// ════════════════════════════════════════════════════════════════════
export const dispatch: Record<string, EventHandler> = {
  'checkout.session.completed':
    (e) => handleCheckoutSessionCompleted(e as Stripe.CheckoutSessionCompletedEvent),
  'customer.subscription.updated':
    (e) => handleSubscriptionUpdated(e as Stripe.CustomerSubscriptionUpdatedEvent),
  'customer.subscription.deleted':
    (e) => handleSubscriptionDeleted(e as Stripe.CustomerSubscriptionDeletedEvent),
  'customer.updated':
    (e) => handleCustomerUpdated(e as Stripe.CustomerUpdatedEvent),
  'invoice.payment_failed':
    (e) => handleInvoicePaymentFailed(e as Stripe.InvoicePaymentFailedEvent),
  'invoice.payment_succeeded':
    (e) => handleInvoicePaymentSucceeded(e as Stripe.InvoicePaymentSucceededEvent),
  'invoice.payment_action_required':
    (e) => handleInvoicePaymentActionRequired(e as Stripe.InvoicePaymentActionRequiredEvent),
}

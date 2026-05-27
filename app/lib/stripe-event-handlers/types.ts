import 'server-only'
import type Stripe from 'stripe'

// Discriminated unions returned by all handlers. Three variants:
//   • HandlerResult — used by checkout-session-completed (only handler
//     that creates a NEW companies row + returns companyId).
//   • SyncResult — used by handlers that UPDATE an existing companies row
//     (no companyId to return).
//   • SkipResult — B66.5 — used by handlers that executed cleanly but
//     made no state change. Distinct from failure: skipped events still
//     flip processed=true on stripe_events with process_skip_reason
//     populated (vs. failures, which leave processed=false + populate
//     process_error). Examples:
//       • event arrives for a customer/subscription we don't own
//       • account_state already in dunning lifecycle, no further change
//       • idempotent re-delivery of a recovery already applied
export type HandlerResult =
  | { ok: true; companyId: number }
  | { ok: false; reason: string }

export type SyncResult =
  | { ok: true }
  | { ok: false; reason: string }

export type SkipResult =
  | { ok: true; skipped: true; reason: string }

export type EventResult = HandlerResult | SyncResult | SkipResult

// Unified handler signature for the dispatch map. Each typed handler
// (e.g., handleCheckoutSessionCompleted) takes its specific Stripe.Event
// subtype; the dispatch map's value casts the generic event before
// calling. Safe because Stripe's event.type IS the discriminator — if
// we look up by event.type, the matched handler's typed parameter is
// guaranteed correct.
export type EventHandler = (event: Stripe.Event) => Promise<EventResult>

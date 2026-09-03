# Consent v2 architecture — capture, don't build yet

**Filed:** September 3, 2026
**Priority:** BACKLOG. v1 shipped in `d82b10a` (version-pinned row check at checkout).
**Origin:** Mateo Sep 3 discussion during picker research.

## Context

Self-serve signup has three endpoints:
1. `supabase.auth.signUp` — creates the auth user (client-side call, CAPTCHA-gated by
   Supabase Auth's Turnstile integration)
2. `/api/signup/attest` — records TOS/Privacy/Texas rows in `tos_acceptances` (via
   `accept_signup_consents` RPC)
3. `/api/signup/create-checkout-session` — kicks off Stripe checkout → webhook
   provisions company

Endpoint 2 is skippable on the way to endpoint 3. **`d82b10a` closes the gap** by
having endpoint 3 refuse to proceed unless three tos_acceptances rows exist at the
current pinned versions (TOS_VERSION, PRIVACY_VERSION, TEXAS_ATTESTATION_VERSION
from `lib/legal-versions.ts`).

That's v1: a row check at the last endpoint. Cheap, direct, ships today.

Proposal-code path doesn't have this shape because `redeem_proposal_code` writes
the company + `user_roles.company_id` + three `tos_acceptances` rows + `user_roles`
version stamps all in one RPC — consent is a side effect of provisioning.

## Why v2

v1's shape has one property: it's a checkpoint AT checkout, not at company
provisioning. Company provisioning happens later, in the `checkout.session.completed`
webhook. If a subscriber's session state changes (e.g., they hit the checkout with
consent recorded, then somehow have the rows deleted before the webhook fires — an
edge case that requires either a bug or a deliberate attack via a different endpoint),
the company could provision without provable consent-at-time-of-provisioning.

Not a live concern today. Filed for consideration when we want the same atomicity
proposal-code has.

## Option 1 — 🔴 NEVER SHIP AS-STATED

*Move consent-recording into the webhook handler at `checkout.session.completed`,
reading version pins from `user_metadata`.*

**REJECTED by Mateo Sep 3 §1.** `user_metadata` is client-writable via
`supabase.auth.updateUser({ data: {...} })`. A caller could set `tos_reviewed_version`
to any string, and the webhook would record consent to terms the user never saw.

The `intended_tier` precedent doesn't transfer: a forged tier fails downstream (catalog
lookup rejects it, checkout breaks loudly). **A forged consent record succeeds and
looks correct forever** — nothing downstream validates it, because a consent row IS
the validation.

**IF this shape is ever revisited, version pins MUST come from `lib/legal-versions.ts`
at webhook time, NEVER from the payload.** Even then, the shape is worse than v1
because the webhook has to duplicate the version-pin read the /attest endpoint already
does, and any drift between the two endpoints' pin-read time creates a race window.

See [[feedback_user_metadata_client_writable]] for the class rule.

## Option 2 — Signed nonce

`/api/signup/attest` returns a JWT (or Supabase-signed nonce) attesting "user X accepted
TOS_VERSION=v1.3, PRIVACY_VERSION=v1.1, TEXAS_ATTESTATION_VERSION=v1.0 at time T."
`/api/signup/create-checkout-session` requires the nonce as a body param, verifies the
server-signed content, and passes it through as `session.metadata.consent_nonce` on
the Stripe Checkout Session. Webhook validates the nonce again + records consent AT
provisioning time.

Pros:
- Consent-at-provisioning atomicity (matches proposal-code shape)
- No user_metadata dependency; nonce is server-signed
- Nonce content is inspectable server-side without a DB round-trip

Cons:
- More moving parts (JWT signing infra, verify path in 3 places)
- Requires a JWT secret (already have SUPABASE_JWT_SECRET; feasible)
- Nonce expiry management (short TTL to prevent replay across sessions)

## Option 3 — Consent as a webhook precondition, checking DB rows

Simplest option 2 variant. `/api/signup/create-checkout-session` puts the user's
tos_acceptances row IDs in `session.metadata.consent_row_ids`. Webhook re-reads
`tos_acceptances` at provisioning time, verifies the rows still exist at current
versions, records provisioning against those specific rows.

Pros:
- No signing infrastructure — just row references
- Row IDs are opaque BIGINTs; can't be forged into content
- Naturally version-pinned via re-read

Cons:
- Two DB round-trips (checkout time + webhook time)
- Row deletion race window (attacker deletes row after checkout but before webhook —
  requires RLS write bypass or admin action, so extremely unlikely)

## When to revisit

Any of:

1. A B118-Layer-2-style consent-migration audit finds gaps at provisioning time (v1's
   checkpoint-at-checkout doesn't cover that path)
2. Legal review flags "consent-at-time-of-purchase" vs "consent-at-time-of-checkout"
   as a distinction that matters for their case
3. A different self-serve flow gets added (e.g., in-app plan-change) that also needs
   consent verification — v1's inline pattern duplicates the logic; a signed nonce or
   canonical helper would centralize it

Absent any of these, v1's row check is sufficient. Don't build until then.

## Related

- v1 shipped: `d82b10a` (create-checkout-session row check)
- Migration: `20260710_acceptance_reviewed_at_signup_extension.sql` (idempotent RPC,
  version-based guard)
- Precedent: `20260707_b118_layer2_redeem_two_click_and_stamp.sql`
  (`redeem_proposal_code` atomicity)
- Memory: [[feedback_user_metadata_client_writable]] — forgeability class rule
- Memory: [[feedback_legal_version_pinning]] — server-side version pins

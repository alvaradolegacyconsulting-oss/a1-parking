# Backlog — `accept_saas_agreement` self-serve chicken-and-egg

**Filed:** 2026-07-22 during B2-5 C5 (Order Form snapshot) preflight.
**Priority: HIGH — blocking B2-4 and self-serve go-live.**
**Not** a low-priority cleanup. Do not defer. This is on the critical
path for `public_signup_open = true`.

## The bug

The RPC [`accept_saas_agreement(TEXT, TIMESTAMPTZ, INET, TEXT)`](../../migrations/20260713_tos_acceptances_company_id_derivation.sql)
(latest definition at lines 493-604) requires:

1. An authenticated caller (`auth.uid()` and `auth.jwt()->>'email'` populated), AND
2. A `user_roles` row for that email — the RPC RAISEs `42501` at line
   545-547 if `v_caller_role IS NULL` after the JOIN.

On the **self-serve path**, the `user_roles` row is created by the
`checkout.session.completed` webhook AFTER Stripe checkout finishes —
not before. But the SaaS scroll-to-sign gate on `/signup/verify` fires
`/api/signup/accept-saas` → `accept_saas_agreement` **BEFORE** the user
is redirected to Stripe Checkout ([app/signup/verify/page.tsx:410-427](../../app/signup/verify/page.tsx#L410-L427)).

Chicken-and-egg: the RPC that records SaaS acceptance requires the
`user_roles` row that only exists AFTER the payment that requires the
SaaS acceptance the RPC records.

**Result:** on the self-serve path, `accept_saas_agreement` will raise
`42501` when called from `/signup/verify`. `saasError` renders on the
Verify page. The "Continue → Stripe Checkout" button never enables
(the `saasSigned` state stays false because `handleSaasSigned` errored
before setting it true).

## Why nobody's hit it in prod

`public_signup_open` has been false since deploy. Nobody has completed
the self-serve flow. A1 is on the **proposal-code path**, which does
NOT have this bug — `redeem_proposal_code` creates the `user_roles`
row + inserts the SaaS acceptance inline at Step 4d in the same
transaction ([20260710_acceptance_reviewed_at_redeem_extension.sql:200-214](../../migrations/20260710_acceptance_reviewed_at_redeem_extension.sql#L200-L214)).
No RPC dependency; no chicken-and-egg.

**Immediate impact today: zero.** But this bug fires the instant
`public_signup_open` flips.

## What it blocks

- **B2-4** (stranger-path end-to-end test) — cannot exercise self-serve
  SaaS acceptance until this is fixed.
- **B2-5 C5 self-serve half** — the Order Form snapshot FK-references
  `tos_acceptances` (the SaaS row); if that row can't be written on
  self-serve, the snapshot on that path has nothing to FK to. **C5 will
  ship structurally complete but UNTESTABLE on self-serve until this
  fix lands.** Proposal-code path (A1 + all Legacy) tests today; the
  self-serve testability question waits on this.
- **`public_signup_open = true`** — self-serve go-live is gated on
  every self-serve flow working. This is the missing piece.

## Fix shape (report-first when picked up)

Two candidate approaches:

**Option A — move `accept_saas_agreement` to run AFTER the webhook.**
Instead of firing from `/signup/verify` pre-checkout, fire it on
`/signup/success` after Stripe redirect-back. By then the webhook has
created the `user_roles` row. Two costs: (a) SaaS acceptance moves
from pre-payment to post-payment, which means we've taken the money
before the customer has clicked to accept the agreement — a legal
regression from where the flow is today. (b) Requires new logic on
`/signup/success` page + a new API route.

**Option B — allow `accept_saas_agreement` to run pre-`user_roles`.**
The RPC RAISEs when `user_roles` is missing because it needs
`company_id` for the `tos_acceptances` row. But: we KNOW company_id
will be assigned very shortly (webhook fires within seconds). Option:
allow the SaaS `tos_acceptances` row to write with NULL `company_id`
pre-webhook, then backfill in the webhook when it creates the
`user_roles` + `companies` rows. Precedent: `accept_signup_consents`
already writes `tos_acceptances` with NULL `company_id` legitimately
in the signup-path (per the audit comment at
[20260713:618](../../migrations/20260713_tos_acceptances_company_id_derivation.sql#L618) — "Legitimate NULL only on
accept_signup_consents pre-checkout").

**Option C — hybrid.** Move the SaaS scroll-gate + acceptance to a
NEW page that renders AFTER Stripe redirect-back but BEFORE the customer
lands in their dashboard. Payment happens, then a mandatory scroll-gate
before they can proceed. Legally cleaner than Option A (agreement is
accepted before the subscription is "live"), technically similar
complexity. But — this means we've taken payment for a subscription
the customer hasn't yet agreed to the terms of. Grey area.

**Recommend Option B when picked up.** Keeps the flow order matching
the customer's expectation (accept → pay), matches the existing
precedent (`accept_signup_consents` already writes NULL company_id
pre-checkout), and is the smallest change (allow NULL + backfill).
But report-first when picked up — Jose may have legal-side preferences.

## Testability today (C5 impact)

- **Proposal-code half of C5** — fully testable now.
- **Self-serve half of C5** — code path wired + source-inspection
  smoke can prove it, but no end-to-end verification until this bug
  fixes. Structural completeness only.

## Cross-references

- [B2-1 C1 preflight report](../../.claude/projects/-Users-ALC-a1-parking/memory/project_b28_signup_path_consent_forward_path.md) —
  related but different signup-path bug.
- B2-4 (pending) — stranger-path E2E test, blocked by this.
- B2-5 C5 (in flight 2026-07-22) — Order Form snapshot; testable
  today only on proposal-code path because of this.
- [migrations/20260713_tos_acceptances_company_id_derivation.sql](../../migrations/20260713_tos_acceptances_company_id_derivation.sql) —
  where the RPC RAISEs.
- [app/signup/verify/page.tsx:410-427](../../app/signup/verify/page.tsx#L410-L427) —
  where the pre-checkout call happens.
- `docs/backlog/orphaned-auth-users-after-name-collision.md` — same
  operational shape: "self-serve mechanism broken; A1 unaffected;
  invisible today because `public_signup_open = false`."

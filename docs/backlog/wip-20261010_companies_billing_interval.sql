-- ════════════════════════════════════════════════════════════════════
-- companies.billing_interval — persist the cycle
-- ════════════════════════════════════════════════════════════════════
--
-- Ruling: Jose, 2026-10-09. "Persist the interval on companies from the
-- subscription webhooks (created/updated), backfill A1 and Test PM
-- Starter 2 from Stripe, then price the portal card from the quote
-- source and retire TIER_PRICING. Don't read Stripe at render."
--
-- WHY. The CA plan card had no price at all after 2026-10-09, because
-- pricing it from the stripe_prices catalog needs to know whether the
-- subscriber is monthly or annual, and that fact lived only on the
-- Stripe subscription. `companies` carried current_period_end and
-- cancel_at_period_end but no interval.
--
-- 🔴 OUR VOCABULARY, NOT STRIPE'S. 'monthly' / 'annual', matching
-- stripe_prices.cycle and the argument /api/signup/quote takes — not
-- Stripe's 'month' / 'year'. The webhook writes the value straight off
-- the catalog row that already resolves the tier, so the tier and the
-- cycle come from ONE row and cannot disagree about the same line item.
-- Stripe's interval is only a backstop for a price that is not in
-- stripe_prices at all, and it is mapped at that boundary.
--
-- This is the same deliberate vocabulary split as `canceled` (Stripe)
-- vs `cancelled` (internal): the boundary translates once, on the way
-- in, and nothing downstream has to know Stripe's words.
--
-- NULLABLE, and that is the point. NULL means "we do not know yet" —
-- a company with no subscription, or one whose base price is not in the
-- catalog. The card must render the no-price form for NULL rather than
-- assume monthly: a wrong price is worse than no price, which is the
-- whole lesson of the $199/$339 defect.
--
-- CHECK rather than an enum: two values, and a CHECK is alterable
-- without the type-dependency dance. Deliberately NOT a default — a
-- default of 'monthly' would make every unknown company look monthly,
-- which is exactly the confident-wrong-answer shape being avoided.
--
-- Paired: wip-20261010_companies_billing_interval_verification.sql

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS billing_interval TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.companies'::regclass
       AND conname = 'companies_billing_interval_valid'
  ) THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_billing_interval_valid
      CHECK (billing_interval IS NULL OR billing_interval IN ('monthly', 'annual'));
  END IF;
END $$;

COMMENT ON COLUMN public.companies.billing_interval IS
  'Billing cycle in OUR vocabulary: monthly | annual | NULL. Matches stripe_prices.cycle and the cycle argument /api/signup/quote takes — NOT Stripe''s month/year, which is translated once at the webhook boundary. Written by handleSubscriptionUpdated (customer.subscription.created + .updated) from the SAME stripe_prices row that resolves tier/tier_type, so the two cannot disagree. Falls back to Stripe''s recurring.interval only when the base price is absent from stripe_prices, and is LEFT ALONE rather than nulled when neither resolves — losing a known value because one event could not resolve it would make the CA plan card stop pricing a company it was pricing correctly. NULL means unknown: the card renders its no-price form rather than assuming monthly.';

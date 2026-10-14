-- ════════════════════════════════════════════════════════════════════
-- companies.bulk_onboarding_enabled — flag, guard, and write path
-- ════════════════════════════════════════════════════════════════════
--
-- Ruled by Jose: take the column guard even though RLS already limits
-- companies UPDATE to super-admin, because `authenticated` holds the
-- table-level arwd grant and the first CA self-service policy (billing
-- address is the obvious candidate) would silently make the flag
-- CA-writable. Same class as the properties hole.
--
-- ── 🔴 WRITER SWEEP FIRST, as ruled. 26 writers of companies: ───────
--
-- CLIENT (authenticated) — 4 sites, ALL super-admin console:
--   admin/page.tsx:353,361,372         company edit (name, phone, tier_type…)
--   admin/proposal-codes/[code]:350    proposal-code admin
--   → none writes this column (it does not exist yet), and the guard
--     covers ONLY this column, so none is affected.
--
-- SERVICE ROLE — 13 sites, all Stripe webhooks and crons:
--   checkout-session-completed ×2, customer-updated, subscription-updated ×2,
--   subscription-deleted, invoice-payment-failed, invoice-payment-succeeded,
--   stripe-mutations (tier), proposal-codes/start-billing, cron/dunning ×3
--   → exempt: current_user = 'service_role'.
--
-- DEFINER RPCs that write companies — 8:
--   super_admin_deactivate_company, super_admin_reactivate_company,
--   redeem_proposal_code, set_company_logo, update_my_company_tdlr,
--   accept_tos, accept_signup_consents, get_company_property_limit
--   → exempt: current_user = the function owner.
--
-- 🔴 THAT SWEEP CHOSE THE MECHANISM. Two of those RPCs —
-- update_my_company_tdlr and accept_tos — are CA-FACING. A guard keyed
-- on auth.jwt() + role, the way the properties guard is, would see the
-- CA's own JWT INSIDE those DEFINER functions and refuse them the day a
-- column they write joins the protected list. current_user does not
-- have that failure mode: a DEFINER RPC is exempt by what it is.
--
-- Blast radius today is provably ZERO: the column does not exist yet,
-- so nothing can already be writing it.
--
-- Paired: wip-20261014_companies_bulk_onboarding_flag_verification.sql

-- ── 1. the column ───────────────────────────────────────────────────
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS bulk_onboarding_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.companies.bulk_onboarding_enabled IS
  'Super-admin switch for the customer-owned bulk onboarding surface. OFF for every company by default: while false the CA sees nothing new. Writable ONLY through set_company_bulk_onboarding — companies_protected_columns_guard refuses a direct write by an authenticated session, including a super-admin''s, so the flip is always audited with its prior value.';

-- ── 2. the guard ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.companies_protected_columns_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
-- 🔴 NOT SECURITY DEFINER. Inside a DEFINER function current_user is
-- the OWNER, so a DEFINER guard would read 'postgres' for every caller
-- and permit everything while looking installed. Same reasoning, and
-- the same trap, as vehicles_activation_guard.
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_changed TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- Anything that is not a signed-in PostgREST session passes: the 13
  -- service-role Stripe writers, the 8 DEFINER RPCs, migrations, cron.
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  -- 🔴 array_append, NOT `v_changed || 'col'`. With an untyped literal
  -- Postgres resolves text[] || unknown as anyarray || anyarray and
  -- raises `malformed array literal` for EVERY caller — the properties
  -- guard v1 shipped exactly that bug and six structural gates passed
  -- over it. One line today, but the list is meant to grow.
  IF NEW.bulk_onboarding_enabled IS DISTINCT FROM OLD.bulk_onboarding_enabled THEN
    v_changed := array_append(v_changed, 'bulk_onboarding_enabled');
  END IF;
  -- Future protected columns go here, one IF each, same shape.

  IF array_length(v_changed, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'company_protected_column_not_permitted'
    USING HINT = format(
      '%s can only be changed through its own RPC, so the change is audited with its prior value. Writing the column directly is refused even for a super-admin.',
      array_to_string(v_changed, ', '));
END;
$fn$;

REVOKE ALL ON FUNCTION public.companies_protected_columns_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companies_protected_columns_guard() FROM anon;
REVOKE ALL ON FUNCTION public.companies_protected_columns_guard() FROM authenticated;

COMMENT ON FUNCTION public.companies_protected_columns_guard() IS
  'Refuses a direct write to a protected companies column by an `authenticated` PostgREST session. 🔴 SECURITY INVOKER is the mechanism: inside a SECURITY DEFINER function current_user is the OWNER, so a DEFINER version would permit everything while looking installed. Chosen over the properties guard''s auth.jwt()+role shape because the writer sweep found CA-FACING DEFINER RPCs on this table (update_my_company_tdlr, accept_tos) — those would be refused by a JWT-keyed guard the day a column they write joins the list, whereas current_user exempts a DEFINER RPC by what it is. Protects bulk_onboarding_enabled today; the list is one IF per column and is asserted by CONTENTS in the paired verification.';

DROP TRIGGER IF EXISTS companies_protected_columns_guard_trigger ON public.companies;
CREATE TRIGGER companies_protected_columns_guard_trigger
  BEFORE UPDATE ON public.companies
  FOR EACH ROW
  EXECUTE FUNCTION public.companies_protected_columns_guard();

-- ── 3. the only write path ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_company_bulk_onboarding(
  p_company TEXT,
  p_enabled BOOLEAN
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor  TEXT;
  v_co     public.companies;
  v_before BOOLEAN;
BEGIN
  v_actor := lower(trim(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_actor = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_signed_in');
  END IF;
  IF public.get_my_role() <> 'admin' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_super_admin');
  END IF;

  SELECT * INTO v_co FROM public.companies
   WHERE lower(trim(name)) = lower(trim(COALESCE(p_company, '')));
  IF v_co.id IS NULL THEN
    -- Absence must not read as success.
    RETURN jsonb_build_object('ok', FALSE, 'error', 'company_not_found', 'company', p_company);
  END IF;

  v_before := COALESCE(v_co.bulk_onboarding_enabled, FALSE);
  UPDATE public.companies SET bulk_onboarding_enabled = p_enabled WHERE id = v_co.id;

  -- Audited with the PRIOR value: "turned bulk onboarding on" and
  -- "re-saved it already on" are different events, and only the
  -- before/after pair tells them apart.
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, old_values, new_values, notes)
  VALUES (v_actor, 'COMPANY_BULK_ONBOARDING_SET', 'companies', v_co.id::TEXT,
    jsonb_build_object('company', v_co.name, 'bulk_onboarding_enabled', v_before),
    jsonb_build_object('company', v_co.name, 'bulk_onboarding_enabled', p_enabled,
                       'changed', (v_before IS DISTINCT FROM p_enabled)),
    format('%s set bulk onboarding %s for %s (was %s)',
           v_actor, CASE WHEN p_enabled THEN 'ON' ELSE 'OFF' END, v_co.name, v_before));

  RETURN jsonb_build_object('ok', TRUE, 'company', v_co.name,
                            'enabled', p_enabled, 'was', v_before,
                            'changed', (v_before IS DISTINCT FROM p_enabled));
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_company_bulk_onboarding(TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_company_bulk_onboarding(TEXT, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_company_bulk_onboarding(TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_company_bulk_onboarding(TEXT, BOOLEAN) TO service_role;

COMMENT ON FUNCTION public.set_company_bulk_onboarding(TEXT, BOOLEAN) IS
  'The only write path for companies.bulk_onboarding_enabled. Super-admin only, and audited with the PRIOR value because "turned it on" and "re-saved it already on" are different events. A company name that does not resolve returns company_not_found rather than a quiet no-op.';

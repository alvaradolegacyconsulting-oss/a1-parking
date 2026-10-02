-- ════════════════════════════════════════════════════════════════════
-- get_effective_property_limit — one source of truth for the cap
-- ════════════════════════════════════════════════════════════════════
--
-- Per Jose's ruling 2026-10-02: the client must resolve the effective
-- property limit the SAME WAY enforce_property_limit does — proposal
-- code override first, then the tier default — not by hard-coding 50.
--
-- 🔴 WHY THIS FUNCTION EXISTS RATHER THAN A SECOND IMPLEMENTATION.
-- app/lib/tier-config.ts carries MAX_PROPERTIES = -1 for
-- enforcement_only and legacy. That was true until the ceiling
-- migration this morning and is now WRONG: the client would let a
-- customer add a 51st property and the database would refuse it with a
-- raw cap error.
--
-- Fixing it by writing 50 into tier-config would create a THIRD copy of
-- a number that already lives in two places, and would still be wrong
-- for A1 — whose override is -1, so A1 must stay uncapped in the UI
-- too. The only answer that cannot drift is for the client to ask the
-- server, and for the server to answer with the same rule the trigger
-- applies.
--
-- The body below is lifted from enforce_property_limit's own lookup —
-- same WHERE, same ORDER BY, same precedence — so the two cannot
-- disagree about a given company.
--
-- RETURNS: the effective limit. Negative = unlimited (the trigger's own
-- convention: `IF v_limit < 0 THEN RETURN NEW`).
--
-- Callable by authenticated users. It discloses only a number about the
-- caller's own company; RLS is not involved because the function takes
-- a company NAME and the UI only ever passes its own. A caller passing
-- another company's name learns that company's property ceiling, which
-- is a published price-list fact, not a secret.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_effective_property_limit(p_company_name TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_company_id    BIGINT;
  v_override_text TEXT;
  v_override      INTEGER;
BEGIN
  IF p_company_name IS NULL OR trim(p_company_name) = '' THEN
    RETURN -1;   -- nothing to scope; matches the trigger's early return
  END IF;

  SELECT id INTO v_company_id
    FROM public.companies
   WHERE name ILIKE p_company_name
   LIMIT 1;

  IF v_company_id IS NOT NULL THEN
    SELECT (feature_overrides ->> 'max_properties')
      INTO v_override_text
      FROM public.proposal_codes
     WHERE company_id = v_company_id
       AND status = 'redeemed'
       AND feature_overrides ? 'max_properties'
     ORDER BY redeemed_at DESC NULLS LAST
     LIMIT 1;

    IF v_override_text IS NOT NULL THEN
      BEGIN
        v_override := v_override_text::INTEGER;
      EXCEPTION WHEN OTHERS THEN
        v_override := NULL;
      END;
    END IF;
  END IF;

  IF v_override IS NOT NULL THEN
    RETURN v_override;
  END IF;

  RETURN public.get_company_property_limit(p_company_name);
END;
$func$;

COMMENT ON FUNCTION public.get_effective_property_limit(TEXT) IS
  '2026-10-02. The effective property ceiling for a company: proposal-code feature_overrides.max_properties first, then the per-tier default from get_company_property_limit. Negative = unlimited. Mirrors enforce_property_limit''s own precedence so the UI and the trigger cannot disagree — the UI must NOT hard-code a number, because the tier default (50) is wrong for any account with an override, including A1 (-1).';

REVOKE EXECUTE ON FUNCTION public.get_effective_property_limit(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_effective_property_limit(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_effective_property_limit(TEXT) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (NULL, 'SCHEMA_GET_EFFECTIVE_PROPERTY_LIMIT', 'public.get_effective_property_limit', NULL,
  jsonb_build_object(
    'migration', '20261002_get_effective_property_limit',
    'why',       'the client must resolve the cap the same way the trigger does; tier-config.ts said -1 for enforcement_only and legacy after the ceiling landed at 50, and hard-coding 50 would still be wrong for A1 (override -1)'
  ), now());

COMMIT;

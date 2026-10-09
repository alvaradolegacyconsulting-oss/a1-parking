-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — proposal_codes_summary role gate
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT. Terminal SELECT returns the PASS row.
--
-- Structural. That a resident and a driver read ZERO ROWS while a
-- company_admin still sees their deal is an execution property with
-- real sessions, proven by  npm run verify:plannames.

DO $$
DECLARE
  v_fail TEXT[] := ARRAY[]::TEXT[];
  v_def  TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_views WHERE schemaname='public' AND viewname='proposal_codes_summary') THEN
    v_fail := v_fail || 'G1: the view is GONE — DROP ran and CREATE did not';
  ELSE
    v_def := pg_get_viewdef('public.proposal_codes_summary'::regclass, true);

    -- G2 — the role gate exists
    IF v_def NOT LIKE '%company_admin%' THEN
      v_fail := v_fail || 'G2: 🔴 no company_admin role gate — every authenticated user at the company can read client_email again';
    END IF;
    IF v_def NOT LIKE '%admin%' THEN
      v_fail := v_fail || 'G2: no admin branch — super-admin reads nothing';
    END IF;

    -- G3 — pricing stays OUT. The original design excluded these and
    -- the exclusion is load-bearing: a resident must never read the
    -- negotiated rate, and A1's is $325 flat.
    IF v_def ILIKE '%custom_base_fee%' OR v_def ILIKE '%custom_per_property_fee%'
       OR v_def ILIKE '%custom_per_driver_fee%' OR v_def ILIKE '%custom_per_permit_fee%' THEN
      v_fail := v_fail || 'G3: 🔴 a pricing column is now exposed by the view';
    END IF;

    -- G4 — still redeemed-only
    IF v_def NOT LIKE '%redeemed%' THEN
      v_fail := v_fail || 'G4: the status=redeemed filter was lost — unredeemed codes are now visible';
    END IF;

    -- G5 — exact company match, not ILIKE
    IF v_def LIKE '%~~*%' THEN
      v_fail := v_fail || 'G5: the company match is still ILIKE — a name containing _ or %% is a pattern';
    END IF;

    -- G6 — the GRANT survived the DROP. Forgetting this is how the CA
    -- plan card silently starts reporting "no negotiated deal" for A1.
    IF NOT has_table_privilege('authenticated', 'public.proposal_codes_summary', 'SELECT') THEN
      v_fail := v_fail || 'G6: 🔴 authenticated lost SELECT — the CA plan card cannot tell a negotiated deal from a self-serve one and will show published wording to A1';
    END IF;
    IF has_table_privilege('anon', 'public.proposal_codes_summary', 'SELECT') THEN
      v_fail := v_fail || 'G6: 🔴 anon can SELECT the view';
    END IF;

    -- G7 — security_invoker must stay FALSE. The view is meant to
    -- bypass proposal_codes' admin-only RLS; flipping it to true would
    -- return zero rows to company_admin and break the badge.
    IF EXISTS (
      SELECT 1 FROM pg_class c
       WHERE c.oid = 'public.proposal_codes_summary'::regclass
         AND array_to_string(c.reloptions, ',') ILIKE '%security_invoker=true%'
    ) THEN
      v_fail := v_fail || 'G7: security_invoker=true — proposal_codes RLS now applies and company_admin reads nothing';
    END IF;
  END IF;

  -- G8 — the base table's RLS must still be admin-only. The view's
  -- gate is the only thing standing between a resident and this table.
  IF EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.proposal_codes'::regclass
       AND pg_get_expr(p.polqual, p.polrelid) ILIKE '%resident%'
  ) THEN
    v_fail := v_fail || 'G8: a resident-facing policy appeared on proposal_codes';
  END IF;

  IF array_length(v_fail,1) IS NOT NULL THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  - %', array_to_string(v_fail, E'\n  - ');
  END IF;
END $$;

SELECT
  'proposal_codes_summary role gate'::TEXT AS target,
  'PASS'::TEXT                             AS result,
  has_table_privilege('authenticated', 'public.proposal_codes_summary', 'SELECT') AS authenticated_select,
  (SELECT count(*) FROM public.proposal_codes WHERE status='redeemed')            AS redeemed_codes,
  'NOT PROVEN HERE: resident/driver read 0 rows. Run npm run verify:plannames.'::TEXT AS execution_proof;

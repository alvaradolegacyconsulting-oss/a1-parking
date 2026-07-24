-- ═══════════════════════════════════════════════════════════════════════
-- 20260724_pm_plate_lookup_viewing_property_verification.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Verifies pm_plate_lookup viewing-property migration.
--
-- ── Structural only ───────────────────────────────────────────────────
-- Post-apply expected silence. Pre-apply negative controls captured via
-- separate read-only diagnostic per the 8th discipline (see
-- docs/development/migration-verification-template.md "Negative controls
-- run as a diagnostic, not as the verification file"). Diagnostic
-- captures 4 flipping detectors + 2 preservation invariants — the
-- BEGIN...COMMIT wrap here would abort at the first RAISE pre-apply and
-- mask the rest.
--
-- ── Also re-run post-apply (unchanged files, must stay silent) ────────
--   • 20260723_dnt_b2_function_scope_fix_verification.sql — B2's
--     VQ.COMPANY + VQ.LIFECYCLE assert on pm_plate_lookup source. If
--     fires, the rewrite dropped a company predicate → cross-tenant
--     defect reopened inside a scoping fix.
--   • 20260723_ap_cascade_check_authorized_plate_verification.sql —
--     AP.PM_CALLS updated this commit to positive form
--     (check_authorized_plate(v_normalized, p_viewing_property)).

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- AP.PM_VIEWING_PARAM — signature gains p_viewing_property
-- ══════════════════════════════════════════════════════════════════════
DO $ap_pm_viewing_param$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'pm_plate_lookup';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'AP.PM_VIEWING_PARAM FAILED — pm_plate_lookup function not found';
  END IF;

  IF v_def NOT LIKE '%p_viewing_property%' THEN
    RAISE EXCEPTION 'AP.PM_VIEWING_PARAM FAILED — p_viewing_property parameter missing from pm_plate_lookup signature';
  END IF;
END $ap_pm_viewing_param$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.PM_VIEWING_COUNT — exactly 6 branch predicates
-- ══════════════════════════════════════════════════════════════════════
-- Count-based, not presence-based: a branch missed during the rewrite
-- fails (count=5) rather than passing on its neighbours' predicates.
-- Needle 'p_viewing_property IS NULL OR' is unique to pm_plate_lookup
-- (check_authorized_plate uses parameter name p_property, not
-- p_viewing_property) so a count in this function's source is
-- unambiguous.
DO $ap_pm_viewing_count$
DECLARE
  v_def   TEXT;
  v_count INT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'pm_plate_lookup';

  v_count := (length(v_def) - length(replace(v_def, 'p_viewing_property IS NULL OR', '')))
             / length('p_viewing_property IS NULL OR');

  IF v_count <> 6 THEN
    RAISE EXCEPTION 'AP.PM_VIEWING_COUNT FAILED — expected 6 branch predicates (p_viewing_property IS NULL OR), got %', v_count;
  END IF;
END $ap_pm_viewing_count$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.PM_AP_ARG — AP call passes p_viewing_property (positive form)
-- ══════════════════════════════════════════════════════════════════════
-- Assert what SHOULD be true, not absence of what SHOULDN'T. Absence
-- of the old NULL string is satisfied by deleting the call entirely,
-- by a typo, by anything.
DO $ap_pm_ap_arg$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'pm_plate_lookup';

  IF v_def NOT LIKE '%check_authorized_plate(v_normalized, p_viewing_property)%' THEN
    RAISE EXCEPTION 'AP.PM_AP_ARG FAILED — pm_plate_lookup does not pass p_viewing_property to check_authorized_plate';
  END IF;
END $ap_pm_ap_arg$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.PM_SIGNATURE — pg_proc count = 1 (no overload from DROP-first miss)
-- ══════════════════════════════════════════════════════════════════════
DO $ap_pm_signature$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'pm_plate_lookup';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'AP.PM_SIGNATURE FAILED — pm_plate_lookup has % overloads, expected 1', v_count;
  END IF;
END $ap_pm_signature$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.AUDIT — SCHEMA_PM_PLATE_LOOKUP_VIEWING_PROPERTY row landed
-- ══════════════════════════════════════════════════════════════════════
DO $ap_audit$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.audit_logs
  WHERE action = 'SCHEMA_PM_PLATE_LOOKUP_VIEWING_PROPERTY'
    AND new_values->>'migration' = '20260724_pm_plate_lookup_viewing_property';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'AP.AUDIT FAILED — SCHEMA_PM_PLATE_LOOKUP_VIEWING_PROPERTY row missing';
  END IF;
END $ap_audit$;

COMMIT;

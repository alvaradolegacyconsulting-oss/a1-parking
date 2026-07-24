-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_ap_cascade_check_authorized_plate_verification.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Verifies AP-CASCADE-DB (commit 2 of 4). check_authorized_plate DEFINER
-- RPC + pm_plate_lookup branch 1.5.
--
-- ── VQ inventory (structural, named per assertion) ────────────────────
-- Per Mateo's item on VQ.CHECK_SHAPE: split into named per-assertion
-- checks so any failure names WHAT differs, not just that something did.
--
--   AP.CHECK_EXISTS       — RPC present, pg_proc count = 1
--   AP.CHECK_ALIAS        — ap_p alias in RPC source
--   AP.CHECK_COMPANY      — lower(trim(ap_p.company)) = lower(trim(get_my_company()))
--   AP.CHECK_LIFECYCLE    — ap.removed_at IS NULL
--   AP.CHECK_ORDERING     — v_is_authorized assigned BEFORE returned in JSON
--                           (position()-based, not LIKE — presence ≠ order)
--   AP.CHECK_ROLE_LABEL   — role-conditional CASE with THEN v_label + ELSE NULL
--   AP.CHECK_ADMIN_ESCAPE — v_role = 'admin' OR-branch in scope predicate
--   AP.CHECK_GRANTS       — authenticated EXECUTE, anon none
--   AP.PM_CALLS           — pm_plate_lookup source contains RPC call
--   AP.PM_SETS_TYPE       — pm_plate_lookup sets v_result_type := 'authorized_plate'
--   AP.AUDIT              — SCHEMA_ row present
--
-- All 11 fail pre-apply. Post-apply silent.
--
-- ── Scope disclaimer ──────────────────────────────────────────────────
-- STRUCTURAL only. Behavioral proof is the AP-CASCADE-CLIENT ship
-- report's three-role acceptance smoke on Test-LEGACY:
--   1. Add one plate to one property (as manager or CA)
--   2. Look up as DRIVER (assigned to that property) → Authorized
--   3. Look up as MANAGER → Authorized
--   4. Look up as CA → Authorized
--   5. Look up as DRIVER assigned to a DIFFERENT Test-LEGACY property
--      → non-resident (proves scope refuses cross-property)
-- That is the feature's acceptance criterion — three paths agreeing.
--
-- Wrapped in BEGIN...COMMIT — first RAISE aborts subsequent VQs.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- AP.CHECK_EXISTS — check_authorized_plate present, count = 1
-- ══════════════════════════════════════════════════════════════════════
DO $ap_check_exists$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = 'check_authorized_plate';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'AP.CHECK_EXISTS FAILED — check_authorized_plate does not exist';
  END IF;
  IF v_count > 1 THEN
    RAISE EXCEPTION 'AP.CHECK_EXISTS FAILED — check_authorized_plate has % overloads, expected 1', v_count;
  END IF;
END $ap_check_exists$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.CHECK_ALIAS — ap_p alias in RPC source
-- ══════════════════════════════════════════════════════════════════════
DO $ap_check_alias$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'check_authorized_plate';

  IF v_def NOT LIKE '%public.properties ap_p%' THEN
    RAISE EXCEPTION 'AP.CHECK_ALIAS FAILED — ap_p alias not present in check_authorized_plate RPC source';
  END IF;
END $ap_check_alias$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.CHECK_COMPANY — company predicate with ap_p alias + get_my_company()
-- ══════════════════════════════════════════════════════════════════════
-- Exact-string assertion on the canonical company comparison.
-- ap_p is unique to the AP block by convention, unreachable from
-- unrelated get_my_company() calls elsewhere in the function body.
DO $ap_check_company$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'check_authorized_plate';

  IF v_def NOT LIKE '%lower(trim(ap_p.company)) = lower(trim(get_my_company()))%' THEN
    RAISE EXCEPTION 'AP.CHECK_COMPANY FAILED — canonical company predicate missing in check_authorized_plate RPC';
  END IF;
END $ap_check_company$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.CHECK_LIFECYCLE — ap.removed_at IS NULL filter
-- ══════════════════════════════════════════════════════════════════════
DO $ap_check_lifecycle$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'check_authorized_plate';

  IF v_def NOT LIKE '%ap.removed_at IS NULL%' THEN
    RAISE EXCEPTION 'AP.CHECK_LIFECYCLE FAILED — ap.removed_at IS NULL filter missing in check_authorized_plate RPC';
  END IF;
END $ap_check_lifecycle$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.CHECK_ORDERING — v_is_authorized assigned BEFORE returned in JSON
-- ══════════════════════════════════════════════════════════════════════
-- Presence assertion via LIKE would prove the line exists, not that it
-- precedes the return. Assert assignment position < use position, same
-- shape as B2's AP.ISDNT_ORDER. Catches the driver-card-disappears
-- failure mode: is_authorized derived from a suppressed label would
-- silently render non-authorized.
DO $ap_check_ordering$
DECLARE
  v_def   TEXT;
  v_asgn  INTEGER;
  v_use   INTEGER;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'check_authorized_plate';

  v_asgn := position('v_is_authorized :=' in v_def);
  v_use  := position('''is_authorized'', v_is_authorized' in v_def);

  IF v_asgn = 0 OR v_use = 0 OR v_use <= v_asgn THEN
    RAISE EXCEPTION 'AP.CHECK_ORDERING FAILED — v_is_authorized not assigned before use in check_authorized_plate (assign_pos=% use_pos=%)',
      v_asgn, v_use;
  END IF;
END $ap_check_ordering$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.CHECK_ROLE_LABEL — role-conditional CASE with default-deny ELSE
-- ══════════════════════════════════════════════════════════════════════
-- Asserts the label return CASE: portal roles get v_label, everyone
-- else gets NULL. Same shape as B2's AP.REASON_ROLE for check_dnt_plate.
DO $ap_check_role_label$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'check_authorized_plate';

  IF     v_def NOT LIKE '%CASE%v_role IN (''manager'',''leasing_agent'',''company_admin'',''admin'')%'
      OR v_def NOT LIKE '%THEN v_label%'
      OR v_def NOT LIKE '%ELSE NULL%'
  THEN
    RAISE EXCEPTION 'AP.CHECK_ROLE_LABEL FAILED — role-conditional CASE (portal roles → v_label, ELSE NULL) not present in check_authorized_plate';
  END IF;
END $ap_check_role_label$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.CHECK_ADMIN_ESCAPE — admin OR-branch in scope predicate
-- ══════════════════════════════════════════════════════════════════════
-- Asserts the RPC's scope-predicate branches include v_role = 'admin'.
-- Same class as B2's DNT admin escape.
DO $ap_check_admin_escape$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'check_authorized_plate';

  IF v_def NOT LIKE '%v_role = ''admin''%' THEN
    RAISE EXCEPTION 'AP.CHECK_ADMIN_ESCAPE FAILED — admin OR-branch missing in check_authorized_plate scope predicate';
  END IF;
END $ap_check_admin_escape$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.CHECK_GRANTS — authenticated EXECUTE, anon has none, PUBLIC has none
-- ══════════════════════════════════════════════════════════════════════
DO $ap_check_grants$
DECLARE
  v_auth_exec  BOOLEAN;
  v_anon_exec  BOOLEAN;
  v_pub_exec   BOOLEAN;
BEGIN
  SELECT has_function_privilege('authenticated', 'public.check_authorized_plate(text, text)', 'EXECUTE')
    INTO v_auth_exec;
  SELECT has_function_privilege('anon', 'public.check_authorized_plate(text, text)', 'EXECUTE')
    INTO v_anon_exec;
  SELECT has_function_privilege('public', 'public.check_authorized_plate(text, text)', 'EXECUTE')
    INTO v_pub_exec;

  IF NOT v_auth_exec THEN
    RAISE EXCEPTION 'AP.CHECK_GRANTS FAILED — authenticated lacks EXECUTE on check_authorized_plate';
  END IF;
  IF v_anon_exec THEN
    RAISE EXCEPTION 'AP.CHECK_GRANTS FAILED — anon has EXECUTE on check_authorized_plate (deny-by-default broken)';
  END IF;
  IF v_pub_exec THEN
    RAISE EXCEPTION 'AP.CHECK_GRANTS FAILED — PUBLIC has EXECUTE on check_authorized_plate (deny-by-default broken)';
  END IF;
END $ap_check_grants$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.PM_CALLS — pm_plate_lookup calls check_authorized_plate
-- ══════════════════════════════════════════════════════════════════════
-- Manager path integration. If missing, pm_plate_lookup silently
-- diverges from driver + CA on the same plate.
DO $ap_pm_calls$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'pm_plate_lookup';

  IF v_def NOT LIKE '%public.check_authorized_plate(v_normalized, NULL)%' THEN
    RAISE EXCEPTION 'AP.PM_CALLS FAILED — pm_plate_lookup does not call check_authorized_plate(v_normalized, NULL) — manager path diverges from driver + CA';
  END IF;
END $ap_pm_calls$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.PM_SETS_TYPE — pm_plate_lookup emits 'authorized_plate' result_type
-- ══════════════════════════════════════════════════════════════════════
-- Asserts pm_plate_lookup's branch 1.5 sets the correct status.
-- Complement to AP.PM_CALLS: RPC could be called but result ignored.
DO $ap_pm_sets_type$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'pm_plate_lookup';

  IF v_def NOT LIKE '%v_result_type      := ''authorized_plate''%'
     AND v_def NOT LIKE '%v_result_type := ''authorized_plate''%'
  THEN
    RAISE EXCEPTION 'AP.PM_SETS_TYPE FAILED — pm_plate_lookup does not set v_result_type := ''authorized_plate''';
  END IF;
END $ap_pm_sets_type$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.AUDIT — SCHEMA_AP_CASCADE_CHECK_AUTHORIZED_PLATE row landed
-- ══════════════════════════════════════════════════════════════════════
DO $ap_audit$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.audit_logs
  WHERE action = 'SCHEMA_AP_CASCADE_CHECK_AUTHORIZED_PLATE'
    AND new_values->>'migration' = '20260723_ap_cascade_check_authorized_plate';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'AP.AUDIT FAILED — SCHEMA_AP_CASCADE_CHECK_AUTHORIZED_PLATE row missing';
  END IF;
END $ap_audit$;

COMMIT;

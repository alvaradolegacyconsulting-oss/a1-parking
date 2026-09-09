-- ══════════════════════════════════════════════════════════════════════
-- 20260909_tow_log_tow_operators_verification.sql
--
-- STRUCTURAL gates for Tow Log Commit 2 (tow_operators). v2 pattern
-- (no BEGIN/COMMIT wrap; terminal SELECT returns PASS row).
--
-- ── SCOPE ──────────────────────────────────────────────────────────
-- Booleans and OIDs only. NO rendered SQL string assertions
-- (pg_get_expr output breaks under expression normalization —
-- feedback_gates_must_assert_what_they_measured item 8).
--
-- Grant audits use pg_class.relacl + pg_proc.proacl — NOT
-- information_schema.*_privileges (which under-report — see
-- feedback_information_schema_under_reports_grants).
--
-- Function signature gates use to_regprocedure() — NOT proname string
-- match with parameter-type comparison (parameter type modifiers get
-- stripped — see feedback_function_parameter_modifiers_stripped).
--
-- ── GATES ──────────────────────────────────────────────────────────
--   VS1   public.tow_operators table exists
--   VS2   9 columns present with correct types + nullability
--   VS3   tow_operators_name_no_sql_metachar CHECK exists
--   VS4   tow_operators_company_name_uniq PARTIAL unique index exists
--         (columns + partial predicate)
--   VS5   RLS enabled on the table
--   VS6   3 SELECT policies exist (admin_all / ca_own / manager_own)
--   VS7   No policy grants anon or PUBLIC
--   VS8   Table grants: SELECT for authenticated; no INSERT/UPDATE/DELETE
--         on any application role (via pg_class.relacl)
--   VS9   All 3 RPCs exist with SECURITY DEFINER (via to_regprocedure)
--   VS10  RPC grants: EXECUTE to authenticated only; not to anon,
--         not to PUBLIC (via pg_proc.proacl)
--   VS11  SCHEMA_TOW_LOG_TOW_OPERATORS audit row present
--
-- Execution gates E1-E8 are NOT in this file — Jose triggers each
-- denial by hand, reports the actual message, and the assertions get
-- written from the empirical text (feedback_gates_must_assert_what_
-- they_measured, feedback_rpc_verification_must_include_execution_gate
-- Part 2). Documented at the bottom.
-- ══════════════════════════════════════════════════════════════════════


-- ── VS1: table exists ═══════════════════════════════════════════════
DO $vs1$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tow_operators'
     AND c.relkind = 'r';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS1 FAIL: public.tow_operators table not found (count=%)', v_count;
  END IF;
END $vs1$;


-- ── VS2: 9 columns with correct type + nullability ═════════════════
-- Iterates a JSONB array of expectations. Scalar-JSONB loop form —
-- `FOR v_elem IN SELECT value FROM jsonb_array_elements(x)` binds
-- each element to a scalar JSONB variable. (An earlier draft used
-- `FOR v_col IN SELECT * FROM jsonb_array_elements(x) elem` and then
-- v_col.elem — that fails with 42703 record-has-no-field-"elem"
-- because `elem` was a table alias, not a column name; the record's
-- column is `value` by SRF default.)
DO $vs2$
DECLARE
  v_expect JSONB := jsonb_build_array(
    jsonb_build_object('name','id',                  'type','bigint',                     'nullable','NO'),
    jsonb_build_object('name','company',             'type','text',                       'nullable','NO'),
    jsonb_build_object('name','name',                'type','text',                       'nullable','NO'),
    jsonb_build_object('name','phone',               'type','text',                       'nullable','YES'),
    jsonb_build_object('name','tdlr_license_number', 'type','text',                       'nullable','YES'),
    jsonb_build_object('name','notes',               'type','text',                       'nullable','YES'),
    jsonb_build_object('name','is_active',           'type','boolean',                    'nullable','NO'),
    jsonb_build_object('name','created_at',          'type','timestamp with time zone',   'nullable','NO'),
    jsonb_build_object('name','created_by_email',    'type','text',                       'nullable','NO')
  );
  v_actual  JSONB;
  v_missing TEXT := '';
  v_elem    JSONB;
BEGIN
  FOR v_elem IN SELECT value FROM jsonb_array_elements(v_expect)
  LOOP
    SELECT jsonb_build_object(
             'name',     column_name,
             'type',     data_type,
             'nullable', is_nullable
           )
      INTO v_actual
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'tow_operators'
       AND column_name  = v_elem ->> 'name';

    IF v_actual IS NULL THEN
      v_missing := v_missing || format('MISSING %s; ', v_elem ->> 'name');
    ELSIF v_actual ->> 'type'     <> v_elem ->> 'type'
       OR v_actual ->> 'nullable' <> v_elem ->> 'nullable' THEN
      v_missing := v_missing || format(
        '%s DRIFT expected=(%s,%s) got=(%s,%s); ',
        v_elem   ->> 'name',
        v_elem   ->> 'type',     v_elem   ->> 'nullable',
        v_actual ->> 'type',     v_actual ->> 'nullable'
      );
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'VS2 FAIL: column shape mismatch: %', v_missing;
  END IF;
END $vs2$;


-- ── VS3: metachar CHECK on name ═════════════════════════════════════
DO $vs3$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class      t ON t.oid = c.conrelid
    JOIN pg_namespace  n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'tow_operators'
     AND c.conname = 'tow_operators_name_no_sql_metachar'
     AND c.contype = 'c';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS3 FAIL: tow_operators_name_no_sql_metachar CHECK not found (count=%)', v_count;
  END IF;
END $vs3$;


-- ── VS4: PARTIAL unique index (columns + partial predicate) ═════════
-- The index is unique, has 2 key columns, and has a partial predicate.
-- We assert booleans + column count (per feedback_gates_must_assert_
-- what_they_measured; rendered SQL string never becomes the gate).
DO $vs4$
DECLARE
  v_indisunique BOOLEAN;
  v_indnkeyatts SMALLINT;
  v_has_partial BOOLEAN;
BEGIN
  SELECT ix.indisunique,
         ix.indnkeyatts,
         ix.indpred IS NOT NULL
    INTO v_indisunique, v_indnkeyatts, v_has_partial
    FROM pg_class      c
    JOIN pg_namespace  n  ON n.oid = c.relnamespace
    JOIN pg_index      ix ON ix.indexrelid = c.oid
   WHERE n.nspname = 'public'
     AND c.relname = 'tow_operators_company_name_uniq';

  IF v_indisunique IS NULL THEN
    RAISE EXCEPTION 'VS4 FAIL: tow_operators_company_name_uniq index not found';
  END IF;
  IF v_indisunique IS NOT TRUE THEN
    RAISE EXCEPTION 'VS4 FAIL: index exists but not UNIQUE';
  END IF;
  IF v_indnkeyatts <> 2 THEN
    RAISE EXCEPTION 'VS4 FAIL: expected 2 key columns; got %', v_indnkeyatts;
  END IF;
  IF v_has_partial IS NOT TRUE THEN
    RAISE EXCEPTION 'VS4 FAIL: index is not PARTIAL — expected WHERE is_active predicate. Deactivated names must be reusable; a full index would collide.';
  END IF;
END $vs4$;


-- ── VS5: RLS enabled ════════════════════════════════════════════════
DO $vs5$
DECLARE v_enabled BOOLEAN;
BEGIN
  SELECT c.relrowsecurity INTO v_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tow_operators';
  IF v_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'VS5 FAIL: RLS not enabled on public.tow_operators (relrowsecurity=%)', v_enabled;
  END IF;
END $vs5$;


-- ── VS6: 3 named SELECT policies exist ═════════════════════════════
DO $vs6$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_policy
   WHERE polrelid = 'public.tow_operators'::regclass
     AND polname IN (
       'admin_all_tow_operators',
       'ca_own_tow_operators',
       'manager_own_tow_operators'
     )
     AND polcmd IN ('r', '*');  -- 'r'=SELECT, '*'=ALL (either acceptable)
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'VS6 FAIL: expected 3 named SELECT policies on public.tow_operators; got %', v_count;
  END IF;
END $vs6$;


-- ── VS7: no policy grants anon or PUBLIC ═══════════════════════════
DO $vs7$
DECLARE
  v_anon_oid OID;
  v_row RECORD;
  v_bad TEXT := '';
BEGIN
  SELECT oid INTO v_anon_oid FROM pg_roles WHERE rolname = 'anon';
  IF v_anon_oid IS NULL THEN
    RAISE EXCEPTION 'VS7 FIXTURE FAIL: no anon role in this cluster — cannot check exclusion';
  END IF;

  FOR v_row IN
    SELECT polname, polroles
      FROM pg_policy
     WHERE polrelid = 'public.tow_operators'::regclass
  LOOP
    -- polroles = {0} = PUBLIC (no role restriction). Inclusion of anon.oid
    -- also unacceptable. Require explicit authenticated targeting.
    IF v_anon_oid = ANY(v_row.polroles) OR v_row.polroles = ARRAY[0]::oid[] THEN
      v_bad := v_bad || format('%s (polroles=%s); ', v_row.polname, v_row.polroles::text);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS7 FAIL: policies grant anon or PUBLIC: %', v_bad;
  END IF;
END $vs7$;


-- ── VS8: table grants — SELECT for authenticated; no INSERT/UPDATE/DELETE
--        on any application role. Reads pg_class.relacl authoritatively
--        (information_schema.table_privileges under-reports —
--        feedback_information_schema_under_reports_grants). ═══════════
DO $vs8$
DECLARE
  v_acl aclitem[];
  v_acl_str TEXT;
  v_bad TEXT := '';
BEGIN
  SELECT c.relacl INTO v_acl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'tow_operators';

  v_acl_str := COALESCE(v_acl::text, 'NULL');

  -- Rendering aclitem[] as text is best for human review; the assertion
  -- iterates the array per-role.
  -- Expect: authenticated has r (SELECT) only; anon has nothing;
  -- PUBLIC has nothing. INSERT/UPDATE/DELETE (a/w/d) must be absent
  -- from every authenticated grant entry.
  IF NOT EXISTS (
    SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE 'authenticated=r/%'
  ) THEN
    v_bad := v_bad || format('authenticated missing SELECT-only grant (relacl=%s); ', v_acl_str);
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(v_acl) a
     WHERE a::text ~ 'authenticated=[^/]*[awd]'
  ) THEN
    v_bad := v_bad || format('authenticated has INSERT/UPDATE/DELETE grant — must be SELECT only (relacl=%s); ', v_acl_str);
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE 'anon=%'
  ) THEN
    v_bad := v_bad || format('anon has table grant — must have none (relacl=%s); ', v_acl_str);
  END IF;

  -- PUBLIC grants render as `=X/owner` (empty grantee). Fail if any exist.
  IF EXISTS (
    SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE '=%'
  ) THEN
    v_bad := v_bad || format('PUBLIC grant present — must have none (relacl=%s); ', v_acl_str);
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS8 FAIL: %', v_bad;
  END IF;
END $vs8$;


-- ── VS9: 3 RPCs exist with SECURITY DEFINER ═══════════════════════
-- to_regprocedure() resolves the signature to an OID, then we look
-- up prosecdef. Parameter-type modifiers stripped correctly here
-- (feedback_function_parameter_modifiers_stripped).
DO $vs9$
DECLARE
  v_oid  OID;
  v_secdef BOOLEAN;
  v_bad TEXT := '';
  v_sig TEXT;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.create_tow_operator(TEXT, TEXT, TEXT, TEXT)',
    'public.update_tow_operator(BIGINT, TEXT, TEXT, TEXT, TEXT)',
    'public.deactivate_tow_operator(BIGINT)'
  ]
  LOOP
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN
      v_bad := v_bad || format('MISSING %s; ', v_sig);
      CONTINUE;
    END IF;
    SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid = v_oid;
    IF v_secdef IS NOT TRUE THEN
      v_bad := v_bad || format('%s not SECURITY DEFINER (prosecdef=%s); ', v_sig, v_secdef);
    END IF;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS9 FAIL: %', v_bad;
  END IF;
END $vs9$;


-- ── VS10: RPC grants — EXECUTE to authenticated only; not anon,
--         not PUBLIC. Reads pg_proc.proacl authoritatively. ═══════
DO $vs10$
DECLARE
  v_oid  OID;
  v_acl  aclitem[];
  v_acl_str TEXT;
  v_bad TEXT := '';
  v_sig TEXT;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.create_tow_operator(TEXT, TEXT, TEXT, TEXT)',
    'public.update_tow_operator(BIGINT, TEXT, TEXT, TEXT, TEXT)',
    'public.deactivate_tow_operator(BIGINT)'
  ]
  LOOP
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN
      v_bad := v_bad || format('MISSING %s (VS9 should have caught); ', v_sig);
      CONTINUE;
    END IF;

    SELECT proacl INTO v_acl FROM pg_proc WHERE oid = v_oid;
    v_acl_str := COALESCE(v_acl::text, 'NULL');

    IF v_acl IS NULL THEN
      -- proacl NULL = default grants (typically EXECUTE to PUBLIC on
      -- SECURITY DEFINER functions per Supabase default). This is
      -- exactly what feedback_function_public_grant_supabase_default
      -- warns about; treat as failure.
      v_bad := v_bad || format('%s proacl NULL — default PUBLIC EXECUTE grant not revoked; ', v_sig);
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE 'authenticated=X/%'
    ) THEN
      v_bad := v_bad || format('%s missing authenticated EXECUTE (proacl=%s); ', v_sig, v_acl_str);
    END IF;

    IF EXISTS (
      SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE 'anon=%'
    ) THEN
      v_bad := v_bad || format('%s has anon EXECUTE grant (proacl=%s); ', v_sig, v_acl_str);
    END IF;

    IF EXISTS (
      SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE '=%'
    ) THEN
      v_bad := v_bad || format('%s has PUBLIC EXECUTE grant (proacl=%s); ', v_sig, v_acl_str);
    END IF;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS10 FAIL: %', v_bad;
  END IF;
END $vs10$;


-- ── VS11: audit row present ═════════════════════════════════════════
DO $vs11$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_TOW_LOG_TOW_OPERATORS'
     AND new_values ->> 'migration' = '20260909_tow_log_tow_operators';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS11 FAIL: audit row missing';
  END IF;
END $vs11$;


-- ── FINAL: PASS row ══════════════════════════════════════════════
SELECT
  'PASS'::TEXT AS status,
  'tow_operators structural (Tow Log Commit 2)'::TEXT AS target,
  ARRAY[
    'VS1   public.tow_operators table exists',
    'VS2   9 columns present with correct type + nullability',
    'VS3   tow_operators_name_no_sql_metachar CHECK exists',
    'VS4   tow_operators_company_name_uniq PARTIAL unique index (2 key cols, WHERE clause)',
    'VS5   RLS enabled',
    'VS6   3 SELECT policies exist (admin_all / ca_own / manager_own)',
    'VS7   no policy grants anon or PUBLIC',
    'VS8   table grants — SELECT-only for authenticated; no anon/PUBLIC; no INSERT/UPDATE/DELETE',
    'VS9   3 RPCs exist with SECURITY DEFINER',
    'VS10  RPC grants — EXECUTE to authenticated only; not anon, not PUBLIC',
    'VS11  SCHEMA_TOW_LOG_TOW_OPERATORS audit row present'
  ] AS gates_verified,
  now() AS verified_at;


-- ══════════════════════════════════════════════════════════════════
-- NOT IN THIS FILE — EXECUTION GATES (separate follow-up)
--
-- Empirical assertions land after Jose triggers each case by hand and
-- reports the actual message. Predicting exact wording is a defect
-- class (feedback_rpc_verification_must_include_execution_gate Part 2).
--
--   E1  Manager @ company A creates operator            → { ok:true, created:true }
--   E2  Manager @ company A creates SAME NAME again     → { ok:true, created:false, id:<same> }
--   E3  Manager @ company A SELECTs company B rows      → 0 rows (RLS filters)
--   E4  Manager @ company A update_tow_operator(B.id)   → { error: 'out_of_scope' }
--   E5  Enforcement-Only caller (my_tier_pm_capable=F)  → RAISE ERRCODE=insufficient_privilege
--                                                         (message likely 'tier_not_permitted')
--   E6  anon → RPC EXECUTE denied at grant layer (SQLSTATE 42501)
--   E7  Name containing '%' → CHECK violation
--       (via table-level tow_operators_name_no_sql_metachar OR via
--        RPC-level 'invalid_name' return — depends whether input
--        validation catches it before the INSERT. Both are correct
--        outcomes; assertion records which fired.)
--   E8  driver / resident role → { error: 'role_not_authorized' }
--
-- Additional gates to consider once the empirical text is in hand:
--   E9  CA @ company A creates operator                 → { ok:true } (CA passes role gate)
--   E10 deactivate_tow_operator on ALREADY inactive     → { error: 'already_inactive' }
--   E11 create_tow_operator with SAME NAME on a DEACTIVATED row
--       → { ok:true, created:true } (partial index allows reuse)
--
-- Fixtures: Test-PM (my_tier_pm_capable), Test-LEGACY (both helpers
-- pass), Test-ENF (my_tier_pm_capable=false).
--
-- A gate that can't find its fixture must FAIL, never SKIP
-- (feedback_absence_must_not_be_failure_output).
-- ══════════════════════════════════════════════════════════════════

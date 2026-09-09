-- ══════════════════════════════════════════════════════════════════════
-- 20260909_tow_log_vehicle_removals_verification.sql
--
-- STRUCTURAL gates for Tow Log Commit 3 (vehicle_removals +
-- vehicle_removal_media). v2 pattern (no BEGIN/COMMIT wrap; terminal
-- SELECT returns PASS row).
--
-- ── SCOPE ──────────────────────────────────────────────────────────
-- Booleans and OIDs only. NO rendered SQL string assertions
-- (pg_get_expr / pg_get_triggerdef break under expression normalization —
-- feedback_gates_must_assert_what_they_measured item 8).
--
-- Grant audits use pg_class.relacl — NOT information_schema.*_privileges
-- (feedback_information_schema_under_reports_grants).
--
-- Function signature gates use to_regprocedure() — NOT proname string
-- match (feedback_function_parameter_modifiers_stripped).
--
-- Column-shape iteration uses the scalar-JSONB loop form
-- (`FOR v_elem IN SELECT value FROM jsonb_array_elements(x)`) — the
-- record.field-alias form raised 42703 in Commit 2 (VS2 rewrite).
--
-- ── GATES ──────────────────────────────────────────────────────────
--   vehicle_removals structural:
--     VS1   table exists
--     VS2   25 columns present with correct type + nullability
--     VS3   vehicle_removals_type_valid CHECK exists
--     VS4   vehicle_removals_void_coherence CHECK exists
--     VS5   tow_operator_id FK to public.tow_operators(id) with
--           ON DELETE SET NULL (confdeltype='n')
--     VS6   2 indexes exist (plate_lookup + property_towed_at) —
--           both non-unique, non-partial
--     VS7   vehicle_removal_plate_normalize function exists +
--           is SECURITY DEFINER
--     VS8   trigger exists on vehicle_removals with BEFORE + ROW +
--           INSERT + UPDATE bits set
--     VS9   RLS enabled
--     VS10  3 SELECT policies (admin_all / ca_own / manager_own)
--     VS11  no policy grants anon or PUBLIC
--     VS12  table grants: SELECT-only for authenticated
--
--   vehicle_removal_media structural:
--     VS13  table exists
--     VS14  10 columns present with correct type + nullability
--     VS15  vehicle_removal_media_kind_valid CHECK exists
--     VS16  removal_id FK to public.vehicle_removals(id) with
--           ON DELETE RESTRICT (confdeltype='r')
--     VS17  removal_id index exists
--     VS18  RLS enabled
--     VS19  1 SELECT policy (scoped_via_parent) exists
--     VS20  no policy grants anon or PUBLIC
--     VS21  table grants: SELECT-only for authenticated
--
--   Common:
--     VS22  SCHEMA_TOW_LOG_VEHICLE_REMOVALS audit row present
--
-- Execution gates deferred to the empirical pass with Commit 2 E1-E11.
-- ══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
-- vehicle_removals gates (VS1-VS12)
-- ══════════════════════════════════════════════════════════════════════

-- ── VS1: table exists ═══════════════════════════════════════════════
DO $vs1$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'vehicle_removals'
     AND c.relkind = 'r';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS1 FAIL: public.vehicle_removals table not found (count=%)', v_count;
  END IF;
END $vs1$;


-- ── VS2: 25 columns with correct type + nullability ═════════════════
-- Scalar-JSONB loop form (per Commit 2 VS2 rewrite comment).
DO $vs2$
DECLARE
  v_expect JSONB := jsonb_build_array(
    jsonb_build_object('name','id',                  'type','bigint',                     'nullable','NO'),
    jsonb_build_object('name','company',             'type','text',                       'nullable','NO'),
    jsonb_build_object('name','property',            'type','text',                       'nullable','NO'),
    jsonb_build_object('name','property_id',         'type','bigint',                     'nullable','YES'),
    jsonb_build_object('name','removal_type',        'type','text',                       'nullable','NO'),
    jsonb_build_object('name','plate',               'type','text',                       'nullable','NO'),
    jsonb_build_object('name','plate_state',         'type','text',                       'nullable','YES'),
    jsonb_build_object('name','make',                'type','text',                       'nullable','YES'),
    jsonb_build_object('name','model',               'type','text',                       'nullable','YES'),
    jsonb_build_object('name','color',               'type','text',                       'nullable','YES'),
    jsonb_build_object('name','linked_vehicle_id',   'type','bigint',                     'nullable','YES'),
    jsonb_build_object('name','reason_code',         'type','text',                       'nullable','NO'),
    jsonb_build_object('name','reason_notes',        'type','text',                       'nullable','YES'),
    jsonb_build_object('name','space_id',            'type','bigint',                     'nullable','YES'),
    jsonb_build_object('name','towed_at',            'type','timestamp with time zone',   'nullable','NO'),
    jsonb_build_object('name','authorized_by_email', 'type','text',                       'nullable','NO'),
    jsonb_build_object('name','authorized_by_name',  'type','text',                       'nullable','YES'),
    jsonb_build_object('name','tow_operator_id',     'type','bigint',                     'nullable','YES'),
    jsonb_build_object('name','operator_name',       'type','text',                       'nullable','NO'),
    jsonb_build_object('name','operator_phone',      'type','text',                       'nullable','YES'),
    jsonb_build_object('name','created_at',          'type','timestamp with time zone',   'nullable','NO'),
    jsonb_build_object('name','recorded_by_email',   'type','text',                       'nullable','NO'),
    jsonb_build_object('name','voided_at',           'type','timestamp with time zone',   'nullable','YES'),
    jsonb_build_object('name','voided_by_email',     'type','text',                       'nullable','YES'),
    jsonb_build_object('name','void_reason',         'type','text',                       'nullable','YES')
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
       AND table_name   = 'vehicle_removals'
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


-- ── VS3: removal_type CHECK exists ═════════════════════════════════
DO $vs3$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class      t ON t.oid = c.conrelid
    JOIN pg_namespace  n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'vehicle_removals'
     AND c.conname = 'vehicle_removals_type_valid'
     AND c.contype = 'c';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS3 FAIL: vehicle_removals_type_valid CHECK not found (count=%)', v_count;
  END IF;
END $vs3$;


-- ── VS4: void_coherence CHECK exists ═══════════════════════════════
DO $vs4$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class      t ON t.oid = c.conrelid
    JOIN pg_namespace  n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'vehicle_removals'
     AND c.conname = 'vehicle_removals_void_coherence'
     AND c.contype = 'c';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS4 FAIL: vehicle_removals_void_coherence CHECK not found (count=%)', v_count;
  END IF;
END $vs4$;


-- ── VS5: tow_operator_id FK with ON DELETE SET NULL ════════════════
-- confdeltype: 'a'=NO ACTION, 'r'=RESTRICT, 'c'=CASCADE,
--              'n'=SET NULL, 'd'=SET DEFAULT
DO $vs5$
DECLARE
  v_confdeltype CHAR;
  v_refcls      OID;
  v_expected    OID;
BEGIN
  SELECT c.confdeltype, c.confrelid
    INTO v_confdeltype, v_refcls
    FROM pg_constraint c
    JOIN pg_class      t ON t.oid = c.conrelid
    JOIN pg_namespace  n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'vehicle_removals'
     AND c.contype = 'f'
     AND c.conkey  = ARRAY[
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.vehicle_removals'::regclass
           AND attname  = 'tow_operator_id')
     ]::smallint[];

  IF v_confdeltype IS NULL THEN
    RAISE EXCEPTION 'VS5 FAIL: FK on tow_operator_id not found';
  END IF;

  v_expected := 'public.tow_operators'::regclass;
  IF v_refcls IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'VS5 FAIL: FK points at wrong table (confrelid=%, expected public.tow_operators)', v_refcls::regclass::text;
  END IF;

  IF v_confdeltype <> 'n' THEN
    RAISE EXCEPTION 'VS5 FAIL: FK ON DELETE rule is % (expected n=SET NULL). Snapshot principle requires SET NULL — see migration header.', v_confdeltype;
  END IF;
END $vs5$;


-- ── VS6: 2 indexes exist (plate_lookup + property_towed_at) ════════
-- Non-unique, non-partial, 2 key columns each.
DO $vs6$
DECLARE
  v_row RECORD;
  v_bad TEXT := '';
BEGIN
  FOR v_row IN
    SELECT c.relname             AS index_name,
           ix.indisunique        AS is_unique,
           ix.indnkeyatts        AS n_keys,
           ix.indpred IS NOT NULL AS has_partial
      FROM pg_class     c
      JOIN pg_namespace n  ON n.oid = c.relnamespace
      JOIN pg_index     ix ON ix.indexrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relname IN (
         'vehicle_removals_plate_lookup',
         'vehicle_removals_property_towed_at'
       )
  LOOP
    IF v_row.is_unique THEN
      v_bad := v_bad || format('%s should NOT be unique; ', v_row.index_name);
    END IF;
    IF v_row.n_keys <> 2 THEN
      v_bad := v_bad || format('%s expected 2 key cols got %s; ', v_row.index_name, v_row.n_keys);
    END IF;
    IF v_row.has_partial THEN
      v_bad := v_bad || format('%s should NOT be partial; ', v_row.index_name);
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'vehicle_removals_plate_lookup'
  ) THEN
    v_bad := v_bad || 'MISSING vehicle_removals_plate_lookup; ';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'vehicle_removals_property_towed_at'
  ) THEN
    v_bad := v_bad || 'MISSING vehicle_removals_property_towed_at; ';
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS6 FAIL: %', v_bad;
  END IF;
END $vs6$;


-- ── VS7: plate normalizer function exists + SECURITY DEFINER ═══════
DO $vs7$
DECLARE
  v_oid    OID;
  v_secdef BOOLEAN;
BEGIN
  v_oid := to_regprocedure('public.vehicle_removal_plate_normalize()');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VS7 FAIL: public.vehicle_removal_plate_normalize() not found';
  END IF;
  SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid = v_oid;
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'VS7 FAIL: vehicle_removal_plate_normalize is not SECURITY DEFINER (prosecdef=%)', v_secdef;
  END IF;
END $vs7$;


-- ── VS8: trigger exists with BEFORE + ROW + INSERT + UPDATE bits ══
-- pg_trigger.tgtype bitmap:
--   1  = ROW       (else STATEMENT)
--   2  = BEFORE    (else AFTER)
--   4  = INSERT
--   8  = DELETE
--   16 = UPDATE
--   32 = TRUNCATE
-- Expected: 1 + 2 + 4 + 16 = 23 (BEFORE INSERT OR UPDATE FOR EACH ROW).
-- Asserted per-bit so a drift produces a named failure, not a magic
-- number compare.
DO $vs8$
DECLARE
  v_tgtype SMALLINT;
BEGIN
  SELECT tgtype INTO v_tgtype
    FROM pg_trigger
   WHERE tgrelid = 'public.vehicle_removals'::regclass
     AND tgname  = 'vehicle_removal_plate_normalize_trigger'
     AND NOT tgisinternal;

  IF v_tgtype IS NULL THEN
    RAISE EXCEPTION 'VS8 FAIL: trigger vehicle_removal_plate_normalize_trigger not found on public.vehicle_removals';
  END IF;

  IF (v_tgtype & 1) <> 1 THEN
    RAISE EXCEPTION 'VS8 FAIL: trigger not FOR EACH ROW (tgtype=% missing ROW bit)', v_tgtype;
  END IF;
  IF (v_tgtype & 2) <> 2 THEN
    RAISE EXCEPTION 'VS8 FAIL: trigger not BEFORE (tgtype=% missing BEFORE bit)', v_tgtype;
  END IF;
  IF (v_tgtype & 4) <> 4 THEN
    RAISE EXCEPTION 'VS8 FAIL: trigger does not fire on INSERT (tgtype=% missing INSERT bit)', v_tgtype;
  END IF;
  IF (v_tgtype & 16) <> 16 THEN
    RAISE EXCEPTION 'VS8 FAIL: trigger does not fire on UPDATE (tgtype=% missing UPDATE bit)', v_tgtype;
  END IF;
END $vs8$;


-- ── VS9: RLS enabled on vehicle_removals ═══════════════════════════
DO $vs9$
DECLARE v_enabled BOOLEAN;
BEGIN
  SELECT c.relrowsecurity INTO v_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'vehicle_removals';
  IF v_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'VS9 FAIL: RLS not enabled on public.vehicle_removals (relrowsecurity=%)', v_enabled;
  END IF;
END $vs9$;


-- ── VS10: 3 SELECT policies on vehicle_removals ════════════════════
DO $vs10$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_policy
   WHERE polrelid = 'public.vehicle_removals'::regclass
     AND polname IN (
       'admin_all_vehicle_removals',
       'ca_own_vehicle_removals',
       'manager_own_vehicle_removals'
     )
     AND polcmd IN ('r', '*');
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'VS10 FAIL: expected 3 named SELECT policies on public.vehicle_removals; got %', v_count;
  END IF;
END $vs10$;


-- ── VS11: no policy on vehicle_removals grants anon or PUBLIC ══════
DO $vs11$
DECLARE
  v_anon_oid OID;
  v_row RECORD;
  v_bad TEXT := '';
BEGIN
  SELECT oid INTO v_anon_oid FROM pg_roles WHERE rolname = 'anon';
  IF v_anon_oid IS NULL THEN
    RAISE EXCEPTION 'VS11 FIXTURE FAIL: no anon role in this cluster';
  END IF;

  FOR v_row IN
    SELECT polname, polroles
      FROM pg_policy
     WHERE polrelid = 'public.vehicle_removals'::regclass
  LOOP
    IF v_anon_oid = ANY(v_row.polroles) OR v_row.polroles = ARRAY[0]::oid[] THEN
      v_bad := v_bad || format('%s (polroles=%s); ', v_row.polname, v_row.polroles::text);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS11 FAIL: policies grant anon or PUBLIC: %', v_bad;
  END IF;
END $vs11$;


-- ── VS12: table grants — SELECT-only for authenticated ═════════════
DO $vs12$
DECLARE
  v_acl aclitem[];
  v_acl_str TEXT;
  v_bad TEXT := '';
BEGIN
  SELECT c.relacl INTO v_acl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'vehicle_removals';

  v_acl_str := COALESCE(v_acl::text, 'NULL');

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
    v_bad := v_bad || format('anon has table grant (relacl=%s); ', v_acl_str);
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE '=%'
  ) THEN
    v_bad := v_bad || format('PUBLIC grant present (relacl=%s); ', v_acl_str);
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS12 FAIL: %', v_bad;
  END IF;
END $vs12$;


-- ══════════════════════════════════════════════════════════════════════
-- vehicle_removal_media gates (VS13-VS21)
-- ══════════════════════════════════════════════════════════════════════

-- ── VS13: table exists ═════════════════════════════════════════════
DO $vs13$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'vehicle_removal_media'
     AND c.relkind = 'r';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS13 FAIL: public.vehicle_removal_media table not found (count=%)', v_count;
  END IF;
END $vs13$;


-- ── VS14: 10 columns with correct type + nullability ═══════════════
DO $vs14$
DECLARE
  v_expect JSONB := jsonb_build_array(
    jsonb_build_object('name','id',               'type','bigint',                     'nullable','NO'),
    jsonb_build_object('name','removal_id',       'type','bigint',                     'nullable','NO'),
    jsonb_build_object('name','storage_path',     'type','text',                       'nullable','NO'),
    jsonb_build_object('name','kind',             'type','text',                       'nullable','NO'),
    jsonb_build_object('name','created_at',       'type','timestamp with time zone',   'nullable','NO'),
    jsonb_build_object('name','created_by_email', 'type','text',                       'nullable','NO'),
    jsonb_build_object('name','removed_at',       'type','timestamp with time zone',   'nullable','YES'),
    jsonb_build_object('name','removed_by_email', 'type','text',                       'nullable','YES'),
    jsonb_build_object('name','removed_by_role',  'type','text',                       'nullable','YES'),
    jsonb_build_object('name','removal_reason',   'type','text',                       'nullable','YES')
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
       AND table_name   = 'vehicle_removal_media'
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
    RAISE EXCEPTION 'VS14 FAIL: column shape mismatch: %', v_missing;
  END IF;
END $vs14$;


-- ── VS15: kind CHECK exists ════════════════════════════════════════
DO $vs15$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class      t ON t.oid = c.conrelid
    JOIN pg_namespace  n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'vehicle_removal_media'
     AND c.conname = 'vehicle_removal_media_kind_valid'
     AND c.contype = 'c';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS15 FAIL: vehicle_removal_media_kind_valid CHECK not found (count=%)', v_count;
  END IF;
END $vs15$;


-- ── VS16: removal_id FK with ON DELETE RESTRICT ════════════════════
DO $vs16$
DECLARE
  v_confdeltype CHAR;
  v_refcls      OID;
  v_expected    OID;
BEGIN
  SELECT c.confdeltype, c.confrelid
    INTO v_confdeltype, v_refcls
    FROM pg_constraint c
    JOIN pg_class      t ON t.oid = c.conrelid
    JOIN pg_namespace  n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'vehicle_removal_media'
     AND c.contype = 'f'
     AND c.conkey  = ARRAY[
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.vehicle_removal_media'::regclass
           AND attname  = 'removal_id')
     ]::smallint[];

  IF v_confdeltype IS NULL THEN
    RAISE EXCEPTION 'VS16 FAIL: FK on removal_id not found';
  END IF;

  v_expected := 'public.vehicle_removals'::regclass;
  IF v_refcls IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'VS16 FAIL: FK points at wrong table (confrelid=%, expected public.vehicle_removals)', v_refcls::regclass::text;
  END IF;

  IF v_confdeltype <> 'r' THEN
    RAISE EXCEPTION 'VS16 FAIL: FK ON DELETE rule is % (expected r=RESTRICT). CASCADE would give a would-be deleter a false clean-removal path — see migration header.', v_confdeltype;
  END IF;
END $vs16$;


-- ── VS17: removal_id index exists ═══════════════════════════════════
DO $vs17$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_class     c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'vehicle_removal_media_removal_id';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS17 FAIL: vehicle_removal_media_removal_id index not found (count=%)', v_count;
  END IF;
END $vs17$;


-- ── VS18: RLS enabled on vehicle_removal_media ═════════════════════
DO $vs18$
DECLARE v_enabled BOOLEAN;
BEGIN
  SELECT c.relrowsecurity INTO v_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'vehicle_removal_media';
  IF v_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'VS18 FAIL: RLS not enabled on public.vehicle_removal_media (relrowsecurity=%)', v_enabled;
  END IF;
END $vs18$;


-- ── VS19: 1 SELECT policy on vehicle_removal_media ═════════════════
DO $vs19$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_policy
   WHERE polrelid = 'public.vehicle_removal_media'::regclass
     AND polname  = 'scoped_via_parent_vehicle_removal_media'
     AND polcmd IN ('r', '*');
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VS19 FAIL: expected scoped_via_parent policy on vehicle_removal_media; got %', v_count;
  END IF;
END $vs19$;


-- ── VS20: no policy on vehicle_removal_media grants anon or PUBLIC ═
DO $vs20$
DECLARE
  v_anon_oid OID;
  v_row RECORD;
  v_bad TEXT := '';
BEGIN
  SELECT oid INTO v_anon_oid FROM pg_roles WHERE rolname = 'anon';
  IF v_anon_oid IS NULL THEN
    RAISE EXCEPTION 'VS20 FIXTURE FAIL: no anon role in this cluster';
  END IF;

  FOR v_row IN
    SELECT polname, polroles
      FROM pg_policy
     WHERE polrelid = 'public.vehicle_removal_media'::regclass
  LOOP
    IF v_anon_oid = ANY(v_row.polroles) OR v_row.polroles = ARRAY[0]::oid[] THEN
      v_bad := v_bad || format('%s (polroles=%s); ', v_row.polname, v_row.polroles::text);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS20 FAIL: policies grant anon or PUBLIC: %', v_bad;
  END IF;
END $vs20$;


-- ── VS21: table grants — SELECT-only for authenticated ═════════════
DO $vs21$
DECLARE
  v_acl aclitem[];
  v_acl_str TEXT;
  v_bad TEXT := '';
BEGIN
  SELECT c.relacl INTO v_acl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'vehicle_removal_media';

  v_acl_str := COALESCE(v_acl::text, 'NULL');

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
    v_bad := v_bad || format('anon has table grant (relacl=%s); ', v_acl_str);
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE '=%'
  ) THEN
    v_bad := v_bad || format('PUBLIC grant present (relacl=%s); ', v_acl_str);
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'VS21 FAIL: %', v_bad;
  END IF;
END $vs21$;


-- ══════════════════════════════════════════════════════════════════════
-- Common gate
-- ══════════════════════════════════════════════════════════════════════

-- ── VS22: audit row present ════════════════════════════════════════
DO $vs22$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_TOW_LOG_VEHICLE_REMOVALS'
     AND new_values ->> 'migration' = '20260909_tow_log_vehicle_removals';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VS22 FAIL: audit row missing';
  END IF;
END $vs22$;


-- ── FINAL: PASS row ══════════════════════════════════════════════
SELECT
  'PASS'::TEXT AS status,
  'vehicle_removals + vehicle_removal_media structural (Tow Log Commit 3)'::TEXT AS target,
  ARRAY[
    'VS1   public.vehicle_removals table exists',
    'VS2   25 columns present with correct type + nullability',
    'VS3   vehicle_removals_type_valid CHECK exists',
    'VS4   vehicle_removals_void_coherence CHECK exists (verbatim from space_payments)',
    'VS5   tow_operator_id FK to public.tow_operators(id) ON DELETE SET NULL',
    'VS6   2 non-unique non-partial indexes (plate_lookup + property_towed_at)',
    'VS7   vehicle_removal_plate_normalize() function is SECURITY DEFINER',
    'VS8   trigger has BEFORE + ROW + INSERT + UPDATE bits set (tgtype)',
    'VS9   RLS enabled on vehicle_removals',
    'VS10  3 SELECT policies (admin_all / ca_own / manager_own — manager PROPERTY-scoped)',
    'VS11  no policy grants anon or PUBLIC on vehicle_removals',
    'VS12  vehicle_removals grants — SELECT-only for authenticated',
    'VS13  public.vehicle_removal_media table exists',
    'VS14  10 columns present with correct type + nullability',
    'VS15  vehicle_removal_media_kind_valid CHECK exists',
    'VS16  removal_id FK to public.vehicle_removals(id) ON DELETE RESTRICT',
    'VS17  vehicle_removal_media_removal_id index exists',
    'VS18  RLS enabled on vehicle_removal_media',
    'VS19  scoped_via_parent_vehicle_removal_media SELECT policy exists',
    'VS20  no policy grants anon or PUBLIC on vehicle_removal_media',
    'VS21  vehicle_removal_media grants — SELECT-only for authenticated',
    'VS22  SCHEMA_TOW_LOG_VEHICLE_REMOVALS audit row present'
  ] AS gates_verified,
  now() AS verified_at;


-- ══════════════════════════════════════════════════════════════════
-- NOT IN THIS FILE — EXECUTION GATES (deferred to empirical pass)
--
-- Land together with Commit 2 E1-E11 after Jose runs the Commit 2
-- runbook. Documented for the eventual assertion set:
--
-- vehicle_removals:
--   E12  Manager @ property A SELECTs a removal at property B → 0 rows
--        (RLS filters per manager_own_vehicle_removals)
--   E13  CA @ company A SELECTs company B rows                → 0 rows
--   E14  anon SELECT on vehicle_removals                     → 0 rows (no policy)
--   E15  Direct INSERT via client (no RPC)                    → permission denied
--        (VS12 grant discipline; INSERT/UPDATE/DELETE not held)
--   E16  Attempt to INSERT with removal_type='seizure'        → 23514 CHECK vehicle_removals_type_valid
--   E17  Attempt to INSERT with voided_at set + void_reason NULL
--                                                             → 23514 CHECK vehicle_removals_void_coherence
--   E18  INSERT plate='abc-123'                               → row stored as 'ABC123' (trigger)
--   E19  INSERT plate='  '                                    → 22004 empty-after-normalization RAISE
--
-- vehicle_removal_media:
--   E20  SELECT media where parent hidden by RLS              → 0 rows (EXISTS delegation)
--   E21  INSERT with kind='video'                             → 23514 CHECK vehicle_removal_media_kind_valid
--   E22  DELETE from vehicle_removals with attached media    → 23503 FK RESTRICT (blocks orphan)
--
-- Each empirical case: Jose triggers, reports message verbatim,
-- assertion gets written from actual text (never predicted).
--
-- Fixtures reused: Test-PM, Test-LEGACY, Test-ENF, plus a tow_operators
-- row created in Commit 2 for the tow_operator_id FK write path.
-- ══════════════════════════════════════════════════════════════════

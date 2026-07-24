-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_authorized_plates_v1_schema_verification.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Verifies AP-SCHEMA (commit 1 of 4 in the Authorized Plates arc).
--
-- ── Negative controls (pre-apply state) ───────────────────────────────
-- Every VQ fails against the unfixed schema because nothing exists yet:
--   AP.EXISTS       — FAIL naming all 4 objects (table, sequence, trigger, function)
--   AP.RLS          — FAIL (0 policies expected 9)
--   AP.CHECKS       — FAIL (0 constraints expected 4)
--   AP.FK           — FAIL (no FK exists)
--   AP.INDEXES      — FAIL (index doesn't exist)
--   AP.TRIGGER_SCOPE— FAIL (trigger doesn't exist)
--   AP.ATTRIB       — FAIL (function doesn't exist)
--   AP.IMMUTABLE    — FAIL (function doesn't exist)
--   AP.GRANTS       — FAIL (table doesn't exist)
--   AP.COMMENT      — FAIL (table doesn't exist)
--   AP.AUDIT        — FAIL (row not landed)
--
-- ── Scope disclaimer ──────────────────────────────────────────────────
-- All VQs are STRUCTURAL: source shape + catalog state. They do NOT
-- prove behavior. Behavioral proof for AP is Commit 4.5's sessioned
-- assertions (add plate as manager → visible to manager, invisible
-- cross-tenant; remove plate → soft-deleted; plate immutable via
-- UPDATE attempt → RAISE, etc.).
--
-- Wrapped in BEGIN...COMMIT — first RAISE aborts the transaction and
-- subsequent VQs do not execute.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- AP.EXISTS — table + sequence + trigger + function all present
-- ══════════════════════════════════════════════════════════════════════
DO $ap_exists$
DECLARE
  v_missing TEXT[];
BEGIN
  v_missing := ARRAY[]::TEXT[];

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='authorized_plates') THEN
    v_missing := v_missing || 'table:authorized_plates';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.sequences
                  WHERE sequence_schema='public' AND sequence_name='authorized_plates_id_seq') THEN
    v_missing := v_missing || 'sequence:authorized_plates_id_seq';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  JOIN pg_class c ON c.oid = t.tgrelid
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname='public' AND c.relname='authorized_plates'
                    AND t.tgname='authorized_plates_normalize_and_attribute_trigger'
                    AND NOT t.tgisinternal) THEN
    v_missing := v_missing || 'trigger:authorized_plates_normalize_and_attribute_trigger';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace = 'public'::regnamespace
                    AND proname = 'authorized_plates_normalize_and_attribute') THEN
    v_missing := v_missing || 'function:authorized_plates_normalize_and_attribute';
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'AP.EXISTS FAILED — missing: %', v_missing;
  END IF;
END $ap_exists$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.RLS — exact 9-policy name set + all TO authenticated + no DELETE cmd
-- ══════════════════════════════════════════════════════════════════════
DO $ap_rls$
DECLARE
  v_expected TEXT[] := ARRAY[
    'ap_admin_select', 'ap_admin_insert', 'ap_admin_update',
    'ap_ca_select', 'ap_ca_insert', 'ap_ca_update',
    'ap_manager_select', 'ap_manager_insert', 'ap_manager_update'
  ];
  v_actual   TEXT[];
  v_missing  TEXT[];
  v_extra    TEXT[];
  v_del_pol  INTEGER;
  v_non_auth TEXT[];
  v_rls_on   BOOLEAN;
BEGIN
  -- Set comparison (order-independent). Array equality via `=` /
  -- `IS DISTINCT FROM` is order-sensitive — this caught a false
  -- failure on first apply where expected was logical-order and
  -- actual was alphabetical (from ORDER BY policyname). Use `@>`
  -- both directions and report specific difference via EXCEPT.
  -- See docs/development/migration-verification-template.md,
  -- "Set assertions" section.
  SELECT COALESCE(array_agg(policyname), '{}') INTO v_actual
  FROM pg_policies
  WHERE schemaname='public' AND tablename='authorized_plates';

  IF NOT (v_actual @> v_expected AND v_expected @> v_actual) THEN
    SELECT COALESCE(array_agg(x ORDER BY x), '{}') INTO v_missing
      FROM (SELECT unnest(v_expected) EXCEPT SELECT unnest(v_actual)) t(x);
    SELECT COALESCE(array_agg(x ORDER BY x), '{}') INTO v_extra
      FROM (SELECT unnest(v_actual) EXCEPT SELECT unnest(v_expected)) t(x);
    RAISE EXCEPTION 'AP.RLS FAILED — policy set drift. missing=% unexpected=%',
      v_missing, v_extra;
  END IF;

  SELECT COUNT(*) INTO v_del_pol
  FROM pg_policies
  WHERE schemaname='public' AND tablename='authorized_plates' AND cmd='DELETE';
  IF v_del_pol <> 0 THEN
    RAISE EXCEPTION 'AP.RLS FAILED — DELETE-cmd policy exists (count=%) — soft-delete-only invariant broken', v_del_pol;
  END IF;

  SELECT COALESCE(array_agg(policyname || ':' || roles::text ORDER BY policyname), '{}') INTO v_non_auth
  FROM pg_policies
  WHERE schemaname='public' AND tablename='authorized_plates'
    AND roles::text <> '{authenticated}';
  IF array_length(v_non_auth, 1) > 0 THEN
    RAISE EXCEPTION 'AP.RLS FAILED — policy not scoped exclusively TO authenticated: %', v_non_auth;
  END IF;

  SELECT relrowsecurity INTO v_rls_on
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relname='authorized_plates';
  IF v_rls_on IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'AP.RLS FAILED — RLS not enabled on authorized_plates';
  END IF;
END $ap_rls$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.CHECKS — exactly 4 CHECK constraints, by name
-- ══════════════════════════════════════════════════════════════════════
DO $ap_checks$
DECLARE
  v_expected TEXT[] := ARRAY[
    'authorized_plates_label_length_cap',
    'authorized_plates_plate_non_empty',
    'authorized_plates_plate_normalized',
    'authorized_plates_soft_delete_pair'
  ];
  v_actual  TEXT[];
  v_missing TEXT[];
  v_extra   TEXT[];
BEGIN
  -- Set comparison (order-independent) — see AP.RLS block above.
  SELECT COALESCE(array_agg(conname), '{}') INTO v_actual
  FROM pg_constraint
  WHERE conrelid = 'public.authorized_plates'::regclass
    AND contype = 'c';

  IF NOT (v_actual @> v_expected AND v_expected @> v_actual) THEN
    SELECT COALESCE(array_agg(x ORDER BY x), '{}') INTO v_missing
      FROM (SELECT unnest(v_expected) EXCEPT SELECT unnest(v_actual)) t(x);
    SELECT COALESCE(array_agg(x ORDER BY x), '{}') INTO v_extra
      FROM (SELECT unnest(v_actual) EXCEPT SELECT unnest(v_expected)) t(x);
    RAISE EXCEPTION 'AP.CHECKS FAILED — CHECK constraint set drift. missing=% unexpected=%',
      v_missing, v_extra;
  END IF;
END $ap_checks$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.FK — property_id FK exists with ON DELETE RESTRICT (not CASCADE)
-- ══════════════════════════════════════════════════════════════════════
-- FIX 2: matches soft-delete-only philosophy. A property with
-- authorized plates can't be deleted without an explicit decision.
DO $ap_fk$
DECLARE
  v_confdeltype "char";
BEGIN
  SELECT confdeltype INTO v_confdeltype
  FROM pg_constraint
  WHERE conrelid = 'public.authorized_plates'::regclass
    AND contype  = 'f'
    AND conname  LIKE '%property_id%'
  LIMIT 1;

  IF v_confdeltype IS NULL THEN
    RAISE EXCEPTION 'AP.FK FAILED — no property_id FK found on authorized_plates';
  END IF;

  -- confdeltype: 'r' = RESTRICT, 'c' = CASCADE, 'n' = SET NULL, 'a' = NO ACTION, 'd' = SET DEFAULT
  IF v_confdeltype <> 'r' THEN
    RAISE EXCEPTION 'AP.FK FAILED — property_id FK confdeltype=% (expected r/RESTRICT)', v_confdeltype;
  END IF;
END $ap_fk$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.INDEXES — only the partial unique index (redundant + speculative dropped)
-- ══════════════════════════════════════════════════════════════════════
-- FIX 3: property_id partial index was redundant with the partial unique
-- (leading column serves point-lookups); added_at desc was speculative
-- (tens of rows per property; add when a query is measurably slow).
DO $ap_indexes$
DECLARE
  v_expected TEXT[] := ARRAY[
    'authorized_plates_pkey',                        -- BIGSERIAL primary key
    'authorized_plates_property_plate_active_uidx'  -- partial unique
  ];
  v_actual  TEXT[];
  v_missing TEXT[];
  v_extra   TEXT[];
BEGIN
  -- Set comparison (order-independent) — see AP.RLS block above.
  SELECT COALESCE(array_agg(indexname), '{}') INTO v_actual
  FROM pg_indexes
  WHERE schemaname='public' AND tablename='authorized_plates';

  IF NOT (v_actual @> v_expected AND v_expected @> v_actual) THEN
    SELECT COALESCE(array_agg(x ORDER BY x), '{}') INTO v_missing
      FROM (SELECT unnest(v_expected) EXCEPT SELECT unnest(v_actual)) t(x);
    SELECT COALESCE(array_agg(x ORDER BY x), '{}') INTO v_extra
      FROM (SELECT unnest(v_actual) EXCEPT SELECT unnest(v_expected)) t(x);
    RAISE EXCEPTION 'AP.INDEXES FAILED — index set drift. missing=% unexpected=%',
      v_missing, v_extra;
  END IF;

  -- Additionally assert the partial unique index has the correct WHERE clause
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public'
       AND indexname='authorized_plates_property_plate_active_uidx'
       AND indexdef LIKE '%WHERE (removed_at IS NULL)%'
  ) THEN
    RAISE EXCEPTION 'AP.INDEXES FAILED — partial unique index missing WHERE (removed_at IS NULL) clause';
  END IF;
END $ap_indexes$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.TRIGGER_SCOPE — trigger fires BEFORE INSERT OR UPDATE (no column list)
-- ══════════════════════════════════════════════════════════════════════
-- FIX 1: widened from `OF plate` to full INSERT OR UPDATE so soft-delete
-- transitions (which touch removed_at, not plate) fire the trigger and
-- stamp removed_by server-side. tgattr empty (int2vector length 0) =
-- row-level trigger with no column list.
DO $ap_trigger_scope$
DECLARE
  v_tgtype       INT2;
  v_tgattr_len   INT;
  v_before_mask  INT2 := 2;     -- TRIGGER_TYPE_BEFORE  (1<<1)
  v_insert_mask  INT2 := 4;     -- TRIGGER_TYPE_INSERT  (1<<2)
  v_update_mask  INT2 := 16;    -- TRIGGER_TYPE_UPDATE  (1<<4)
  v_row_mask     INT2 := 1;     -- TRIGGER_TYPE_ROW     (1<<0)
BEGIN
  SELECT tgtype, array_length(tgattr::int2[], 1)
    INTO v_tgtype, v_tgattr_len
  FROM pg_trigger
  WHERE tgname='authorized_plates_normalize_and_attribute_trigger';

  IF v_tgtype IS NULL THEN
    RAISE EXCEPTION 'AP.TRIGGER_SCOPE FAILED — trigger not found';
  END IF;

  IF (v_tgtype & v_before_mask) = 0 THEN
    RAISE EXCEPTION 'AP.TRIGGER_SCOPE FAILED — trigger is not BEFORE (tgtype=%)', v_tgtype;
  END IF;
  IF (v_tgtype & v_insert_mask) = 0 THEN
    RAISE EXCEPTION 'AP.TRIGGER_SCOPE FAILED — trigger does not fire on INSERT (tgtype=%)', v_tgtype;
  END IF;
  IF (v_tgtype & v_update_mask) = 0 THEN
    RAISE EXCEPTION 'AP.TRIGGER_SCOPE FAILED — trigger does not fire on UPDATE (tgtype=%)', v_tgtype;
  END IF;
  IF (v_tgtype & v_row_mask) = 0 THEN
    RAISE EXCEPTION 'AP.TRIGGER_SCOPE FAILED — trigger is not FOR EACH ROW (tgtype=%)', v_tgtype;
  END IF;

  -- tgattr is int2vector; NULL/empty when no column list (fires on all columns)
  IF COALESCE(v_tgattr_len, 0) <> 0 THEN
    RAISE EXCEPTION 'AP.TRIGGER_SCOPE FAILED — trigger has column list (tgattr length=%), expected empty (fires on all columns for soft-delete stamping)', v_tgattr_len;
  END IF;
END $ap_trigger_scope$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.ATTRIB — server-side attribution logic in function source
-- ══════════════════════════════════════════════════════════════════════
DO $ap_attrib$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = 'authorized_plates_normalize_and_attribute';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'AP.ATTRIB FAILED — function not found';
  END IF;

  IF     v_def NOT LIKE '%NEW.added_by := COALESCE(auth.jwt() ->> ''email''%'
      OR v_def NOT LIKE '%NEW.removed_by := COALESCE(auth.jwt() ->> ''email''%'
  THEN
    RAISE EXCEPTION 'AP.ATTRIB FAILED — server-side attribution (added_by/removed_by := COALESCE(auth.jwt()...)) not present in trigger function';
  END IF;
END $ap_attrib$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.IMMUTABLE — plate immutability + no reactivation guards in function
-- ══════════════════════════════════════════════════════════════════════
-- Change 1: refuses UPDATE that changes plate + refuses UPDATE that
-- reactivates a soft-deleted row. Assertion on the RAISE EXCEPTION
-- literals — deterministic source-text presence.
DO $ap_immutable$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = 'authorized_plates_normalize_and_attribute';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'AP.IMMUTABLE FAILED — function not found';
  END IF;

  IF v_def NOT LIKE '%plate is immutable%' THEN
    RAISE EXCEPTION 'AP.IMMUTABLE FAILED — plate-immutability guard string missing from trigger function';
  END IF;

  IF v_def NOT LIKE '%removed rows cannot be reactivated%' THEN
    RAISE EXCEPTION 'AP.IMMUTABLE FAILED — no-reactivation guard string missing from trigger function';
  END IF;
END $ap_immutable$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.GRANTS — deny-by-default: authenticated SELECT/INSERT/UPDATE only,
--             sequence USAGE/SELECT, anon has nothing
-- ══════════════════════════════════════════════════════════════════════
DO $ap_grants$
DECLARE
  v_auth_sel BOOLEAN;
  v_auth_ins BOOLEAN;
  v_auth_upd BOOLEAN;
  v_auth_del BOOLEAN;
  v_anon_any BOOLEAN;
  v_seq_usg  BOOLEAN;
  v_seq_sel  BOOLEAN;
BEGIN
  SELECT has_table_privilege('authenticated', 'public.authorized_plates', 'SELECT') INTO v_auth_sel;
  SELECT has_table_privilege('authenticated', 'public.authorized_plates', 'INSERT') INTO v_auth_ins;
  SELECT has_table_privilege('authenticated', 'public.authorized_plates', 'UPDATE') INTO v_auth_upd;
  SELECT has_table_privilege('authenticated', 'public.authorized_plates', 'DELETE') INTO v_auth_del;

  IF NOT (v_auth_sel AND v_auth_ins AND v_auth_upd) THEN
    RAISE EXCEPTION 'AP.GRANTS FAILED — authenticated missing SELECT/INSERT/UPDATE (sel=%, ins=%, upd=%)',
      v_auth_sel, v_auth_ins, v_auth_upd;
  END IF;
  IF v_auth_del THEN
    RAISE EXCEPTION 'AP.GRANTS FAILED — authenticated has DELETE grant on authorized_plates (soft-delete-only invariant broken)';
  END IF;

  SELECT (has_table_privilege('anon', 'public.authorized_plates', 'SELECT')
       OR has_table_privilege('anon', 'public.authorized_plates', 'INSERT')
       OR has_table_privilege('anon', 'public.authorized_plates', 'UPDATE')
       OR has_table_privilege('anon', 'public.authorized_plates', 'DELETE')) INTO v_anon_any;
  IF v_anon_any THEN
    RAISE EXCEPTION 'AP.GRANTS FAILED — anon has some privilege on authorized_plates (deny-by-default broken)';
  END IF;

  SELECT has_sequence_privilege('authenticated', 'public.authorized_plates_id_seq', 'USAGE') INTO v_seq_usg;
  SELECT has_sequence_privilege('authenticated', 'public.authorized_plates_id_seq', 'SELECT') INTO v_seq_sel;
  IF NOT (v_seq_usg AND v_seq_sel) THEN
    RAISE EXCEPTION 'AP.GRANTS FAILED — authenticated missing sequence USAGE/SELECT (usg=%, sel=%)', v_seq_usg, v_seq_sel;
  END IF;
END $ap_grants$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.COMMENT — table comment carries the three-way cross-reference
-- ══════════════════════════════════════════════════════════════════════
DO $ap_comment$
DECLARE
  v_comment TEXT;
BEGIN
  SELECT obj_description('public.authorized_plates'::regclass, 'pg_class') INTO v_comment;

  IF v_comment IS NULL OR btrim(v_comment) = '' THEN
    RAISE EXCEPTION 'AP.COMMENT FAILED — COMMENT ON TABLE missing';
  END IF;

  IF     v_comment NOT LIKE '%REMAIN FULLY ENFORCEABLE%'
      OR v_comment NOT LIKE '%do_not_tow_plates%'
      OR v_comment NOT LIKE '%exempt_plates%'
  THEN
    RAISE EXCEPTION 'AP.COMMENT FAILED — comment missing required cross-references (REMAIN FULLY ENFORCEABLE / do_not_tow_plates / exempt_plates)';
  END IF;
END $ap_comment$;

-- ══════════════════════════════════════════════════════════════════════
-- AP.AUDIT — SCHEMA_AUTHORIZED_PLATES_V1 row landed
-- ══════════════════════════════════════════════════════════════════════
DO $ap_audit$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.audit_logs
  WHERE action = 'SCHEMA_AUTHORIZED_PLATES_V1'
    AND new_values->>'migration' = '20260723_authorized_plates_v1_schema';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'AP.AUDIT FAILED — SCHEMA_AUTHORIZED_PLATES_V1 row missing';
  END IF;
END $ap_audit$;

COMMIT;

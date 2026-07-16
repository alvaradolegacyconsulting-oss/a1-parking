-- ════════════════════════════════════════════════════════════════════
-- Verification — 20260715_property_name_block_rename (count-based)
-- 2026-07-15 (refined 2026-07-16 to count-based per Mateo decision)
--
-- Runs as service_role (Supabase SQL editor). In the editor session,
-- auth.jwt() is NULL → get_my_role() returns NULL → the trigger's
-- admin bypass does NOT apply → count-check gates the rename.
--
-- VQ.B proves rename BLOCKED when refs > 0 (the load-bearing safety case).
-- VQ.C proves rename ALLOWED when refs = 0 (the fresh-typo-fix case).
-- VQ.D proves non-name updates pass through untouched (trigger scope).
-- VQ.E documents the admin-bypass hand-verify (can't test from editor).
--
-- Each write uses a disposable smoke row (unique company name to avoid
-- collisions) + explicit DELETE cleanup.
-- ════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════
-- VQ.A — trigger function + trigger both exist
-- ══════════════════════════════════════════════════════════════════
DO $vqa$
DECLARE v_fn_count INT; v_trigger_count INT;
BEGIN
  SELECT COUNT(*) INTO v_fn_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'properties_name_block_rename_trigger';
  IF v_fn_count <> 1 THEN
    RAISE EXCEPTION 'VQ.A FAIL: expected 1 trigger function, found %', v_fn_count;
  END IF;

  SELECT COUNT(*) INTO v_trigger_count
    FROM pg_trigger t WHERE t.tgname = 'trg_properties_name_block_rename' AND NOT t.tgisinternal;
  IF v_trigger_count <> 1 THEN
    RAISE EXCEPTION 'VQ.A FAIL: expected 1 trigger, found %', v_trigger_count;
  END IF;

  RAISE NOTICE 'VQ.A PASS: trigger function + trigger registered';
END $vqa$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.B — rename BLOCKED at ≥1 assignment (non-admin)
-- Creates a property + 1 driver assignment, attempts rename, expects RAISE.
-- ══════════════════════════════════════════════════════════════════
DO $vqb$
DECLARE
  v_id BIGINT;
  v_driver_id BIGINT;
  v_stored TEXT;
  v_raised BOOLEAN := FALSE;
  v_company TEXT := 'VQ-RENAME-BLOCK-CO-DO-NOT-USE';
  v_prop TEXT := 'VQ Rename Block Prop';
BEGIN
  INSERT INTO public.properties (name, company, is_active)
  VALUES (v_prop, v_company, FALSE)
  RETURNING id INTO v_id;

  -- Create 1 driver with this property in assigned_properties.
  INSERT INTO public.drivers (email, name, assigned_properties, company, is_active)
  VALUES ('vq-rename-block-driver@vq.local', 'VQ Test', ARRAY[v_prop], v_company, FALSE)
  RETURNING id INTO v_driver_id;

  -- Attempt rename — expected: RAISES check_violation (count=1 > 0).
  BEGIN
    UPDATE public.properties SET name = v_prop || ' — Renamed' WHERE id = v_id;
  EXCEPTION WHEN check_violation THEN
    v_raised := TRUE;
  END;

  IF NOT v_raised THEN
    DELETE FROM public.drivers WHERE id = v_driver_id;
    DELETE FROM public.properties WHERE id = v_id;
    RAISE EXCEPTION 'VQ.B FAIL: rename with 1 assignment did NOT raise check_violation';
  END IF;

  -- Confirm name unchanged (rollback within sub-transaction).
  SELECT name INTO v_stored FROM public.properties WHERE id = v_id;
  IF v_stored <> v_prop THEN
    DELETE FROM public.drivers WHERE id = v_driver_id;
    DELETE FROM public.properties WHERE id = v_id;
    RAISE EXCEPTION 'VQ.B FAIL: name changed despite trigger raise — stored=[%]', v_stored;
  END IF;

  DELETE FROM public.drivers WHERE id = v_driver_id;
  DELETE FROM public.properties WHERE id = v_id;
  RAISE NOTICE 'VQ.B PASS: rename BLOCKED when count=1 assignment exists';
END $vqb$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.C — rename ALLOWED at 0 assignments (fresh-typo case)
-- Creates a property with NO user assignments, renames, expects success.
-- ══════════════════════════════════════════════════════════════════
DO $vqc$
DECLARE
  v_id BIGINT;
  v_stored TEXT;
  v_company TEXT := 'VQ-RENAME-ALLOW-CO-DO-NOT-USE';
  v_prop_typo TEXT := 'VQ Prop With Typoe';
  v_prop_fixed TEXT := 'VQ Prop With Typo';
BEGIN
  INSERT INTO public.properties (name, company, is_active)
  VALUES (v_prop_typo, v_company, FALSE)
  RETURNING id INTO v_id;

  -- Confirm 0 user_roles / drivers / residents reference this new prop.
  -- If any exist somehow (test pollution), abort with a clear message.
  IF EXISTS (SELECT 1 FROM user_roles WHERE v_prop_typo = ANY(property) AND lower(trim(company)) = lower(trim(v_company)))
    OR EXISTS (SELECT 1 FROM drivers WHERE v_prop_typo = ANY(assigned_properties) AND lower(trim(company)) = lower(trim(v_company)))
    OR EXISTS (SELECT 1 FROM residents WHERE property = v_prop_typo AND lower(trim(company)) = lower(trim(v_company))) THEN
    DELETE FROM public.properties WHERE id = v_id;
    RAISE EXCEPTION 'VQ.C SETUP FAIL: test pollution — assignments already exist for [%]', v_prop_typo;
  END IF;

  -- Attempt rename — expected: SUCCEEDS (count=0 → allowed for non-admin).
  UPDATE public.properties SET name = v_prop_fixed WHERE id = v_id;

  SELECT name INTO v_stored FROM public.properties WHERE id = v_id;
  IF v_stored <> v_prop_fixed THEN
    DELETE FROM public.properties WHERE id = v_id;
    RAISE EXCEPTION 'VQ.C FAIL: rename at count=0 did NOT persist — stored=[%]', v_stored;
  END IF;

  DELETE FROM public.properties WHERE id = v_id;
  RAISE NOTICE 'VQ.C PASS: rename ALLOWED when count=0 (fresh-typo case)';
END $vqc$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.D — non-name updates pass through (trigger scope is UPDATE OF name)
-- ══════════════════════════════════════════════════════════════════
DO $vqd$
DECLARE
  v_id BIGINT;
  v_stored TEXT;
  v_company TEXT := 'VQ-NONNAME-CO-DO-NOT-USE';
BEGIN
  INSERT INTO public.properties (name, company, is_active, address)
  VALUES ('VQ Non-Name Update Prop', v_company, FALSE, 'orig address')
  RETURNING id INTO v_id;

  UPDATE public.properties SET address = 'updated address' WHERE id = v_id;
  SELECT address INTO v_stored FROM public.properties WHERE id = v_id;

  IF v_stored <> 'updated address' THEN
    DELETE FROM public.properties WHERE id = v_id;
    RAISE EXCEPTION 'VQ.D FAIL: non-name update did not persist — stored=[%]', v_stored;
  END IF;

  DELETE FROM public.properties WHERE id = v_id;
  RAISE NOTICE 'VQ.D PASS: non-name updates pass through trigger unaffected';
END $vqd$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.E — SCHEMA_ audit row landed
-- ══════════════════════════════════════════════════════════════════
DO $vqe$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_PROPERTY_NAME_COUNT_BASED_RENAME_LOCK'
     AND new_values->>'migration' = '20260715_property_name_block_rename';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.E FAIL: SCHEMA_ audit row missing';
  END IF;
  RAISE NOTICE 'VQ.E PASS: SCHEMA_ audit row present (count=%)', v_count;
END $vqe$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.F — HAND-VERIFY (not automated)
-- Admin bypass requires a real admin session (auth.jwt() context):
--   1. Log into CA portal as super-admin (role='admin').
--   2. Edit a property WITH ≥1 assignment (real driver/resident).
--   3. Change the name and Save. Expect: success (admin bypass).
--   4. Log in as CA. Same property. Expect: name field disabled with
--      "· locked · N users assigned · contact support to change" chip.
--   5. On a NEW property (0 assignments), CA can rename freely
--      (fresh-typo case allowed).
-- ══════════════════════════════════════════════════════════════════

-- Silent success = all gates green. Any RAISE EXCEPTION above halts.

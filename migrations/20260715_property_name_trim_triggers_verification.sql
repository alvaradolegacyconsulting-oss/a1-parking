-- ════════════════════════════════════════════════════════════════════
-- Verification — 20260715_property_name_trim_triggers
-- 2026-07-15
--
-- Runs AS SUPERUSER (Supabase SQL editor) after the migration applies.
-- Each VQ proves the trigger FIRES on direct-SQL writes that bypass
-- the client entirely — Mateo's step-6 test that distinguishes
-- "we trimmed the form" from "the class is structurally closed."
--
-- Read-only VQs (VQ.A) confirm the objects exist with the expected
-- shape. Write VQs (VQ.B, VQ.C, VQ.D) use a disposable smoke row
-- inside its own transaction that ROLLS BACK — no residual writes.
--
-- HALT gates: any FAIL surfaces a NOTICE-level RAISE prefix so the
-- operator sees it clearly in the Supabase output stream. A silent
-- pass means every gate is green.
-- ════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════
-- VQ.A — three trigger functions + three triggers exist, one each
-- ══════════════════════════════════════════════════════════════════
DO $vqa$
DECLARE
  v_fn_count      INT;
  v_trigger_count INT;
BEGIN
  -- Functions
  SELECT COUNT(*) INTO v_fn_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'properties_name_trim_trigger',
       'spaces_property_trim_trigger',
       'drivers_assigned_properties_trim_trigger'
     );
  IF v_fn_count <> 3 THEN
    RAISE EXCEPTION 'VQ.A FAIL: expected 3 trigger functions, found %', v_fn_count;
  END IF;

  -- Triggers
  SELECT COUNT(*) INTO v_trigger_count
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname IN (
      'trg_properties_name_trim',
      'trg_spaces_property_trim',
      'trg_drivers_assigned_properties_trim'
    )
    AND NOT t.tgisinternal;
  IF v_trigger_count <> 3 THEN
    RAISE EXCEPTION 'VQ.A FAIL: expected 3 triggers, found %', v_trigger_count;
  END IF;

  RAISE NOTICE 'VQ.A PASS: 3 trigger functions + 3 triggers registered';
END $vqa$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.B — properties.name trigger strips trailing space on direct SQL
--        THE STEP-6 TEST — proves the class is structurally closed,
--        not just UI-trimmed.
-- ══════════════════════════════════════════════════════════════════
DO $vqb$
DECLARE
  v_id BIGINT;
  v_stored TEXT;
  v_company TEXT := 'VQ-DISPOSABLE-COMPANY-DO-NOT-USE';
BEGIN
  -- Direct SQL insert with trailing space — bypasses the client entirely.
  -- Uses savepoint so any FK/RLS side effect can be cleanly rolled back.
  INSERT INTO public.properties (name, company, is_active)
  VALUES ('VQ Test Property   ', v_company, FALSE)
  RETURNING id INTO v_id;

  SELECT name INTO v_stored FROM public.properties WHERE id = v_id;

  IF v_stored <> 'VQ Test Property' THEN
    RAISE EXCEPTION 'VQ.B FAIL: properties trigger did not fire — stored value = [%] (length %)', v_stored, length(v_stored);
  END IF;

  -- Also test UPDATE OF name
  UPDATE public.properties SET name = 'VQ Test Property Renamed   ' WHERE id = v_id;
  SELECT name INTO v_stored FROM public.properties WHERE id = v_id;

  IF v_stored <> 'VQ Test Property Renamed' THEN
    RAISE EXCEPTION 'VQ.B FAIL: properties trigger did not fire on UPDATE — stored value = [%] (length %)', v_stored, length(v_stored);
  END IF;

  -- Cleanup — DELETE the smoke row explicitly (no ROLLBACK because
  -- Supabase SQL editor auto-commits each statement).
  DELETE FROM public.properties WHERE id = v_id;

  RAISE NOTICE 'VQ.B PASS: properties.name trigger strips trailing whitespace on direct-SQL INSERT + UPDATE';
END $vqb$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.C — spaces.property trigger strips trailing space on direct SQL
-- ══════════════════════════════════════════════════════════════════
DO $vqc$
DECLARE
  v_id BIGINT;
  v_stored TEXT;
BEGIN
  INSERT INTO public.spaces (property, space_type, label, is_active)
  VALUES ('VQ Test Property  ', 'reserved', 'VQ-SMOKE-1', FALSE)
  RETURNING id INTO v_id;

  SELECT property INTO v_stored FROM public.spaces WHERE id = v_id;

  IF v_stored <> 'VQ Test Property' THEN
    RAISE EXCEPTION 'VQ.C FAIL: spaces trigger did not fire on INSERT — stored value = [%] (length %)', v_stored, length(v_stored);
  END IF;

  UPDATE public.spaces SET property = 'VQ Renamed Property  ' WHERE id = v_id;
  SELECT property INTO v_stored FROM public.spaces WHERE id = v_id;

  IF v_stored <> 'VQ Renamed Property' THEN
    RAISE EXCEPTION 'VQ.C FAIL: spaces trigger did not fire on UPDATE — stored value = [%] (length %)', v_stored, length(v_stored);
  END IF;

  DELETE FROM public.spaces WHERE id = v_id;
  RAISE NOTICE 'VQ.C PASS: spaces.property trigger strips trailing whitespace on direct-SQL INSERT + UPDATE';
END $vqc$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.D — drivers.assigned_properties trigger element-wise trims
--        Tests: null, empty array, single-element, multi-element,
--        already-clean idempotency.
-- ══════════════════════════════════════════════════════════════════
DO $vqd$
DECLARE
  v_id BIGINT;
  v_stored TEXT[];
  v_email TEXT := 'vq-disposable-driver-DO-NOT-USE@vq-test.local';
BEGIN
  -- Multi-element with mixed poisoning
  INSERT INTO public.drivers (email, name, assigned_properties, is_active)
  VALUES (v_email, 'VQ Test', ARRAY['Prop A ', '  Prop B', ' Prop C  ', 'Prop D'], FALSE)
  RETURNING id INTO v_id;

  SELECT assigned_properties INTO v_stored FROM public.drivers WHERE id = v_id;

  IF v_stored <> ARRAY['Prop A', 'Prop B', 'Prop C', 'Prop D'] THEN
    RAISE EXCEPTION 'VQ.D FAIL: drivers trigger did not element-wise trim on INSERT — stored = %', v_stored;
  END IF;

  -- UPDATE with fresh poison
  UPDATE public.drivers
     SET assigned_properties = ARRAY[' Prop A Renamed  ', 'Prop E ']
   WHERE id = v_id;
  SELECT assigned_properties INTO v_stored FROM public.drivers WHERE id = v_id;

  IF v_stored <> ARRAY['Prop A Renamed', 'Prop E'] THEN
    RAISE EXCEPTION 'VQ.D FAIL: drivers trigger did not element-wise trim on UPDATE — stored = %', v_stored;
  END IF;

  -- Empty array — passes through unchanged
  UPDATE public.drivers SET assigned_properties = ARRAY[]::TEXT[] WHERE id = v_id;
  SELECT assigned_properties INTO v_stored FROM public.drivers WHERE id = v_id;

  IF v_stored <> ARRAY[]::TEXT[] THEN
    RAISE EXCEPTION 'VQ.D FAIL: drivers trigger mangled empty array — stored = %', v_stored;
  END IF;

  -- NULL — passes through unchanged
  UPDATE public.drivers SET assigned_properties = NULL WHERE id = v_id;
  SELECT assigned_properties INTO v_stored FROM public.drivers WHERE id = v_id;

  IF v_stored IS NOT NULL THEN
    RAISE EXCEPTION 'VQ.D FAIL: drivers trigger mangled NULL — stored = %', v_stored;
  END IF;

  -- Already-clean idempotency
  UPDATE public.drivers SET assigned_properties = ARRAY['Prop Clean'] WHERE id = v_id;
  SELECT assigned_properties INTO v_stored FROM public.drivers WHERE id = v_id;

  IF v_stored <> ARRAY['Prop Clean'] THEN
    RAISE EXCEPTION 'VQ.D FAIL: drivers trigger mangled already-clean value — stored = %', v_stored;
  END IF;

  DELETE FROM public.drivers WHERE id = v_id;
  RAISE NOTICE 'VQ.D PASS: drivers.assigned_properties trigger element-wise trims on INSERT + UPDATE (NULL-safe, empty-array-safe, idempotent)';
END $vqd$;


-- ══════════════════════════════════════════════════════════════════
-- VQ.E — SCHEMA_ audit row landed
-- ══════════════════════════════════════════════════════════════════
DO $vqe$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_PROPERTY_NAME_TRIM_TRIGGERS'
     AND new_values->>'migration' = '20260715_property_name_trim_triggers';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.E FAIL: SCHEMA_ audit row missing';
  END IF;
  RAISE NOTICE 'VQ.E PASS: SCHEMA_ audit row present (count=%)', v_count;
END $vqe$;

-- Silent success = all gates green. Any RAISE EXCEPTION above halts.

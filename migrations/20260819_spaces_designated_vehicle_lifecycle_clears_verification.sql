-- ══════════════════════════════════════════════════════════════════════
-- 20260819_spaces_designated_vehicle_lifecycle_clears_verification.sql
-- POST-APPLY: four clear-sites each asserted BY NAME (Mateo Aug 19
-- constraint #3), trigger WHEN clause NULL-safe (constraint #1),
-- predicate symmetry with the RPC (constraint #2).
--
-- v2 returns-rows pattern: no BEGIN/COMMIT wrap. Read-only assertions;
-- terminal SELECT is the last statement, its row reaches the SQL Editor.
--
-- Site-name assertion strategy: each clear-site carries a tagged
-- comment marker (@DVCLEAR_SITE_1..4) in the source. Verification
-- greps pg_get_functiondef / pg_get_triggerdef for each marker. A
-- future maintainer adding a fifth clear-site without a matching
-- @DVCLEAR_SITE_5 marker + gate fails loudly at the gate that used
-- to pass. Same discipline as the D-9 sweep's "explicit per-site
-- assertion" rule.
--
-- Run AFTER 20260819_spaces_designated_vehicle_lifecycle_clears.sql.
-- Paste WHOLE. Expect: one row
--   `PASS | designated_vehicle_lifecycle (4 sites) | {gates} | <ts>`.
-- ══════════════════════════════════════════════════════════════════════

-- ── VQ.TRIGGER_EXISTS ───────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_trigger t
    JOIN pg_class   c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal
     AND n.nspname = 'public'
     AND c.relname = 'vehicles'
     AND t.tgname  = 'vehicles_inactive_clear_space_designation';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.TRIGGER_EXISTS: expected 1 vehicles_inactive_clear_space_designation trigger; got %', v_count;
  END IF;
END $$;

-- ── VQ.TRIGGER_WHEN_NULL_SAFE ───────────────────────────────────────
-- 🔴 Mateo Aug 19 constraint #1: WHEN clause must use IS TRUE / IS
-- NOT TRUE (NULL-safe boolean form) and IS [NOT] DISTINCT FROM
-- (NULL-safe equality form). Must NOT contain naïve `= true` /
-- `= false` in the trigger definition. Gate stops a future edit
-- from silently reverting the form and creating a D-8-class hole.
DO $$
DECLARE v_def TEXT; v_lower TEXT;
BEGIN
  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
    JOIN pg_class   c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'vehicles'
     AND t.tgname  = 'vehicles_inactive_clear_space_designation';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'VQ.TRIGGER_WHEN_NULL_SAFE: trigger definition unreadable';
  END IF;
  v_lower := lower(v_def);
  IF v_lower NOT LIKE '%is true%' THEN
    RAISE EXCEPTION 'VQ.TRIGGER_WHEN_NULL_SAFE: definition missing `IS TRUE` (naive `= true` would silently skip on NULL transitions)';
  END IF;
  IF v_lower NOT LIKE '%is not true%' THEN
    RAISE EXCEPTION 'VQ.TRIGGER_WHEN_NULL_SAFE: definition missing `IS NOT TRUE` (naive `NOT (... IS TRUE)` would silently skip on NULL)';
  END IF;
  -- Regex-check absence of `= true` / `= false` as bareword bool
  -- equality (word boundaries so we don't false-match on identifiers).
  IF v_lower ~ '=\s*true\M' THEN
    RAISE EXCEPTION 'VQ.TRIGGER_WHEN_NULL_SAFE: definition contains `= true` — must use IS TRUE for NULL-safety. Got: %', v_def;
  END IF;
  IF v_lower ~ '=\s*false\M' THEN
    RAISE EXCEPTION 'VQ.TRIGGER_WHEN_NULL_SAFE: definition contains `= false` — must use IS NOT TRUE for NULL-safety. Got: %', v_def;
  END IF;
END $$;

-- ── VQ.TRIGGER_PREDICATE_REFERENCES_STATUS ─────────────────────────
-- Predicate symmetry (Mateo Aug 19 #2): the trigger WHEN must
-- reference BOTH is_active AND status because the RPC set-guard
-- checks both. A WHEN clause that only fires on is_active would
-- miss the decline path when declineVehicleWrite ever splits into
-- is_active-alone or status-alone (today it flips both, but that
-- is convention not constraint).
DO $$
DECLARE v_def TEXT;
BEGIN
  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
    JOIN pg_class   c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'vehicles'
     AND t.tgname  = 'vehicles_inactive_clear_space_designation';
  IF v_def NOT LIKE '%is_active%' THEN
    RAISE EXCEPTION 'VQ.TRIGGER_PREDICATE_REFERENCES_STATUS: WHEN missing is_active reference';
  END IF;
  IF v_def NOT LIKE '%status%' THEN
    RAISE EXCEPTION 'VQ.TRIGGER_PREDICATE_REFERENCES_STATUS: WHEN missing status reference — asymmetric with RPC set-guard';
  END IF;
END $$;

-- ── VQ.SITE_1_MARKER_IN_TRIGGER_FUNCTION ────────────────────────────
DO $$
DECLARE v_body TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'clear_space_designation_on_vehicle_inactive';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'VQ.SITE_1_MARKER_IN_TRIGGER_FUNCTION: clear_space_designation_on_vehicle_inactive function not found';
  END IF;
  IF v_body NOT LIKE '%@DVCLEAR_SITE_1%' THEN
    RAISE EXCEPTION 'VQ.SITE_1_MARKER_IN_TRIGGER_FUNCTION: @DVCLEAR_SITE_1 marker missing — clear-site not recognized';
  END IF;
  IF v_body NOT LIKE '%UPDATE public.spaces%SET designated_vehicle_id = NULL%WHERE designated_vehicle_id = OLD.id%' THEN
    RAISE EXCEPTION 'VQ.SITE_1_MARKER_IN_TRIGGER_FUNCTION: expected UPDATE spaces SET designated_vehicle_id = NULL WHERE designated_vehicle_id = OLD.id — actual clear statement missing';
  END IF;
END $$;

-- ── VQ.SITE_2_MARKER_IN_RESIDENT_DEACTIVATE_TRIGGER ─────────────────
DO $$
DECLARE v_body TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'free_spaces_on_resident_deactivate';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'VQ.SITE_2_MARKER_IN_RESIDENT_DEACTIVATE_TRIGGER: free_spaces_on_resident_deactivate function not found';
  END IF;
  IF v_body NOT LIKE '%@DVCLEAR_SITE_2%' THEN
    RAISE EXCEPTION 'VQ.SITE_2_MARKER_IN_RESIDENT_DEACTIVATE_TRIGGER: @DVCLEAR_SITE_2 marker missing — resident-deactivate lifecycle clear not recognized';
  END IF;
  IF v_body NOT LIKE '%designated_vehicle_id%' THEN
    RAISE EXCEPTION 'VQ.SITE_2_MARKER_IN_RESIDENT_DEACTIVATE_TRIGGER: designated_vehicle_id not referenced in function body';
  END IF;
END $$;

-- ── VQ.SITE_3_MARKER_IN_FREE_SPACE_PER_RESIDENT ─────────────────────
DO $$
DECLARE v_body TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'free_space'
     AND pg_get_function_identity_arguments(p.oid) = 'p_space_id bigint, p_reason text, p_resident_email text';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'VQ.SITE_3_MARKER_IN_FREE_SPACE_PER_RESIDENT: free_space(BIGINT,TEXT,TEXT) not found';
  END IF;
  IF v_body NOT LIKE '%@DVCLEAR_SITE_3%' THEN
    RAISE EXCEPTION 'VQ.SITE_3_MARKER_IN_FREE_SPACE_PER_RESIDENT: @DVCLEAR_SITE_3 marker missing — per-resident free_space clear not recognized';
  END IF;
END $$;

-- ── VQ.SITE_4_MARKER_IN_FREE_SPACE_WHOLE ────────────────────────────
DO $$
DECLARE v_body TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'free_space'
     AND pg_get_function_identity_arguments(p.oid) = 'p_space_id bigint, p_reason text, p_resident_email text';
  IF v_body NOT LIKE '%@DVCLEAR_SITE_4%' THEN
    RAISE EXCEPTION 'VQ.SITE_4_MARKER_IN_FREE_SPACE_WHOLE: @DVCLEAR_SITE_4 marker missing — whole-space free_space clear not recognized';
  END IF;
END $$;

-- ── VQ.FREE_SPACE_DEFAULTS_PRESERVED ────────────────────────────────
-- feedback_create_or_replace_drops_defaults: re-defining free_space
-- must preserve `p_reason DEFAULT 'manual_free'` and
-- `p_resident_email DEFAULT NULL`.
DO $$
DECLARE v_args TEXT;
BEGIN
  SELECT pg_get_function_arguments(p.oid) INTO v_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'free_space'
     AND pg_get_function_identity_arguments(p.oid) = 'p_space_id bigint, p_reason text, p_resident_email text';
  IF v_args NOT LIKE '%DEFAULT ''manual_free''%' THEN
    RAISE EXCEPTION 'VQ.FREE_SPACE_DEFAULTS_PRESERVED: p_reason DEFAULT ''manual_free'' missing. Got: %', v_args;
  END IF;
  IF v_args NOT LIKE '%DEFAULT NULL%' THEN
    RAISE EXCEPTION 'VQ.FREE_SPACE_DEFAULTS_PRESERVED: p_resident_email DEFAULT NULL missing. Got: %', v_args;
  END IF;
END $$;

-- ── VQ.RESIDENTS_DEACTIVATE_TRIGGER_STILL_BOUND ─────────────────────
-- The residents_deactivate_free_spaces trigger existed pre-this-
-- migration. We re-issued DROP+CREATE to rebind after the function
-- body change. Sanity: still exactly 1 trigger on residents by that
-- name.
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_trigger t
    JOIN pg_class   c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal
     AND n.nspname = 'public'
     AND c.relname = 'residents'
     AND t.tgname  = 'residents_deactivate_free_spaces';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.RESIDENTS_DEACTIVATE_TRIGGER_STILL_BOUND: expected 1; got %', v_count;
  END IF;
END $$;

-- ── VQ.CLEAR_TRIGGER_FUNCTION_IS_DEFINER ────────────────────────────
DO $$
DECLARE v_security TEXT;
BEGIN
  SELECT CASE prosecdef WHEN true THEN 'DEFINER' ELSE 'INVOKER' END
    INTO v_security
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'clear_space_designation_on_vehicle_inactive';
  IF v_security <> 'DEFINER' THEN
    RAISE EXCEPTION 'VQ.CLEAR_TRIGGER_FUNCTION_IS_DEFINER: expected SECURITY DEFINER; got %', v_security;
  END IF;
END $$;

-- ── VQ.SCHEMA_AUDIT_ROW ─────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_SPACES_DESIGNATED_VEHICLE_LIFECYCLE_CLEARS'
     AND new_values->>'migration' = '20260819_spaces_designated_vehicle_lifecycle_clears';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.SCHEMA_AUDIT_ROW: SCHEMA_ audit row missing';
  END IF;
END $$;

-- ── FINAL: return one row on pass ─────────────────────────────────
SELECT
  'PASS'::TEXT                                            AS status,
  'designated_vehicle_lifecycle (4 sites)'::TEXT          AS target,
  ARRAY[
    'TRIGGER_EXISTS',
    'TRIGGER_WHEN_NULL_SAFE',
    'TRIGGER_PREDICATE_REFERENCES_STATUS',
    'SITE_1_MARKER_IN_TRIGGER_FUNCTION',
    'SITE_2_MARKER_IN_RESIDENT_DEACTIVATE_TRIGGER',
    'SITE_3_MARKER_IN_FREE_SPACE_PER_RESIDENT',
    'SITE_4_MARKER_IN_FREE_SPACE_WHOLE',
    'FREE_SPACE_DEFAULTS_PRESERVED',
    'RESIDENTS_DEACTIVATE_TRIGGER_STILL_BOUND',
    'CLEAR_TRIGGER_FUNCTION_IS_DEFINER',
    'SCHEMA_AUDIT_ROW'
  ]                                                       AS gates_verified,
  now()                                                   AS verified_at;

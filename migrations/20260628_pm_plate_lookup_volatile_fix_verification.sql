-- ════════════════════════════════════════════════════════════════════
-- Permit-Door Piece 3 Item 1 — pm_plate_lookup VOLATILE fix — VERIFICATION
-- 2026-06-28
-- ════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- §1 — volatility flipped to VOLATILE
-- ─────────────────────────────────────────────────────────────────
SELECT
  '§1 — provolatile'                                              AS check_name,
  proname,
  provolatile                                                     AS volatile_flag,
  CASE WHEN provolatile = 'v' THEN 'PASS — VOLATILE (writes allowed)'
       WHEN provolatile = 's' THEN 'FAIL — still STABLE (writes still blocked)'
       WHEN provolatile = 'i' THEN 'FAIL — IMMUTABLE (writes blocked)'
       ELSE 'FAIL — unexpected: ' || provolatile
  END                                                             AS verdict
FROM pg_proc
WHERE proname     = 'pm_plate_lookup'
  AND pronamespace = 'public'::regnamespace;

-- ─────────────────────────────────────────────────────────────────
-- §2 — exactly ONE function in pg_proc (no overload trap)
-- ─────────────────────────────────────────────────────────────────
SELECT
  '§2 — function count'                                           AS check_name,
  count(*)                                                        AS proc_count,
  CASE WHEN count(*) = 1 THEN 'PASS'
       WHEN count(*) = 0 THEN 'FAIL — function missing'
       ELSE 'FAIL — overload trap (' || count(*) || ' functions exist)'
  END                                                             AS verdict
FROM pg_proc
WHERE proname     = 'pm_plate_lookup'
  AND pronamespace = 'public'::regnamespace;

-- ─────────────────────────────────────────────────────────────────
-- §3 — grants preserved (CREATE OR REPLACE on matching signature
--      preserves grants; this verifies the assumption held)
-- ─────────────────────────────────────────────────────────────────
SELECT
  '§3 — authenticated has EXECUTE'                                AS check_name,
  has_function_privilege('authenticated', 'public.pm_plate_lookup(text)', 'EXECUTE') AS has_exec,
  CASE WHEN has_function_privilege('authenticated', 'public.pm_plate_lookup(text)', 'EXECUTE')
       THEN 'PASS' ELSE 'FAIL — authenticated lost EXECUTE'
  END                                                             AS verdict;

SELECT
  '§3 — anon does NOT have EXECUTE'                               AS check_name,
  has_function_privilege('anon', 'public.pm_plate_lookup(text)', 'EXECUTE') AS has_exec,
  CASE WHEN NOT has_function_privilege('anon', 'public.pm_plate_lookup(text)', 'EXECUTE')
       THEN 'PASS' ELSE 'FAIL — anon has EXECUTE (PUBLIC-grant retrofit gap)'
  END                                                             AS verdict;

-- ─────────────────────────────────────────────────────────────────
-- §4 — behavioral smoke: function runs without P0050 (non-volatile
--      INSERT error). Cannot easily test the full happy-path here
--      without a real auth.jwt() context; that's what the §6 UI smoke
--      covers. This SQL test confirms the RPC RAISEs the EXPECTED
--      'unauthenticated' error (proves the function executes far
--      enough to fail on auth — NOT on the audit INSERT line).
-- ─────────────────────────────────────────────────────────────────
DO $b$
DECLARE
  v_msg     TEXT;
  v_sqlstate TEXT;
BEGIN
  BEGIN
    PERFORM public.pm_plate_lookup('TEST123');
    RAISE EXCEPTION 'FAIL §4 — pm_plate_lookup should have raised unauthenticated';
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS
        v_msg      = MESSAGE_TEXT,
        v_sqlstate = RETURNED_SQLSTATE;
      IF v_msg = 'unauthenticated' THEN
        RAISE NOTICE 'PASS §4 — function executes; raised expected unauthenticated (auth gate hit)';
      ELSIF v_sqlstate = '0A000' THEN
        -- 0A000 = feature_not_supported = "INSERT is not allowed in a non-volatile function"
        RAISE EXCEPTION 'FAIL §4 — still hitting the P0050/0A000 STABLE bug: %', v_msg;
      ELSE
        RAISE NOTICE 'PARTIAL §4 — function executed but raised unexpected: % (sqlstate=%)', v_msg, v_sqlstate;
      END IF;
  END;
END $b$;

-- ─────────────────────────────────────────────────────────────────
-- §5 — migration audit row landed
-- ─────────────────────────────────────────────────────────────────
SELECT
  '§5 — migration audit row'                                      AS check_name,
  count(*)                                                        AS rows_found,
  CASE WHEN count(*) = 1 THEN 'PASS'
       WHEN count(*) = 0 THEN 'FAIL — no audit row'
       ELSE 'FAIL — too many audit rows (' || count(*) || ')'
  END                                                             AS verdict
FROM public.audit_logs
WHERE action    = 'SCHEMA_RPC_UPDATED'
  AND table_name = 'pm_plate_lookup'
  AND new_values->>'migration' = '20260628_pm_plate_lookup_volatile_fix';

-- ─────────────────────────────────────────────────────────────────
-- §6 — UI smoke (run in app, not SQL)
-- ─────────────────────────────────────────────────────────────────
--   Manager portal → Plate Lookup tab → enter any plate (real or
--   synthetic) → expected: result card renders (resident / visitor /
--   guest_authorized / unauthorized) WITHOUT the "INSERT is not
--   allowed in a non-volatile function" error.
--
--   Then: verify audit row landed:
--     SELECT created_at, user_email, action, new_values
--       FROM public.audit_logs
--      WHERE action = 'plate_lookup'
--      ORDER BY created_at DESC LIMIT 5;
--   Expected: a row per UI lookup, post-migration.
--
-- ════════════════════════════════════════════════════════════════════

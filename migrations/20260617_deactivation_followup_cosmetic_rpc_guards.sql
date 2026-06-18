-- Deactivation follow-up — effective-active guard on the two cosmetic RPCs
--
-- HISTORY
--   The June 17 cascading-deactivation arc (commit 7da03d2) closed the
--   resident-INSERT path via request_my_vehicle (DEFINER RPC with
--   effective-active guard) + DROP resident_insert_vehicles policy.
--   At ship time, two adjacent B90-v2 cosmetic RPCs were filed as
--   follow-up scope (LOW risk — cosmetic edits on rows the resident
--   already owns, no new access, no new data):
--
--     • update_my_vehicle_cosmetic (sets state/make/model/year/color)
--     • mark_my_vehicle_declined_read (sets resident_read = TRUE)
--
--   Today's follow-up: add the same effective-active body guard that
--   request_my_vehicle uses, mirroring its exact pattern (guard first,
--   'account_deactivated' raise string with the same HINT, no-args
--   auto-scope so the helper derives the resident's property from
--   residents.property).
--
-- ARCHITECTURE — body guard inside SECURITY DEFINER function
--   This is intentionally a function-body guard, NOT a trigger and NOT
--   an RLS policy. The B90 v1 BEFORE UPDATE trigger architecture (the
--   one we rolled back same-day on 2026-06-15) hung to statement-
--   timeout on the resident_update_vehicles WITH CHECK recheck loop;
--   B90 v2 only worked because the DEFINER context bypasses the policy
--   recheck on NEW entirely. Re-introducing a trigger or RLS-recheck-
--   based guard would hit the same hang class. Pure body-guard inside
--   DEFINER fn is the canonical pattern — same shape as
--   request_my_vehicle (2026-06-17), B198 (verifyOtp interstitial),
--   A2 (get_company_admin_emails), and D2 (insert_user_role).
--
-- SECURITY ENVELOPE — provably unchanged
--   • LANGUAGE plpgsql                           — UNCHANGED
--   • SECURITY DEFINER                           — UNCHANGED
--   • SET search_path TO public, pg_temp         — UNCHANGED
--   • Signature (5+1 args for cosmetic; 1 arg for mark-read) — UNCHANGED
--   • Return type BIGINT                          — UNCHANGED
--   • REVOKE EXECUTE FROM PUBLIC                  — UNCHANGED
--   • REVOKE EXECUTE FROM anon                    — UNCHANGED
--   • GRANT  EXECUTE TO authenticated             — UNCHANGED
--
--   The CREATE OR REPLACE FUNCTION statements below redefine the
--   bodies only. The REVOKE/GRANT statements are re-applied for
--   idempotent safety (they no-op if already in the desired state).
--
-- APPLY DISCIPLINE
--   SINGLE-PASTE SINGLE-RUN. Paste this entire file into the Supabase
--   SQL Editor and Run. Both RPCs must update atomically — partial
--   apply could leave one guarded and one unguarded (stale-session
--   deactivated resident could still mark-read but not cosmetic-edit,
--   or vice versa — an inconsistent gate posture).
--   See [[feedback_sql_editor_partial_apply]].
--
-- PRE-APPLY GATE (operator)
--   Run the pg_get_functiondef verify query at the head of the
--   PRE-APPLY SANITY VERIFICATION section. If the live bodies don't
--   match the migration text in the previous B90 v2 file
--   (migrations/20260615_b90_resident_vehicle_definer_rpc.sql), STOP
--   and re-scope before applying. The migration file is the draft,
--   not proof of live state — Dashboard edits could have drifted
--   the production body without a repo trail.
-- ============================================================================

-- ── PRE-APPLY SANITY VERIFICATION ──────────────────────────────────

SELECT '─────── PRE-APPLY: current bodies of both target RPCs (compare against B90 v2 migration text) ───────' AS marker;

-- VQ.0 — Live function bodies. Compare visually against
-- migrations/20260615_b90_resident_vehicle_definer_rpc.sql lines
-- 139-184 (update_my_vehicle_cosmetic) and 201-231
-- (mark_my_vehicle_declined_read). Both should:
--   • Begin with the caller-is-resident gate (NOT yet with the
--     get_my_effective_active gate — that's what this migration adds)
--   • Have the same UPDATE/ROW_COUNT/RETURN tail
--   • Have search_path set to public, pg_temp
--   • Have prosecdef = true
-- If anything looks different (a body has been Dashboard-edited
-- since 2026-06-15), STOP and re-scope.
SELECT
  p.proname                                  AS fn,
  pg_get_function_identity_arguments(p.oid)  AS args,
  p.prosecdef                                AS is_definer_expect_true,
  p.proconfig                                AS config_expect_public_pg_temp,
  pg_get_functiondef(p.oid)                  AS current_body
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('update_my_vehicle_cosmetic', 'mark_my_vehicle_declined_read')
ORDER BY p.proname;

SELECT '─────── PRE-APPLY: get_my_effective_active helper exists (sanity) ───────' AS marker;

-- VQ.0b — The helper this migration's bodies will call must exist.
-- If zero rows, the cascading-deactivation arc (7da03d2) didn't apply
-- — STOP, apply that first.
SELECT
  proname                                   AS fn,
  pg_get_function_identity_arguments(oid)   AS args,
  pg_get_function_result(oid)               AS returns,
  prosecdef                                 AS is_definer
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname = 'get_my_effective_active';
-- Expected: one row, args = "scope_property text DEFAULT NULL",
-- returns = boolean, is_definer = true.

-- ── PART 1 — update_my_vehicle_cosmetic with effective-active guard ─

CREATE OR REPLACE FUNCTION public.update_my_vehicle_cosmetic(
  p_id    BIGINT,
  p_state TEXT,
  p_make  TEXT,
  p_model TEXT,
  p_year  INTEGER,
  p_color TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $func$
DECLARE
  v_count INTEGER;
BEGIN
  -- Deactivation arc follow-up — effective-active guard. Mirrors the
  -- pattern in request_my_vehicle (2026-06-17). Sits first so stale-
  -- session deactivated residents can't cosmetic-edit either. Default
  -- scope = NULL → helper auto-derives from residents.property.
  -- 'account_deactivated' raise string + HINT match the
  -- request_my_vehicle precedent verbatim so the resident-page client
  -- error matcher (error.message.includes('account_deactivated'))
  -- handles all three RPCs uniformly.
  IF NOT public.get_my_effective_active() THEN
    RAISE EXCEPTION 'account_deactivated'
      USING HINT = 'Your access has been deactivated. Contact your property manager.';
  END IF;

  IF public.get_my_role() IS DISTINCT FROM 'resident' THEN
    RAISE EXCEPTION 'caller is not a resident'
      USING HINT = 'This RPC is for resident-self cosmetic vehicle edits only.';
  END IF;

  UPDATE public.vehicles ur
     SET state = p_state,
         make  = p_make,
         model = p_model,
         year  = p_year,
         color = p_color
   WHERE ur.id = p_id
     AND (ur.property, ur.unit) IN (
       SELECT r.property, r.unit
       FROM public.residents r
       WHERE lower(r.email) = lower(auth.jwt() ->> 'email')
     );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    -- Don't distinguish "vehicle doesn't exist" from "not yours" — same
    -- error shape avoids an ownership oracle. The UI's only call site
    -- always passes the user's own vehicle id, so this only fires on
    -- crafted-PATCH attempts.
    RAISE EXCEPTION 'vehicle not found or not yours';
  END IF;

  RETURN p_id;
END;
$func$;

-- Re-apply the GRANT envelope for idempotent safety (no-op if already set).
REVOKE EXECUTE ON FUNCTION public.update_my_vehicle_cosmetic(BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_my_vehicle_cosmetic(BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.update_my_vehicle_cosmetic(BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT) TO authenticated;

-- ── PART 2 — mark_my_vehicle_declined_read with effective-active guard

CREATE OR REPLACE FUNCTION public.mark_my_vehicle_declined_read(p_id BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $func$
DECLARE
  v_count INTEGER;
BEGIN
  -- Deactivation arc follow-up — same guard shape as update_my_vehicle_
  -- cosmetic above. Single-intent function (resident_read := TRUE on
  -- caller-owned vehicle); the guard discipline is identical.
  IF NOT public.get_my_effective_active() THEN
    RAISE EXCEPTION 'account_deactivated'
      USING HINT = 'Your access has been deactivated. Contact your property manager.';
  END IF;

  IF public.get_my_role() IS DISTINCT FROM 'resident' THEN
    RAISE EXCEPTION 'caller is not a resident'
      USING HINT = 'This RPC is for resident-self decline acknowledgement only.';
  END IF;

  UPDATE public.vehicles ur
     SET resident_read = TRUE
   WHERE ur.id = p_id
     AND (ur.property, ur.unit) IN (
       SELECT r.property, r.unit
       FROM public.residents r
       WHERE lower(r.email) = lower(auth.jwt() ->> 'email')
     );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'vehicle not found or not yours';
  END IF;

  RETURN p_id;
END;
$func$;

-- Re-apply the GRANT envelope for idempotent safety.
REVOKE EXECUTE ON FUNCTION public.mark_my_vehicle_declined_read(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mark_my_vehicle_declined_read(BIGINT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.mark_my_vehicle_declined_read(BIGINT) TO authenticated;

-- ── POST-APPLY VERIFICATION ────────────────────────────────────────

SELECT '─────── POST-APPLY: both RPCs now contain get_my_effective_active call ───────' AS marker;

-- VQ.A — Body should contain the new helper call. If 'NO (FAIL)',
-- the guard didn't land — STOP and investigate.
SELECT
  p.proname                                  AS fn,
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%get_my_effective_active%' THEN 'YES (PASS)' ELSE 'NO (FAIL)' END
                                             AS body_has_effective_active_guard,
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%account_deactivated%' THEN 'YES (PASS)' ELSE 'NO (FAIL)' END
                                             AS body_has_account_deactivated_raise,
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%get_my_role%' THEN 'YES (PASS)' ELSE 'NO (FAIL)' END
                                             AS body_still_has_caller_role_guard,
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%auth.jwt%' THEN 'YES (PASS)' ELSE 'NO (FAIL)' END
                                             AS body_still_has_ownership_lookup
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('update_my_vehicle_cosmetic', 'mark_my_vehicle_declined_read')
ORDER BY p.proname;

SELECT '─────── POST-APPLY: security envelope unchanged (DEFINER + search_path) ───────' AS marker;

-- VQ.B — Security envelope must be byte-identical to pre-apply.
SELECT
  p.proname                                  AS fn,
  pg_get_function_identity_arguments(p.oid)  AS args_expect_unchanged,
  pg_get_function_result(p.oid)              AS returns_expect_bigint,
  p.prosecdef                                AS is_definer_expect_true,
  p.proconfig                                AS config_expect_search_path_public_pg_temp
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('update_my_vehicle_cosmetic', 'mark_my_vehicle_declined_read')
ORDER BY p.proname;
-- Expected for both rows:
--   args:    update_my_vehicle_cosmetic → "p_id bigint, p_state text, p_make text, p_model text, p_year integer, p_color text"
--            mark_my_vehicle_declined_read → "p_id bigint"
--   returns: bigint
--   is_definer: t
--   config: {search_path=public, pg_temp}  (single element with both schemas)

SELECT '─────── POST-APPLY: proacl shape — no anon, no PUBLIC, authenticated present ───────' AS marker;

-- VQ.C — Grant state must remain authenticated-only (no anon leak).
SELECT
  p.proname                                  AS fn,
  p.proacl::TEXT                             AS proacl_after,
  CASE WHEN p.proacl::TEXT LIKE '%anon=X%' THEN 'YES (FAIL)' ELSE 'NO (PASS)' END
                                             AS anon_executable,
  CASE WHEN p.proacl::TEXT ~ '(^|[,{])=X' THEN 'YES (FAIL)' ELSE 'NO (PASS)' END
                                             AS public_executable,
  CASE WHEN p.proacl::TEXT LIKE '%authenticated=X%' THEN 'YES (PASS)' ELSE 'NO (FAIL)' END
                                             AS authenticated_executable
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('update_my_vehicle_cosmetic', 'mark_my_vehicle_declined_read')
ORDER BY p.proname;

SELECT '─────── POST-APPLY: no new functions / no functions dropped ───────' AS marker;

-- VQ.D — Sanity count: only the two existing RPCs should be present
-- with these names. Nothing extra, nothing missing.
SELECT count(*) AS rpc_count_expect_two
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('update_my_vehicle_cosmetic', 'mark_my_vehicle_declined_read');

-- ============================================================================
-- POST-APPLY SMOKE (operator runs from app, not SQL)
-- ============================================================================
--
-- After applying:
--   1. As a DEACTIVATED resident (residents.is_active=false OR
--      user_roles.is_active=false OR companies.account_state ∉ {active,past_due}
--      OR property.is_active=false):
--        a. Cosmetic edit (Edit button on a vehicle card) → raises
--           'account_deactivated'. Resident-page client matches on
--           error.message.includes('account_deactivated') and shows
--           the friendly "contact your property manager" copy.
--        b. Mark-as-Read on a declined vehicle → same raise + friendly copy.
--   2. As an ACTIVE resident:
--        a. Cosmetic edit succeeds (vehicle row updated, no error).
--        b. Mark-as-Read succeeds.
--   3. Crafted PATCH against /rest/v1/vehicles?id=eq.X (any resident):
--      still permission denied (no UPDATE policy for resident role —
--      that path was DROPped by B90 v2 and stays DROPped).

-- B90 — resident vehicle write guard (DEFINER RPC architecture; v2)
--
-- HISTORY
--   v1 (BEFORE UPDATE trigger with to_jsonb allowlist) was applied
--   2026-06-15 and rolled back same day (P0). The trigger raised
--   correctly on every block-case but hung to statement-timeout on
--   every legitimate cosmetic-edit path. Root cause confirmed as H2:
--   the resident_update_vehicles policy's WITH CHECK re-evaluation on
--   the NEW row, specifically the
--     (property, unit) IN (SELECT ... FROM residents WHERE
--                          email ~~* (auth.jwt() ->> 'email'))
--   subquery, looped indefinitely after the trigger returned NEW.
--   Admin's policy is unscoped → admin RETURN-NEW path was fast →
--   identifying the resident-RLS-recheck as the hang. H1 (Dashboard-
--   applied trigger) ruled out via pg_trigger enumeration against prod
--   post-rollback: zero rows.
--
-- v2 ARCHITECTURE — canonical DEFINER-RPC pattern
--   1. CREATE update_my_vehicle_cosmetic — SECURITY DEFINER RPC whose
--      signature pins the 5 allowed cosmetic columns. Body guards
--      caller-is-resident + caller-owns-vehicle. DEFINER context
--      bypasses RLS WITH CHECK entirely (no recheck-on-NEW = no
--      H2 hang).
--   2. CREATE mark_my_vehicle_declined_read — second narrow RPC for
--      the markDeclinedRead call site at app/resident/page.tsx:323
--      (sets resident_read = TRUE on a declined vehicle). Mirror
--      ownership guard. Splitting into two RPCs over one combined
--      keeps each signature single-intent.
--   3. DROP POLICY resident_update_vehicles — removes the
--      direct-PATCH bypass. Residents no longer have ANY direct
--      UPDATE path against vehicles; the two RPCs are the only
--      authorized resident writes.
--   4. resident_select_vehicles + resident_insert_vehicles untouched.
--      Residents can still SEE their vehicles and INSERT new request
--      rows via the existing "Request New Vehicle" flow.
--
--   Matches the D2 (insert_user_role) / A2 (get_company_admin_emails)
--   / B198 (verifyOtp interstitial) pattern — body-guarded DEFINER fn
--   with REVOKE-from-anon + GRANT-to-authenticated discipline.
--
-- AUTH MODEL after this migration
--   • Resident UPDATE direct REST PATCH against /rest/v1/vehicles?id=eq.X
--     → permission denied (no UPDATE policy for resident role)
--   • Resident calls update_my_vehicle_cosmetic RPC
--     → DEFINER context updates 5 cols on caller-owned vehicle
--   • Resident calls mark_my_vehicle_declined_read RPC
--     → DEFINER context sets resident_read=TRUE on caller-owned vehicle
--   • Resident calls either RPC on someone else's vehicle
--     → "vehicle not found or not yours" (no oracle on ownership distinction)
--   • Non-resident calls either RPC → "caller is not a resident"
--   • anon calls either RPC → permission denied (REVOKE FROM anon)
--   • admin / CA / manager / driver UPDATE policies untouched
--     (legitimate workflow writes preserved)
--
-- APPLY DISCIPLINE
--   SINGLE-PASTE SINGLE-RUN. Paste this entire file into the Supabase
--   SQL Editor and Run. Partial apply could leave one RPC created with
--   the policy still in place (resident still has bypass) or leave the
--   policy dropped without RPCs in place (resident can't edit at all).
--   See [[feedback_sql_editor_partial_apply]].
--
-- ============================================================================
-- BEFORE STATE — captured 2026-06-15 from prod (rolled-back v1 state).
--
-- Relevant policy (will be DROPped):
--   CREATE POLICY resident_update_vehicles ON vehicles
--     FOR UPDATE TO authenticated
--     USING (
--       (get_my_role() = 'resident'::text)
--       AND ((property, unit) IN (
--         SELECT residents.property, residents.unit FROM residents
--         WHERE residents.email ~~* (auth.jwt() ->> 'email'::text)
--       ))
--     )
--     WITH CHECK (... same as USING ...);
--
-- Existing triggers on vehicles: ZERO (confirmed via pg_trigger
-- enumeration post-rollback). v1 trigger DROPped.
--
-- After this migration:
--   • Two DEFINER RPCs exist with REVOKE-anon + GRANT-authenticated
--   • resident_update_vehicles policy is gone
--   • resident_select_vehicles + resident_insert_vehicles unchanged
--   • All non-resident UPDATE policies unchanged
-- ============================================================================

-- ── PRE-APPLY SANITY VERIFICATION ───────────────────────────────────────────

SELECT '─────── PRE-APPLY: resident_update_vehicles policy state ───────' AS marker;

SELECT
  schemaname, tablename, policyname,
  cmd, roles,
  qual          AS using_expr,
  with_check    AS with_check_expr
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'vehicles'
  AND policyname = 'resident_update_vehicles';
-- Expected: exactly one row matching the BEFORE STATE captured above.
-- If zero rows, the policy is already gone — re-paste is idempotent.

SELECT '─────── PRE-APPLY: triggers on vehicles (must be zero rows) ───────' AS marker;

SELECT
  t.tgname AS trigger, p.proname AS fn_called,
  pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_proc  p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND c.relnamespace = 'public'::regnamespace
  AND c.relname = 'vehicles';
-- Expected: ZERO rows. If any rows appear, STOP and investigate before
-- proceeding — a Dashboard-applied trigger landed since the v1 rollback
-- and would affect the RPC's internal UPDATE path identically.

SELECT '─────── PRE-APPLY: existing update_my_vehicle_* fns (idempotent re-paste check) ───────' AS marker;

SELECT
  p.proname AS fn,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef AS is_definer
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('update_my_vehicle_cosmetic', 'mark_my_vehicle_declined_read');
-- Expected: ZERO rows on first apply. Subsequent re-paste shows two rows
-- (CREATE OR REPLACE is idempotent).

-- ── PART 1 — update_my_vehicle_cosmetic RPC ─────────────────────────────────
-- Signature pins the 5 allowlist columns (state, make, model, year, color).
-- No other column is reachable via this RPC. Body guards:
--   • caller is a resident (else 'caller is not a resident')
--   • caller owns the vehicle by (property, unit) tuple match against
--     residents (else 'vehicle not found or not yours' — same shape for
--     both "doesn't exist" and "not yours" to avoid an ownership oracle)
-- search_path public, pg_temp — standing B182/D2/A2 pattern.

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
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
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
$function$;

REVOKE EXECUTE ON FUNCTION public.update_my_vehicle_cosmetic(BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_my_vehicle_cosmetic(BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.update_my_vehicle_cosmetic(BIGINT, TEXT, TEXT, TEXT, INTEGER, TEXT) TO authenticated;

-- ── PART 2 — mark_my_vehicle_declined_read RPC ──────────────────────────────
-- Single-column write: resident_read := TRUE. Mirrors the existing
-- markDeclinedRead JS path (app/resident/page.tsx:322-325). Same
-- caller-is-resident + caller-owns-vehicle guards as Part 1.
--
-- Not bundled into Part 1 because the call sites and semantics differ:
-- Part 1 is "save cosmetic edits" (multiple cols, "Edit" button); this
-- is "acknowledge decline" (single col, "Mark as Read" button on
-- declined vehicles). Single-intent signatures are easier to reason
-- about and to grep for.

CREATE OR REPLACE FUNCTION public.mark_my_vehicle_declined_read(p_id BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
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
$function$;

REVOKE EXECUTE ON FUNCTION public.mark_my_vehicle_declined_read(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mark_my_vehicle_declined_read(BIGINT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.mark_my_vehicle_declined_read(BIGINT) TO authenticated;

-- ── PART 3 — DROP resident_update_vehicles policy ───────────────────────────
-- After this drop, residents have ZERO direct-UPDATE path against
-- vehicles. The two RPCs are the only authorized resident writes.
-- SELECT + INSERT policies for residents stay (resident_select_vehicles
-- + resident_insert_vehicles), so the rest of the resident portal
-- (viewing, requesting new vehicles) is unaffected.

DROP POLICY IF EXISTS resident_update_vehicles ON public.vehicles;

-- ── POST-APPLY VERIFICATION ─────────────────────────────────────────────────

SELECT '─────── POST-APPLY: RPC state ───────' AS marker;

-- VQ.A — both RPCs exist with correct shape (DEFINER + search_path + body).
SELECT
  p.proname                                  AS fn,
  pg_get_function_identity_arguments(p.oid)  AS args,
  p.prosecdef                                AS is_definer_expect_true,
  p.proconfig                                AS config_expect_public_pg_temp,
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%get_my_role%' THEN 'YES (PASS)' ELSE 'NO (FAIL)' END
                                             AS body_has_caller_role_guard,
  CASE WHEN pg_get_functiondef(p.oid) LIKE '%auth.jwt%' THEN 'YES (PASS)' ELSE 'NO (FAIL)' END
                                             AS body_has_ownership_lookup
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('update_my_vehicle_cosmetic', 'mark_my_vehicle_declined_read')
ORDER BY p.proname;

-- VQ.B — proacl shape for both RPCs: no anon, no PUBLIC, authenticated present.
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

-- VQ.C — resident_update_vehicles policy DROPped.
SELECT '─────── POST-APPLY: vehicles UPDATE policies ───────' AS marker;
SELECT policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'vehicles'
  AND cmd = 'UPDATE'
ORDER BY policyname;
-- Expected: admin_all_vehicles (FOR ALL counts as UPDATE), company_admin_update_vehicles,
-- driver_*_vehicles UPDATE policies, manager_update_vehicles. NO resident_update_vehicles.
-- (admin_all_vehicles is FOR ALL so cmd may show as 'ALL' rather than 'UPDATE' — that's
-- expected and fine; it covers UPDATE via FOR ALL semantics.)

-- VQ.D — resident_select_vehicles + resident_insert_vehicles untouched (no regression
-- on the view + request-new-vehicle paths).
SELECT '─────── POST-APPLY: resident vehicles policies intact ───────' AS marker;
SELECT policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'vehicles'
  AND policyname LIKE 'resident_%'
ORDER BY policyname;
-- Expected exactly two rows:
--   resident_insert_vehicles | INSERT
--   resident_select_vehicles | SELECT

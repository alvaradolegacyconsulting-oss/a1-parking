-- ════════════════════════════════════════════════════════════════════
-- pm_plate_lookup — hardening pass (determinism + property-match safety)
-- 2026-07-20 · B224 fast-follows for the manager surface
--
-- Brings pm_plate_lookup to parity with the driver-side B224 read-side
-- fix (57a9160). Two fixes in one CREATE OR REPLACE:
--
-- ── FIX 1 (visitor_passes ONLY) — determinism ──────────────────────
-- The visitor_passes branch used bare `LIMIT 1` without ORDER BY. When
-- 2+ passes match (same plate + property + active + non-expired), the
-- returned row was planner-arbitrary. Doesn't throw (unlike PostgREST
-- .single() which produced the driver-side wrongful-tow), but the
-- non-determinism is its own class: PM scans a plate with 2+ passes
-- and gets an arbitrary (possibly wrong-visitor) unit back.
--
-- Add `ORDER BY vp.expires_at DESC` before the existing `LIMIT 1` so
-- the freshest (longest-remaining-validity) pass wins deterministically.
-- Mirrors driver-side `.order('expires_at', desc).limit(1)` semantics
-- (57a9160). Driver + manager parity is the point.
--
-- The other four branches (vehicles active, vehicles pending,
-- vehicle_plate_changes, guest_authorizations) either sort already
-- (vpc.submitted_at DESC, ga.end_date DESC) or assume one-row-per-
-- (plate, property) — the vehicles-branch assumption is filed as
-- docs/backlog/pm_plate_lookup-vehicles-branches-determinism.md and
-- deliberately NOT expanded into this commit.
--
-- ── FIX 2 (all 5 branches) — property-match safety ─────────────────
-- Every branch used `<table>.property ILIKE ANY (v_properties)` where
-- v_properties comes from get_my_properties() (text[] from
-- user_roles.property). Two failure modes closed:
--
--   1. Whitespace strict — ILIKE requires whitespace to match on both
--      sides. A stray leading/trailing space in either side produced
--      false-negatives. Same class as the July 14 driver false-notfound.
--
--   2. Wildcard interpretation — ILIKE treats `%` and `_` as wildcards.
--      A stored value with a literal `%` or `_` (say, from a CA typo)
--      would over-match. Same class as the 2026-07-14 anon-RPC ILIKE
--      close (20260714_anon_rpc_ilike_wildcard_close.sql). This is the
--      last remaining instance of that pattern in the RPC layer.
--
-- Fix: precompute `v_properties_normalized TEXT[]` once at the top of
-- the body as `ARRAY(SELECT lower(trim(p)) FROM unnest(v_properties) p)`,
-- then swap all 5 predicates to
-- `lower(trim(<table>.property)) = ANY (v_properties_normalized)`.
-- Case-insensitive exact-equality after trim. Both sides normalized.
-- Zero wildcard surface. Whitespace-tolerant.
--
-- Plate side left alone — already safe via
-- `upper(regexp_replace(x, '[^A-Za-z0-9]', '', 'g'))` exact-equality on
-- both sides, alphanumeric-only. Zero wildcard surface pre-existing.
--
-- ── REGRESSION PROFILE (Jose confirmed 2026-07-20) ─────────────────
-- Pre-apply queries returned zero rows on all three regression checks:
--   Q1. user_roles.property elements containing `%` or `_`  → 0
--       (no manager currently over-matches via wildcards → nothing
--        narrows post-fix)
--   Q2. visitor_passes.property with leading/trailing whitespace  → 0
--       (no historical rows suddenly start matching → nothing widens)
--   Q3. user_roles.property elements with leading/trailing whitespace → 0
--       (same — trim triggers 3adc2c5 keep new writes clean and Jose's
--        July 15 cleanup trimmed existing rows)
-- Clean regression profile — behavior delta is zero for currently-live
-- data. Fix is purely forward-looking hardening against re-introduction
-- of the classes.
--
-- ── HAPPY PATH PRESERVED ────────────────────────────────────────────
-- Function signature (p_plate TEXT → jsonb), SECURITY DEFINER, VOLATILE
-- (for the audit_logs INSERT), search_path (public, pg_temp), role
-- check (manager | leasing_agent), cascade ordering (resident → pending
-- → plate-change → guest_auth → visitor-pass → unauthorized), return
-- shape (result_type, unit_number, guest_name, valid_through), and
-- audit-write behavior — all unchanged.
--
-- ── DISCIPLINE ──────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS first (defensive — wipes ACL, forces re-GRANT
-- per convention), pg_proc COUNT=1 assertion, REVOKE PUBLIC + anon +
-- GRANT authenticated re-emitted per feedback_function_public_grant_
-- supabase_default + feedback_revoke_from_anon_explicitly. Whole
-- migration in ONE transaction. VQs live in companion verification
-- file — one is a self-cleaning determinism smoke that proves the
-- ORDER BY fix works end-to-end.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- Defensive DROP so post-apply overload_count = 1 for sure
-- ([[feedback_sql_editor_partial_apply]] lesson).
DROP FUNCTION IF EXISTS public.pm_plate_lookup(TEXT);

CREATE OR REPLACE FUNCTION public.pm_plate_lookup(p_plate TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email          TEXT;
  v_role                  TEXT;
  v_properties            TEXT[];
  v_properties_normalized TEXT[];   -- NEW (Fix 2): precomputed lower(trim(each element))
  v_normalized            TEXT;
  v_vehicle_unit          TEXT;
  v_visitor_unit          TEXT;
  v_guest_name            TEXT;
  v_guest_unit            TEXT;
  v_guest_end             DATE;
  v_result_type           TEXT;
  v_unit_number           TEXT;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = 'check_violation';
  END IF;

  v_role := get_my_role();
  IF v_role NOT IN ('manager', 'leasing_agent') THEN
    RAISE EXCEPTION 'role % not permitted for pm_plate_lookup', v_role
      USING ERRCODE = 'check_violation';
  END IF;

  v_properties := get_my_properties();
  IF v_properties IS NULL OR array_length(v_properties, 1) IS NULL THEN
    RAISE EXCEPTION 'caller has no assigned properties' USING ERRCODE = 'check_violation';
  END IF;

  -- Fix 2 (2026-07-20): normalize the caller's property array ONCE per
  -- invocation, reuse in all 5 predicates below. Handles NULL / empty
  -- array cleanly (unnest returns zero rows → empty result array).
  v_properties_normalized := ARRAY(SELECT lower(trim(p)) FROM unnest(v_properties) p);

  IF p_plate IS NULL OR length(trim(p_plate)) = 0 THEN
    RAISE EXCEPTION 'plate required' USING ERRCODE = 'check_violation';
  END IF;
  v_normalized := upper(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'));

  IF length(v_normalized) = 0 THEN
    RAISE EXCEPTION 'plate empty after normalization' USING ERRCODE = 'check_violation';
  END IF;

  -- ── 1. Resident match (active permit) ────────────────────────────
  -- Fix 2: property predicate normalized both sides. Plate predicate
  -- pre-existing alphanumeric-normalized (safe).
  -- Determinism note: no ORDER BY (one-active-vehicle-per-plate-per-
  -- property assumption filed as docs/backlog/pm_plate_lookup-vehicles-
  -- branches-determinism.md; deliberately not expanded here).
  SELECT v.unit INTO v_vehicle_unit
  FROM vehicles v
  WHERE upper(regexp_replace(v.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
    AND v.is_active = TRUE
    AND lower(trim(v.property)) = ANY (v_properties_normalized)
  LIMIT 1;

  IF v_vehicle_unit IS NOT NULL THEN
    v_result_type := 'resident';
    v_unit_number := v_vehicle_unit;
  ELSE
    -- ── 2. Pending permit match (B230) ────────────────────────────
    -- Vehicle row exists at an assigned property but permit approval
    -- is still pending. Driver surface renders as "REGISTRATION
    -- PENDING — DO NOT TOW"; PM surface renders as "under review /
    -- being reviewed." Same underlying state, surface-appropriate copy.
    -- Fix 2: property predicate normalized. Determinism: same assumption
    -- as branch 1 (filed backlog).
    SELECT v.unit INTO v_vehicle_unit
    FROM vehicles v
    WHERE upper(regexp_replace(v.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
      AND v.is_active = FALSE
      AND v.status    = 'pending'
      AND lower(trim(v.property)) = ANY (v_properties_normalized)
    LIMIT 1;

    IF v_vehicle_unit IS NOT NULL THEN
      v_result_type := 'pending';
      v_unit_number := v_vehicle_unit;
    ELSE
      -- ── 3. Plate-change pending match (B230) ────────────────────
      -- vehicle_plate_changes row where the queried plate matches the
      -- SUBMITTED NEW plate + status='pending'. Existing resident is
      -- mid-request for a plate change; driver surface renders the
      -- old→new context banner; PM surface renders as "under review."
      -- Overlap tie-broken by most-recent submitted_at (matches
      -- driver's ORDER BY at driver/page.tsx:474). Fix 2 only.
      SELECT v.unit INTO v_vehicle_unit
      FROM vehicle_plate_changes vpc
      JOIN vehicles v ON v.id = vpc.vehicle_id
      WHERE upper(regexp_replace(vpc.new_plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
        AND vpc.status = 'pending'
        AND lower(trim(vpc.property)) = ANY (v_properties_normalized)
      ORDER BY vpc.submitted_at DESC
      LIMIT 1;

      IF v_vehicle_unit IS NOT NULL THEN
        v_result_type := 'plate_under_review';
        v_unit_number := v_vehicle_unit;
      ELSE
        -- ── 4. Guest authorization match (B220 stage 2.5) ────────
        -- Fix 2 only. Existing ORDER BY ga.end_date DESC preserved
        -- (already deterministic).
        SELECT
          ga.guest_name,
          ga.visiting_unit,
          ga.end_date
        INTO
          v_guest_name,
          v_guest_unit,
          v_guest_end
        FROM guest_authorizations ga
        WHERE upper(regexp_replace(ga.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
          AND ga.is_active = TRUE
          AND ga.status = 'active'
          AND ga.start_date <= CURRENT_DATE
          AND ga.end_date   >= CURRENT_DATE
          AND lower(trim(ga.property)) = ANY (v_properties_normalized)
        ORDER BY ga.end_date DESC
        LIMIT 1;

        IF v_guest_unit IS NOT NULL THEN
          v_result_type := 'guest_authorized';
          v_unit_number := v_guest_unit;
        ELSE
          -- ── 5. Visitor pass match ─────────────────────────────
          -- 🔴 Fix 1 (2026-07-20) — ADD ORDER BY vp.expires_at DESC
          -- so the freshest pass wins deterministically when 2+ match.
          -- Mirrors driver-side .order('expires_at', desc).limit(1)
          -- semantics from 57a9160. Driver + manager parity.
          --
          -- 🔴 Fix 2 (2026-07-20) — property predicate normalized both
          -- sides (was ILIKE ANY).
          SELECT vp.visiting_unit INTO v_visitor_unit
          FROM visitor_passes vp
          WHERE upper(regexp_replace(vp.plate, '[^A-Za-z0-9]', '', 'g')) = v_normalized
            AND vp.is_active = TRUE
            AND vp.expires_at > now()
            AND lower(trim(vp.property)) = ANY (v_properties_normalized)
          ORDER BY vp.expires_at DESC
          LIMIT 1;

          IF FOUND THEN
            v_result_type := 'visitor';
            v_unit_number := v_visitor_unit;
          ELSE
            -- ── 6. Unauthorized (unchanged — declined + expired ─────
            -- vehicles fall through here; enforcement-equivalent for
            -- now per Q3 lock 2026-07-08).
            v_result_type := 'unauthorized';
            v_unit_number := NULL;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  -- ── 7. Audit write (requires VOLATILE — unchanged) ───────────────
  INSERT INTO audit_logs (user_email, action, table_name, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'plate_lookup',
    'vehicles',
    jsonb_build_object(
      'normalized_plate',     v_normalized,
      'result_type',          v_result_type,
      'properties_searched',  to_jsonb(v_properties)
    ),
    now()
  );

  RETURN jsonb_build_object(
    'result_type',   v_result_type,
    'unit_number',   v_unit_number,
    'guest_name',    v_guest_name,
    'valid_through', v_guest_end
  );
END;
$func$;

-- pg_proc COUNT=1 assertion — defensive; catches accidental overload
-- proliferation before it becomes a runtime ambiguity.
DO $chk$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pm_plate_lookup';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'pm_plate_lookup has % overloads; expected 1', v_count;
  END IF;
END $chk$;

-- DROP wiped the ACL — re-emit REVOKE + GRANT per standing discipline
-- (feedback_function_public_grant_supabase_default +
-- feedback_revoke_from_anon_explicitly).
REVOKE ALL ON FUNCTION public.pm_plate_lookup(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pm_plate_lookup(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.pm_plate_lookup(TEXT) TO authenticated;


-- ══════════════════════════════════════════════════════════════════
-- SCHEMA_ audit
-- ══════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_PM_PLATE_LOOKUP_HARDENING',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260720_pm_plate_lookup_hardening',
    'fix_1',     $txt$Determinism on visitor_passes branch: added ORDER BY vp.expires_at DESC before LIMIT 1. When 2+ passes match the same (plate, property, active, non-expired), the freshest (longest-remaining-validity) wins deterministically. Mirrors driver-side .order('expires_at', desc).limit(1) from 57a9160. Other 4 branches either already sort (vpc.submitted_at DESC, ga.end_date DESC) or assume one-row-per (vehicles branches; assumption filed as docs/backlog/pm_plate_lookup-vehicles-branches-determinism.md).$txt$,
    'fix_2',     $txt$Property-match safety across all 5 branches: precompute v_properties_normalized TEXT[] once at top as ARRAY(SELECT lower(trim(p)) FROM unnest(v_properties) p), then swap all 5 predicates from <t>.property ILIKE ANY (v_properties) to lower(trim(<t>.property)) = ANY (v_properties_normalized). Closes whitespace-strict + wildcard-interpretation classes (last remaining instance of the pattern retired 2026-07-14 anon-RPC ILIKE close). Plate side pre-existing alphanumeric-normalized (safe, untouched).$txt$,
    'regression_profile', $txt$Pre-apply Jose ran 3 regression queries 2026-07-20: (Q1) user_roles.property elements containing % or _ → 0 rows, (Q2) visitor_passes.property with leading/trailing whitespace → 0 rows, (Q3) user_roles.property elements with leading/trailing whitespace → 0 rows. Clean regression profile — behavior delta is zero for currently-live data. Fix is purely forward-looking hardening.$txt$,
    'convention_codified', $txt$RPCs that filter by property (or similar user-supplied name-comparison arg from a caller-derived TEXT[] via helper) MUST normalize both sides with lower(trim()) exact-equality, never ILIKE-against-raw-column. This is the last surviving pm_plate_lookup instance of the pattern retired everywhere else in July 2026.$txt$
  ),
  now()
);

COMMIT;

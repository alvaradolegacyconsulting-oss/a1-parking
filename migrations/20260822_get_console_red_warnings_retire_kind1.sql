-- ══════════════════════════════════════════════════════════════════════
-- 20260822_get_console_red_warnings_retire_kind1.sql
--
-- 🔴 RETIRES kind #1 (portal_approved_enforcement_denied) from the
-- super-admin console red-warnings rollup. Kind #5 (enforcement_
-- authorized_portal_pending) preserved.
--
-- ── WHY (Mateo Aug 22) ──────────────────────────────────────────────
--
-- Kind #1's predicate — v.status='active' AND v.is_active=FALSE — was
-- built to detect a display divergence: the manager panel showed the
-- vehicle as "approved" while enforcement denied it. Post-alignment
-- arc, that divergence no longer exists in the display layer:
--
--   22c7da1 (Aug 20)  countVehicles gates on is_active
--   74e8934 (Aug 21)  vehicleDisplayStatus badge gates on is_active
--   residents-export  vehicleStatusLabel already gated (line 230)
--
-- Post-Aug-21 the row displays as "deactivated" everywhere (badge,
-- count, CSV export). Enforcement RPCs (check_resident_plate +
-- pm_plate_lookup) always gated on is_active. The predicate then
-- described a stale COLUMN value with no consumer:
--
--   - Jose could not act on it (no diagnosis needed; row is correct)
--   - CA could not act on it (resident moved out weeks ago)
--   - Manager could not act on it (system correctly unauthorized)
--
-- The Green Acres six (JGV3186 · PCX5830 · LYM8379 · MPH9101 ·
-- TJD8452 · WSN6747) all fell into this class after Amanda's move-
-- out sequence. Ages spread 4–24 days = ongoing accumulation with
-- tenant turnover. Under H.2 unchanged this floor grew with every
-- subscriber and taught the reader to skim past red — the same
-- failure mode as warnings that don't self-clear, arriving by a
-- third route. Retirement over narrowing (Option A) because the
-- schema-integrity framing didn't survive scrutiny: if the question
-- is worth asking at all, it's an occasional query, not a permanent
-- monitoring-board fixture.
--
-- 🔴 PREREQUISITE BEFORE APPLYING THIS MIGRATION
--
-- Jose or A1 must EYEBALL a badge post-74e8934 to confirm the fix
-- landed. The manager-panel warning is currently the ONLY signal we
-- have if the badge fix didn't propagate. Options:
--   - A1 reads unit 15, 95, 149, or 150 at Green Acres — badge should
--     read "Deactivated" on those vehicles now
--   - Or Jose checks Test Legacy probes (WARN01, PRBC30x) — same
--     shape, Jose has access
--
-- Once badge confirmed → apply this migration → the console will
-- render empty in production (correct resting state), Test Legacy
-- probes for kind #5 remain visible with the env filter toggled.
--
-- ── DO NOT RE-ADD ────────────────────────────────────────────────────
--
-- If you find yourself considering re-adding a predicate of the shape
-- (v.status='active' AND v.is_active=FALSE), STOP and re-read the
-- alignment history above. This is precisely the predicate whose
-- retirement was hard-won. Any legitimate new use case for a
-- schema-integrity check on this shape belongs in an ad-hoc query,
-- not a permanent monitoring surface.
--
-- APPLY: single database. Idempotent CREATE OR REPLACE — safe to run
-- multiple times. Verification: rerun 20260821_get_console_red_
-- warnings_verification.sql (G6 updated to assert kind #1 ABSENT +
-- kind #5 PRESENT + G8 execution gate still passes).
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.get_console_red_warnings(
  p_company_env TEXT DEFAULT 'production'
)
RETURNS TABLE (
  company_id          BIGINT,
  company_name        TEXT,
  company_env         TEXT,
  property            TEXT,
  unit                TEXT,
  plate               TEXT,
  kind                TEXT,
  vehicle_status      TEXT,
  vehicle_is_active   BOOLEAN,
  vehicle_id          BIGINT,
  vehicle_created_at  TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
#variable_conflict use_column
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(v_caller_email) = 0 THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  SELECT role INTO v_caller_role
    FROM public.user_roles
   WHERE lower(email) = lower(v_caller_email)
   LIMIT 1;
  IF v_caller_role IS NULL OR v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'forbidden_not_admin' USING ERRCODE = '42501',
      HINT = 'get_console_red_warnings is super-admin-only.';
  END IF;

  RETURN QUERY
  SELECT
    c.id                                                AS company_id,
    c.name                                              AS company_name,
    c.company_env::TEXT                                 AS company_env,
    v.property                                          AS property,
    v.unit                                              AS unit,
    v.plate                                             AS plate,
    -- MIRROR TypeScript property-warnings.ts:139 (kind #5 loop) EXACTLY.
    -- Was CASE with two branches; kind #1
    -- (portal_approved_enforcement_denied) retired 2026-08-22 —
    -- CASE reduced to a single branch. Left as CASE (not a bare
    -- literal) so any future re-addition of a new red kind slots
    -- into the same construct.
    CASE
      WHEN v.status = 'pending' AND v.is_active = TRUE  THEN 'enforcement_authorized_portal_pending'
    END                                                 AS kind,
    v.status                                            AS vehicle_status,
    v.is_active                                         AS vehicle_is_active,
    v.id                                                AS vehicle_id,
    v.created_at                                        AS vehicle_created_at
  FROM public.vehicles v
  LEFT JOIN public.properties p
         ON p.name ~~* v.property
  LEFT JOIN public.companies c
         ON lower(trim(c.name)) = lower(trim(p.company))
  WHERE
    -- Predicate reduced to kind #5 only (retirement of kind #1).
    -- Was: ((status='active' AND is_active=FALSE) OR (status='pending' AND is_active=TRUE))
    (v.status = 'pending' AND v.is_active = TRUE)
    AND (p_company_env IS NULL OR c.company_env::TEXT = p_company_env)
  ORDER BY c.name NULLS LAST, v.property, v.unit, v.plate;
END;
$func$;

COMMENT ON FUNCTION public.get_console_red_warnings(TEXT) IS
  'Super-admin console red-warnings rollup. Returns one row per vehicle matching the surviving red predicate: enforcement_authorized_portal_pending (status=pending AND is_active=true) — vehicle scanning as authorized while portal shows pending, permissive tow risk. Kind #1 (portal_approved_enforcement_denied) RETIRED 2026-08-22 — its divergence was closed by count fix (22c7da1) + badge fix (74e8934); predicate had no consumer post-alignment. DELIBERATE mirror of app/lib/property-warnings.ts kind #5; do not tune predicates here (change TypeScript first, mirror in same commit). Provisional — call into full extraction or delete when property-warnings extraction lands. Filter: p_company_env TEXT DEFAULT ''production''; NULL returns all envs incl. unresolved. Read-only. Admin-gated. See migration 20260822_get_console_red_warnings_retire_kind1.sql for retirement rationale.';

-- Grants already in place from 20260821_get_console_red_warnings.sql
-- (authenticated EXECUTE; anon + service_role REVOKED). CREATE OR
-- REPLACE preserves existing grants, so re-issuing them here is a
-- no-op — but explicit is safer against a future admin who might
-- drop-and-recreate rather than replace.
REVOKE ALL     ON FUNCTION public.get_console_red_warnings(TEXT) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.get_console_red_warnings(TEXT) FROM anon;
REVOKE ALL     ON FUNCTION public.get_console_red_warnings(TEXT) FROM service_role;
GRANT  EXECUTE ON FUNCTION public.get_console_red_warnings(TEXT) TO   authenticated;

-- Schema audit row for the retirement — distinct action from the
-- original CREATE + the enum-cast fix.
INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_GET_CONSOLE_RED_WARNINGS_RETIRE_KIND1',
  'public.get_console_red_warnings(TEXT)',
  '20260822_get_console_red_warnings_retire_kind1',
  jsonb_build_object(
    'migration', '20260822_get_console_red_warnings_retire_kind1',
    'retired',   'portal_approved_enforcement_denied',
    'preserved', 'enforcement_authorized_portal_pending',
    'why',       'divergence closed by count fix 22c7da1 + badge fix 74e8934; predicate had no consumer post-alignment (Green Acres 6-row baseline nobody could act on)',
    'do_not_re_add', 'the predicate v.status=active AND v.is_active=FALSE is the retired shape — see migration header for the alignment history',
    'idempotent', TRUE
  )
);

COMMIT;

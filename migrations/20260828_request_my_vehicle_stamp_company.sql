-- ══════════════════════════════════════════════════════════════════════
-- 20260828_request_my_vehicle_stamp_company.sql
--
-- 🟢 vehicles.company arc — COMMIT 2 (DB migration 2 of 2)
--
-- Extends public.request_my_vehicle to stamp v.company on INSERT.
-- Reads residents.company alongside residents.property/unit in the
-- same SELECT the RPC already runs — no new name-keyed lookup.
--
-- ── SHAPE — CREATE OR REPLACE (body-only change) ────────────────────
--
-- Same 6-parameter signature (p_plate, p_state, p_make, p_model,
-- p_year, p_color). No parameter DEFAULTs to preserve (all required).
-- Same RETURNS BIGINT. Same LANGUAGE plpgsql, SECURITY DEFINER,
-- search_path. This is a body-only change; CREATE OR REPLACE is
-- appropriate (unlike get_residents_row_by_precedence's return-type
-- change which required DROP + CREATE).
--
-- CREATE OR REPLACE preserves grants (they attach to the function
-- oid). No COMMENT ON FUNCTION was ever set on the June 17 install,
-- so nothing to re-issue.
--
-- ── BODY DELTA ──────────────────────────────────────────────────────
--
--   1. DECLARE gains v_company TEXT
--   2. SELECT at :251 gains company column: was
--        SELECT property, unit INTO v_property, v_unit ...
--      now
--        SELECT property, unit, company INTO v_property, v_unit, v_company ...
--   3. INSERT column list at :267 gains company; VALUES gains v_company
--
-- Everything else is preserved verbatim from
-- 20260617_deactivation_model.sql:209-282 including:
--   - get_my_effective_active() guard (THE deactivation gate)
--   - resident role gate (v_role must be 'resident')
--   - plate normalization (upper + alphanumeric strip)
--   - property/unit NULL guard
--   - INSERT with is_active=FALSE + status='pending' (matches
--     existing manager-approval workflow)
--
-- ── COMPANY VALUE PROVENANCE ────────────────────────────────────────
--
-- The company comes from residents.company on the SAME residents row
-- the RPC resolves for property + unit — one SELECT, no drift. This
-- is the writer-populated shape (a) chosen at §1.3 report: five
-- production writers, all have company in scope or on the row they
-- already resolve. No trigger, no name-keyed lookup at INSERT time.
--
-- Post-Commit-3-backfill + Commit-4-SET-NOT-NULL: v_company must be
-- non-NULL for the INSERT to succeed. Residents rows without a
-- company populated would break this path — but residents.company is
-- already a live column with historical values (Aug 28 P1 read
-- confirmed populated on all A1 rows). Post-backfill discipline
-- should keep it that way.
--
-- ── PostgREST CACHE ─────────────────────────────────────────────────
--
-- Body-only change — return shape doesn't change (still BIGINT).
-- PostgREST caches function SIGNATURES; body changes don't require a
-- cache reload. NOTIFY pgrst issued anyway (belt-and-braces + no cost).
-- No separate REST-side gate script needed for this migration
-- (unlike DB migration 1 of 2 where return shape did change).
--
-- APPLY: single database. Wrapped in BEGIN/COMMIT for atomicity.
-- Verification: 20260828_request_my_vehicle_stamp_company_verification.sql
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.request_my_vehicle(
  p_plate TEXT,
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
  v_email            TEXT;
  v_role             TEXT;
  v_property         TEXT;
  v_unit             TEXT;
  v_company          TEXT;   -- 🟢 vehicles.company arc Commit 2 addition
  v_normalized_plate TEXT;
  v_vehicle_id       BIGINT;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- Effective-active check (THE deactivation guard — covers chain
  -- through user_roles.is_active, companies.account_state,
  -- residents.is_active, and the resident's property's is_active).
  -- Preserved verbatim from 2026-06-17 install.
  IF NOT public.get_my_effective_active() THEN
    RAISE EXCEPTION 'account_deactivated'
      USING HINT = 'Your access has been deactivated. Contact your property manager.';
  END IF;

  -- Caller-is-resident gate. Preserved verbatim.
  SELECT role INTO v_role
    FROM public.user_roles
    WHERE lower(email) = lower(v_email)
    LIMIT 1;
  IF v_role IS DISTINCT FROM 'resident' THEN
    RAISE EXCEPTION 'caller is not a resident'
      USING HINT = 'This RPC is for resident-self vehicle requests only.';
  END IF;

  -- Resolve property + unit + company from residents row.
  -- 🟢 2026-08-28 vehicles.company arc — extended SELECT to include
  -- company. Same row, one SELECT, no name-keyed lookup at INSERT
  -- time. Provenance: residents.company on the SAME row that resolves
  -- property + unit.
  SELECT property, unit, company INTO v_property, v_unit, v_company
    FROM public.residents
    WHERE lower(email) = lower(v_email)
    LIMIT 1;
  IF v_property IS NULL OR v_unit IS NULL THEN
    RAISE EXCEPTION 'no residents row for caller';
  END IF;
  -- Note: v_company NULL check is NOT here. Commit 4 SET NOT NULL
  -- would make an INSERT with v_company=NULL fail loudly at that
  -- constraint, which is the correct place for the check (mechanism
  -- at the constraint boundary, not a duplicate RAISE here).

  -- Normalize plate (same shape as create_visitor_pass + manager
  -- portal: uppercase, alphanumeric only). Preserved verbatim.
  v_normalized_plate := upper(regexp_replace(COALESCE(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));
  IF length(v_normalized_plate) = 0 THEN
    RAISE EXCEPTION 'plate required'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 🟢 INSERT column list + VALUES extended for company.
  INSERT INTO public.vehicles (
    plate, state, make, model, year, color,
    unit, property, resident_email,
    company,
    is_active, status
  ) VALUES (
    v_normalized_plate,
    p_state, p_make, p_model, p_year, p_color,
    v_unit, v_property, lower(v_email),
    v_company,
    FALSE,           -- pending manager approval (matches existing workflow)
    'pending'
  )
  RETURNING id INTO v_vehicle_id;

  RETURN v_vehicle_id;
END;
$function$;

-- Grants preserved by CREATE OR REPLACE (attach to function OID);
-- no re-issue needed. From 20260617_deactivation_model.sql:284-286:
--   REVOKE EXECUTE FROM PUBLIC, anon; GRANT EXECUTE TO authenticated.

-- ── PostgREST schema-cache reload ───────────────────────────────────
-- Body-only change; signature unchanged. Reload is belt-and-braces
-- (Supabase auto-issues on DDL anyway).
NOTIFY pgrst, 'reload schema';

-- ── Schema audit row ────────────────────────────────────────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_REQUEST_MY_VEHICLE_STAMP_COMPANY',
  'public.request_my_vehicle(TEXT,TEXT,TEXT,TEXT,INTEGER,TEXT)',
  'request_my_vehicle',
  jsonb_build_object(
    'migration', '20260828_request_my_vehicle_stamp_company',
    'arc',       'vehicles.company Commit 2 (DB migration 2 of 2)',
    'change',    'body-only: SELECT residents (property, unit, company); INSERT vehicles (…, company, …)',
    'shape',     'CREATE OR REPLACE (no return-type change, no signature change)',
    'preserved', jsonb_build_array(
      '6-param signature (p_plate, p_state, p_make, p_model, p_year, p_color)',
      'RETURNS BIGINT',
      'LANGUAGE plpgsql',
      'SECURITY DEFINER',
      'SET search_path TO public, pg_temp',
      'get_my_effective_active() deactivation guard',
      'resident-role gate',
      'plate normalization',
      'is_active=FALSE + status=pending (manager-approval workflow)',
      'grants: REVOKE PUBLIC + anon; GRANT authenticated (preserved by CREATE OR REPLACE)'
    ),
    'next_step', 'Verify via 20260828_request_my_vehicle_stamp_company_verification.sql (7 gates including execution) before any Commit 2 consumer push'
  )
);

COMMIT;

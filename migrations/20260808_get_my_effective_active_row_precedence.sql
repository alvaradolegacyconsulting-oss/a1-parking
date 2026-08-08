-- ══════════════════════════════════════════════════════════════════════
-- 20260808_get_my_effective_active_row_precedence.sql
-- 🔴 LIVE LOCKOUT FIX. A Green Acres resident with two residents rows
-- (one active, one declined) is locked out of the portal RIGHT NOW.
-- get_my_effective_active picks whichever row Postgres returns and
-- can land on the declined one → returns FALSE → portal locked.
--
-- Fix: ORDER BY canonical row precedence, both selects in the
-- function body.
-- ══════════════════════════════════════════════════════════════════════
--
-- ── SHIP ALONE (Mateo Aug 8) ─────────────────────────────────────────
--
-- Not bundled with the companion-vehicle proxy fix (also has the same
-- bug at route.ts:209-213 via .maybeSingle()). Live lockout has
-- priority; the proxy fix is #2 and ships behind this using the SAME
-- precedence helper introduced here.
--
-- Signature stable: get_my_effective_active(TEXT DEFAULT NULL) RETURNS
-- BOOLEAN, SECURITY DEFINER, SET search_path = public, pg_temp. CREATE
-- OR REPLACE preserves grants. Body BYTE-IDENTICAL to 20260617's
-- version EXCEPT the two SELECT ... LIMIT 1 blocks at lines 155-159
-- (v_resident_active) and 163-168 (scope_property derivation) — both
-- gain ORDER BY resident_row_precedence(...) DESC + created_at DESC.
--
-- ── THE PRECEDENCE HELPER — SHARED, IMMUTABLE ────────────────────────
--
-- resident_row_precedence is IMMUTABLE (pure function of arguments,
-- no now(), no jwt, no state) and installed as a shared helper so
-- both this function AND the pending companion-vehicle proxy fix (#2)
-- use the SAME definition. Two implementations of "the resident's
-- best row" is the same class of bug as countVehicles vs enforcement.
-- If a third caller emerges, route THROUGH THIS HELPER — do NOT
-- re-express the CASE inline (Aug 8 lock).
--
-- The canonical precedence:
--   1. status='active' AND is_active=TRUE — the healthy active row
--   2. status='pending'                    — awaiting approval
--   3. status='declined'                   — explicit denial
--   4. else (covers is_active=FALSE)       — deactivated
--
-- Ties broken by created_at DESC (newest wins) — a resident who was
-- deactivated Jul 31 and re-registered Aug 2 should have the Aug 2
-- row picked when both are active.
--
-- ── DO NOT ────────────────────────────────────────────────────────────
--
-- - DO NOT drop the ORDER BY thinking "LIMIT 1 is fine, Postgres is
--   deterministic." It isn't — the row returned is
--   implementation-defined without an ORDER BY, and this bug is the
--   proof.
-- - DO NOT re-express the CASE inline in a future caller. Route
--   through resident_row_precedence().
-- - DO NOT change the precedence without updating the helper's
--   COMMENT ON — the comment IS the spec.
--
-- ── DEPENDENCIES ──────────────────────────────────────────────────────
--
-- 20260617_deactivation_model.sql — original get_my_effective_active
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — resident_row_precedence helper ─────────────────────────
CREATE OR REPLACE FUNCTION public.resident_row_precedence(
  p_status    TEXT,
  p_is_active BOOLEAN
) RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_status = 'active'   AND p_is_active = TRUE THEN 1
    WHEN p_status = 'pending'                          THEN 2
    WHEN p_status = 'declined'                         THEN 3
    ELSE                                                    4
  END;
$$;

REVOKE ALL     ON FUNCTION public.resident_row_precedence(TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.resident_row_precedence(TEXT, BOOLEAN) FROM anon;
GRANT  EXECUTE ON FUNCTION public.resident_row_precedence(TEXT, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION public.resident_row_precedence IS
  'Canonical precedence for picking a resident''s "best" row when multiple residents rows exist for one lowered email at one property. Ranking: 1=active+is_active=TRUE, 2=pending, 3=declined, 4=deactivated (is_active=FALSE). Used by get_my_effective_active (this migration) and the companion-vehicle proxy (pending #2 in the Aug 8 arc). If a third caller emerges, ROUTE THROUGH THIS FUNCTION — do NOT re-express the CASE inline. Two implementations of resident-best-row is the same class of bug as countVehicles vs enforcement (see docs/backlog/vehicles-status-is_active-divergence.md). Ties broken by ORDER BY created_at DESC at the call site (helper does not encode tiebreaker — it is not part of the precedence).';


-- ── PART 2 — get_my_effective_active with ORDER BY precedence ───────
-- Body BYTE-IDENTICAL to 20260617_deactivation_model.sql:106-192
-- EXCEPT the two SELECT ... LIMIT 1 blocks at lines 155-159 and
-- 163-168 — both gain ORDER BY resident_row_precedence(...) +
-- created_at DESC.
CREATE OR REPLACE FUNCTION public.get_my_effective_active(scope_property TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_email           TEXT;
  v_role            TEXT;
  v_company         TEXT;
  v_properties      TEXT[];
  v_user_active     BOOLEAN;
  v_company_state   TEXT;
  v_property_active BOOLEAN;
  v_resident_active BOOLEAN;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- 1. Caller's user_roles row.
  SELECT role, company, property, is_active
    INTO v_role, v_company, v_properties, v_user_active
    FROM public.user_roles
    WHERE lower(email) = lower(v_email)
    LIMIT 1;

  IF v_role IS NULL THEN
    RETURN FALSE;
  END IF;

  -- 2. Caller's own is_active.
  IF v_user_active IS DISTINCT FROM TRUE THEN
    RETURN FALSE;
  END IF;

  -- 3. Admin short-circuit.
  IF v_role = 'admin' THEN
    RETURN TRUE;
  END IF;

  -- 4. Company account_state.
  SELECT account_state INTO v_company_state
    FROM public.companies
    WHERE lower(name) = lower(v_company)
    LIMIT 1;
  IF v_company_state NOT IN ('active', 'past_due') THEN
    RETURN FALSE;
  END IF;

  -- 5. Resident: check residents.is_active + derive scope_property.
  -- 🔴 ORDER BY resident_row_precedence(status, is_active), created_at DESC —
  --    picks the resident's "best" row when multiple exist for one
  --    lowered email (Aug 8 lock — see resident_row_precedence COMMENT
  --    ON for the canonical ranking). Fixes the 20260617 LIMIT-1-with-
  --    no-ORDER-BY lockout where Postgres returned the declined row
  --    for a resident who ALSO had an active row.
  IF v_role = 'resident' THEN
    SELECT is_active INTO v_resident_active
      FROM public.residents
      WHERE lower(email) = lower(v_email)
      ORDER BY public.resident_row_precedence(status, is_active), created_at DESC
      LIMIT 1;
    IF v_resident_active IS DISTINCT FROM TRUE THEN
      RETURN FALSE;
    END IF;
    IF scope_property IS NULL THEN
      -- Same precedence for scope_property derivation — otherwise
      -- resident could pass the is_active gate on one row and get
      -- routed to a different property from another row.
      SELECT property INTO scope_property
        FROM public.residents
        WHERE lower(email) = lower(v_email)
        ORDER BY public.resident_row_precedence(status, is_active), created_at DESC
        LIMIT 1;
    END IF;
  END IF;

  -- 6. Per-property scope check.
  IF scope_property IS NOT NULL THEN
    -- 6a. PM/leasing_agent assignment.
    IF v_role IN ('manager', 'leasing_agent') THEN
      IF NOT (scope_property = ANY(v_properties)) THEN
        RETURN FALSE;
      END IF;
    END IF;
    -- 6b. Property is_active.
    SELECT is_active INTO v_property_active
      FROM public.properties
      WHERE lower(name) = lower(scope_property)
        AND lower(company) = lower(v_company)
      LIMIT 1;
    IF v_property_active IS DISTINCT FROM TRUE THEN
      RETURN FALSE;
    END IF;
  END IF;

  RETURN TRUE;
END;
$function$;

-- Grants preserved by CREATE OR REPLACE. Re-issue defensively (belt
-- for future audits — matches original 20260617 shape).
REVOKE EXECUTE ON FUNCTION public.get_my_effective_active(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_effective_active(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_my_effective_active(TEXT) TO authenticated;


-- ── PART 3 — SCHEMA_ audit ──────────────────────────────────────────
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
SELECT
  'system_migration_v1',
  'SCHEMA_GET_MY_EFFECTIVE_ACTIVE_ROW_PRECEDENCE',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260808_get_my_effective_active_row_precedence',
    'purpose',   '🔴 LIVE LOCKOUT FIX. get_my_effective_active picked arbitrary residents row via LIMIT 1 with no ORDER BY; a Green Acres resident with (active + declined) rows was locked out when Postgres returned the declined one. Both SELECT ... LIMIT 1 blocks now ORDER BY resident_row_precedence(status, is_active), created_at DESC.',
    'helper_added', 'public.resident_row_precedence(TEXT, BOOLEAN) — canonical precedence for resident-row selection; shared with companion-vehicle proxy fix (#2 pending)',
    'callers_affected', jsonb_build_object(
      'get_my_effective_active', 'this migration',
      'app/lib/portal-account-gate.ts', 'evaluatePortalGate; called at each portal mount'
    ),
    'signature', 'unchanged (CREATE OR REPLACE preserves grants)',
    'follow_ups', jsonb_build_object(
      'proxy_fix',        'companion-vehicle route.ts:209-213 replace .maybeSingle() with ORDER BY resident_row_precedence(...) + LIMIT 1',
      'banner_conditional', 'registration tow-risk banner conditional on genuine insert failure — rides #2',
      'register_dedup',   '/register step 4 stops creating duplicate residents rows on attach (own design pass)'
    )
  ),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_logs
   WHERE action = 'SCHEMA_GET_MY_EFFECTIVE_ACTIVE_ROW_PRECEDENCE'
     AND new_values->>'migration' = '20260808_get_my_effective_active_row_precedence'
);

COMMIT;

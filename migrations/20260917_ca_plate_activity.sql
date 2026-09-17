-- ══════════════════════════════════════════════════════════════════════
-- 20260917_ca_plate_activity.sql
--
-- CA plate activity — one property, one plate, a 30-day window.
-- RPC + two plate indexes.
--
-- ── WHY A NEW RPC RATHER THAN WIDENING pm_plate_lookup ──────────────
-- pm_plate_lookup gates on get_my_role() IN ('manager','leasing_agent')
-- and scopes through get_my_properties(), which returns a MANAGER's
-- assigned properties. A company_admin has none — so widening the role
-- list alone hands a CA an empty result, and fixing the scoping means
-- editing the function every manager's plate lookup depends on. It also
-- answers a different question: current authorization status, one row,
-- live passes only. This wants history including expired.
--
-- ── 🔴 CA-ONLY, SERVER-SIDE ─────────────────────────────────────────
-- A UI that does not render a button is not a control. The role check
-- is here.
--
-- ⚠ `admin` is DELIBERATELY NOT included, unlike most sibling RPCs
-- which carry a super-admin bypass. The ask was CA-only and being
-- literal costs one line to reverse. If platform support needs it, add
-- 'admin' to the IN list and extend E2.
--
-- ── 🔴 NORMALIZE BOTH SIDES ─────────────────────────────────────────
-- Neither visitor_passes nor violations has a normalizing trigger —
-- both rely on callers. Measured 2026-09-17: 1000 pass rows and 95
-- violation rows, zero non-normalized, zero cross-table drift. That is
-- a property of today's write paths, not a guarantee, and the failure
-- it would produce is the one to design against: a SILENT PARTIAL
-- ANSWER. A plate that matches in one table and misses in the other
-- gives a CA a history that looks complete and isn't, with nothing on
-- screen to say so. Normalizing both sides costs nothing and makes that
-- impossible rather than unlikely.
--
-- ── 🔴 THE INDEXES ARE SHAPED TO SERVE THE HOT PATH TOO ─────────────
-- enforce_visitor_pass_limit() runs a normalized scan of visitor_passes
-- on EVERY pass issued — the busiest write in the product — and there
-- is no plate index on either table today.
--
-- Its predicate is
--   WHERE property = NEW.property
--     AND UPPER(regexp_replace(plate, '[^A-Z0-9]', '', 'gi')) = …
--     AND created_at > now() - interval '30 days'
-- RAW property equality, and that exact regex spelling. So this RPC
-- resolves the property to its CANONICAL stored name first and then
-- uses raw equality and the IDENTICAL expression — not because the RPC
-- needs it, but so ONE index serves both. An index built to a prettier
-- spelling (lower(trim(property)), [^A-Za-z0-9]) would serve this RPC
-- and leave the hot path scanning.
--
-- 🔴 DO NOT "TIDY" THE EXPRESSIONS BELOW. They are copied from
-- 20260729_visitor_pass_rolling_30_semantics.sql:95-98 character for
-- character. Changing either side silently un-indexes the trigger.
--
-- ⚠ SO THIS CODE LOOKS WRONG ON PURPOSE. The natural spellings here
-- would be lower(trim(property)) and [^A-Za-z0-9] — that is what every
-- other property/plate comparison in this codebase uses, and it is what
-- a reader will reach for. They are DELIBERATELY not used. Writing it
-- the natural way costs nothing visible: the queries return identical
-- rows, every gate stays green, and the only casualty is that
-- enforce_visitor_pass_limit goes back to scanning visitor_passes on
-- every pass issued — the busiest write in the product — with nothing
-- anywhere to say it happened. VS3 in the paired verification exists
-- for exactly that reason.
--
-- ── BOUNDARY — DATA MINIMISATION ON THE VIOLATION PROJECTION ────────
-- violations carries tow_fee, tow_mileage_fee, tow_storage_name/address/
-- phone, driver_name, driver_license, vehicle_vin, photos. NONE of it is
-- returned. This answers "did this plate get cited here, when, and for
-- what" — it is not a tow-cost view, not an evidence view, and not a
-- roster of which officer wrote it.
-- (feedback_tow_log_is_a_log_not_enforcement, B225 minimisation.)
--
-- ── APPLY DISCIPLINE (CRITICAL) ─────────────────────────────────────
-- Paste the ENTIRE BEGIN/COMMIT block as ONE block, click Run ONCE.
-- Paired file: 20260917_ca_plate_activity_verification.sql
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- PART 1 — Indexes. Expressions verbatim from the enforcement trigger.
-- ══════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS visitor_passes_property_plate_norm
  ON public.visitor_passes (property, UPPER(regexp_replace(plate, '[^A-Z0-9]', '', 'gi')));

CREATE INDEX IF NOT EXISTS violations_property_plate_norm
  ON public.violations (property, UPPER(regexp_replace(plate, '[^A-Z0-9]', '', 'gi')));


-- ══════════════════════════════════════════════════════════════════════
-- PART 2 — ca_plate_activity
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.ca_plate_activity(
  p_property TEXT,
  p_plate    TEXT,
  p_days     INT DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email      TEXT;
  v_role       TEXT;
  v_company    TEXT;
  v_canonical  TEXT;
  v_plate_norm TEXT;
  v_days       INT;
  v_since      TIMESTAMPTZ;
  v_passes     jsonb;
  v_violations jsonb;
BEGIN
  v_email := auth.jwt() ->> 'email';
  IF v_email IS NULL OR length(trim(v_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- 🔴 CA-ONLY. See the header on why 'admin' is absent.
  v_role := get_my_role();
  IF v_role IS DISTINCT FROM 'company_admin' THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  v_company := get_my_company();
  IF v_company IS NULL OR length(trim(v_company)) = 0 THEN
    RETURN jsonb_build_object('error', 'no_company_context');
  END IF;

  IF p_property IS NULL OR length(trim(p_property)) = 0 THEN
    RETURN jsonb_build_object('error', 'property_required');
  END IF;

  v_plate_norm := UPPER(regexp_replace(coalesce(p_plate, ''), '[^A-Z0-9]', '', 'gi'));
  IF length(v_plate_norm) = 0 THEN
    RETURN jsonb_build_object('error', 'plate_required');
  END IF;

  -- Window clamped rather than trusted. A caller passing 100000 turns a
  -- 30-day lookup into a full scan of both tables.
  v_days  := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_since := now() - make_interval(days => v_days);

  -- ── 🔴 COMPANY SCOPE. The property must belong to the CALLER's
  -- company, and this also resolves its CANONICAL stored name so the
  -- queries below can use raw equality and hit the index.
  SELECT p.name INTO v_canonical
    FROM public.properties p
   WHERE lower(trim(p.name))    = lower(trim(p_property))
     AND lower(trim(p.company)) = lower(trim(v_company))
   LIMIT 1;

  IF v_canonical IS NULL THEN
    -- Same answer for "does not exist" and "belongs to another company".
    -- Distinguishing them would let a CA probe for property names across
    -- tenants one guess at a time.
    RETURN jsonb_build_object('error', 'property_not_found');
  END IF;

  -- ── Passes ────────────────────────────────────────────────────────
  -- 🔴 Liveness is BOTH predicates — is_active AND expires_at > now().
  -- is_active alone reports an expired pass as live.
  -- (feedback_visitor_pass_liveness_both_predicates)
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'issued_at' DESC), '[]'::jsonb)
    INTO v_passes
    FROM (
      SELECT jsonb_build_object(
               'id',             vp.id,
               'issued_at',      vp.created_at,
               'duration_hours', vp.duration_hours,
               'expires_at',     vp.expires_at,
               'is_live',        (vp.is_active = TRUE AND vp.expires_at > now()),
               'visiting_unit',  vp.visiting_unit
             ) AS x
        FROM public.visitor_passes vp
       WHERE vp.property = v_canonical
         AND UPPER(regexp_replace(vp.plate, '[^A-Z0-9]', '', 'gi')) = v_plate_norm
         AND vp.created_at > v_since
    ) s;

  -- ── Violations ────────────────────────────────────────────────────
  -- Minimal projection — see the BOUNDARY note in the header.
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'issued_at' DESC), '[]'::jsonb)
    INTO v_violations
    FROM (
      SELECT jsonb_build_object(
               'id',        v.id,
               'issued_at', v.created_at,
               'reason',    v.violation_type,
               'status',    v.status,
               'voided_at', v.voided_at
             ) AS x
        FROM public.violations v
       WHERE v.property = v_canonical
         AND UPPER(regexp_replace(v.plate, '[^A-Z0-9]', '', 'gi')) = v_plate_norm
         AND v.created_at > v_since
    ) s;

  RETURN jsonb_build_object(
    'ok',          true,
    'property',    v_canonical,
    'plate',       v_plate_norm,
    'window_days', v_days,
    'passes',      v_passes,
    'violations',  v_violations,
    -- Counts returned explicitly so a caller never has to infer "none"
    -- from an empty array it might have failed to read.
    'pass_count',      jsonb_array_length(v_passes),
    'violation_count', jsonb_array_length(v_violations)
  );
END
$func$;

-- feedback_function_public_grant_supabase_default: SECURITY DEFINER
-- inherits EXECUTE to PUBLIC on creation. Revoke explicitly, including
-- anon (feedback_revoke_from_anon_explicitly).
REVOKE EXECUTE ON FUNCTION public.ca_plate_activity(TEXT, TEXT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ca_plate_activity(TEXT, TEXT, INT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.ca_plate_activity(TEXT, TEXT, INT) TO authenticated;

COMMENT ON FUNCTION public.ca_plate_activity(TEXT, TEXT, INT) IS
  'CA-only plate activity for ONE property the caller''s company owns, over a clamped day window. Returns visitor passes (issued_at, duration, expires_at, is_live, visiting_unit) and violations (issued_at, reason, status, voided_at). Deliberately EXCLUDES tow fees, storage details, officer identity and VIN — this answers "was this plate here and was it cited", not "what did the tow cost". Role gate is company_admin only; `admin` is intentionally absent. Plate is normalized on both sides with the SAME expression as enforce_visitor_pass_limit so visitor_passes_property_plate_norm serves both.';

INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_CA_PLATE_ACTIVITY',
  'public.visitor_passes,public.violations',
  'ca_plate_activity',
  jsonb_build_object(
    'migration', '20260917_ca_plate_activity',
    'arc',       'CA plate activity — one property, one plate, 30-day window',
    'rpc',       'ca_plate_activity(TEXT, TEXT, INT) — company_admin only, company-scoped server-side',
    'indexes',   jsonb_build_array('visitor_passes_property_plate_norm', 'violations_property_plate_norm'),
    'index_shape_rationale', 'Expressions copied VERBATIM from enforce_visitor_pass_limit (raw property equality + UPPER(regexp_replace(plate, ''[^A-Z0-9]'', '''', ''gi''))) so ONE index serves both this RPC and the trigger that scans visitor_passes on every pass issued. A prettier spelling would serve the RPC and leave the hot path scanning.',
    'why_not_pm_plate_lookup', 'It gates on manager/leasing_agent and scopes via get_my_properties(), which is empty for a CA — widening the role alone returns nothing, and fixing the scoping edits a function every manager depends on. It also returns current status, one row, live passes only; this wants history including expired.',
    'admin_excluded', 'Deliberate. The ask was CA-only. One line to add if platform support needs it.',
    'minimisation', 'Violation projection excludes tow_fee, tow_mileage_fee, tow_storage_*, driver_name, driver_license, vehicle_vin and photos.',
    'not_included', 'Self-registered vs invited pass origin — descoped 2026-09-17. visitor_passes has NO origin column and it cannot be backfilled, so it would have been a schema change plus a write-path change at every issuing surface.'
  ),
  now()
);

COMMIT;

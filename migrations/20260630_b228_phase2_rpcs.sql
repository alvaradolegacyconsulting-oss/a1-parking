-- ════════════════════════════════════════════════════════════════════
-- B228 Phase 2 — DEFINER RPCs (extended aggregates + spikes + PM drill + flag ack)
-- 2026-06-30
-- ════════════════════════════════════════════════════════════════════
--
-- Four functions, all SECURITY DEFINER + super-admin role gate:
--
--   1. get_console_aggregates (REPLACEMENT) — extends Phase 1 fn to
--      include plate_reads_24h + plate_reads_30d real data + currently-
--      active spike flag counts. Same single round-trip.
--
--   2. get_console_pm_property_permits(p_company_id) — per-property
--      approved-permit counts for PM-track subscribers (CRM drawer drill).
--      Returns nothing for non-PM tier_type (caller should skip the
--      section for enforcement subscribers).
--
--   3. get_console_spike_flags — returns per-company per-metric flags
--      (last 24h vs 7d baseline). Includes ack state (dismissed if
--      flag_acknowledgments row exists + dismiss_until > now).
--
--   4. acknowledge_console_flag(p_company_id, p_flag_type, p_dismiss_until, p_note)
--      — super-admin dismisses a flag. Upserts the row.
--
-- VERIFICATION
--   See _verification.sql:
--     §1 fn shapes + DEFINER + search_path
--     §2 grants (authenticated=X only on each)
--     §3 no overload trap
--     §4 audit row landed
--     §5 app-level smoke prompts
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. get_console_aggregates — EXTENDED replacement
-- ─────────────────────────────────────────────────────────────────
-- Phase 2 widens the RETURNS TABLE shape (adds plate_reads_24h /
-- plate_reads_30d / active_flags). PG 42P13: CREATE OR REPLACE can't
-- change return-type shape — must DROP first.
--
-- IDEMPOTENT: IF EXISTS so the fix migration is re-runnable.
-- LOAD-BEARING: DROP wipes the ACL; the REVOKE/GRANT block below the
-- CREATE re-applies the discipline. Without this, Supabase's default
-- grants (which include service_role) come back — the exact leak fixed
-- in the Phase 1 hotfix. The §4 verification re-confirms post-apply.
DROP FUNCTION IF EXISTS public.get_console_aggregates();

CREATE OR REPLACE FUNCTION public.get_console_aggregates()
RETURNS TABLE (
  company_id        BIGINT,
  company_name      TEXT,
  company_tier      TEXT,
  company_tier_type TEXT,
  account_state     TEXT,
  is_active         BOOLEAN,
  properties_count  BIGINT,
  vehicles_active   BIGINT,
  vehicles_pending  BIGINT,
  violations_30d    BIGINT,
  passes_30d        BIGINT,
  plate_reads_24h   BIGINT,
  plate_reads_30d   BIGINT,
  active_flags      BIGINT
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
      HINT = 'get_console_aggregates is super-admin-only.';
  END IF;

  RETURN QUERY
  SELECT
    c.id                                              AS company_id,
    c.name                                            AS company_name,
    c.tier                                            AS company_tier,
    c.tier_type                                       AS company_tier_type,
    c.account_state                                   AS account_state,
    c.is_active                                       AS is_active,
    COALESCE(p_agg.properties_count, 0)               AS properties_count,
    COALESCE(v_agg.vehicles_active,  0)               AS vehicles_active,
    COALESCE(v_agg.vehicles_pending, 0)               AS vehicles_pending,
    COALESCE(vio_agg.violations_30d, 0)               AS violations_30d,
    COALESCE(pass_agg.passes_30d,    0)               AS passes_30d,
    COALESCE(scan_agg.plate_reads_24h, 0)             AS plate_reads_24h,
    COALESCE(scan_agg.plate_reads_30d, 0)             AS plate_reads_30d,
    0::BIGINT                                         AS active_flags
  FROM public.companies c
  LEFT JOIN (
    SELECT p.company, COUNT(*) AS properties_count
    FROM public.properties p
    WHERE p.is_active = TRUE
    GROUP BY p.company
  ) p_agg ON p_agg.company ~~* c.name
  LEFT JOIN (
    SELECT p.company,
           COUNT(*) FILTER (WHERE v.is_active = TRUE  AND v.status = 'active')  AS vehicles_active,
           COUNT(*) FILTER (WHERE v.status = 'pending')                          AS vehicles_pending
    FROM public.vehicles v
    JOIN public.properties p ON p.name ~~* v.property
    GROUP BY p.company
  ) v_agg ON v_agg.company ~~* c.name
  LEFT JOIN (
    SELECT p.company, COUNT(*) AS violations_30d
    FROM public.violations vi
    JOIN public.properties p ON p.name ~~* vi.property
    WHERE vi.created_at >= now() - interval '30 days'
      AND vi.voided_at IS NULL
    GROUP BY p.company
  ) vio_agg ON vio_agg.company ~~* c.name
  LEFT JOIN (
    SELECT p.company, COUNT(*) AS passes_30d
    FROM public.visitor_passes vp
    JOIN public.properties p ON p.name ~~* vp.property
    WHERE vp.created_at >= now() - interval '30 days'
    GROUP BY p.company
  ) pass_agg ON pass_agg.company ~~* c.name
  -- Phase 2 metering: aggregate audit_logs API_USAGE_METER rows by
  -- company stamped in new_values. Filters tool='plate_read' so the
  -- VIN-lookup hook doesn't double-count when it ships.
  LEFT JOIN (
    SELECT new_values->>'company' AS company,
           COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS plate_reads_24h,
           COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')  AS plate_reads_30d
    FROM public.audit_logs
    WHERE action = 'API_USAGE_METER'
      AND new_values->>'tool' = 'plate_read'
      AND created_at >= now() - interval '30 days'
    GROUP BY new_values->>'company'
  ) scan_agg ON scan_agg.company ~~* c.name
  ORDER BY c.name;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.get_console_aggregates() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_console_aggregates() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_console_aggregates() FROM service_role;
GRANT  EXECUTE ON FUNCTION public.get_console_aggregates() TO authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 2. get_console_pm_property_permits — drawer drill for PM subscribers
-- ─────────────────────────────────────────────────────────────────
-- Returns one row per property at the requested company, with the
-- approved-permit count (status='active' AND is_active=TRUE on
-- vehicles attached to that property). NULL/empty for non-PM tier_type
-- subscribers — caller (UI) decides whether to render the section.
CREATE OR REPLACE FUNCTION public.get_console_pm_property_permits(p_company_id BIGINT)
RETURNS TABLE (
  property_name      TEXT,
  approved_permits   BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
#variable_conflict use_column
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_company_name TEXT;
  v_tier_type    TEXT;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  SELECT role INTO v_caller_role
    FROM public.user_roles
   WHERE lower(email) = lower(v_caller_email)
   LIMIT 1;
  IF v_caller_role IS NULL OR v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'forbidden_not_admin' USING ERRCODE = '42501';
  END IF;

  SELECT name, tier_type INTO v_company_name, v_tier_type
  FROM public.companies WHERE id = p_company_id LIMIT 1;
  IF v_company_name IS NULL THEN
    RAISE EXCEPTION 'company_not_found' USING ERRCODE = 'check_violation';
  END IF;
  IF v_tier_type IS DISTINCT FROM 'property_management' THEN
    -- Return empty for non-PM subscribers. UI omits the section.
    RETURN;
  END IF;

  -- Approved-permit definition pinned to the existing billing meter:
  -- vehicles.status = 'active' AND vehicles.is_active = TRUE.
  -- Matches commit 4b's countActiveRecords usage; do not invent a
  -- second count.
  RETURN QUERY
  SELECT
    p.name                                                          AS property_name,
    COUNT(v.id) FILTER (WHERE v.status = 'active' AND v.is_active = TRUE)  AS approved_permits
  FROM public.properties p
  LEFT JOIN public.vehicles v ON v.property ~~* p.name
  WHERE p.company ~~* v_company_name
    AND p.is_active = TRUE
  GROUP BY p.name
  ORDER BY p.name;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.get_console_pm_property_permits(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_console_pm_property_permits(BIGINT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_console_pm_property_permits(BIGINT) FROM service_role;
GRANT  EXECUTE ON FUNCTION public.get_console_pm_property_permits(BIGINT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 3. get_console_spike_flags — last-24h vs 7d baseline per metric
-- ─────────────────────────────────────────────────────────────────
-- Returns rows ONLY for currently-active flags (last_24h >
-- baseline_7d_avg × 1.25). Dismissed flags filtered out via JOIN
-- against flag_acknowledgments.
--
-- 4 metric sources:
--   plate_reads        — audit_logs API_USAGE_METER (tool=plate_read)
--   visitor_passes     — visitor_passes table
--   self_registrations — residents created via /register (created_at)
--   bulk_uploads       — audit_logs BULK_UPLOAD action
CREATE OR REPLACE FUNCTION public.get_console_spike_flags()
RETURNS TABLE (
  company_id          BIGINT,
  company_name        TEXT,
  flag_type           TEXT,
  last_24h            BIGINT,
  baseline_7d_avg     NUMERIC,
  threshold_pct       NUMERIC,
  dismissed           BOOLEAN,
  dismissed_until     TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
#variable_conflict use_column
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  -- B228 Phase 2 named/editable constant. 0.25 = 25% over baseline.
  -- Promotion path to platform_settings if Jose wants per-property
  -- tuning later.
  v_threshold    NUMERIC := 0.25;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  SELECT role INTO v_caller_role
    FROM public.user_roles
   WHERE lower(email) = lower(v_caller_email)
   LIMIT 1;
  IF v_caller_role IS NULL OR v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'forbidden_not_admin' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH per_company_per_metric AS (
    -- plate_reads
    SELECT c.id                                                       AS company_id,
           c.name                                                     AS company_name,
           'plate_reads'::TEXT                                        AS flag_type,
           COUNT(*) FILTER (
             WHERE al.created_at >= now() - interval '24 hours'
           )                                                          AS last_24h,
           (COUNT(*) FILTER (
              WHERE al.created_at BETWEEN now() - interval '8 days' AND now() - interval '24 hours'
           ))::NUMERIC / 7.0                                          AS baseline_7d_avg
      FROM public.companies c
      LEFT JOIN public.audit_logs al
             ON al.action = 'API_USAGE_METER'
            AND al.new_values->>'tool'    = 'plate_read'
            AND al.new_values->>'company' ~~* c.name
            AND al.created_at >= now() - interval '8 days'
     GROUP BY c.id, c.name

    UNION ALL

    -- visitor_passes
    SELECT c.id, c.name, 'visitor_passes',
           COUNT(*) FILTER (WHERE vp.created_at >= now() - interval '24 hours'),
           (COUNT(*) FILTER (
              WHERE vp.created_at BETWEEN now() - interval '8 days' AND now() - interval '24 hours'
           ))::NUMERIC / 7.0
      FROM public.companies c
      LEFT JOIN public.properties p ON p.company ~~* c.name
      LEFT JOIN public.visitor_passes vp ON vp.property ~~* p.name
                                         AND vp.created_at >= now() - interval '8 days'
     GROUP BY c.id, c.name

    UNION ALL

    -- self_registrations (residents created within the company's properties)
    SELECT c.id, c.name, 'self_registrations',
           COUNT(*) FILTER (WHERE r.created_at >= now() - interval '24 hours'),
           (COUNT(*) FILTER (
              WHERE r.created_at BETWEEN now() - interval '8 days' AND now() - interval '24 hours'
           ))::NUMERIC / 7.0
      FROM public.companies c
      LEFT JOIN public.properties p ON p.company ~~* c.name
      LEFT JOIN public.residents r ON r.property ~~* p.name
                                   AND r.created_at >= now() - interval '8 days'
     GROUP BY c.id, c.name

    UNION ALL

    -- bulk_uploads (audit_logs BULK_UPLOAD action; new_values.company filter)
    SELECT c.id, c.name, 'bulk_uploads',
           COUNT(*) FILTER (WHERE al.created_at >= now() - interval '24 hours'),
           (COUNT(*) FILTER (
              WHERE al.created_at BETWEEN now() - interval '8 days' AND now() - interval '24 hours'
           ))::NUMERIC / 7.0
      FROM public.companies c
      LEFT JOIN public.audit_logs al
             ON al.action LIKE 'BULK_UPLOAD%'
            AND al.new_values->>'company' ~~* c.name
            AND al.created_at >= now() - interval '8 days'
     GROUP BY c.id, c.name
  )
  SELECT
    m.company_id,
    m.company_name,
    m.flag_type,
    m.last_24h,
    m.baseline_7d_avg,
    v_threshold                                  AS threshold_pct,
    COALESCE(ack.dismiss_until > now(), FALSE)   AS dismissed,
    ack.dismiss_until                            AS dismissed_until
  FROM per_company_per_metric m
  LEFT JOIN public.flag_acknowledgments ack
         ON ack.company_id = m.company_id
        AND ack.flag_type  = m.flag_type
  WHERE m.last_24h > 0
    AND m.last_24h::NUMERIC > m.baseline_7d_avg * (1 + v_threshold)
    -- Only return if not dismissed (acknowledged + dismiss_until still active)
    AND (ack.dismiss_until IS NULL OR ack.dismiss_until <= now())
  ORDER BY m.company_name, m.flag_type;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.get_console_spike_flags() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_console_spike_flags() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_console_spike_flags() FROM service_role;
GRANT  EXECUTE ON FUNCTION public.get_console_spike_flags() TO authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 4. acknowledge_console_flag — upsert dismissal
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.acknowledge_console_flag(
  p_company_id    BIGINT,
  p_flag_type     TEXT,
  p_dismiss_until TIMESTAMPTZ DEFAULT NULL,
  p_note          TEXT        DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  SELECT role INTO v_caller_role
    FROM public.user_roles
   WHERE lower(email) = lower(v_caller_email)
   LIMIT 1;
  IF v_caller_role IS NULL OR v_caller_role <> 'admin' THEN
    RETURN jsonb_build_object('error', 'forbidden_not_admin');
  END IF;
  IF p_flag_type NOT IN ('plate_reads', 'visitor_passes', 'self_registrations', 'bulk_uploads') THEN
    RETURN jsonb_build_object('error', 'invalid_flag_type');
  END IF;

  -- Default dismiss_until = 7 days from now if not provided
  IF p_dismiss_until IS NULL THEN
    p_dismiss_until := now() + interval '7 days';
  END IF;

  INSERT INTO public.flag_acknowledgments
    (company_id, flag_type, acknowledged_by_email, acknowledged_at, dismiss_until, note)
  VALUES
    (p_company_id, p_flag_type, lower(v_caller_email), now(), p_dismiss_until, p_note)
  ON CONFLICT (company_id, flag_type) DO UPDATE
    SET acknowledged_at       = EXCLUDED.acknowledged_at,
        acknowledged_by_email = EXCLUDED.acknowledged_by_email,
        dismiss_until         = EXCLUDED.dismiss_until,
        note                  = EXCLUDED.note;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'CONSOLE_FLAG_ACK',
    'flag_acknowledgments',
    NULL,
    jsonb_build_object(
      'company_id',    p_company_id,
      'flag_type',     p_flag_type,
      'dismiss_until', p_dismiss_until,
      'note',          p_note
    ),
    now()
  );

  RETURN jsonb_build_object('ok', TRUE, 'dismiss_until', p_dismiss_until);
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.acknowledge_console_flag(BIGINT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.acknowledge_console_flag(BIGINT, TEXT, TIMESTAMPTZ, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.acknowledge_console_flag(BIGINT, TEXT, TIMESTAMPTZ, TEXT) FROM service_role;
GRANT  EXECUTE ON FUNCTION public.acknowledge_console_flag(BIGINT, TEXT, TIMESTAMPTZ, TEXT) TO authenticated;


-- Audit row
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_B228_PHASE2_RPCS',
  'pg_proc',
  NULL,
  jsonb_build_object(
    'migration', '20260630_b228_phase2_rpcs',
    'fns',       jsonb_build_array(
      'get_console_aggregates (extended)',
      'get_console_pm_property_permits',
      'get_console_spike_flags',
      'acknowledge_console_flag'
    ),
    'phase',     'B228 Phase 2'
  ),
  now()
);

COMMIT;

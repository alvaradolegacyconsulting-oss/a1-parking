-- ════════════════════════════════════════════════════════════════════
-- B228 Phase 2 — spike-flag minimum-volume floor (small-N false positives)
-- 2026-06-30
-- ════════════════════════════════════════════════════════════════════
--
-- THE PROBLEM
--   Live smoke surfaced "Self Registrations, 2 vs 0.3/d, +600%" flags
--   on test accounts. Math is right; signal is noise. When the 7-day
--   baseline is near zero, ANY trivial absolute count yields a huge
--   percentage. At scale, every low-volume metric would spike
--   constantly on near-zero baselines → flag section becomes noise →
--   operator learns to ignore it → feature is dead.
--
-- THE FIX
--   Gate each flag on BOTH:
--     (a) current > baseline × (1 + threshold)      ← existing 25% rule
--     (b) current >= v_min_volume                    ← NEW absolute floor
--
--   New named local v_min_volume NUMERIC := 10 — same shape as
--   v_threshold. "Don't cry spike unless it's both 25%+ over baseline
--   AND at least 10 events." Floor=10 kills the trivial test-account
--   noise; genuine onboarding bursts (~40+ events) still flag and are
--   "Mark expected"-dismissable.
--
-- WHY ANOTHER MIGRATION FILE (not an in-place edit)
--   Clear audit trail for the behavior change; standalone roll-back
--   target; matches the Phase-1-hotfix pattern. The RETURNS TABLE shape
--   is unchanged, so CREATE OR REPLACE works — no DROP needed.
--
-- POST-APPLY
--   §4 of the Phase 2 verification still applies (authenticated=X only).
--   App: the two "2 vs 0.3/d" self-reg flags clear immediately on
--   refresh. Manufacture a ≥10-event spike to confirm flags still fire.
--
-- FUTURE
--   Promote v_min_volume to platform_settings if per-metric tuning
--   becomes needed (plate-reads might warrant a higher floor than
--   self-registrations). One global floor is fine for v1.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

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
  -- B228 Phase 2 named/editable constants.
  v_threshold    NUMERIC := 0.25;  -- 25% over baseline
  v_min_volume   NUMERIC := 10;    -- absolute floor: small-N false-positive guard
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
  WHERE m.last_24h::NUMERIC >= v_min_volume                              -- NEW: absolute floor
    AND m.last_24h::NUMERIC > m.baseline_7d_avg * (1 + v_threshold)      -- existing % rule
    AND (ack.dismiss_until IS NULL OR ack.dismiss_until <= now())        -- not currently dismissed
  ORDER BY m.company_name, m.flag_type;
END;
$func$;

-- ── Re-apply grants (CREATE OR REPLACE preserves ACL when the shape
-- is unchanged, but explicit REVOKE/GRANT is idempotent and matches
-- the standing discipline). ─────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.get_console_spike_flags() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_console_spike_flags() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_console_spike_flags() FROM service_role;
GRANT  EXECUTE ON FUNCTION public.get_console_spike_flags() TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_B228_PHASE2_SPIKE_FLOOR_FIX',
  'pg_proc',
  NULL,
  jsonb_build_object(
    'migration', '20260630_b228_phase2_spike_floor_fix',
    'change',    'get_console_spike_flags now requires last_24h >= v_min_volume (default 10) in addition to the % rule',
    'rationale', 'Near-zero baselines + any trivial count produced +600% spikes on test accounts. Floor kills the small-N false positives; genuine ≥10-event bursts still flag.'
  ),
  now()
);

COMMIT;

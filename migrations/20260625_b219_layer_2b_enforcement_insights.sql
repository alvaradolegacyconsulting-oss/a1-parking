-- ═══════════════════════════════════════════════════════════════════
-- B219 Layer 2b — Enforcement Insights aggregation RPC (FULL v1)
-- Date:   2026-06-25
-- Branch: a1/insights-2b
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- Adds public.get_enforcement_insights — a SECURITY DEFINER read-only
-- aggregation RPC returning the entire Insights dashboard payload as a
-- jsonb blob in one round-trip. Reads the status data accumulating from
-- B219 Layer 1 + 2a (set_violation_status RPC) plus the existing
-- voided_* columns (B175), and computes:
--
--   Summary       — total_violations, tow_rate_pct, visitor_passes
--                   (ports avg-tow-rate + visitor-pass-count from the
--                    soon-to-be-hidden Analytics tab so nothing CA-
--                    critical orphans)
--   6 widgets:
--     - status_pipeline   (counts by status, voided as separate bucket)
--     - ticket_aging      (open tickets bucketed by days since created)
--     - by_property       (violations / tows / voids per property)
--     - by_driver         (drift-watch ONLY: violations, tows, voids,
--                          disputes, + trend indicator. NO ranked score,
--                          NO accuracy %)
--     - heatmap           (day-of-week × 4hr time-bucket)
--     - repeat_vehicles   (plates with ≥3 violations in window)
--
--   6 flags:
--     - accuracy_slipping (red, per-driver, FIXED 30d window)
--     - tickets_aging_out (red, single, open >30d, count ≥10)
--     - dispute_spike     (amber, per-prop+per-driver, last 7d)
--     - void_spike        (amber, per-prop+per-driver, last 7d)
--     - coverage_gap      (amber, per-property, last 7d vs trailing 4wk)
--     - stuck_tow_tickets (amber, single, tow_ticket unchanged >14d)
--
-- 🔒 INVARIANTS (locked by Jose 2026-06-24/25):
--
--   1. VOID PRECEDENCE: a voided row counts as VOIDED only — never
--      double-counted in its pre-void status slice. status_pipeline
--      counts non-voided rows; void is a separate count.
--
--   2. DISPUTE SOURCE: status='disputed' EXCLUSIVELY. NOT
--      dispute_requests (removed in B210). The dispute_requests table
--      exists but is inert — no aggregate reads it.
--
--   3. OPEN: status IN ('new','tow_ticket') AND voided_at IS NULL.
--      Matches 2a's filter exactly.
--
--   4. NO DRIVER RANKING: the by_driver widget shows volume + trend
--      arrow ONLY. NO accuracy %, NO score, NO leaderboard. Values
--      call (wrongful-tow-sensitive product; ranking creates wrong
--      incentive toward more tows).
--
--   5. FLAG WINDOWS ARE FIXED: each flag uses its own intrinsic
--      operational window (7d / 14d / 30d) regardless of the
--      dashboard's display filter. The display filter only affects
--      the widget charts. Flag UI surfaces the window per-tile.
--
-- COMPANY-SCOPE PREDICATE — mirrors b40 RLS + Layer 1 exactly:
--   properties.company ~~* v_caller_company (ILIKE)
--   AND violations.property = ANY(v_property_list)  (exact)
-- Invariant: RLS-visible rows = RPC-returned rows.
--
-- ROLE GATE: company_admin only (matches set_violation_status +
-- void_violation). Byte-identical-to-set_violation_status; same
-- helpers (get_my_role + get_my_company).
--
-- GRANTS: REVOKE PUBLIC + REVOKE anon explicit + GRANT authenticated
-- per the established discipline.
--
-- APPLY DISCIPLINE
-- ────────────────
-- 1. Section A of verification → confirm RPC absent
-- 2. Apply this file in single BEGIN/COMMIT
-- 3. Sections B–G of verification → confirm pass
-- 4. UAT flag-seed file (separate) applied for the UAT sitting only;
--    pre-launch wipe removes seed rows
-- 5. UI commit (Insights tab + Analytics-hide) ships AFTER this RPC
--    is live in prod
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.get_enforcement_insights(
  p_property   TEXT        DEFAULT NULL,    -- NULL = all properties in caller's company
  p_date_from  TIMESTAMPTZ DEFAULT NULL,    -- NULL = NOW() - 30 days
  p_date_to    TIMESTAMPTZ DEFAULT NULL     -- NULL = NOW()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $func$
DECLARE
  -- ── Auth + scope ──────────────────────────────────────────────
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_caller_company TEXT;
  v_property_list  TEXT[];
  v_from           TIMESTAMPTZ;
  v_to             TIMESTAMPTZ;
  v_now            TIMESTAMPTZ := now();

  -- ── Flag thresholds (hardcoded for v1; per-company config
  --    deferred to platform_settings later) ─────────────────────
  v_accuracy_dispute_pct  CONSTANT NUMERIC := 8.0;   -- flag 1
  v_accuracy_void_pct     CONSTANT NUMERIC := 10.0;  -- flag 1
  v_accuracy_min_volume   CONSTANT INTEGER := 10;    -- flag 1 noise guard
  v_aging_days            CONSTANT INTEGER := 30;    -- flag 2
  v_aging_min_count       CONSTANT INTEGER := 10;    -- flag 2 noise guard
  v_spike_abs             CONSTANT INTEGER := 5;     -- flags 3+4
  v_spike_multiplier      CONSTANT NUMERIC := 3.0;   -- flags 3+4
  v_spike_baseline_min    CONSTANT NUMERIC := 3.0;   -- flags 3+4 per week
  v_coverage_pct          CONSTANT NUMERIC := 0.25;  -- flag 5
  v_coverage_baseline_min CONSTANT NUMERIC := 5.0;   -- flag 5 per week
  v_stuck_days            CONSTANT INTEGER := 14;    -- flag 6
  v_stuck_min_count       CONSTANT INTEGER := 5;     -- flag 6
  v_repeat_min            CONSTANT INTEGER := 3;     -- widget 6

  -- ── Trend-arrow noise guard (per-driver `trend` field) ──────
  v_trend_min_volume      CONSTANT INTEGER := 5;     -- ≥5 violations in 14d window
  v_trend_min_delta       CONSTANT INTEGER := 2;     -- AND ≥2 abs delta in metric

  -- ── Result assembly ──────────────────────────────────────────
  v_result jsonb;
BEGIN
  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ AUTH + ROLE GATE (mirrors set_violation_status exactly) ║
  -- ╚══════════════════════════════════════════════════════════╝
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  IF v_caller_role != 'company_admin' THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  v_caller_company := get_my_company();
  IF v_caller_company IS NULL THEN
    RETURN jsonb_build_object('error', 'no_company_assigned');
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ PROPERTY SCOPE — mirrors b40 RLS predicate exactly      ║
  -- ║   properties.company ~~* (ILIKE) v_caller_company        ║
  -- ║   AND (p_property=NULL OR properties.name = p_property)  ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF p_property IS NULL THEN
    SELECT array_agg(name) INTO v_property_list
      FROM public.properties
     WHERE company ~~* v_caller_company;
  ELSE
    SELECT array_agg(name) INTO v_property_list
      FROM public.properties
     WHERE company ~~* v_caller_company
       AND name = p_property;
  END IF;

  IF v_property_list IS NULL OR array_length(v_property_list, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'error', 'no_properties_in_scope',
      'hint',  'No properties match this company + property filter.'
    );
  END IF;

  -- ── Date range defaults ─────────────────────────────────────
  v_to   := COALESCE(p_date_to, v_now);
  v_from := COALESCE(p_date_from, v_now - INTERVAL '30 days');

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ WIDGET + FLAG COMPUTATIONS                              ║
  -- ║ All in ONE giant WITH clause to keep the SECURITY       ║
  -- ║ DEFINER context single-statement. Each CTE either       ║
  -- ║ respects the display-filter window (widgets) or uses    ║
  -- ║ its own fixed operational window (flags).               ║
  -- ╚══════════════════════════════════════════════════════════╝
  WITH
  -- ── CTE 1: scoped_violations (display-filter window) ──────
  -- DRAFT EXCLUSION RATIONALE: is_confirmed=false rows are
  -- unconfirmed drafts (the staging-area state before a driver
  -- submits). They're never operationally meaningful as violations
  -- so they're excluded from EVERY widget and flag. Side effect:
  -- the dashboard's status='new' count won't tie to Layer 1's
  -- raw backfill total (which counted ALL non-voided rows
  -- including drafts). 68 new + 19 tow_ticket from Layer 1 ≠
  -- the new+tow_ticket totals shown here. Filter is intentional.
  scoped_violations AS (
    SELECT *
      FROM public.violations
     WHERE property = ANY(v_property_list)
       AND is_confirmed = TRUE
       AND created_at >= v_from
       AND created_at <  v_to
  ),

  -- ── CTE 2: summary (ports the orphaned Analytics metrics) ──
  -- Visitor passes is its own query against visitor_passes table.
  summary_visitor_passes AS (
    SELECT COUNT(*) AS pass_count
      FROM public.visitor_passes
     WHERE property = ANY(v_property_list)
       AND created_at >= v_from
       AND created_at <  v_to
  ),

  -- ── WIDGET 1: status_pipeline ─────────────────────────────
  -- Void precedence: voided rows excluded from status counts;
  -- counted in their own 'voided' bucket. Non-voided rows
  -- counted by current status.
  status_pipeline AS (
    SELECT
      COUNT(*) FILTER (WHERE voided_at IS NULL AND status = 'new')        AS c_new,
      COUNT(*) FILTER (WHERE voided_at IS NULL AND status = 'tow_ticket') AS c_tow_ticket,
      COUNT(*) FILTER (WHERE voided_at IS NULL AND status = 'resolved')   AS c_resolved,
      COUNT(*) FILTER (WHERE voided_at IS NULL AND status = 'disputed')   AS c_disputed,
      COUNT(*) FILTER (WHERE voided_at IS NOT NULL)                       AS c_voided
    FROM scoped_violations
  ),

  -- ── WIDGET 2: ticket_aging (open tickets bucketed by age) ──
  -- Uses scoped_violations (display window) but only counts open
  -- tickets (status IN new/tow_ticket AND voided_at IS NULL).
  ticket_aging AS (
    SELECT
      COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (v_now - created_at)) / 86400 <= 7)   AS d0_7,
      COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (v_now - created_at)) / 86400 >  7
                         AND EXTRACT(EPOCH FROM (v_now - created_at)) / 86400 <= 30) AS d8_30,
      COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (v_now - created_at)) / 86400 >  30) AS d30plus
    FROM scoped_violations
    WHERE voided_at IS NULL
      AND status IN ('new', 'tow_ticket')
  ),

  -- ── WIDGET 3: by_property (volume per property in window) ──
  by_property AS (
    SELECT
      property,
      COUNT(*) FILTER (WHERE voided_at IS NULL)                                AS violations,
      COUNT(*) FILTER (WHERE voided_at IS NULL AND tow_ticket_generated = TRUE) AS tows,
      COUNT(*) FILTER (WHERE voided_at IS NOT NULL)                            AS voids
    FROM scoped_violations
    GROUP BY property
    ORDER BY violations DESC
  ),

  -- ── WIDGET 4: by_driver (DRIFT-WATCH ONLY) ───────────────
  -- Per-driver volume + dispute/void counts + trend arrow.
  -- NO ranked score, NO accuracy %, NO leaderboard.
  -- Trend window: last 14d (NOT v_from/v_to) — current 7d vs
  -- prior 7d. Min volume 5 + min delta 2 prevents single-event
  -- noise from showing a rising arrow.
  --
  -- driver_name CAN be NULL on legacy rows; coalesce to a
  -- sentinel so the aggregation still groups them as one bucket
  -- ('(unattributed)') the UI can render readably.
  driver_14d AS (
    SELECT
      COALESCE(NULLIF(trim(driver_name), ''), '(unattributed)') AS driver,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '7 days'
                         AND status = 'disputed')                AS disputes_current_7d,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '14 days'
                         AND created_at <  v_now - INTERVAL '7 days'
                         AND status = 'disputed')                AS disputes_prior_7d,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '7 days'
                         AND voided_at IS NOT NULL)              AS voids_current_7d,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '14 days'
                         AND created_at <  v_now - INTERVAL '7 days'
                         AND voided_at IS NOT NULL)              AS voids_prior_7d,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '14 days') AS total_14d
    FROM public.violations
    WHERE property = ANY(v_property_list)
      AND is_confirmed = TRUE
      AND created_at >= v_now - INTERVAL '14 days'
    GROUP BY 1
  ),
  by_driver AS (
    SELECT
      COALESCE(NULLIF(trim(sv.driver_name), ''), '(unattributed)') AS driver,
      COUNT(*) FILTER (WHERE sv.voided_at IS NULL)                                AS violations,
      COUNT(*) FILTER (WHERE sv.voided_at IS NULL AND sv.tow_ticket_generated)    AS tows,
      COUNT(*) FILTER (WHERE sv.voided_at IS NOT NULL)                            AS voids,
      COUNT(*) FILTER (WHERE sv.voided_at IS NULL AND sv.status = 'disputed')     AS disputes,
      CASE
        WHEN COALESCE(d.total_14d, 0) < v_trend_min_volume THEN NULL
        WHEN COALESCE(d.disputes_current_7d, 0) >= COALESCE(d.disputes_prior_7d, 0) + v_trend_min_delta
          THEN 'rising_disputes'
        WHEN COALESCE(d.voids_current_7d, 0)    >= COALESCE(d.voids_prior_7d, 0)    + v_trend_min_delta
          THEN 'rising_voids'
        ELSE NULL
      END AS trend
    FROM scoped_violations sv
    LEFT JOIN driver_14d d
      ON d.driver = COALESCE(NULLIF(trim(sv.driver_name), ''), '(unattributed)')
    GROUP BY 1, d.total_14d, d.disputes_current_7d, d.disputes_prior_7d, d.voids_current_7d, d.voids_prior_7d
    ORDER BY violations DESC
  ),

  -- ── WIDGET 5: heatmap (day-of-week × 4hr bucket) ──────────
  -- 0=Sun..6=Sat ; bucket 0=12-4a, 1=4-8a, 2=8a-12p, 3=12-4p,
  -- 4=4-8p, 5=8p-12a. Counts non-voided violations only
  -- (peak operational pattern, not void pattern).
  heatmap AS (
    SELECT
      EXTRACT(DOW  FROM created_at)::INTEGER         AS dow,
      (EXTRACT(HOUR FROM created_at)::INTEGER / 4)   AS bucket,
      COUNT(*)                                        AS count
    FROM scoped_violations
    WHERE voided_at IS NULL
    GROUP BY 1, 2
  ),

  -- ── WIDGET 6: repeat_vehicles (≥3 violations in window) ──
  -- Includes voided in the count (any plate getting attention
  -- N times is a signal, even if some were voided).
  repeat_vehicles AS (
    SELECT
      plate,
      COUNT(*)                          AS count,
      MAX(created_at)                   AS latest_at,
      (array_agg(status     ORDER BY created_at DESC))[1] AS latest_status,
      (array_agg(property   ORDER BY created_at DESC))[1] AS property
    FROM scoped_violations
    GROUP BY plate
    HAVING COUNT(*) >= v_repeat_min
    ORDER BY count DESC, latest_at DESC
    LIMIT 50
  ),

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ FLAGS — each uses its own fixed operational window      ║
  -- ║ (NOT v_from/v_to). Operational alerts answer "what     ║
  -- ║ should the operator pay attention to RIGHT NOW."        ║
  -- ╚══════════════════════════════════════════════════════════╝

  -- ── FLAG 1: accuracy_slipping (per-driver, FIXED 30d) ────
  -- dispute_rate > 8% OR void_rate > 10%, min ≥10 violations.
  flag_accuracy_data AS (
    SELECT
      COALESCE(NULLIF(trim(driver_name), ''), '(unattributed)') AS driver,
      COUNT(*)                                                  AS total,
      COUNT(*) FILTER (WHERE status = 'disputed')               AS disputes,
      COUNT(*) FILTER (WHERE voided_at IS NOT NULL)             AS voids
    FROM public.violations
    WHERE property = ANY(v_property_list)
      AND is_confirmed = TRUE
      AND created_at >= v_now - INTERVAL '30 days'
    GROUP BY 1
  ),
  flag_accuracy AS (
    SELECT
      driver,
      total,
      disputes,
      voids,
      ROUND((disputes::NUMERIC / total) * 100, 1) AS dispute_pct,
      ROUND((voids::NUMERIC    / total) * 100, 1) AS void_pct
    FROM flag_accuracy_data
    WHERE total >= v_accuracy_min_volume
      AND (
        (disputes::NUMERIC / total) * 100 > v_accuracy_dispute_pct
        OR (voids::NUMERIC / total) * 100 > v_accuracy_void_pct
      )
  ),

  -- ── FLAG 2: tickets_aging_out (single, count ≥10) ────────
  flag_aging_rows AS (
    SELECT property, created_at
      FROM public.violations
     WHERE property = ANY(v_property_list)
       AND is_confirmed = TRUE
       AND voided_at IS NULL
       AND status IN ('new', 'tow_ticket')
       AND created_at < v_now - (v_aging_days || ' days')::INTERVAL
  ),
  flag_aging AS (
    SELECT
      (SELECT COUNT(*) FROM flag_aging_rows) AS total,
      (SELECT property
         FROM flag_aging_rows
        GROUP BY property ORDER BY COUNT(*) DESC LIMIT 1) AS worst_property,
      (SELECT MIN(created_at) FROM flag_aging_rows) AS oldest_at
  ),

  -- ── FLAG 3: dispute_spike (per-property + per-driver) ────
  -- ≥5 in last 7d (absolute) OR ≥3× trailing-4wk weekly avg.
  -- Baseline guard: trailing avg must be ≥3/wk before 3× fires.
  flag_dispute_spike_prop AS (
    SELECT
      property,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '7 days')  AS current_7d,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '35 days'
                         AND created_at <  v_now - INTERVAL '7 days')  AS trailing_28d
    FROM public.violations
    WHERE property = ANY(v_property_list)
      AND is_confirmed = TRUE
      AND status = 'disputed'
      AND created_at >= v_now - INTERVAL '35 days'
    GROUP BY property
    HAVING
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '7 days') >= v_spike_abs
      OR (
        COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '35 days'
                           AND created_at <  v_now - INTERVAL '7 days') / 4.0 >= v_spike_baseline_min
        AND COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '7 days') >=
            ((COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '35 days'
                                 AND created_at <  v_now - INTERVAL '7 days') / 4.0) * v_spike_multiplier)
      )
  ),
  flag_dispute_spike_driver AS (
    SELECT
      COALESCE(NULLIF(trim(driver_name), ''), '(unattributed)') AS driver,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '7 days')  AS current_7d,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '35 days'
                         AND created_at <  v_now - INTERVAL '7 days')  AS trailing_28d
    FROM public.violations
    WHERE property = ANY(v_property_list)
      AND is_confirmed = TRUE
      AND status = 'disputed'
      AND created_at >= v_now - INTERVAL '35 days'
    GROUP BY 1
    HAVING
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '7 days') >= v_spike_abs
      OR (
        COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '35 days'
                           AND created_at <  v_now - INTERVAL '7 days') / 4.0 >= v_spike_baseline_min
        AND COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '7 days') >=
            ((COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '35 days'
                                 AND created_at <  v_now - INTERVAL '7 days') / 4.0) * v_spike_multiplier)
      )
  ),

  -- ── FLAG 4: void_spike (per-property + per-driver) ────────
  -- Same shape as dispute_spike, applied to voids.
  flag_void_spike_prop AS (
    SELECT
      property,
      COUNT(*) FILTER (WHERE voided_at >= v_now - INTERVAL '7 days')  AS current_7d,
      COUNT(*) FILTER (WHERE voided_at >= v_now - INTERVAL '35 days'
                         AND voided_at <  v_now - INTERVAL '7 days')  AS trailing_28d
    FROM public.violations
    WHERE property = ANY(v_property_list)
      AND is_confirmed = TRUE
      AND voided_at IS NOT NULL
      AND voided_at >= v_now - INTERVAL '35 days'
    GROUP BY property
    HAVING
      COUNT(*) FILTER (WHERE voided_at >= v_now - INTERVAL '7 days') >= v_spike_abs
      OR (
        COUNT(*) FILTER (WHERE voided_at >= v_now - INTERVAL '35 days'
                           AND voided_at <  v_now - INTERVAL '7 days') / 4.0 >= v_spike_baseline_min
        AND COUNT(*) FILTER (WHERE voided_at >= v_now - INTERVAL '7 days') >=
            ((COUNT(*) FILTER (WHERE voided_at >= v_now - INTERVAL '35 days'
                                 AND voided_at <  v_now - INTERVAL '7 days') / 4.0) * v_spike_multiplier)
      )
  ),
  flag_void_spike_driver AS (
    SELECT
      COALESCE(NULLIF(trim(driver_name), ''), '(unattributed)') AS driver,
      COUNT(*) FILTER (WHERE voided_at >= v_now - INTERVAL '7 days')  AS current_7d,
      COUNT(*) FILTER (WHERE voided_at >= v_now - INTERVAL '35 days'
                         AND voided_at <  v_now - INTERVAL '7 days')  AS trailing_28d
    FROM public.violations
    WHERE property = ANY(v_property_list)
      AND is_confirmed = TRUE
      AND voided_at IS NOT NULL
      AND voided_at >= v_now - INTERVAL '35 days'
    GROUP BY 1
    HAVING
      COUNT(*) FILTER (WHERE voided_at >= v_now - INTERVAL '7 days') >= v_spike_abs
      OR (
        COUNT(*) FILTER (WHERE voided_at >= v_now - INTERVAL '35 days'
                           AND voided_at <  v_now - INTERVAL '7 days') / 4.0 >= v_spike_baseline_min
        AND COUNT(*) FILTER (WHERE voided_at >= v_now - INTERVAL '7 days') >=
            ((COUNT(*) FILTER (WHERE voided_at >= v_now - INTERVAL '35 days'
                                 AND voided_at <  v_now - INTERVAL '7 days') / 4.0) * v_spike_multiplier)
      )
  ),

  -- ── FLAG 5: coverage_gap (per-property only) ──────────────
  -- last 7d < 25% of trailing-4wk weekly avg; baseline ≥5/wk.
  flag_coverage AS (
    SELECT
      property,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '7 days')                AS current_7d,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '35 days'
                         AND created_at <  v_now - INTERVAL '7 days') / 4.0          AS baseline_weekly
    FROM public.violations
    WHERE property = ANY(v_property_list)
      AND is_confirmed = TRUE
      AND voided_at IS NULL
      AND created_at >= v_now - INTERVAL '35 days'
    GROUP BY property
    HAVING
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '35 days'
                         AND created_at <  v_now - INTERVAL '7 days') / 4.0 >= v_coverage_baseline_min
      AND COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '7 days') <
          ((COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '35 days'
                               AND created_at <  v_now - INTERVAL '7 days') / 4.0) * v_coverage_pct)
  ),

  -- ── FLAG 6: stuck_tow_tickets (single, count ≥5) ──────────
  -- status='tow_ticket' AND voided_at IS NULL AND
  -- COALESCE(status_changed_at, created_at) < NOW() - 14d.
  -- Fallback to created_at catches backfilled rows where
  -- status_changed_at is NULL (Layer 1 backfilled 19 tow_ticket
  -- rows without setting status_changed_at).
  flag_stuck_rows AS (
    SELECT property, created_at, status_changed_at
      FROM public.violations
     WHERE property = ANY(v_property_list)
       AND is_confirmed = TRUE
       AND voided_at IS NULL
       AND status = 'tow_ticket'
       AND COALESCE(status_changed_at, created_at) < v_now - (v_stuck_days || ' days')::INTERVAL
  ),
  flag_stuck AS (
    SELECT
      (SELECT COUNT(*) FROM flag_stuck_rows) AS total,
      (SELECT property
         FROM flag_stuck_rows
        GROUP BY property ORDER BY COUNT(*) DESC LIMIT 1) AS worst_property
  )

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ ASSEMBLE FINAL jsonb                                    ║
  -- ╚══════════════════════════════════════════════════════════╝
  SELECT jsonb_build_object(
    'window', jsonb_build_object(
      'from',     v_from,
      'to',       v_to,
      'property', p_property
    ),
    'summary', jsonb_build_object(
      'total_violations', (SELECT COUNT(*) FILTER (WHERE voided_at IS NULL) FROM scoped_violations),
      'tow_rate_pct',     (
        SELECT CASE
          WHEN COUNT(*) FILTER (WHERE voided_at IS NULL) = 0 THEN 0
          ELSE ROUND(
            (COUNT(*) FILTER (WHERE voided_at IS NULL AND tow_ticket_generated = TRUE)::NUMERIC
             / COUNT(*) FILTER (WHERE voided_at IS NULL)) * 100, 0
          )
        END
        FROM scoped_violations
      ),
      'visitor_passes',   (SELECT pass_count FROM summary_visitor_passes)
    ),
    'status_pipeline', (
      SELECT jsonb_build_object(
        'new',        c_new,
        'tow_ticket', c_tow_ticket,
        'resolved',   c_resolved,
        'disputed',   c_disputed,
        'voided',     c_voided
      ) FROM status_pipeline
    ),
    'ticket_aging', (
      SELECT jsonb_build_object(
        'd0_7',    d0_7,
        'd8_30',   d8_30,
        'd30plus', d30plus
      ) FROM ticket_aging
    ),
    'by_property', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'property',   property,
        'violations', violations,
        'tows',       tows,
        'voids',      voids
      )) FROM by_property),
      '[]'::jsonb
    ),
    'by_driver', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'driver',     driver,
        'violations', violations,
        'tows',       tows,
        'voids',      voids,
        'disputes',   disputes,
        'trend',      trend
      )) FROM by_driver),
      '[]'::jsonb
    ),
    'heatmap', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'dow',    dow,
        'bucket', bucket,
        'count',  count
      )) FROM heatmap),
      '[]'::jsonb
    ),
    'repeat_vehicles', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'plate',         plate,
        'count',         count,
        'latest_status', latest_status,
        'property',      property
      )) FROM repeat_vehicles),
      '[]'::jsonb
    ),
    'flags', (
      SELECT COALESCE(jsonb_agg(flag_row ORDER BY (flag_row->>'severity_rank')::INTEGER, flag_row->>'code'), '[]'::jsonb)
      FROM (
        -- Flag 1: accuracy_slipping (red, per-driver)
        SELECT jsonb_build_object(
          'severity',      'red',
          'severity_rank', 0,
          'code',          'accuracy_slipping',
          'window_label',  'Last 30 days',
          'headline',      format('Accuracy slipping · %s · %s%% dispute rate (%s of %s)',
                                  driver, dispute_pct, disputes, total),
          'detail',        jsonb_build_object(
            'driver',      driver,
            'dispute_pct', dispute_pct,
            'void_pct',    void_pct,
            'total',       total
          )
        ) AS flag_row
        FROM flag_accuracy

        UNION ALL
        -- Flag 2: tickets_aging_out (red, single)
        SELECT jsonb_build_object(
          'severity',      'red',
          'severity_rank', 0,
          'code',          'tickets_aging_out',
          'window_label',  format('Older than %s days', v_aging_days),
          'headline',      format('%s open tickets aging past %s days · %s worst',
                                  total, v_aging_days, COALESCE(worst_property, '—')),
          'detail',        jsonb_build_object(
            'total',          total,
            'worst_property', worst_property,
            'oldest_at',      oldest_at
          )
        )
        FROM flag_aging
        WHERE total >= v_aging_min_count

        UNION ALL
        -- Flag 3: dispute_spike (amber, per-property)
        SELECT jsonb_build_object(
          'severity',      'amber',
          'severity_rank', 1,
          'code',          'dispute_spike_property',
          'window_label',  'Last 7 days',
          'headline',      format('Dispute spike · %s · %s in 7 days', property, current_7d),
          'detail',        jsonb_build_object('property', property, 'current_7d', current_7d, 'trailing_28d', trailing_28d)
        )
        FROM flag_dispute_spike_prop

        UNION ALL
        -- Flag 3b: dispute_spike (amber, per-driver)
        SELECT jsonb_build_object(
          'severity',      'amber',
          'severity_rank', 1,
          'code',          'dispute_spike_driver',
          'window_label',  'Last 7 days',
          'headline',      format('Dispute spike · %s · %s in 7 days', driver, current_7d),
          'detail',        jsonb_build_object('driver', driver, 'current_7d', current_7d, 'trailing_28d', trailing_28d)
        )
        FROM flag_dispute_spike_driver

        UNION ALL
        -- Flag 4: void_spike (amber, per-property)
        SELECT jsonb_build_object(
          'severity',      'amber',
          'severity_rank', 1,
          'code',          'void_spike_property',
          'window_label',  'Last 7 days',
          'headline',      format('Void spike · %s · %s in 7 days', property, current_7d),
          'detail',        jsonb_build_object('property', property, 'current_7d', current_7d, 'trailing_28d', trailing_28d)
        )
        FROM flag_void_spike_prop

        UNION ALL
        -- Flag 4b: void_spike (amber, per-driver)
        SELECT jsonb_build_object(
          'severity',      'amber',
          'severity_rank', 1,
          'code',          'void_spike_driver',
          'window_label',  'Last 7 days',
          'headline',      format('Void spike · %s · %s in 7 days', driver, current_7d),
          'detail',        jsonb_build_object('driver', driver, 'current_7d', current_7d, 'trailing_28d', trailing_28d)
        )
        FROM flag_void_spike_driver

        UNION ALL
        -- Flag 5: coverage_gap (amber, per-property)
        SELECT jsonb_build_object(
          'severity',      'amber',
          'severity_rank', 1,
          'code',          'coverage_gap',
          'window_label',  'Last 7 days vs trailing 4 weeks',
          'headline',      format('Coverage gap · %s · %s in last 7d vs %s/wk avg',
                                  property, current_7d, ROUND(baseline_weekly, 1)),
          'detail',        jsonb_build_object(
            'property',         property,
            'current_7d',       current_7d,
            'baseline_weekly',  baseline_weekly
          )
        )
        FROM flag_coverage

        UNION ALL
        -- Flag 6: stuck_tow_tickets (amber, single)
        SELECT jsonb_build_object(
          'severity',      'amber',
          'severity_rank', 1,
          'code',          'stuck_tow_tickets',
          'window_label',  format('Unchanged >%s days', v_stuck_days),
          'headline',      format('%s tow tickets stuck unchanged >%s days', total, v_stuck_days),
          'detail',        jsonb_build_object('total', total, 'worst_property', worst_property)
        )
        FROM flag_stuck
        WHERE total >= v_stuck_min_count
      ) AS all_flags
    )
  ) INTO v_result;

  RETURN v_result;
END;
$func$;

-- ── Grants ──────────────────────────────────────────────────────────
-- Explicit REVOKE from anon + PUBLIC per
-- [[feedback-revoke-from-anon-explicitly]] +
-- [[feedback-function-public-grant-supabase-default]]
REVOKE EXECUTE ON FUNCTION public.get_enforcement_insights(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_enforcement_insights(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_enforcement_insights(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- Audit row recording the RPC ships.
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_ADDED',
  'enforcement_insights',
  NULL,
  jsonb_build_object(
    'rpc',         'get_enforcement_insights',
    'migration',   '20260625_b219_layer_2b_enforcement_insights',
    'returns',     'jsonb',
    'role_gate',   'company_admin',
    'read_only',   TRUE,
    'flag_count',  6,
    'widget_count', 6
  ),
  now()
);

COMMIT;

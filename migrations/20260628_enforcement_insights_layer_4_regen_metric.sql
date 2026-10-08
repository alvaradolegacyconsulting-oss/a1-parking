-- ═══════════════════════════════════════════════════════════════════
-- Tow Ticket Regenerate — Layer 4 (Regen-Count Metric)
-- Date:   2026-06-28
-- Branch: a1/tow-ticket-regenerate-layer-4
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- Amends get_enforcement_insights (B219 Layer 2b RPC) to add
-- per-driver regenerate activity:
--   1. A `regens` count column on each by_driver widget row,
--      attributed to the driver who PERFORMED the regenerate
--      (audit caller, NOT the original ticket's driver).
--   2. Trend extension: `rising_regens` appended to the by_driver
--      trend CASE (after disputes + voids).
--   3. A new flag: flag_regen_spike_driver — same baseline-guarded
--      shape as flag_void_spike_driver, sourced from regen audit.
--
-- 🔒 INVARIANTS HONORED
-- ─────────────────────
--   - DRIFT SIGNAL, NOT a ranking: regens is a count column
--     alongside violations/tows/voids/disputes. The by_driver CTE
--     still ORDER BY violations DESC (not by regens) — no
--     leaderboard, no "worst driver" score. (B219 2b values call.)
--
--   - ATTRIBUTION to the original ticket's DRIVER (via driver_name
--     carried forward by L1's INSERT into the regenerated row).
--     The drift signal is "this driver's work product needed
--     regenerating", regardless of who keyed the fix. Admin/CA
--     regenerates on a driver's ticket correctly reflect on that
--     driver's by_driver row. See the DATA SOURCE section below
--     for the full attribution-shift rationale (post-2026-06-26
--     refactor from audit-caller attribution to FK-based source).
--
--   - UNATTRIBUTED bucket carries count, not filtered away. When
--     violations.driver_name is NULL or empty, COALESCE to
--     '(unattributed)' — same pattern
--     as existing by_driver. An unattributable regenerate is more
--     drift-interesting, not less; name-alignment hygiene is a
--     separate sweep.
--
--   - EXISTING DASHBOARD UNTOUCHED — all 6 widget output keys + 8
--     existing flag CTEs preserved BYTE-IDENTICAL. Layer 4 is
--     additive: 3 new CTEs + 1 new flag CTE + 1 new column on
--     by_driver + 1 new field in the by_driver jsonb output + 1
--     new UNION ALL in the flags array. Section C of verification
--     content-checks the 6 widget keys + 8 flag CTE names. Section
--     E (load-bearing) re-runs the B219 2b 8-flag seed and asserts
--     the headlines are byte-identical to what L2b produced.
--
--   - TIME WINDOW CONSISTENT with the rest of the dashboard:
--     regens count uses v_from/v_to (same as other window
--     metrics); trend windows use 7d/14d (same as driver_14d);
--     spike flag uses 7d/35d (same as void/dispute spikes).
--
-- DATA SOURCE — violations.regenerated_from FK (CHOSEN, 2026-06-26)
-- ─────────────────────────────────────────────────────────────────
-- Three candidates were evaluated (see preflight report):
--   (a) audit_logs WHERE action='VIOLATION_REGENERATED'   ← rejected
--   (b) violations.regenerated_from IS NOT NULL (new row) ← CHOSEN
--   (c) violations.regenerate_reason IS NOT NULL (voided original)
--
-- 2026-06-26 refactor rationale:
--   1. PATTERN MATCH — the existing get_enforcement_insights body
--      sources voids and disputes from per-row columns
--      (violations.voided_at, violations.status='disputed'); it
--      does NOT join audit_logs anywhere. The original Layer 4
--      draft would have been the odd-one-out, importing an audit
--      join shape that no other CTE in this function uses.
--   2. DRIFT-PROOF — regenerated_from is set in the SAME atomic
--      transaction as the regenerate (L1 Step 2's INSERT). If a
--      VIOLATION_REGENERATED audit row write silently fails, the
--      FK is still set. The FK is the fact; the audit log is the
--      record of intent. Use the fact.
--   3. SCHEMA DRIFT AVOIDANCE — audit_logs.record_id is TEXT in
--      production (verified pre-apply 2026-06-26). The (a) approach
--      would have required v.id::TEXT = al.record_id casts on 3
--      join sites; the (b) approach eliminates the join entirely.
--   4. ALREADY INDEXED — L1 added a partial index
--      violations_regenerated_from_idx WHERE regenerated_from IS
--      NOT NULL, so the FILTER (WHERE regenerated_from IS NOT NULL)
--      stays cheap.
--
-- ATTRIBUTION SHIFT (intentional, noted):
--   (a) attributed regenerates to the driver who PERFORMED the
--       regenerate (via audit.user_email → user_roles.name).
--   (b) attributes regenerates to the driver who ISSUED the
--       original (via driver_name carried forward by L1's INSERT).
--
-- At A1 today these are the same person (driver-keyed regenerates
-- on their own tickets). The dashboard signal is unchanged:
-- "this driver's work product needed regenerating" is the drift we
-- care about, regardless of who keyed the fix. If admin/CA later
-- regenerates a driver's ticket, it correctly reflects on that
-- driver's by_driver row (their work needed correction).
--
-- FILTER LOSS (also intentional, noted):
--   (a) included WHERE al.new_values->>'caller_role' = 'driver' to
--       exclude admin "cleanup" regenerates from the drift signal.
--   (b) loses this distinction (would require re-joining audit_logs
--       to recover, defeating the refactor).
--
-- Decision: drop the filter. Admin/CA regenerates on driver tickets
-- still reflect a drift signal worth surfacing. Re-add via a small
-- audit_logs join later if production reveals it as noise.
--
-- The 3 CTEs (regen_by_driver_window, regen_by_driver_14d,
-- flag_regen_spike_driver) now mirror the c_voided / c_disputed /
-- flag_void_spike_driver shapes — same source (violations table),
-- same filter pattern (FILTER WHERE <column> IS NOT NULL), same
-- window discipline (v_from/v_to for window CTE, v_now -INTERVAL
-- for trend/spike CTEs).
--
-- APPLY DISCIPLINE
-- ────────────────
-- 1. Section A → confirm RPC body does NOT yet contain the 3 new
--    CTE/marker strings (proves pre-amendment state). Post-refactor:
--    markers are `regen_by_driver_window`, `flag_regen_spike_driver`,
--    and `regenerated_from IS NOT NULL` (since we no longer reference
--    the VIOLATION_REGENERATED audit action).
-- 2. Apply this file as single paste in SQL Editor
-- 3. Section B → confirm body now contains the new identifiers
-- 4. Section C (load-bearing) → all 8 existing flag CTE names + 6
--    widget output keys still present (additive guard)
-- 5. Section D → grants unchanged (authenticated only)
-- 6. Section E (load-bearing) → JWT-mock as the test CA, call
--    get_enforcement_insights(NULL, NULL, NULL) against the still-
--    seeded B219 2b data, assert all 8 existing flag headlines are
--    byte-identical to the pre-Layer-4 output. regen_spike_driver
--    should NOT fire (the 2b seed inserts zero VIOLATION_REGENERATED
--    audit rows).
-- 7. Section F → SCHEMA_RPC_UPDATED audit row landed
-- 8. Section G (load-bearing) → time-window respect: insert a
--    synthetic VIOLATION_REGENERATED audit row dated > 30 days ago,
--    confirm regens_in_window does NOT include it. Cleanup
--    unconditional.
--
-- UI commit (Insights tab JSX adds regens column + spike flag
-- rendering) ships AFTER this RPC is live + B/C/D/E/F/G green.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.get_enforcement_insights(
  p_property   TEXT        DEFAULT NULL,
  p_date_from  TIMESTAMPTZ DEFAULT NULL,
  p_date_to    TIMESTAMPTZ DEFAULT NULL
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
  v_spike_abs             CONSTANT INTEGER := 5;     -- flags 3+4 + LAYER 4 regen spike
  v_spike_multiplier      CONSTANT NUMERIC := 3.0;   -- flags 3+4 + LAYER 4 regen spike
  v_spike_baseline_min    CONSTANT NUMERIC := 3.0;   -- flags 3+4 + LAYER 4 regen spike per week
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

  -- ── LAYER 4: regen CTEs (sourced from violations.regenerated_from
  --    FK, attributed to the original ticket's driver_name carried
  --    forward by L1's INSERT). No audit_logs join — matches the
  --    established convention in this function (voids/disputes also
  --    source from per-row columns, never audit_logs). See header
  --    DATA SOURCE block for rationale. ────────────────────────────

  -- LAYER 4 — regen_by_driver_window: count of regenerated rows per
  -- driver in the dashboard's display window. Sourced from
  -- scoped_violations (already filtered to v_property_list + v_from/v_to
  -- + is_confirmed). Mirrors the c_voided / c_disputed FILTER shape in
  -- status_pipeline. created_at on the new (regenerated) row is the
  -- regenerate moment (L1's INSERT timestamp; same transaction as the
  -- FK set). driver_name on the new row = original driver carried
  -- forward (intentional — see header note on attribution shift).
  regen_by_driver_window AS (
    SELECT
      COALESCE(NULLIF(trim(driver_name), ''), '(unattributed)') AS driver,
      COUNT(*) AS regens
    FROM scoped_violations
    WHERE regenerated_from IS NOT NULL
    GROUP BY 1
  ),

  -- LAYER 4 — regen_by_driver_14d: current_7d vs prior_7d for the
  -- trend arrow. Independent 14d window (NOT scoped_violations, which
  -- uses dashboard window) — mirrors driver_14d's shape exactly, with
  -- the extra `regenerated_from IS NOT NULL` filter to restrict the
  -- base set to regenerated rows. Pattern-match for flag_void_spike_
  -- driver's `WHERE voided_at IS NOT NULL` discipline.
  regen_by_driver_14d AS (
    SELECT
      COALESCE(NULLIF(trim(driver_name), ''), '(unattributed)') AS driver,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '7 days')  AS regens_current_7d,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '14 days'
                         AND created_at <  v_now - INTERVAL '7 days')  AS regens_prior_7d
    FROM public.violations
    WHERE property = ANY(v_property_list)
      AND is_confirmed = TRUE
      AND regenerated_from IS NOT NULL
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
      -- LAYER 4: regenerate count attributed by audit caller (NOT
      -- by the violation's driver_name field). r.regens may be NULL
      -- for drivers who issued violations in the window but didn't
      -- perform any regenerates — COALESCE to 0.
      --
      -- EDGE CASE (acceptable for v1): a driver who performed
      -- regenerates in the window but did NOT issue any violations
      -- in this window won't appear in by_driver at all — the
      -- bucket source is scoped_violations (issuance activity).
      -- Their regen activity still drives the spike flag if firing.
      COALESCE(r.regens, 0)                                                       AS regens,
      CASE
        WHEN COALESCE(d.total_14d, 0) < v_trend_min_volume THEN NULL
        WHEN COALESCE(d.disputes_current_7d, 0) >= COALESCE(d.disputes_prior_7d, 0) + v_trend_min_delta
          THEN 'rising_disputes'
        WHEN COALESCE(d.voids_current_7d, 0)    >= COALESCE(d.voids_prior_7d, 0)    + v_trend_min_delta
          THEN 'rising_voids'
        -- LAYER 4: rising_regens — appended LAST so existing
        -- disputes/voids trend priorities are preserved. Regenerates
        -- produce voids (L1's void-first ordering) so rising_voids
        -- often co-occurs and dominates; the explicit regens column
        -- still tells the count even when trend reads rising_voids.
        WHEN COALESCE(r14.regens_current_7d, 0) >= COALESCE(r14.regens_prior_7d, 0) + v_trend_min_delta
          THEN 'rising_regens'
        ELSE NULL
      END AS trend
    FROM scoped_violations sv
    LEFT JOIN driver_14d d
      ON d.driver = COALESCE(NULLIF(trim(sv.driver_name), ''), '(unattributed)')
    LEFT JOIN regen_by_driver_window r
      ON r.driver = COALESCE(NULLIF(trim(sv.driver_name), ''), '(unattributed)')
    LEFT JOIN regen_by_driver_14d r14
      ON r14.driver = COALESCE(NULLIF(trim(sv.driver_name), ''), '(unattributed)')
    GROUP BY 1,
      d.total_14d, d.disputes_current_7d, d.disputes_prior_7d, d.voids_current_7d, d.voids_prior_7d,
      r.regens, r14.regens_current_7d, r14.regens_prior_7d
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
  ),

  -- ── LAYER 4 FLAG: regen_spike_driver (amber, per-driver only)
  -- Mirrors flag_void_spike_driver shape EXACTLY — same source
  -- (violations table), same WHERE-clause-narrowed-then-FILTER
  -- pattern, same baseline guards, same HAVING formula. Only diff:
  -- `regenerated_from IS NOT NULL` substitutes for `voided_at IS
  -- NOT NULL`. Per-driver only (not per-property) — a property
  -- doesn't regenerate; a driver does.
  flag_regen_spike_driver AS (
    SELECT
      COALESCE(NULLIF(trim(driver_name), ''), '(unattributed)') AS driver,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '7 days')  AS current_7d,
      COUNT(*) FILTER (WHERE created_at >= v_now - INTERVAL '35 days'
                         AND created_at <  v_now - INTERVAL '7 days')  AS trailing_28d
    FROM public.violations
    WHERE property = ANY(v_property_list)
      AND is_confirmed = TRUE
      AND regenerated_from IS NOT NULL
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
        'regens',     regens,         -- LAYER 4 (new field; additive)
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

        UNION ALL
        -- LAYER 4: regen_spike_driver (amber, per-driver only) ──
        SELECT jsonb_build_object(
          'severity',      'amber',
          'severity_rank', 1,
          'code',          'regen_spike_driver',
          'window_label',  'Last 7 days',
          'headline',      format('Regenerate spike · %s · %s in 7 days', driver, current_7d),
          'detail',        jsonb_build_object('driver', driver, 'current_7d', current_7d, 'trailing_28d', trailing_28d)
        )
        FROM flag_regen_spike_driver
      ) AS all_flags
    )
  ) INTO v_result;

  RETURN v_result;
END;
$func$;

-- ── Grants ──────────────────────────────────────────────────────────
-- CREATE OR REPLACE preserves grants; re-affirm defensively per the
-- established discipline (Supabase default-privilege drift).
REVOKE EXECUTE ON FUNCTION public.get_enforcement_insights(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_enforcement_insights(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_enforcement_insights(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- Audit row recording the amendment ships.
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_UPDATED',
  'enforcement_insights',
  NULL,
  jsonb_build_object(
    'rpc',         'get_enforcement_insights',
    'migration',   '20260628_enforcement_insights_layer_4_regen_metric',
    'change',      'Layer 4: added regen-count column + rising_regens trend + flag_regen_spike_driver',
    'additive',    TRUE,
    'invariant',   'All 6 widget output keys + 8 existing flag CTEs preserved; behavioral regression-guard in verification Section E re-runs B219 2b 8-flag seed; E.2 positively proves live-path firing via L1 RPC fixture',
    'source',      'violations.regenerated_from FK (per-row column set atomically by L1 regenerate_tow_ticket INSERT); attribution via driver_name carried forward to the new row; no audit_logs join (matches existing void/dispute pattern in this function)'
  ),
  now()
);

COMMIT;

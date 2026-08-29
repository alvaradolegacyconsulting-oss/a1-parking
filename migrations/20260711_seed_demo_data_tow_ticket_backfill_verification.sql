-- ═══════════════════════════════════════════════════════════════════
-- Verify — 20260711_seed_demo_data_tow_ticket_backfill.sql
-- Paste in Supabase SQL Editor AFTER the backfill migration applies.
-- Each block returns 1 row; every 'ok' column must be TRUE.
-- ═══════════════════════════════════════════════════════════════════

-- ── VQ1: 12 demo violations now carry tow_ticket_generated=TRUE ──
-- (Includes TX2JHN45 which is BOTH towed and voided — kept for
-- audit-trail realism. This VQ counts the raw column, not the
-- widget-scoped count.)
SELECT
  COUNT(*) FILTER (WHERE tow_ticket_generated = TRUE) AS towed_count,
  COUNT(*) FILTER (WHERE tow_ticket_generated = TRUE) = 12 AS ok
  FROM public.violations
 WHERE driver_name = 'Demo Driver';

-- ── VQ2: The 12 towed rows are the expected plates+statuses ──────
SELECT
  string_agg(plate || ':' || status, ', ' ORDER BY plate, status) AS towed_rows,
  COUNT(*) = 12 AS ok
  FROM public.violations
 WHERE driver_name = 'Demo Driver'
   AND tow_ticket_generated = TRUE;
-- Expected (alphabetical): TX0PXH52:resolved, TX0RSY93:tow_ticket,
-- TX2JHN45:resolved, TX3GBP54:tow_ticket, TX3TWQ29:tow_ticket,
-- TX5WMR86:disputed, TX6NVT48:tow_ticket, TX6VCR78:tow_ticket,
-- TX6WXP38:tow_ticket, TX7BLD56:resolved, TX7LMS29:tow_ticket,
-- TX9QDF63:tow_ticket

-- ── VQ3: Storage/fee columns populated on all 12 ────────────────
-- tow_fee is a TEXT column; cast to numeric so the equality
-- doesn't depend on formatting drift ('275.00' vs '275' etc).
SELECT
  COUNT(*)                                                  AS towed_total,
  COUNT(*) FILTER (WHERE tow_ticket_generated_at IS NOT NULL) AS with_stamp,
  COUNT(*) FILTER (WHERE tow_storage_name    = 'Demo Tow Yard') AS with_name,
  COUNT(*) FILTER (WHERE tow_storage_address = '9200 Industrial Row, Houston, TX 77048') AS with_addr,
  COUNT(*) FILTER (WHERE tow_storage_phone   = '713-555-0142') AS with_phone,
  COUNT(*) FILTER (WHERE tow_fee::numeric = 275.00)            AS with_fee,
  (COUNT(*) = 12
   AND COUNT(*) FILTER (WHERE tow_ticket_generated_at IS NOT NULL) = 12
   AND COUNT(*) FILTER (WHERE tow_storage_name    = 'Demo Tow Yard') = 12
   AND COUNT(*) FILTER (WHERE tow_storage_address = '9200 Industrial Row, Houston, TX 77048') = 12
   AND COUNT(*) FILTER (WHERE tow_storage_phone   = '713-555-0142') = 12
   AND COUNT(*) FILTER (WHERE tow_fee::numeric = 275.00) = 12) AS ok
  FROM public.violations
 WHERE driver_name = 'Demo Driver'
   AND tow_ticket_generated = TRUE;

-- ── VQ4: tow_rate_pct via the widget's exact formula ────────────
-- REPORT — no hardcoded target. The widget formula excludes voided
-- rows from BOTH numerator and denominator. Structural assertions:
--   • rate > 0             — the original symptom (0%) is gone
--   • 25% <= rate <= 55%   — plausible range for a demo portfolio
--   • every status='tow_ticket' row has tow_ticket_generated=TRUE
--     (the invariant that was broken pre-backfill — a tow_ticket
--     status with generated=FALSE is unreachable in production)
-- Whatever the tile displays, Jose confirms it matches tow_rate_pct
-- below.
WITH scoped AS (
  SELECT * FROM public.violations
   WHERE driver_name = 'Demo Driver' AND voided_at IS NULL
),
computed AS (
  SELECT
    COUNT(*)                                            AS non_voided_total,
    COUNT(*) FILTER (WHERE tow_ticket_generated = TRUE) AS towed_non_voided,
    ROUND(100.0 * COUNT(*) FILTER (WHERE tow_ticket_generated = TRUE)
          / NULLIF(COUNT(*), 0), 1)                     AS tow_rate_pct
    FROM scoped
),
status_invariant AS (
  SELECT COUNT(*) AS violators
    FROM public.violations
   WHERE driver_name = 'Demo Driver'
     AND status = 'tow_ticket'
     AND tow_ticket_generated IS DISTINCT FROM TRUE
)
SELECT
  c.non_voided_total,
  c.towed_non_voided,
  c.tow_rate_pct,
  si.violators                                   AS status_tow_ticket_without_generated,
  (c.tow_rate_pct > 0
   AND c.tow_rate_pct BETWEEN 25 AND 55
   AND si.violators = 0)                         AS ok
  FROM computed c CROSS JOIN status_invariant si;

-- ── VQ5: No production violation was touched by the backfill ─────
-- Belt-and-suspenders — literal 'Demo Driver' is unique to the seed,
-- but confirm no cross-tenant tow columns got stamped in error.
SELECT
  COUNT(*)                             AS non_demo_towed_today,
  COUNT(*) = 0                         AS ok
  FROM public.violations v
 WHERE v.driver_name IS DISTINCT FROM 'Demo Driver'
   AND v.tow_storage_address = '9200 Industrial Row, Houston, TX 77048';

-- ── VQ6: Idempotency — no rows are candidates for a second apply ─
SELECT
  COUNT(*)                             AS candidates_for_reapply,
  COUNT(*) = 0                         AS ok
  FROM public.violations v
 WHERE v.driver_name = 'Demo Driver'
   AND (v.tow_ticket_generated IS NOT TRUE)
   AND (
        (v.plate = 'TX6WXP38' AND v.status = 'tow_ticket')
     OR (v.plate = 'TX3GBP54' AND v.status = 'tow_ticket')
     OR (v.plate = 'TX0RSY93' AND v.status = 'tow_ticket')
     OR (v.plate = 'TX3TWQ29' AND v.status = 'tow_ticket')
     OR (v.plate = 'TX7LMS29' AND v.status = 'tow_ticket')
     OR (v.plate = 'TX6VCR78' AND v.status = 'tow_ticket')
     OR (v.plate = 'TX9QDF63' AND v.status = 'tow_ticket')
     OR (v.plate = 'TX6NVT48' AND v.status = 'tow_ticket')
     OR (v.plate = 'TX7BLD56' AND v.status = 'resolved')
     OR (v.plate = 'TX2JHN45' AND v.status = 'resolved')
     OR (v.plate = 'TX0PXH52' AND v.status = 'resolved')
     OR (v.plate = 'TX5WMR86' AND v.status = 'disputed')
   );

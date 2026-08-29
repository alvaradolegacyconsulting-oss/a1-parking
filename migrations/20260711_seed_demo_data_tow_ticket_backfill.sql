-- ═══════════════════════════════════════════════════════════════════
-- Backfill — Demo tow_ticket_generated on 12 existing violations
-- 2026-07-11 · Task 2 (Tow Rate = 0% fix)
-- ═══════════════════════════════════════════════════════════════════
--
-- WHY
--   seed_demo_data() v1 created 30 demo violations, 8 of which carry
--   status='tow_ticket'. The Enforcement Insights tow_rate_pct widget
--   reads the tow_ticket_generated BOOLEAN column (not the status
--   string) — that column was never populated by the seed, so the
--   CA Enforcement Insights card shows Tow Rate = 0%.
--
--   This migration:
--     (1) Companion patch in seed_demo_data_rpc.sql (same commit)
--         adds a should_tow BOOLEAN column to the VALUES tuple + a
--         conditional INSERT block. Fixes future re-seeds.
--     (2) THIS FILE backfills the 12 live rows so today's demo
--         portfolio shows a realistic 40% tow rate immediately —
--         no need to wipe/re-seed just for the widget.
--
-- WHICH 12 ROWS (40% of 30 total)
--   • 8 status='tow_ticket'  — all 8 currently-open tow orders
--   • 3 status='resolved'    — post-tow resolved (owner paid & left)
--       └ 1 of these is TX2JHN45 (voided-after-tow — audit trail
--         showing wrongful-tow that PM voided after the fact; kept
--         for storytelling realism).
--   • 1 status='disputed'    — post-tow dispute (customer contesting
--       a completed tow — TX5WMR86). The other disputed row
--       (TX4YKB33) stays non-towed (dispute over a warning ticket).
--
--   All 12 receive the same storage/fee values as the seed patch:
--     tow_ticket_generated_at = created_at + 2h
--     tow_storage_name        = 'Demo Tow Yard'
--     tow_storage_address     = '9200 Industrial Row, Houston, TX 77048'
--     tow_storage_phone       = '713-555-0142'
--     tow_fee                 = 275.00
--
-- SAFETY
--   • Scope guarded by BOTH driver_name='Demo Driver' AND the exact
--     property/plate/status triple that seed_demo_data() writes.
--     driver_name='Demo Driver' is unique to the demo seed — no
--     real customer row will carry that literal value.
--   • Idempotent: WHERE tow_ticket_generated IS NOT TRUE — re-running
--     is a no-op on already-backfilled rows.
--   • No writes outside company_env='demo' — the plate list only
--     resolves to the Demo Company's violations.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- Sanity-check: refuse to run if any of the 12 target plates resolves
-- to more than one Demo violation (should not happen — driver_name
-- 'Demo Driver' + property triple is unique in the seed, but
-- belt-and-suspenders since we're writing to a shared table).
DO $check$
DECLARE
  v_dup INT;
BEGIN
  SELECT COUNT(*) INTO v_dup
    FROM (
      SELECT plate, property, status, COUNT(*) AS n
        FROM public.violations
       WHERE driver_name = 'Demo Driver'
         AND (
              (plate = 'TX6WXP38' AND status = 'tow_ticket')
           OR (plate = 'TX3GBP54' AND status = 'tow_ticket')
           OR (plate = 'TX0RSY93' AND status = 'tow_ticket')
           OR (plate = 'TX3TWQ29' AND status = 'tow_ticket')
           OR (plate = 'TX7LMS29' AND status = 'tow_ticket')
           OR (plate = 'TX6VCR78' AND status = 'tow_ticket')
           OR (plate = 'TX9QDF63' AND status = 'tow_ticket')
           OR (plate = 'TX6NVT48' AND status = 'tow_ticket')
           OR (plate = 'TX7BLD56' AND status = 'resolved')
           OR (plate = 'TX2JHN45' AND status = 'resolved')
           OR (plate = 'TX0PXH52' AND status = 'resolved')
           OR (plate = 'TX5WMR86' AND status = 'disputed')
         )
       GROUP BY plate, property, status
      HAVING COUNT(*) > 1
    ) dup;
  IF v_dup > 0 THEN
    RAISE EXCEPTION 'Backfill refused: % target (plate,property,status) triples have duplicates. Investigate before re-running.', v_dup;
  END IF;
END $check$;

-- ── The backfill ─────────────────────────────────────────────────
UPDATE public.violations v
   SET tow_ticket_generated    = TRUE,
       tow_ticket_generated_at = v.created_at + INTERVAL '2 hours',
       tow_storage_name        = 'Demo Tow Yard',
       tow_storage_address     = '9200 Industrial Row, Houston, TX 77048',
       tow_storage_phone       = '713-555-0142',
       tow_fee                 = 275.00
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

COMMIT;

-- ═══════════════════════════════════════════════════════════════════
-- 🧪 B219 Layer 2b — UAT FLAG SEED (NOT APPLIED TO PROD AT LAUNCH)
--    This file inserts synthetic violations + properties to make
--    every B219 Layer 2b flag fire EXACTLY ONCE during UAT.
--
--    APPLY: before the UAT sitting, AFTER the RPC migration is live.
--    WIPE:  by the pre-launch data wipe (sentinel-tagged rows only).
--
--    DO NOT leave this seed in production. It is launch-blocking
--    if not wiped — the seed rows would surface as real violations
--    in CA dashboards and (worse) the seed driver names + plates
--    would appear in any aggregate the operator looks at.
-- ═══════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS
-- ────────────────────
-- B219 Layer 2b's flag heuristics are calibrated for an established
-- operation (Jose's call: quiet-and-right beats noisy-and-wrong).
-- That correctness means A1's real pre-launch data will NOT trip the
-- flags during UAT — the "Needs attention" strip would be empty, and
-- UAT would validate rendering but never see a flag actually FIRE.
-- The flags are the dashboard's differentiator; they can't ship
-- proven by code-reading alone.
--
-- This seed inserts the minimum crafted rows to clear each flag's
-- thresholds + noise guards, against the constants hardcoded in
-- get_enforcement_insights. One cluster per flag, all sentinel-
-- tagged for clean wipe.
--
-- ═══════════════════════════════════════════════════════════════════
-- EXACT HEADLINES UAT SHOULD EXPECT IN THE "NEEDS ATTENTION" STRIP
-- ═══════════════════════════════════════════════════════════════════
--
--   RED FLAGS (sort first in the strip):
--   ────────────────────────────────────
--   1. Accuracy slipping · __b219_uat_seed_driver_slipping__ · 16.7% dispute rate (2 of 12)
--   2. 11 open tickets aging past 30 days · __b219_uat_seed_a__ worst
--
--   AMBER FLAGS:
--   ────────────
--   3. Dispute spike · __b219_uat_seed_a__ · 6 in 7 days
--   3b. Dispute spike · __b219_uat_seed_driver_disp_spike__ · 6 in 7 days
--   4. Void spike · __b219_uat_seed_a__ · 6 in 7 days
--   4b. Void spike · __b219_uat_seed_driver_void_spike__ · 6 in 7 days
--   5. Coverage gap · __b219_uat_seed_b__ · 1 in last 7d vs 6.0/wk avg
--   6. 5 tow tickets stuck unchanged >14 days
--
-- Note: flag 3 and flag 4 fire BOTH a property-row AND a driver-row
-- (different `code` values in the RPC: dispute_spike_property +
-- dispute_spike_driver, etc.). That's by design — same event surfaces
-- via two lenses. UAT should expect 8 flag rows total (2 red + 6 amber).
--
-- Additionally, the dispute-spike driver row should ALSO show
-- 'rising_disputes' trend arrow in the by_driver widget. The void-spike
-- driver similarly shows 'rising_voids'.
--
-- ═══════════════════════════════════════════════════════════════════
-- SUMMARY CHIPS UAT SHOULD EXPECT (post-residue-cleanup, seed-only)
-- ═══════════════════════════════════════════════════════════════════
-- Checklist corrected pre-UAT 2026-06-25 (Jose):
--
--   total_violations:  ~47 (in-window non-voided count).
--                       The summary RESPECTS the default 30d display
--                       window — so these seed rows correctly fall out:
--                         flag 2's 11 aging rows (created 35d ago,
--                           outside 30d window)
--                         flag 5's last trailing-baseline row (i=24
--                           at 31d ago, also outside 30d)
--                         flag 4's 6 voided rows (excluded by the
--                           voided_at filter)
--                       Composition of the ~47:
--                         12 (flag 1) + 6 (flag 3) + 24 (flag 5
--                         in-window: 23 trailing days 8-30 + 1
--                         UAT5LAST) + 5 (flag 6) = 47
--                       Earlier draft said 65 (raw seed row count) —
--                       that was wrong; the dashboard summary is
--                       window-filtered, not raw.
--
--   tow_rate_pct:      Small positive — Jose measured ~9% in clean
--                       run. Driven by stuck-tow rows (flag 6, 5
--                       rows of status='tow_ticket') interacting
--                       with the tow_ticket_generated metric.
--                       Earlier draft said 0 — that was wrong;
--                       confirm against actual seed-only run.
--
--   visitor_passes:    0 (the seed deliberately inserts no visitor
--                       passes; any nonzero reading means residue
--                       remains under the test company — see TRACK 1
--                       cleanup if cleanup hasn't been run yet).
--
-- ═══════════════════════════════════════════════════════════════════
-- APPLY DISCIPLINE
-- ════════════════
--   1. Confirm B219 Layer 2b RPC is live in prod first (sections A–G
--      of the verification file all green).
--   2. EDIT v_company below to match the test CA login's company.
--   3. Apply this file in a single paste.
--   4. CA logs in, navigates to Insights tab, screenshots the
--      "Needs attention" strip; confirms each of the 8 expected
--      flag rows appears with matching headlines.
--   5. After UAT sign-off: run cleanup at the bottom of this file
--      (or wait for pre-launch wipe).
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

DO $b219_uat_seed$
DECLARE
  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ ⚠ UAT OPERATOR: EDIT THIS LINE to match the CA test    ║
  -- ║   login's company. Without this, the company-scope     ║
  -- ║   predicate in the RPC won't include the seed rows     ║
  -- ║   and the flags won't fire for that CA.                 ║
  -- ╚══════════════════════════════════════════════════════════╝
  v_company TEXT := 'Demo Towing LLC';   -- ← EDIT THIS

  -- ── Sentinel-tagged identifiers ─────────────────────────────
  v_prop_a            CONSTANT TEXT := '__b219_uat_seed_a__';
  v_prop_b            CONSTANT TEXT := '__b219_uat_seed_b__';
  v_prop_c            CONSTANT TEXT := '__b219_uat_seed_c__';
  v_driver_slipping   CONSTANT TEXT := '__b219_uat_seed_driver_slipping__';
  v_driver_aging      CONSTANT TEXT := '__b219_uat_seed_driver_aging__';
  v_driver_disp_spike CONSTANT TEXT := '__b219_uat_seed_driver_disp_spike__';
  v_driver_void_spike CONSTANT TEXT := '__b219_uat_seed_driver_void_spike__';
  v_driver_coverage   CONSTANT TEXT := '__b219_uat_seed_driver_coverage__';
  v_driver_stuck      CONSTANT TEXT := '__b219_uat_seed_driver_stuck__';
  v_sentinel_address  CONSTANT TEXT := '__b219_uat_seed_address__';
  v_now               CONSTANT TIMESTAMPTZ := now();

  i INTEGER;
BEGIN
  -- ── 0a. Defensive pre-clean (idempotent re-apply safety) ────
  -- The properties table may not carry a UNIQUE constraint on name,
  -- so ON CONFLICT (name) DO NOTHING errors with "no unique or
  -- exclusion constraint matching the ON CONFLICT specification."
  -- Instead: pre-clean sentinel-tagged rows so a re-run of this
  -- file always lands in the same state. Violations deleted first
  -- (no FK to properties; conventional order anyway).
  --
  -- TIGHT predicate: by sentinel PROPERTY ONLY. Earlier draft also
  -- DELETEd WHERE plate LIKE 'UAT%' — removed per Jose pre-apply
  -- 2026-06-25: redundant (sentinel properties already catch every
  -- seed row) and over-broad (would nuke any non-seed test plate
  -- prefixed UAT, real blast risk on prod).
  DELETE FROM public.violations WHERE property LIKE '__b219_uat_seed_%';
  DELETE FROM public.properties WHERE name     LIKE '__b219_uat_seed_%';

  -- ── 0b. Seed properties (3) ─────────────────────────────────
  -- Each tied to v_company so the RPC's company-scope predicate
  -- (properties.company ~~* v_caller_company) returns them.
  INSERT INTO public.properties (name, company, address, is_active)
  VALUES
    (v_prop_a, v_company, v_sentinel_address, TRUE),
    (v_prop_b, v_company, v_sentinel_address, TRUE),
    (v_prop_c, v_company, v_sentinel_address, TRUE);

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ FLAG 1 — accuracy_slipping                              ║
  -- ║   Trigger: dispute_rate > 8% OR void_rate > 10%, ≥10   ║
  -- ║            violations in last 30d                       ║
  -- ║   Seed:    12 violations (driver_slipping, prop A),    ║
  -- ║            2 disputed → 16.7% > 8% ✓                    ║
  -- ║   Dispute timing: days 20-25 ago (outside 7d spike     ║
  -- ║                   window, inside 30d accuracy window). ║
  -- ╚══════════════════════════════════════════════════════════╝
  FOR i IN 1..12 LOOP
    INSERT INTO public.violations (
      plate, violation_type, property, driver_name,
      is_confirmed, status, created_at
    ) VALUES (
      'UAT1' || LPAD(i::TEXT, 3, '0'),
      'overnight',
      v_prop_a,
      v_driver_slipping,
      TRUE,
      CASE WHEN i <= 2 THEN 'disputed' ELSE 'new' END,
      -- spread across last 28d; disputes go in days 20-25 ago
      v_now - (CASE WHEN i <= 2 THEN 20 ELSE (i + 3) END || ' days')::INTERVAL
    );
  END LOOP;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ FLAG 2 — tickets_aging_out                              ║
  -- ║   Trigger: open tickets >30d old, count ≥10            ║
  -- ║   Seed:    11 violations (driver_aging, prop A),       ║
  -- ║            created 35d ago, status='new', not voided    ║
  -- ╚══════════════════════════════════════════════════════════╝
  FOR i IN 1..11 LOOP
    INSERT INTO public.violations (
      plate, violation_type, property, driver_name,
      is_confirmed, status, created_at
    ) VALUES (
      'UAT2' || LPAD(i::TEXT, 3, '0'),
      'overnight',
      v_prop_a,
      v_driver_aging,
      TRUE,
      'new',
      v_now - INTERVAL '35 days'
    );
  END LOOP;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ FLAG 3 — dispute_spike (per-property + per-driver)     ║
  -- ║   Trigger: ≥5 disputes in last 7d at a property/driver ║
  -- ║   Seed:    6 disputed violations in last 7d at prop A  ║
  -- ║            (driver_disp_spike) → fires BOTH the         ║
  -- ║            property AND driver flag rows                ║
  -- ║   Bonus:   by_driver widget shows 'rising_disputes'    ║
  -- ║            arrow for this driver (6 current 7d vs 0     ║
  -- ║            prior 7d, ≥5 total 14d).                     ║
  -- ╚══════════════════════════════════════════════════════════╝
  FOR i IN 1..6 LOOP
    INSERT INTO public.violations (
      plate, violation_type, property, driver_name,
      is_confirmed, status, created_at
    ) VALUES (
      'UAT3' || LPAD(i::TEXT, 3, '0'),
      'overnight',
      v_prop_a,
      v_driver_disp_spike,
      TRUE,
      'disputed',
      v_now - (i || ' days')::INTERVAL   -- 1-6 days ago
    );
  END LOOP;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ FLAG 4 — void_spike (per-property + per-driver)        ║
  -- ║   Trigger: ≥5 voids in last 7d at a property/driver    ║
  -- ║   Seed:    6 voided violations in last 7d at prop A    ║
  -- ║            (driver_void_spike)                          ║
  -- ║   Bonus:   by_driver widget shows 'rising_voids'        ║
  -- ║            arrow for this driver.                       ║
  -- ╚══════════════════════════════════════════════════════════╝
  FOR i IN 1..6 LOOP
    INSERT INTO public.violations (
      plate, violation_type, property, driver_name,
      is_confirmed, status, created_at,
      voided_at, voided_by_email, voided_by_role, void_reason
    ) VALUES (
      'UAT4' || LPAD(i::TEXT, 3, '0'),
      'overnight',
      v_prop_a,
      v_driver_void_spike,
      TRUE,
      'new',
      v_now - ((i + 7) || ' days')::INTERVAL,   -- created 8-13d ago
      v_now - (i || ' days')::INTERVAL,         -- voided 1-6d ago
      'uat_seed@example.com',
      'company_admin',
      'b219_uat_seed_void_spike'
    );
  END LOOP;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ FLAG 5 — coverage_gap (per-property)                    ║
  -- ║   Trigger: last 7d violations < 25% of trailing-4wk    ║
  -- ║            weekly avg; baseline ≥5/wk                   ║
  -- ║   Seed:    Property B with 24 violations spread across ║
  -- ║            days 8-35 ago (= 6/wk trailing baseline,     ║
  -- ║            clears 5/wk min) + 1 violation in last 7d   ║
  -- ║            → 1 / 6 = 16.7% < 25% ✓                      ║
  -- ║   Note:    Per-property only; driver_coverage shown so ║
  -- ║            the rows attribute readably in by_driver.    ║
  -- ╚══════════════════════════════════════════════════════════╝
  -- 24 trailing violations: 6/week × 4 weeks, spaced across days 8-35.
  FOR i IN 1..24 LOOP
    INSERT INTO public.violations (
      plate, violation_type, property, driver_name,
      is_confirmed, status, created_at
    ) VALUES (
      'UAT5' || LPAD(i::TEXT, 3, '0'),
      'overnight',
      v_prop_b,
      v_driver_coverage,
      TRUE,
      'new',
      -- spread across days 8-35: every ~1.13 days
      v_now - ((8 + (i - 1)) || ' days')::INTERVAL
    );
  END LOOP;
  -- 1 violation in last 7d (the coverage-gap signal)
  INSERT INTO public.violations (
    plate, violation_type, property, driver_name,
    is_confirmed, status, created_at
  ) VALUES (
    'UAT5LAST',
    'overnight',
    v_prop_b,
    v_driver_coverage,
    TRUE,
    'new',
    v_now - INTERVAL '3 days'
  );

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ FLAG 6 — stuck_tow_tickets                              ║
  -- ║   Trigger: status='tow_ticket' AND voided_at IS NULL    ║
  -- ║            AND COALESCE(status_changed_at, created_at) ║
  -- ║            < NOW() - 14d, count ≥5                      ║
  -- ║   Seed:    5 tow_ticket violations (driver_stuck,      ║
  -- ║            prop C), created 20d ago, status_changed_at  ║
  -- ║            left NULL (= COALESCE falls back to          ║
  -- ║            created_at; 20d > 14d ✓). Tests the fallback ║
  -- ║            path explicitly.                              ║
  -- ╚══════════════════════════════════════════════════════════╝
  FOR i IN 1..5 LOOP
    INSERT INTO public.violations (
      plate, violation_type, property, driver_name,
      is_confirmed, status, status_changed_at, created_at
    ) VALUES (
      'UAT6' || LPAD(i::TEXT, 3, '0'),
      'overnight',
      v_prop_c,
      v_driver_stuck,
      TRUE,
      'tow_ticket',
      NULL,                                       -- explicit fallback test
      v_now - INTERVAL '20 days'
    );
  END LOOP;

  RAISE NOTICE 'UAT SEED COMPLETE — 65 violations + 3 properties inserted under company %', v_company;
  RAISE NOTICE 'Navigate to CA → Insights tab. Expect 8 flag rows (2 red + 6 amber).';
  RAISE NOTICE 'Cleanup query at the bottom of this file (or wait for pre-launch wipe).';
END;
$b219_uat_seed$;

COMMIT;


-- ═══════════════════════════════════════════════════════════════════
-- 🧹 CLEANUP (run AFTER UAT sign-off; idempotent)
-- ═══════════════════════════════════════════════════════════════════
-- Sentinel-prefixed wipe — removes seed rows ONLY, no real data risk.
-- Subset of the pre-launch full wipe (which removes ALL test rows by
-- property/plate/driver_name patterns; this is just the B219 2b subset).
--
-- Run as a separate statement after UAT sign-off:

/*
BEGIN;
-- Tight predicate: sentinel PROPERTY only. Earlier draft also DELETEd
-- WHERE plate LIKE 'UAT%' — removed per Jose pre-apply 2026-06-25
-- (redundant + over-broad; would nuke any non-seed test plate on prod).
DELETE FROM public.violations  WHERE property  LIKE '__b219_uat_seed_%';       -- 65 rows
DELETE FROM public.properties  WHERE name      LIKE '__b219_uat_seed_%';       -- 3 rows
COMMIT;

-- Verify wipe (should both be 0):
SELECT COUNT(*) AS remaining_seed_violations FROM public.violations WHERE property LIKE '__b219_uat_seed_%';
SELECT COUNT(*) AS remaining_seed_properties FROM public.properties WHERE name     LIKE '__b219_uat_seed_%';
*/

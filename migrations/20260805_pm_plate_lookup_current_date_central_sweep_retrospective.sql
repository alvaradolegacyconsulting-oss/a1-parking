-- ══════════════════════════════════════════════════════════════════════
-- 20260805_pm_plate_lookup_current_date_central_sweep_retrospective.sql
-- PRE-APPLY DIAGNOSTIC (Jose runs FIRST, read-only).
-- Zero rows is the expected outcome. Any row = incident triage, halt.
-- ══════════════════════════════════════════════════════════════════════
--
-- Why this file exists:
--
-- The August 3 retrospective covered up to Aug 3 and found zero
-- boundary-day tows across the 4 Test Legacy Property authorizations.
-- This re-run covers Aug 3 → now (2 days) in case Green Acres or
-- Test Legacy used the guest-auth feature in the interim.
--
-- Run this BEFORE 20260805_pm_plate_lookup_current_date_central_sweep.sql
-- applies. If it returns rows, DO NOT APPLY — the fix would remove
-- the bug that produced the tow, and we need to know about the tow
-- before the record gets harder to reason about.
--
-- Ancillary query at the bottom is time-of-day dependent — see the
-- deploy-before-7pm-Central rule in the migration header. If we
-- deploy before 7pm Central, both counts are structurally zero and
-- the ancillary is moot.
--
-- No side effects. No probe rows. Safe to run repeatedly.
-- ══════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════
-- QUERY 1 — Boundary-day retrospective, Aug 1 → now
--
-- Any row = a tow taken against a plate whose guest_authorization
-- was actually live in Central-time terms on the tow-day.
-- ══════════════════════════════════════════════════════════════════════
WITH win AS (
  SELECT '2026-08-01'::timestamptz AS start_utc, now() AS end_utc
),
active_grants AS (
  -- Guest authorizations that were (or are) live inside the window.
  -- Includes revoked/expired grants whose window overlaps the window.
  SELECT ga.*
  FROM public.guest_authorizations ga, win
  WHERE ga.is_active = TRUE
    AND ga.status    = 'active'
    AND ga.created_at <  win.end_utc
    AND ga.end_date  >= (win.start_utc AT TIME ZONE 'America/Chicago')::date
),
tows AS (
  -- Non-voided tow-ticket-generated violations inside the window.
  -- Column list matches actual violations schema (no `company` column;
  -- checked 2026-08-05 via information_schema after Jose's 42703 hit).
  SELECT
    v.id,
    v.created_at,
    v.plate,
    v.property,
    (v.created_at AT TIME ZONE 'America/Chicago')::DATE                     AS tow_date_central,
    EXTRACT(HOUR FROM (v.created_at AT TIME ZONE 'America/Chicago'))::int   AS tow_hour_central
  FROM public.violations v, win
  WHERE v.tow_ticket_generated = TRUE
    AND v.voided_at IS NULL
    AND v.created_at >= win.start_utc
    AND v.created_at <  win.end_utc
),
suspects AS (
  SELECT
    t.id                                          AS violation_id,
    t.created_at                                  AS violation_at_utc,
    (t.created_at AT TIME ZONE 'America/Chicago') AS violation_at_central,
    t.plate                                       AS ticket_plate,
    t.property                                    AS ticket_property,
    ga.id                                         AS guest_auth_id,
    ga.plate                                      AS ga_plate,
    ga.property                                   AS ga_property,
    ga.guest_name,
    ga.visiting_unit,
    ga.start_date                                 AS ga_start_date,
    ga.end_date                                   AS ga_end_date,
    ga.created_at                                 AS ga_created_at,
    CASE
      WHEN ga.end_date   =  t.tow_date_central     AND t.tow_hour_central >= 19
        THEN 'DENIED on last authorized day (end-edge bug — the tow-risk case)'
      WHEN ga.start_date =  t.tow_date_central + 1 AND t.tow_hour_central >= 19
        THEN 'ADMITTED early (start-edge fail-open — should not produce a tow, but flag if it did)'
    END                                           AS defect_side
  FROM tows t
  JOIN active_grants ga
    ON ga.property ILIKE t.property
   AND UPPER(regexp_replace(ga.plate, '[^A-Z0-9]', '', 'gi'))
     = UPPER(regexp_replace(t.plate,  '[^A-Z0-9]', '', 'gi'))
  WHERE (ga.end_date   =  t.tow_date_central     AND t.tow_hour_central >= 19)
     OR (ga.start_date =  t.tow_date_central + 1 AND t.tow_hour_central >= 19)
)
SELECT * FROM suspects
ORDER BY violation_at_utc DESC;


-- ══════════════════════════════════════════════════════════════════════
-- QUERY 2 (ANCILLARY) — What flips at deploy time?
--
-- Time-of-day dependent. Only meaningful if this is run within an hour
-- of the intended deploy time AND that deploy time is post-7pm Central.
-- If deploying before 7pm Central per the migration's timing rule,
-- both counts are structurally zero — the ancillary is moot.
--
-- Non-zero results:
--   • col 1 = active grants that will FLIP FROM admitted TO denied at
--     deploy (start-edge fail-open transitioning to correct-deny).
--     Small user-visible change.
--   • col 2 = active grants that will FLIP FROM denied TO admitted at
--     deploy (end-edge fail-closed transitioning to correct-admit).
--     Also small user-visible change — this is the tow-risk fix.
-- ══════════════════════════════════════════════════════════════════════
SELECT
  COUNT(*) FILTER (WHERE start_date = ((now() AT TIME ZONE 'America/Chicago')::date + 1)
                     AND EXTRACT(HOUR FROM (now() AT TIME ZONE 'America/Chicago')) >= 19)
    AS active_grants_currently_admitted_early_that_will_be_denied_after_fix,
  COUNT(*) FILTER (WHERE end_date = (now() AT TIME ZONE 'America/Chicago')::date
                     AND EXTRACT(HOUR FROM (now() AT TIME ZONE 'America/Chicago')) >= 19)
    AS active_grants_currently_denied_that_will_be_admitted_after_fix
FROM public.guest_authorizations
WHERE is_active = TRUE
  AND status    = 'active';

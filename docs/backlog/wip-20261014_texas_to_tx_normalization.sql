-- ════════════════════════════════════════════════════════════════════
-- ONE-TIME — vehicles.state 'Texas' → 'TX'
-- ════════════════════════════════════════════════════════════════════
-- 🔴 DO NOT APPLY WITHOUT REVIEW. Hand-back for Jose, as ruled.
--
-- Same meaning, different spelling. 'Texas' is not a USPS code, so it
-- matches no select option anywhere in the product, cannot be chosen
-- when adding a vehicle, and (before PlateStateSelect) was the shape
-- most exposed to the silent-overwrite defect.
--
-- 🔴 WHY THIS IS SAFE AND THE 11 OUT-OF-STATE ROWS ARE NOT:
-- 'Texas' → 'TX' is a spelling change with ONE possible intent. The 11
-- rows holding LA / TN / MO / MS / MI are already correct codes and
-- must not be touched. Nothing here guesses at a value — if it did, it
-- would belong with those, i.e. only A1 could answer it.
--
-- Enforcement impact: NONE. Every plate predicate in the product
-- matches on PLATE ALONE, never plate+state (recorded as a standing
-- rule). So this changes a display and data-quality field, not an
-- authorization outcome.
--
-- Run the BEFORE block, read it, then the UPDATE, then the AFTER block.

-- ── BEFORE ──────────────────────────────────────────────────────────
SELECT 'BEFORE'::TEXT AS phase,
       count(*) FILTER (WHERE state = 'Texas')                      AS exactly_Texas,
       count(*) FILTER (WHERE state ILIKE 'texas' AND state <> 'Texas') AS other_casings,
       count(*) FILTER (WHERE state = 'TX')                          AS already_TX,
       count(*) FILTER (WHERE state IS NULL OR btrim(state) = '')    AS null_or_blank,
       count(*)                                                      AS total_vehicles
  FROM public.vehicles;

-- Every distinct value, so nothing is normalized blind.
SELECT state, count(*) AS rows
  FROM public.vehicles
 GROUP BY state
 ORDER BY count(*) DESC;

-- ── THE UPDATE ──────────────────────────────────────────────────────
-- ILIKE, so 'texas' / 'TEXAS' / ' Texas ' are caught too — all the same
-- spelling of the same state. Scoped with btrim so a stray space does
-- not leave a row behind.
--
-- RETURNING, so the write set is COUNTABLE rather than assumed: a
-- DELETE/UPDATE smoke that reports nothing cannot be told from one that
-- matched nothing.
WITH touched AS (
  UPDATE public.vehicles
     SET state = 'TX'
   WHERE btrim(state) ILIKE 'texas'
  RETURNING id, plate, property
)
SELECT 'UPDATED'::TEXT AS phase, count(*) AS rows_changed,
       count(DISTINCT property) AS properties_touched
  FROM touched;

-- ── AFTER ───────────────────────────────────────────────────────────
-- Audited as one row, because a bulk data fix with no audit trail is
-- indistinguishable from drift when someone asks in six months.
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, old_values, new_values, notes)
SELECT 'data-fix-texas-to-tx', 'VEHICLES_STATE_SPELLING_NORMALIZED', 'vehicles', NULL,
       jsonb_build_object('state', 'Texas'),
       jsonb_build_object('state', 'TX', 'rows', (SELECT count(*) FROM public.vehicles WHERE state = 'TX')),
       'One-time spelling normalization: vehicles.state ILIKE ''texas'' -> ''TX''. Same state, non-USPS spelling that matched no select option. The 11 rows holding LA/TN/MO/MS/MI were deliberately NOT touched — those are already correct codes, and only A1 could confirm any value that needed guessing. No enforcement impact: every plate predicate matches on plate alone, never plate+state.';

SELECT 'AFTER'::TEXT AS phase,
       count(*) FILTER (WHERE btrim(state) ILIKE 'texas') AS texas_spelling_want_0,
       count(*) FILTER (WHERE state = 'TX')               AS now_TX,
       count(*) FILTER (WHERE state IS NOT NULL AND state <> 'TX'
                          AND state NOT IN ('AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI',
                                            'ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN',
                                            'MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH',
                                            'OK','OR','PA','RI','SC','SD','TN','UT','VT','VA','WA',
                                            'WV','WI','WY')) AS still_unrecognised_want_0,
       count(*) AS total_vehicles
  FROM public.vehicles;

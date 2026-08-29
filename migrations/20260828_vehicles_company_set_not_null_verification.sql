-- ══════════════════════════════════════════════════════════════════════
-- 20260828_vehicles_company_set_not_null_verification.sql
--
-- Paired verification for 20260828_vehicles_company_set_not_null.
-- v2 pattern: no BEGIN/COMMIT wrap; terminal SELECT returns one PASS
-- row on success; any gate failure surfaces via RAISE EXCEPTION in a
-- DO block.
--
-- ── 5 IMMEDIATE GATES + 1 DEFERRED ──────────────────────────────────
--   VQ1  attnotnull structural check on vehicles.company
--   VQ2  🔴 EXECUTION — INSERT with company=NULL is REJECTED (not just
--        structurally marked NOT NULL). Test Legacy scope; probe row
--        deleted on completion (only reached if constraint fails).
--        Rationale (Mateo Aug 28 §5): "a structural check passes
--        against a constraint that isn't enforcing." Structural
--        attnotnull can be set without the runtime actually validating
--        (e.g., ALTER FROM a broken state, catalog corruption, or a
--        planner bypass). The execution gate closes that.
--   VQ3  still_null=0 belt-and-braces (should have been true pre-ALTER;
--        would have failed the ALTER if not; cheap re-check anyway)
--   VQ4  schema audit row present with correct migration name
--   VQ5  (deferred, ad-hoc)  V4.A1_DRIFT — bottom-of-file standalone
--        SELECT. Not part of the immediate PASS. Run manually after A1
--        has had a few hours of natural traffic. Pass is:
--          null_company = 0  AND  created_since_deploy > 0
--        Zero created_since_deploy is NOT a pass (nothing exercised
--        the path). Cannot pass on the immediate apply — deploy_ts and
--        now() are the same, so any vehicles.created_at is either
--        before-deploy or exactly-at-deploy.
--
-- ── VQ2 SCOPE + SAFETY ──────────────────────────────────────────────
-- The probe INSERT is a NEGATIVE test: it MUST fail with
-- not_null_violation on column='company'. If it fails on a different
-- column (e.g., plate NOT NULL because I omitted a column that turns
-- out to be required today), the exception message says which column
-- so the probe can be adjusted. If it fails on some OTHER SQLSTATE,
-- same — the exception surfaces.
--
-- If the probe INSERT SUCCEEDS (i.e., constraint isn't enforcing —
-- the whole reason this gate exists), the DO block deletes the
-- phantom row before RAISE EXCEPTION, so no dangling test data.
-- ══════════════════════════════════════════════════════════════════════

-- ── VQ1: attnotnull structural check ────────────────────────────────
DO $$
DECLARE
  v_is_nullable TEXT;
BEGIN
  SELECT is_nullable INTO v_is_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'vehicles'
     AND column_name  = 'company';
  IF v_is_nullable IS NULL THEN
    RAISE EXCEPTION 'VQ1 FAIL: column vehicles.company not found';
  END IF;
  IF v_is_nullable <> 'NO' THEN
    RAISE EXCEPTION 'VQ1 FAIL: expected NOT NULL; is_nullable = %. ALTER did not land.', v_is_nullable;
  END IF;
END $$;

-- ── VQ2: 🔴 EXECUTION — INSERT with company=NULL must be REJECTED ───
DO $$
DECLARE
  v_null_rejected BOOLEAN := FALSE;
  v_column_name   TEXT;
  v_test_plate    TEXT := '__V4-EXEC-PROBE-' || floor(extract(epoch from now()))::text;
BEGIN
  -- Nested BEGIN/EXCEPTION so an expected failure doesn't abort the
  -- outer DO block. Test Legacy scope (property value is a synthetic
  -- string that doesn't need to resolve — NOT NULL fires before any
  -- FK / trigger / RLS predicate check). is_active + status included
  -- to satisfy any other NOT NULLs on the row.
  BEGIN
    INSERT INTO public.vehicles (plate, state, property, company, status, is_active)
    VALUES (v_test_plate, 'TX', 'V4-EXEC-PROBE-property', NULL, 'pending', FALSE);
    -- If we reach here, NOT NULL is NOT enforcing. Delete the phantom
    -- row we shouldn't have written, then raise.
    DELETE FROM public.vehicles WHERE plate = v_test_plate;
    RAISE EXCEPTION
      'VQ2 FAIL: INSERT with company=NULL was ACCEPTED. attnotnull is set (VQ1) but the constraint is not enforcing at runtime. Phantom row (plate=%) has been deleted.', v_test_plate;
  EXCEPTION
    WHEN not_null_violation THEN
      GET STACKED DIAGNOSTICS v_column_name = COLUMN_NAME;
      IF v_column_name = 'company' THEN
        v_null_rejected := TRUE;
      ELSE
        RAISE EXCEPTION
          'VQ2 FAIL: not_null_violation raised on column="%" instead of "company". Probe INSERT is missing another required column — adjust the INSERT list to satisfy that NOT NULL, then rerun so the probe isolates the company constraint.', v_column_name;
      END IF;
    WHEN others THEN
      RAISE EXCEPTION
        'VQ2 FAIL: probe INSERT raised unexpected SQLSTATE=% : %. Adjust the probe INSERT to isolate the company NOT NULL check, or investigate why an unrelated constraint is firing first.', SQLSTATE, SQLERRM;
  END;

  IF NOT v_null_rejected THEN
    RAISE EXCEPTION 'VQ2 FAIL: control flow reached the end without v_null_rejected=TRUE — should be unreachable, investigate the probe logic.';
  END IF;
END $$;

-- ── VQ3: still_null = 0 belt-and-braces ─────────────────────────────
-- Post-ALTER, this should be trivially TRUE — SET NOT NULL would have
-- failed if any row had NULL company. Kept as a cheap re-check in case
-- a concurrent transaction inserted a NULL after the backfill and
-- before this verification (impossible under BEGIN/COMMIT-wrapped
-- migration, but SET NOT NULL post-commit is not itself in a txn).
DO $$
DECLARE
  v_null_count INT;
BEGIN
  SELECT COUNT(*) INTO v_null_count
    FROM public.vehicles
   WHERE company IS NULL;
  IF v_null_count <> 0 THEN
    RAISE EXCEPTION 'VQ3 FAIL: still_null=% post-ALTER (want 0). Something raced past the backfill+ALTER window.', v_null_count;
  END IF;
END $$;

-- ── VQ4: schema audit row present ───────────────────────────────────
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_VEHICLES_COMPANY_SET_NOT_NULL'
     AND new_values->>'migration' = '20260828_vehicles_company_set_not_null';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ4 FAIL: SCHEMA_VEHICLES_COMPANY_SET_NOT_NULL audit row missing. Migration DO block did not complete — check for a mid-run RAISE EXCEPTION in the error pane.';
  END IF;
END $$;

-- ── FINAL: one PASS row on immediate gates ──────────────────────────
SELECT
  'PASS'::TEXT                                 AS status,
  'vehicles.company SET NOT NULL'::TEXT        AS target,
  ARRAY[
    'VQ1 attnotnull structural',
    'VQ2 EXECUTION — INSERT with company=NULL rejected on column=company',
    'VQ3 still_null=0 belt-and-braces',
    'VQ4 SCHEMA_VEHICLES_COMPANY_SET_NOT_NULL audit row present'
  ]                                            AS gates_verified,
  'VQ5 (V4.A1_DRIFT) deferred — see standalone SELECT below'::TEXT AS deferred,
  now()                                        AS verified_at;

-- ══════════════════════════════════════════════════════════════════════
-- ── VQ5 (DEFERRED) — V4.A1_DRIFT ─────────────────────────────────────
-- ══════════════════════════════════════════════════════════════════════
-- 🔴 RUN THIS SEPARATELY, LATER — after A1 has had a few hours of
-- natural traffic post-apply. Immediately post-apply, deploy_ts and
-- now() are effectively the same, and created_since_deploy is 0 → not
-- a pass (means nothing has exercised the path yet, per Mateo Aug 28
-- §5). Re-run at, say, T+4h and again the next morning until
-- created_since_deploy > 0 and null_company = 0 both hold.
--
-- Uses the schema audit row's created_at as the deploy anchor —
-- authoritative timestamp, no need for a hand-supplied constant.
--
-- Paste as a single statement.
--
--   WITH deploy_anchor AS (
--     SELECT created_at AS deploy_ts
--       FROM public.audit_logs
--      WHERE action = 'SCHEMA_VEHICLES_COMPANY_SET_NOT_NULL'
--        AND new_values->>'migration' = '20260828_vehicles_company_set_not_null'
--      ORDER BY created_at DESC
--      LIMIT 1
--   ),
--   a1_row AS (
--     SELECT id, name FROM public.companies WHERE name ILIKE '%a1%' LIMIT 1
--   ),
--   a1_traffic AS (
--     SELECT v.*,
--            (v.created_at >= (SELECT deploy_ts FROM deploy_anchor)) AS created_since_deploy
--       FROM public.vehicles v
--      WHERE lower(trim(v.company)) = lower((SELECT name FROM a1_row))
--   )
--   SELECT
--     (SELECT deploy_ts FROM deploy_anchor)                       AS deploy_ts,
--     (SELECT name      FROM a1_row)                              AS a1_company,
--     COUNT(*)                                                    AS a1_total,
--     COUNT(*) FILTER (WHERE company IS NULL)                     AS null_company,
--     COUNT(*) FILTER (WHERE created_since_deploy)                AS created_since_deploy,
--     (COUNT(*) FILTER (WHERE company IS NULL) = 0
--      AND COUNT(*) FILTER (WHERE created_since_deploy) > 0)       AS pass
--     FROM a1_traffic;
--
-- Pass shape (one row):
--   deploy_ts             = timestamp of the ALTER (from audit row)
--   a1_company            = 'A1 Wrecker LLC' (or whatever T2 returned)
--   a1_total              = >= 140 (A1 has that as of Aug 28)
--   null_company          = 0    ← always true post-ALTER (SET NOT NULL)
--   created_since_deploy  = > 0  ← the load-bearing signal
--   pass                  = true
-- ══════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════
-- 20260904_violations_column_grant_tightening.sql
--
-- 🟢 Track gating Commit 3 Commit C — column-level GRANT tightening
--    on public.violations.
--
-- Closes the residual mass-assignment surface Commit B's allowlist
-- couldn't reach: direct client `.from('violations').insert/update`
-- paths that bypass the RPC entirely. Prior state: RLS gated WHICH
-- ROWS the client could write, never WHICH COLUMNS. A CA could
-- direct-INSERT a violation with `tow_ticket_generated: true` +
-- `tow_fee: 999` and RLS admitted it (property IN CA's company).
-- Only the RPC's allowlist stopped the vector — and the RPC is one
-- of two INSERT paths.
--
-- ── FAIL-CLOSED POSITIVE-ALLOWLIST (Mateo Sep 3 followup §1) ───────
--
-- Negative REVOKE list means any column added to violations in the
-- future is client-writable by default. Positive GRANT list means
-- new columns are closed until someone deliberately opens one —
-- same principle as the tier CASE's ELSE + get_company_property_limit's
-- neuter (which cost a day when it was fail-open).
--
-- ── ALLOWLIST (19 INSERT columns + 1 UPDATE column) ────────────────
--
-- INSERT — union of both direct-INSERT paths:
--   driver/page.tsx:1381 (submitViolation fallback — 19 keys)
--   company_admin/page.tsx:3224 (CA submitViolation — 15 keys, subset)
--
--   plate, violation_type, location, notes, property,
--   driver_name, driver_license,
--   video_url,
--   vehicle_color, vehicle_make, vehicle_model, vehicle_year,
--   is_confirmed,
--   was_authorized_at_time, decline_reason, decline_reason_note,
--   scanned_at, headline_status_at_scan,
--   snapshot_status
--
-- UPDATE — the two confirm-step sites (driver:1565, CA:3329) touch
-- only `is_confirmed`.
--
-- ── SNAPSHOT_STATUS RESIDUAL (Mateo Sep 3 followup §2 note) ────────
--
-- `snapshot_status` stays client-writable via the driver fallback,
-- which is the point (evidence-gap marker on RPC failure). A false
-- 'captured' from the client means a genuine evidence gap never
-- enters reconciliation because the queryable marker is the thing
-- that flags it. Low harm — the writer already controls the
-- evidence being reported about — but recorded here so it isn't
-- rediscovered as a fresh finding.
--
-- ── DEFINER RPCs UNAFFECTED ────────────────────────────────────────
--
-- Postgres column-level grants apply to the SESSION USER's rights.
-- SECURITY DEFINER functions run as their OWNER (typically postgres),
-- which retains full grants. So stamp_tow_ticket, void_violation,
-- set_violation_status, set_violation_view_token, regenerate_tow_ticket,
-- and driver_create_violation_with_snapshot keep full column access.
--
-- 🔴 VS5 in the paired verification asserts this by calling
-- void_violation with a garbage id — expects { error: 'not_found' },
-- would fail with "permission denied for column voided_at" if the
-- DEFINER premise were wrong.
--
-- ── DELETE + SELECT UNCHANGED ──────────────────────────────────────
--
-- DELETE: 3 policies (CA/driver/manager _delete_own_drafts) all gate
-- `is_confirmed = false` per F10 sweep (2026-06-10) + perf re-issue
-- (2026-07-03). Pre-flight in Part 1 asserts this invariant against
-- LIVE — source-vs-live drift is caught in the same transaction as
-- the grant changes.
--
-- SELECT: policies gate by role + property (per B155.2). Column-level
-- grant is table-wide; RLS is the scope. Not tightened here.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
--
-- 1. BEGIN — atomic. Pre-flight OR both grants apply, never one.
-- 2. Part 1 pre-flight (DELETE-policy invariant + presence of
--    is_confirmed in each qual + NOTICE the qual per policy).
-- 3. Part 2 REVOKE INSERT, UPDATE ON public.violations FROM
--    authenticated (wipe the wide grants).
-- 4. Part 3 GRANT INSERT (allowlist) TO authenticated.
-- 5. Part 4 GRANT UPDATE (is_confirmed) TO authenticated.
-- 6. Part 5 Audit row with the exact grant list captured.
-- 7. Part 6 NOTIFY pgrst.
-- 8. COMMIT.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- PART 1 — DELETE-policy pre-flight (source-vs-live drift catch)
-- ══════════════════════════════════════════════════════════════════════
DO $preflight$
DECLARE
  v_expected_count INT;
  v_admin_count INT;
  v_no_confirmed_gate TEXT := '';
  v_rec RECORD;
BEGIN
  -- 1a. Exactly 3 DELETE policies exist (CA/driver/manager
  --     _delete_own_drafts). Named match — reliable regardless of
  --     Postgres qual-rendering variance (item 8 lesson).
  SELECT COUNT(*) INTO v_expected_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'violations' AND cmd = 'DELETE'
     AND policyname IN ('company_admin_delete_own_drafts',
                        'driver_delete_own_drafts',
                        'manager_delete_own_drafts');
  IF v_expected_count <> 3 THEN
    RAISE EXCEPTION 'PREFLIGHT FAIL: expected exactly 3 DELETE policies (company_admin_delete_own_drafts, driver_delete_own_drafts, manager_delete_own_drafts); got %', v_expected_count;
  END IF;

  -- 1b. No admin-prefixed DELETE policies (F10 sweep invariant).
  SELECT COUNT(*) INTO v_admin_count
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'violations' AND cmd = 'DELETE'
     AND policyname LIKE 'admin%';
  IF v_admin_count > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT FAIL: unexpected admin-prefixed DELETE policy on violations (count=%); F10 sweep intended NONE. This is Commit D scope, not Commit C.', v_admin_count;
  END IF;

  -- 1c. Every DELETE policy's qual mentions is_confirmed as a
  --     PRESENCE check (Mateo Sep 3 followup §3: catalog qual
  --     rendering varies — `is_confirmed = false` may render as
  --     `(is_confirmed = false)`, `is_confirmed IS FALSE`, or
  --     `NOT is_confirmed`. Presence of the column name in a
  --     DELETE policy's qual is strong evidence; operator rendering
  --     is fragile). NOTICE the full qual so a human can confirm
  --     once rather than a regex guessing forever.
  FOR v_rec IN
    SELECT policyname, qual
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'violations' AND cmd = 'DELETE'
     ORDER BY policyname
  LOOP
    RAISE NOTICE 'PREFLIGHT INFO: DELETE policy % qual: %', v_rec.policyname, v_rec.qual;
    IF v_rec.qual NOT LIKE '%is_confirmed%' THEN
      v_no_confirmed_gate := v_no_confirmed_gate
        || format('%s (qual=%L); ', v_rec.policyname, v_rec.qual);
    END IF;
  END LOOP;

  IF v_no_confirmed_gate <> '' THEN
    RAISE EXCEPTION 'PREFLIGHT FAIL: DELETE policies without is_confirmed reference in qual: %. This is a finding — confirmed violations should not be subscriber-deletable. Commit D scope.', v_no_confirmed_gate;
  END IF;
END $preflight$;


-- ══════════════════════════════════════════════════════════════════════
-- PART 2 — REVOKE wide grants
-- ══════════════════════════════════════════════════════════════════════
REVOKE INSERT, UPDATE ON public.violations FROM authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- PART 3 — GRANT INSERT on the 19-column allowlist
-- ══════════════════════════════════════════════════════════════════════
-- Union of what the driver fallback + CA submit paths write today.
-- Driver's set is the superset (19 keys); CA writes a 15-key subset.
-- Adding a column to violations in the future doesn't automatically
-- grant INSERT on it — has to be deliberately extended here.
GRANT INSERT (
  plate, violation_type, location, notes, property,
  driver_name, driver_license,
  video_url,
  vehicle_color, vehicle_make, vehicle_model, vehicle_year,
  is_confirmed,
  was_authorized_at_time, decline_reason, decline_reason_note,
  scanned_at, headline_status_at_scan,
  snapshot_status
) ON public.violations TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- PART 4 — GRANT UPDATE on is_confirmed only
-- ══════════════════════════════════════════════════════════════════════
-- Two confirm-step call sites (driver:1565, CA:3329) touch only
-- is_confirmed. Every other UPDATE flows through a DEFINER RPC.
GRANT UPDATE (is_confirmed) ON public.violations TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- PART 5 — Schema audit row
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_VIOLATIONS_COLUMN_GRANT_TIGHTENING',
  'public.violations',
  'commit_3_commit_c',
  jsonb_build_object(
    'migration',            '20260904_violations_column_grant_tightening',
    'arc',                  'Track gating Commit 3 Commit C — column-level GRANT tightening on public.violations',
    'closes_residual',      'Direct client .from(violations).insert/update paths that bypass the RPC. RLS gated ROWS; column grants now gate COLUMNS. Complements Commit B''s allowlist for the RPC path.',
    'grant_shape',          'Positive allowlist (fail-closed for future columns). Negative REVOKE list would default new columns to client-writable — same class as the tier CASE ELSE or get_company_property_limit neuter.',
    'insert_allowlist',     jsonb_build_array(
      'plate','violation_type','location','notes','property',
      'driver_name','driver_license','video_url',
      'vehicle_color','vehicle_make','vehicle_model','vehicle_year',
      'is_confirmed',
      'was_authorized_at_time','decline_reason','decline_reason_note',
      'scanned_at','headline_status_at_scan',
      'snapshot_status'
    ),
    'update_allowlist',     jsonb_build_array('is_confirmed'),
    'definer_rpcs_unaffected', 'SECURITY DEFINER runs as owner (postgres) which retains all grants. stamp_tow_ticket, void_violation, set_violation_status, set_violation_view_token, regenerate_tow_ticket, driver_create_violation_with_snapshot keep full column access. VS5 execution probe asserts this.',
    'delete_policies_untouched', jsonb_build_object(
      'policies', jsonb_build_array('company_admin_delete_own_drafts', 'driver_delete_own_drafts', 'manager_delete_own_drafts'),
      'gate', 'is_confirmed=false (F10 sweep 2026-06-10 + perf re-issue 2026-07-03; live-verified in Part 1 pre-flight)',
      'invariant', '0 admin-prefixed DELETE policies (F10 sweep — asserted in pre-flight)'
    ),
    'snapshot_status_residual', 'snapshot_status stays client-writable via the driver fallback (evidence-gap marker on RPC failure). A false ''captured'' from the client would hide a real evidence gap from reconciliation — low harm because the writer already controls the evidence being reported about.',
    'service_role',         'Unchanged (all grants retained; RPC execution + admin paths work)',
    'anon',                 'Unchanged (no grants; RLS reads-only for public tow-ticket-view via DEFINER)',
    'select_delete',        'Unchanged (RLS is the scope)',
    'next',                 'Rehearsal + flip. No further track-gating arcs.'
  ),
  now()
);


-- ══════════════════════════════════════════════════════════════════════
-- PART 6 — PostgREST cache reload
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

COMMIT;

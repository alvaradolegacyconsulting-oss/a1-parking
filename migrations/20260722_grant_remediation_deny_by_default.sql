-- ═══════════════════════════════════════════════════════════════════════
-- 20260722_grant_remediation_deny_by_default.sql
-- ═══════════════════════════════════════════════════════════════════════
-- B182/B183 systemic fix — schema-wide deny-by-default for anon +
-- authenticated on public tables, then narrow explicit re-grants that
-- match ACTUAL usage. Closes the class of bug that shipped adfc6e1
-- (provisioning_failures with standing authenticated writes for 24h)
-- and would have shipped again on order_forms without VQ.H catching it
-- pre-apply.
--
-- ── SAFETY (Mateo 2026-07-22, per multi-round preflight) ───────────────
-- 1. WRAPPED IN SINGLE TRANSACTION. Any failure inside — including
--    a VQ.GRANTS RAISE — rolls back the entire migration. Pre-state
--    intact if anything fails apply-time.
--
-- 2. EMERGENCY RESTORE (paste-ready) — see companion file
--    scripts/emergency-restore-grants.sql. Reverts to the over-
--    permissive pre-state in seconds if a post-COMMIT smoke fails.
--    Jose keeps this SQL open in a second editor tab BEFORE running
--    this migration. Not typed live. Paste-ready.
--
-- 3. POST-COMMIT SMOKES GATE THE MIGRATION:
--    a) VQ.GRANTS blocks silent (asserted at the end of this migration).
--    b) scripts/smoke-anon-surfaces-post-revoke.ts — 7 functional anon
--       calls + structural anon table SELECT check + tow-link smoke.
--    c) Manual authenticated write smoke: as legacy-manager (Test-
--       LEGACY), create a visitor pass → trigger fires → write
--       succeeds. Proves the RLS helpers + authenticated EXECUTE
--       held + trigger functions callable.
--    d) Manual authenticated read smoke: as legacy-manager, load the
--       residents/violations queue → rows returned. Proves the 56-
--       policy get_my_role() surface intact.
--    Any smoke failure → paste emergency restore, diagnose, do not
--    push through.
--
-- ── DESIGN ─────────────────────────────────────────────────────────────
-- • authenticated: BLANKET GRANT SELECT ON ALL TABLES + BLANKET GRANT
--   EXECUTE ON ALL FUNCTIONS. Complete by construction — impossible to
--   miss a function in the 95-item list. RLS scopes SELECT rows;
--   authenticated calling a public-schema function they could already
--   call is not the threat model.
-- • authenticated writes: narrow, only on the 22 tables where a
--   client-side .from().write() path exists per Cond 3 report. 5
--   tables (tos_acceptances, order_forms, provisioning_failures,
--   stripe_events, stripe_prices) intentionally have NO auth write
--   grants — writes only via DEFINER RPCs or service_role.
-- • anon: ZERO table grants. EXECUTE ONLY on the 8 confirmed anon-
--   surface RPCs (visitor form + plate lookup + tow link + proposal-
--   code redemption). Dead-weight anon grants (create_visitor_pass
--   server-route-replaced, get_platform_flags no-callers,
--   set_must_change_password auth-only, accept_tos retired,
--   submit_dispute_request retired) let-stripped by the REVOKE.
-- • service_role: untouched. Explicit assertion block verifies it
--   retained SELECT + INSERT + UPDATE on load-bearing tables after
--   the migration.
-- • ALTER DEFAULT PRIVILEGES: REVOKE default anon+auth grants on
--   FUTURE TABLES + SEQUENCES (so newly-created tables don't
--   auto-grant back). NOT applied to FUNCTIONS — new functions
--   continue to default-grant to authenticated, matching the
--   blanket re-grant model.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 1 — Schema-wide REVOKE
-- ══════════════════════════════════════════════════════════════════════
-- Strips every default Supabase grant on every public-schema object.
-- service_role is NOT listed and its grants remain intact.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- Also revoke future default privileges so newly-created TABLES + SEQUENCES
-- don't auto-grant back to anon/authenticated. FUNCTIONS default privileges
-- INTENTIONALLY UNCHANGED — future new functions continue to default-grant
-- EXECUTE to authenticated, matching the blanket re-grant pattern below.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 2 — Authenticated re-grants
-- ══════════════════════════════════════════════════════════════════════

-- ── 2a. BLANKET SELECT on all tables ──────────────────────────────────
-- RLS scopes which rows any authenticated user sees. Admin-only tables
-- (order_forms admin_select, tos_acceptances admin_all, etc.) admit
-- only admin at qual layer. Non-admin auth gets 0 rows via RLS on those.
-- Complete by construction — no per-table list to miss.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;

-- ── 2b. Narrow writes on the 22 tables with client-side .from().write() ─
-- Explicitly enumerated (Cond 3 report). 5 tables intentionally omitted:
--   tos_acceptances       — writes only via 4 DEFINER RPCs
--   order_forms           — writes only via webhook service_role
--   provisioning_failures — writes only via webhook service_role
--   stripe_events         — writes only via webhook service_role
--   stripe_prices         — writes only via CLI script service_role
GRANT INSERT, UPDATE          ON public.audit_logs             TO authenticated;
GRANT INSERT, UPDATE, DELETE  ON public.companies              TO authenticated;
GRANT INSERT, UPDATE          ON public.dispute_requests       TO authenticated;
GRANT INSERT, UPDATE, DELETE  ON public.drivers                TO authenticated;
GRANT INSERT                  ON public.flag_acknowledgments   TO authenticated;
GRANT INSERT, UPDATE          ON public.guest_authorizations   TO authenticated;
GRANT INSERT, UPDATE          ON public.platform_settings      TO authenticated;
GRANT INSERT, UPDATE, DELETE  ON public.properties             TO authenticated;
GRANT INSERT, UPDATE, DELETE  ON public.proposal_codes         TO authenticated;
GRANT INSERT, UPDATE          ON public.residents              TO authenticated;
GRANT INSERT                  ON public.space_assignment_history TO authenticated;
GRANT INSERT, UPDATE          ON public.space_requests         TO authenticated;
GRANT INSERT, UPDATE, DELETE  ON public.space_residents        TO authenticated;
GRANT INSERT, UPDATE, DELETE  ON public.spaces                 TO authenticated;
GRANT INSERT, UPDATE, DELETE  ON public.storage_facilities     TO authenticated;
GRANT INSERT                  ON public.user_roles             TO authenticated;
GRANT INSERT                  ON public.vehicle_plate_changes  TO authenticated;
GRANT INSERT, UPDATE          ON public.vehicles               TO authenticated;
GRANT INSERT, UPDATE          ON public.violation_photos       TO authenticated;
GRANT INSERT, UPDATE          ON public.violation_videos       TO authenticated;
GRANT INSERT, UPDATE          ON public.violations             TO authenticated;
GRANT INSERT, UPDATE          ON public.visitor_passes         TO authenticated;

-- ── 2c. Sequence USAGE for the 22 tables with authenticated INSERT ────
-- Postgres SERIAL/BIGSERIAL sequences need explicit USAGE for the role
-- performing the INSERT. Missing USAGE = INSERT fails with permission
-- denied for sequence.
GRANT USAGE ON SEQUENCE
  public.audit_logs_id_seq,
  public.companies_id_seq,
  public.dispute_requests_id_seq,
  public.drivers_id_seq,
  public.flag_acknowledgments_id_seq,
  public.guest_authorizations_id_seq,
  public.platform_settings_id_seq,
  public.properties_id_seq,
  public.proposal_codes_id_seq,
  public.residents_id_seq,
  public.space_assignment_history_id_seq,
  public.space_requests_id_seq,
  public.space_residents_id_seq,
  public.spaces_id_seq,
  public.storage_facilities_id_seq,
  public.user_roles_id_seq,
  public.vehicle_plate_changes_id_seq,
  public.vehicles_id_seq,
  public.violation_photos_id_seq,
  public.violation_videos_id_seq,
  public.violations_id_seq,
  public.visitor_passes_id_seq
  TO authenticated;

-- ── 2d. BLANKET EXECUTE on all functions ──────────────────────────────
-- Per Mateo 2026-07-22 Confirmation 1: blanket re-grant is complete by
-- construction on a 95-function list. Enumerated form = 95 chances to
-- typo or omit. The security boundary is anon table reads + anon writes
-- (closed above); restricting which functions a logged-in user may
-- call is not the threat model.
--
-- Load-bearing: also covers Category A RLS helpers (get_my_role,
-- get_my_company, get_my_properties — 56 policies depend on
-- authenticated retaining EXECUTE) and Category B trigger functions
-- (fire during authenticated writes; missing EXECUTE = silent write
-- failures on 12+ tables including visitor_passes/companies).
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 3 — Anon re-grants
-- ══════════════════════════════════════════════════════════════════════
-- ZERO table grants. All anon reads via SECURITY DEFINER RPCs that run
-- as owner (bypass anon's own grants). Anon RLS helpers not needed
-- (anon never evaluates policies that reference them). Anon triggers
-- not needed (anon never writes to tables — anon writes go through
-- service-role /api/* routes or are structurally absent).
--
-- Explicit EXECUTE on the 8 anon-surface RPCs. Complete list per
-- route enumeration (Cond 2 report):
GRANT EXECUTE ON FUNCTION public.check_resident_plate(TEXT, TEXT)                TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_branding(TEXT)                      TO anon;
GRANT EXECUTE ON FUNCTION public.get_plate_pass_status(TEXT, TEXT)               TO anon;
GRANT EXECUTE ON FUNCTION public.get_platform_defaults()                         TO anon;
GRANT EXECUTE ON FUNCTION public.get_properties_for_visitor_select(TEXT)         TO anon;
GRANT EXECUTE ON FUNCTION public.get_property_for_visitor(TEXT)                  TO anon;
GRANT EXECUTE ON FUNCTION public.get_violation_by_view_token(TEXT)               TO anon;
GRANT EXECUTE ON FUNCTION public.validate_proposal_code(TEXT)                    TO anon;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 4 — VQ.GRANTS end-state assertion
-- ══════════════════════════════════════════════════════════════════════
-- Any failure here aborts the transaction and rolls back the entire
-- migration. Pre-state intact.

-- ── VQ.4a. Anon has ZERO table grants ─────────────────────────────────
DO $vq_anon_tables$
DECLARE v_leaked TEXT;
BEGIN
  SELECT string_agg(table_name || ':' || privilege_type, ', ') INTO v_leaked
  FROM information_schema.role_table_grants
  WHERE grantee = 'anon' AND table_schema = 'public';
  IF v_leaked IS NOT NULL THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL (4a): anon retains table grants: %', v_leaked;
  END IF;
END $vq_anon_tables$;

-- ── VQ.4b. Anon has EXECUTE on exactly the 8 preserved RPCs ────────────
DO $vq_anon_exec$
DECLARE
  v_fn TEXT;
  v_preserved TEXT[] := ARRAY[
    'public.check_resident_plate(text,text)',
    'public.get_company_branding(text)',
    'public.get_plate_pass_status(text,text)',
    'public.get_platform_defaults()',
    'public.get_properties_for_visitor_select(text)',
    'public.get_property_for_visitor(text)',
    'public.get_violation_by_view_token(text)',
    'public.validate_proposal_code(text)'
  ];
BEGIN
  FOREACH v_fn IN ARRAY v_preserved LOOP
    IF NOT has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'VQ.GRANTS FAIL (4b): anon lost EXECUTE on % — anon surface WILL BREAK', v_fn;
    END IF;
  END LOOP;
END $vq_anon_exec$;

-- ── VQ.4c. Authenticated has SELECT on every public table + RLS-helper EXECUTE ─
DO $vq_auth$
DECLARE
  v_missing TEXT;
  v_helper  TEXT;
  v_helpers TEXT[] := ARRAY[
    'public.get_my_role()',
    'public.get_my_company()',
    'public.get_my_properties()'
  ];
BEGIN
  -- Every public table must be SELECT-able by authenticated (RLS scopes rows).
  SELECT string_agg(c.relname, ', ') INTO v_missing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT LIKE 'pg_%'
    AND NOT has_table_privilege('authenticated', c.oid, 'SELECT');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL (4c): authenticated missing SELECT on: %', v_missing;
  END IF;

  -- Category A RLS helpers MUST have authenticated EXECUTE — 56 policies
  -- depend on this. Missing = total authenticated outage.
  FOREACH v_helper IN ARRAY v_helpers LOOP
    IF NOT has_function_privilege('authenticated', v_helper, 'EXECUTE') THEN
      RAISE EXCEPTION 'VQ.GRANTS FAIL (4c): authenticated lost EXECUTE on RLS helper % — TOTAL OUTAGE risk', v_helper;
    END IF;
  END LOOP;
END $vq_auth$;

-- ── VQ.4d. Service_role retention ─────────────────────────────────────
-- Sample a representative set of load-bearing tables. If service_role
-- lost grants on any, webhook / DEFINER RPC / provisioning would break.
DO $vq_svc$
DECLARE
  t TEXT;
  v_load_bearing TEXT[] := ARRAY[
    'companies', 'user_roles', 'residents', 'drivers', 'vehicles',
    'visitor_passes', 'violations', 'tos_acceptances', 'order_forms',
    'provisioning_failures', 'stripe_events', 'platform_settings',
    'proposal_codes', 'audit_logs'
  ];
BEGIN
  FOREACH t IN ARRAY v_load_bearing LOOP
    IF NOT has_table_privilege('service_role', format('public.%I', t), 'SELECT') THEN
      RAISE EXCEPTION 'VQ.GRANTS FAIL (4d): service_role lost SELECT on %', t;
    END IF;
    IF NOT has_table_privilege('service_role', format('public.%I', t), 'INSERT') THEN
      RAISE EXCEPTION 'VQ.GRANTS FAIL (4d): service_role lost INSERT on %', t;
    END IF;
    IF NOT has_table_privilege('service_role', format('public.%I', t), 'UPDATE') THEN
      RAISE EXCEPTION 'VQ.GRANTS FAIL (4d): service_role lost UPDATE on %', t;
    END IF;
  END LOOP;
END $vq_svc$;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 5 — SCHEMA_ audit
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_GRANT_REMEDIATION_DENY_BY_DEFAULT',
  'schema',
  NULL,
  jsonb_build_object(
    'migration', '20260722_grant_remediation_deny_by_default',
    'purpose',   'B182/B183 systemic fix — schema-wide deny-by-default for anon+authenticated, narrow explicit re-grants matching actual usage. Closes the class shipped in adfc6e1 (auth writes on PII table for 24h) + would have shipped on order_forms without VQ.H catch.',
    'anon_end_state', 'Zero table grants. EXECUTE on 8 confirmed anon-surface RPCs only (visitor form, plate lookup, tow link, proposal-code redemption). Dead-weight let-stripped: create_visitor_pass, get_platform_flags, set_must_change_password, accept_tos, submit_dispute_request.',
    'auth_end_state', 'Blanket SELECT on all public tables (RLS scopes rows). Narrow writes on 22 tables. Blanket EXECUTE on all functions (complete by construction — 95-fn list, includes Category A RLS helpers + Category B trigger functions).',
    'service_role', 'Untouched. Assertion block confirms retention of I/U/D on 14 load-bearing tables.',
    'gates',     'VQ.GRANTS (this migration, 4 blocks) + scripts/smoke-anon-surfaces-post-revoke.ts (functional anon calls incl. tow link) + manual authenticated write smoke (legacy-manager create visitor pass, trigger fires) + manual authenticated read smoke (residents queue loads).',
    'rollback',  'Atomic transaction — any RAISE aborts. Post-COMMIT smoke failure: paste scripts/emergency-restore-grants.sql (over-permissive restore, seconds to recover).',
    'convention_codified', 'docs/development/migration-verification-template.md updated with VQ.GRANTS block. Every future new-table migration MUST include the check.'
  ),
  now()
);

COMMIT;

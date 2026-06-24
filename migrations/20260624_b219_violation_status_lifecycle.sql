-- ═══════════════════════════════════════════════════════════════════
-- B219 — Violation status lifecycle + audit (FOUNDATION ONLY)
-- Date:   2026-06-24
-- Branch: a1/violation-status
--
-- ORIGINATING REQUEST
-- ───────────────────
-- A1 (2026-06-21) — company_admin wants to mark a violation/tow ticket's
-- disposition so they can track what's open vs. settled. Reframed from
-- a binary "paid/complete" into a configurable status field (different
-- companies define "resolved" differently).
--
-- TONIGHT'S SCOPE
-- ───────────────
-- Foundation only: status field + audited RPC + RLS/grants, CA-only.
-- NO dashboard, NO aggregation, NO flags, NO manager surfacing, NO
-- per-company config, NOTHING billing-adjacent. The dashboard + flags
-- are the explicit fast-follow, parked under the expanded B219 entry.
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- 1. Adds 3 columns on violations:
--      status             TEXT NOT NULL DEFAULT 'new'
--      status_changed_at  TIMESTAMPTZ
--      status_changed_by  TEXT
--    + CHECK constraint pinning status to the in-scope enum
--    + composite index on (property, status) for the CA dashboard's
--      eventual access path (violations is scoped by property, not
--      company — company scope is derived via the properties join,
--      same as b40 RLS)
--
-- 2. Backfills status from existing signals:
--      view_token IS NOT NULL → 'tow_ticket' (someone issued the
--                                 capability URL — they treated it
--                                 as a tow ticket)
--      everything else        → 'new' (the column DEFAULT)
--
-- 3. Creates set_violation_status DEFINER RPC:
--    • CA-only (mirrors B175 void_violation amendment 2026-06-11)
--    • Reuses get_my_role() + get_my_company() (no new auth path)
--    • Validates new_status against the CHECK enum (mirrors
--      update_space_metadata invalid_type)
--    • Refuses status changes on voided rows (voided_row_immutable)
--    • Writes VIOLATION_STATUS_CHANGE audit row with old→new
--    • Idempotent: same-value writes return noop=true without UPDATE
--    • REVOKE-from-anon-explicitly + GRANT to authenticated only
--
-- GATE 6 — `void` ORTHOGONALITY (Jose endorsed 2026-06-24)
-- ────────────────────────────────────────────────────────
-- `void` is DELIBERATELY NOT in the status CHECK enum. Voided-ness is
-- a first-class fact in voided_at/voided_by_email/voided_by_role/
-- void_reason (B175, 2026-06-11) with its own DEFINER RPC, its own
-- CA-only role gate, its own audit action (VIOLATION_VOIDED), and its
-- own immutability rule. Dual-encoding it as status='void' would
-- create a drift seam (two writes, two audit rows, two opportunities
-- to disagree).
--
-- Status = disposition (new / tow_ticket / resolved / disputed).
-- Voided = orthogonal axis (queried via voided_at IS NOT NULL).
-- UI render combines: `voided_at IS NOT NULL ? 'VOIDED' : status`.
--
-- COMPANY-SCOPE PREDICATE — MUST MATCH B40 RLS EXACTLY
-- ────────────────────────────────────────────────────
-- Jose verification point 2026-06-24: the company-scope check in
-- this RPC uses `~~*` (ILIKE) on properties.company, matching the
-- b40 company_admin_own_violations RLS predicate exactly:
--
--   USING (
--     get_my_role() = 'company_admin'::text
--     AND property IN (
--       SELECT properties.name FROM properties
--       WHERE properties.company ~~* get_my_company()
--     )
--   )
--
-- Property name match stays exact (`=`) — that's what RLS does too.
-- Invariant: "RLS-visible row = RPC-allowed row." A case/whitespace
-- drift in company would create an RLS-visible-but-RPC-denied row;
-- ILIKE alignment prevents that.
--
-- APPLY DISCIPLINE
-- ────────────────
-- Single-paste single-run in Supabase SQL Editor. BEGIN/COMMIT
-- wraps so partial-apply is impossible. Run verification Section A
-- first (column absent) → apply this file → run B/C/D/E/F/G.
-- Report Section C row counts before declaring applied + verified.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — Schema ─────────────────────────────────────────────────

ALTER TABLE public.violations
  ADD COLUMN IF NOT EXISTS status            TEXT        NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_changed_by TEXT;

-- Idempotent CHECK add (drop-if-exists then add — safer for re-runs)
ALTER TABLE public.violations
  DROP CONSTRAINT IF EXISTS violations_status_valid;

ALTER TABLE public.violations
  ADD CONSTRAINT violations_status_valid
  CHECK (status IN ('new', 'tow_ticket', 'resolved', 'disputed'));
-- 'void' deliberately absent (Gate 6 orthogonality).

-- ── PART 2 — Backfill (signal-driven inference) ─────────────────────

UPDATE public.violations
   SET status = 'tow_ticket'
 WHERE view_token IS NOT NULL
   AND status = 'new';   -- only touch DEFAULT-populated rows
-- Everything else stays 'new' (the column DEFAULT).
-- Voided rows: NOT touched here — their status (whatever it became
-- before void) stays as-is; voided_at IS NOT NULL is the source of
-- truth for voidness.

-- ── PART 3 — Index for the CA dashboard's eventual access path ──────
-- violations is scoped by property (not company); CA-side filtering
-- joins through properties (matching b40 RLS shape). Composite index
-- on (property, status) supports the per-property status filter the
-- dashboard will run; the upstream company filter rides on the
-- properties join with its own b40-time indexes.

CREATE INDEX IF NOT EXISTS violations_property_status
  ON public.violations (property, status);

-- ── PART 4 — set_violation_status DEFINER RPC ───────────────────────

CREATE OR REPLACE FUNCTION public.set_violation_status(
  p_violation_id BIGINT,
  p_new_status   TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_caller_company TEXT;
  v_row            violations%ROWTYPE;
  v_old_status     TEXT;
BEGIN
  -- ── Auth context ────────────────────────────────────────────────
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- Reuse existing helpers per spec ("do NOT invent a new auth path").
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  -- Role gate: CA-only (mirrors B175 void_violation amendment 2026-06-11).
  -- admin EXCLUDED on purpose — admin has admin_all RLS; if super-admin
  -- ever needs to set status they can UPDATE directly. Tonight's scope
  -- is the CA workflow per Jose Gate 1 lock.
  IF v_caller_role != 'company_admin' THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  v_caller_company := get_my_company();
  IF v_caller_company IS NULL THEN
    RETURN jsonb_build_object('error', 'no_company_assigned');
  END IF;

  -- ── Validate new_status (mirrors update_space_metadata invalid_type)
  IF p_new_status IS NULL
     OR p_new_status NOT IN ('new', 'tow_ticket', 'resolved', 'disputed') THEN
    RETURN jsonb_build_object(
      'error', 'invalid_status',
      'hint',  'status must be one of: new, tow_ticket, resolved, disputed'
    );
  END IF;

  -- ── Load + scope-check ──────────────────────────────────────────
  SELECT * INTO v_row FROM public.violations WHERE id = p_violation_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- Company-scope predicate — MUST MATCH b40 company_admin_own_violations
  -- RLS exactly (Jose verification point 2026-06-24):
  --   - properties.company ~~* (ILIKE) the caller's company
  --   - violations.property exact-match a row in that filtered set
  IF NOT EXISTS (
    SELECT 1 FROM public.properties p
     WHERE p.company ~~* v_caller_company
       AND p.name = v_row.property
  ) THEN
    RETURN jsonb_build_object('error', 'cross_company_denied');
  END IF;

  -- ── Voided rows are terminal in the disposition sense ───────────
  -- Voiding IS the correction; the disposition becomes moot after void.
  -- UI render shows 'VOIDED' regardless of status; we refuse status
  -- writes here to keep the invariant "voided rows are immutable in
  -- disposition" coherent.
  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'voided_row_immutable');
  END IF;

  v_old_status := COALESCE(v_row.status, 'new');

  -- ── Idempotent short-circuit ────────────────────────────────────
  IF v_old_status = p_new_status THEN
    RETURN jsonb_build_object('ok', TRUE, 'noop', TRUE, 'status', p_new_status);
  END IF;

  -- ── Atomic UPDATE + audit ───────────────────────────────────────
  UPDATE public.violations
     SET status            = p_new_status,
         status_changed_at = now(),
         status_changed_by = lower(v_caller_email)
   WHERE id = p_violation_id;

  -- Audit row (mirrors VIOLATION_VOIDED + AUTH_SPACE_* convention).
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'VIOLATION_STATUS_CHANGE',
    'violations',
    p_violation_id,
    jsonb_build_object(
      'old_status', v_old_status,
      'new_status', p_new_status,
      'company',    v_caller_company
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok',         TRUE,
    'old_status', v_old_status,
    'new_status', p_new_status
  );
END;
$func$;

-- ── PART 5 — Grants ─────────────────────────────────────────────────
-- Explicit REVOKE from anon + PUBLIC per the established discipline
-- ([[feedback-revoke-from-anon-explicitly]] + [[feedback-function-public-grant-supabase-default]]).
-- Supabase's default-privileges grant pattern is the reason we REVOKE
-- explicitly — REVOKE PUBLIC alone may leave anon executable.

REVOKE EXECUTE ON FUNCTION public.set_violation_status(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_violation_status(BIGINT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_violation_status(BIGINT, TEXT) TO authenticated;

COMMIT;

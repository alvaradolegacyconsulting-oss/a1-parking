-- ═══════════════════════════════════════════════════════════════════
-- Space Requests v1 — resident-initiated request flow
-- Date:   2026-06-26
-- Branch: a1/space-requests-v1
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- Net-new feature. Resident requests a parking space → lands in the
-- manager's approval queue → manager either approves (REQUIRES picking
-- an available space; single atomic action) or declines (optional
-- reason). Resident sees status + decision via in-portal notification +
-- mark-as-read, mirroring the vehicle-decline pattern (NOT email).
--
-- v1 SCOPE LOCKED (Jose 2026-06-26):
--   - Approval = assignment in one atomic action; can't approve unassigned
--   - In-portal notification + mark-as-read (NOT email)
--   - Optional resident note (free text, capped 500)
--   - Optional decline reason (matches vehicle-decline's optional
--     manager_note for consistency — manager-discretion field, NOT gated)
--   - One pending request per resident (partial UNIQUE index)
--   - Dropdown-only space picker in v1 (manual-entry fallback deferred
--     to v1.1; missing space → manager generates via existing pool tool
--     first, then approves)
--   - NO swap, NO tier upgrade/downgrade (deferred)
--
-- WHY A NEW TABLE
-- ───────────────
-- No existing approval flow is reusable:
--   - vehicles.status — wrong entity (vehicles vs space-request)
--   - residents.status — conflates request-state with registration-state
--     (residents.status already means "approved as resident", per the
--     2026-06-21 lock: "approval ≠ assignment; most residents hold zero
--     spaces" — registration approval is decoupled from space holding)
--   - spaces.status — attaches request-state to the wrong entity
--     (request precedes assignment)
-- A new table also gives clean audit (requested_at / decided_at /
-- decided_by_email / decline_reason / assigned_space_id all on one row).
--
-- PATTERN MIRRORS
-- ───────────────
--   - Atomic RPC discipline: B214 (guest_authorizations) — SECURITY
--     DEFINER, role-pinned, one-transaction approve flow
--   - In-portal mark-as-read: B90 (vehicles.resident_read +
--     mark_my_vehicle_declined_read RPC)
--   - Spaces v1.1 assignment: assign_space() + space_residents(space_id,
--     resident_email) join table — we INSERT directly into
--     space_residents rather than call assign_space() because we're
--     also updating space_requests in the same tx; inlining the INSERT
--     keeps the atomicity contract explicit
--
-- 🔒 INVARIANTS HONORED
-- ─────────────────────
--   1. APPROVE = ASSIGNMENT (single atomic action). approve_space_request
--      validates pending + space-available + property-match, then in one
--      transaction: INSERTs space_residents + UPDATEs spaces.status='assigned'
--      + UPDATEs space_requests.status='approved'. If any step fails,
--      all roll back. Cannot approve a request without picking a space.
--
--   2. NO DOUBLE-ASSIGN. spaces row is locked FOR UPDATE during the
--      approve, so two concurrent approves of different requests against
--      the same space serialize — second one sees status='assigned' and
--      returns space_no_longer_available.
--
--   3. ONE PENDING PER RESIDENT. Partial UNIQUE index
--      (resident_email) WHERE status='pending' enforces it at the DB
--      level (defense-in-depth; submit_space_request also pre-checks).
--
--   4. RESIDENT ONLY SUBMITS FOR SELF. submit_space_request uses
--      auth.jwt() ->> 'email' as the resident_email (caller can't
--      submit on someone else's behalf). RLS INSERT policy also
--      enforces this.
--
--   5. MANAGER SCOPE PRESERVED. approve/decline RPCs validate the
--      request's property is in get_my_properties() (manager) or matches
--      get_my_company() (CA). Out-of-scope returns request_out_of_scope.
--
--   6. AUDITED. submit + approve + decline + mark-read each write an
--      audit_logs row with action SPACE_REQUEST_<verb> and a new_values
--      jsonb capturing the meaningful state transition.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — Table: public.space_requests
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.space_requests (
  id                BIGSERIAL PRIMARY KEY,
  resident_email    TEXT        NOT NULL,
  property          TEXT        NOT NULL,
  note              TEXT,                                                 -- optional resident context; capped 500 via CHECK
  status            TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'approved', 'declined')),
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by_email  TEXT,                                                 -- nullable until decision
  decided_at        TIMESTAMPTZ,                                          -- nullable until decision
  decline_reason    TEXT,                                                 -- nullable; populated on decline (optional even then)
  assigned_space_id BIGINT REFERENCES public.spaces(id) ON DELETE SET NULL,
  resident_read     BOOLEAN     NOT NULL DEFAULT FALSE,                   -- mirror vehicles.resident_read; flipped via mark_my_space_request_decision_read
  CONSTRAINT space_requests_note_length_chk
    CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT space_requests_decline_reason_length_chk
    CHECK (decline_reason IS NULL OR char_length(decline_reason) <= 500),
  CONSTRAINT space_requests_decided_consistency_chk
    CHECK (
      (status = 'pending'  AND decided_by_email IS NULL AND decided_at IS NULL)
      OR
      (status IN ('approved', 'declined') AND decided_by_email IS NOT NULL AND decided_at IS NOT NULL)
    ),
  CONSTRAINT space_requests_approved_has_space_chk
    CHECK (status <> 'approved' OR assigned_space_id IS NOT NULL)
);

-- Partial UNIQUE: one pending request per resident at a time.
-- Allows historical approved/declined rows for the same email to coexist.
CREATE UNIQUE INDEX IF NOT EXISTS space_requests_one_pending_per_resident
  ON public.space_requests (resident_email)
  WHERE status = 'pending';

-- Query indexes
CREATE INDEX IF NOT EXISTS space_requests_property_status_idx
  ON public.space_requests (property, status);

CREATE INDEX IF NOT EXISTS space_requests_resident_status_idx
  ON public.space_requests (resident_email, status);

CREATE INDEX IF NOT EXISTS space_requests_status_requested_at_idx
  ON public.space_requests (status, requested_at);


-- ════════════════════════════════════════════════════════════════════
-- PART 2 — RLS (resident own + manager-properties + CA company + admin all)
-- ════════════════════════════════════════════════════════════════════
-- Pattern mirrors B40 / Spaces v1.1 / B214. Writes route via DEFINER
-- RPCs (which bypass RLS); the policies below govern direct table
-- reads (resident's own status surface; manager's queue load).
-- REVOKE all from PUBLIC + REVOKE anon explicitly per [[feedback-revoke-anon-default-on-new-tables]].

ALTER TABLE public.space_requests ENABLE ROW LEVEL SECURITY;

-- ⚠ SUPABASE DEFAULT-PRIVILEGE FOOTGUN (Jose 2026-06-26):
-- Supabase's ALTER DEFAULT PRIVILEGES IN SCHEMA public grants the
-- `authenticated` role ALL on new tables (INSERT/UPDATE/DELETE/TRUNCATE
-- + SELECT) at creation time, BEFORE any of our REVOKE statements run.
-- The TABLE grant is direct to the named role — NOT via PUBLIC — so
-- REVOKE ... FROM PUBLIC doesn't claw it back. Same gotcha for anon
-- (covered by [[feedback-revoke-anon-default-on-new-tables]]); the
-- 2026-06-26 incident extended the lesson to `authenticated` too —
-- omitting REVOKE FROM authenticated leaves writes wide open even
-- with RLS enabled, since RLS gates SELECT/UPDATE/DELETE *expressions*
-- not the underlying grant. End result: a resident could directly
-- UPDATE their own space_requests row to status='approved' with a
-- forged assigned_space_id, skipping all RPC validation + scope
-- checks. Fix: explicit REVOKE on BOTH authenticated AND anon BEFORE
-- the targeted GRANT SELECT.
REVOKE ALL    ON public.space_requests FROM authenticated;
REVOKE ALL    ON public.space_requests FROM anon;
REVOKE ALL    ON public.space_requests FROM PUBLIC;
GRANT  SELECT ON public.space_requests TO authenticated;
-- service_role retains its default backend grants; postgres is the owner.
-- No INSERT/UPDATE/DELETE/TRUNCATE for authenticated/anon — writes go
-- through SECURITY DEFINER RPCs only. Defense-in-depth: even if RLS
-- were misconfigured, the missing write grants block client-side writes.

-- Resident: SELECT own (case-insensitive email compare)
DROP POLICY IF EXISTS "resident_own_space_requests" ON public.space_requests;
CREATE POLICY "resident_own_space_requests"
  ON public.space_requests
  FOR SELECT
  TO authenticated
  USING (lower(resident_email) = lower(auth.jwt() ->> 'email'));

-- Manager: SELECT within their property scope
DROP POLICY IF EXISTS "manager_property_scoped_space_requests" ON public.space_requests;
CREATE POLICY "manager_property_scoped_space_requests"
  ON public.space_requests
  FOR SELECT
  TO authenticated
  USING (
    get_my_role() = 'manager'
    AND property = ANY(get_my_properties())
  );

-- Company admin: SELECT within their company scope
DROP POLICY IF EXISTS "ca_company_scoped_space_requests" ON public.space_requests;
CREATE POLICY "ca_company_scoped_space_requests"
  ON public.space_requests
  FOR SELECT
  TO authenticated
  USING (
    get_my_role() = 'company_admin'
    AND property IN (SELECT name FROM public.properties WHERE company ~~* get_my_company())
  );

-- Admin: SELECT all
DROP POLICY IF EXISTS "admin_all_space_requests" ON public.space_requests;
CREATE POLICY "admin_all_space_requests"
  ON public.space_requests
  FOR SELECT
  TO authenticated
  USING (get_my_role() = 'admin');


-- ════════════════════════════════════════════════════════════════════
-- PART 3 — RPC 1: submit_space_request (resident)
-- ════════════════════════════════════════════════════════════════════
-- Resident submits a request for a space at their own property.
-- Validates: caller authenticated, caller is a resident with active
-- registration, property matches their residents row, note within cap,
-- no existing pending request (partial UNIQUE backs this).

CREATE OR REPLACE FUNCTION public.submit_space_request(
  p_property TEXT,
  p_note     TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_resident     residents%ROWTYPE;
  v_new_id       BIGINT;
BEGIN
  -- ── Auth gate ──────────────────────────────────────────────
  v_caller_email := lower(auth.jwt() ->> 'email');
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- ── Role gate ──────────────────────────────────────────────
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;
  IF v_caller_role <> 'resident' THEN
    RETURN jsonb_build_object('error', 'role_not_authorized',
                              'hint',  'Only residents can submit space requests.');
  END IF;

  -- ── Args ───────────────────────────────────────────────────
  IF p_property IS NULL OR length(trim(p_property)) = 0 THEN
    RETURN jsonb_build_object('error', 'property_required');
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 500 THEN
    RETURN jsonb_build_object('error', 'note_too_long',
                              'hint',  'Note is capped at 500 characters.');
  END IF;

  -- ── Resident load + state ─────────────────────────────────
  SELECT * INTO v_resident
    FROM public.residents
   WHERE lower(email) = v_caller_email
   LIMIT 1;
  IF v_resident.id IS NULL THEN
    RETURN jsonb_build_object('error', 'resident_not_found');
  END IF;
  IF v_resident.status <> 'active' THEN
    RETURN jsonb_build_object('error', 'resident_not_active',
                              'hint',  'Your registration must be approved before requesting a space.');
  END IF;
  IF v_resident.property IS NULL OR v_resident.property <> p_property THEN
    RETURN jsonb_build_object('error', 'property_out_of_scope',
                              'hint',  'You can only request a space at your own property.');
  END IF;

  -- ── Pre-check: no existing pending (UNIQUE partial index backs this;
  --    pre-check returns a friendly error instead of constraint violation)
  IF EXISTS (
    SELECT 1 FROM public.space_requests
     WHERE lower(resident_email) = v_caller_email AND status = 'pending'
  ) THEN
    RETURN jsonb_build_object('error', 'pending_request_exists',
                              'hint',  'You already have a pending space request. Wait for a decision or cancel it first.');
  END IF;

  -- ── INSERT ─────────────────────────────────────────────────
  INSERT INTO public.space_requests (resident_email, property, note)
  VALUES (v_caller_email, p_property, NULLIF(trim(COALESCE(p_note, '')), ''))
  RETURNING id INTO v_new_id;

  -- ── Audit ──────────────────────────────────────────────────
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    v_caller_email,
    'SPACE_REQUEST_SUBMITTED',
    'space_requests',
    v_new_id,
    jsonb_build_object(
      'property',      p_property,
      'note_present',  p_note IS NOT NULL AND length(trim(p_note)) > 0
    ),
    now()
  );

  RETURN jsonb_build_object('ok', TRUE, 'request_id', v_new_id);
END;
$func$;


-- ════════════════════════════════════════════════════════════════════
-- PART 4 — RPC 2: approve_space_request (manager/CA/admin) — ATOMIC
-- ════════════════════════════════════════════════════════════════════
-- Single atomic action: validate + assign + mark approved + audit, one
-- transaction. SELECT FOR UPDATE on the space row prevents two concurrent
-- approves against the same space (the second sees status='assigned'
-- and returns space_no_longer_available).

CREATE OR REPLACE FUNCTION public.approve_space_request(
  p_request_id BIGINT,
  p_space_id   BIGINT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_request      space_requests%ROWTYPE;
  v_space        spaces%ROWTYPE;
BEGIN
  -- ── Auth ───────────────────────────────────────────────────
  v_caller_email := lower(auth.jwt() ->> 'email');
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- ── Role gate ──────────────────────────────────────────────
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;
  IF v_caller_role NOT IN ('manager', 'company_admin', 'admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- ── Request load + state ──────────────────────────────────
  SELECT * INTO v_request
    FROM public.space_requests
   WHERE id = p_request_id;
  IF v_request.id IS NULL THEN
    RETURN jsonb_build_object('error', 'request_not_found');
  END IF;
  IF v_request.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'request_already_decided',
                              'hint',  format('Request is %s; only pending requests can be approved.', v_request.status));
  END IF;

  -- ── Scope check ────────────────────────────────────────────
  IF v_caller_role = 'manager' THEN
    IF NOT (v_request.property = ANY(get_my_properties())) THEN
      RETURN jsonb_build_object('error', 'request_out_of_scope');
    END IF;
  ELSIF v_caller_role = 'company_admin' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.properties
       WHERE name = v_request.property AND company ~~* get_my_company()
    ) THEN
      RETURN jsonb_build_object('error', 'request_out_of_scope');
    END IF;
  END IF;
  -- admin: no scope check (sees all)

  -- ── Space load + LOCK FOR UPDATE (prevents concurrent double-assign)
  SELECT * INTO v_space
    FROM public.spaces
   WHERE id = p_space_id
   FOR UPDATE;
  IF v_space.id IS NULL THEN
    RETURN jsonb_build_object('error', 'space_not_found');
  END IF;
  IF v_space.is_active = FALSE THEN
    RETURN jsonb_build_object('error', 'space_decommissioned');
  END IF;
  IF v_space.status <> 'available' THEN
    RETURN jsonb_build_object('error', 'space_no_longer_available',
                              'hint',  format('Space is %s; pick another available space.', v_space.status));
  END IF;
  IF v_space.property <> v_request.property THEN
    RETURN jsonb_build_object('error', 'space_property_mismatch',
                              'hint',  'Space must be at the same property as the request.');
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ ATOMIC APPROVE — 3 writes in one transaction            ║
  -- ║   1. INSERT space_residents(space_id, resident_email)    ║
  -- ║   2. UPDATE spaces.status='assigned'                     ║
  -- ║   3. UPDATE space_requests (status='approved',          ║
  -- ║      decided_*, assigned_space_id)                      ║
  -- ║ Any failure → rollback all three. The CHECK constraint  ║
  -- ║ space_requests_approved_has_space_chk also guards #3.    ║
  -- ╚══════════════════════════════════════════════════════════╝
  INSERT INTO public.space_residents (space_id, resident_email, added_by_email)
  VALUES (p_space_id, lower(v_request.resident_email), v_caller_email);

  UPDATE public.spaces
     SET status = 'assigned'
   WHERE id = p_space_id;

  UPDATE public.space_requests
     SET status            = 'approved',
         decided_by_email  = v_caller_email,
         decided_at        = now(),
         assigned_space_id = p_space_id,
         resident_read     = FALSE                                       -- reset so resident sees the new decision
   WHERE id = p_request_id;

  -- ── Audit ──────────────────────────────────────────────────
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    v_caller_email,
    'SPACE_REQUEST_APPROVED',
    'space_requests',
    p_request_id,
    jsonb_build_object(
      'resident_email',   v_request.resident_email,
      'property',         v_request.property,
      'assigned_space_id', p_space_id,
      'space_label',      v_space.label,
      'caller_role',      v_caller_role
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok',                TRUE,
    'request_id',        p_request_id,
    'assigned_space_id', p_space_id,
    'space_label',       v_space.label
  );
END;
$func$;


-- ════════════════════════════════════════════════════════════════════
-- PART 5 — RPC 3: decline_space_request (manager/CA/admin)
-- ════════════════════════════════════════════════════════════════════
-- p_decline_reason is OPTIONAL (matches vehicle-decline's optional
-- manager_note for consistency — Jose lock 2026-06-26). RPC does NOT
-- gate the decline on reason presence.

CREATE OR REPLACE FUNCTION public.decline_space_request(
  p_request_id     BIGINT,
  p_decline_reason TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_request      space_requests%ROWTYPE;
BEGIN
  -- ── Auth ───────────────────────────────────────────────────
  v_caller_email := lower(auth.jwt() ->> 'email');
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;
  IF v_caller_role NOT IN ('manager', 'company_admin', 'admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- ── Reason length cap (optional content; 500 max if present) ──
  IF p_decline_reason IS NOT NULL AND char_length(p_decline_reason) > 500 THEN
    RETURN jsonb_build_object('error', 'decline_reason_too_long',
                              'hint',  'Decline reason is capped at 500 characters.');
  END IF;

  -- ── Request load + state ──────────────────────────────────
  SELECT * INTO v_request
    FROM public.space_requests
   WHERE id = p_request_id;
  IF v_request.id IS NULL THEN
    RETURN jsonb_build_object('error', 'request_not_found');
  END IF;
  IF v_request.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'request_already_decided',
                              'hint',  format('Request is %s; only pending requests can be declined.', v_request.status));
  END IF;

  -- ── Scope check (same shape as approve) ───────────────────
  IF v_caller_role = 'manager' THEN
    IF NOT (v_request.property = ANY(get_my_properties())) THEN
      RETURN jsonb_build_object('error', 'request_out_of_scope');
    END IF;
  ELSIF v_caller_role = 'company_admin' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.properties
       WHERE name = v_request.property AND company ~~* get_my_company()
    ) THEN
      RETURN jsonb_build_object('error', 'request_out_of_scope');
    END IF;
  END IF;

  -- ── Mutation ──────────────────────────────────────────────
  UPDATE public.space_requests
     SET status            = 'declined',
         decline_reason    = NULLIF(trim(COALESCE(p_decline_reason, '')), ''),  -- normalize empty/whitespace to NULL
         decided_by_email  = v_caller_email,
         decided_at        = now(),
         resident_read     = FALSE                                       -- reset so resident sees the new decision
   WHERE id = p_request_id;

  -- ── Audit ──────────────────────────────────────────────────
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    v_caller_email,
    'SPACE_REQUEST_DECLINED',
    'space_requests',
    p_request_id,
    jsonb_build_object(
      'resident_email', v_request.resident_email,
      'property',       v_request.property,
      'reason_present', p_decline_reason IS NOT NULL AND length(trim(p_decline_reason)) > 0,
      'caller_role',    v_caller_role
    ),
    now()
  );

  RETURN jsonb_build_object('ok', TRUE, 'request_id', p_request_id);
END;
$func$;


-- ════════════════════════════════════════════════════════════════════
-- PART 6 — RPC 4: mark_my_space_request_decision_read (resident)
-- ════════════════════════════════════════════════════════════════════
-- Mirrors mark_my_vehicle_declined_read (B90). Resident dismisses the
-- approved/declined card by calling this; flips resident_read=TRUE.
-- Validates ownership AND that the request has actually been decided
-- (no point marking pending as read).

CREATE OR REPLACE FUNCTION public.mark_my_space_request_decision_read(
  p_request_id BIGINT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email TEXT;
  v_request      space_requests%ROWTYPE;
BEGIN
  v_caller_email := lower(auth.jwt() ->> 'email');
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  SELECT * INTO v_request
    FROM public.space_requests
   WHERE id = p_request_id;
  IF v_request.id IS NULL THEN
    RETURN jsonb_build_object('error', 'request_not_found');
  END IF;
  IF lower(v_request.resident_email) <> v_caller_email THEN
    RETURN jsonb_build_object('error', 'not_your_request');
  END IF;
  IF v_request.status = 'pending' THEN
    RETURN jsonb_build_object('error', 'request_still_pending',
                              'hint',  'Nothing to mark as read until a decision is made.');
  END IF;

  UPDATE public.space_requests
     SET resident_read = TRUE
   WHERE id = p_request_id;

  RETURN jsonb_build_object('ok', TRUE, 'request_id', p_request_id);
END;
$func$;


-- ════════════════════════════════════════════════════════════════════
-- PART 7 — Grants on the 4 RPCs (authenticated only)
-- ════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION public.submit_space_request(TEXT, TEXT)                 FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_space_request(TEXT, TEXT)                 FROM anon;
GRANT  EXECUTE ON FUNCTION public.submit_space_request(TEXT, TEXT)                 TO authenticated;

REVOKE EXECUTE ON FUNCTION public.approve_space_request(BIGINT, BIGINT)            FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_space_request(BIGINT, BIGINT)            FROM anon;
GRANT  EXECUTE ON FUNCTION public.approve_space_request(BIGINT, BIGINT)            TO authenticated;

REVOKE EXECUTE ON FUNCTION public.decline_space_request(BIGINT, TEXT)              FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decline_space_request(BIGINT, TEXT)              FROM anon;
GRANT  EXECUTE ON FUNCTION public.decline_space_request(BIGINT, TEXT)              TO authenticated;

REVOKE EXECUTE ON FUNCTION public.mark_my_space_request_decision_read(BIGINT)      FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mark_my_space_request_decision_read(BIGINT)      FROM anon;
GRANT  EXECUTE ON FUNCTION public.mark_my_space_request_decision_read(BIGINT)      TO authenticated;


-- ════════════════════════════════════════════════════════════════════
-- PART 8 — Migration audit rows
-- ════════════════════════════════════════════════════════════════════

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_TABLE_CREATED',
  'space_requests',
  NULL,
  jsonb_build_object(
    'migration', '20260626_space_requests_v1',
    'table',     'public.space_requests',
    'columns',   jsonb_build_array(
      'id BIGSERIAL PK',
      'resident_email TEXT NOT NULL',
      'property TEXT NOT NULL',
      'note TEXT (capped 500)',
      'status TEXT CHECK (pending|approved|declined)',
      'requested_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      'decided_by_email TEXT (nullable until decided)',
      'decided_at TIMESTAMPTZ (nullable until decided)',
      'decline_reason TEXT (optional even on decline)',
      'assigned_space_id BIGINT FK spaces(id) ON DELETE SET NULL',
      'resident_read BOOLEAN NOT NULL DEFAULT FALSE'
    ),
    'indexes',   jsonb_build_array(
      'UNIQUE (resident_email) WHERE status=pending — one pending per resident',
      '(property, status) — manager queue',
      '(resident_email, status) — resident own',
      '(status, requested_at) — pending list ordered'
    ),
    'rls',       'enabled; 4 SELECT policies (resident own / manager properties / CA company / admin all); REVOKE PUBLIC/anon; GRANT SELECT to authenticated; no client INSERT/UPDATE/DELETE'
  ),
  now()
);

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPCS_CREATED',
  'space_requests',
  NULL,
  jsonb_build_object(
    'migration', '20260626_space_requests_v1',
    'rpcs',      jsonb_build_array(
      'submit_space_request(p_property TEXT, p_note TEXT) — resident, INSERT',
      'approve_space_request(p_request_id BIGINT, p_space_id BIGINT) — manager/CA/admin, ATOMIC (insert space_residents + spaces.status=assigned + space_requests.status=approved)',
      'decline_space_request(p_request_id BIGINT, p_decline_reason TEXT) — manager/CA/admin, optional reason',
      'mark_my_space_request_decision_read(p_request_id BIGINT) — resident, ownership-checked, decision-only'
    ),
    'grants',    'REVOKE PUBLIC + anon; GRANT EXECUTE to authenticated on all 4',
    'discipline','SECURITY DEFINER; role-pinned; pattern matches B214 atomic + B90 read-marker'
  ),
  now()
);

COMMIT;

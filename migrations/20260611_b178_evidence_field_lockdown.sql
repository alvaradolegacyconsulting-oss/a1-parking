-- ═══════════════════════════════════════════════════════════════════
-- B178 — Confirmed-violation evidence-field lockdown
-- Date:   2026-06-11
-- Branch: b178/evidence-field-lockdown
--
-- THE GAP F10 LEFT
-- ────────────────
-- F10 (B155.2) hardened DELETE on confirmed violations — they cannot
-- be erased. But the four UPDATE policies (admin / company_admin /
-- driver / manager) have NO is_confirmed gate. An in-scope tenant
-- role can still rewrite a confirmed violation's evidence (plate,
-- type, notes, vehicle_*, location) via a direct API UPDATE, which
-- undercuts the "tamper-proof records" claim and leaves B175's
-- voided_* columns writable outside the void_violation RPC.
--
-- WHY APPROACH (b): DEFINER RPC + drafts-only RLS UPDATE (Jose lock)
-- ──────────────────────────────────────────────────────────────────
-- Approach (a) (column-level GRANT/REVOKE) leaves an escape hatch:
-- under (a), is_confirmed must stay writable for the confirm
-- transition → a tenant role could `update({is_confirmed:false})` to
-- un-confirm → back to draft → edit evidence / hit the draft-DELETE
-- policy. (b) denies all UPDATE on confirmed rows at the RLS layer,
-- closing the un-confirm hole. (b) is also codebase-consistent
-- (DEFINER RPCs are the dominant pattern: insert_user_role,
-- accept_tos, accept_signup_consents, redeem_proposal_code,
-- create_visitor_pass, void_violation).
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- 1. Tighten the 4 UPDATE policies: add `AND is_confirmed = false`
--    to USING. WITH CHECK unchanged → the false→true confirm
--    transition still passes (USING admits the draft row, WITH
--    CHECK doesn't gate is_confirmed). Post-confirm direct UPDATE
--    is denied across the board, by every role, on every column.
--
-- 2. Replace set_violation_view_token with a SECURITY DEFINER
--    variant that has its OWN body-level role+scope gate. Critical:
--    converting INVOKER→DEFINER WITHOUT a body gate is a privilege
--    escalation (any authenticated user could tokenize any
--    violation). The body gate mirrors void_violation's pattern:
--    validate get_my_role() ∈ allowed set + own-scope via
--    get_my_company() / get_my_properties().
--
-- 3. Create new stamp_tow_ticket SECURITY DEFINER RPC with the same
--    body-level role+scope gate. Server-side derives tow_storage_*
--    fields from the facility id (don't trust client-passed strings)
--    + scope-checks the facility belongs to the caller's company.
--
-- 4. void_violation is already DEFINER (B175) — unchanged. After
--    this migration, voided_* is RPC-only (RLS denies direct UPDATE
--    on confirmed rows). Closes the B175 void-audit tamper-evidence
--    gap that B175 v1 consciously deferred.
--
-- AUTHORIZED ROLES FOR tokenize + stamp_tow_ticket
-- ────────────────────────────────────────────────
-- {admin, company_admin, driver, manager} — same set of roles that
-- generate tow tickets today (per existing generateTicket UI in
-- driver and CA portals + manager precedent). Leasing_agent
-- excluded (consistent with F10 violations role array). Resident +
-- driver* excluded — they don't generate tickets.
--   * driver here MEANS the tow-operator driver role, who DOES
--     generate tickets. Renaming nothing — confirming role-name
--     semantics so a future reader doesn't trip on the overlap.
--
-- APPLY DISCIPLINE
-- ────────────────
-- Single-paste single-run in Supabase SQL Editor. Pre-apply
-- verification documents the pre-tightening shape; post-apply
-- verification confirms:
--   • Policy USING clauses contain `is_confirmed = false`.
--   • set_violation_view_token has prosecdef = true (DEFINER).
--   • stamp_tow_ticket exists with prosecdef = true.
--   • Grant table: both RPCs show ONLY authenticated; if anon or
--     PUBLIC appears, REVOKE failed silently — STOP.
-- ═══════════════════════════════════════════════════════════════════


-- ── PRE-APPLY VERIFICATION ──────────────────────────────────────────
-- Current UPDATE policy state.
SELECT tablename, policyname, cmd AS verb,
       qual AS using_clause, with_check
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename = 'violations'
   AND cmd = 'UPDATE'
 ORDER BY policyname;
-- Expected: 4 rows (admin/CA/driver/manager update_violations); none
-- of their USING clauses should contain 'is_confirmed = false' yet.

-- Current set_violation_view_token security mode.
SELECT proname, prosecdef AS is_security_definer
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname = 'set_violation_view_token';
-- Expected: 1 row, prosecdef = false (currently INVOKER).

-- stamp_tow_ticket should NOT exist yet.
SELECT proname FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname = 'stamp_tow_ticket';
-- Expected: 0 rows.


-- ═══════════════════════════════════════════════════════════════════
-- PART 1 — Tighten the 4 UPDATE policies: drafts-only USING
-- ═══════════════════════════════════════════════════════════════════
-- DROP + CREATE pattern. Each policy gains `AND is_confirmed = false`
-- in USING. WITH CHECK unchanged so the confirm transition (false →
-- true) still passes (USING admits the draft row; WITH CHECK
-- evaluates against the NEW row but has no is_confirmed clause).

DROP POLICY IF EXISTS admin_update_violations ON violations;
CREATE POLICY admin_update_violations ON violations
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'admin'::text
    AND is_confirmed = false
  )
  WITH CHECK (get_my_role() = 'admin'::text);

DROP POLICY IF EXISTS company_admin_update_violations ON violations;
CREATE POLICY company_admin_update_violations ON violations
  FOR UPDATE TO authenticated
  USING (
    (get_my_role() = 'company_admin'::text)
    AND is_confirmed = false
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  )
  WITH CHECK (
    (get_my_role() = 'company_admin'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );

DROP POLICY IF EXISTS driver_update_violations ON violations;
CREATE POLICY driver_update_violations ON violations
  FOR UPDATE TO authenticated
  USING (
    (get_my_role() = 'driver'::text)
    AND is_confirmed = false
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  )
  WITH CHECK (
    (get_my_role() = 'driver'::text)
    AND (property IN (
      SELECT properties.name FROM properties
      WHERE properties.company ~~* get_my_company()
    ))
  );

DROP POLICY IF EXISTS manager_update_violations ON violations;
CREATE POLICY manager_update_violations ON violations
  FOR UPDATE TO authenticated
  USING (
    (get_my_role() = 'manager'::text)
    AND is_confirmed = false
    AND (property ~~* ANY (get_my_properties()))
  )
  WITH CHECK (
    (get_my_role() = 'manager'::text)
    AND (property ~~* ANY (get_my_properties()))
  );


-- ═══════════════════════════════════════════════════════════════════
-- PART 2 — set_violation_view_token: INVOKER → DEFINER + body gate
-- ═══════════════════════════════════════════════════════════════════
-- The CRITICAL change: INVOKER→DEFINER would bypass RLS and (without
-- a body gate) become callable by ANY authenticated user to tokenize
-- ANY violation — privilege escalation. The body gate added here
-- mirrors void_violation's pattern: role check + own-scope via
-- get_my_company() / get_my_properties().
--
-- The state checks also tighten: refuse drafts (is_confirmed=false)
-- AND refuse voided rows. A voided ticket has no business surfacing
-- new public links.
--
-- Returns the same {token, expires_at} success shape (with an added
-- 'ok' discriminator key for cleaner callers); error shape stays
-- {error: '...'}. Existing callers reading .token continue to work.

CREATE OR REPLACE FUNCTION public.set_violation_view_token(p_violation_id BIGINT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_company        TEXT;
  v_properties     TEXT[];
  v_row            violations%ROWTYPE;
  v_token          TEXT;
  v_expires        TIMESTAMPTZ;
BEGIN
  -- Auth context
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  -- Role gate — same set that generates tow tickets today.
  IF v_caller_role NOT IN ('admin', 'company_admin', 'driver', 'manager') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- Load + state checks. Only confirmed, non-voided rows get tokens.
  SELECT * INTO v_row FROM violations WHERE id = p_violation_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_row.is_confirmed = false THEN
    RETURN jsonb_build_object('error', 'not_confirmed');
  END IF;
  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'voided');
  END IF;

  -- Scope gate — mirror the F10 SELECT predicates per role.
  IF v_caller_role IN ('company_admin', 'driver') THEN
    v_company := get_my_company();
    IF v_company IS NULL OR NOT EXISTS (
      SELECT 1 FROM properties p
       WHERE p.name = v_row.property
         AND p.company ~~* v_company
    ) THEN
      RETURN jsonb_build_object('error', 'out_of_scope');
    END IF;
  ELSIF v_caller_role = 'manager' THEN
    v_properties := get_my_properties();
    IF v_properties IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM unnest(v_properties) p
          WHERE v_row.property ~~* p
       )
    THEN
      RETURN jsonb_build_object('error', 'out_of_scope');
    END IF;
  END IF;
  -- admin falls through

  -- Generate token + expiry (unchanged shape).
  -- Schema-qualify gen_random_bytes — pgcrypto installs it in the
  -- 'extensions' schema, NOT public. DEFINER pins search_path = public
  -- (minimum-leak posture is correct), so an unqualified call would
  -- fail at first tokenize with 'function gen_random_bytes(integer)
  -- does not exist'. CREATE-time resolution is lazy → prosecdef +
  -- grant checks pass green; the first real call is what breaks.
  v_expires := now() + interval '90 days';
  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');

  UPDATE violations
     SET view_token            = v_token,
         view_token_expires_at = v_expires
   WHERE id = p_violation_id;

  RETURN jsonb_build_object(
    'ok',         true,
    'token',      v_token,
    'expires_at', v_expires
  );
END
$func$;

-- Grant discipline (explicit REVOKE FROM anon — load-bearing per
-- [[feedback-revoke-from-anon-explicitly]]).
REVOKE EXECUTE ON FUNCTION public.set_violation_view_token(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_violation_view_token(BIGINT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_violation_view_token(BIGINT) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════
-- PART 3 — stamp_tow_ticket SECURITY DEFINER RPC
-- ═══════════════════════════════════════════════════════════════════
-- Replaces the direct client UPDATE at driver/page.tsx (~line 883)
-- and company_admin/page.tsx (~line 1811). Server-side:
--   • role gate (same set as tokenize)
--   • scope gate on the violation
--   • scope gate on the storage facility (must belong to caller's
--     company — don't trust client-passed strings)
--   • atomic UPDATE of tow_ticket_generated + tow_ticket_generated_at
--     + tow_storage_name/_address/_phone derived FROM the facility row
--     (server reads the canonical values) + tow_fee from p_tow_fee
--   • returns {ok: true, violation: <updated row>} for client state
--     refresh.

CREATE OR REPLACE FUNCTION public.stamp_tow_ticket(
  p_violation_id        BIGINT,
  p_storage_facility_id BIGINT,
  p_tow_fee             NUMERIC
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_company        TEXT;
  v_properties     TEXT[];
  v_row            violations%ROWTYPE;
  v_storage        storage_facilities%ROWTYPE;
  v_updated_row    jsonb;
BEGIN
  -- Auth context
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  -- Role gate — same set as set_violation_view_token (the roles that
  -- generate tow tickets).
  IF v_caller_role NOT IN ('admin', 'company_admin', 'driver', 'manager') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- Load violation + state checks.
  SELECT * INTO v_row FROM violations WHERE id = p_violation_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'violation_not_found');
  END IF;
  IF v_row.is_confirmed = false THEN
    -- Tow ticket can only be stamped on a confirmed violation.
    RETURN jsonb_build_object('error', 'not_confirmed');
  END IF;
  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'voided');
  END IF;

  -- Violation scope gate (mirror F10 SELECT predicates).
  IF v_caller_role IN ('company_admin', 'driver') THEN
    v_company := get_my_company();
    IF v_company IS NULL OR NOT EXISTS (
      SELECT 1 FROM properties p
       WHERE p.name = v_row.property
         AND p.company ~~* v_company
    ) THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  ELSIF v_caller_role = 'manager' THEN
    v_properties := get_my_properties();
    IF v_properties IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM unnest(v_properties) p
          WHERE v_row.property ~~* p
       )
    THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  END IF;
  -- admin falls through

  -- Load storage facility — server-side canonical values (don't trust
  -- client-passed strings).
  SELECT * INTO v_storage FROM storage_facilities WHERE id = p_storage_facility_id;
  IF v_storage.id IS NULL THEN
    RETURN jsonb_build_object('error', 'storage_facility_not_found');
  END IF;

  -- Storage facility scope gate — must belong to caller's company.
  -- admin sees all (per admin_all_facilities); non-admin roles check
  -- the storage_facilities.company column matches get_my_company().
  IF v_caller_role IN ('company_admin', 'driver', 'manager') THEN
    v_company := get_my_company();
    IF v_company IS NULL
       OR v_storage.company IS NULL
       OR NOT (v_storage.company ~~* v_company)
    THEN
      RETURN jsonb_build_object('error', 'storage_facility_out_of_scope');
    END IF;
  END IF;
  -- admin falls through

  -- Atomic stamp. Server reads facility name/address/phone from the
  -- facility row — never the client-passed strings.
  UPDATE violations
     SET tow_ticket_generated     = true,
         tow_ticket_generated_at  = now(),
         tow_storage_name         = v_storage.name,
         tow_storage_address      = v_storage.address,
         tow_storage_phone        = v_storage.phone,
         tow_fee                  = p_tow_fee
   WHERE id = p_violation_id
  RETURNING to_jsonb(violations.*) INTO v_updated_row;

  RETURN jsonb_build_object(
    'ok',        true,
    'violation', v_updated_row
  );
END
$func$;

REVOKE EXECUTE ON FUNCTION public.stamp_tow_ticket(BIGINT, BIGINT, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stamp_tow_ticket(BIGINT, BIGINT, NUMERIC) FROM anon;
GRANT  EXECUTE ON FUNCTION public.stamp_tow_ticket(BIGINT, BIGINT, NUMERIC) TO authenticated;


-- ── POST-APPLY VERIFICATION ─────────────────────────────────────────

-- 1. Each UPDATE policy USING contains `is_confirmed = false`.
SELECT policyname, qual AS using_clause
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename = 'violations'
   AND cmd = 'UPDATE'
 ORDER BY policyname;
-- Expected: 4 rows; every using_clause contains the substring
-- 'is_confirmed = false'.

-- 2. set_violation_view_token is now SECURITY DEFINER.
SELECT proname, prosecdef AS is_security_definer,
       pg_get_function_arguments(oid) AS args
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname = 'set_violation_view_token';
-- Expected: prosecdef = true; args = 'p_violation_id bigint'.

-- 3. stamp_tow_ticket exists with the correct signature + DEFINER.
SELECT proname, prosecdef AS is_security_definer,
       pg_get_function_arguments(oid) AS args
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname = 'stamp_tow_ticket';
-- Expected: 1 row; prosecdef = true; args =
-- 'p_violation_id bigint, p_storage_facility_id bigint, p_tow_fee numeric'.

-- 4. Grant table — load-bearing check per the explicit-REVOKE-FROM-anon
--    discipline. Both RPCs MUST show ONLY authenticated. If anon or
--    PUBLIC appears, STOP and investigate before any UI smoke.
SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE specific_schema = 'public'
   AND routine_name IN ('set_violation_view_token', 'stamp_tow_ticket')
   AND grantee IN ('anon', 'authenticated', 'PUBLIC')
 ORDER BY routine_name, grantee;
-- Expected EXACTLY:
--   set_violation_view_token | authenticated | EXECUTE
--   stamp_tow_ticket         | authenticated | EXECUTE
-- 'anon' / 'PUBLIC' MUST NOT appear.


-- ── NEXT (manual) ───────────────────────────────────────────────────
-- 1. Verify the post-apply block produced the expected results.
-- 2. The UI commit on the SAME branch (b178/evidence-field-lockdown)
--    deploys the two client refactors:
--      • app/driver/page.tsx ~line 883 — replace direct
--        from('violations').update({tow_*}) with
--        rpc('stamp_tow_ticket', {p_violation_id, p_storage_
--        facility_id, p_tow_fee}); read the RETURNed row into
--        local state.
--      • app/company_admin/page.tsx ~line 1811 — same refactor.
--    The existing rpc('set_violation_view_token', {p_violation_id})
--    callers are byte-compatible — the new shape adds {ok: true}
--    alongside existing {token, expires_at}; callers reading
--    .token continue to work.
-- 3. Smoke per the locked plan:
--    • Confirm transition still works (draft → confirmed). ✓
--    • Tow-stamp via RPC works; direct UPDATE of tow_* on a
--      confirmed row → DENIED (RLS).
--    • Tokenize via RPC works AND is gated — unauthorized role /
--      out-of-scope violation → refused (prove the gate, not just
--      the happy path).
--    • Evidence edit — direct update({plate:...}) on confirmed →
--      DENIED.
--    • Un-confirm escape hatch — direct update({is_confirmed:false})
--      on confirmed → DENIED. The hole is closed.
--    • Void still works via void_violation; direct
--      update({voided_at:...}) on confirmed → DENIED.
--    • Drafts remain fully editable + discardable.
-- 4. All destructive RLS denial checks use RETURNING / rows-affected
--    per [[feedback-delete-smoke-must-use-returning]] (e.g.
--    `UPDATE ... RETURNING id` returns 0 rows iff RLS denied).

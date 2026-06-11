-- ═══════════════════════════════════════════════════════════════════
-- B175 — Violation void mechanism (A1-LAUNCH GATE)
-- Date:   2026-06-11
-- Branch: a1/violation-void
--
-- THE GAP F10 LEFT
-- ────────────────
-- F10 (June 10) made confirmed violations IMMUTABLE at the DELETE
-- layer — no role can delete a confirmed violation, period. That's
-- correct (wrongful-tow evidence integrity). But it means a confirmed
-- violation issued in error — mistyped plate, wrong vehicle, duplicate
-- — is currently permanent with NO correction path. A1 cannot issue
-- real violations safely until a void path exists.
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- 1. Adds the void column shape (mirror of the proven media soft-delete
--    pattern from B13/B18):
--      voided_at        TIMESTAMPTZ
--      voided_by_email  TEXT
--      voided_by_role   TEXT
--      void_reason      TEXT
--    + partial index on voided_at WHERE voided_at IS NOT NULL.
--
-- 2. Creates SECURITY DEFINER RPC void_violation(p_violation_id,
--    p_void_reason) — the SINGLE authorized write path for the
--    voided_* columns.
--    • Validates caller role ∈ {admin, company_admin} ONLY (Jose
--      amendment 2026-06-11). Manager / driver / leasing_agent /
--      resident REFUSED. Original v1 lock admitted manager; pre-
--      merge amendment narrowed authority to company-level roles
--      only — managers retain media-removal authority on confirmed
--      violations (asymmetry consciously accepted) but cannot void.
--    • Validates own-scope (mirrors the F10 SELECT predicates):
--      admin → no scope check; company_admin → property IN
--      companies-via-get_my_company().
--    • REFUSES drafts (is_confirmed=false — drafts have discard path).
--    • REFUSES already-voided rows (terminal — no un-void in v1).
--    • Sets all 4 voided_* columns atomically with the
--      VIOLATION_VOIDED audit row.
--    • RETURNS the updated row (so the client can update local state
--      without a refetch; also lets the caller see the row landed,
--      avoiding RLS DELETE/UPDATE silent-no-op ambiguity per
--      [[feedback-delete-smoke-must-use-returning]]).
--
-- 3. Modifies get_violation_by_view_token to be void-aware per Q6c:
--    a voided violation returns a distinct {status: 'voided'} WITHOUT
--    the violation payload (no plate, no photos, no location). The
--    public /ticket/view/[token] route renders a clean "voided" page.
--    Rationale: a violation is often voided because the data was wrong;
--    we must not keep republishing the erroneous record on an anonymous
--    public URL.
--
-- WHAT THIS MIGRATION INTENTIONALLY DOES NOT DO (B178)
-- ────────────────────────────────────────────────────
-- The F10 UPDATE policies on violations lack an is_confirmed gate —
-- meaning the 4 voided_* columns are technically writable outside the
-- void_violation RPC by any authorized UPDATE role. Filed as B178 to
-- close. B175 v1 consciously accepts this gap because (a) the RPC is
-- the only UI path that writes those columns, and (b) closing the
-- UPDATE gap touches every UPDATE policy and is its own arc per
-- Jose's lock. B178 will add voided_* to the column-level protected
-- set (or migrate UPDATE policies to a confirmed-row column-grant
-- model) — separate scope.
--
-- APPLY DISCIPLINE
-- ────────────────
-- Single-paste single-run in Supabase SQL Editor. Apply BEFORE the
-- UI commit on this branch deploys — the UI calls void_violation, so
-- the RPC must exist first. Vercel preview deploy is fine pre-apply
-- since smoke uses the preview backend = prod shared.
--
-- Pre-apply verification confirms the columns are absent + neither
-- RPC has the new shape. Post-apply confirms everything plus the
-- grant pattern per the [[feedback-revoke-from-anon-explicitly]]
-- discipline (REVOKE FROM anon EXPLICITLY, not just FROM PUBLIC).
-- ═══════════════════════════════════════════════════════════════════


-- ── PRE-APPLY VERIFICATION ──────────────────────────────────────────
-- Columns: 0 rows expected.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'violations'
   AND column_name IN ('voided_at', 'voided_by_email', 'voided_by_role', 'void_reason');

-- RPCs: void_violation = 0 rows (doesn't exist); get_violation_by_
-- view_token = 1 row (exists from tow-ticket migration, will be replaced).
SELECT proname, pg_get_function_arguments(oid) AS args, prosecdef AS is_security_definer
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname IN ('void_violation', 'get_violation_by_view_token')
 ORDER BY proname;


-- ── PART 1 — Column adds + partial index ────────────────────────────
ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS voided_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by_email  TEXT,
  ADD COLUMN IF NOT EXISTS voided_by_role   TEXT,
  ADD COLUMN IF NOT EXISTS void_reason      TEXT;

-- Partial index — only the (small) set of voided rows. Used by the
-- read-site filters (analytics: `voided_at IS NULL`; lists: visible-
-- marked rendering still benefits from index for ordering).
CREATE INDEX IF NOT EXISTS violations_voided_at_idx
  ON violations (voided_at)
  WHERE voided_at IS NOT NULL;


-- ── PART 2 — void_violation DEFINER RPC ─────────────────────────────
CREATE OR REPLACE FUNCTION public.void_violation(
  p_violation_id BIGINT,
  p_void_reason  TEXT
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
  v_row            violations%ROWTYPE;
  v_updated_row    jsonb;
BEGIN
  -- ── Auth context ────────────────────────────────────────────────
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  -- ── Role gate (Jose lock amended 2026-06-11: CA-only) ──────────
  -- Authority: admin + company_admin ONLY. Manager EXCLUDED (along
  -- with leasing_agent / driver / resident). The original v1 lock
  -- included manager; Jose amended pre-merge: void is a company-
  -- level correction action, not a per-property one. Managers keep
  -- their existing media-removal authority on confirmed violations
  -- (asymmetry consciously accepted) — but void → CA / admin only.
  IF v_caller_role NOT IN ('admin', 'company_admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- ── Reason validation ──────────────────────────────────────────
  IF p_void_reason IS NULL OR length(trim(p_void_reason)) = 0 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  -- ── Load the target row + state checks ─────────────────────────
  SELECT * INTO v_row FROM violations WHERE id = p_violation_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_row.is_confirmed = false THEN
    -- Drafts have discard path (F10 draft DELETE policies); void is
    -- the confirmed-record analog.
    RETURN jsonb_build_object('error', 'not_confirmed');
  END IF;

  IF v_row.voided_at IS NOT NULL THEN
    -- Terminal: v1 has no un-void. An erroneously-voided real
    -- violation is corrected by re-issuing a new violation row, not
    -- by reversing the void.
    RETURN jsonb_build_object('error', 'already_voided');
  END IF;

  -- ── Scope gate — mirror F10 SELECT policies per authorized role ─
  -- admin: no scope check (sees all).
  -- company_admin: property IN companies-via-get_my_company().
  -- (Manager branch removed alongside the role gate — managers
  --  cannot void post-amendment.)
  IF v_caller_role = 'company_admin' THEN
    v_company := get_my_company();
    IF v_company IS NULL OR NOT EXISTS (
      SELECT 1 FROM properties p
       WHERE p.name = v_row.property
         AND p.company ~~* v_company
       )
    THEN
      RETURN jsonb_build_object('error', 'out_of_scope');
    END IF;
  END IF;
  -- admin falls through (no scope restriction)

  -- ── Atomic write: void the row + audit ─────────────────────────
  UPDATE violations
     SET voided_at       = now(),
         voided_by_email = lower(v_caller_email),
         voided_by_role  = v_caller_role,
         void_reason     = p_void_reason
   WHERE id = p_violation_id
  RETURNING to_jsonb(violations.*) INTO v_updated_row;

  INSERT INTO audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'VIOLATION_VOIDED',
    'violations',
    p_violation_id::text,
    jsonb_build_object(
      'violation_id', p_violation_id,
      'plate',        v_row.plate,
      'property',     v_row.property,
      'void_reason',  p_void_reason,
      'voided_by_role', v_caller_role,
      'voided_at',    v_updated_row->>'voided_at'
    ),
    now()
  );

  RETURN jsonb_build_object(
    'ok',        true,
    'violation', v_updated_row
  );
END
$func$;

-- Grant discipline per [[feedback-revoke-from-anon-explicitly]]:
-- EXPLICIT REVOKE FROM anon + FROM PUBLIC; explicit GRANT to authenticated.
REVOKE EXECUTE ON FUNCTION public.void_violation(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.void_violation(BIGINT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.void_violation(BIGINT, TEXT) TO authenticated;


-- ── PART 3 — get_violation_by_view_token void-aware (Q6c) ───────────
-- The CHANGE vs the prior body: detect voided_at IS NOT NULL FIRST,
-- before the is_confirmed/expiry checks. A voided violation returns
-- a distinct {status: 'voided'} WITHOUT the violation payload — no
-- plate, no photos, no location. We will not keep republishing the
-- erroneous record on an anonymous public URL. The public route
-- renders a clean "This ticket has been voided" page.
CREATE OR REPLACE FUNCTION public.get_violation_by_view_token(p_token TEXT)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_violation jsonb;
  v_photos   jsonb;
  v_id       BIGINT;
  v_voided   TIMESTAMPTZ;
BEGIN
  -- Input sanity.
  IF p_token IS NULL OR length(p_token) < 32 THEN
    RETURN jsonb_build_object('error', 'invalid_token');
  END IF;

  -- Look up by token alone first — we need to know if the row exists
  -- and is voided before applying the confirmed/expiry gates. A voided
  -- row should return the distinct voided status even if its view
  -- token has expired (the operator may have voided AFTER expiry; a
  -- recipient hitting the link should still see "voided" not "not
  -- found / expired").
  SELECT v.id, v.voided_at
    INTO v_id, v_voided
    FROM violations v
   WHERE v.view_token = p_token
     AND v.is_confirmed = true;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found_or_expired');
  END IF;

  -- VOIDED branch — distinct status, NO payload.
  IF v_voided IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'voided');
  END IF;

  -- Re-fetch the full row IFF not voided + not expired.
  SELECT to_jsonb(v.*)
    INTO v_violation
    FROM violations v
   WHERE v.id = v_id
     AND v.view_token_expires_at > now();

  IF v_violation IS NULL THEN
    -- Confirmed, not voided, but expired.
    RETURN jsonb_build_object('error', 'not_found_or_expired');
  END IF;

  -- Photos: active only (soft-deletes excluded).
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('id', id, 'photo_url', photo_url)
      ORDER BY id
    ),
    '[]'::jsonb
  )
    INTO v_photos
    FROM violation_photos
   WHERE violation_id = v_id
     AND removed_at IS NULL;

  RETURN jsonb_build_object(
    'violation', v_violation,
    'photos',    v_photos
  );
END
$func$;

-- Re-confirm grants (no change vs tow-ticket migration; documenting
-- here for completeness since the function body was replaced).
REVOKE EXECUTE ON FUNCTION public.get_violation_by_view_token(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_violation_by_view_token(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_violation_by_view_token(TEXT) TO anon, authenticated;


-- ── POST-APPLY VERIFICATION ─────────────────────────────────────────
-- All 4 columns present + correct types.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'violations'
   AND column_name IN ('voided_at', 'voided_by_email', 'voided_by_role', 'void_reason')
 ORDER BY column_name;
-- Expected 4 rows:
--   void_reason     | text                     | YES
--   voided_at       | timestamp with time zone | YES
--   voided_by_email | text                     | YES
--   voided_by_role  | text                     | YES

-- Partial index present.
SELECT indexname FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename = 'violations'
   AND indexname = 'violations_voided_at_idx';
-- Expected: 1 row.

-- Both RPCs present + correct DEFINER/INVOKER shape.
SELECT proname,
       pg_get_function_arguments(oid) AS args,
       prosecdef                       AS is_security_definer
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname IN ('void_violation', 'get_violation_by_view_token')
 ORDER BY proname;
-- Expected:
--   get_violation_by_view_token | p_token text                       | t (DEFINER)
--   void_violation              | p_violation_id bigint, p_void_reason text | t (DEFINER)

-- Grants — load-bearing per the explicit REVOKE-FROM-anon discipline.
-- void_violation: authenticated only.
-- get_violation_by_view_token: anon + authenticated (unchanged from tow-ticket).
SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE specific_schema = 'public'
   AND routine_name IN ('void_violation', 'get_violation_by_view_token')
   AND grantee IN ('anon', 'authenticated', 'PUBLIC')
 ORDER BY routine_name, grantee;
-- Expected:
--   get_violation_by_view_token | anon          | EXECUTE
--   get_violation_by_view_token | authenticated | EXECUTE
--   void_violation              | authenticated | EXECUTE
-- void_violation MUST NOT show 'anon' or 'PUBLIC'. If either appears,
-- the REVOKE FROM anon line failed silently — investigate before any
-- UI smoke.

-- Behavior sanity (no row needs to exist):
-- Anon call with garbage token → invalid_token.
SELECT public.get_violation_by_view_token('too-short');
-- Expected: {"error": "invalid_token"}

-- Anon call to void_violation should error at the grant layer.
-- (Cannot test from SQL Editor as authenticated; run from a real
-- anon-only session if needed.)


-- ── NEXT (manual) ───────────────────────────────────────────────────
-- 1. Verify the post-apply block produced the expected results
--    (especially the grants — load-bearing).
-- 2. The UI commit on the SAME branch (a1/violation-void) deploys:
--      ViolationVoidDialog component (sibling to MediaRemovalDialog)
--      Wire void action at the post-confirm violation surface for
--        manager / CA / admin (NOT driver)
--      Read-site treatment per Q4:
--        manager/admin/driver lists: visible + marked
--        analytics counters: filter voided out
--        resident list: hide voided
--        PostConfirmationEditModal: refuse media edit on voided
--      Public route /ticket/view/[token]/page.tsx: render the new
--        {status: 'voided'} branch as a clean "voided" page (no
--        plate / photos / location).
-- 3. Smoke per Jose's plan — see B175 greenlight; use RETURNING
--    discipline on every destructive write check.

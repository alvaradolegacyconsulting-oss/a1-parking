-- ═══════════════════════════════════════════════════════════════════
-- A1 Tow-Ticket Capability URL — view_token + 2 RPCs
-- Date:   2026-06-10
-- Branch: a1/tow-ticket-view
--
-- WHAT'S CHANGING
-- ───────────────
-- A confirmed tow ticket gets an unguessable capability URL. The
-- driver shares the URL from their own email/messaging client (no
-- system-sent email); the recipient clicks → /ticket/view/{token}
-- → sees a read-only hosted ticket view with details + photos. The
-- URL IS the credential — no login required.
--
-- Schema:
--   violations.view_token             TEXT UNIQUE
--   violations.view_token_expires_at  TIMESTAMPTZ
--   index on view_token for O(1) lookup
--
-- RPCs:
--   get_violation_by_view_token(p_token TEXT)
--     • SECURITY DEFINER (bypasses RLS; token IS auth)
--     • Anon-callable (the recipient has no account)
--     • Token ≥ 32 chars; expires_at > now(); is_confirmed = true
--       (NEVER expose drafts — consistent with F10 immutability)
--     • Returns violation + photos (removed_at IS NULL)
--
--   set_violation_view_token(p_violation_id BIGINT)
--     • SECURITY INVOKER (RLS applies — caller must own/scope the
--       violation; admin via admin_all; driver/CA/manager via their
--       own_violations policies)
--     • Authenticated-only
--     • 90-day expiry (Jose lock; regenerable via re-call)
--     • UPDATE gated on is_confirmed = true (never tokenize a draft)
--     • Returns { token, expires_at } or { error }
--
-- WHY THIS SHAPE (anchored to existing patterns)
-- ──────────────────────────────────────────────
-- The anon-callable DEFINER RPC mirrors B65's validate_proposal_code
-- (anon redeems a code) + B74's check_resident_plate (anon visitor
-- pre-check). The token-in-WHERE + expiry gate is the established
-- capability-URL pattern.
--
-- set_violation_view_token deliberately runs as INVOKER (not DEFINER)
-- so the existing F10 violations RLS policies gate writes per role:
--   • driver_update_violations (own-company property scope)
--   • manager_update_violations (assigned-properties scope)
--   • company_admin_update_violations (own-company scope)
--   • admin_update_violations (all)
-- No role-specific carve-out in the RPC body — the policies already
-- encode the right intent.
--
-- F10 INTERACTION
-- ───────────────
-- get_violation_by_view_token enforces is_confirmed = true, so the
-- public link for a draft is structurally impossible. Aligns with
-- the F10 lock that confirmed violations are the immutable record.
--
-- PRECONDITIONS
-- ─────────────
-- pgcrypto extension provides gen_random_bytes. Supabase has this
-- enabled by default.
--
-- APPLY DISCIPLINE
-- ────────────────
-- Single-paste single-run in Supabase SQL Editor. Pre-apply verifies
-- absence; post-apply verifies the new shape + grant pattern.
-- ═══════════════════════════════════════════════════════════════════


-- ── PRE-APPLY VERIFICATION ──────────────────────────────────────────
-- Expected: 0 rows. The columns + RPCs do not exist yet.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'violations'
   AND column_name IN ('view_token', 'view_token_expires_at');

SELECT proname FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname IN ('get_violation_by_view_token', 'set_violation_view_token');


-- ── SCHEMA ──────────────────────────────────────────────────────────
ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS view_token TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS view_token_expires_at TIMESTAMPTZ;

-- O(1) lookup by token (UNIQUE constraint already creates an index,
-- but partial-index on non-null view_token keeps the index tight
-- since most existing rows have view_token IS NULL).
CREATE INDEX IF NOT EXISTS violations_view_token_idx
  ON violations (view_token)
  WHERE view_token IS NOT NULL;


-- ── RPC 1: get_violation_by_view_token (anon-callable, DEFINER) ─────
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
BEGIN
  -- Input sanity. Token is 32 bytes base64-encoded + URL-safe → 43
  -- chars without padding. Reject obviously-malformed input early.
  IF p_token IS NULL OR length(p_token) < 32 THEN
    RETURN jsonb_build_object('error', 'invalid_token');
  END IF;

  -- Look up the violation by (token, not-expired, confirmed). The
  -- is_confirmed = true gate enforces F10 immutability at the link
  -- layer: a draft has no working public link.
  SELECT to_jsonb(v.*), v.id
    INTO v_violation, v_id
    FROM violations v
   WHERE v.view_token = p_token
     AND v.view_token_expires_at > now()
     AND v.is_confirmed = true;

  IF v_violation IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found_or_expired');
  END IF;

  -- Photos: active only (soft-deletes excluded). Ordered by id for
  -- stable display.
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

-- Grant pattern: REVOKE PUBLIC default + explicit anon + authenticated.
-- Discipline per [[feedback-function-public-grant-supabase-default]].
REVOKE EXECUTE ON FUNCTION public.get_violation_by_view_token(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_violation_by_view_token(TEXT) TO anon, authenticated;


-- ── RPC 2: set_violation_view_token (authenticated, INVOKER) ────────
-- INVOKER means RLS applies. The F10 violations UPDATE policies
-- (driver/CA/manager/admin) gate which roles can tokenize which
-- rows. No custom role gate in the body — policies are authoritative.
CREATE OR REPLACE FUNCTION public.set_violation_view_token(p_violation_id BIGINT)
RETURNS jsonb
LANGUAGE plpgsql
AS $func$
DECLARE
  v_token       TEXT;
  v_expires     TIMESTAMPTZ;
  v_updated_id  BIGINT;
BEGIN
  -- 90-day capability URL expiry. Regenerable by re-calling this RPC
  -- (the UNIQUE constraint accepts the new value since the prior is
  -- about to be overwritten on the same row).
  v_expires := now() + interval '90 days';

  -- 32 bytes (256 bits) of entropy, base64-encoded, URL-safe.
  --   gen_random_bytes(32)  → 32 random bytes
  --   encode(..., 'base64') → ~44 chars (43 + 1 padding)
  --   translate(+/= → -_)   → URL-safe; '=' padding stripped to fit
  v_token := translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');

  -- Direct UPDATE — RLS applies (caller's session). The F10 policies
  -- already encode who can update which rows; no custom gate needed.
  -- The is_confirmed = true gate ensures a draft never gets a token.
  UPDATE violations
     SET view_token            = v_token,
         view_token_expires_at = v_expires
   WHERE id = p_violation_id
     AND is_confirmed = true
  RETURNING id INTO v_updated_id;

  -- v_updated_id is NULL if (a) no row matched, (b) is_confirmed was
  -- false, OR (c) RLS denied the UPDATE. Single error discriminator.
  IF v_updated_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found_or_unauthorized');
  END IF;

  RETURN jsonb_build_object(
    'token',      v_token,
    'expires_at', v_expires
  );
END
$func$;

REVOKE EXECUTE ON FUNCTION public.set_violation_view_token(BIGINT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.set_violation_view_token(BIGINT) TO authenticated;


-- ── POST-APPLY VERIFICATION ─────────────────────────────────────────
-- Columns present + correct types.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'violations'
   AND column_name IN ('view_token', 'view_token_expires_at')
 ORDER BY column_name;
-- Expected:
--   view_token             | text                     | YES
--   view_token_expires_at  | timestamp with time zone | YES

-- Index present.
SELECT indexname FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename = 'violations'
   AND indexname = 'violations_view_token_idx';
-- Expected: 1 row.

-- RPCs present + DEFINER/INVOKER status correct.
SELECT proname,
       pg_get_function_arguments(oid) AS args,
       prosecdef                       AS is_security_definer
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname IN ('get_violation_by_view_token', 'set_violation_view_token')
 ORDER BY proname;
-- Expected:
--   get_violation_by_view_token | p_token text       | t (DEFINER)
--   set_violation_view_token    | p_violation_id bigint | f (INVOKER)

-- Grants — anon + authenticated for get; authenticated only for set.
SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE specific_schema = 'public'
   AND routine_name IN ('get_violation_by_view_token', 'set_violation_view_token')
   AND grantee IN ('anon', 'authenticated', 'PUBLIC')
 ORDER BY routine_name, grantee;
-- Expected:
--   get_violation_by_view_token | anon          | EXECUTE
--   get_violation_by_view_token | authenticated | EXECUTE
--   set_violation_view_token    | authenticated | EXECUTE
-- (PUBLIC should NOT appear — REVOKE'd.)

-- Behavior sanity: anon call with invalid token returns error.
SELECT public.get_violation_by_view_token('too-short');
-- Expected: {"error": "invalid_token"}

SELECT public.get_violation_by_view_token('this-token-does-not-exist-but-is-32+-chars-long-padding');
-- Expected: {"error": "not_found_or_expired"}


-- ── NEXT (manual) ───────────────────────────────────────────────────
-- 1. Deploy the public route app/ticket/view/[token]/page.tsx +
--    middleware allowlist + driver/CA wiring (this branch).
-- 2. Smoke:
--    • Generate a confirmed ticket → open the link incognito/no-login
--      → confirms details + photos render.
--    • Garbage / expired token → "not found" UI.
--    • A draft (somehow tokenized — shouldn't happen) → "not found"
--      via the is_confirmed gate.
--    • Mobile share-sheet + desktop mailto both pre-fill the storage
--      facility email.
-- 3. v2 hardening (separate arc, FILED): switch violation-photos
--    bucket from public to private + generate signed URLs at view
--    render time. Out of scope for v1 (conscious-accept: tow
--    photos low-PII; bucket pre-exists this build).

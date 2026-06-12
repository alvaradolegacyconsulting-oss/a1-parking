-- ═══════════════════════════════════════════════════════════════════
-- B120 Part 2 — Tow-ticket licensing resolution for public page +
--               CA-side TDLR capture
-- Date:   2026-06-12
-- Branch: feat/b120-ticket-licensing
--
-- WHY THIS MIGRATION
-- ──────────────────
-- The B120 diagnostic surfaced two structural facts:
--   1. The public capability-URL page (/ticket/view/<token>) is
--      unauthenticated and cannot read companies / storage_facilities
--      directly — B155.3 dropped the public-read policies on both.
--      The data fetch goes through get_violation_by_view_token, which
--      today returns only the violation row + photos. The operator
--      license is already snapshotted onto violations.driver_license
--      at insert time by the driver portal, but the company TDLR and
--      facility VSF licenses live on companies / storage_facilities
--      and are unreachable to the anon client.
--   2. companies.tdlr_license_number can only be set by admin today
--      (admin/page.tsx:838/896). The CA portal has no UPDATE path on
--      companies — no RLS policy permits CA writes there, by design
--      ([[admin-roles-not-writable-via-peer-rls]] / B155.4 lineage).
--      Mirroring the optional-VSF + optional-operator_license capture
--      patterns the CA already has, TDLR needs a CA-settable path.
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- PART 1 — Extend get_violation_by_view_token to resolve TDLR + VSF
-- server-side and fold them into the violation jsonb payload as
-- `resolved_tdlr_license` and `resolved_vsf_license`. Returns NULL
-- when the property→company chain finds nothing OR the company /
-- facility row has a null license value. The public template then
-- show-if-presents these alongside the existing driver_license
-- (which is already on the row via the driver portal's snapshot).
--
-- VSF resolution is SCOPED BY COMPANY (not name-only). The B179 /
-- B174 name-string fragility class would otherwise let a public
-- motorist-facing ticket surface the wrong company's VSF# if two
-- facilities ever shared a name across companies. The two-hop
-- property→company resolution is reused from the TDLR lookup so the
-- scope add is a single extra predicate, no extra join.
--
-- The voided + not-found + invalid_token branches are unchanged.
--
-- PART 2 — New `update_my_company_tdlr(p_tdlr TEXT)` DEFINER RPC.
-- Surgical: a CA can set ONLY their own company's TDLR via this
-- single-column write path. Role gate (company_admin only),
-- scope gate (companies.name ~~* get_my_company()), no other column
-- touched. Mirrors the surgical-RPC pattern from B175 + B178
-- (void_violation + stamp_tow_ticket).
--
-- WHY NOT BROADEN CA WRITE ACCESS TO companies
-- ────────────────────────────────────────────
-- A general CA UPDATE policy on companies would let a CA flip
-- is_active, change name / tier / theme / display_name — none of
-- which is in scope for B120. The named-column DEFINER RPC limits
-- the privilege to exactly the column the lane needs. If future
-- lanes need more CA-side company writes, each follows this same
-- per-column-RPC pattern (B175's void_violation et al.).
-- ═══════════════════════════════════════════════════════════════════


-- ── PRE-APPLY VERIFICATION ──────────────────────────────────────────
-- Current shape of get_violation_by_view_token (B175 modified — voided
-- branch should be intact).
SELECT proname, prosecdef AS is_security_definer,
       pg_get_function_arguments(oid) AS args
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname = 'get_violation_by_view_token';
-- Expected: 1 row, prosecdef = true, args = 'p_token text'.

-- update_my_company_tdlr should NOT exist yet.
SELECT proname FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname = 'update_my_company_tdlr';
-- Expected: 0 rows.


-- ═══════════════════════════════════════════════════════════════════
-- PART 1 — get_violation_by_view_token: TDLR + VSF resolution
-- ═══════════════════════════════════════════════════════════════════
-- Preserves the B175 voided branch + the original invalid_token /
-- not_found_or_expired discriminator. Only the success branch's
-- payload changes — the violation jsonb gains two resolved fields.

CREATE OR REPLACE FUNCTION public.get_violation_by_view_token(p_token TEXT)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_violation    jsonb;
  v_photos       jsonb;
  v_id           BIGINT;
  v_voided       TIMESTAMPTZ;
  v_property     TEXT;
  v_storage_name TEXT;
  v_company_name TEXT;
  v_tdlr         TEXT;
  v_vsf          TEXT;
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 THEN
    RETURN jsonb_build_object('error', 'invalid_token');
  END IF;

  SELECT v.id, v.voided_at
    INTO v_id, v_voided
    FROM violations v
   WHERE v.view_token = p_token
     AND v.is_confirmed = true;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found_or_expired');
  END IF;

  IF v_voided IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'voided');
  END IF;

  -- Load the full row + the resolution keys (property, tow_storage_name)
  -- in a single read.
  SELECT to_jsonb(v.*), v.property, v.tow_storage_name
    INTO v_violation, v_property, v_storage_name
    FROM violations v
   WHERE v.id = v_id
     AND v.view_token_expires_at > now();

  IF v_violation IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found_or_expired');
  END IF;

  -- Resolve property → company once. Reused for both TDLR (the
  -- company's licence) and VSF (scope the facility match to the
  -- company that issued the ticket — see VSF section below for why
  -- name-only matching is unsafe for a public legal surface).
  -- Two-hop: violations.property → properties.name → properties.company
  -- → companies. ILIKE matches per the codebase's case-insensitive
  -- convention ([[feedback-query-before-inferring]] + B174). LIMIT 1
  -- guards against duplicate property names across companies.
  SELECT c.name, c.tdlr_license_number
    INTO v_company_name, v_tdlr
    FROM properties p
    JOIN companies c ON c.name ~~* p.company
   WHERE p.name = v_property
   LIMIT 1;

  -- Resolve VSF via tow_storage_name SCOPED BY COMPANY. The B179 / B174
  -- name-string fragility class makes a name-only LIMIT 1 match unsafe
  -- here: two facilities could share a name across companies, and this
  -- is a motorist-facing legal document — resolving the wrong VSF# is a
  -- real cost. Scoping by storage_facilities.company ~~* v_company_name
  -- ensures we only ever surface a VSF# for a facility actually owned
  -- by the company that issued the ticket. Returns NULL if the company
  -- resolution chain is broken OR if no in-company facility matches
  -- (renamed / deleted / cross-company name collision) — show-if-present
  -- discipline takes over from there.
  IF v_storage_name IS NOT NULL AND v_company_name IS NOT NULL THEN
    SELECT vsf_license_number
      INTO v_vsf
      FROM storage_facilities
     WHERE name ~~* v_storage_name
       AND company ~~* v_company_name
     LIMIT 1;
  END IF;

  -- Fold the resolved licenses into the violation payload.
  v_violation := v_violation || jsonb_build_object(
    'resolved_tdlr_license', v_tdlr,
    'resolved_vsf_license',  v_vsf
  );

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

-- Re-affirm grants (no change from baseline — anon + authenticated).
REVOKE EXECUTE ON FUNCTION public.get_violation_by_view_token(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_violation_by_view_token(TEXT) TO anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════
-- PART 2 — update_my_company_tdlr DEFINER RPC
-- ═══════════════════════════════════════════════════════════════════
-- Surgical single-column UPDATE for a CA on their own company.
-- Role gate (company_admin), scope gate (own company name match).
-- No other column touched. Returns {ok:true} or {error:'...'}.

CREATE OR REPLACE FUNCTION public.update_my_company_tdlr(p_tdlr TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_company      TEXT;
  v_updated_id   BIGINT;
  v_norm_tdlr    TEXT;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  -- Role gate — CA only. Admin uses the existing admin portal path;
  -- this RPC is specifically for the CA's own-company write.
  IF v_caller_role <> 'company_admin' THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  v_company := get_my_company();
  IF v_company IS NULL OR length(trim(v_company)) = 0 THEN
    RETURN jsonb_build_object('error', 'no_company_scope');
  END IF;

  -- Normalize input: empty string / whitespace-only → NULL (matches
  -- the admin portal's `editingCompany.tdlr_license_number || null`
  -- coercion at admin/page.tsx:246).
  v_norm_tdlr := NULLIF(trim(coalesce(p_tdlr, '')), '');

  UPDATE companies
     SET tdlr_license_number = v_norm_tdlr
   WHERE name ~~* v_company
  RETURNING id INTO v_updated_id;

  IF v_updated_id IS NULL THEN
    RETURN jsonb_build_object('error', 'company_not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'tdlr_license_number', v_norm_tdlr);
END
$func$;

REVOKE EXECUTE ON FUNCTION public.update_my_company_tdlr(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_my_company_tdlr(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.update_my_company_tdlr(TEXT) TO authenticated;


-- ── POST-APPLY VERIFICATION ─────────────────────────────────────────

-- 1. get_violation_by_view_token still DEFINER, args unchanged.
SELECT proname, prosecdef AS is_security_definer,
       pg_get_function_arguments(oid) AS args
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname = 'get_violation_by_view_token';
-- Expected: prosecdef = true; args = 'p_token text'.

-- 2. update_my_company_tdlr exists + DEFINER.
SELECT proname, prosecdef AS is_security_definer,
       pg_get_function_arguments(oid) AS args
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname = 'update_my_company_tdlr';
-- Expected: 1 row; prosecdef = true; args = 'p_tdlr text'.

-- 3. Grant table — load-bearing per the REVOKE-from-anon discipline.
SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE specific_schema = 'public'
   AND routine_name IN ('get_violation_by_view_token', 'update_my_company_tdlr')
   AND grantee IN ('anon', 'authenticated', 'PUBLIC')
 ORDER BY routine_name, grantee;
-- Expected EXACTLY:
--   get_violation_by_view_token | anon          | EXECUTE
--   get_violation_by_view_token | authenticated | EXECUTE
--   update_my_company_tdlr      | authenticated | EXECUTE
-- update_my_company_tdlr MUST NOT show anon or PUBLIC.


-- ── NEXT (manual smoke after apply) ─────────────────────────────────
-- 1. Set TDLR on Demo Towing via the new CA tab (post-deploy).
-- 2. Set operator_license on a driver (existing CA UI).
-- 3. Set VSF on a storage facility (existing CA UI).
-- 4. Generate a tow ticket via the driver portal → grab the public
--    view_token link.
-- 5. Hit /ticket/view/<token> in a no-session window → confirm TDLR
--    + VSF render alongside the operator license.
-- 6. NULL CASE — clear TDLR or use a different company with no TDLR
--    set; confirm the field renders as nothing (no blank line).

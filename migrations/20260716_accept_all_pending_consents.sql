-- ════════════════════════════════════════════════════════════════════
-- accept_all_pending_consents — atomic role-conditional consent write
-- P1 CONSENT HARD-GATE Commit 1 of 5 · 2026-07-16
--
-- ═══ WHAT THIS RPC EXISTS FOR ═══════════════════════════════════════
-- The portal-layout server gate (Commit 3) redirects authenticated
-- users to /consent when they're missing any required doc at current
-- version. /consent renders the missing docs via scroll-to-sign,
-- collects reviewed_at stamps, and calls THIS RPC once to write
-- everything atomically. All-or-none — a user who accepts 2 of 4
-- required docs and drops must be re-gated for the remaining 2 on
-- next portal load.
--
-- ═══ TWO LOAD-BEARING INVARIANTS ═══════════════════════════════════
-- 🔴 INVARIANT 1 — ATOMIC.
--   plpgsql fn body runs in ONE transaction. Any RAISE anywhere in
--   the body rolls back EVERY insert made so far. No partial-consent
--   state possible: caller either gets ALL missing docs written or
--   NONE (with a RAISE they can act on).
--
-- 🔴 INVARIANT 2 — company_id SERVER-DERIVED, NEVER CLIENT-SUPPLIED.
--   Every INSERT sets company_id = derived via
--   lower(trim(auth.jwt() ->> 'email')) → user_roles.company →
--   companies.name lower(trim(...)) join. Same pattern as
--   accept_signup_consents, accept_tos, accept_saas_agreement (2026-
--   07-13 derivation extension). Trust auth + our own tables; never
--   an arg. RAISE if derivation misses for non-admin roles.
--
-- ═══ ROLE MATRIX (Mateo decision 6, 2026-07-16) ═════════════════════
--   driver / resident / manager / leasing_agent → tos + privacy
--   company_admin                                → tos + privacy + saas + texas
--
--   super-admin (role='admin')                   → tos + privacy only.
--     Admin is NOT subscribing/contracting so SaaS+Texas don't apply.
--     Same 2-doc set as PM/LA/driver/resident.
--     v_company_id IS NULL is legitimate for admin (no user_roles.company);
--     inserts still land with NULL company_id (audit still keyed on
--     user_id + document_type + version, so no join loss).
--
-- ═══ IDEMPOTENCY ═══════════════════════════════════════════════════
--   Per-doc IF NOT EXISTS on (user_id, document_type, <version_col>).
--   Re-calling with the same versions is a no-op for already-consented
--   docs — writes only the missing ones. Client can call unconditionally
--   without knowing what's already stamped.
--
-- ═══ WHAT DOES NOT CHANGE ═══════════════════════════════════════════
--   • Existing single-doc RPCs (accept_tos 4-arg, accept_saas_agreement
--     4-arg) — untouched by this migration. Retired in Commit 5 once
--     the login modal is deleted and no callers remain.
--   • tos_acceptances schema — no ALTER TABLE. Uses existing columns
--     verbatim: user_id, company_id, document_type, tos_version,
--     privacy_version, attestation_version, saas_version, ip_address,
--     user_agent, reviewed_at.
--   • user_roles version-stamp columns — same set as existing RPCs
--     stamp (tos_accepted_at, tos_accepted_version,
--     privacy_accepted_version, saas_accepted_version, texas_confirmed).
--
-- ═══ DISCIPLINE ════════════════════════════════════════════════════
--   DROP-first + pg_proc overload=1 assertion + REVOKE PUBLIC + REVOKE
--   anon + GRANT authenticated. Dollar-quoted audit rationale.
--   Companion verification file exercises: atomicity (partial failure
--   rolls back), company_id derivation (all rows tagged), role-
--   conditional (CA gets 4 rows, driver gets 2), idempotency (re-call
--   is no-op), missing-required-arg RAISE.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION IF EXISTS public.accept_all_pending_consents(
  TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, INET, TEXT
);

CREATE FUNCTION public.accept_all_pending_consents(
  p_tos_version         TEXT,
  p_tos_reviewed_at     TIMESTAMPTZ,
  p_privacy_version     TEXT,
  p_privacy_reviewed_at TIMESTAMPTZ,
  p_saas_version        TEXT        DEFAULT NULL,
  p_saas_reviewed_at    TIMESTAMPTZ DEFAULT NULL,
  p_texas_version       TEXT        DEFAULT NULL,
  p_ip_address          INET        DEFAULT NULL,
  p_user_agent          TEXT        DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_uid    UUID;
  v_caller_email  TEXT;
  v_role          TEXT;
  v_company_id    BIGINT;
  v_inserted      JSONB := '[]'::jsonb;
BEGIN
  -- ─── Auth + role resolution ────────────────────────────────────────
  v_caller_uid   := auth.uid();
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_uid IS NULL OR v_caller_email IS NULL OR v_caller_email = '' THEN
    RAISE EXCEPTION 'accept_all_pending_consents: no authenticated session' USING ERRCODE = '42501';
  END IF;

  -- Server-side company_id derivation. Same lower(trim(...)) join as
  -- accept_signup_consents / accept_tos / accept_saas_agreement.
  SELECT ur.role, c.id
    INTO v_role, v_company_id
    FROM public.user_roles ur
    LEFT JOIN public.companies c
      ON lower(trim(c.name)) = lower(trim(ur.company))
   WHERE lower(ur.email) = lower(v_caller_email)
   LIMIT 1;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'accept_all_pending_consents: no user_roles row for authenticated caller: %',
      v_caller_email USING ERRCODE = '42501';
  END IF;

  -- v_company_id IS NULL is legitimately valid only for role='admin'
  -- (super-admin never has user_roles.company). Every other role must
  -- resolve or we're about to leave orphan NULL company_id rows.
  IF v_company_id IS NULL AND v_role <> 'admin' THEN
    RAISE EXCEPTION 'accept_all_pending_consents: could not derive company_id for role=% (user_roles.company unmatched or NULL)', v_role
      USING ERRCODE = '42501',
            HINT = 'Check user_roles.company vs companies.name for lower(trim(...)) match';
  END IF;

  -- ─── Required-arg validation (role-conditional) ───────────────────
  -- ToS + Privacy are required for EVERY role.
  IF p_tos_version IS NULL OR length(trim(p_tos_version)) = 0 THEN
    RAISE EXCEPTION 'p_tos_version required' USING ERRCODE = '22004';
  END IF;
  IF p_privacy_version IS NULL OR length(trim(p_privacy_version)) = 0 THEN
    RAISE EXCEPTION 'p_privacy_version required' USING ERRCODE = '22004';
  END IF;

  -- SaaS + Texas required ONLY for company_admin.
  IF v_role = 'company_admin' THEN
    IF p_saas_version IS NULL OR length(trim(p_saas_version)) = 0 THEN
      RAISE EXCEPTION 'p_saas_version required for role=company_admin' USING ERRCODE = '22004';
    END IF;
    IF p_texas_version IS NULL OR length(trim(p_texas_version)) = 0 THEN
      RAISE EXCEPTION 'p_texas_version required for role=company_admin' USING ERRCODE = '22004';
    END IF;
  END IF;

  -- ─── ATOMIC INSERT PASS (idempotent per doc) ──────────────────────
  -- Any RAISE below rolls back every insert made so far in this fn body.
  -- IF NOT EXISTS guards make re-calls no-ops per doc.

  -- 1. tos
  IF NOT EXISTS (
    SELECT 1 FROM tos_acceptances
    WHERE user_id = v_caller_uid AND document_type = 'tos' AND tos_version = p_tos_version
  ) THEN
    INSERT INTO tos_acceptances (
      user_id, company_id, document_type, tos_version,
      privacy_version, attestation_version,
      ip_address, user_agent, reviewed_at
    ) VALUES (
      v_caller_uid, v_company_id, 'tos', p_tos_version,
      NULL, NULL,
      p_ip_address, p_user_agent, p_tos_reviewed_at
    );
    v_inserted := v_inserted || jsonb_build_array('tos');
  END IF;

  -- 2. privacy
  IF NOT EXISTS (
    SELECT 1 FROM tos_acceptances
    WHERE user_id = v_caller_uid AND document_type = 'privacy' AND privacy_version = p_privacy_version
  ) THEN
    INSERT INTO tos_acceptances (
      user_id, company_id, document_type, tos_version,
      privacy_version, attestation_version,
      ip_address, user_agent, reviewed_at
    ) VALUES (
      v_caller_uid, v_company_id, 'privacy', NULL,
      p_privacy_version, NULL,
      p_ip_address, p_user_agent, p_privacy_reviewed_at
    );
    v_inserted := v_inserted || jsonb_build_array('privacy');
  END IF;

  -- 3. saas + 4. texas — company_admin ONLY
  IF v_role = 'company_admin' THEN
    IF NOT EXISTS (
      SELECT 1 FROM tos_acceptances
      WHERE user_id = v_caller_uid AND document_type = 'saas' AND saas_version = p_saas_version
    ) THEN
      INSERT INTO tos_acceptances (
        user_id, company_id, document_type,
        saas_version, ip_address, user_agent, reviewed_at
      ) VALUES (
        v_caller_uid, v_company_id, 'saas',
        p_saas_version, p_ip_address, p_user_agent, p_saas_reviewed_at
      );
      v_inserted := v_inserted || jsonb_build_array('saas');
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM tos_acceptances
      WHERE user_id = v_caller_uid AND document_type = 'texas_attestation' AND attestation_version = p_texas_version
    ) THEN
      INSERT INTO tos_acceptances (
        user_id, company_id, document_type,
        tos_version, privacy_version, attestation_version,
        ip_address, user_agent
      ) VALUES (
        v_caller_uid, v_company_id, 'texas_attestation',
        NULL, NULL, p_texas_version,
        p_ip_address, p_user_agent
      );
      v_inserted := v_inserted || jsonb_build_array('texas_attestation');
    END IF;
  END IF;

  -- ─── Stamp user_roles version columns (idempotent) ────────────────
  -- Belt-and-suspenders: rows in tos_acceptances are the source of
  -- truth per Mateo decision ("consented = row existence at current
  -- version, NOT the user_roles stamp"). Stamps are convenience for
  -- legacy callers + reporting; NULL-friendly COALESCE keeps them
  -- monotonic (later re-accept doesn't clear a prior version stamp).
  UPDATE user_roles
     SET tos_accepted_at      = COALESCE(tos_accepted_at, now()),
         tos_accepted_version = COALESCE(p_tos_version, tos_accepted_version),
         privacy_accepted_version = COALESCE(p_privacy_version, privacy_accepted_version)
   WHERE lower(email) = lower(v_caller_email);

  IF v_role = 'company_admin' THEN
    UPDATE user_roles
       SET saas_accepted_version = COALESCE(p_saas_version, saas_accepted_version),
           texas_confirmed = TRUE
     WHERE lower(email) = lower(v_caller_email);
  END IF;

  RETURN jsonb_build_object(
    'ok',         TRUE,
    'email',      v_caller_email,
    'role',       v_role,
    'company_id', v_company_id,
    'inserted',   v_inserted
  );
END
$func$;

REVOKE EXECUTE ON FUNCTION public.accept_all_pending_consents(TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, INET, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.accept_all_pending_consents(TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, INET, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.accept_all_pending_consents(TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TEXT, INET, TEXT) TO authenticated;

DO $chk$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_all_pending_consents';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'accept_all_pending_consents has % overloads; expected 1', v_count;
  END IF;
END $chk$;

-- ══════════════════════════════════════════════════════════════════
-- SCHEMA_ audit
-- ══════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_ACCEPT_ALL_PENDING_CONSENTS',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260716_accept_all_pending_consents',
    'change',    $txt$New atomic role-conditional consent-write RPC accept_all_pending_consents(9 args). Called by /consent (P1 hard-gate Commit 2) to write every missing consent row for the caller's role in ONE transaction. Idempotent per (user_id, document_type, version) — re-calls skip already-consented docs. Role matrix: driver/resident/manager/leasing_agent → tos + privacy; company_admin → tos + privacy + saas + texas_attestation; admin → tos + privacy (no company_id required). Server-derived company_id via lower(trim(email)) → user_roles.company → companies.name join. Companion single-doc RPCs (accept_tos 4-arg, accept_saas_agreement 4-arg) stay untouched; retired in Commit 5 once no callers remain.$txt$,
    'rationale', $txt$P1 consent hard-gate arc replaces the bypassable /login soft-modal (setShowTosModal). New gate is portal-layout server-check → /consent → this RPC → redirectByRole. Two load-bearing invariants: (1) ATOMIC — plpgsql fn body is one transaction; any RAISE rolls back all inserts; no partial-consent state possible. (2) company_id SERVER-DERIVED, never client-supplied — every INSERT tags the correct tenancy. Both are the two most-common ways a consent RPC gets subtly wrong; they're guarded structurally.$txt$,
    'convention_codified', $txt$Multi-doc consent writes MUST be atomic (all-or-nothing per call) and MUST server-derive company_id from auth.jwt() email → user_roles → companies join. Client passes only version strings + reviewed_at stamps + ip/user_agent (optional). Client-supplied company_id is a design smell.$txt$
  ),
  now()
);

COMMIT;

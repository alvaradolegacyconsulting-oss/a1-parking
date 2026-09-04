-- ══════════════════════════════════════════════════════════════════════
-- 20260904_accept_saas_agreement_relax_selfserve_preflight.sql
--
-- 🔴 SELF-SERVE UNBLOCKER — accept_saas_agreement chicken-and-egg
--
-- ── ORIGIN ──────────────────────────────────────────────────────────
-- Sep 4 2026 rehearsal: Jose walked the live self-serve flow and hit
-- 'accept_saas_agreement: no user_roles row for authenticated caller'
-- at the SaaS agreement gate. Deadlock:
--   • accept_saas_agreement requires a user_roles row (2026-07-13 add)
--   • user_roles is created by the webhook AFTER checkout completes
--   • checkout can't be reached without signing SaaS
--
-- Backlog: docs/backlog/accept-saas-agreement-selfserve-chicken-and-egg.md
--
-- ── DECISION ────────────────────────────────────────────────────────
-- Option A: relax the RPC to accept the self-serve pre-checkout shape
-- (no user_roles row → legitimate NULL). Mirror accept_signup_consents,
-- which the SAME 2026-07-13 migration explicitly designed for this
-- shape ('Legitimate NULL: pre-checkout self-serve (no user_roles row
-- yet)' — comment at RPC 1 of 4, line 74).
--
-- REJECTED (Sep 4 report): move SaaS to post-provisioning. Would
-- charge the customer BEFORE they accept the master contract.
-- Refund liability + inconsistent with tos/privacy/attestation, which
-- already precede payment.
--
-- ── READER AUDIT (Sep 4) ────────────────────────────────────────────
-- Two fields go unset for self-serve subscribers post-fix:
--   • tos_acceptances.company_id → NULL
--   • user_roles.saas_accepted_version → NULL
--
-- Grep of app/ found ZERO runtime readers for either:
--
--   user_roles.saas_accepted_version:
--     - legal-versions.ts:51 (explicit: "Login-modal predicate does
--       NOT read saas_accepted_version — SaaS re-sign is deliberate
--       UX, not auto-prompt")
--     - No middleware, login gate, or billing check consults it
--
--   tos_acceptances.company_id:
--     - Only referenced by 2026-07-13 migrations + one script
--     - No app-code SELECT filters on it
--     - Linkability from tos_acceptances → company runs via the join:
--       auth.users.id → user_roles.email → user_roles.company →
--       companies.name (lower+trim) — same chain the 2026-07-13
--       backfill migration uses
--
-- Conclusion: NULL is a forensic-quality gap, not a runtime one.
-- No backfill trigger + no webhook-side backfill needed.
--
-- ── CHANGES ─────────────────────────────────────────────────────────
-- Two guard removals in the accept_saas_agreement body:
--
--   • REMOVED — 2026-07-13:L545-547
--       IF v_caller_role IS NULL THEN RAISE
--         'accept_saas_agreement: no user_roles row for authenticated
--         caller'
--
--   • REMOVED — 2026-07-13:L549-553
--       IF v_company_id IS NULL AND v_caller_role <> 'admin' THEN
--         RAISE 'accept_saas_agreement: could not derive company_id
--         for role=% (user_roles.company unmatched or NULL)'
--
-- Everything else preserved verbatim:
--   • Auth guard (auth.uid + auth.jwt email) — unchanged
--   • p_saas_version / p_reviewed_at required — unchanged
--   • Idempotency check on (user_id, document_type='saas', saas_version)
--   • INSERT into tos_acceptances (company_id may be NULL, legitimate)
--   • UPDATE user_roles.saas_accepted_version — naturally no-ops when
--     the row doesn't exist yet (WHERE lower(email) = ... matches 0)
--   • Signature (TEXT, TIMESTAMPTZ, INET, TEXT) → VOID — unchanged
--   • SECURITY DEFINER + SET search_path — unchanged
--   • Grants (revoked PUBLIC + anon, granted authenticated) — unchanged
--
-- ── SIDE EFFECT (POSITIVE) ──────────────────────────────────────────
-- checkout-session-completed.ts:315-323 documents that the SaaS row
-- lookup in writeOrderFormSnapshot currently finds nothing (RPC has
-- been throwing pre-checkout, so no row exists to find). Post-fix,
-- the row WILL exist with company_id=NULL. Lookup keys on user_id +
-- document_type='saas', not on company_id, so it finds cleanly.
-- Order Form snapshots will start including SaaS info. Positive
-- collateral fix.
--
-- ── saas_accepted_version PERMANENT-NULL POSTURE (self-serve) ───────
-- In the real self-serve flow, nothing re-calls accept_saas_agreement
-- after provisioning. The RPC fires ONCE pre-checkout from
-- /signup/verify's handleSaasSigned; the webhook doesn't call it,
-- and no login/middleware/billing gate re-prompts (per
-- legal-versions.ts:51 "Login-modal predicate does NOT read
-- saas_accepted_version — SaaS re-sign is deliberate UX, not
-- auto-prompt"). So user_roles.saas_accepted_version stays NULL for
-- every self-serve subscriber PERMANENTLY.
--
-- This is accepted (zero readers — 2026-09-04 audit). Recording here
-- so it isn't rediscovered as a fresh finding: NULL saas_accepted_version
-- on a live company_admin row is the expected self-serve shape,
-- distinguishable from redeem/proposal-code CAs whose row IS stamped
-- via redeem_proposal_code's inline SAAS section (2026-07-07
-- b118_layer2_saas_redeem_extension.sql).
--
-- Forensic query "which self-serve CAs accepted SaaS?" runs against
-- tos_acceptances document_type='saas' + saas_version + user_id,
-- joined to user_roles by email — NOT user_roles.saas_accepted_version.
--
-- If a version bump ever needs to re-prompt subscribers, the redeem
-- pattern applies: EITHER add a post-provisioning re-call site (login
-- predicate + accept_all_pending_consents), OR write a bulk backfill
-- migration for the target user_roles.saas_accepted_version cohort.
--
-- ── PARITY CAPTURE ──────────────────────────────────────────────────
-- pg_proc(prosecdef, proconfig, proacl) captured before + after in
-- the audit row. Signature unchanged; only body + comments differ.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- Part 1 — Pre-replace parity capture
-- ══════════════════════════════════════════════════════════════════════
DO $capture$
DECLARE
  v_prosecdef BOOLEAN;
  v_proconfig TEXT[];
  v_proacl    TEXT[];
  v_signature TEXT;
BEGIN
  SELECT p.prosecdef,
         p.proconfig,
         p.proacl::TEXT[],
         pg_get_function_identity_arguments(p.oid)
    INTO v_prosecdef, v_proconfig, v_proacl, v_signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'accept_saas_agreement'
   LIMIT 1;

  IF v_signature IS NULL THEN
    RAISE EXCEPTION 'Pre-replace parity: accept_saas_agreement not found. Abort — this migration edits an existing function; there''s nothing to replace.';
  END IF;

  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'Pre-replace parity: accept_saas_agreement is NOT SECURITY DEFINER (prosecdef=%). Refusing to replace — investigate before rewriting.', v_prosecdef;
  END IF;

  RAISE NOTICE 'Pre-replace parity captured: signature=%, prosecdef=%, proconfig=%, proacl=%',
    v_signature, v_prosecdef, v_proconfig, v_proacl;
END $capture$;


-- ══════════════════════════════════════════════════════════════════════
-- Part 2 — CREATE OR REPLACE with the relaxed guards
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.accept_saas_agreement(
  p_saas_version TEXT,
  p_reviewed_at  TIMESTAMPTZ,
  p_ip_address   INET DEFAULT NULL,
  p_user_agent   TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $body$
DECLARE
  v_caller_uid    UUID;
  v_caller_email  TEXT;
  v_caller_role   TEXT;
  v_company_id    BIGINT;
BEGIN
  v_caller_uid   := auth.uid();
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_uid IS NULL OR v_caller_email IS NULL OR v_caller_email = '' THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  IF p_saas_version IS NULL OR length(p_saas_version) = 0 THEN
    RAISE EXCEPTION 'p_saas_version required' USING ERRCODE = '22004';
  END IF;

  IF p_reviewed_at IS NULL THEN
    RAISE EXCEPTION 'p_reviewed_at required (client stamp when gate unlocked)' USING ERRCODE = '22004';
  END IF;

  -- Server-side derivation. NULL v_company_id AND NULL v_caller_role
  -- are both legitimate on the self-serve pre-checkout path — the
  -- webhook creates user_roles AFTER checkout completes, so the
  -- SaaS acceptance necessarily precedes it.
  --
  -- Mirrors accept_signup_consents at the same 2026-07-13 migration
  -- (RPC 1 of 4, line 74 comment: "Legitimate NULL: pre-checkout
  -- self-serve (no user_roles row yet)"). accept_signup_consents
  -- writes 3 rows with company_id=NULL on the same pre-checkout
  -- shape; this RPC now writes the 4th.
  SELECT ur.role, c.id
    INTO v_caller_role, v_company_id
    FROM public.user_roles ur
    LEFT JOIN public.companies c
      ON lower(trim(c.name)) = lower(trim(ur.company))
   WHERE lower(ur.email) = lower(v_caller_email)
   LIMIT 1;

  -- ── Idempotent write on (user_id, document_type='saas', saas_version).
  -- Same user re-signing the same version: no new row. Version bump:
  -- new row. company_id may be NULL (self-serve pre-checkout —
  -- forensic queries resolve via the auth.users → user_roles →
  -- companies join, same chain the 2026-07-13 backfill uses).
  IF NOT EXISTS (
    SELECT 1 FROM public.tos_acceptances
    WHERE user_id = v_caller_uid
      AND document_type = 'saas'
      AND saas_version = p_saas_version
  ) THEN
    INSERT INTO public.tos_acceptances (
      user_id,
      company_id,
      document_type,
      saas_version,
      reviewed_at,
      ip_address,
      user_agent
    ) VALUES (
      v_caller_uid,
      v_company_id,        -- May be NULL on self-serve pre-checkout
      'saas',
      p_saas_version,
      p_reviewed_at,
      p_ip_address,
      p_user_agent
    );
  END IF;

  -- ── Stamp user_roles.saas_accepted_version. Naturally a no-op on the
  -- self-serve pre-checkout path (WHERE lower(email)=... matches 0
  -- rows because user_roles doesn't exist yet). This is INTENTIONAL —
  -- legal-versions.ts:51 explicitly documents that the login-modal
  -- predicate does NOT read saas_accepted_version ("SaaS re-sign is
  -- deliberate UX, not auto-prompt"). The field is evidence-only.
  -- For redeem/post-provisioning callers with a user_roles row, this
  -- stamps as before.
  UPDATE public.user_roles
     SET saas_accepted_version = COALESCE(p_saas_version, saas_accepted_version)
   WHERE lower(email) = lower(v_caller_email);
END
$body$;


-- ══════════════════════════════════════════════════════════════════════
-- Part 3 — Post-replace parity assertion
-- ══════════════════════════════════════════════════════════════════════
DO $parity$
DECLARE
  v_prosecdef BOOLEAN;
  v_proconfig TEXT[];
  v_proacl    TEXT[];
  v_signature TEXT;
  v_body      TEXT;
BEGIN
  SELECT p.prosecdef,
         p.proconfig,
         p.proacl::TEXT[],
         pg_get_function_identity_arguments(p.oid),
         pg_get_functiondef(p.oid)
    INTO v_prosecdef, v_proconfig, v_proacl, v_signature, v_body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'accept_saas_agreement'
   LIMIT 1;

  IF v_signature IS NULL THEN
    RAISE EXCEPTION 'Parity FAIL: accept_saas_agreement missing post-replace';
  END IF;

  IF v_prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'Parity FAIL: prosecdef=% (want TRUE) — SECURITY DEFINER lost during replace', v_prosecdef;
  END IF;

  IF NOT ('search_path=public' = ANY(v_proconfig)) THEN
    RAISE EXCEPTION 'Parity FAIL: proconfig=% (want [search_path=public]) — SET search_path lost during replace', v_proconfig;
  END IF;

  -- Body substring assertions — presence of the intended shape.
  -- The two removed RAISEs should be gone; the write path should
  -- pass v_company_id through unconditionally.
  IF v_body LIKE '%no user_roles row for authenticated caller%' THEN
    RAISE EXCEPTION 'Parity FAIL: body still contains the removed "no user_roles row" RAISE — relaxation did not apply';
  END IF;

  IF v_body LIKE '%could not derive company_id for role%' THEN
    RAISE EXCEPTION 'Parity FAIL: body still contains the removed "could not derive company_id" RAISE — relaxation did not apply';
  END IF;

  IF v_body NOT LIKE '%Legitimate NULL: pre-checkout self-serve%'
     AND v_body NOT LIKE '%legitimate on the self-serve pre-checkout path%' THEN
    RAISE EXCEPTION 'Parity FAIL: body missing self-serve pre-checkout documentation comment — relaxation did not include intent record';
  END IF;

  RAISE NOTICE 'Post-replace parity OK: signature=%, prosecdef=%, proconfig=%, proacl=%',
    v_signature, v_prosecdef, v_proconfig, v_proacl;
END $parity$;


-- ══════════════════════════════════════════════════════════════════════
-- Part 4 — Restate grants (defense in depth after CREATE OR REPLACE)
-- ══════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE preserves grants, but restating them makes the
-- migration idempotent and self-contained if any grant drifted.
REVOKE ALL ON FUNCTION public.accept_saas_agreement(TEXT, TIMESTAMPTZ, INET, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_saas_agreement(TEXT, TIMESTAMPTZ, INET, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_saas_agreement(TEXT, TIMESTAMPTZ, INET, TEXT) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- Part 5 — Audit row
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_ACCEPT_SAAS_AGREEMENT_RELAX',
  'public.accept_saas_agreement',
  'rpc_relaxation_selfserve_preflight',
  jsonb_build_object(
    'migration',            '20260904_accept_saas_agreement_relax_selfserve_preflight',
    'arc',                  'Sep 4 rehearsal chicken-and-egg unblocker — mirror accept_signup_consents pattern',
    'removed_raises', jsonb_build_array(
      jsonb_build_object(
        'guard', 'v_caller_role IS NULL',
        'phrase', 'accept_saas_agreement: no user_roles row for authenticated caller',
        'origin', '2026-07-13_tos_acceptances_company_id_derivation.sql:L545-547',
        'rationale', 'False assumption that every SaaS-accept caller has a user_roles row. Self-serve pre-checkout is a legitimate no-row shape — webhook creates user_roles AFTER checkout, so SaaS accept necessarily precedes it.'
      ),
      jsonb_build_object(
        'guard', 'v_company_id IS NULL AND v_caller_role <> ''admin''',
        'phrase', 'accept_saas_agreement: could not derive company_id for role=%',
        'origin', '2026-07-13_tos_acceptances_company_id_derivation.sql:L549-553',
        'rationale', 'Same false assumption re: company_id derivation. NULL is legitimate for self-serve pre-checkout; forensic queries resolve via the auth.users → user_roles → companies join.'
      )
    ),
    'sibling_precedent',    'accept_signup_consents at same 2026-07-13 migration (RPC 1 of 4, L74): "Legitimate NULL: pre-checkout self-serve (no user_roles row yet)". Writes 3 rows with company_id=NULL on the same shape; this RPC now writes the 4th.',
    'reader_audit',         jsonb_build_object(
      'tos_acceptances.company_id',    'Zero app-code readers; only migration + one script hit. Linkability via join.',
      'user_roles.saas_accepted_version', 'Zero readers; legal-versions.ts:51 explicit — login-modal predicate does NOT read it (SaaS re-sign is deliberate UX, not auto-prompt).'
    ),
    'positive_collateral',  'checkout-session-completed.ts:315-323 writeOrderFormSnapshot SaaS lookup will now find the row (currently "skips + logs"); Order Form snapshots will include SaaS info.',
    'signature_unchanged',  'accept_saas_agreement(TEXT, TIMESTAMPTZ, INET, TEXT) → VOID',
    'grants_unchanged',     'PUBLIC + anon revoked; authenticated granted',
    'next',                 'Rehearsal re-run with fresh plus-address (previous consumed by auth.users UNIQUE(lower(email))); then public_signup_open flip.'
  ),
  now()
);


-- ══════════════════════════════════════════════════════════════════════
-- Part 6 — PostgREST cache reload
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

COMMIT;

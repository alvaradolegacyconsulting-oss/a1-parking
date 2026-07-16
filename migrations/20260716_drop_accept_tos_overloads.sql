-- ════════════════════════════════════════════════════════════════════
-- Drop accept_tos overloads — P1 consent hard-gate Commit 5b.1 cleanup
-- 2026-07-16
--
-- ── WHAT + WHY ──────────────────────────────────────────────────────
-- Removes both overloads of public.accept_tos — the 0-arg legacy
-- (2026-05-13 shipped) and the 4-arg extended (2026-07-10 shipped,
-- 2026-07-13 company_id-derivation-updated) — after the P1 consent
-- hard-gate arc replaced their sole remaining caller.
--
-- Sole live caller was /login/page.tsx's acceptTos() handler, which
-- was RETIRED in Commit 4 (8c2fe3b, 2026-07-16). Post-Commit-4
-- caller-audit via grep across app/ + scripts/ returned ZERO remaining
-- callers of accept_tos (both overloads). Consent writes now flow
-- through accept_all_pending_consents (Commit 1 · 255313f) via the
-- /consent route (Commit 2 · da981d5) after the portal-layout gate
-- (Commits 3a/3b · 613b045 + 1ca8940) redirects unconsented users there.
--
-- ── WHY accept_saas_agreement STAYS (deferral breadcrumb) ───────────
-- The sibling function accept_saas_agreement(TEXT, TIMESTAMPTZ, INET,
-- TEXT) was considered for drop in the same audit and DEFERRED. It has
-- ONE live production caller: [app/api/signup/accept-saas/route.ts:60].
-- That route serves the self-serve signup path — user is authenticated
-- (email verified) but has NO user_roles row yet (company + role are
-- created after Stripe checkout completion). accept_all_pending_consents
-- REQUIRES a user_roles row (RAISEs if missing), so it cannot replace
-- the signup-path caller. Different context — signup-scoped RPC serving
-- authenticated-without-role users vs. hard-gate RPC serving
-- authenticated-with-role users.
--
-- accept_saas_agreement stays in production. Its retirement (or absorption
-- into a new signup-path atomic RPC) is deferred to B2-8 — the formal
-- backlog item covering signup-path server-side consent + the role-less
-- forward-path issue. See docs/backlog/B2-8-signup-path-consent.md (this
-- commit) + the project_b28_signup_path_consent_forward_path memory doc.
--
-- ── SCOPE ───────────────────────────────────────────────────────────
-- Drop-only. No schema changes elsewhere. No RLS changes. No data
-- touched. No user_roles.tos_accepted_* stamp columns removed
-- (kept as belt-and-suspenders for reporting; accept_all_pending_consents
-- keeps writing them monotonically per its Commit 1 body).
--
-- ── DISCIPLINE ──────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS per overload (idempotent — safe if either
-- was already gone). pg_proc COUNT=0 assertion for accept_tos afterward.
-- Whole migration in ONE transaction. Dollar-quoted audit prose.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION IF EXISTS public.accept_tos();
DROP FUNCTION IF EXISTS public.accept_tos(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ);

DO $chk$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_tos';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'accept_tos: expected 0 overloads after drop, found %', v_count;
  END IF;
END $chk$;


-- ══════════════════════════════════════════════════════════════════
-- SCHEMA_ audit — captures rationale + deferral breadcrumb
-- ══════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_ACCEPT_TOS_RETIRED',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260716_drop_accept_tos_overloads',
    'change',    $txt$Dropped both accept_tos overloads: the 0-arg legacy (2026-05-13) and the 4-arg extended (2026-07-10 shipped, 2026-07-13 company_id-derivation-updated). Sole live caller was /login/page.tsx acceptTos(), retired in Commit 4 (8c2fe3b, 2026-07-16). Consent writes now flow through accept_all_pending_consents (Commit 1 · 255313f) via /consent route (Commit 2 · da981d5) after portal-layout gates (Commits 3a/3b · 613b045 + 1ca8940) redirect unconsented users there.$txt$,
    'rationale', $txt$Post-Commit-4 caller-audit via grep across app/ + scripts/ returned zero remaining callers of accept_tos across both overloads (only comment references remained — /reset-password-required/page.tsx:28 documented the pattern historically; migration files defined the RPC). Retiring the dead RPC removes an unused GRANT surface + a divergent write path that could not disagree with the hard-gate RPC because it had no caller — but leaving dead RPCs is a maintenance-hygiene issue.$txt$,
    'deferral_breadcrumb', $txt$accept_saas_agreement(TEXT, TIMESTAMPTZ, INET, TEXT) was considered for drop in the same audit and DEFERRED. It has ONE live production caller: app/api/signup/accept-saas/route.ts:60, serving the self-serve signup path (authenticated user WITHOUT user_roles row yet — company + role created after Stripe checkout). accept_all_pending_consents cannot replace it (RAISEs on missing user_roles row). Different context. accept_saas_agreement retirement is deferred to B2-8 (docs/backlog/B2-8-signup-path-consent.md), which will decide whether to migrate to a new signup-path atomic RPC or keep it signup-scoped.$txt$,
    'convention_codified', $txt$Post-arc RPC retirement: drop only after (a) grep-verified zero live callers across app/ + scripts/, (b) documented deferral for any sibling RPC that stays alive due to a distinct-context caller. Audit row captures the deferral breadcrumb so the next reader finds the reasoning without re-discovering it.$txt$
  ),
  now()
);

COMMIT;

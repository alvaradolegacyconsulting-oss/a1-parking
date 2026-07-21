-- ═══════════════════════════════════════════════════════════════════════
-- 20260721_company_name_available_rpc.sql
-- ═══════════════════════════════════════════════════════════════════════
-- B2-1 Commit 1 — pre-flight uniqueness check for the self-serve signup
-- path. Called by /api/signup/create-checkout-session BEFORE creating a
-- Stripe Checkout Session so a duplicate company name is caught while
-- the prospect is still on-site and no money has moved.
--
-- ── Why this RPC exists ─────────────────────────────────────────────────
-- The DB has a unique index on lower(trim(companies.name))
-- (companies_name_lower_unique). Before today, the webhook handler
-- (checkout-session-completed.ts) contained an app-layer disambiguation
-- loop that appended " (2)", " (3)", etc., silently renaming the customer
-- POST-payment. That's worse than a stack trace: the customer paid,
-- accepted a SaaS Agreement referencing "Company", then landed with a
-- company they didn't name. Legal exposure + support surface.
--
-- The disambiguation loop is deleted in Commit 2. This Commit 1 moves
-- the check pre-payment so the collision surfaces on the form and
-- Stripe is never touched. Belt (this RPC) + suspenders (unique index
-- still fires if the pre-check ever misses).
--
-- ── Why the normalization matters ───────────────────────────────────────
-- The index normalizes with lower(trim(name)). The old app-layer loop
-- used ilike('name', $1) which is case-insensitive but whitespace-
-- sensitive — a stored " Acme Wrecker" vs a requested "Acme Wrecker"
-- would miss the collision, the INSERT would then 23505, webhook would
-- 500, Stripe would retry for 72h — customer paid, unprovisioned.
-- This RPC uses lower(trim($1)) = lower(trim(name)) exact-equality,
-- matching the index. Same normalization or the check is theatre.
-- (Convention codified in 743e519 pm_plate_lookup hardening.)
--
-- ── ACL discipline ──────────────────────────────────────────────────────
-- SECURITY DEFINER + REVOKE PUBLIC/anon + GRANT authenticated.
-- Caller is /api/signup/create-checkout-session (authenticated user only —
-- route rejects anon at line 48). Not exposed to unauth callers because
-- (a) it's not needed there yet, (b) the anon surface exposes signal
-- about which companies exist — best to keep enumeration off until we
-- actually need a client-side "name available" chip (Bar-3 candidate,
-- would need rate-limiting).
--
-- DEFAULT NULL-safety: p_name IS NULL / empty string returns FALSE
-- (i.e., "not available"). Prevents the caller from short-circuiting
-- past the check on a malformed input.

BEGIN;

DROP FUNCTION IF EXISTS public.company_name_available(TEXT);

CREATE OR REPLACE FUNCTION public.company_name_available(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $func$
  SELECT
    CASE
      WHEN p_name IS NULL OR length(trim(p_name)) = 0 THEN FALSE
      ELSE NOT EXISTS (
        SELECT 1 FROM public.companies
         WHERE lower(trim(name)) = lower(trim(p_name))
      )
    END;
$func$;

REVOKE ALL ON FUNCTION public.company_name_available(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.company_name_available(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.company_name_available(TEXT) TO authenticated;

-- Overload guard — this file must be the only definer for this name.
DO $chk$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'company_name_available';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'company_name_available has % overloads; expected 1', v_count;
  END IF;
END $chk$;

-- ── SCHEMA_ audit ──────────────────────────────────────────────────────
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_COMPANY_NAME_AVAILABLE_RPC',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260721_company_name_available_rpc',
    'purpose',   'B2-1 Commit 1 pre-flight duplicate-company-name check for /api/signup/create-checkout-session. Returns TRUE if the trimmed lower-case name is not already in use; FALSE otherwise (including NULL/empty input). Matches the normalization used by the companies_name_lower_unique index (lower(trim(name))) — case+whitespace insensitive. Caller redirects to /signup/verify?error=name_taken on FALSE, no Stripe session created, no charge.',
    'convention_codified', 'lower(trim($1)) = lower(trim(column)) — same-normalization rule from 743e519 pm_plate_lookup hardening. ILIKE against raw column is whitespace-sensitive and misses the DB constraint; never use ILIKE where a unique index normalizes.',
    'blast_radius', 'Self-serve signup path only. Proposal-code path is untouched (redeem_proposal_code has its own inline company creation with its own uniqueness handling). A1 unaffected.',
    'acl', 'SECURITY DEFINER, REVOKE PUBLIC/anon, GRANT authenticated. Anon not granted — enumeration signal held back until Bar-3 needs client-side available-chip (would need rate-limiting).'
  ),
  now()
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- FOLLOW-UP to wip-20261022_visitor_pass_token.sql — one line
-- ════════════════════════════════════════════════════════════════════
--
-- 🔴 WHAT WENT WRONG. mint_pass_token_if_printable called
-- gen_random_bytes(32) unqualified. pgcrypto installs that function in
-- the 'extensions' schema, not public, and the function pins
-- SET search_path = public, pg_temp — correct minimum-leak posture for a
-- SECURITY DEFINER function, and precisely why the call cannot resolve.
--
-- Every structural check passed: the function exists, prosecdef is set,
-- the grants are right, anon is refused. Name resolution inside a
-- plpgsql body is LAZY — deferred to first execution — so nothing is
-- wrong until someone actually issues a pass at a switch-ON property,
-- and then:
--
--   42883: function gen_random_bytes(integer) does not exist
--
-- This repo already learned this, in
-- migrations/20260611_b178_evidence_field_lockdown.sql:289, whose
-- comment predicts this failure in these words. The Piece 2 minter
-- copied the token's SHAPE from the pre-fix 20260610 version and
-- inherited the bug with it.
--
-- OBSERVED, not inferred: calling the minter as service_role against a
-- freshly inserted switch-ON property at Test-PM returned 42883, and so
-- did issue_visitor_pass, which calls it inside the INSERT.
--
-- BLAST RADIUS, read from the live catalogue: exactly one property has
-- printable_visitor_passes_enabled = true — Northgate Commerce Center
-- at Demo Company (company_env = 'demo'). No production tenant and no
-- A1 property is affected: for a switch-OFF property the minter returns
-- NULL from the IF above, never reaching gen_random_bytes, so pass
-- issuance everywhere else is untouched. The demo property IS affected,
-- which means the next prospect demo at Northgate could not issue a
-- visitor pass until this is applied.
--
-- ONLY the minter changes. issue_visitor_pass resolves the minter by
-- name at call time, so replacing the minter's body is sufficient — the
-- 300-line issue_visitor_pass body is NOT re-applied, and must not be.
--
-- CREATE OR REPLACE drops parameter DEFAULTs; p_property has none, so
-- there is nothing to preserve. It preserves grants and the comment,
-- both restated below anyway so this file is self-contained.
--
-- Apply: Supabase SQL Editor. No BEGIN/COMMIT.
-- Paired: wip-20261022_pass_token_pgcrypto_schema_qualify_verification.sql
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.mint_pass_token_if_printable(p_property TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_on BOOLEAN;
BEGIN
  SELECT printable_visitor_passes_enabled INTO v_on
    FROM public.properties
   WHERE lower(trim(name)) = lower(trim(p_property))
   LIMIT 1;
  -- 🔴 NULL is OFF. A property whose switch has never been set, and a
  -- property name that matches no row, both yield NULL — and neither
  -- is a reason to mint a token. Absence is not permission.
  IF v_on IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  -- 32 bytes (256 bits), base64, URL-safe, '=' padding translated out.
  -- 🔴 extensions.gen_random_bytes, SCHEMA-QUALIFIED. pgcrypto lives in
  -- 'extensions' and this function's search_path deliberately does not
  -- include it. Unqualified, this line resolves at first call and
  -- raises 42883 — invisible to every structural check.
  RETURN translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
END
$fn$;

REVOKE ALL ON FUNCTION public.mint_pass_token_if_printable(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mint_pass_token_if_printable(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.mint_pass_token_if_printable(TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.mint_pass_token_if_printable(TEXT) IS
  'Returns a fresh 256-bit URL-safe token when the named property has printable_visitor_passes_enabled = TRUE, and NULL otherwise — including when the switch is unset or the property name matches no row, because absence is not permission. Split out of issue_visitor_pass so the switch is consulted in exactly one place. 🔴 gen_random_bytes is schema-qualified as extensions.gen_random_bytes: pgcrypto is not on this function''s pinned search_path, and an unqualified call raises 42883 at first execution while passing every structural check.';

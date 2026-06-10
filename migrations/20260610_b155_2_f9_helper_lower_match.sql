-- ═══════════════════════════════════════════════════════════════════
-- B155.2 — F9 helper wildcard fix
-- Date:   2026-06-10
-- Branch: b155-2/helper-fix-plus-policy-tightens
--
-- WHAT'S CHANGING
-- ───────────────
-- Replace the three RLS scope helpers (get_my_role, get_my_company,
-- get_my_properties) to match on `lower(email) = lower(auth.jwt() ->>
-- 'email')` instead of `email ILIKE auth.jwt() ->> 'email'`.
--
-- WHY (security finding)
-- ──────────────────────
-- ILIKE treats `_` and `%` in its right-hand side as wildcards. The
-- RHS is the user's JWT email — so a user with `_` in their email
-- local-part can match other emails. Example: john_doe@x.com → the
-- helper runs `email ILIKE 'john_doe@x.com'` → `_` is a single-char
-- wildcard → matches johnXdoe@x.com (any X). LIMIT 1 with no ORDER
-- BY picks one non-deterministically. Result: a session could be
-- assigned the role/company/properties of a DIFFERENT tenant's user.
--
-- Same class as B166's owner-trim wildcard bug, but in the RLS scope
-- plumbing every policy depends on. Targeted-attack registerable.
--
-- The fix swaps the ILIKE for `lower(col) = lower(val)` — explicit
-- case-insensitive exact match, no wildcard interpretation.
--
-- This is FIRST in the B155.2 sequence: the matrix probe assumes
-- helper identity resolution is trustworthy. Until F9 lands, a
-- colliding test email would corrupt the probe's POS/NEG asserts.
--
-- The broader policy-level ILIKE sweep (dozens of `email ~~* ...`
-- predicates) is B174 — runs AFTER the matrix probe ships, with the
-- matrix re-running as the regression gate.
--
-- APPLY DISCIPLINE
-- ────────────────
-- Single-paste, single-run in Supabase SQL Editor. Pre-apply
-- verification documents the broken shape; post-apply confirms the
-- fixed shape.
-- ═══════════════════════════════════════════════════════════════════


-- ── PRE-APPLY VERIFICATION ──────────────────────────────────────────
-- Expected: 3 rows, all bodies containing 'ILIKE' (~~* operator).
-- If any body already contains 'lower(email) = lower' — the migration
-- has run before; investigate before re-applying.
SELECT
  proname  AS func,
  pg_get_functiondef(oid) AS body
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('get_my_role', 'get_my_company', 'get_my_properties')
ORDER BY proname;


-- ── APPLY ───────────────────────────────────────────────────────────
-- CREATE OR REPLACE preserves grants + ownership; only swaps the body.
-- LIMIT 1 retained (single-row-per-email is the documented assumption;
-- the UNIQUE constraint is a separate Bar-2 item).

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
AS $func$
  SELECT role FROM user_roles
  WHERE lower(email) = lower(auth.jwt() ->> 'email')
  LIMIT 1
$func$;

CREATE OR REPLACE FUNCTION public.get_my_company()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
AS $func$
  SELECT company FROM user_roles
  WHERE lower(email) = lower(auth.jwt() ->> 'email')
  LIMIT 1
$func$;

CREATE OR REPLACE FUNCTION public.get_my_properties()
RETURNS text[]
LANGUAGE sql
STABLE SECURITY DEFINER
AS $func$
  SELECT property FROM user_roles
  WHERE lower(email) = lower(auth.jwt() ->> 'email')
  LIMIT 1
$func$;


-- ── POST-APPLY VERIFICATION (body shape) ────────────────────────────
-- Expected: 3 rows. Each body must contain
--   'lower(email) = lower(auth.jwt() ->> ''email'')'
-- and must NOT contain 'ILIKE' or '~~*'.
SELECT
  proname  AS func,
  pg_get_functiondef(oid) AS body,
  position('lower(email)' in pg_get_functiondef(oid)) > 0 AS has_lower,
  position('ILIKE' in pg_get_functiondef(oid))        AS has_ilike_pos,
  position('~~*'   in pg_get_functiondef(oid))        AS has_tilde_pos
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('get_my_role', 'get_my_company', 'get_my_properties')
ORDER BY proname;
-- Expected per row: has_lower = true; has_ilike_pos = 0; has_tilde_pos = 0.


-- ── POST-APPLY VERIFICATION (compile sanity) ────────────────────────
-- Calling the helpers without a JWT (run from SQL Editor as postgres)
-- returns NULL — confirms the bodies parse and the LIMIT 1 + null
-- email path returns null cleanly. The compile sanity, not a behavior
-- check (real behavior tested by the matrix probe).
SELECT
  get_my_role()       AS role_anon,
  get_my_company()    AS company_anon,
  get_my_properties() AS properties_anon;
-- Expected: all three NULL.


-- ── NEXT (manual) ───────────────────────────────────────────────────
-- After F9 applies cleanly, apply 20260610_b155_2_policy_tightens.sql
-- which lands the F1/F2/F4/F5/F6/F7 cell tightens. The matrix probe
-- gets built against the post-tighten shape, NOT the as-built over-
-- permissions.

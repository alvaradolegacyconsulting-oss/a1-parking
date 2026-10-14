-- ════════════════════════════════════════════════════════════════════
-- STEP 3 — get_my_role / get_my_company / get_my_properties:
--          is_active, pinned search_path, deterministic order
-- ════════════════════════════════════════════════════════════════════
-- 🔴 THE LARGEST-BLAST-RADIUS CHANGE IN THIS ARC. The capture says
-- 159 policies and 58 functions inherit these three. One line changes
-- behaviour everywhere at once, which is why the sweep came first.
--
-- ── WHAT EACH CHANGE IS FOR ─────────────────────────────────────────
--
-- 1. AND is_active — the point. Measured on a canary: after a per-user
--    deactivation the session still returned get_my_role() = 'manager'
--    and still read residents and vehicles through direct PostgREST.
--    The portal gate is client-side and is not in that path. Step 2
--    now bans the login, which refuses a refresh — but an
--    already-issued access token kept returning HTTP 200 for its full
--    60-minute life (measured with a raw bearer, no SDK session
--    state). This closes that residual window at the next query.
--
-- 2. SET search_path = public, pg_temp — these are SECURITY DEFINER
--    with search_path unpinned, which is the classic definer-hijack
--    surface. Zero behavioural risk; it should always have been there.
--
-- 3. ORDER BY id — LIMIT 1 with no ORDER BY returns an ARBITRARY row.
--    With 159 policies behind these helpers, "arbitrary" means a
--    person's access could differ between two requests. 🔴 ASCENDING
--    on purpose: oldest row wins, so a row inserted later can never
--    supersede an existing identity. Nothing in the codebase UPDATEs
--    user_roles.role (grepped: zero sites), so oldest-wins has no
--    legitimate downside and removes an escalation shape.
--
-- ── MEASURED BEFORE WRITING THIS ────────────────────────────────────
--   386 user_roles rows, 🔴 ZERO with is_active NULL, across all six
--   roles — so `AND is_active` cuts off exactly the rows meant, and a
--   COALESCE would be dead code pretending to handle a case that does
--   not exist.
--
--   🔴 Exactly 4 rows are cut off, all A1, all already deactivated:
--     driver   alexsandra.hidalgo@gmail.com
--     manager  amanda.a1wreckerllc+properties@gmail.com
--     manager  amanda.a1wreckerllc+greenacres@gmail.com
--     manager  amanda.a1wreckerllc+property@gmail.com
--   The capture said 5; it was taken before the one-off. The fifth was
--   amandacanchol@gmail.com, now a correctly ACTIVE resident, so it is
--   right that she is no longer on this list.
--
--   0 of 386 emails hold more than one user_roles row, so ORDER BY id
--   never actually arbitrates today. It is there so that it cannot.
--
-- ── 🔴 THE CONSEQUENCE THAT WOULD HAVE BEEN A LOGIN LOOP ────────────
-- A deactivated user must still reach /deactivated and be told their
-- access was removed — not a blank portal and not a login loop. That
-- routing goes through get_my_effective_active(), which reads
-- user_roles DIRECTLY (`SELECT role, company, property, is_active
-- FROM public.user_roles WHERE lower(email) = lower(v_email)`) and
-- does NOT call get_my_role(). So it is unaffected. The paired
-- verification asserts that it still does not call these helpers,
-- because the day it does, this change starts hiding the explanation
-- from the person who needs it.
--
-- ── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────
-- It does not touch EXECUTE grants. These are DEFINER functions and
-- sweep class 4 flags PUBLIC/anon EXECUTE on any of them — but
-- revoking it here would change the reachability of 159 policies in
-- the same commit as their semantics. The verification REPORTS the
-- grant state so the decision is made on a number, separately.
-- (anon calling get_my_role() gets NULL anyway: there is no JWT.)
--
-- CREATE OR REPLACE preserves grants and ownership and only swaps the
-- body. None of the three takes a parameter, so the
-- CREATE-OR-REPLACE-drops-DEFAULTS trap does not apply.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
  SELECT role FROM public.user_roles
   WHERE lower(email) = lower(auth.jwt() ->> 'email')
     AND is_active
   ORDER BY id
   LIMIT 1
$func$;

CREATE OR REPLACE FUNCTION public.get_my_company()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
  SELECT company FROM public.user_roles
   WHERE lower(email) = lower(auth.jwt() ->> 'email')
     AND is_active
   ORDER BY id
   LIMIT 1
$func$;

CREATE OR REPLACE FUNCTION public.get_my_properties()
RETURNS text[]
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
  SELECT property FROM public.user_roles
   WHERE lower(email) = lower(auth.jwt() ->> 'email')
     AND is_active
   ORDER BY id
   LIMIT 1
$func$;

COMMENT ON FUNCTION public.get_my_role() IS
  'The caller''s role, from user_roles keyed on lower(email) from the JWT. '
  '🔴 2026-10-15: gained AND is_active, a pinned search_path, and ORDER BY id. '
  'Before that a deactivated user still resolved to their role and read tenant data through direct PostgREST — the portal gate is client-side and not in that path. '
  'ORDER BY id is ASCENDING so a row inserted later cannot supersede an existing identity; nothing in the codebase UPDATEs user_roles.role. '
  '159 policies and 58 functions inherit this body — change it only behind a full sweep, and never without the role-by-role positive controls in scripts/verify-identity-helpers.ts.';

COMMIT;

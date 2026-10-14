-- ════════════════════════════════════════════════════════════════════
-- ONE-OFF — close the live deactivated-manager login on
--           amandacanchol@gmail.com
-- ════════════════════════════════════════════════════════════════════
-- 🔴 DO NOT RUN ANY STEP WITHOUT READING STEP 0 FIRST.
--
-- 🔴 AND DO NOT RUN STEP B WITHOUT READING WHY IT IS NOT THE
--    RECOMMENDATION. A ban was the instruction; the evidence found
--    after it was given says a ban breaks a current process.
--
-- ── WHAT THIS ACCOUNT ACTUALLY IS ───────────────────────────────────
-- One address, TWO identities:
--
--   user_roles 627   manager, A1 Wrecker llc, ["Sugarberry Place"]
--                    is_active = FALSE since 2026-08-10
--                    auth.users.banned_until = NULL  ← the exposure
--
--   residents  656   "Amanda Canchola", Southfork Lake Apartments
--                    is_active = TRUE, status = 'active'
--                    created 2026-07-30                ← a LIVE resident
--
--   auth.users       created 2026-07-15T14:43:56 (1s before the role
--                    row — the invite flow makes auth first)
--                    🔴 last_sign_in_at 2026-08-21T16:19:41
--                       = 11 days AFTER the manager deactivation
--
-- So the exposure is real and was exercised — but banning the auth
-- user would also lock out an active resident record. That is why this
-- file leads with deleting the dead ROLE rather than banning the LOGIN.
--
-- ── WHY THE BAN WAS MISSING (answered from the audit log) ───────────
-- All four per-user deactivation sites DO call swift-handler
-- (action: deactivate_user / activate_user), which is what set the
-- 2126 bans on the other four deactivated A1 rows — ban_duration of
-- ~100 years. The ban is BEST-EFFORT, and its failures are audited:
--
--   2026-08-10T21:40  deactivate_user  amandacanchol@gmail.com
--   {"ban_error":"User not found","is_active":false,"ban_applied":false}
--
-- The auth user existed since 2026-07-15, so "User not found" was a
-- swift-handler lookup failure, not a missing user. company_admin's own
-- code comments carry the query for finding these; 7 audit rows have
-- ban_applied=false, and this is the only one on a live A1 account.
-- The step-2 route must therefore treat a ban failure as a FAILURE,
-- not a note.

-- ════════════════════════════════════════════════════════════════════
-- STEP 0 — REVIEW. Read-only. Run this and read it before anything.
-- ════════════════════════════════════════════════════════════════════
SELECT 'user_roles' AS what, ur.id::TEXT AS id, ur.email, ur.role, ur.company,
       ur.is_active::TEXT AS is_active, ur.created_at::TEXT AS created_at,
       array_to_string(ur.property, ' | ') AS detail
  FROM public.user_roles ur
 WHERE lower(btrim(ur.email)) = 'amandacanchol@gmail.com'
UNION ALL
SELECT 'residents', r.id::TEXT, r.email, r.status, r.company,
       r.is_active::TEXT, r.created_at::TEXT, r.property || ' · ' || COALESCE(r.name,'')
  FROM public.residents r
 WHERE lower(btrim(r.email)) = 'amandacanchol@gmail.com'
UNION ALL
SELECT 'auth.users', u.id::TEXT, u.email, '—', '—',
       CASE WHEN u.banned_until IS NULL THEN 'LOGIN LIVE' ELSE 'banned' END,
       u.created_at::TEXT,
       'last_sign_in_at ' || COALESCE(u.last_sign_in_at::TEXT, 'never')
  FROM auth.users u
 WHERE lower(btrim(u.email)) = 'amandacanchol@gmail.com'
 ORDER BY 1;

-- ════════════════════════════════════════════════════════════════════
-- STEP A — RECOMMENDED. Delete the dead manager role. Login untouched.
-- ════════════════════════════════════════════════════════════════════
-- Closes the escalation at its source: with no manager row, get_my_role()
-- returns nothing for this address and no manager policy can match it —
-- the same remedy already applied to row 875. Her resident record and
-- her login are left alone, so nothing a live user does today breaks.
--
-- Guard-claused: it refuses unless the row is EXACTLY the one reviewed
-- above — right id, right email, right role, and still deactivated. An
-- unfilled or stale target must fail loudly, not match something else.
DO $do$
DECLARE
  v_id    BIGINT := 627;     -- from STEP 0. Change only if STEP 0 disagrees.
  v_email TEXT   := 'amandacanchol@gmail.com';
  v_row   public.user_roles;
BEGIN
  SELECT * INTO v_row FROM public.user_roles WHERE id = v_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_roles id % does not exist — STEP 0 output is stale, re-read it', v_id;
  END IF;
  IF lower(btrim(v_row.email)) <> v_email THEN
    RAISE EXCEPTION 'id % is %, not % — refusing to delete the wrong row', v_id, v_row.email, v_email;
  END IF;
  IF v_row.role <> 'manager' THEN
    RAISE EXCEPTION 'id % is role %, expected manager — refusing', v_id, v_row.role;
  END IF;
  IF v_row.is_active IS NOT FALSE THEN
    RAISE EXCEPTION 'id % is is_active=% — it is NOT deactivated, so deleting it would remove live access', v_id, v_row.is_active;
  END IF;
  RAISE NOTICE 'pre-flight OK: id=% email=% role=% company=% is_active=%',
    v_row.id, v_row.email, v_row.role, v_row.company, v_row.is_active;
END
$do$;

-- Run this second, after the NOTICE above says pre-flight OK.
-- RETURNING, so the write set is countable rather than assumed.
DELETE FROM public.user_roles
 WHERE id = 627
   AND lower(btrim(email)) = 'amandacanchol@gmail.com'
   AND role = 'manager'
   AND is_active IS FALSE
RETURNING id, email, role, company, is_active, array_to_string(property, ' | ') AS property;
-- Expect exactly 1 row. Zero rows means the guard predicate no longer
-- matches — stop and re-read STEP 0 rather than loosening it.

-- ════════════════════════════════════════════════════════════════════
-- STEP A2 — then check whether her RESIDENT identity needs a role row
-- ════════════════════════════════════════════════════════════════════
-- She is the one live resident in the system with a login and no
-- resident user_roles row (measured: 343 live residents with a login,
-- 1 missing a resident role row). After STEP A she has none at all, so
-- her resident portal may land blank — the no-role-row dead-end class.
--
-- Read this, then decide. Do NOT create the row blind: a role row is
-- access, and inventing one is a product decision.
SELECT r.id AS resident_id, r.name, r.email, r.property, r.unit, r.is_active, r.status,
       (SELECT count(*) FROM public.user_roles ur
         WHERE lower(btrim(ur.email)) = lower(btrim(r.email))) AS user_roles_rows_remaining
  FROM public.residents r
 WHERE lower(btrim(r.email)) = 'amandacanchol@gmail.com';

-- ════════════════════════════════════════════════════════════════════
-- STEP B — THE BAN. 🔴 NOT RECOMMENDED. Read this before running it.
-- ════════════════════════════════════════════════════════════════════
-- This was the original instruction, and it does close the exposure.
-- It also 🔴 LOCKS OUT residents row 656 — "Amanda Canchola" at
-- Southfork Lake Apartments, is_active=true, status='active' — because
-- the ban is on the LOGIN and the login serves both identities. She
-- signed in on 2026-08-21, so this is a live account, not a dormant one.
--
-- Run it only if A1 confirms she does not use this address at all, in
-- which case deactivating the resident record is the honest companion
-- step and should be decided at the same time.
--
-- Reversible: UPDATE auth.users SET banned_until = NULL WHERE ... —
-- but a locked-out resident will not know that, and will call A1.
--
-- Uncomment deliberately, not by habit.
--
-- UPDATE auth.users
--    SET banned_until = (now() + INTERVAL '100 years')
--  WHERE lower(btrim(email)) = 'amandacanchol@gmail.com'
--    AND banned_until IS NULL
-- RETURNING id, email, banned_until, last_sign_in_at;
--
-- -- Refresh-token revocation. A ban already refuses a refresh
-- -- ("Invalid Refresh Token: User Banned", measured), so this is belt
-- -- rather than the control. 🔴 It does NOT revoke an access token
-- -- already issued: a raw bearer kept returning HTTP 200 for the full
-- -- 60-minute token life after both is_active=false AND the ban
-- -- (measured with a direct PostgREST call, no SDK session state). That
-- -- residual window is what the helper is_active term closes, and it is
-- -- why that step is still needed.
-- UPDATE auth.refresh_tokens t
--    SET revoked = TRUE
--  WHERE t.user_id::TEXT IN (
--          SELECT u.id::TEXT FROM auth.users u
--           WHERE lower(btrim(u.email)) = 'amandacanchol@gmail.com')
--    AND t.revoked IS NOT TRUE
-- RETURNING t.id, t.user_id, t.revoked;

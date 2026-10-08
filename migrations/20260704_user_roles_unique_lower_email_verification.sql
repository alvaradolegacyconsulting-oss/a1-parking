-- ════════════════════════════════════════════════════════════════════
-- Verification for 20260704_user_roles_unique_lower_email.sql
-- Pre-written 2026-07-04 alongside the migration; runs in two phases
-- (BEFORE apply as a gate; AFTER apply to lock in the invariant).
-- ════════════════════════════════════════════════════════════════════


-- ── §PRE. PRE-APPLY GATE — run BEFORE applying the migration ─────────
-- Expected: 0 rows. If any rows returned, the wipe/dedup wasn't
-- complete; STOP and finish it before proceeding. The migration will
-- fail-closed on 23505 anyway, but this pre-check surfaces the state
-- with the full dup detail so cleanup is targeted.
SELECT '§PRE · duplicate-email counter (must be 0 before apply)' AS section;
SELECT lower(email) AS lowered_email,
       COUNT(*) AS dup_count,
       array_agg(role ORDER BY id) AS roles,
       array_agg(id ORDER BY id) AS ids
  FROM public.user_roles
 GROUP BY lower(email)
HAVING COUNT(*) > 1
 ORDER BY dup_count DESC, lowered_email;


-- ── §A. Index exists + correct expression ────────────────────────────
SELECT '§A · unique index present with correct shape' AS section;
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname='public' AND tablename='user_roles'
   AND indexname='user_roles_lower_email_uidx';
-- Expected: 1 row; indexdef contains 'CREATE UNIQUE INDEX' + 'lower(email)'.


-- ── §B. Constraint enforcement smoke (MANUAL — inside a rolled-back tx) ─
-- Run this block in a fresh SQL Editor tab if you want to spot-verify.
-- The BEGIN/ROLLBACK guarantees no data change.
--
--   BEGIN;
--   INSERT INTO public.user_roles (email, role, company)
--     VALUES ('__verify_lower_email_test@example.com', 'resident', 'X');
--   -- Second insert with different case must fail with 23505:
--   INSERT INTO public.user_roles (email, role, company)
--     VALUES ('__VERIFY_LOWER_EMAIL_TEST@example.com', 'resident', 'X');
--   ROLLBACK;
--
-- Expected: first INSERT succeeds; second raises 23505 unique_violation
-- referencing user_roles_lower_email_uidx. ROLLBACK cleans up.


-- ── §C. Post-apply duplicate re-check (belt-and-suspenders) ──────────
SELECT '§C · post-apply duplicate check (must remain 0)' AS section;
SELECT lower(email) AS lowered_email, COUNT(*) AS dup_count
  FROM public.user_roles
 GROUP BY lower(email)
HAVING COUNT(*) > 1
 ORDER BY dup_count DESC;


-- ── §D. get_my_role() body reference (no change; sanity that helper exists) ─
SELECT '§D · get_my_role helper exists (unchanged; UNIQUE now locks its LIMIT 1)' AS section;
SELECT proname, prosecdef AS is_definer, provolatile
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname = 'get_my_role';
-- Expected: 1 row, is_definer=TRUE.

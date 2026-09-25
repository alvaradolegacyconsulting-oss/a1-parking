-- ════════════════════════════════════════════════════════════════════
-- delete_orphaned_pending_resident — v3
-- Narrow the auth guard to UNBANNED logins, and put the live function
-- back in the repo.
-- ════════════════════════════════════════════════════════════════════
--
-- 🔴 WHAT WAS BROKEN
--
-- This RPC returned 0 and deleted nothing on EVERY call. Every failed
-- add-resident since left an orphan row behind, and nothing reported it.
--
-- The live function did not match 20260710_delete_orphaned_pending_resident_rpc.sql.
-- It carried an extra predicate in all three branches:
--
--     AND NOT EXISTS (
--       SELECT 1 FROM auth.users WHERE lower(email) = v_norm_email
--     )
--
-- The intent is right: never hard-delete a resident who has a working
-- login. It just treats a BANNED account as a working one.
--
-- The rollback in app/manager/page.tsx (and the company_admin twin) BANS
-- the orphaned auth account and does not delete it — and it does so
-- BEFORE calling this function. So auth.users always still holds the row
-- when the delete runs, the NOT EXISTS is always false, and the DELETE
-- matches nothing. Guaranteed 0, every time, by construction.
--
-- Confirmed in audit_logs: every ROLLBACK_DELETE_RESIDENT row carries
-- rows_deleted: 0 and source: delete_orphaned_pending_resident_v2.
--
-- ════════════════════════════════════════════════════════════════════
-- 🔴 THIS IS A REVERSAL OF A REVERSAL. READ BEFORE CHANGING THE GUARD.
-- ════════════════════════════════════════════════════════════════════
--
-- v1 (20260710) CONSIDERED an auth-existence guard and REJECTED IT IN
-- WRITING, at lines 42-51 of that file:
--
--   "WHY NOT check auth.users existence? Considered; rejected. The
--    rollback fires immediately (microseconds) after a residents INSERT
--    that landed but before/during a subsequent step that failed. In
--    that window auth.users may or may not exist depending on which step
--    failed. The auth-existence predicate would either over-block (if
--    auth exists from another company's prior successful create with the
--    same email — the cross-tenant case) or under-block (race).
--    Role-derived scope + audit trail is simpler and correct."
--
-- v2 reintroduced that exact predicate, undocumented, applied outside
-- the repo. The rejection had named the failure; the reinstatement
-- didn't know the rejection existed, because the only place the guard
-- was written down was a client-side comment in company_admin/page.tsx.
-- That is how this hid for ten weeks: the repo and the database
-- disagreed, and nobody could diff them.
--
-- v3 keeps a NARROWED form of the guard rather than reverting to v1.
--
-- WHY KEEP IT AT ALL: this function is SECURITY DEFINER and callable by
-- any manager who has an email address and their own property name.
-- Without any auth guard it is a hard-DELETE of any resident at that
-- property, which bypasses the CRM's soft deactivation entirely. The
-- guard is what keeps it a rollback tool instead of a delete tool.
--
-- WHY NARROW IT: a banned account is not a working login. It is the
-- signature of the rollback that is running right now.
--
-- 🔴 KNOWN RESIDUAL, ACCEPTED: v1's cross-tenant objection still
-- stands. If a DIFFERENT tenant holds the same email address with a
-- live, unbanned login, this guard blocks a delete that should have
-- proceeded and the function returns 0. That is now VISIBLE rather than
-- silent — both callers read the returned count and show the operator an
-- error when it is not exactly 1 (2026-09-25). A visible wrong answer is
-- recoverable; a silent one is what produced this migration.
--
-- FOLLOW-UP THAT RETIRES THE RESIDUAL — not this commit, filed as
-- docs/backlog/carry-the-ids-you-already-have-2026-09-25.md: delete by
-- the residents row ID returned from the INSERT, with a recency bound,
-- instead of by email + property. A known row needs no guard reasoning
-- about logins at all, and the same change lets the ban target the
-- user_id create_user already returned instead of re-resolving an email.
--
-- ════════════════════════════════════════════════════════════════════
-- NOT CHANGED
-- ════════════════════════════════════════════════════════════════════
--   • Signature, including p_property's DEFAULT NULL. CREATE OR REPLACE
--     DROPS parameter defaults unless they are restated, and every
--     caller relies on the two-arg form resolving.
--   • RETURNS INTEGER, LANGUAGE, SECURITY DEFINER, SET search_path.
--   • Role ladder, manager p_property requirement, CA company scope,
--     admin unscoped-by-design branch.
--   • Grants: REVOKE PUBLIC + anon, GRANT authenticated. Restated below
--     because they are not implied by a replace.
--
--   • The NAME. "pending" is misleading — a failed manager add writes no
--     status at all, so the row carries the column default and is NOT
--     status='pending'. A rename touches every caller for no behavioural
--     gain, so the wording is corrected here instead of the identifier.
--
-- 🔴 NO status FILTER. It was considered and dropped: the rows this
-- function must delete are not 'pending', so filtering on it would
-- reintroduce the guaranteed-0 bug through a different predicate.
--
-- ════════════════════════════════════════════════════════════════════
-- BEFORE APPLYING
-- ════════════════════════════════════════════════════════════════════
-- This body is v1 plus the narrowed guard plus the source bump. It was
-- reconstructed from the committed v1 and the described v2 delta — the
-- live body could not be read from here (pg_get_functiondef needs
-- catalog access PostgREST does not have).
--
-- 🔴 Diff this against `pg_get_functiondef` on the live function BEFORE
-- applying. If v2 carries any change beyond the auth-existence guard,
-- this replace would silently revert it — which is the same failure
-- mode, in the opposite direction, that produced this file.
--
-- That diff was run (Jose pulled the live _v2 body, 2026-09-25) and it
-- caught exactly that. The first draft of this file reconstructed the
-- company_admin and admin branches from v1, which does not carry:
--
--     AND (p_property IS NULL OR lower(property) = lower(trim(p_property)))
--
-- Live _v2 does, in BOTH branches. Applying the draft would have WIDENED
-- a destructive delete — the company_admin branch would have gone from
-- "this email, this company, this property" to "this email, this
-- company, ANY property" — while fixing an unrelated bug. Those clauses
-- and live's admin-branch comment are now reproduced verbatim.
--
-- ── THE ONE INTENTIONAL TEXTUAL DIFFERENCE FROM LIVE ───────────────
--
-- Live writes the guard's subquery predicate unqualified:
--
--     SELECT 1 FROM auth.users WHERE lower(email) = v_norm_email
--
-- This file qualifies it as lower(auth.users.email). Behaviour is
-- identical — the subquery's own FROM wins name resolution — but the
-- outer statement is DELETE FROM public.residents, which ALSO has an
-- email column. Unqualified, the predicate is correct by scoping rules
-- rather than by intent, and a future edit that changed the subquery's
-- FROM would silently repoint it at the outer table. Qualified, that
-- edit breaks loudly.
--
-- This is the only deliberate difference. Everything else matches live
-- except the guard's banned_until condition and the _v2 -> _v3 source.

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_orphaned_pending_resident(
  p_email    TEXT,
  p_property TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_caller_company TEXT;
  v_norm_email     TEXT;
  v_count          INTEGER;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;

  v_caller_role := public.get_my_role();
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'company_admin', 'manager') THEN
    RAISE EXCEPTION 'role_not_authorized'
      USING HINT = 'Only admin, company_admin, or manager can invoke rollback cleanup.';
  END IF;

  v_norm_email := lower(trim(coalesce(p_email, '')));
  IF v_norm_email = '' THEN
    RAISE EXCEPTION 'invalid_email'
      USING HINT = 'p_email must be a non-empty string.';
  END IF;

  -- v3 guard, identical in all three branches:
  --   block the delete only when an UNBANNED login exists for this
  --   address. A banned account is not a working login — it is the
  --   signature of the rollback currently in progress.
  IF v_caller_role = 'manager' THEN
    IF p_property IS NULL OR length(trim(p_property)) = 0 THEN
      RAISE EXCEPTION 'manager_scope_required'
        USING HINT = 'Manager callers must pass p_property to scope the delete.';
    END IF;
    DELETE FROM public.residents
     WHERE lower(email) = v_norm_email
       AND lower(property) = lower(trim(p_property))
       AND NOT EXISTS (
         SELECT 1 FROM auth.users
          WHERE lower(auth.users.email) = v_norm_email
            AND (auth.users.banned_until IS NULL OR auth.users.banned_until <= now())
       );
  ELSIF v_caller_role = 'company_admin' THEN
    v_caller_company := public.get_my_company();
    IF v_caller_company IS NULL OR length(trim(v_caller_company)) = 0 THEN
      RAISE EXCEPTION 'no_company_scope'
        USING HINT = 'Your session is missing a company scope. Refresh and try again.';
    END IF;
    DELETE FROM public.residents
     WHERE lower(email) = v_norm_email
       AND lower(company) = lower(v_caller_company)
       AND (p_property IS NULL OR lower(property) = lower(trim(p_property)))
       AND NOT EXISTS (
         SELECT 1 FROM auth.users
          WHERE lower(auth.users.email) = v_norm_email
            AND (auth.users.banned_until IS NULL OR auth.users.banned_until <= now())
       );
  ELSE
    -- admin: role-unscoped, but p_property still an optional narrower
    -- filter + auth-user existence guard still applies.
    DELETE FROM public.residents
     WHERE lower(email) = v_norm_email
       AND (p_property IS NULL OR lower(property) = lower(trim(p_property)))
       AND NOT EXISTS (
         SELECT 1 FROM auth.users
          WHERE lower(auth.users.email) = v_norm_email
            AND (auth.users.banned_until IS NULL OR auth.users.banned_until <= now())
       );
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    v_caller_email,
    'ROLLBACK_DELETE_RESIDENT',
    'residents',
    NULL,
    jsonb_build_object(
      'email',        v_norm_email,
      'property',     p_property,
      'role',         v_caller_role,
      'rows_deleted', v_count,
      'source',       'delete_orphaned_pending_resident_v3'
    ),
    now()
  );

  RETURN v_count;
END
$func$;

-- Not implied by CREATE OR REPLACE on an existing function, but restated
-- so this file alone describes the intended end state.
REVOKE EXECUTE ON FUNCTION public.delete_orphaned_pending_resident(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_orphaned_pending_resident(TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.delete_orphaned_pending_resident(TEXT, TEXT) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  NULL,
  'SCHEMA_DELETE_ORPHANED_PENDING_RESIDENT_V3',
  'public.delete_orphaned_pending_resident',
  NULL,
  jsonb_build_object(
    'migration', '20260925_delete_orphaned_pending_resident_v3',
    'rpc',       'delete_orphaned_pending_resident',
    'change',    'auth-existence guard narrowed to UNBANNED logins; audit source bumped v2 -> v3',
    'why',       'ban runs before the delete, so the v2 guard was always false and the function returned 0 on every call',
    'residual',  'cross-tenant same-email live login still blocks; now visible because both callers check the returned count'
  ),
  now()
);

COMMIT;

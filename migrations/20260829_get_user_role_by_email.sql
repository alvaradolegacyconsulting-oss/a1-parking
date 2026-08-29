-- ══════════════════════════════════════════════════════════════════════
-- 20260829_get_user_role_by_email.sql
--
-- 🟢 Item 2 Commit 1.5 — companion RPC for the swift-handler admin
-- protection guard in reset_password.
--
-- ── WHY A SECOND RPC ──────────────────────────────────────────────
--
-- The reset_password branch of swift-handler has an admin protection
-- guard: "Cannot reset admin passwords via this handler." My initial
-- Commit 2 handoff proposed replacing the current unescaped ILIKE
-- with `.eq('email', email.toLowerCase().trim())` — Mateo Aug 29
-- caught the defect:
--
-- **user_roles.email is not stored lowercased.** The uniqueness
-- guarantee is `UNIQUE (lower(email))` — an expression index —
-- which enforces uniqueness case-insensitively but leaves the
-- stored text exactly as entered. Mixed case is LIVE in this data:
-- e.g. `Juanachavez62.jc@gmail.com` recorded in the Aug 28 audit.
--
-- So `.eq()` against a lowercased needle misses any row stored with
-- capitals. `targetRole` returns null, `targetRole?.role === 'admin'`
-- is false, and the guard passes — same fail-open failure mode as
-- the ILIKE-with-underscore-wildcard bug we're trying to close.
-- Different mechanism, same outcome, would trigger on ordinary
-- mixed-case addresses rather than crafted `_` patterns.
--
-- PostgREST cannot express `lower(email) = lower($1)` in a filter
-- clause (functional predicates need a DEFINER RPC). So we use one.
-- Same shape as get_auth_user_id_by_email (Commit 1) — the pattern
-- is now established for "case-insensitive email lookup as
-- identity primitive."
--
-- ── 🔴 GRANTS ARE LOAD-BEARING (same as Commit 1) ─────────────────
--
-- Returns a role given an email. Anyone who can invoke this can
-- enumerate not just user existence (Commit 1's oracle risk) but
-- ALSO the target user's role — which is arguably a bigger leak.
-- Deny by default; service_role only. If anon/authenticated/PUBLIC
-- appears, HALT.
--
-- ── APPLY ─────────────────────────────────────────────────────────
-- Single database, wrapped BEGIN/COMMIT. Verification returns PASS
-- on 7 gates including execution + negative-case gate. Same shape
-- as Commit 1's verification.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.get_user_role_by_email(p_email TEXT)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  -- Fully-qualified public.user_roles under search_path = ''.
  -- lower(trim()) on both sides matches the case-insensitive
  -- UNIQUE (lower(email)) index. Returns NULL on no match rather
  -- than raising — caller distinguishes "no user_roles row" (null)
  -- from "lookup failed" (RPC error).
  SELECT role
    FROM public.user_roles
   WHERE lower(email) = lower(trim(p_email))
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_user_role_by_email(TEXT) IS
  'Item 2 Commit 1.5 (2026-08-29). Case-insensitive email → user_roles.role lookup for the swift-handler reset_password admin protection guard. Replaces .ilike(email, email) that failed .single() on `_`-wildcard matches AND .eq(email, lower) that failed open on mixed-case stored emails. SECURITY DEFINER + service_role-only. Returns NULL on no match (never raises). Caller pattern: on NULL → target has no role row, proceed with reset; on ''admin'' → refuse (guard); on RPC error → refuse (fail-closed, uncertain-state = deny). Do NOT grant to anon/authenticated/PUBLIC — this leaks user roles by email.';

-- ── Grants: service_role EXCLUSIVE ──────────────────────────────────
REVOKE ALL     ON FUNCTION public.get_user_role_by_email(TEXT) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.get_user_role_by_email(TEXT) FROM anon;
REVOKE ALL     ON FUNCTION public.get_user_role_by_email(TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_user_role_by_email(TEXT) TO   service_role;

-- PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';

-- Schema audit row
INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_GET_USER_ROLE_BY_EMAIL',
  'public.get_user_role_by_email(TEXT)',
  'get_user_role_by_email',
  jsonb_build_object(
    'migration',    '20260829_get_user_role_by_email',
    'item',         'Item 2 Commit 1.5 — companion to get_auth_user_id_by_email',
    'purpose',      'Case-insensitive email→role lookup for swift-handler reset_password admin protection guard. Closes fail-open modes from both the ILIKE-underscore-wildcard bug AND the .eq(lower) mixed-case-miss bug caught by Mateo Aug 29 review.',
    'grants',       'service_role EXECUTE; REVOKED from PUBLIC/anon/authenticated (identity + role oracle discipline)',
    'security',     'SECURITY DEFINER + SET search_path = '''' + returns NULL on no match (never raises)',
    'caller_shape', 'on NULL → no role row, proceed; on ''admin'' → refuse with 403; on RPC error → refuse fail-closed (uncertain-state = deny)'
  )
);

COMMIT;

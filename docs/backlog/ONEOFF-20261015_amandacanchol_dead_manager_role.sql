-- ════════════════════════════════════════════════════════════════════
-- ONE-OFF — replace the dead manager role on amandacanchol@gmail.com
--           with the resident role her live record needs
-- ════════════════════════════════════════════════════════════════════
-- Option A as a REPLACEMENT, per the ruling. STEP B (the ban) is not
-- used and has been removed from this file rather than left commented:
-- the login serves a live resident, so a ban breaks a current process,
-- and a dead branch that does exactly the harmful thing is an
-- invitation.
--
-- ── WHAT THIS ACCOUNT IS ────────────────────────────────────────────
-- One address, two identities:
--
--   user_roles 627   manager, A1, ["Sugarberry Place"]
--                    is_active = FALSE since 2026-08-10
--                    auth.users.banned_until = NULL   ← the exposure
--   residents  656   "Amanda Canchola", Southfork Lake Apartments
--                    is_active = TRUE, status = 'active'
--   vehicles   713   plate 1234BC, Southfork Lake, unit 101, active
--   auth.users       created 2026-07-15, last_sign_in 2026-08-21
--                    = 11 days AFTER the manager deactivation
--
-- Deleting 627 alone would leave her login with no role at all, which
-- is the blank-portal trap for a resident who demonstrably signs in.
-- So the delete and the insert are ONE transaction.
--
-- ── 🔴 NOTHING HERE IS COPIED FROM A PEER, AND NOTHING IS INVENTED ──
-- There are ZERO resident user_roles rows at Southfork Lake Apartments
-- to copy (measured: 348 resident rows, 208 Green Acres, 113 Esperanza,
-- none Southfork). So the shape comes from the A1 resident template and
-- every VALUE is derived from her own data:
--
--   company, property  ← her residents row 656, not typed in
--   consent versions   ← her OWN tos_acceptances rows (345 tos,
--                        346 privacy, both 2026-07-12-v2, accepted
--                        2026-07-26), resolved by subquery
--
-- 🔴 Consent is never copied from another user. tos_acceptances is the
-- authoritative source (row existence at the current version, not the
-- user_roles stamp), and 2026-07-12-v2 is the CURRENT version for both
-- documents, so she passes the hard gate and is not re-prompted. The
-- user_roles columns are a stamp; this sets them to what she actually
-- accepted.
--
-- Defaults taken from the A1 resident template (id 751, 686):
--   texas_confirmed=false, must_change_password=false,
--   can_regenerate_tow_ticket=false, can_approve_vehicles=false,
--   name=null, saas_accepted_version=null

BEGIN;

-- ── Pre-flight. Refuses unless the state is EXACTLY what was reviewed.
DO $do$
DECLARE
  v_email TEXT := 'amandacanchol@gmail.com';
  v_row   public.user_roles;
  v_live  INT;
  v_tos   INT;
BEGIN
  SELECT * INTO v_row FROM public.user_roles WHERE id = 627;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_roles 627 does not exist — the review is stale, re-read it';
  END IF;
  IF lower(btrim(v_row.email)) <> v_email THEN
    RAISE EXCEPTION 'user_roles 627 is %, not % — refusing to touch the wrong row', v_row.email, v_email;
  END IF;
  IF v_row.role <> 'manager' OR v_row.is_active IS NOT FALSE THEN
    RAISE EXCEPTION 'user_roles 627 is role=% is_active=% — expected an INACTIVE manager; refusing',
      v_row.role, v_row.is_active;
  END IF;

  -- Exactly one live residents row, or ARRAY[r.property] below would
  -- insert one role row per property and quietly widen her access.
  SELECT count(*) INTO v_live FROM public.residents r
   WHERE lower(btrim(r.email)) = v_email AND r.is_active AND r.status = 'active';
  IF v_live <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 live residents row for %, found % — stop and look', v_email, v_live;
  END IF;

  -- Her consent must be real, not assumed. If it is missing, the
  -- insert would stamp NULLs and she would be re-prompted at /consent —
  -- survivable, but it should be a decision, not a surprise.
  SELECT count(*) INTO v_tos FROM public.tos_acceptances ta
    JOIN auth.users u ON u.id = ta.user_id
   WHERE lower(btrim(u.email)) = v_email;
  IF v_tos = 0 THEN
    RAISE EXCEPTION 'no tos_acceptances rows for % — her consent is not on file; decide before inserting', v_email;
  END IF;

  RAISE NOTICE 'pre-flight OK: deleting manager 627, inserting resident for % (% consent row(s) on file)', v_email, v_tos;
END
$do$;

-- ── 1. the dead manager role goes ───────────────────────────────────
DELETE FROM public.user_roles
 WHERE id = 627
   AND lower(btrim(email)) = 'amandacanchol@gmail.com'
   AND role = 'manager'
   AND is_active IS FALSE
RETURNING 'DELETED' AS step, id, email, role, company, is_active,
          array_to_string(property, ' | ') AS property;

-- ── 2. the resident role her live record needs ──────────────────────
INSERT INTO public.user_roles (
  email, role, company, property, is_active,
  tos_accepted_at, tos_accepted_version, privacy_accepted_version,
  texas_confirmed, must_change_password,
  can_regenerate_tow_ticket, can_approve_vehicles
)
SELECT
  r.email,
  'resident',
  r.company,                      -- from her residents row
  ARRAY[r.property],              -- from her residents row
  TRUE,
  (SELECT max(ta.accepted_at) FROM public.tos_acceptances ta
     JOIN auth.users u ON u.id = ta.user_id
    WHERE lower(btrim(u.email)) = lower(btrim(r.email))),
  (SELECT max(ta.tos_version) FROM public.tos_acceptances ta
     JOIN auth.users u ON u.id = ta.user_id
    WHERE lower(btrim(u.email)) = lower(btrim(r.email))
      AND ta.tos_version IS NOT NULL),
  (SELECT max(ta.privacy_version) FROM public.tos_acceptances ta
     JOIN auth.users u ON u.id = ta.user_id
    WHERE lower(btrim(u.email)) = lower(btrim(r.email))
      AND ta.privacy_version IS NOT NULL),
  FALSE, FALSE, FALSE, FALSE
  FROM public.residents r
 WHERE lower(btrim(r.email)) = 'amandacanchol@gmail.com'
   AND r.is_active
   AND r.status = 'active'
RETURNING 'INSERTED' AS step, id, email, role, company,
          array_to_string(property, ' | ') AS property, is_active,
          tos_accepted_version, privacy_accepted_version, tos_accepted_at;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION — re-runnable, read-only
-- ════════════════════════════════════════════════════════════════════
-- 🔴 This does NOT mint a session as a real customer. The shape is
-- proven by execution against a canary in
-- scripts/verify-resident-role-shape.ts (npm run verify:residentrole).
-- What this block does is run the HELPERS' OWN PREDICATE against her
-- actual row, which is the thing her session will evaluate.
DO $do$
DECLARE
  v_email TEXT := 'amandacanchol@gmail.com';
  v_fail  TEXT[] := '{}';
  v_role  TEXT;
  v_co    TEXT;
  v_props TEXT[];
  v_n     INT;
BEGIN
  -- get_my_role()'s body, verbatim, with her email in place of the JWT.
  SELECT role, company, property INTO v_role, v_co, v_props
    FROM public.user_roles
   WHERE lower(email) = lower(v_email)
   LIMIT 1;

  IF v_role IS DISTINCT FROM 'resident' THEN
    v_fail := array_append(v_fail, format('her session would resolve to role %L, want resident', v_role));
  END IF;
  IF v_co IS DISTINCT FROM 'A1 Wrecker llc' THEN
    v_fail := array_append(v_fail, format('company resolves to %L', v_co));
  END IF;
  IF NOT ('Southfork Lake Apartments' = ANY(COALESCE(v_props, '{}'))) THEN
    v_fail := array_append(v_fail, format('property resolves to %L, want Southfork Lake Apartments', v_props));
  END IF;
  IF 'Sugarberry Place' = ANY(COALESCE(v_props, '{}')) THEN
    v_fail := array_append(v_fail, '🔴 Sugarberry Place is still in her property list — the manager scope survived');
  END IF;

  SELECT count(*) INTO v_n FROM public.user_roles
   WHERE lower(btrim(email)) = lower(v_email);
  IF v_n <> 1 THEN
    v_fail := array_append(v_fail, format('%s user_roles rows for her, want exactly 1', v_n));
  END IF;

  SELECT count(*) INTO v_n FROM public.user_roles
   WHERE lower(btrim(email)) = lower(v_email) AND role <> 'resident';
  IF v_n <> 0 THEN
    v_fail := array_append(v_fail, format('🔴 %s non-resident role row(s) remain', v_n));
  END IF;

  -- Her own data must still be there — the point was to keep it.
  SELECT count(*) INTO v_n FROM public.residents
   WHERE lower(btrim(email)) = lower(v_email) AND is_active AND status = 'active';
  IF v_n <> 1 THEN
    v_fail := array_append(v_fail, format('her live residents row count is %s, want 1', v_n));
  END IF;
  SELECT count(*) INTO v_n FROM public.vehicles
   WHERE lower(btrim(resident_email)) = lower(v_email) AND is_active;
  IF v_n < 1 THEN
    v_fail := array_append(v_fail, 'her active vehicle is gone');
  END IF;

  -- And the login must be untouched: a ban here would be the outcome
  -- this file exists to avoid.
  IF EXISTS (SELECT 1 FROM auth.users WHERE lower(btrim(email)) = lower(v_email) AND banned_until IS NOT NULL) THEN
    v_fail := array_append(v_fail, '🔴 her auth user is BANNED — that locks out a live resident');
  END IF;

  IF array_length(v_fail,1) > 0 THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
END
$do$;

SELECT 'PASS — amandacanchol@gmail.com'                                  AS result,
       (SELECT role FROM public.user_roles
         WHERE lower(email)='amandacanchol@gmail.com' LIMIT 1)           AS resolves_to,
       (SELECT array_to_string(property,' | ') FROM public.user_roles
         WHERE lower(email)='amandacanchol@gmail.com' LIMIT 1)           AS property_scope,
       (SELECT count(*) FROM public.user_roles
         WHERE lower(btrim(email))='amandacanchol@gmail.com')            AS role_rows_want_1,
       (SELECT count(*) FROM public.vehicles
         WHERE lower(btrim(resident_email))='amandacanchol@gmail.com' AND is_active) AS her_active_vehicles,
       (SELECT COALESCE(banned_until::TEXT,'not banned — correct')
          FROM auth.users WHERE lower(btrim(email))='amandacanchol@gmail.com') AS login_state,
       '🔴 npm run verify:residentrole proves the SHAPE by execution on a canary' AS next;

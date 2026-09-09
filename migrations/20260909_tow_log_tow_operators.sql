-- ══════════════════════════════════════════════════════════════════════
-- 20260909_tow_log_tow_operators.sql
--
-- 🟢 Tow Log arc — COMMIT 2 of N. `tow_operators` table + RLS + grants
--    + 3 DEFINER RPCs.
--
-- Commit 1 (d1a2d48) established the storage bucket + scoped RLS on
-- storage.objects for vehicle-removal photos. This commit adds the
-- business-record surface: a PM's address book of third-party towing
-- companies they call.
--
-- ── DOMAIN — WHO USES THIS TABLE ────────────────────────────────────
-- `tow_operators` is the PROPERTY MANAGER's address book of third-party
-- towing companies. It is NOT a record about the enforcement subscriber.
--
--   • An Enforcement-Only subscriber IS a towing company. They do the
--     towing — they don't call other tow companies. Their equivalent
--     data lives as `drivers.operator_license` (per-driver TDLR) + tow
--     tickets (per-tow record). They do not need `tow_operators`.
--
--   • A PM subscriber cannot issue violations or tow tickets. What they
--     CAN do is authorize a vehicle removal and phone a towing company.
--     Today that record lives in a text message. `tow_operators` is who
--     they called.
--
-- The Saturday-night scenario: a PM's on-duty lead at 11pm dials ABC
-- Towing inline because the usual company didn't answer. `find-or-
-- create` on lower(trim(name)) means typing "ABC Towing" a second time
-- returns the same id instead of raising a unique-violation on the
-- exact night that matters most.
--
-- ── 🔴 TWO-LICENSE DISTINCTION (write this down or someone conflates
--    them later) ──────────────────────────────────────────────────────
-- `drivers.operator_license`           → the INDIVIDUAL person's TDLR
--                                        license. About the human doing
--                                        the tow. On the driver row.
-- `tow_operators.tdlr_license_number`  → the TOWING COMPANY's TDLR
--                                        license (as a business). About
--                                        the outfit the PM calls. On the
--                                        operator row.
-- Two different licenses about two different subjects. Similar names,
-- one table apart. See COMMENT ON COLUMN below and the mirror comment
-- on drivers.operator_license (future companion commit, if that column
-- doesn't already carry a comment).
--
-- ── TIER GATE — WHY `my_tier_pm_capable()` (not enforcement) ────────
-- Per-tier eligibility for creating/updating/deactivating tow_operators:
--
--   Tier              pm_capable?    Included?    Rationale
--   ─────────────────────────────────────────────────────────────────
--   PM Starter        yes            YES          The differentiator
--                                                 feature for PM tiers.
--   Enforcement-Only  no             no           They ARE the tow
--                                                 company; use their own
--                                                 drivers table + tow
--                                                 tickets.
--   Legacy            yes            YES          Both helpers pass;
--                                                 A1 gets it regardless.
--   Custom quote      case-by-case   proposal-code-driven
--
-- Super-admin (role='admin') always bypasses the tier gate — the helper
-- would RAISE no_company_context on a NULL user_roles.company.
--
-- ── SCHEMA ──────────────────────────────────────────────────────────
-- Follows 20260830_space_payments_v1_table.sql:
--   • BIGSERIAL primary key
--   • _by_email attribution (server-side via auth.jwt() in RPCs)
--   • GRANT SELECT only to authenticated; all writes through DEFINER
--
-- Diverges from space_payments in three deliberate ways:
--
--   1. NOT append-only. Operators are business records that get renamed
--      (phone changes, name changes on rebrand). update_tow_operator is
--      a first-class RPC, unlike space_payments where the only correction
--      path is void.
--
--   2. Deactivation model instead of void. `is_active BOOLEAN DEFAULT
--      true`. deactivate_tow_operator sets is_active=false — the row
--      stays, `vehicle_removals` snapshots (operator_name + phone) survive
--      regardless, id stays resolvable, name becomes reusable.
--
--   3. Unique index is PARTIAL (`WHERE is_active`) — properties'
--      equivalent (20260902_properties_unique_company_name_ci) is FULL.
--      Rationale differs: a property is a physical location whose name
--      identifies it alive-or-dormant, so reuse-after-deactivate should
--      collide at reactivate time. An operator is a phone-book entry
--      whose deactivated name should be freely reusable — if a PM
--      deactivates "ABC Towing" and later a different outfit named
--      "ABC Towing" enters the picture, that's a legitimate new row.
--
-- ── UNIQUE-INDEX SCOPE ──────────────────────────────────────────────
-- (lower(trim(company)), lower(trim(name))) WHERE is_active. Company-
-- scoped, not property-scoped — a PM firm's operators serve every
-- property they manage. The same operator name at a DIFFERENT company
-- is allowed.
--
-- ── RLS ─────────────────────────────────────────────────────────────
-- Equality via lower(trim), NEVER ~~*. Divergence from the shipped
-- sibling ~~* pattern is deliberate; same rationale as
-- space_payments header §RLS PREDICATE (metachar vector). Do not
-- normalize back to ~~* in future sweeps.
--
-- Three SELECT policies:
--   admin_all_tow_operators      — admin sees all
--   ca_own_tow_operators         — CA sees own-company rows
--   manager_own_tow_operators    — manager sees own-company rows
-- Driver/resident: no policy → 0 rows on SELECT. RLS filters, doesn't
-- throw (feedback_rls_denials_return_empty_not_error).
--
-- ── RPCs — 3 DEFINER FUNCTIONS ──────────────────────────────────────
-- create_tow_operator(p_name, p_phone, p_tdlr, p_notes)
--   → find-or-create on lower(trim(name)) within caller's company.
--     Returns { ok, id, created:true|false }. Unique-violation race
--     backstop caught + re-looked-up.
--
-- update_tow_operator(p_id, p_name, p_phone, p_tdlr, p_notes)
--   → scope-checks own-company; name changes re-check unique.
--
-- deactivate_tow_operator(p_id)
--   → sets is_active=false. Never DELETE (attribution + snapshots).
--
-- Rejection shape (Commit 2 uniform per 20260904):
--   • Role rejection      → RETURN jsonb_build_object('error','role_not_authorized')
--   • Tier rejection      → RAISE ERRCODE='insufficient_privilege', msg='tier_not_permitted'
--   • Scope rejection     → RETURN jsonb_build_object('error','out_of_scope')
--   • Validation failures → RETURN jsonb_build_object('error','<name>')
--   • Success             → RETURN jsonb_build_object('ok',true, …)
--
-- Grant discipline per feedback_revoke_from_anon_explicitly:
--   REVOKE FROM PUBLIC + FROM anon; GRANT EXECUTE TO authenticated.
--
-- ── AUDIT ───────────────────────────────────────────────────────────
-- Each RPC writes an audit_logs row using the canonical shape from
-- void_violation (20260611):
--   (user_email, action, table_name, record_id, new_values, created_at)
-- with lowercased email, SCREAMING_SNAKE action, ::text on record_id.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- Report-first → eyeball → apply (Jose) → verify → push.
-- Wraps in BEGIN/COMMIT. Execution gates E1-E8 are a SEPARATE follow-up
-- file — Jose triggers each denial by hand, reports the actual message,
-- and the assertions get written from the empirical text.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — TABLE ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tow_operators (
  id                  BIGSERIAL     PRIMARY KEY,
  company             TEXT          NOT NULL,
  name                TEXT          NOT NULL,
  phone               TEXT          NULL,
  tdlr_license_number TEXT          NULL,   -- TOWING COMPANY's TDLR (not the driver's)
  notes               TEXT          NULL,
  is_active           BOOLEAN       NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by_email    TEXT          NOT NULL,   -- server-side from auth.jwt() in RPCs

  -- Metachar CHECK on name — verbatim from
  -- 20260901_companies_and_properties_name_metachar_check.
  -- Refuses `%`, `_`, `\` in operator names so an "ABC%Towing" input
  -- can't wildcard-match the RLS predicate later if someone ever
  -- reintroduces ~~* on this table.
  CONSTRAINT tow_operators_name_no_sql_metachar
    CHECK (name !~ '[%_\\]')
);

COMMENT ON TABLE public.tow_operators IS
  '2026-09-09 Tow Log Commit 2. PM address book of third-party towing companies. NOT a record about the enforcement subscriber (Enforcement-Only tier is the tow company — see drivers.operator_license + tow tickets). Company-scoped, not property-scoped: a PM firm''s operators serve every property they manage. Writes through DEFINER RPCs only (create/update/deactivate_tow_operator). Deactivation model, not void — is_active=false keeps id resolvable, frees name for reuse via partial unique index. RLS equality, not ~~*.';

COMMENT ON COLUMN public.tow_operators.tdlr_license_number IS
  'TDLR license number of the TOWING COMPANY (business entity). Distinct from drivers.operator_license, which is the INDIVIDUAL driver''s TDLR license. Two licenses about two subjects; do not conflate. Optional — platform states facts, does not claim compliance on this value.';

COMMENT ON COLUMN public.tow_operators.company IS
  'Owning subscriber company. Server-derived from get_my_company() in each RPC; never accepted from client. Case+whitespace-normalized for RLS + unique-index comparison.';

COMMENT ON COLUMN public.tow_operators.is_active IS
  'Deactivation flag. Never DELETE — vehicle_removals snapshots survive, id stays resolvable, deactivated names become reusable via the partial unique index (WHERE is_active).';


-- ── PART 2 — UNIQUE INDEX (partial) ─────────────────────────────────
-- Partial (WHERE is_active) is deliberate — see header §SCHEMA #3.
CREATE UNIQUE INDEX IF NOT EXISTS tow_operators_company_name_uniq
  ON public.tow_operators (lower(trim(company)), lower(trim(name)))
  WHERE is_active;


-- ── PART 3 — GRANTS (append-and-mutate via RPCs only) ──────────────
-- SELECT only for authenticated. All INSERT/UPDATE flow through the
-- 3 DEFINER RPCs below.
REVOKE ALL ON public.tow_operators FROM PUBLIC;
REVOKE ALL ON public.tow_operators FROM anon;
REVOKE ALL ON public.tow_operators FROM authenticated;
GRANT  SELECT ON public.tow_operators TO authenticated;


-- ── PART 4 — RLS ────────────────────────────────────────────────────
ALTER TABLE public.tow_operators ENABLE ROW LEVEL SECURITY;
-- No FORCE ROW LEVEL SECURITY: service_role bypass required for the
-- DEFINER RPC bodies below.

-- admin — all rows visible
DROP POLICY IF EXISTS "admin_all_tow_operators" ON public.tow_operators;
CREATE POLICY "admin_all_tow_operators" ON public.tow_operators
  FOR SELECT TO authenticated
  USING ((SELECT get_my_role()) = 'admin'::text);

-- company_admin — SELECT within own company. Equality via lower(trim),
-- NEVER ~~*. See header §RLS.
DROP POLICY IF EXISTS "ca_own_tow_operators" ON public.tow_operators;
CREATE POLICY "ca_own_tow_operators" ON public.tow_operators
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND lower(trim(company)) = lower(trim((SELECT get_my_company())))
  );

-- manager — SELECT within own company. Same shape as CA.
-- (Property-scoped filtering isn't needed — operators serve every
-- property in the company. Any manager under the company can see the
-- company's address book.)
DROP POLICY IF EXISTS "manager_own_tow_operators" ON public.tow_operators;
CREATE POLICY "manager_own_tow_operators" ON public.tow_operators
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'manager'::text
    AND lower(trim(company)) = lower(trim((SELECT get_my_company())))
  );

-- driver + resident: no policy = SELECT returns 0 rows. RLS filters.


-- ══════════════════════════════════════════════════════════════════════
-- PART 5 — RPCs
-- ══════════════════════════════════════════════════════════════════════

-- ── create_tow_operator — find-or-create on (company, lower(trim(name))) ─
CREATE OR REPLACE FUNCTION public.create_tow_operator(
  p_name  TEXT,
  p_phone TEXT DEFAULT NULL,
  p_tdlr  TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_company      TEXT;
  v_existing_id  BIGINT;
  v_new_id       BIGINT;
BEGIN
  -- ── Auth ────────────────────────────────────────────────────────
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  -- ── Role gate ──────────────────────────────────────────────────
  IF v_caller_role NOT IN ('manager', 'company_admin', 'admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- ── Tier gate — super-admin bypass FIRST (helper raises on NULL company) ─
  IF v_caller_role <> 'admin' AND NOT public.my_tier_pm_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'Tow-operator management is a property-management feature. Your subscription tier does not include it.',
            ERRCODE = 'insufficient_privilege';
  END IF;

  -- ── Input validation ───────────────────────────────────────────
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RETURN jsonb_build_object('error', 'name_required');
  END IF;
  -- Metachar CHECK on the table catches `%`, `_`, `\` at INSERT time,
  -- but validate here too so the caller sees a clean 'invalid_name'
  -- rather than a raw 23514 for the same reason.
  IF p_name ~ '[%_\\]' THEN
    RETURN jsonb_build_object('error', 'invalid_name');
  END IF;

  -- ── Company scope ──────────────────────────────────────────────
  -- Admin has NULL company by design; admin creating on behalf of a
  -- specific company is out of scope for v1 (admin can update/deactivate
  -- any row via role='admin', but creation requires a caller company).
  v_company := get_my_company();
  IF v_company IS NULL OR length(trim(v_company)) = 0 THEN
    RETURN jsonb_build_object('error', 'no_company_context');
  END IF;

  -- ── Find-or-create — MATCH lower(trim(name)) within company on
  --    ACTIVE rows. Deactivated rows don't collide (partial unique
  --    index skips them), so a fresh insert against a deactivated
  --    name succeeds. ─────────────────────────────────────────────
  SELECT id INTO v_existing_id
    FROM public.tow_operators
   WHERE lower(trim(company)) = lower(trim(v_company))
     AND lower(trim(name))    = lower(trim(p_name))
     AND is_active            = true
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    -- Existing active operator with this name — return the found id.
    -- Do NOT overwrite phone/tdlr/notes; update flows via
    -- update_tow_operator. Audit as FIND.
    INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
    VALUES (
      lower(v_caller_email),
      'TOW_OPERATOR_FIND',
      'tow_operators',
      v_existing_id::text,
      jsonb_build_object(
        'company', v_company,
        'name',    trim(p_name),
        'found',   true,
        'note',    'find-or-create matched existing active operator; no fields overwritten'
      ),
      now()
    );

    RETURN jsonb_build_object('ok', true, 'id', v_existing_id, 'created', false);
  END IF;

  -- ── Fresh INSERT ───────────────────────────────────────────────
  -- Wrapped in a sub-block to catch unique_violation from a
  -- concurrent creator racing between the SELECT above and this
  -- INSERT. The partial unique index is the backstop.
  BEGIN
    INSERT INTO public.tow_operators (
      company, name, phone, tdlr_license_number, notes,
      is_active, created_by_email
    )
    VALUES (
      trim(v_company), trim(p_name),
      NULLIF(trim(p_phone), ''),
      NULLIF(trim(p_tdlr),  ''),
      NULLIF(trim(p_notes), ''),
      true, lower(v_caller_email)
    )
    RETURNING id INTO v_new_id;

  EXCEPTION
    WHEN unique_violation THEN
      -- Race: another session inserted the same (company, name) between
      -- our SELECT and INSERT. Re-look-up the winner's row and return
      -- it as `created:false`, matching the find-or-create contract.
      SELECT id INTO v_existing_id
        FROM public.tow_operators
       WHERE lower(trim(company)) = lower(trim(v_company))
         AND lower(trim(name))    = lower(trim(p_name))
         AND is_active            = true
       LIMIT 1;

      IF v_existing_id IS NULL THEN
        -- Extraordinarily unlikely (row deactivated between the race
        -- INSERT and our re-lookup). Surface as a distinguishable error.
        RETURN jsonb_build_object('error', 'unique_race_unresolved');
      END IF;

      INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
      VALUES (
        lower(v_caller_email),
        'TOW_OPERATOR_FIND',
        'tow_operators',
        v_existing_id::text,
        jsonb_build_object(
          'company', v_company,
          'name',    trim(p_name),
          'found',   true,
          'note',    'find-or-create resolved from unique_violation race; no fields overwritten'
        ),
        now()
      );
      RETURN jsonb_build_object('ok', true, 'id', v_existing_id, 'created', false);
  END;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'TOW_OPERATOR_CREATED',
    'tow_operators',
    v_new_id::text,
    jsonb_build_object(
      'company',              v_company,
      'name',                 trim(p_name),
      'phone',                NULLIF(trim(p_phone), ''),
      'tdlr_license_number',  NULLIF(trim(p_tdlr),  ''),
      'notes',                NULLIF(trim(p_notes), ''),
      'created_by_role',      v_caller_role
    ),
    now()
  );

  RETURN jsonb_build_object('ok', true, 'id', v_new_id, 'created', true);
END
$func$;

REVOKE EXECUTE ON FUNCTION public.create_tow_operator(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_tow_operator(TEXT, TEXT, TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.create_tow_operator(TEXT, TEXT, TEXT, TEXT) TO authenticated;


-- ── update_tow_operator ────────────────────────────────────────────
-- All fields optional; NULL argument = don't change. name change re-
-- checks unique via the partial index.
CREATE OR REPLACE FUNCTION public.update_tow_operator(
  p_id    BIGINT,
  p_name  TEXT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_tdlr  TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_company      TEXT;
  v_row          tow_operators%ROWTYPE;
  v_updated_row  jsonb;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  IF v_caller_role NOT IN ('manager', 'company_admin', 'admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  IF v_caller_role <> 'admin' AND NOT public.my_tier_pm_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'Tow-operator management is a property-management feature. Your subscription tier does not include it.',
            ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_name IS NOT NULL AND p_name ~ '[%_\\]' THEN
    RETURN jsonb_build_object('error', 'invalid_name');
  END IF;
  IF p_name IS NOT NULL AND length(trim(p_name)) = 0 THEN
    RETURN jsonb_build_object('error', 'name_required');
  END IF;

  SELECT * INTO v_row FROM public.tow_operators WHERE id = p_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- Scope: admin bypass; everyone else must match the caller's company.
  IF v_caller_role <> 'admin' THEN
    v_company := get_my_company();
    IF v_company IS NULL OR lower(trim(v_row.company)) <> lower(trim(v_company)) THEN
      RETURN jsonb_build_object('error', 'out_of_scope');
    END IF;
  END IF;

  -- Apply only the columns explicitly passed (NULL = no-op).
  UPDATE public.tow_operators
     SET name                = COALESCE(NULLIF(trim(p_name), ''), name),
         phone               = CASE WHEN p_phone IS NULL THEN phone ELSE NULLIF(trim(p_phone), '') END,
         tdlr_license_number = CASE WHEN p_tdlr  IS NULL THEN tdlr_license_number ELSE NULLIF(trim(p_tdlr),  '') END,
         notes               = CASE WHEN p_notes IS NULL THEN notes ELSE NULLIF(trim(p_notes), '') END
   WHERE id = p_id
  RETURNING to_jsonb(tow_operators.*) INTO v_updated_row;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'TOW_OPERATOR_UPDATED',
    'tow_operators',
    p_id::text,
    jsonb_build_object(
      'updated_by_role', v_caller_role,
      'before', jsonb_build_object(
        'name',                v_row.name,
        'phone',               v_row.phone,
        'tdlr_license_number', v_row.tdlr_license_number,
        'notes',               v_row.notes
      ),
      'after', v_updated_row
    ),
    now()
  );

  RETURN jsonb_build_object('ok', true, 'operator', v_updated_row);
END
$func$;

REVOKE EXECUTE ON FUNCTION public.update_tow_operator(BIGINT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_tow_operator(BIGINT, TEXT, TEXT, TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.update_tow_operator(BIGINT, TEXT, TEXT, TEXT, TEXT) TO authenticated;


-- ── deactivate_tow_operator ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.deactivate_tow_operator(
  p_id BIGINT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_company      TEXT;
  v_row          tow_operators%ROWTYPE;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  IF v_caller_role NOT IN ('manager', 'company_admin', 'admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  IF v_caller_role <> 'admin' AND NOT public.my_tier_pm_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'Tow-operator management is a property-management feature. Your subscription tier does not include it.',
            ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_row FROM public.tow_operators WHERE id = p_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_row.is_active = false THEN
    RETURN jsonb_build_object('error', 'already_inactive');
  END IF;

  IF v_caller_role <> 'admin' THEN
    v_company := get_my_company();
    IF v_company IS NULL OR lower(trim(v_row.company)) <> lower(trim(v_company)) THEN
      RETURN jsonb_build_object('error', 'out_of_scope');
    END IF;
  END IF;

  UPDATE public.tow_operators
     SET is_active = false
   WHERE id = p_id;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'TOW_OPERATOR_DEACTIVATED',
    'tow_operators',
    p_id::text,
    jsonb_build_object(
      'deactivated_by_role', v_caller_role,
      'company',             v_row.company,
      'name',                v_row.name,
      'note',                'row retained (never DELETE) — attribution + future vehicle_removals snapshots survive; name reusable via partial unique index'
    ),
    now()
  );

  RETURN jsonb_build_object('ok', true, 'id', p_id);
END
$func$;

REVOKE EXECUTE ON FUNCTION public.deactivate_tow_operator(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deactivate_tow_operator(BIGINT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.deactivate_tow_operator(BIGINT) TO authenticated;


-- ── PART 6 — Schema audit row ──────────────────────────────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_TOW_LOG_TOW_OPERATORS',
  'public.tow_operators',
  'commit_2_of_N',
  jsonb_build_object(
    'migration',       '20260909_tow_log_tow_operators',
    'arc',             'Tow Log Commit 2 — tow_operators table + RLS + grants + 3 DEFINER RPCs',
    'domain',          'PM address book of third-party towing companies. NOT a record about the enforcement subscriber (Enforcement-Only IS the tow company; their equivalent lives on drivers.operator_license + tow tickets).',
    'tier_gate',       'my_tier_pm_capable() — Enforcement-Only excluded correctly (they don''t call other tow companies), PM Starter + Legacy included. Super-admin bypass FIRST (helper raises on NULL user_roles.company).',
    'two_licenses',    'drivers.operator_license = individual driver''s TDLR. tow_operators.tdlr_license_number = towing company''s TDLR. Similar names, different subjects, one table apart. See COMMENT ON COLUMN.',
    'schema_changes',  jsonb_build_array(
      'CREATED TABLE public.tow_operators (9 cols, 1 metachar CHECK)',
      'CREATED PARTIAL UNIQUE INDEX tow_operators_company_name_uniq (lower(trim(company)), lower(trim(name))) WHERE is_active — partial (not full like properties) so deactivated names are reusable',
      'ENABLED RLS + 3 SELECT policies (admin_all / ca_own / manager_own — equality via lower(trim), never ~~*)',
      'REVOKED all writes from PUBLIC/anon/authenticated; GRANTED SELECT ONLY to authenticated (writes via DEFINER RPCs)',
      'CREATED 3 DEFINER RPCs: create_tow_operator (find-or-create), update_tow_operator, deactivate_tow_operator',
      'GRANT EXECUTE to authenticated only; REVOKE from PUBLIC + anon on all 3'
    ),
    'rpc_gates',       jsonb_build_object(
      'role',      'manager, company_admin, admin (RETURN role_not_authorized)',
      'tier',      'my_tier_pm_capable() with admin bypass FIRST (RAISE insufficient_privilege / tier_not_permitted)',
      'scope',     'lower(trim(company)) equality against get_my_company() (RETURN out_of_scope)',
      'validation','name required + metachar-clean (RETURN name_required / invalid_name)'
    ),
    'find_or_create',  'create_tow_operator matches lower(trim(name)) within company on ACTIVE rows; returns existing id + created:false. Unique-violation race caught + re-looked-up. Deactivated rows do not collide (partial unique index skips them).',
    'deactivation',    'is_active=false. Never DELETE — vehicle_removals will snapshot operator_name + phone (future commit); deactivated names become reusable via the partial unique index.',
    'rls_deliberate_divergence', 'lower(trim()) equality, not ~~* ILIKE. Same rationale as space_payments — new tables ship with the safer form. Do NOT normalize back to ~~*.',
    'audit_shape',     'Canonical from void_violation (20260611): lowercased email, SCREAMING_SNAKE action, unqualified table name, ::text on record_id, jsonb_build_object payload.',
    'unwriteable_from_client', 'INSERT/UPDATE/DELETE via client bypass DENIED at grant layer. Only DEFINER RPCs write. Attribution unforgeable via auth.jwt() ->> ''email''.',
    'next_commits',    'Commit 3: vehicle_removals ledger (snapshots operator_name + phone at INSERT time; the tow_operator id is a reference, snapshots are the record). Commit 4: UI (manager portal Tow Log tab) + optional bucket-scoped signed-URL RPC.',
    'execution_gates', 'E1-E8 in a separate follow-up file — Jose triggers each denial by hand, reports the actual message, assertions written from empirical text.'
  ),
  now()
);


-- ── PART 7 — PostgREST schema cache reload ─────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;

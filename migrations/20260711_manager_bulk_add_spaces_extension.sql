-- ════════════════════════════════════════════════════════════════════
-- generate_spaces_from_pool — extend in place for manager bulk add
-- 2026-07-11 · POST-LAUNCH extension (NOT for weekend chain)
--
-- WHY (three things at once, one CREATE OR REPLACE)
--   1. Manager bulk-add — currently the manager UI calls this RPC with
--      p_count=1 always (single-space add). Extend the same RPC to
--      accept p_count > 1 from manager callers, gated on
--      user_roles.can_approve_vehicles (elevated authority — reuses
--      the existing approve-vehicles flag rather than adding a new
--      column + CA setter UI). CA path untouched.
--   2. Manager property-scope tighten — the current property guard
--      only checks in-company match. A manager could hand-craft an
--      RPC call to add spaces at OTHER properties in the same
--      company. Tighten with p_property = ANY(user_roles.property[])
--      for manager callers. CA + admin unchanged.
--   3. Sequencing COUNT+1 → MAX+1 (all callers) — the current
--      approach counts existing labels for the prefix, then generates
--      count+1..count+p_count. On a GAPPED property (label
--      decommissioned in the middle: G-1, G-3 exist, G-2 gone),
--      COUNT=2 and a p_count=1 call would try G-3 → collide → skip →
--      v_inserted=0. Silent partial-success class bug. MAX+1 fixes
--      it for CA and manager both.
--
--   Advisory lock added to serialize concurrent CA + manager
--   generation vs. the same (property, type) — two callers both
--   computing MAX+1 = same value would hit spaces_label_unique_per_
--   property UNIQUE and one would raise. Lock prevents the raise.
--
--   Rows-affected assert — the old skip-on-collision silently under-
--   inserted; with MAX+1 + advisory lock + UNIQUE constraint this
--   must be exact. If v_inserted <> p_count, raise (we WANT to know
--   about a collision now, not hide it).
--
-- SIGNATURE — unchanged
--   generate_spaces_from_pool(
--     p_property     TEXT,
--     p_type         TEXT,
--     p_count        INTEGER,
--     p_label_prefix TEXT DEFAULT NULL
--   ) RETURNS INTEGER
--
--   Body-only CREATE OR REPLACE. No overload; no PostgREST ambiguity;
--   no client-code sig change required. UI change (quantity field on
--   manager "+ New space") comes in a separate commit right after.
--
-- CAPS
--   Manager: p_count 1..100 (Jose lock — solves "one at a time"
--     pain without runaway risk). CA/admin: existing 1..1000.
--
-- WHAT'S UNCHANGED FOR CA/ADMIN CALLERS
--   • Role gate still allows 'company_admin' + 'manager'.
--   • In-company property check still applies to CA (unchanged).
--   • Cap stays 1000 for CA.
--   • Prefix map, type validation, audit_logs write pattern.
--
-- WHY POST-LAUNCH
--   generate_spaces_from_pool is the LIVE RPC A1's CA property setup
--   hits this weekend. Extension waits until A1 is live. Both live
--   issues are dormant during the weekend chain: sequencing bug only
--   fires on GAPPED properties (A1 starts fresh post-wipe → no gaps);
--   scope leak isn't reachable via the UI (manager UI always sends
--   the manager's own property). No urgency — bundle post-launch.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.generate_spaces_from_pool(
  p_property      TEXT,
  p_type          TEXT,
  p_count         INTEGER,
  p_label_prefix  TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email                 TEXT;
  v_role                  TEXT;
  v_company               TEXT;
  v_can_approve_vehicles  BOOLEAN;
  v_caller_properties     TEXT[];
  v_property_ok           BOOLEAN;
  v_resolved_prefix       TEXT;
  v_start                 INTEGER;
  v_inserted              INTEGER := 0;
  v_i                     INTEGER;
  v_label                 TEXT;
  v_first_label           TEXT;
  v_last_label            TEXT;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- Read role + company + can_approve_vehicles + assigned properties
  -- in one round-trip. Manager caller uses all four; CA uses only
  -- role + company.
  SELECT role, company, can_approve_vehicles, property
    INTO v_role, v_company, v_can_approve_vehicles, v_caller_properties
    FROM public.user_roles
   WHERE lower(email) = lower(v_email)
   LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed';
  END IF;

  -- In-company property check — applies to CA + manager both (CA had
  -- this; manager gets the additional assigned-property tighten below).
  SELECT EXISTS (
    SELECT 1 FROM public.properties
     WHERE name = p_property AND company ~~* v_company
  ) INTO v_property_ok;
  IF NOT v_property_ok THEN
    RAISE EXCEPTION 'property_not_in_company';
  END IF;

  -- ── Manager-only gates (CA path untouched by these three) ────────
  IF v_role = 'manager' THEN
    -- Cap 100 for manager callers.
    IF p_count > 100 THEN
      RAISE EXCEPTION 'manager bulk add capped at 100 (got %)', p_count;
    END IF;
    -- Bulk (>1) requires can_approve_vehicles. Single (=1) preserved
    -- for any manager — no behavior change on the existing single-add
    -- path even if this flag isn't set.
    IF p_count > 1 AND v_can_approve_vehicles IS NOT TRUE THEN
      RAISE EXCEPTION 'bulk add requires can_approve_vehicles'
        USING ERRCODE = '42501';
    END IF;
    -- Property scope: manager may only add at an assigned property.
    -- Closes the pre-fix scope leak where a manager could hit any
    -- property in their company via crafted RPC call. UI already
    -- always sends manager.name, so no UI change required to accept
    -- this tighten.
    IF p_property <> ALL(COALESCE(v_caller_properties, ARRAY[]::TEXT[])) THEN
      RAISE EXCEPTION 'property_not_in_manager_scope'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ── Count sanity (both roles) ────────────────────────────────────
  IF p_count IS NULL OR p_count <= 0 THEN
    RAISE EXCEPTION 'count_must_be_positive' USING ERRCODE = 'check_violation';
  END IF;
  IF p_count > 1000 THEN
    RAISE EXCEPTION 'count_exceeds_safety_cap'
      USING HINT = 'Generating more than 1000 spaces in a single call is blocked. Split into multiple calls.';
  END IF;

  -- Type validation + prefix resolution (unchanged).
  IF p_type IS NULL OR p_type NOT IN ('regular','carport','garage','covered','handicap','employee') THEN
    RAISE EXCEPTION 'invalid_type'
      USING HINT = 'type must be one of: regular, carport, garage, covered, handicap, employee';
  END IF;
  v_resolved_prefix := COALESCE(NULLIF(trim(COALESCE(p_label_prefix, '')), ''),
    CASE p_type
      WHEN 'carport'    THEN 'CP'
      WHEN 'garage'     THEN 'G'
      WHEN 'covered'    THEN 'C'
      WHEN 'handicap'   THEN 'H'
      WHEN 'employee'   THEN 'E'
      ELSE 'R'
    END
  );

  -- ── Serialize per (property, type) ───────────────────────────────
  -- Concurrent CA + manager generation vs the same (property, prefix)
  -- would otherwise both compute the same MAX+1 → UNIQUE violation
  -- on the second inserter. Transaction-scoped advisory lock keyed
  -- on hash(property || ':' || prefix). No DB-wide lock; released
  -- automatically on COMMIT.
  PERFORM pg_advisory_xact_lock(hashtext(lower(p_property) || ':' || v_resolved_prefix));

  -- ── MAX+1 sequencing (replaces COUNT+1) ──────────────────────────
  -- Parse the numeric suffix off matching labels; take MAX; add 1.
  -- The regexp anchor ('^prefix-[0-9]+$') filters non-numeric-suffix
  -- labels so a rename to 'G-North' doesn't inflate the sequence.
  SELECT COALESCE(MAX( (regexp_replace(label, '^.*-', ''))::INTEGER ), 0)
    INTO v_start
    FROM public.spaces
   WHERE property ~~* p_property
     AND label ~ ('^' || v_resolved_prefix || '-[0-9]+$');

  -- Generate contiguously v_start+1 .. v_start+p_count. No IF NOT
  -- EXISTS skip — MAX+1 + advisory lock + UNIQUE constraint make it
  -- redundant; keeping it would re-hide the silent-skip class bug
  -- this migration fixes.
  v_inserted := 0;
  FOR v_i IN (v_start + 1)..(v_start + p_count) LOOP
    v_label := v_resolved_prefix || '-' || v_i::TEXT;
    INSERT INTO public.spaces (
      company, property, label, type, status, is_active,
      created_at, created_by_email
    ) VALUES (
      v_company, p_property, v_label, p_type, 'available', TRUE,
      now(), lower(v_email)
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  -- Rows-affected assert — MAX+1 + lock + UNIQUE guarantee we should
  -- insert exactly p_count rows. Anything else = bug we want to know
  -- about now, not paper over.
  IF v_inserted <> p_count THEN
    RAISE EXCEPTION 'generate_spaces_from_pool rows-affected mismatch: expected %, got %', p_count, v_inserted;
  END IF;

  -- Audit row — extends the prior AUTH_SPACE_GENERATE shape with the
  -- label range (first..last) so dispute-trail queries can resolve
  -- "who generated which labels" without joining spaces on created_by
  -- + created_at.
  v_first_label := v_resolved_prefix || '-' || (v_start + 1)::TEXT;
  v_last_label  := v_resolved_prefix || '-' || (v_start + p_count)::TEXT;
  INSERT INTO public.audit_logs (user_email, action, table_name, new_values, created_at)
  VALUES (
    lower(v_email), 'AUTH_SPACE_GENERATE', 'spaces',
    jsonb_build_object(
      'property',         p_property,
      'type',             p_type,
      'requested_count',  p_count,
      'inserted_count',   v_inserted,
      'label_prefix',     v_resolved_prefix,
      'first_label',      v_first_label,
      'last_label',       v_last_label,
      'caller_role',      v_role
    ),
    now()
  );

  RETURN v_inserted;
END
$func$;

-- Permissions unchanged (idempotent re-apply).
REVOKE EXECUTE ON FUNCTION public.generate_spaces_from_pool(TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.generate_spaces_from_pool(TEXT, TEXT, INTEGER, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.generate_spaces_from_pool(TEXT, TEXT, INTEGER, TEXT) TO authenticated;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_EXTENDED',
  'pg_proc',
  NULL,
  jsonb_build_object(
    'migration', '20260711_manager_bulk_add_spaces_extension',
    'rpc',       'generate_spaces_from_pool',
    'change',    'Body-only extension of the existing 4-arg RPC. (1) Manager callers gain bulk add (p_count>1) gated on user_roles.can_approve_vehicles + cap 100; single add (=1) unchanged for any manager. (2) Manager property-scope tightened to p_property = ANY(user_roles.property[]) — closes an in-company scope leak. (3) Sequencing COUNT+1 → MAX+1 for all callers, dropping the IF NOT EXISTS skip and adding a rows-affected assert — fixes silent partial-success on gapped properties. Advisory lock keyed on (property, prefix) serializes concurrent CA + manager generation. CA cap unchanged (1000). CA behavior unchanged aside from MAX+1 (equivalent when ungapped; correct fix when gapped). Signature unchanged — no client-code sig change required.',
    'rationale', 'Post-launch parallel work. Restores PM space-pool parity for Legacy (A1) + PM tracks: per-space billing removed the original CA-only restriction. Both live-issue fixes (sequencing bug + scope leak) are dormant for A1 weekend so this bundles cleanly post-launch without destabilizing the CA setup path A1 hits Saturday.'
  ),
  now()
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--
-- VQ.A — Still single overload, SD, same signature
--   SELECT proname, prosecdef, pg_get_function_arguments(oid) AS args,
--          count(*) OVER () AS overload_count
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname = 'generate_spaces_from_pool';
--   -- Expected: 1 row; prosecdef=true;
--   -- args = 'p_property text, p_type text, p_count integer,
--   --         p_label_prefix text DEFAULT NULL::text';
--   -- overload_count = 1.
--
-- VQ.B — Grants: authenticated only
--   SELECT grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public'
--     AND routine_name = 'generate_spaces_from_pool';
--   -- Expected: authenticated=EXECUTE (postgres/service_role harmless).
--
-- VQ.C — Body contains the 3 new gates + MAX+1 + advisory lock
--   SELECT pg_get_functiondef(oid) AS body
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname = 'generate_spaces_from_pool';
--   -- Grep expected in returned body:
--   --   'can_approve_vehicles'
--   --   'property_not_in_manager_scope'
--   --   'pg_advisory_xact_lock'
--   --   'regexp_replace(label'                (MAX+1 parse)
--   --   'rows-affected mismatch'
--   --   'AUTH_SPACE_GENERATE'  (unchanged action name)
--
-- VQ.D — Migration audit row landed
--   SELECT action, new_values->>'migration' AS migration, created_at
--   FROM audit_logs
--   WHERE new_values->>'migration' = '20260711_manager_bulk_add_spaces_extension'
--   ORDER BY created_at DESC LIMIT 1;
-- ════════════════════════════════════════════════════════════════════

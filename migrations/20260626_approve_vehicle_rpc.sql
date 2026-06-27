-- ════════════════════════════════════════════════════════════════════
-- Billing Slice 1 / Commit 4a — approve_vehicle() SECURITY DEFINER RPC
-- Date:   2026-06-26
-- Branch: billing/slice1-commit4a-approve-vehicle-rpc
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- Introduces `public.approve_vehicle(p_vehicle_id BIGINT, p_manager_note
-- TEXT DEFAULT NULL) RETURNS jsonb` — the single server-side chokepoint
-- that (1) does the vehicle-approval UPDATE atomically and (2) returns
-- a jsonb result the app uses to decide whether to fire the permit
-- quantity-sync (commit 4b).
--
-- THIS RPC CONSOLIDATES 3 SCATTERED CLIENT-SIDE UPDATE SITES that were
-- found in app/manager/page.tsx during §0.2:
--   L753 — individual approve     (passes manager_note + resident_read=true)
--   L777 — bulk-per-unit          (loop; passes note + resident_read=true)
--   L895 — resident-approve cascade (omits note + omits resident_read=true
--                                    in the current code — drift from
--                                    L753/L777; this RPC normalizes it)
-- Commit 4b replaces all 3 sites with calls to this RPC.
--
-- DESIGN DECISIONS (locked in Jose 2026-06-26 §0 sign-off):
--   1. Signature `(p_vehicle_id BIGINT, p_manager_note TEXT DEFAULT NULL)`.
--      Individual + bulk-per-unit pass the note; cascade passes NULL.
--      Eliminates L895's note-asymmetry via an explicit optional arg.
--   2. resident_read=true set UNCONDITIONALLY (harmless on cascade where
--      no decline card was ever open; eliminates L895's omission).
--   3. Role-pin to {manager, company_admin} — NO admin, NO driver, NO
--      resident (super-admin actions go through other RPCs if needed).
--   4. Scope-check uses the CANONICAL helpers — get_my_properties()
--      for manager (ILIKE-ANY per RLS convention), get_my_company() +
--      1-hop properties join for company_admin (mirrors L1's
--      regenerate_tow_ticket scope shape). NO hand-rolled match —
--      provably identical to RLS scope.
--   5. Idempotent: re-approving an already-approved vehicle returns
--      {ok:true, action:'noop_already_active', vehicle:<row>} with NO
--      DB write. Commit 4b's app wiring keys off action!='noop_*' to
--      decide whether to fire the permit sync.
--   6. Non-throwing for business errors (return {error, hint}); RAISE
--      EXCEPTION only for SQL-layer failures.
--
-- 🔒 SECURITY (load-bearing — the one privilege-sensitive line):
-- Because SECURITY DEFINER bypasses RLS, the function MUST re-enforce
-- scope manually. The manager scope-check uses the EXACT predicate
-- shape that RLS policies use across the codebase:
--   property ~~* ANY (get_my_properties())   [B40, B51a, B80 — RLS canon]
-- If a future helper change makes get_my_properties() narrower (or
-- wider), this RPC inherits that change automatically. Section E of
-- the verification proves the negative case fires: an in-company
-- manager attempting approve_vehicle on a vehicle outside their
-- get_my_properties() set is REJECTED.
--
-- 🔒 OVERLOAD-TRAP PRE-CHECK (§0.1 verified): no existing function
-- named `approve_vehicle` before this apply. Section A re-confirms
-- pre-state. Section B post-apply confirms exactly one signature.
--
-- 🔒 GRANT FOOTGUN (function analog of the table footgun):
-- REVOKE EXECUTE FROM PUBLIC + anon explicitly, then GRANT EXECUTE
-- TO authenticated. Role-pin inside the function narrows authenticated
-- → manager/company_admin. service_role retains its grants (backend
-- BYPASSRLS). [[feedback-function-public-grant-supabase-default]]
-- discipline observed.
--
-- APPLY DISCIPLINE (commit 4a is migration-only):
--   1. Eyeball this file (particularly the scope-check block)
--   2. Section A pre-check (overload + grants pre-state)
--   3. Apply migration single BEGIN/COMMIT paste
--   4. Sections B–F post-apply (esp. E load-bearing scope negative)
--   5. On clean → push 4a → write 4b (app wiring)
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — approve_vehicle() RPC
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.approve_vehicle(
  p_vehicle_id   BIGINT,
  p_manager_note TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_role        TEXT;
  v_caller_company     TEXT;
  v_caller_properties  TEXT[];
  v_vehicle            public.vehicles%ROWTYPE;
  v_in_scope           BOOLEAN := FALSE;
  v_updated            public.vehicles%ROWTYPE;
BEGIN
  -- ── 1. Role gate ────────────────────────────────────────────────
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  IF v_caller_role NOT IN ('manager', 'company_admin') THEN
    RETURN jsonb_build_object(
      'error', 'role_not_authorized',
      'hint',  'approve_vehicle requires manager or company_admin role; got ' || v_caller_role
    );
  END IF;

  -- ── 2. Load target vehicle (or fail not_found) ─────────────────
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id;
  IF v_vehicle.id IS NULL THEN
    RETURN jsonb_build_object('error', 'vehicle_not_found');
  END IF;

  -- ╔══════════════════════════════════════════════════════════╗
  -- ║ ★ 3. SCOPE-CHECK — the one privilege-sensitive line     ║
  -- ║                                                          ║
  -- ║ DEFINER bypasses RLS. We re-enforce scope HERE using the ║
  -- ║ EXACT helpers RLS policies use elsewhere:                ║
  -- ║                                                          ║
  -- ║  manager:        property ~~* ANY (get_my_properties())  ║
  -- ║                  (canonical RLS shape; B40/B51a/B80)     ║
  -- ║                                                          ║
  -- ║  company_admin:  EXISTS join to properties WHERE         ║
  -- ║                  name ~~* v_vehicle.property             ║
  -- ║                  AND company ~~* get_my_company()        ║
  -- ║                  (mirrors L1 regenerate_tow_ticket scope) ║
  -- ║                                                          ║
  -- ║ Section E of verification fires the negative test: an    ║
  -- ║ in-company manager attempting approve on a vehicle at a  ║
  -- ║ DIFFERENT property must be rejected. If E passes, this   ║
  -- ║ block is provably equivalent to RLS scope.               ║
  -- ╚══════════════════════════════════════════════════════════╝
  IF v_caller_role = 'manager' THEN
    v_caller_properties := get_my_properties();
    IF v_caller_properties IS NULL OR array_length(v_caller_properties, 1) IS NULL THEN
      RETURN jsonb_build_object('error', 'no_properties_in_scope');
    END IF;
    v_in_scope := v_vehicle.property ~~* ANY(v_caller_properties);
  ELSIF v_caller_role = 'company_admin' THEN
    v_caller_company := get_my_company();
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM public.properties p
       WHERE p.name ~~* v_vehicle.property
         AND p.company ~~* v_caller_company
    ) INTO v_in_scope;
  END IF;

  IF NOT v_in_scope THEN
    RETURN jsonb_build_object(
      'error', 'vehicle_out_of_scope',
      'hint',  'The vehicle belongs to a property outside your role''s scope.'
    );
  END IF;

  -- ── 4. Idempotency — already-approved is a no-op ────────────────
  -- Returns {ok:true, action:'noop_already_active'} so commit 4b's app
  -- wiring can decide whether to fire the permit sync (only fires on
  -- action='approved'; noop skips the sync since the count is unchanged).
  IF v_vehicle.status = 'active' AND v_vehicle.is_active = TRUE THEN
    RETURN jsonb_build_object(
      'ok',      TRUE,
      'action',  'noop_already_active',
      'vehicle', to_jsonb(v_vehicle)
    );
  END IF;

  -- ── 5. THE APPROVAL UPDATE ──────────────────────────────────────
  -- Mirrors the 3 client-side sites' shape with the L895 drift
  -- normalized:
  --   is_active     = true       (always)
  --   status        = 'active'   (always)
  --   resident_read = true       (always — fixes L895 omission)
  --   manager_note  = p_manager_note  (direct assignment, not COALESCE
  --                                    — matches current client behavior
  --                                    where pendingNotes[id]||null
  --                                    clears the field on a no-note
  --                                    approval; cascade passes NULL
  --                                    which clears any leftover note)
  UPDATE public.vehicles
     SET is_active     = TRUE,
         status        = 'active',
         resident_read = TRUE,
         manager_note  = p_manager_note
   WHERE id = p_vehicle_id
  RETURNING * INTO v_updated;

  RETURN jsonb_build_object(
    'ok',      TRUE,
    'action',  'approved',
    'vehicle', to_jsonb(v_updated)
  );
END;
$func$;


-- ════════════════════════════════════════════════════════════════════
-- PART 2 — Grants (function-grant footgun discipline)
-- ════════════════════════════════════════════════════════════════════
-- Per [[feedback-function-public-grant-supabase-default]]: REVOKE
-- explicit on PUBLIC + anon (Supabase doesn't override Postgres default
-- of GRANT EXECUTE to PUBLIC). Then GRANT to authenticated only.
-- service_role retains its default grants (Supabase backend).

REVOKE EXECUTE ON FUNCTION public.approve_vehicle(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_vehicle(BIGINT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.approve_vehicle(BIGINT, TEXT) TO authenticated;


-- ════════════════════════════════════════════════════════════════════
-- PART 3 — Migration audit row
-- ════════════════════════════════════════════════════════════════════

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_CREATED',
  'approve_vehicle',
  NULL,
  jsonb_build_object(
    'migration',  '20260626_approve_vehicle_rpc',
    'slice',      'billing slice 1 commit 4a',
    'rpc',        'approve_vehicle(p_vehicle_id BIGINT, p_manager_note TEXT DEFAULT NULL) RETURNS jsonb',
    'role_pin',   jsonb_build_array('manager', 'company_admin'),
    'scope_helpers', jsonb_build_object(
      'manager',       'get_my_properties() — property ~~* ANY (canonical RLS shape)',
      'company_admin', 'get_my_company() + 1-hop properties join (mirrors L1 regenerate_tow_ticket)'
    ),
    'consolidates', jsonb_build_array(
      'app/manager/page.tsx:753 individual approve',
      'app/manager/page.tsx:777 bulk-per-unit approve (loop)',
      'app/manager/page.tsx:895 resident-approve cascade (drift normalized: now sets resident_read=true)'
    ),
    'normalized', 'L895 cascade now sets resident_read=true uniformly (was omitted in client-side shape)',
    'idempotency', 'already-approved returns action=noop_already_active without DB write or sync trigger',
    'overload_trap', 'pre-checked via §0.1; Section B post-apply confirms exactly 1 signature',
    'grant_footgun', 'REVOKE PUBLIC + anon explicit, GRANT authenticated only; role-pin inside narrows further'
  ),
  now()
);

COMMIT;

-- Spaces v1.1 — explicit multi-resident-per-space expansion (join-table model).
--
-- ════════════════════════════════════════════════════════════════════
-- 🔒 LOCKED INVARIANT — at the top, honored everywhere
-- ════════════════════════════════════════════════════════════════════
-- AUTHORIZATION DERIVES FROM THE VEHICLE, NEVER THE SPACE.
--
-- A resident with an active, approved vehicle is AUTHORIZED — period.
-- Holding a space ≠ being authorized; not holding a space ≠ being
-- unauthorized. The space is REFERENCE DATA on the ticket, not an
-- enforcement gate. The label (or its absence) is informational
-- context for the human operator. The system NEVER flips a car to
-- unauthorized because of a space fact. The ONLY thing that makes a
-- car unauthorized is the vehicle itself being deactivated by the PM
-- (or the resident being deactivated, which cascades to the vehicle
-- via the existing B166 trim path — still vehicle-level).
--
-- FREEING A SPACE NEVER TOUCHES THE VEHICLE OR THE RESIDENT'S
-- AUTHORIZATION. The free_space RPC (per-resident or whole-space)
-- removes the space tie only. Resident stays active, vehicles stay
-- active, ticket simply no longer shows a space label.
--
-- This invariant is asserted by smoke row D-NULL: an authorized vehicle
-- with NO space tie MUST return 'authorized' with the space field
-- rendering as a dash. If "not in any space's plate set" is ever
-- treated as "not authorized," that's a regression against this rule.
--
-- ════════════════════════════════════════════════════════════════════
-- ORIGIN
-- ════════════════════════════════════════════════════════════════════
-- Spaces v1 shipped 1:1 space→resident (spaces.assigned_to_resident_email
-- single text column). The locked v1.1 expansion replaces that with an
-- explicit join table — a space can be tied to up to 2 resident emails
-- (cap=2 in RPC; promotable later). Each row in space_residents IS the
-- explicit tie. The unit-co-residency DERIVATION path (originally
-- considered) was rejected: authorizing by unit-membership is too loose
-- for enforcement — a stale residents row, a mistyped unit, or an
-- unrelated third resident at the same unit would all get authorized.
-- Explicit-named tying closes that hole: only the people the manager
-- deliberately tied to the space are authorized.
--
-- DESIGN LOCKS (Jose, sign-off this build):
--   • Schema shape: join table space_residents (not array, not fixed cols)
--   • Cap = 2, RPC-enforced via v_cap constant (not CHECK; can't count
--     join rows row-locally)
--   • Deactivation-free: DB trigger (not client-side hook). Three
--     production paths set residents.is_active=false (deactivateResident,
--     declineResident, admin DEACTIVATE_PROPERTY_CASCADE); client-side
--     hook would miss two. Trigger catches all + future paths.
--   • Drop reassign_space — set-world makes "reassign" ambiguous.
--     Manager UX = two explicit clicks (remove + add).
--   • Legacy spaces.assigned_to_resident_email PRESERVED (dual-written
--     by new RPCs during deprecation window). Same expand-contract
--     lesson as total_spaces rename. Drop in separate follow-on after
--     v1.1 readers prove moved.
--
-- DEPRECATED COLUMN LIFECYCLE (expand-contract phase 1 of 2)
--   spaces.assigned_to_resident_email stays in this migration. Commit 2-5
--   ship the 9 client readers + the spaces.ts helper migrated to read the
--   new residents-array shape (sourced from space_residents). After the
--   commit-2-through-5 deploy proves green, a separate cleanup migration
--   drops the legacy column. During the deprecation window the new RPCs
--   dual-write: legacy column = the single resident's email when set has
--   exactly 1 row; NULL when set has 0 or 2+. Sequencing guarantee
--   (Jose 2026-06-22): NO legacy reader survives past the commit 2-5
--   push — the "NULL on 2+" state is pure safety margin, never visible.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — NEW TABLE: space_residents (the explicit tie)
-- ════════════════════════════════════════════════════════════════════
-- PK (space_id, resident_email) enforces:
--   • Idempotency (re-tying same resident = PK violation = caught by RPC
--     as no-op success)
--   • No-duplicate tie (the same resident cannot appear twice per space)
--
-- ON DELETE CASCADE on space_id: if a space row is hard-deleted (rare —
-- decommission is is_active=FALSE, not DELETE — but defensive), all
-- ties drop with it.
--
-- No FK to residents (residents.email isn't a PK; email is text, residents
-- has its own id). The trigger reconciles ties via residents.is_active
-- changes; manual residents row deletes (rare) would orphan space_residents
-- rows but the deactivation trigger handles the common case.

CREATE TABLE IF NOT EXISTS public.space_residents (
  space_id          BIGINT      NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  resident_email    TEXT        NOT NULL,        -- normalized lowercase by RPCs
  added_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by_email    TEXT        NOT NULL,
  PRIMARY KEY (space_id, resident_email)
);

-- Reverse-lookup index for the deactivation trigger: "find all spaces
-- this resident is tied to." lower() because RPCs normalize to lowercase
-- on insert; this matches trigger's lower(NEW.email) lookup.
CREATE INDEX IF NOT EXISTS space_residents_resident_lookup
  ON public.space_residents (lower(resident_email));

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — RLS on space_residents (3 policies, mirror spaces shape)
-- ════════════════════════════════════════════════════════════════════
-- NO driver policy. Driver reads via the new DEFINER RPC
-- derive_space_allowed_plates which projects only space label + plates.

ALTER TABLE public.space_residents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_all_space_residents" ON public.space_residents;
CREATE POLICY "admin_all_space_residents" ON public.space_residents
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin'::text);

DROP POLICY IF EXISTS "company_admin_own_space_residents" ON public.space_residents;
CREATE POLICY "company_admin_own_space_residents" ON public.space_residents
  FOR ALL TO authenticated
  USING (
    (get_my_role() = 'company_admin'::text)
    AND EXISTS (
      SELECT 1 FROM public.spaces s
       WHERE s.id = space_residents.space_id
         AND s.company ~~* get_my_company()
    )
  );

DROP POLICY IF EXISTS "manager_own_space_residents" ON public.space_residents;
CREATE POLICY "manager_own_space_residents" ON public.space_residents
  FOR ALL TO authenticated
  USING (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND EXISTS (
      SELECT 1 FROM public.spaces s
       WHERE s.id = space_residents.space_id
         AND s.property ~~* ANY (get_my_properties())
    )
  );

REVOKE ALL ON public.space_residents FROM anon, public;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.space_residents TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — BACKFILL: copy existing 1:1 assignments into space_residents
-- ════════════════════════════════════════════════════════════════════
-- Every existing spaces row with assigned_to_resident_email IS NOT NULL
-- becomes one space_residents row. Preserves current 1-per-space state.
-- Backfill-count assertion in verification file catches silent drops.

INSERT INTO public.space_residents (space_id, resident_email, added_at, added_by_email)
SELECT
  id,
  lower(assigned_to_resident_email),
  COALESCE(assigned_at, now()),
  COALESCE(assigned_by_email, 'system_migration_v1_1')
  FROM public.spaces
 WHERE assigned_to_resident_email IS NOT NULL
   AND is_active = TRUE
ON CONFLICT (space_id, resident_email) DO NOTHING;  -- defensive; first run can't conflict but re-runs are safe

-- ════════════════════════════════════════════════════════════════════
-- PART 4 — DROP reassign_space RPC (locked decision #4)
-- ════════════════════════════════════════════════════════════════════
-- Set-world makes "reassign" ambiguous. Manager UX = two explicit
-- actions (remove + add). RPC removed; UI removed in commit 3+4.

DROP FUNCTION IF EXISTS public.reassign_space(BIGINT, TEXT);

-- ════════════════════════════════════════════════════════════════════
-- PART 5 — DEACTIVATION TRIGGER (the load-bearing capacity-leak defense)
-- ════════════════════════════════════════════════════════════════════
-- Fires AFTER UPDATE OF is_active on residents WHEN is_active goes TRUE→FALSE.
-- Catches all 3 production paths:
--   1. deactivateResident (manager UI, app/manager/page.tsx:1086)
--   2. declineResident (manager pending-decline, app/manager/page.tsx:826)
--   3. admin DEACTIVATE_PROPERTY_CASCADE (app/admin/page.tsx:373)
-- Plus any future 4th path automatically. Single transaction with the
-- originating residents UPDATE; race-safe.
--
-- Audit row per space freed (AUTH_SPACE_FREE_AUTO action, distinct from
-- the manual AUTH_SPACE_FREE so log viewers can filter trigger-driven
-- frees from manual ones — see audit-write verification query).
--
-- INVARIANT REMINDER: this trigger removes SPACE TIES only. It does NOT
-- touch vehicles, does NOT change is_active anywhere except the trigger
-- already-firing on residents. Vehicles drop via the existing B166
-- trimDepartedResidentVehicles path which runs in the client; vehicles
-- and space-ties are independent concerns.

CREATE OR REPLACE FUNCTION public.free_spaces_on_resident_deactivate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_space_id  BIGINT;
  v_remaining INTEGER;
BEGIN
  -- Loop over every space this resident was tied to. Index on
  -- lower(resident_email) makes this an index scan.
  FOR v_space_id IN
    SELECT space_id
      FROM public.space_residents
     WHERE lower(resident_email) = lower(NEW.email)
  LOOP
    -- Remove this resident's tie to v_space_id.
    DELETE FROM public.space_residents
     WHERE space_id = v_space_id
       AND lower(resident_email) = lower(NEW.email);

    -- Check if any ties remain for this space.
    SELECT COUNT(*) INTO v_remaining
      FROM public.space_residents
     WHERE space_id = v_space_id;

    -- If empty, flip the space back to 'available' + clear the legacy
    -- assigned_to_resident_email column (dual-write discipline).
    IF v_remaining = 0 THEN
      UPDATE public.spaces
         SET status                     = 'available',
             assigned_to_resident_email = NULL,
             assigned_at                = NULL,
             assigned_by_email          = NULL
       WHERE id = v_space_id;
    ELSIF v_remaining = 1 THEN
      -- Set went from N≥2 to 1: dual-write the remaining email into the
      -- legacy column so commit-2-5 legacy readers continue to see a
      -- valid single-resident state.
      UPDATE public.spaces
         SET assigned_to_resident_email = (
               SELECT lower(resident_email)
                 FROM public.space_residents
                WHERE space_id = v_space_id
                LIMIT 1
             )
       WHERE id = v_space_id;
    END IF;
    -- If v_remaining >= 2, legacy column stays NULL (multi-resident state)
    -- per dual-write rule.

    -- Audit row per space freed. AUTH_SPACE_FREE_AUTO distinguishes
    -- trigger-driven frees from manual free_space RPC calls in log queries.
    INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
    VALUES (
      lower(NEW.email),                    -- user_email: the resident being deactivated
      'AUTH_SPACE_FREE_AUTO',
      'spaces',
      v_space_id,
      jsonb_build_object(
        'space_id',              v_space_id,
        'freed_resident_email',  lower(NEW.email),
        'remaining_residents',   v_remaining,
        'trigger_source',        TG_NAME,
        'space_freed_completely', (v_remaining = 0)
      ),
      now()
    );
  END LOOP;

  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS residents_deactivate_free_spaces ON public.residents;
CREATE TRIGGER residents_deactivate_free_spaces
  AFTER UPDATE OF is_active ON public.residents
  FOR EACH ROW
  WHEN (OLD.is_active = TRUE AND NEW.is_active = FALSE)
  EXECUTE FUNCTION public.free_spaces_on_resident_deactivate();

-- ════════════════════════════════════════════════════════════════════
-- PART 6 — REWRITE assign_space (set-add semantics, cap=2, idempotent)
-- ════════════════════════════════════════════════════════════════════
-- Signature unchanged. Behavior shift:
--   • Set-add: INSERT into space_residents (PK protects idempotency).
--   • Cap=2 (v_cap constant) — RPC-enforced; render-side is advisory.
--   • Dual-write legacy column: email when set ends at 1 row, NULL at 2+.
--   • Flip spaces.status='assigned' on first insert.

CREATE OR REPLACE FUNCTION public.assign_space(
  p_space_id       BIGINT,
  p_resident_email TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_cap                CONSTANT INTEGER := 2;  -- locked decision #5
  v_email              TEXT;
  v_role               TEXT;
  v_company            TEXT;
  v_space_company      TEXT;
  v_space_property     TEXT;
  v_resident_ok        BOOLEAN;
  v_normalized_email   TEXT;
  v_current_count      INTEGER;
  v_already_present    BOOLEAN;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- Role + company guard (single round-trip).
  SELECT role, company INTO v_role, v_company
    FROM public.user_roles
   WHERE lower(email) = lower(v_email)
   LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed'
      USING HINT = 'Only managers and company admins can assign spaces.';
  END IF;

  -- Load space + verify company.
  SELECT company, property INTO v_space_company, v_space_property
    FROM public.spaces
   WHERE id = p_space_id;
  IF v_space_company IS NULL THEN
    RAISE EXCEPTION 'space_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_space_company !~~* v_company THEN
    RAISE EXCEPTION 'space_not_in_company'
      USING HINT = 'The space does not belong to your company.';
  END IF;

  -- Validate resident.
  v_normalized_email := lower(trim(COALESCE(p_resident_email, '')));
  IF length(v_normalized_email) = 0 THEN
    RAISE EXCEPTION 'resident_email_required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.residents
     WHERE lower(email) = v_normalized_email
       AND property ~~* v_space_property
       AND is_active = TRUE
  ) INTO v_resident_ok;
  IF NOT v_resident_ok THEN
    RAISE EXCEPTION 'resident_not_active_at_property'
      USING HINT = 'The resident must be active at this space''s property.';
  END IF;

  -- Idempotency check: if already tied, return success no-op.
  SELECT EXISTS (
    SELECT 1 FROM public.space_residents
     WHERE space_id = p_space_id
       AND lower(resident_email) = v_normalized_email
  ) INTO v_already_present;
  IF v_already_present THEN
    RETURN TRUE;
  END IF;

  -- Cap check.
  SELECT COUNT(*) INTO v_current_count
    FROM public.space_residents
   WHERE space_id = p_space_id;
  IF v_current_count >= v_cap THEN
    RAISE EXCEPTION 'space_at_cap'
      USING HINT = format('Spaces are limited to %s residents (this space already has %s).', v_cap, v_current_count);
  END IF;

  -- INSERT the tie.
  INSERT INTO public.space_residents (space_id, resident_email, added_at, added_by_email)
  VALUES (p_space_id, v_normalized_email, now(), lower(v_email));

  -- Flip status + dual-write legacy column.
  -- v_current_count was the count BEFORE the insert; after insert it's +1.
  IF v_current_count = 0 THEN
    -- This was the first tie; space was 'available', flip to 'assigned'.
    -- Legacy column = this single resident (1-row state).
    UPDATE public.spaces
       SET status                     = 'assigned',
           assigned_to_resident_email = v_normalized_email,
           assigned_at                = now(),
           assigned_by_email          = lower(v_email)
     WHERE id = p_space_id;
  ELSIF v_current_count = 1 THEN
    -- Set was 1, now 2: NULL the legacy column (multi-resident state).
    UPDATE public.spaces
       SET assigned_to_resident_email = NULL
     WHERE id = p_space_id;
  END IF;

  -- Audit.
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_email), 'AUTH_SPACE_ASSIGN', 'spaces', p_space_id,
    jsonb_build_object(
      'resident_email',     v_normalized_email,
      'property',           v_space_property,
      'company',            v_company,
      'set_size_after',     v_current_count + 1
    ),
    now()
  );

  RETURN TRUE;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.assign_space(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.assign_space(BIGINT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.assign_space(BIGINT, TEXT) TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- PART 7 — EXTEND free_space (optional resident param; per-resident remove)
-- ════════════════════════════════════════════════════════════════════
-- Signature change: ADD optional p_resident_email param.
--   • NULL → free entire space (legacy mode): DELETE all space_residents
--     rows for this space, status='available', clear legacy column.
--   • Non-NULL → remove just that resident (idempotent — missing row =
--     success no-op). Auto-flip status='available' only when set empties.
--     Dual-write legacy column per the 0/1/2+ rule.
--
-- INVARIANT: this RPC NEVER touches vehicles or residents.is_active.
-- Removing a space tie ≠ deactivating the resident ≠ deauthorizing the
-- vehicle. Verified by smoke rows M5 + M6 + M7.

CREATE OR REPLACE FUNCTION public.free_space(
  p_space_id       BIGINT,
  p_reason         TEXT DEFAULT 'manual_free',
  p_resident_email TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email             TEXT;
  v_role              TEXT;
  v_company           TEXT;
  v_space_company     TEXT;
  v_normalized_reason TEXT;
  v_normalized_email  TEXT;
  v_remaining         INTEGER;
BEGIN
  v_email := auth.jwt() ->> 'email';

  SELECT role, company INTO v_role, v_company
    FROM public.user_roles WHERE lower(email) = lower(v_email) LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed';
  END IF;

  SELECT company INTO v_space_company
    FROM public.spaces WHERE id = p_space_id;
  IF v_space_company IS NULL THEN
    RAISE EXCEPTION 'space_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_space_company !~~* v_company THEN
    RAISE EXCEPTION 'space_not_in_company';
  END IF;

  v_normalized_reason := NULLIF(trim(COALESCE(p_reason, '')), '');
  IF v_normalized_reason IS NULL THEN v_normalized_reason := 'manual_free'; END IF;
  IF v_normalized_reason NOT IN ('manual_free','deactivation','manual_reassign','space_decommissioned') THEN
    RAISE EXCEPTION 'invalid_freed_reason'
      USING HINT = 'reason must be one of: manual_free, deactivation, manual_reassign, space_decommissioned';
  END IF;

  v_normalized_email := lower(trim(COALESCE(p_resident_email, '')));

  IF length(v_normalized_email) = 0 THEN
    -- Whole-space free (legacy mode): DELETE all ties, status='available',
    -- clear legacy column.
    DELETE FROM public.space_residents WHERE space_id = p_space_id;
    UPDATE public.spaces
       SET status                     = 'available',
           assigned_to_resident_email = NULL,
           assigned_at                = NULL,
           assigned_by_email          = NULL
     WHERE id = p_space_id;

    INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
    VALUES (
      lower(v_email), 'AUTH_SPACE_FREE', 'spaces', p_space_id,
      jsonb_build_object(
        'reason',           v_normalized_reason,
        'mode',             'whole_space',
        'set_size_after',   0
      ),
      now()
    );
    RETURN TRUE;
  END IF;

  -- Per-resident free: remove just this email's tie. Idempotent.
  DELETE FROM public.space_residents
   WHERE space_id = p_space_id
     AND lower(resident_email) = v_normalized_email;

  SELECT COUNT(*) INTO v_remaining
    FROM public.space_residents WHERE space_id = p_space_id;

  IF v_remaining = 0 THEN
    UPDATE public.spaces
       SET status                     = 'available',
           assigned_to_resident_email = NULL,
           assigned_at                = NULL,
           assigned_by_email          = NULL
     WHERE id = p_space_id;
  ELSIF v_remaining = 1 THEN
    -- Set went from 2 to 1: dual-write the remaining email.
    UPDATE public.spaces
       SET assigned_to_resident_email = (
             SELECT lower(resident_email)
               FROM public.space_residents
              WHERE space_id = p_space_id
              LIMIT 1
           )
     WHERE id = p_space_id;
  END IF;
  -- v_remaining >= 2: legacy column stays NULL (multi-resident state)

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_email), 'AUTH_SPACE_FREE', 'spaces', p_space_id,
    jsonb_build_object(
      'reason',                v_normalized_reason,
      'mode',                  'per_resident',
      'freed_resident_email',  v_normalized_email,
      'set_size_after',        v_remaining
    ),
    now()
  );

  RETURN TRUE;
END;
$func$;

-- Old signature drop (commit-1 schema migration replaces it with extended one)
DROP FUNCTION IF EXISTS public.free_space(BIGINT, TEXT);

REVOKE EXECUTE ON FUNCTION public.free_space(BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.free_space(BIGINT, TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.free_space(BIGINT, TEXT, TEXT) TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- PART 8 — REWRITE decommission_space (gate flips from scalar→set)
-- ════════════════════════════════════════════════════════════════════
-- Gate change: was "IF assigned_to_resident_email IS NOT NULL"; now
-- "IF EXISTS in space_residents." Same friendly raise.

CREATE OR REPLACE FUNCTION public.decommission_space(
  p_space_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email         TEXT;
  v_role          TEXT;
  v_company       TEXT;
  v_space_company TEXT;
BEGIN
  v_email := auth.jwt() ->> 'email';

  SELECT role, company INTO v_role, v_company
    FROM public.user_roles WHERE lower(email) = lower(v_email) LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed';
  END IF;

  SELECT company INTO v_space_company
    FROM public.spaces WHERE id = p_space_id;
  IF v_space_company IS NULL THEN
    RAISE EXCEPTION 'space_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_space_company !~~* v_company THEN
    RAISE EXCEPTION 'space_not_in_company';
  END IF;

  -- Gate: must be unassigned (set must be empty).
  IF EXISTS (SELECT 1 FROM public.space_residents WHERE space_id = p_space_id) THEN
    RAISE EXCEPTION 'space_still_assigned'
      USING HINT = 'Remove all tied residents (free_space) before decommissioning.';
  END IF;

  UPDATE public.spaces SET is_active = FALSE WHERE id = p_space_id;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_email), 'AUTH_SPACE_DECOMMISSION', 'spaces', p_space_id,
    jsonb_build_object('company', v_space_company),
    now()
  );

  RETURN TRUE;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.decommission_space(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decommission_space(BIGINT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.decommission_space(BIGINT) TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- PART 9 — NEW driver-facing helper RPC: derive_space_allowed_plates
-- ════════════════════════════════════════════════════════════════════
-- DEFINER, role-pinned to 'driver'. Resolves the driver Q4 fix without
-- ever leaking PII over the wire: returns space label + description +
-- the union of plates from all active residents tied to each of the
-- caller-provided resident's spaces. NO resident_email, NO names.
--
-- Input: (p_property, p_resident_email) — the property being scanned
-- + the resident_email of the vehicle just matched in the driver
-- cascade. The RPC finds spaces this resident is tied to and returns
-- the allowed-plates union for each.
--
-- INVARIANT REMINDER: the returned array CAN be empty (resident holds
-- no spaces). Driver render must treat empty array as "no space label
-- — render dash" while the vehicle authorization stays intact. The
-- empty array is reference-data absence, NOT a deauthorization signal.
--
-- Returns JSONB array (preferred over TABLE for client simplicity):
--   [
--     { "space_label": "C-12", "space_description": "Building A row 3",
--       "plates": ["ABC1234", "XYZ5678"] },
--     ...
--   ]

CREATE OR REPLACE FUNCTION public.derive_space_allowed_plates(
  p_property       TEXT,
  p_resident_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email TEXT;
  v_role  TEXT;
  v_result JSONB;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- Role pin: driver only.
  SELECT role INTO v_role
    FROM public.user_roles
   WHERE lower(email) = lower(v_email)
   LIMIT 1;
  IF v_role IS NULL OR v_role <> 'driver' THEN
    RAISE EXCEPTION 'role_not_allowed'
      USING HINT = 'derive_space_allowed_plates is for the driver enforcement surface only.';
  END IF;

  IF p_property IS NULL OR length(trim(p_property)) = 0 THEN
    RAISE EXCEPTION 'property_required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_resident_email IS NULL OR length(trim(p_resident_email)) = 0 THEN
    RAISE EXCEPTION 'resident_email_required' USING ERRCODE = 'check_violation';
  END IF;

  -- Find spaces this resident is tied to at this property. For each,
  -- aggregate the plates of ALL active residents tied to that space
  -- (NOT "all OTHER" — the searched-resident's own plates are included,
  -- because the driver should see every allowed plate in the space,
  -- including the one they just scanned). Project ONLY safe-public
  -- columns: space.label, space.description, the plate array. NO
  -- resident emails or names in the output.
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'space_label',       s.label,
      'space_description', s.description,
      'plates',            COALESCE(p.plates, '[]'::jsonb)
    )
    ORDER BY s.label
  ), '[]'::jsonb)
  INTO v_result
  FROM public.spaces s
  JOIN public.space_residents sr
    ON sr.space_id = s.id
   AND lower(sr.resident_email) = lower(p_resident_email)
  LEFT JOIN LATERAL (
    -- Aggregate plates from ALL residents tied to this space.
    SELECT jsonb_agg(DISTINCT v.plate ORDER BY v.plate) AS plates
      FROM public.space_residents sr_all
      JOIN public.vehicles v
        ON lower(v.resident_email) = lower(sr_all.resident_email)
       AND v.is_active = TRUE
       AND v.status = 'active'
       AND v.property ~~* p_property
     WHERE sr_all.space_id = s.id
  ) p ON TRUE
  WHERE s.property ~~* p_property
    AND s.is_active = TRUE
    AND s.status = 'assigned';

  RETURN v_result;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.derive_space_allowed_plates(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.derive_space_allowed_plates(TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.derive_space_allowed_plates(TEXT, TEXT) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- ===== STOP: verification queries are in a SEPARATE file:
-- =====     migrations/20260622_spaces_v1_1_multi_resident_verification.sql
-- ===== Apply the BEGIN/COMMIT block above as a single paste in SQL Editor.
-- ===== Then run the verification queries from the separate file
-- ===== individually. The TWO LOAD-BEARING checks are:
-- =====   (1) Backfill-count assertion (PASS/FAIL).
-- =====   (2) Audit-write confirmation (trigger has grant to write
-- =====       audit_logs and AUTH_SPACE_FREE_AUTO renders sensibly).
-- ════════════════════════════════════════════════════════════════════

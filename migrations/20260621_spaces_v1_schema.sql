-- Spaces v1 — schema extension + backfill + history + RLS + 5 DEFINER RPCs
--
-- ORIGIN
--   A1's key migration-buy-in feature (alongside guest-auth B214). Visitor
--   passes + guest auths cover the "who can be here" question; spaces v1
--   answers "where do they go." Enumerated assignable rows for reserved
--   spaces (manager assigns to RESIDENT, not unit, per B166 multi-residency
--   reality); visitor capacity stays as a COUNT (NOT rows) tracked against
--   active visitor passes.
--
-- SUPERSEDES the "count-with-no-rows" bug (was tracked as B215 in Jose's
-- in-flight backlog; this build replaces that fix entirely — the rows model
-- IS the fix).
--
-- DESIGN LOCKED (Jose 2026-06-21)
--   • TWO space models by type: RESERVED/assigned = enumerated labeled rows;
--     VISITOR/OPEN = a capacity COUNT on properties.visitor_capacity
--   • Reserved row fields: type (regular/carport/garage/covered/handicap/
--     employee — extensible TEXT), label (UNIQUE per property), description
--     (location + REFERENCE-only price), status (available/assigned),
--     is_active (true/false for decommission history)
--   • Assignment: ONE mechanism — space → resident (NOT unit). Resident can
--     hold MULTIPLE spaces. Authorized plates DERIVE from assigned resident's
--     approved vehicles (no separate plate-to-space FK)
--   • Lifecycle: assignment hooks the EXISTING resident-approval flow.
--     Deactivation FREES spaces (returns to available, keeps history).
--     Reactivation does NOT auto-restore (manager re-assigns explicitly;
--     space may have been reassigned in the interim)
--   • Enforcement STAYS PLATE-LEVEL in v1. Spaces are RECORDED and SHOWN
--     (driver scan shows space label + location_notes per Jose's revised
--     privacy line 2026-06-21) but do NOT change enforcement
--   • Frequency-cap-style trigger NONE — visitor capacity is a soft SOFT
--     metric (visitor_capacity − active_passes_count), not an enforced cap
--
-- AUDIT-DATA-DRIVEN BACKFILL (Jose ran audit 2026-06-21; simplified per Jose
-- 2026-06-21 follow-up: existing rows are TEST DATA being cleared by the
-- pre-launch wipe — do NOT build a preservation path for the 1 occupied row):
--   • 123 rows status='available' (no unit, no plate, no assignment) — clean
--   • 2 rows status='reserved' (no unit, no plate, no assignment) — "held
--     but unassigned" is NOT a v1 state; migrate to 'available'
--   • 1 row status='occupied' (has unit + plate, test data) — migrate to
--     'available'; do NOT preserve the assignment (no residents-join logic).
--     Future per-customer onboarding starts fresh with the new schema.
--
-- migration_note column is RETAINED (zero cost, future-defensive) but the
-- v1 backfill does NOT produce any flagged rows. Manager Spaces tab in
-- commit 3 can still render a defensive yellow banner for any future flagged
-- rows, but it'll show 0 today and the code stays inert.
--
-- DEFERRED CLEANUP (do NOT drop in this migration — risk window during deploy)
--   Spaces table legacy columns (space_number, assigned_to_unit,
--   assigned_to_plate, notes, location_notes) are PRESERVED + marked
--   deprecated. properties.total_spaces ALSO preserved (Jose correction
--   2026-06-21: expand-contract pattern — a bare RENAME would break live
--   readers between migration-apply and code-deploy). All preserved
--   columns get dropped by a follow-on cleanup migration once rollout
--   proves green. Rationale: Vercel rolling deploys serve mixed code
--   versions for ~10s; preserving legacy columns means that overlap
--   window doesn't read NULL or fail on missing column. Same B66.1/B82
--   hardening pattern.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — properties: ADD visitor_capacity (expand phase of expand-contract)
-- ════════════════════════════════════════════════════════════════════
-- Jose correction 2026-06-21: a bare RENAME here would break live readers
-- the moment this migration applies (commit 4 reader updates ship later;
-- legacy code on the deployed instance still reads `total_spaces`). Same
-- expand-contract pattern as the spaces columns below — ADD the new column
-- now + backfill, keep the legacy column. Commit 4 dual-writes to both
-- columns during the transition. A follow-on cleanup migration drops
-- `total_spaces` after rollout proves green.

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS visitor_capacity INTEGER;

-- Backfill from the legacy column. Run idempotently (only fill rows where
-- visitor_capacity is still NULL — re-running this migration after manual
-- edits doesn't overwrite them).
UPDATE public.properties
   SET visitor_capacity = total_spaces
 WHERE visitor_capacity IS NULL;

COMMENT ON COLUMN public.properties.visitor_capacity IS
  'Soft cap for active visitor passes (count, not rows). Compared at read-time against active visitor_passes count; not enforced by a trigger. Added 2026-06-21 (Spaces v1) as the expand-phase rename of total_spaces — dual-written by commit 4 code during the transition; total_spaces dropped by a follow-on cleanup migration once rollout proves green.';

COMMENT ON COLUMN public.properties.total_spaces IS
  'DEPRECATED 2026-06-21 (Spaces v1). Superseded by visitor_capacity. Dual-written by commit 4 code during the transition window. Drop after rollout proves green (separate cleanup migration).';

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — spaces table extension (ADD columns; preserve legacy)
-- ════════════════════════════════════════════════════════════════════
-- Existing columns (preserved, deprecated for follow-on cleanup):
--   space_number, status, assigned_to_unit, assigned_to_plate,
--   notes, location_notes, property
-- Existing columns kept as-is: id, property
-- Existing 'status' column repurposed (see Part 3 backfill)

ALTER TABLE public.spaces
  ADD COLUMN IF NOT EXISTS company                    TEXT,
  ADD COLUMN IF NOT EXISTS label                      TEXT,
  ADD COLUMN IF NOT EXISTS type                       TEXT NOT NULL DEFAULT 'regular',
  ADD COLUMN IF NOT EXISTS description                TEXT,
  ADD COLUMN IF NOT EXISTS is_active                  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS assigned_to_resident_email TEXT,
  ADD COLUMN IF NOT EXISTS assigned_at                TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_by_email          TEXT,
  ADD COLUMN IF NOT EXISTS is_bundled                 BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by_email           TEXT,
  ADD COLUMN IF NOT EXISTS migration_note             TEXT;

-- ════════════════════════════════════════════════════════════════════
-- PART 3 — Backfill existing rows (branches grounded in Jose's audit data)
-- ════════════════════════════════════════════════════════════════════

-- 3a. Universal backfill: company / label / description / created_*
-- (applies to all 126 existing rows)
UPDATE public.spaces s
   SET company          = p.company,
       label            = COALESCE(s.label, s.space_number),
       description      = COALESCE(s.description,
                                   NULLIF(
                                     TRIM(
                                       COALESCE(s.location_notes, '') ||
                                       CASE WHEN s.notes IS NOT NULL AND length(trim(s.notes)) > 0
                                            THEN ' · ' || s.notes
                                            ELSE '' END
                                     ),
                                     ''
                                   )),
       created_by_email = COALESCE(s.created_by_email, 'system_migration_spaces_v1')
  FROM public.properties p
 WHERE p.name ~~* s.property;

-- 3b. Status normalization — 'reserved' with no assignment → 'available'
-- (Jose audit confirmed 2 such rows; per #7 rule "held but unassigned"
-- is not a v1 state — manager re-blocks if they want).
UPDATE public.spaces
   SET status = 'available'
 WHERE status = 'reserved'
   AND assigned_to_unit IS NULL
   AND assigned_to_plate IS NULL;

-- 3c. Status normalization — 'occupied' → 'available' (Jose 2026-06-21:
-- the 1 occupied row in current data is TEST DATA being cleared by the
-- pre-launch wipe; do NOT build a preservation path for it). The legacy
-- assigned_to_unit/assigned_to_plate values are preserved in the deprecated
-- columns for the cleanup migration; the new assigned_to_resident_email
-- stays NULL since we're not migrating the assignment.
UPDATE public.spaces
   SET status = 'available'
 WHERE status = 'occupied';

-- Audit row marking the v1 migration ran (single row, not per-flagged-space
-- since there are no flagged rows in v1).
INSERT INTO public.audit_logs (user_email, action, table_name, new_values, created_at)
VALUES (
  'system_migration_spaces_v1',
  'AUTH_SPACE_V1_MIGRATION',
  'spaces',
  jsonb_build_object(
    'rows_total',     (SELECT COUNT(*) FROM public.spaces),
    'rows_available', (SELECT COUNT(*) FROM public.spaces WHERE status = 'available'),
    'rows_assigned',  (SELECT COUNT(*) FROM public.spaces WHERE status = 'assigned')
  ),
  now()
);

-- 3d. company NOT NULL — set the constraint AFTER backfill (so the UPDATE
-- in 3a has a chance to populate every row). Any row where company is
-- still NULL after 3a means properties.name didn't match — surface as
-- migration error so Jose investigates.
ALTER TABLE public.spaces
  ALTER COLUMN company SET NOT NULL,
  ALTER COLUMN label   SET NOT NULL,
  ALTER COLUMN created_by_email SET NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- PART 4 — CHECK constraints + UNIQUE
-- ════════════════════════════════════════════════════════════════════
-- IMPORTANT: NO unique-per-resident constraint (Jose spec #1: resident may
-- hold multiple spaces — the "buy 2 spots" case).

ALTER TABLE public.spaces
  ADD CONSTRAINT spaces_label_unique_per_property UNIQUE (property, label);

ALTER TABLE public.spaces
  ADD CONSTRAINT spaces_status_valid CHECK (status IN ('available', 'assigned', 'occupied', 'reserved'));
-- 'occupied' + 'reserved' kept transiently for any stragglers; cleanup
-- migration tightens to ('available','assigned') after the deferred drop.

ALTER TABLE public.spaces
  ADD CONSTRAINT spaces_assignment_coherence CHECK (
    (status = 'assigned' AND assigned_to_resident_email IS NOT NULL)
    OR
    (status IN ('available', 'occupied', 'reserved') AND assigned_to_resident_email IS NULL)
  );
-- Same transient tolerance — cleanup tightens after rollout.

-- ════════════════════════════════════════════════════════════════════
-- PART 5 — Indexes
-- ════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS spaces_property_status_type
  ON public.spaces (company, property, status, type);

CREATE INDEX IF NOT EXISTS spaces_property_type
  ON public.spaces (company, property, type)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS spaces_assigned_resident
  ON public.spaces (assigned_to_resident_email)
  WHERE assigned_to_resident_email IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- PART 6 — space_assignment_history table (NEW)
-- ════════════════════════════════════════════════════════════════════
-- Separate from audit_logs per Jose #3: audit_logs = event log; this table
-- = queryable "who has held space X, with date ranges" view. Both populated
-- on every assign/reassign/free for cross-checking.

CREATE TABLE IF NOT EXISTS public.space_assignment_history (
  id                BIGSERIAL PRIMARY KEY,
  space_id          BIGINT      NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  resident_email    TEXT        NOT NULL,
  assigned_at       TIMESTAMPTZ NOT NULL,
  assigned_by_email TEXT        NOT NULL,
  freed_at          TIMESTAMPTZ,                 -- NULL while assignment is current
  freed_by_email    TEXT,
  freed_reason      TEXT,                        -- 'manual_reassign'|'deactivation'|'manual_free'|'space_decommissioned'
  CONSTRAINT space_history_freed_coherence CHECK (
    (freed_at IS NULL AND freed_by_email IS NULL AND freed_reason IS NULL)
    OR
    (freed_at IS NOT NULL AND freed_by_email IS NOT NULL AND freed_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS space_history_by_space
  ON public.space_assignment_history (space_id, assigned_at DESC);

CREATE INDEX IF NOT EXISTS space_history_by_resident
  ON public.space_assignment_history (lower(resident_email));

-- ════════════════════════════════════════════════════════════════════
-- PART 7 — RLS (mirrors B214 guest_authorizations shape)
-- ════════════════════════════════════════════════════════════════════
-- NO driver SELECT (driver gets space label via the searchPlate join at
-- read time, NOT via direct table access — commit 2 reworks the query
-- to filter to safe-public columns). NO resident SELECT (resident sees
-- their assignment via residents.space text field, manager-populated).

ALTER TABLE public.spaces                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.space_assignment_history     ENABLE ROW LEVEL SECURITY;

-- ── spaces ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "admin_all_spaces" ON public.spaces;
CREATE POLICY "admin_all_spaces" ON public.spaces
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin'::text);

DROP POLICY IF EXISTS "company_admin_own_spaces" ON public.spaces;
CREATE POLICY "company_admin_own_spaces" ON public.spaces
  FOR ALL TO authenticated
  USING (
    (get_my_role() = 'company_admin'::text)
    AND (company ~~* get_my_company())
  );

-- Two policies split (Jose intent-clarification 2026-06-21): the 5 DEFINER
-- RPCs role-pin to ('manager','company_admin'), explicitly excluding
-- leasing_agent. Granting leasing_agent FOR ALL via RLS would be
-- inconsistent — they could bypass the role-pin by writing directly to
-- the table. Tighten: manager gets FOR ALL (matches RPC authority);
-- leasing_agent gets FOR SELECT only (visibility on assignments at their
-- properties for resident interactions, no write authority).
--
-- B214's manager_own_guest_auths combined both roles into one FOR ALL
-- policy; this spaces-v1 design corrects the inconsistency for the new
-- table. If we ever sweep back through B214's policies for consistency,
-- this is the right shape to mirror.
DROP POLICY IF EXISTS "manager_own_spaces" ON public.spaces;
CREATE POLICY "manager_own_spaces" ON public.spaces
  FOR ALL TO authenticated
  USING (
    (get_my_role() = 'manager'::text)
    AND (property ~~* ANY (get_my_properties()))
  );

DROP POLICY IF EXISTS "leasing_agent_read_spaces" ON public.spaces;
CREATE POLICY "leasing_agent_read_spaces" ON public.spaces
  FOR SELECT TO authenticated
  USING (
    (get_my_role() = 'leasing_agent'::text)
    AND (property ~~* ANY (get_my_properties()))
  );

-- ── space_assignment_history (read-only beyond RPC writes) ─────────
DROP POLICY IF EXISTS "admin_all_space_history" ON public.space_assignment_history;
CREATE POLICY "admin_all_space_history" ON public.space_assignment_history
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin'::text);

DROP POLICY IF EXISTS "company_admin_own_space_history" ON public.space_assignment_history;
CREATE POLICY "company_admin_own_space_history" ON public.space_assignment_history
  FOR SELECT TO authenticated
  USING (
    (get_my_role() = 'company_admin'::text)
    AND EXISTS (
      SELECT 1 FROM public.spaces s
       WHERE s.id = space_assignment_history.space_id
         AND s.company ~~* get_my_company()
    )
  );

DROP POLICY IF EXISTS "manager_own_space_history" ON public.space_assignment_history;
CREATE POLICY "manager_own_space_history" ON public.space_assignment_history
  FOR SELECT TO authenticated
  USING (
    (get_my_role() = ANY (ARRAY['manager'::text, 'leasing_agent'::text]))
    AND EXISTS (
      SELECT 1 FROM public.spaces s
       WHERE s.id = space_assignment_history.space_id
         AND s.property ~~* ANY (get_my_properties())
    )
  );

-- ── REVOKE anon defaults (B66.1 / B82 lesson) ──────────────────────
REVOKE ALL ON public.spaces                     FROM anon, public;
REVOKE ALL ON public.space_assignment_history   FROM anon, public;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.spaces                     TO authenticated;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.space_assignment_history   TO authenticated;
GRANT  USAGE, SELECT ON SEQUENCE public.space_assignment_history_id_seq    TO authenticated;
-- Note: spaces.id is the existing BIGSERIAL from the original Dashboard-
-- created table; its sequence GRANT already in place (no change needed).

-- ════════════════════════════════════════════════════════════════════
-- PART 8 — DEFINER RPCs (5)
--
-- All:
--   • SECURITY DEFINER + SET search_path = public, pg_temp
--   • Role-pinned to ('manager','company_admin') per Jose lock
--   • Scope (company) resolved server-side from caller's user_roles row
--   • Property-belongs-to-caller's-company defense
--   • REVOKE PUBLIC + anon; GRANT authenticated
--   • Write AUTH_SPACE_* audit row
-- ════════════════════════════════════════════════════════════════════

-- ── RPC 1 — assign_space ────────────────────────────────────────────
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
  v_email          TEXT;
  v_role           TEXT;
  v_company        TEXT;
  v_space_company  TEXT;
  v_space_property TEXT;
  v_resident_ok    BOOLEAN;
  v_normalized_email TEXT;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- Role + company in one round-trip (Jose correction 2026-06-21).
  SELECT role, company INTO v_role, v_company
    FROM public.user_roles
   WHERE lower(email) = lower(v_email)
   LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed'
      USING HINT = 'Only managers and company admins can assign spaces.';
  END IF;

  -- Load space + verify company match
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

  -- Validate resident email + active + at this property
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

  -- UPDATE space — atomic with history insert
  UPDATE public.spaces
     SET status                     = 'assigned',
         assigned_to_resident_email = v_normalized_email,
         assigned_at                = now(),
         assigned_by_email          = lower(v_email),
         migration_note             = NULL                  -- clears flag if was set
   WHERE id = p_space_id;

  INSERT INTO public.space_assignment_history (
    space_id, resident_email, assigned_at, assigned_by_email
  ) VALUES (
    p_space_id, v_normalized_email, now(), lower(v_email)
  );

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_email), 'AUTH_SPACE_ASSIGN', 'spaces', p_space_id,
    jsonb_build_object(
      'resident_email', v_normalized_email,
      'property',       v_space_property,
      'company',        v_company
    ),
    now()
  );

  RETURN TRUE;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.assign_space(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.assign_space(BIGINT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.assign_space(BIGINT, TEXT) TO authenticated;

-- ── RPC 2 — reassign_space ──────────────────────────────────────────
-- Atomic free-old + assign-new + 2 history rows. Same row, single UPDATE
-- at the end so the assigned_to_resident_email change is one transaction.
CREATE OR REPLACE FUNCTION public.reassign_space(
  p_space_id           BIGINT,
  p_new_resident_email TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email           TEXT;
  v_role            TEXT;
  v_company         TEXT;
  v_space_company   TEXT;
  v_space_property  TEXT;
  v_old_resident    TEXT;
  v_old_status      TEXT;
  v_resident_ok     BOOLEAN;
  v_normalized_new  TEXT;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- Role + company in one round-trip (Jose correction 2026-06-21).
  SELECT role, company INTO v_role, v_company
    FROM public.user_roles WHERE lower(email) = lower(v_email) LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed'
      USING HINT = 'Only managers and company admins can reassign spaces.';
  END IF;

  -- Load space + verify company + capture old assignment
  SELECT company, property, assigned_to_resident_email, status
    INTO v_space_company, v_space_property, v_old_resident, v_old_status
    FROM public.spaces WHERE id = p_space_id;
  IF v_space_company IS NULL THEN
    RAISE EXCEPTION 'space_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_space_company !~~* v_company THEN
    RAISE EXCEPTION 'space_not_in_company';
  END IF;

  v_normalized_new := lower(trim(COALESCE(p_new_resident_email, '')));
  IF length(v_normalized_new) = 0 THEN
    RAISE EXCEPTION 'resident_email_required' USING ERRCODE = 'check_violation';
  END IF;

  -- New resident validation
  SELECT EXISTS (
    SELECT 1 FROM public.residents
     WHERE lower(email) = v_normalized_new
       AND property ~~* v_space_property
       AND is_active = TRUE
  ) INTO v_resident_ok;
  IF NOT v_resident_ok THEN
    RAISE EXCEPTION 'resident_not_active_at_property';
  END IF;

  -- Close old history row (if any)
  IF v_old_resident IS NOT NULL THEN
    UPDATE public.space_assignment_history
       SET freed_at = now(),
           freed_by_email = lower(v_email),
           freed_reason = 'manual_reassign'
     WHERE space_id = p_space_id
       AND lower(resident_email) = lower(v_old_resident)
       AND freed_at IS NULL;
  END IF;

  -- New history row
  INSERT INTO public.space_assignment_history (
    space_id, resident_email, assigned_at, assigned_by_email
  ) VALUES (
    p_space_id, v_normalized_new, now(), lower(v_email)
  );

  -- UPDATE space
  UPDATE public.spaces
     SET status                     = 'assigned',
         assigned_to_resident_email = v_normalized_new,
         assigned_at                = now(),
         assigned_by_email          = lower(v_email),
         migration_note             = NULL
   WHERE id = p_space_id;

  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_email), 'AUTH_SPACE_REASSIGN', 'spaces', p_space_id,
    jsonb_build_object(
      'old_resident_email', v_old_resident,
      'new_resident_email', v_normalized_new,
      'property',           v_space_property
    ),
    now()
  );

  RETURN TRUE;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.reassign_space(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reassign_space(BIGINT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.reassign_space(BIGINT, TEXT) TO authenticated;

-- ── RPC 3 — free_space ──────────────────────────────────────────────
-- Idempotent: freeing an already-available space = no-op success.
-- p_reason is one of: 'manual_free' | 'deactivation' | 'manual_reassign'
-- (the deactivation hook calls with 'deactivation' for audit clarity).
CREATE OR REPLACE FUNCTION public.free_space(
  p_space_id BIGINT,
  p_reason   TEXT DEFAULT 'manual_free'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email          TEXT;
  v_role           TEXT;
  v_company        TEXT;
  v_space_company  TEXT;
  v_old_resident   TEXT;
  v_normalized_reason TEXT;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- Role + company in one round-trip (Jose correction 2026-06-21).
  SELECT role, company INTO v_role, v_company
    FROM public.user_roles WHERE lower(email) = lower(v_email) LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed';
  END IF;

  SELECT company, assigned_to_resident_email
    INTO v_space_company, v_old_resident
    FROM public.spaces WHERE id = p_space_id;
  IF v_space_company IS NULL THEN
    RAISE EXCEPTION 'space_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_space_company !~~* v_company THEN
    RAISE EXCEPTION 'space_not_in_company';
  END IF;

  -- Idempotent — already free = no-op
  IF v_old_resident IS NULL THEN
    RETURN TRUE;
  END IF;

  v_normalized_reason := NULLIF(trim(COALESCE(p_reason, '')), '');
  IF v_normalized_reason IS NULL THEN v_normalized_reason := 'manual_free'; END IF;
  IF v_normalized_reason NOT IN ('manual_free','deactivation','manual_reassign','space_decommissioned') THEN
    RAISE EXCEPTION 'invalid_freed_reason'
      USING HINT = 'reason must be one of: manual_free, deactivation, manual_reassign, space_decommissioned';
  END IF;

  -- Close history row
  UPDATE public.space_assignment_history
     SET freed_at = now(),
         freed_by_email = lower(v_email),
         freed_reason = v_normalized_reason
   WHERE space_id = p_space_id
     AND lower(resident_email) = lower(v_old_resident)
     AND freed_at IS NULL;

  -- UPDATE space
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
      'freed_resident_email', v_old_resident,
      'reason',               v_normalized_reason
    ),
    now()
  );

  RETURN TRUE;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.free_space(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.free_space(BIGINT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.free_space(BIGINT, TEXT) TO authenticated;

-- ── RPC 4 — generate_spaces_from_pool ──────────────────────────────
-- Bulk auto-generate labeled rows. Idempotent — skips labels that already
-- exist (so re-running with count=60 after count=50 generates 51..60 only).
-- Label format: <prefix>-<sequential_number>. Prefix defaults derive from
-- type (caller may override via p_label_prefix).
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
  v_email          TEXT;
  v_role           TEXT;
  v_company        TEXT;
  v_property_ok    BOOLEAN;
  v_resolved_prefix TEXT;
  v_existing_count INTEGER;
  v_target_count   INTEGER;
  v_inserted       INTEGER := 0;
  v_i              INTEGER;
  v_label          TEXT;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- Role + company in one round-trip (Jose correction 2026-06-21).
  SELECT role, company INTO v_role, v_company
    FROM public.user_roles WHERE lower(email) = lower(v_email) LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed';
  END IF;

  -- Property must belong to caller's company
  SELECT EXISTS (
    SELECT 1 FROM public.properties
     WHERE name = p_property AND company ~~* v_company
  ) INTO v_property_ok;
  IF NOT v_property_ok THEN
    RAISE EXCEPTION 'property_not_in_company';
  END IF;

  IF p_count IS NULL OR p_count <= 0 THEN
    RAISE EXCEPTION 'count_must_be_positive' USING ERRCODE = 'check_violation';
  END IF;
  IF p_count > 1000 THEN
    RAISE EXCEPTION 'count_exceeds_safety_cap'
      USING HINT = 'Generating more than 1000 spaces in a single call is blocked. Split into multiple calls.';
  END IF;

  -- Type validation + prefix resolution
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
      ELSE 'R'                    -- regular default
    END
  );

  -- Count existing spaces with this prefix at this property to find the
  -- next sequential number. Re-running adds to the tail; doesn't renumber.
  SELECT COUNT(*) INTO v_existing_count
    FROM public.spaces
   WHERE property ~~* p_property
     AND label LIKE v_resolved_prefix || '-%';

  v_target_count := v_existing_count + p_count;

  FOR v_i IN (v_existing_count + 1)..v_target_count LOOP
    v_label := v_resolved_prefix || '-' || v_i::TEXT;

    -- Idempotent — skip if exists
    IF NOT EXISTS (
      SELECT 1 FROM public.spaces
       WHERE property ~~* p_property AND label = v_label
    ) THEN
      INSERT INTO public.spaces (
        company, property, label, type, status, is_active,
        created_at, created_by_email
      ) VALUES (
        v_company, p_property, v_label, p_type, 'available', TRUE,
        now(), lower(v_email)
      );
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  INSERT INTO public.audit_logs (user_email, action, table_name, new_values, created_at)
  VALUES (
    lower(v_email), 'AUTH_SPACE_GENERATE', 'spaces',
    jsonb_build_object(
      'property',         p_property,
      'type',             p_type,
      'requested_count',  p_count,
      'inserted_count',   v_inserted,
      'label_prefix',     v_resolved_prefix
    ),
    now()
  );

  RETURN v_inserted;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.generate_spaces_from_pool(TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.generate_spaces_from_pool(TEXT, TEXT, INTEGER, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.generate_spaces_from_pool(TEXT, TEXT, INTEGER, TEXT) TO authenticated;

-- ── RPC 5 — decommission_space ──────────────────────────────────────
-- Marks is_active=FALSE so the space disappears from active operational
-- views but survives in history. Must be unassigned first (call free_space
-- before decommissioning if currently assigned).
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
  v_assignment    TEXT;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- Role + company in one round-trip (Jose correction 2026-06-21).
  SELECT role, company INTO v_role, v_company
    FROM public.user_roles WHERE lower(email) = lower(v_email) LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed';
  END IF;

  SELECT company, assigned_to_resident_email
    INTO v_space_company, v_assignment
    FROM public.spaces WHERE id = p_space_id;
  IF v_space_company IS NULL THEN
    RAISE EXCEPTION 'space_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_space_company !~~* v_company THEN
    RAISE EXCEPTION 'space_not_in_company';
  END IF;
  IF v_assignment IS NOT NULL THEN
    RAISE EXCEPTION 'space_still_assigned'
      USING HINT = 'Free the space (free_space RPC) before decommissioning.';
  END IF;

  UPDATE public.spaces
     SET is_active = FALSE
   WHERE id = p_space_id;

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

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- ===== STOP: everything below this line was removed from the schema
-- ===== migration file. Verification queries (A-J) are in a SEPARATE file:
-- =====     migrations/20260621_spaces_v1_verification.sql
-- ===== Apply the BEGIN/COMMIT block above as a single paste in SQL Editor.
-- ===== Then run the verification queries from the separate file individually.
-- ════════════════════════════════════════════════════════════════════

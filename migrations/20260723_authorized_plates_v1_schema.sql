-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_authorized_plates_v1_schema.sql
-- ═══════════════════════════════════════════════════════════════════════
-- AP-SCHEMA — Authorized Plates v1 · schema + trigger + RLS + grants.
--
-- ── Purpose ────────────────────────────────────────────────────────────
-- Per-property standing authorization for staff, vendors, and
-- contractors who regularly park. A match renders as AUTHORIZED at
-- scan time (identical to an active resident). These vehicles REMAIN
-- FULLY ENFORCEABLE — they can be cited and towed like any other.
-- This is NOT tow protection (do_not_tow_plates is parked; see
-- COMMENT ON TABLE) and NOT visitor-pass quota exemption
-- (properties.exempt_plates is a different feature).
--
-- ── Four-commit arc, this is commit 1 of 4 ─────────────────────────────
-- Progressive inertness — data entry ships LAST so every earlier
-- commit is provably inert and each verifies in isolation:
--   1. AP-SCHEMA  (this)      — nothing writes to it
--   2. AP-CASCADE (next)      — table empty → branch 1.5 never fires
--   3. AP-DRIVER              — result type never returned
--   4. AP-MANAGE              — ← the switch that makes it live
-- Rollback in reverse order.
--
-- ── Design invariants (assertions in the verification file) ────────────
--   • Soft-delete-only, enforced by RLS policy coverage (no policy
--     covers DELETE) — belt and braces against a future "consistency"
--     grant of DELETE to authenticated. Learned from DNT-PARK's
--     load-bearing missing-grant paragraph that took multiple corrections
--     to state accurately. Nine policies total, none FOR ALL.
--   • Plate immutability — UPDATE that changes plate is refused at the
--     trigger. Editing a plate would orphan added_by/added_at from the
--     vehicle they describe. Changing a plate = remove + add.
--   • Removal is terminal — reactivating a removed row is refused;
--     re-authorizing creates a NEW row so history stays honest and
--     the partial unique index stays unambiguous.
--   • Server-side attribution — added_by / removed_by set from
--     auth.jwt() ->> 'email' by the trigger. RLS validates which rows
--     a caller may write, not what they put in the columns.
--   • Normalized plate on write — B2 spelling
--     (`[^A-Za-z0-9]` g, character-for-character). Trigger normalizes;
--     CHECK constraint rejects any row that escaped the trigger.
--   • Label capped at 80 chars — discourages narrative entries where
--     free-text PII arrives. Same reasoning as DNT reason cap.
--   • ON DELETE RESTRICT on property_id FK — matches soft-delete-only
--     philosophy. A property with authorized plates can't be deleted
--     without an explicit decision.
--   • No `is_active` boolean — single lifecycle field (removed_at IS
--     NULL), no drift class.
--   • No `company_id` column — derived via property_id join to
--     properties. Same shape as do_not_tow_plates.
--
-- ── Rollback ───────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS public.authorized_plates CASCADE;
--   DROP FUNCTION IF EXISTS public.authorized_plates_normalize_and_attribute();
-- (CASCADE drops indexes, triggers, and policies. Function has no
-- table dependency so it drops separately.)

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 1 — Table + CHECK constraints
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE public.authorized_plates (
  id             BIGSERIAL PRIMARY KEY,
  property_id    BIGINT NOT NULL REFERENCES public.properties(id) ON DELETE RESTRICT,
  plate          TEXT NOT NULL,
  label          TEXT,
  added_by       TEXT NOT NULL,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at     TIMESTAMPTZ,
  removed_by     TEXT,
  CONSTRAINT authorized_plates_soft_delete_pair
    CHECK (removed_at IS NULL OR removed_by IS NOT NULL),
  CONSTRAINT authorized_plates_plate_normalized
    CHECK (plate = UPPER(regexp_replace(plate, '[^A-Za-z0-9]', '', 'g'))),
  CONSTRAINT authorized_plates_plate_non_empty
    CHECK (plate <> ''),
  CONSTRAINT authorized_plates_label_length_cap
    CHECK (label IS NULL OR length(label) <= 80)
);

-- ══════════════════════════════════════════════════════════════════════
-- STEP 2 — COMMENT ON TABLE (persistent inline documentation)
-- ══════════════════════════════════════════════════════════════════════
COMMENT ON TABLE public.authorized_plates IS
  'Standing authorization — staff, vendors, and contractors who regularly park at a property. '
  'A match renders as Authorized at scan time, exactly as an active resident does. '
  'These vehicles REMAIN FULLY ENFORCEABLE — they can be cited and towed like any other. '
  'This is NOT tow protection (see do_not_tow_plates, parked) and NOT visitor-pass quota '
  'exemption (see properties.exempt_plates). Never merge or migrate between the three.';

-- ══════════════════════════════════════════════════════════════════════
-- STEP 3 — Single partial unique index on active rows
-- ══════════════════════════════════════════════════════════════════════
-- Prevents duplicate active authorization for the same plate at the
-- same property. Soft-deleted rows are excluded so re-authorization
-- after removal works (creates a new row, per no-reactivation rule).
-- Leading column property_id also serves point-lookups by property
-- (no separate property_id index needed — redundant write cost).
CREATE UNIQUE INDEX authorized_plates_property_plate_active_uidx
  ON public.authorized_plates (property_id, plate)
  WHERE removed_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 4 — Trigger function: normalize + attribute + immutability guards
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.authorized_plates_normalize_and_attribute()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
BEGIN
  -- ── Immutability guards (UPDATE only) ─────────────────────────────
  -- Comparison against OLD.plate uses the RAW input, before
  -- normalization below. Catches attempts to change plate even when
  -- the normalized result would be equivalent — user intent to change
  -- plate is signal, not noise. Plate change = remove + add.
  IF TG_OP = 'UPDATE' AND NEW.plate IS DISTINCT FROM OLD.plate THEN
    RAISE EXCEPTION 'plate is immutable — remove this row and add a new one'
      USING ERRCODE = 'check_violation',
            HINT    = 'Remove the existing authorization and add the corrected plate.';
  END IF;

  -- Removal is terminal. Reactivating a removed row is refused; the
  -- correct pattern is INSERT a new row. Keeps the audit history
  -- honest and the partial unique index unambiguous.
  IF TG_OP = 'UPDATE' AND OLD.removed_at IS NOT NULL AND NEW.removed_at IS NULL THEN
    RAISE EXCEPTION 'removed rows cannot be reactivated — add a new row instead'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── Normalize plate (INSERT effectively; UPDATE is no-op since
  --    plate immutability above rejects any change) ─────────────────
  NEW.plate := UPPER(regexp_replace(COALESCE(NEW.plate,''), '[^A-Za-z0-9]', '', 'g'));
  IF NEW.plate = '' THEN
    RAISE EXCEPTION 'plate empty after normalization'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── Server-side attribution (added_by / removed_by) ───────────────
  -- RLS validates which rows a caller may write, not what they put
  -- in the columns. Attribution MUST be server-set or a caller could
  -- write any string. COALESCE fallback allows service_role / probe
  -- contexts that seed data explicitly; RAISE catches the null case
  -- so context failure is raised rather than stored as NULL (the
  -- lying-message class).
  IF TG_OP = 'INSERT' THEN
    NEW.added_by := COALESCE(auth.jwt() ->> 'email', NEW.added_by);
    IF NEW.added_by IS NULL OR btrim(NEW.added_by) = '' THEN
      RAISE EXCEPTION 'added_by unresolvable — no email in JWT and no fallback provided'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL THEN
    NEW.removed_by := COALESCE(auth.jwt() ->> 'email', NEW.removed_by);
    IF NEW.removed_by IS NULL OR btrim(NEW.removed_by) = '' THEN
      RAISE EXCEPTION 'removed_by unresolvable — no email in JWT and no fallback provided'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$func$;

-- Trigger fires BEFORE INSERT OR UPDATE (not `OF plate`) so soft-delete
-- transitions (which touch removed_at, not plate) fire the trigger and
-- stamp removed_by server-side. tgattr empty = row-level trigger with
-- no column list = fires on any column change. Asserted by
-- AP.TRIGGER_SCOPE in the verification file.
CREATE TRIGGER authorized_plates_normalize_and_attribute_trigger
  BEFORE INSERT OR UPDATE ON public.authorized_plates
  FOR EACH ROW
  EXECUTE FUNCTION public.authorized_plates_normalize_and_attribute();

-- ══════════════════════════════════════════════════════════════════════
-- STEP 5 — RLS + 9 policies (admin split into 3 to preserve
--          soft-delete-only via policy coverage, not grant absence)
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.authorized_plates ENABLE ROW LEVEL SECURITY;

-- Admin: SELECT + INSERT + UPDATE only. Deliberately NOT FOR ALL —
-- DNT-PARK's load-bearing missing-DELETE-grant paragraph took several
-- corrections to state accurately because absence-of-grant was the
-- entire mechanism preventing admin hard-delete. Here, RLS itself
-- covers the invariant: no policy names DELETE for any role, so
-- DELETE is refused regardless of grants.
DROP POLICY IF EXISTS "ap_admin_select" ON public.authorized_plates;
CREATE POLICY "ap_admin_select" ON public.authorized_plates
  FOR SELECT TO authenticated
  USING (get_my_role() = 'admin');

DROP POLICY IF EXISTS "ap_admin_insert" ON public.authorized_plates;
CREATE POLICY "ap_admin_insert" ON public.authorized_plates
  FOR INSERT TO authenticated
  WITH CHECK (get_my_role() = 'admin');

DROP POLICY IF EXISTS "ap_admin_update" ON public.authorized_plates;
CREATE POLICY "ap_admin_update" ON public.authorized_plates
  FOR UPDATE TO authenticated
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

-- Manager: company + normalized-name scoped (B1 shape verbatim).
DROP POLICY IF EXISTS "ap_manager_select" ON public.authorized_plates;
CREATE POLICY "ap_manager_select" ON public.authorized_plates
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
         AND lower(trim(p.name)) IN (
               SELECT lower(trim(x)) FROM unnest(get_my_properties()) AS x
             )
    )
  );

DROP POLICY IF EXISTS "ap_manager_insert" ON public.authorized_plates;
CREATE POLICY "ap_manager_insert" ON public.authorized_plates
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
         AND lower(trim(p.name)) IN (
               SELECT lower(trim(x)) FROM unnest(get_my_properties()) AS x
             )
    )
  );

DROP POLICY IF EXISTS "ap_manager_update" ON public.authorized_plates;
CREATE POLICY "ap_manager_update" ON public.authorized_plates
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
         AND lower(trim(p.name)) IN (
               SELECT lower(trim(x)) FROM unnest(get_my_properties()) AS x
             )
    )
  )
  WITH CHECK (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
         AND lower(trim(p.name)) IN (
               SELECT lower(trim(x)) FROM unnest(get_my_properties()) AS x
             )
    )
  );

-- CA: company scoped (B1 shape verbatim, no ILIKE).
DROP POLICY IF EXISTS "ap_ca_select" ON public.authorized_plates;
CREATE POLICY "ap_ca_select" ON public.authorized_plates
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'company_admin'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
    )
  );

DROP POLICY IF EXISTS "ap_ca_insert" ON public.authorized_plates;
CREATE POLICY "ap_ca_insert" ON public.authorized_plates
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'company_admin'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
    )
  );

DROP POLICY IF EXISTS "ap_ca_update" ON public.authorized_plates;
CREATE POLICY "ap_ca_update" ON public.authorized_plates
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'company_admin'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
    )
  )
  WITH CHECK (
    get_my_role() = 'company_admin'
    AND property_id IN (
      SELECT p.id
        FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
    )
  );

-- ══════════════════════════════════════════════════════════════════════
-- STEP 6 — Grants (deny-by-default; sequence USAGE/SELECT explicit)
-- ══════════════════════════════════════════════════════════════════════
-- Per B1 grant discipline: no DELETE grant. RLS coverage above ALSO
-- refuses DELETE for any role — double invariant. If DELETE is ever
-- granted to authenticated for "consistency," RLS still refuses.
REVOKE ALL ON TABLE public.authorized_plates FROM PUBLIC;
REVOKE ALL ON TABLE public.authorized_plates FROM anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.authorized_plates TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.authorized_plates_id_seq TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 7 — SCHEMA_ audit (NOT EXISTS-guarded, safe to re-run)
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
SELECT
  'system_migration_v1',
  'SCHEMA_AUTHORIZED_PLATES_V1',
  'authorized_plates',
  NULL,
  jsonb_build_object(
    'migration', '20260723_authorized_plates_v1_schema',
    'purpose',   'AP-SCHEMA — Authorized Plates v1: per-property standing authorization table + trigger + 9 RLS policies + grants. Behaves like resident (rendering + enforcement); not tow protection; not quota exemption.',
    'commit',    'AP-SCHEMA (1 of 4 — CASCADE, DRIVER, MANAGE follow)',
    'inert_because', 'nothing writes to it — cascade branch 1.5 (AP-CASCADE) never fires with empty table; management UI (AP-MANAGE) ships last',
    'invariants', ARRAY[
      'soft-delete-only via policy coverage (no policy names DELETE — not dependent on grant absence)',
      'plate immutability (UPDATE that changes plate is refused at trigger)',
      'removal is terminal (reactivating removed row is refused)',
      'server-side attribution (added_by / removed_by from auth.jwt()->>email)',
      'plate normalized on write (B2 spelling: [^A-Za-z0-9] g)',
      'label capped at 80 chars (discourage narrative + PII)',
      'ON DELETE RESTRICT on property_id (matches soft-delete-only philosophy)'
    ],
    'nine_policies', ARRAY['ap_admin_select','ap_admin_insert','ap_admin_update',
                            'ap_manager_select','ap_manager_insert','ap_manager_update',
                            'ap_ca_select','ap_ca_insert','ap_ca_update'],
    'rollback',  'DROP TABLE IF EXISTS public.authorized_plates CASCADE; DROP FUNCTION IF EXISTS public.authorized_plates_normalize_and_attribute();'
  ),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_logs
   WHERE action = 'SCHEMA_AUTHORIZED_PLATES_V1'
     AND new_values->>'migration' = '20260723_authorized_plates_v1_schema'
);

COMMIT;

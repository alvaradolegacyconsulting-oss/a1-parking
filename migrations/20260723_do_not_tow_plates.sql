-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_do_not_tow_plates.sql
-- ═══════════════════════════════════════════════════════════════════════
-- DNT Commit 2 — Do Not Tow protected plates (schema only).
--
-- ── Why this exists ────────────────────────────────────────────────────
-- The existing exempt_plates capability (properties.exempt_plates TEXT[])
-- was misread as tow protection but only bypasses the annual visitor-
-- pass quota. Product owner Jose confirmed the real need — vehicles a
-- property must NEVER tow (maintenance, vendors, staff, owner's car,
-- contracted services) — is unmet.
--
-- This table is the storage for that new capability. Separate from
-- exempt_plates by design (different concept: quota bypass vs tow
-- authorization; different urgency: convenience vs liability; different
-- audit needs). Do NOT merge them.
--
-- ── Design decisions (per Mateo 2026-07-23 locked design) ──────────────
-- • Storage: table (not TEXT[] array on properties). Liability decision
--   needs attribution, reason, and history — none of which fit in a
--   text array.
-- • Soft delete via removed_at/removed_by. Preserves forensic trail:
--   "was this plate protected at scan time?" answerable years later.
--   Hard DELETE via any client role is forbidden (no DELETE policy).
-- • Scope: per-property. Company-wide scope is future work.
-- • Precedence in cascade (Commit 3): TOP — before resident match.
--   "Never tow" trumps every other cascade branch, including branches
--   that would render a towable result (pending vehicles).
-- • Expiry: nullable expires_at. NULL = permanent (staff). Timestamp =
--   temporary (vendor visit). Cascade lookup respects both.
-- • Reason: NOT NULL. Renders on the driver's screen alongside the
--   protection so the driver understands WHY.
-- • Roles: manager + company_admin can add/remove (via UPDATE for
--   removed_at soft-delete). Leasing agents cannot — liability
--   decision restricted to management. Admin has full access.
-- • Naming: "Do Not Tow" everywhere (table, columns, UI, driver
--   result, audit action). One name, one meaning, end-to-end.
--
-- ── Plate normalization ────────────────────────────────────────────────
-- Trigger normalizes NEW.plate on INSERT + UPDATE OF plate:
--   UPPER(regexp_replace(NEW.plate, '[^A-Za-z0-9]', '', 'g'))
-- Storing pre-normalized (rather than normalizing at query time) so
-- the cascade's branch-0 lookup (Commit 3) is a plain indexed equality
-- rather than a function call on every row. Matches existing pattern
-- of properties_name_trim_trigger + spaces_property_trim_trigger.
--
-- ── When this activates ────────────────────────────────────────────────
-- Table stays EMPTY until DNT Commit 5 ships (manager UI to add plates).
-- Commit 3 wires the cascade lookup. Commit 4 wires the driver UI.
-- Commit 5 wires the manager Settings surface. Ordering is deliberate:
-- data-entry ships LAST so no manager can enter data that doesn't do
-- anything (the inverse of the exempt_plates bug).

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 1 — Table
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.do_not_tow_plates (
  id            BIGSERIAL PRIMARY KEY,
  property_id   BIGINT NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  -- Plate: stored PRE-NORMALIZED by trigger (upper + alphanumeric only).
  -- Cascade branch-0 lookup uses plain equality against this indexed
  -- column — no runtime regex_replace per candidate row.
  plate         TEXT NOT NULL,
  -- Required. Renders on the driver's "DO NOT TOW" card. A bare
  -- "DO NOT TOW" without a reason invites second-guessing; a driver
  -- seeing "DO NOT TOW — Building maintenance contractor" understands.
  reason        TEXT NOT NULL,
  -- Attribution — who added this and when. Email of the manager/CA.
  added_by      TEXT NOT NULL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = permanent (staff, owner, ongoing vendor). Timestamp in the
  -- future = active until that moment. Cascade check:
  --   expires_at IS NULL OR expires_at > now()
  expires_at    TIMESTAMPTZ NULL,
  -- Soft delete. NULL = active. Set when a manager "removes" a plate.
  -- History preserved for forensic review.
  removed_at    TIMESTAMPTZ NULL,
  removed_by    TEXT NULL,
  -- Defensive CHECKs
  CONSTRAINT dnt_reason_nonempty CHECK (length(trim(reason)) > 0),
  CONSTRAINT dnt_added_by_nonempty CHECK (length(trim(added_by)) > 0)
);

COMMENT ON TABLE public.do_not_tow_plates IS
  'DNT — plates a property has authorized as never-tow. Cascade branch 0 (top precedence). Soft-delete via removed_at; hard DELETE forbidden by RLS.';

-- ══════════════════════════════════════════════════════════════════════
-- STEP 2 — Indexes
-- ══════════════════════════════════════════════════════════════════════
-- Partial unique: only ACTIVE (non-removed) rows unique per
-- (property, plate). Allows remove + re-add cycle without collision
-- while history persists.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dnt_property_plate_active
  ON public.do_not_tow_plates (property_id, plate)
  WHERE removed_at IS NULL;

-- Fast cascade lookup: (plate, property_id) filtered to non-removed.
-- Note: cannot include (expires_at IS NULL OR expires_at > now()) in
-- partial predicate — now() is STABLE not IMMUTABLE. Check applied
-- in query. Small table + point lookup → index still highly selective.
CREATE INDEX IF NOT EXISTS idx_dnt_plate_active
  ON public.do_not_tow_plates (plate, property_id)
  WHERE removed_at IS NULL;

-- Manager Settings UI query — list active DNT plates for a property.
CREATE INDEX IF NOT EXISTS idx_dnt_property_active
  ON public.do_not_tow_plates (property_id, added_at DESC)
  WHERE removed_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 3 — Plate normalization trigger
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.dnt_plate_normalize()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
BEGIN
  -- Same normalization the visitor-pass trigger + cascade RPCs use:
  -- uppercase, alphanumeric only. Guarantees indexed equality lookup
  -- from the cascade produces a hit regardless of caller-side formatting.
  NEW.plate := UPPER(regexp_replace(COALESCE(NEW.plate, ''), '[^A-Za-z0-9]', '', 'g'));
  IF NEW.plate = '' THEN
    RAISE EXCEPTION 'do_not_tow_plates.plate cannot be empty after normalization (only alphanumeric chars kept)'
      USING ERRCODE = '22004',
            HINT    = 'Provide a plate value containing at least one letter or digit.';
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS dnt_plate_normalize_trigger ON public.do_not_tow_plates;
CREATE TRIGGER dnt_plate_normalize_trigger
  BEFORE INSERT OR UPDATE OF plate ON public.do_not_tow_plates
  FOR EACH ROW
  EXECUTE FUNCTION public.dnt_plate_normalize();

-- ══════════════════════════════════════════════════════════════════════
-- STEP 4 — RLS
-- ══════════════════════════════════════════════════════════════════════
-- • Admin: full access.
-- • Manager: SELECT/INSERT/UPDATE scoped to properties the manager is
--   assigned to (via get_my_properties()).
-- • Company admin: same three verbs scoped to properties in the CA's
--   company (via get_my_company() ILIKE-match).
-- • Leasing agent: NO policy — cannot see or modify DNT. Liability
--   decision restricted to management.
-- • Anon: NO policy — default deny.
-- • NO DELETE policy anywhere. Managers "remove" a plate by setting
--   removed_at + removed_by via UPDATE. Hard DELETE forbidden even
--   for admin (via UI); if a hard-delete is ever needed (e.g., GDPR
--   erasure), it goes via service_role directly with an audit-logged
--   reason.
ALTER TABLE public.do_not_tow_plates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dnt_admin_all" ON public.do_not_tow_plates;
CREATE POLICY "dnt_admin_all" ON public.do_not_tow_plates
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

-- Manager SELECT — scoped by property assignment.
DROP POLICY IF EXISTS "dnt_manager_select" ON public.do_not_tow_plates;
CREATE POLICY "dnt_manager_select" ON public.do_not_tow_plates
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT id FROM public.properties WHERE name = ANY (get_my_properties())
    )
  );

-- Manager INSERT — must add plates only for their own properties.
DROP POLICY IF EXISTS "dnt_manager_insert" ON public.do_not_tow_plates;
CREATE POLICY "dnt_manager_insert" ON public.do_not_tow_plates
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT id FROM public.properties WHERE name = ANY (get_my_properties())
    )
  );

-- Manager UPDATE — used for soft delete (removed_at/removed_by) + edits.
DROP POLICY IF EXISTS "dnt_manager_update" ON public.do_not_tow_plates;
CREATE POLICY "dnt_manager_update" ON public.do_not_tow_plates
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT id FROM public.properties WHERE name = ANY (get_my_properties())
    )
  )
  WITH CHECK (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT id FROM public.properties WHERE name = ANY (get_my_properties())
    )
  );

-- CA SELECT — scoped by company.
DROP POLICY IF EXISTS "dnt_ca_select" ON public.do_not_tow_plates;
CREATE POLICY "dnt_ca_select" ON public.do_not_tow_plates
  FOR SELECT TO authenticated
  USING (
    get_my_role() = 'company_admin'
    AND property_id IN (
      SELECT id FROM public.properties WHERE company ILIKE get_my_company()
    )
  );

DROP POLICY IF EXISTS "dnt_ca_insert" ON public.do_not_tow_plates;
CREATE POLICY "dnt_ca_insert" ON public.do_not_tow_plates
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'company_admin'
    AND property_id IN (
      SELECT id FROM public.properties WHERE company ILIKE get_my_company()
    )
  );

DROP POLICY IF EXISTS "dnt_ca_update" ON public.do_not_tow_plates;
CREATE POLICY "dnt_ca_update" ON public.do_not_tow_plates
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'company_admin'
    AND property_id IN (
      SELECT id FROM public.properties WHERE company ILIKE get_my_company()
    )
  )
  WITH CHECK (
    get_my_role() = 'company_admin'
    AND property_id IN (
      SELECT id FROM public.properties WHERE company ILIKE get_my_company()
    )
  );

-- ══════════════════════════════════════════════════════════════════════
-- STEP 5 — Grants (per grant-remediation deny-by-default posture)
-- ══════════════════════════════════════════════════════════════════════
-- Grant remediation (2026-07-22) REVOKE'd anon+authenticated schema-
-- wide + ALTER DEFAULT PRIVILEGES revoked TABLES for future. Sequences
-- + functions defaults intentionally not revoked (they default-grant
-- to authenticated matching the blanket EXECUTE + USAGE pattern).
-- Sequence-defaults preservation is what post-fix commit 7de4ff9
-- explicitly reverted the initial 321a373 REVOKE for.
--
-- ── EXPLICIT GRANTS DISCIPLINE (Mateo 2026-07-23) ──────────────────
-- Post-remediation, EVERY new table's migration explicitly grants
-- everything it uses — table privileges AND sequence privileges.
-- Not because defaults are broken today, but because we are one
-- migration away from them being broken, and inheriting defaults
-- is exactly the class of bug the remediation exists to prevent.
-- Explicit grants for everything the table needs = never breaks.
-- (Convention codified in docs/development/migration-verification-template.md.)
--
-- For this new table:
-- • authenticated: SELECT + INSERT + UPDATE granted explicitly (client-
--   side manager + CA writes are the intended path, gated by RLS).
--   NO DELETE grant (hard delete forbidden by design).
-- • authenticated: sequence USAGE + SELECT granted explicitly (BIGSERIAL
--   default at INSERT time needs USAGE; RETURNING+currval paths need
--   SELECT). NOT inherited — explicit.
-- • anon: REVOKE ALL on table + sequence. Zero anon surface.
-- • service_role: untouched (bypasses grants + RLS).
GRANT SELECT, INSERT, UPDATE ON public.do_not_tow_plates TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.do_not_tow_plates_id_seq TO authenticated;
REVOKE ALL ON public.do_not_tow_plates FROM anon;
REVOKE ALL ON SEQUENCE public.do_not_tow_plates_id_seq FROM anon;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 6 — SCHEMA_ audit
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_DO_NOT_TOW_PLATES_TABLE',
  'do_not_tow_plates',
  NULL,
  jsonb_build_object(
    'migration', '20260723_do_not_tow_plates',
    'purpose',   'DNT Commit 2 — new tow-protection capability. Distinct from properties.exempt_plates (visitor-pass quota bypass). Cascade branch-0 (top precedence) landing in Commit 3; driver UI in Commit 4; manager UI in Commit 5.',
    'design',    'Table (not TEXT[] array): liability decision needs attribution + reason + history. Soft-delete via removed_at. Per-property scope. Plate normalized on write by trigger. Reason NOT NULL — renders on driver''s screen.',
    'rls',       'admin_all + manager/CA scoped SELECT/INSERT/UPDATE (property_id via get_my_properties() / get_my_company()). NO DELETE policy — hard delete forbidden even for admin; use service_role + audit for GDPR/erasure. Leasing agents excluded — liability decision.',
    'grants',    'authenticated: SELECT+INSERT+UPDATE (client-side writes intended). anon: none. Sequence USAGE inherited by default-privileges (grant remediation kept sequences default-grant).',
    'convention_codified', 'First new table since docs/development/migration-verification-template.md landed. VQ.GRANTS block adapted: authenticated I/U assertions commented out (intentional per this table''s write model) with WHY. All anon assertions kept.'
  ),
  now()
);

COMMIT;

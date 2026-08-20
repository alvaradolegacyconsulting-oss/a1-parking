-- ══════════════════════════════════════════════════════════════════════
-- 20260820_property_house_rules_v1.sql
--
-- House rules arc — Commit 1 of 4 (schema + trigger + history).
-- Origin: Jose Aug 20 (property policy in resident + CA views;
-- dispatcher use case for tow calls). Mateo Aug 20 design lock.
--
-- 🔴 NON-GOALS — LOAD-BEARING
--
--   ❌ Not a fourth plate concept. `CURRENT_STATE:480-482` records the
--      "never merge or migrate" invariant across exempt_plates,
--      authorized_plates, and do_not_tow_plates. house_rules is FREE
--      TEXT. No structured enforcement fields. No link to violation
--      reasons. It is a DOCUMENT, not a policy engine.
--   ❌ Not an enforcement input. Rules text does not drive any driver,
--      pm_plate_lookup, check_dnt_plate, or violation code path.
--   ❌ Not merged with resident bulletins (b148 backlog entry). Rules
--      are standing policy; bulletins are transient announcements.
--      Different lifecycles, different retention.
--   ❌ No acknowledgment in v1 (deferred; versioning here makes it
--      additive later per Mateo Aug 20).
--   ❌ Not on any driver surface. Ever.
--
-- ══════════════════════════════════════════════════════════════════════
-- SCHEMA ADDITIONS
-- ══════════════════════════════════════════════════════════════════════
--
-- Five columns on `properties`:
--   house_rules_text                 TEXT      NULL — the rules, NULL = unpublished
--   house_rules_version              INTEGER   NOT NULL DEFAULT 0 — monotonic, trigger-bumped
--   house_rules_effective_date       DATE      NULL — trigger-defaulted to today when text goes non-null
--   house_rules_updated_at           TIMESTAMPTZ NULL — trigger-stamped
--   house_rules_updated_by_email     TEXT      NULL — trigger-stamped from auth.jwt()->>email
--
-- One history table:
--   property_house_rules_versions — immutable audit of every text
--     change. Written ONLY by trigger; the resident/CA read path
--     continues to read the current text from `properties` (unchanged
--     query cost). History exists for "what were the rules on <date>"
--     queries — the Jose Aug 20 dispatcher case.
--
-- Two triggers on properties (BEFORE + AFTER UPDATE OF house_rules_text):
--   trg_house_rules_version — normalizes text, bumps version + stamps
--                             updated_at/by, defaults effective_date
--   trg_house_rules_history — inserts a history row on every version
--                             bump (including unpublish, so
--                             "the rules were cleared on <date>" is
--                             queryable)
--
-- ══════════════════════════════════════════════════════════════════════
-- DESIGN DECISIONS (Mateo Aug 20)
-- ══════════════════════════════════════════════════════════════════════
--
-- Version bumps on TEXT CHANGE ONLY (normalized: trim). A save that
-- doesn't change text preserves version + updated_at + updated_by —
-- residents don't see spurious "updated" indicators. Mateo's "populated
-- by every writer is not a constraint" rule applied: the trigger
-- (not the writer) is the authority, so any future write path
-- (bulk update, admin fix, direct SQL) can't skip this.
--
-- Effective date defaults to CURRENT_DATE at write time when the PM
-- doesn't set it explicitly. PM can set a future date for
-- notice-friendly workflow (Ch. 94 caveat). Default is today because
-- Jose Aug 20: "effective date will almost certainly be immediately."
-- Future-date is a PM-elected affordance, not an enforced default.
--
-- History table stores the NEW state at each transition (including
-- unpublish = NULL text). Rows are immutable; no UPDATE / DELETE
-- policies. RLS mirrors properties visibility (manager scoped, CA
-- scoped, admin all).
--
-- APPLY: Single database — Test Legacy is a tenant inside the
-- production database. Apply once; exercise + verify via the paired
-- verification file (v2 returns-rows pattern).
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- PART 1 — Columns on properties
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS house_rules_text             TEXT,
  ADD COLUMN IF NOT EXISTS house_rules_version          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS house_rules_effective_date   DATE,
  ADD COLUMN IF NOT EXISTS house_rules_updated_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS house_rules_updated_by_email TEXT;

COMMENT ON COLUMN public.properties.house_rules_text IS
  '2026-08-20 house-rules arc v1. Free-text property policy (PM-authored). NULL = never published or explicitly unpublished. Resident portal renders nothing when NULL (Jose Aug 20: optional, invisible when empty; no empty-state UI). Rides the property row the resident page already fetches — must NOT become a separate fetch (Mateo Aug 20 constraint: separate fetch failing would render nothing, indistinguishable from unpublished). 🔴 NEVER merge with exempt_plates / authorized_plates / do_not_tow_plates (see CURRENT_STATE:480-482); this is a document, not a policy engine.';

COMMENT ON COLUMN public.properties.house_rules_version IS
  'Monotonically-increasing counter. Bumped by trg_house_rules_version trigger ONLY when normalized (trim) text actually changes. 0 = never set. First save bumps to 1. Whitespace-only saves and effective-date-only edits do NOT bump. The trigger (not the writer) is the authority — populated-by-every-writer is not a constraint, so any future write path inherits the discipline.';

COMMENT ON COLUMN public.properties.house_rules_effective_date IS
  'Date the current text becomes/became effective. Defaults to CURRENT_DATE at trigger time if not explicitly set on the UPDATE. PM can set a future date for Ch. 94 notice-friendly workflow — editor help text should prompt for this when applicable. NULL when house_rules_text is NULL (never published).';

COMMENT ON COLUMN public.properties.house_rules_updated_at IS
  'Timestamptz of last text-change save. Set by trigger from now(). Same population discipline as version: whitespace-only saves preserve OLD value.';

COMMENT ON COLUMN public.properties.house_rules_updated_by_email IS
  'Email of the manager who last saved. Set by trigger from auth.jwt() ->> ''email'' (lowered + trimmed). Preserved on whitespace-only saves.';

-- ══════════════════════════════════════════════════════════════════════
-- PART 2 — History table
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.property_house_rules_versions (
  id                 BIGSERIAL PRIMARY KEY,
  property_id        BIGINT      NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  version            INTEGER     NOT NULL,
  text               TEXT,       -- nullable: NULL row represents an "unpublish" transition
  effective_date     DATE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_email   TEXT
);

CREATE INDEX IF NOT EXISTS property_house_rules_versions_property_lookup
  ON public.property_house_rules_versions (property_id, version DESC);

CREATE INDEX IF NOT EXISTS property_house_rules_versions_property_effective
  ON public.property_house_rules_versions (property_id, effective_date DESC);

COMMENT ON TABLE public.property_house_rules_versions IS
  '2026-08-20 house-rules arc v1 — immutable history of house_rules text changes on properties. Written ONLY by trg_house_rules_history trigger on properties UPDATE. Rows are the source of truth for "what were the rules on <date>" — dispatcher use case (Jose Aug 20: tow call, dispatcher cites the rule text that was in force on the tow date). No UI in v1; queried on demand. Every version-bump inserts a row, including the unpublish transition (text=NULL) so "the rules were cleared on <date>" is also queryable. Rows never mutate; no UPDATE/DELETE policies below.';

COMMENT ON COLUMN public.property_house_rules_versions.text IS
  'Text as saved at this version. NULL when the version was an "unpublish" transition (PM cleared house_rules_text on the property row). A NULL row here means "no rules in force from effective_date until the next row for this property."';

-- ══════════════════════════════════════════════════════════════════════
-- PART 3 — RLS on history table (mirrors properties visibility)
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE public.property_house_rules_versions ENABLE ROW LEVEL SECURITY;

-- Managers + leasing agents see history for their scoped properties.
DROP POLICY IF EXISTS manager_select_house_rules_versions ON public.property_house_rules_versions;
CREATE POLICY manager_select_house_rules_versions ON public.property_house_rules_versions
  FOR SELECT TO public
  USING (
    (get_my_role() = ANY(ARRAY['manager', 'leasing_agent']))
    AND EXISTS (
      SELECT 1 FROM public.properties p
       WHERE p.id = property_house_rules_versions.property_id
         AND p.name ~~* ANY(get_my_properties())
    )
  );

-- CAs see history for their company's properties.
DROP POLICY IF EXISTS ca_select_house_rules_versions ON public.property_house_rules_versions;
CREATE POLICY ca_select_house_rules_versions ON public.property_house_rules_versions
  FOR SELECT TO public
  USING (
    get_my_role() = 'company_admin'
    AND EXISTS (
      SELECT 1 FROM public.properties p
       WHERE p.id = property_house_rules_versions.property_id
         AND lower(trim(p.company)) = lower(trim(COALESCE(get_my_company(), '')))
    )
  );

-- Admins see all.
DROP POLICY IF EXISTS admin_all_house_rules_versions ON public.property_house_rules_versions;
CREATE POLICY admin_all_house_rules_versions ON public.property_house_rules_versions
  FOR ALL TO public
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

-- NO INSERT / UPDATE / DELETE policies for non-admin roles. History is
-- trigger-populated only. Direct-write attempts from the app fail RLS.

GRANT SELECT ON public.property_house_rules_versions TO authenticated;
REVOKE ALL ON public.property_house_rules_versions FROM anon;

-- ══════════════════════════════════════════════════════════════════════
-- PART 4 — BEFORE UPDATE trigger: normalize + version bump + stamps
-- ══════════════════════════════════════════════════════════════════════
--
-- Fires only when house_rules_text is in the UPDATE's SET list. Compares
-- normalized OLD vs NEW; if unchanged, preserves version/updated_at/by
-- from OLD (whitespace-only saves and effective-date-only edits don't
-- bump). Otherwise: bumps version, stamps updated_at + updated_by,
-- defaults effective_date to CURRENT_DATE if not explicitly set.
--
-- 🔴 NULL-safe comparison via IS [NOT] DISTINCT FROM (Mateo Aug 19
-- Finding B rule for trigger predicates). NULLIF(trim(...), '') handles
-- both "empty string" and "whitespace-only" as equivalent to NULL for
-- change detection.

CREATE OR REPLACE FUNCTION public.trg_fn_house_rules_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_normalized_old TEXT;
  v_normalized_new TEXT;
BEGIN
  v_normalized_old := NULLIF(trim(OLD.house_rules_text), '');
  v_normalized_new := NULLIF(trim(NEW.house_rules_text), '');

  -- No text change → preserve version + stamps. effective_date passes
  -- through so PM can edit that field without triggering a version bump.
  IF v_normalized_new IS NOT DISTINCT FROM v_normalized_old THEN
    NEW.house_rules_version          := OLD.house_rules_version;
    NEW.house_rules_updated_at       := OLD.house_rules_updated_at;
    NEW.house_rules_updated_by_email := OLD.house_rules_updated_by_email;
    RETURN NEW;
  END IF;

  -- Text changed. Bump + stamp.
  NEW.house_rules_version          := COALESCE(OLD.house_rules_version, 0) + 1;
  NEW.house_rules_updated_at       := now();
  NEW.house_rules_updated_by_email := NULLIF(lower(trim(COALESCE(auth.jwt() ->> 'email', ''))), '');

  -- Default effective_date to today when PM didn't set it explicitly.
  IF NEW.house_rules_effective_date IS NULL AND v_normalized_new IS NOT NULL THEN
    NEW.house_rules_effective_date := CURRENT_DATE;
  END IF;

  -- Unpublish transition: clear effective_date so state is consistent
  -- (no text → no effective date).
  IF v_normalized_new IS NULL THEN
    NEW.house_rules_effective_date := NULL;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_fn_house_rules_version() IS
  '2026-08-20 house-rules v1. BEFORE UPDATE OF house_rules_text on properties. Normalizes text (trim + NULLIF empty), compares OLD vs NEW via IS DISTINCT FROM (NULL-safe). Version bumps + stamps only on actual text change; whitespace-only and effective-date-only edits preserve OLD version/updated_at/by. Effective_date defaults to CURRENT_DATE on publish, clears on unpublish. Authority for version discipline (Mateo Aug 20: populated-by-every-writer is not a constraint).';

DROP TRIGGER IF EXISTS trg_house_rules_version ON public.properties;
CREATE TRIGGER trg_house_rules_version
  BEFORE UPDATE OF house_rules_text ON public.properties
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_house_rules_version();

-- ══════════════════════════════════════════════════════════════════════
-- PART 5 — AFTER UPDATE trigger: history insert on version bump
-- ══════════════════════════════════════════════════════════════════════
--
-- Fires after the BEFORE trigger above. Detects the bump via version
-- change (IS DISTINCT FROM). Inserts a history row with NEW text
-- (nullable — an unpublish transition inserts a NULL-text row so the
-- "when did they clear the rules" query is answerable).

CREATE OR REPLACE FUNCTION public.trg_fn_house_rules_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Only insert on actual version bump (BEFORE trigger set the shape).
  IF NEW.house_rules_version IS DISTINCT FROM OLD.house_rules_version THEN
    INSERT INTO public.property_house_rules_versions (
      property_id,
      version,
      text,
      effective_date,
      created_by_email
    ) VALUES (
      NEW.id,
      NEW.house_rules_version,
      NEW.house_rules_text,
      NEW.house_rules_effective_date,
      NEW.house_rules_updated_by_email
    );
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_fn_house_rules_history() IS
  '2026-08-20 house-rules v1. AFTER UPDATE OF house_rules_text on properties. Inserts one row into property_house_rules_versions on each version bump. Detects bump via NEW.house_rules_version IS DISTINCT FROM OLD (paired with trg_fn_house_rules_version which is the sole authority for bumping). Inserts NULL-text rows for unpublish transitions so history is complete.';

DROP TRIGGER IF EXISTS trg_house_rules_history ON public.properties;
CREATE TRIGGER trg_house_rules_history
  AFTER UPDATE OF house_rules_text ON public.properties
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_fn_house_rules_history();

-- ══════════════════════════════════════════════════════════════════════
-- PART 6 — Schema audit row
-- ══════════════════════════════════════════════════════════════════════

INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_PROPERTY_HOUSE_RULES_V1',
  'public.properties + public.property_house_rules_versions',
  'house_rules',
  jsonb_build_object(
    'migration',      '20260820_property_house_rules_v1',
    'commit',         '1 of 4 (schema + trigger + history)',
    'columns_added',  jsonb_build_array(
      'house_rules_text',
      'house_rules_version',
      'house_rules_effective_date',
      'house_rules_updated_at',
      'house_rules_updated_by_email'
    ),
    'history_table',  'property_house_rules_versions',
    'triggers',       jsonb_build_array(
      'trg_house_rules_version (BEFORE)',
      'trg_house_rules_history (AFTER)'
    ),
    'design_decisions', jsonb_build_object(
      'version_bump',    'on normalized text change only',
      'effective_date',  'defaults to CURRENT_DATE, editable, accepts future',
      'ca_access',       'view-only in v1',
      'acknowledgment',  'deferred; versioning is the prerequisite'
    ),
    'non_goals', jsonb_build_array(
      'not a fourth plate concept',
      'not an enforcement input',
      'not merged with resident bulletins',
      'no acknowledgment in v1',
      'no driver surface ever'
    )
  )
);

COMMIT;

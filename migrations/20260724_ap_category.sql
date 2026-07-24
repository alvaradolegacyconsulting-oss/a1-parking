-- ═══════════════════════════════════════════════════════════════════════
-- 20260724_ap_category.sql
-- ═══════════════════════════════════════════════════════════════════════
-- AP-CATEGORY — add `category` column to authorized_plates + return it
-- role-conditional from check_authorized_plate.
--
-- ── Design (Mateo 2026-07-24) ─────────────────────────────────────────
-- Three values: 'staff' · 'vendor' · 'other'. Not a binary. Reducible
-- to binary on Jose's word; adding a value later is a one-line CHECK
-- change while collapsing one isn't. "Non-staff" is a negative category
-- that answers no downstream query — three positive values give the
-- staff-vs-rest split AND future analytics.
--
-- DEFAULT 'staff' backfills the two existing test rows (TESTAP, TESTAP2).
-- TESTAP2 ("Selena's Car") will be inaccurate — test data, not worth a
-- migration to correct.
--
-- ── Portal-only, like the label ───────────────────────────────────────
-- check_authorized_plate returns category with the SAME role-conditional
-- CASE as label — portal roles (manager/leasing_agent/CA/admin) get the
-- string; drivers + others get NULL. Category would be SAFE to show
-- drivers (fixed values, no free-text PII risk) and is the escalation
-- signal Jose originally wanted before the label reversal — but he
-- hasn't asked for it, and it changes the driver card. Left symmetric
-- with label for now; one-line CASE change if wanted later.
--
-- ── Not touched here ──────────────────────────────────────────────────
-- pm_plate_lookup NOT modified. It calls check_authorized_plate and
-- extracts only is_authorized + property_name + label; category is
-- unused by that caller. Manager Plate Lookup tab can be extended
-- later if category needs to surface there. AP-UI-REFINE's manager
-- Authorized Plates tab reads `authorized_plates` directly (not via
-- pm_plate_lookup), so the column is directly available to that surface.
--
-- ── Pre-apply state (negative controls — RUN THIS TIME) ───────────────
-- Validated-detector count has been stuck at 2 all week because AP-SCHEMA
-- + AP-CASCADE-DB pre-apply passes were skipped. Move it to 3+:
--
--   AP.CATEGORY_COLUMN     — expect FAIL pre-apply (column doesn't exist)
--   AP.CATEGORY_CHECK      — expect FAIL pre-apply (constraint doesn't exist)
--   AP.RPC_CATEGORY_ROLE   — expect FAIL pre-apply (RPC returns no category)
--   AP.AUDIT               — expect FAIL pre-apply
--
-- Silent post-apply then means the fix landed AND the detectors are
-- validated for the AP-CATEGORY commit.
--
-- ── Rollback ──────────────────────────────────────────────────────────
--   ALTER TABLE public.authorized_plates DROP CONSTRAINT authorized_plates_category_valid;
--   ALTER TABLE public.authorized_plates DROP COLUMN category;
--   [Re-apply check_authorized_plate from 20260723_ap_cascade_check_authorized_plate.sql:96-190]
--
-- AP-SCHEMA verification file (20260723_authorized_plates_v1_schema_verification.sql)
-- extended AP.CHECKS expected set from 4 to 5 constraints — same commit.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 1 — Add category column + CHECK constraint
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.authorized_plates
  ADD COLUMN category TEXT NOT NULL DEFAULT 'staff';

ALTER TABLE public.authorized_plates
  ADD CONSTRAINT authorized_plates_category_valid
  CHECK (category IN ('staff','vendor','other'));

-- ══════════════════════════════════════════════════════════════════════
-- STEP 2 — check_authorized_plate: return category (role-conditional)
-- ══════════════════════════════════════════════════════════════════════
-- Body byte-identical to
-- 20260723_ap_cascade_check_authorized_plate.sql:96-186 EXCEPT:
--   (a) DECLARE gains v_category TEXT
--   (b) SELECT gains ap.category
--   (c) All 4 early NULL returns gain 'category': NULL
--   (d) Final RETURN gains 'category' with same role-conditional CASE
--       as label.
CREATE OR REPLACE FUNCTION public.check_authorized_plate(
  p_plate    TEXT,
  p_property TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_normalized     TEXT;
  v_role           TEXT;
  v_email          TEXT;
  v_authorized_p   BIGINT;
  v_property_name  TEXT;
  v_label          TEXT;
  v_category       TEXT;             -- NEW (AP-CATEGORY)
  v_is_authorized  BOOLEAN;
BEGIN
  IF p_plate IS NULL THEN
    RETURN jsonb_build_object('is_authorized', false, 'property_id', NULL, 'property_name', NULL, 'label', NULL, 'category', NULL);
  END IF;

  v_email := auth.jwt() ->> 'email';
  IF v_email IS NULL THEN
    RETURN jsonb_build_object('is_authorized', false, 'property_id', NULL, 'property_name', NULL, 'label', NULL, 'category', NULL);
  END IF;

  v_role := get_my_role();
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('is_authorized', false, 'property_id', NULL, 'property_name', NULL, 'label', NULL, 'category', NULL);
  END IF;

  v_normalized := UPPER(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'));
  IF v_normalized = '' THEN
    RETURN jsonb_build_object('is_authorized', false, 'property_id', NULL, 'property_name', NULL, 'label', NULL, 'category', NULL);
  END IF;

  -- ── Role-scoped lookup ────────────────────────────────────────────
  SELECT ap.property_id, ap_p.name, ap.label, ap.category
    INTO v_authorized_p, v_property_name, v_label, v_category
  FROM public.authorized_plates ap
  JOIN public.properties ap_p ON ap_p.id = ap.property_id
  WHERE ap.plate = v_normalized
    AND ap.removed_at IS NULL
    AND (p_property IS NULL
         OR lower(trim(ap_p.name)) = lower(trim(p_property)))
    AND (
      v_role = 'admin'
      OR (v_role IN ('manager','leasing_agent')
          AND lower(trim(ap_p.name)) IN (
                SELECT lower(trim(x)) FROM unnest(get_my_properties()) AS x
              )
          AND lower(trim(ap_p.company)) = lower(trim(get_my_company())))
      OR (v_role = 'driver'
          AND EXISTS (
            SELECT 1
              FROM public.drivers d
              CROSS JOIN LATERAL unnest(d.assigned_properties) AS prop
             WHERE lower(d.email)    = lower(v_email)
               AND lower(trim(prop)) = lower(trim(ap_p.name))
          )
          AND lower(trim(ap_p.company)) = lower(trim(get_my_company())))
      OR (v_role = 'company_admin'
          AND lower(trim(ap_p.company)) = lower(trim(get_my_company())))
    )
  ORDER BY ap.added_at ASC
  LIMIT 1;

  -- Capture is_authorized from row-existence BEFORE label + category
  -- suppression. Analogous to B2's v_is_dnt fix — a suppressed field
  -- must not flip is_authorized to false. Role suppression touches only
  -- the returned label/category fields, never the boolean.
  v_is_authorized := v_authorized_p IS NOT NULL;

  RETURN jsonb_build_object(
    'is_authorized', v_is_authorized,
    'property_id',   v_authorized_p,
    'property_name', v_property_name,
    'label',         CASE
                       WHEN v_role IN ('manager','leasing_agent','company_admin','admin')
                         THEN v_label
                       ELSE NULL   -- default-deny: driver + others get status only
                     END,
    'category',      CASE
                       WHEN v_role IN ('manager','leasing_agent','company_admin','admin')
                         THEN v_category
                       ELSE NULL   -- portal-only, same treatment as label
                     END
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.check_authorized_plate(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_authorized_plate(TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.check_authorized_plate(TEXT, TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- STEP 3 — SCHEMA_ audit (NOT EXISTS-guarded, safe to re-run)
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
SELECT
  'system_migration_v1',
  'SCHEMA_AP_CATEGORY',
  'authorized_plates',
  NULL,
  jsonb_build_object(
    'migration', '20260724_ap_category',
    'purpose',   'AP-CATEGORY — add category column (staff/vendor/other) '
              || 'to authorized_plates + return role-conditional from '
              || 'check_authorized_plate. Portal-only, symmetric with label.',
    'values',    ARRAY['staff','vendor','other'],
    'default',   'staff (backfills existing rows; TESTAP2 will be inaccurate — test data)',
    'not_touched', 'pm_plate_lookup — extends check_authorized_plate return but pm_plate_lookup does not currently extract category. Extend when a caller needs it.',
    'ap_schema_verification', 'AP.CHECKS expected set extended from 4 to 5 constraints (same commit)',
    'rollback',  'ALTER TABLE ... DROP CONSTRAINT authorized_plates_category_valid; ALTER TABLE ... DROP COLUMN category; re-apply check_authorized_plate from 20260723_ap_cascade_check_authorized_plate.sql:96-190'
  ),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_logs
   WHERE action = 'SCHEMA_AP_CATEGORY'
     AND new_values->>'migration' = '20260724_ap_category'
);

COMMIT;

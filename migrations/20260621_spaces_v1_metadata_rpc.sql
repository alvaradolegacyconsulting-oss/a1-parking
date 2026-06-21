-- Spaces v1 — update_space_metadata DEFINER RPC (sibling to the 5 RPCs in
-- 20260621_spaces_v1_schema.sql; ships with commit 3 of the Spaces v1 build).
--
-- ORIGIN
--   Commit 1 (5f43df7-pre, applied 2026-06-21) shipped 5 RPCs for the
--   write-mutations: assign / reassign / free / generate / decommission.
--   The legacy saveSpace() in the manager portal also wrote directly to
--   `spaces` via RLS to edit per-space label, description, type, and
--   bundled flag — that's the B225-class direct-table write the new
--   RPC-only discipline removes. Adding update_space_metadata as a 6th
--   RPC keeps ALL writes symmetric: every mutation flows through DEFINER
--   role-pin + company-from-session + property-belongs-to-company defense
--   + audit_logs row. No direct table writes from the manager Spaces tab.
--
-- CLEAN-RAISE on UNIQUE(property, label) COLLISION
--   The commit-1 schema enforces UNIQUE(property, label). A naïve UPDATE
--   on label would surface raw `unique_violation` / `duplicate key value
--   violates unique constraint "spaces_label_unique_per_property"` to the
--   user — Postgres-speak, not actionable. This RPC catches the
--   unique_violation inside a nested BEGIN/END and re-raises as
--   `label_already_exists` with a USING HINT pointing at the colliding
--   label, mirroring decommission_space's `space_still_assigned` shape.
--   Same friendly-error-shape convention the manager UI can match on.
--
-- ALL-FIELDS-REQUIRED contract
--   Caller passes the CURRENT value for any field they're not changing.
--   Simpler than COALESCE-nullable pattern (which can't distinguish "skip
--   field" from "set to empty"). The UI loads the space, edits in modal,
--   submits all 4 fields. Validates each.

BEGIN;

CREATE OR REPLACE FUNCTION public.update_space_metadata(
  p_space_id    BIGINT,
  p_label       TEXT,
  p_description TEXT,
  p_type        TEXT,
  p_is_bundled  BOOLEAN
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
  v_old_label      TEXT;
  v_normalized_label       TEXT;
  v_normalized_description TEXT;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- Role + company in one round-trip (matches the 5 other RPCs).
  SELECT role, company INTO v_role, v_company
    FROM public.user_roles WHERE lower(email) = lower(v_email) LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed'
      USING HINT = 'Only managers and company admins can edit space metadata.';
  END IF;

  -- Load space + verify company + capture old label (for audit + error context)
  SELECT company, label
    INTO v_space_company, v_old_label
    FROM public.spaces WHERE id = p_space_id;
  IF v_space_company IS NULL THEN
    RAISE EXCEPTION 'space_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_space_company !~~* v_company THEN
    RAISE EXCEPTION 'space_not_in_company'
      USING HINT = 'The space does not belong to your company.';
  END IF;

  -- Field validations (all-required contract; null/empty → raise).
  v_normalized_label := NULLIF(trim(COALESCE(p_label, '')), '');
  IF v_normalized_label IS NULL THEN
    RAISE EXCEPTION 'label_required'
      USING HINT = 'label cannot be empty.';
  END IF;

  IF p_type IS NULL OR p_type NOT IN ('regular','carport','garage','covered','handicap','employee') THEN
    RAISE EXCEPTION 'invalid_type'
      USING HINT = 'type must be one of: regular, carport, garage, covered, handicap, employee';
  END IF;

  IF p_is_bundled IS NULL THEN
    RAISE EXCEPTION 'is_bundled_required'
      USING HINT = 'is_bundled must be TRUE or FALSE (not null).';
  END IF;

  -- description normalization: '' → NULL (don't store empty strings;
  -- match the migration's NULLIF backfill convention)
  v_normalized_description := NULLIF(trim(COALESCE(p_description, '')), '');

  -- ── UPDATE in a protected block so UNIQUE(property,label) raises
  --    a CLEAN label_already_exists instead of the raw constraint error.
  BEGIN
    UPDATE public.spaces
       SET label       = v_normalized_label,
           description = v_normalized_description,
           type        = p_type,
           is_bundled  = p_is_bundled
     WHERE id = p_space_id;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'label_already_exists'
        USING HINT = 'Another space at this property already uses label "' || v_normalized_label || '". Labels must be unique per property.';
  END;

  -- Audit row (mirrors AUTH_SPACE_* convention from the 5 other RPCs).
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_email),
    'AUTH_SPACE_UPDATE_METADATA',
    'spaces',
    p_space_id,
    jsonb_build_object(
      'old_label',   v_old_label,
      'new_label',   v_normalized_label,
      'type',        p_type,
      'is_bundled',  p_is_bundled,
      'description_set', v_normalized_description IS NOT NULL,
      'company',     v_company
    ),
    now()
  );

  RETURN TRUE;
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.update_space_metadata(BIGINT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_space_metadata(BIGINT, TEXT, TEXT, TEXT, BOOLEAN) FROM anon;
GRANT  EXECUTE ON FUNCTION public.update_space_metadata(BIGINT, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- ===== STOP: verification queries are in a SEPARATE file:
-- =====     migrations/20260621_spaces_v1_metadata_rpc_verification.sql
-- ===== Apply the BEGIN/COMMIT block above as a single paste in SQL Editor.
-- ===== Then run the verification queries from the separate file individually.
-- ════════════════════════════════════════════════════════════════════

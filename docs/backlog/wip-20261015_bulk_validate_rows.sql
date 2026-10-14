-- ════════════════════════════════════════════════════════════════════
-- PHASE A — bulk_validate_rows: the four checks only the database knows
-- ════════════════════════════════════════════════════════════════════
-- The validator's field-level checks (required columns, email shape,
-- unit shape, plate length, plate state, duplicates inside the file,
-- conflicting identity) are pure and run in the route. These four are
-- not: they are about what is already in the database.
--
--   plate already active at THIS property
--   plate already active at another property OF THE SAME COMPANY
--   plate prohibited at this property
--   a resident with this email already on file at this property
--
-- 🔴 ONE CALL, SET-BASED. A 1,000-row file must not become 4,000
-- round trips. jsonb_to_recordset turns the file into a relation and
-- every check is a join against it.
--
-- 🔴 THIS IS WHY THE RPC EXISTS AT ALL: public.normalize_plate().
-- The validator must call the database's own normalizer, never a
-- TypeScript copy of it. vehicles_plate_norm_uniq is an EXPRESSION
-- INDEX over that function, and the function's comment warns that
-- changing its body requires a REINDEX of every dependent index. The
-- validator's job is to predict what that index will do to the load, so
-- a second implementation of the key would be predicting the wrong
-- thing the moment either side moved. Both normalizers agree today —
-- they strip every non-alphanumeric, so 'ABC 1234', 'ABC-1234' and
-- 'ABC1234' are one plate — and the point is that they cannot drift.
--
-- 🔴 AND WHY THE PREDICATES ARE COPIED FROM THE INDEX, NOT WRITTEN
-- FRESH. The "already active" check mirrors
--   vehicles_plate_norm_uniq ON vehicles (normalize_plate(plate), property)
--   WHERE is_active = true AND status IN ('active','under_review')
-- exactly, including the property TEXT equality and 'under_review'.
-- Anything looser reports a conflict that would not have happened;
-- anything tighter lets the loader abort mid-batch on 23505. It is the
-- index that will refuse the insert, so the index's predicate is the
-- specification.
--
-- 🔴 CROSS-TENANT DISCLOSURE. "Active at another property" is scoped to
-- the caller's own company, and other_property names a property only
-- within it. A plate parked at another operator's property is not a
-- fact this customer may learn, and an error message is a disclosure
-- channel like any other.

BEGIN;

CREATE OR REPLACE FUNCTION public.bulk_validate_rows(
  p_property_id BIGINT,
  p_rows        JSONB
)
RETURNS TABLE (
  row_index          INT,
  plate_norm         TEXT,
  plate_active_here  BOOLEAN,
  plate_active_other BOOLEAN,
  other_property     TEXT,
  plate_prohibited   BOOLEAN,
  resident_exists    BOOLEAN,
  resident_active    BOOLEAN
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_property TEXT;
  v_company  TEXT;
BEGIN
  -- Same authority as the upload itself: active company_admin of this
  -- property's company, property active, company active and not
  -- suspended, and the flag on. One helper, so the preview cannot be
  -- reachable on a surface the submission is not.
  IF NOT public.may_bulk_upload_at(p_property_id) THEN
    RAISE EXCEPTION 'property_not_in_scope';
  END IF;

  SELECT p.name, p.company INTO v_property, v_company
    FROM public.properties p WHERE p.id = p_property_id;

  RETURN QUERY
  WITH input AS (
    SELECT r.i                                         AS row_index,
           public.normalize_plate(r.plate)             AS plate_norm,
           lower(btrim(coalesce(r.email, '')))         AS email
      FROM jsonb_to_recordset(p_rows) AS r(i INT, email TEXT, plate TEXT)
  ),
  -- The sibling properties, resolved once rather than per row.
  siblings AS (
    SELECT p2.name
      FROM public.properties p2
     WHERE lower(btrim(p2.company)) = lower(btrim(v_company))
       AND p2.name <> v_property
  )
  SELECT
    i.row_index,
    i.plate_norm,
    -- Index predicate, verbatim.
    EXISTS (
      SELECT 1 FROM public.vehicles v
       WHERE public.normalize_plate(v.plate) = i.plate_norm
         AND v.property = v_property
         AND v.is_active = TRUE
         AND v.status IN ('active', 'under_review')
    ),
    -- 🔴 ONE LATERAL, NOT AN EXISTS PLUS A SCALAR SUBQUERY.
    -- The first version asked the sibling question twice: once as
    -- EXISTS for the boolean and again as a scalar subquery for the
    -- name. That wrote the index's predicate into the RPC a third
    -- time — caught by the paired gate's occurrence count, which
    -- expected two — and left the flag and the name as two
    -- independently derived answers that could in principle disagree.
    -- Now the boolean IS the name's presence, and there is one scan
    -- per row instead of two.
    other.property IS NOT NULL,
    other.property,
    -- Prohibitions store the plate ALREADY normalized (ppp_plate_normalize
    -- trigger), so this is an indexed equality. Liveness is both
    -- predicates: not removed AND not expired.
    EXISTS (
      SELECT 1 FROM public.property_plate_prohibitions pp
       WHERE pp.property_id = p_property_id
         AND pp.plate = i.plate_norm
         AND pp.removed_at IS NULL
         AND (pp.expires_at IS NULL OR pp.expires_at > now())
    ),
    EXISTS (
      SELECT 1 FROM public.residents rr
       WHERE lower(btrim(rr.email)) = i.email
         AND rr.property = v_property
    ),
    -- Reported separately because "already here" and "here but
    -- deactivated" are different situations for the customer: one is a
    -- row to delete from the file, the other is a reactivation.
    EXISTS (
      SELECT 1 FROM public.residents rr
       WHERE lower(btrim(rr.email)) = i.email
         AND rr.property = v_property
         AND rr.is_active = TRUE
    )
    FROM input i
    LEFT JOIN LATERAL (
      SELECT v.property
        FROM public.vehicles v
       WHERE public.normalize_plate(v.plate) = i.plate_norm
         AND v.property IN (SELECT s.name FROM siblings s)
         AND v.is_active = TRUE
         AND v.status IN ('active', 'under_review')
       ORDER BY v.property
       LIMIT 1
    ) other ON TRUE;
END
$fn$;

COMMENT ON FUNCTION public.bulk_validate_rows(BIGINT, JSONB) IS
  'Phase A bulk-onboarding preview: the four checks that require the database, for a whole file in one set-based call. '
  '🔴 Exists so the validator calls public.normalize_plate() rather than reimplementing it — vehicles_plate_norm_uniq is an expression index over that function, and predicting that index is the validator''s entire job. '
  'The active-plate predicates are copied from that index verbatim (property TEXT equality, is_active, status IN (active, under_review)): looser reports phantom conflicts, tighter lets the loader abort mid-batch on 23505. '
  '"Active at another property" is scoped to the caller''s own company, because an error message is a disclosure channel. '
  'Gated by may_bulk_upload_at(), the same authority as the upload, and raises property_not_in_scope otherwise.';

REVOKE ALL ON FUNCTION public.bulk_validate_rows(BIGINT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bulk_validate_rows(BIGINT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.bulk_validate_rows(BIGINT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_validate_rows(BIGINT, JSONB) TO service_role;

COMMIT;

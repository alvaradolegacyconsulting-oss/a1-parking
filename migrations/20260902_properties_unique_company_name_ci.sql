-- ══════════════════════════════════════════════════════════════════════
-- 20260902_properties_unique_company_name_ci.sql
--
-- 🟢 Bar-2 launch prep §3 — A3 unique index on properties by
--    (company, name) with case-insensitive + whitespace-normalized
--    comparison.
--
-- Prevents two properties within the same company from having names
-- that differ only in case or leading/trailing whitespace. `Green
-- Acres`, `green acres`, ` Green Acres `, and `GREEN ACRES` all
-- collide.
--
-- ── SCOPE ───────────────────────────────────────────────────────────
--
-- UNIQUE INDEX (not partial) on public.properties:
--   (lower(trim(company)), lower(trim(name)))
--
-- All rows regardless of is_active. Rationale: a property name is a
-- stable identifier of "that lot at that company" — alive or dormant.
-- A deactivate → new-property-with-same-name → reactivate flow
-- otherwise silently allows a collision that trips at the reactivate
-- step (both is_active=true). Full index blocks it at the middle
-- step, which is where a human can fix it (rename the new one).
--
-- Two-column key: same normalized name at DIFFERENT companies is
-- allowed. This is a per-company uniqueness rule, not a global one.
--
-- ── NORMALIZATION ──────────────────────────────────────────────────
--
-- `lower(trim(x))` — matches the equality shape from Cap Commit A
-- (7b67ff8) and the metachar CHECK (1c3e8ef). Consistent normalization
-- across write/read/lookup layers means the same string comparison
-- rule everywhere.
--
-- Metacharacter CHECK (companies_name_no_sql_metachar +
-- properties_name_no_sql_metachar, 1c3e8ef) already rejects `%`, `_`,
-- `\` at write. This index adds case + whitespace collapsing on top.
-- Order of enforcement: metachar CHECK fires first (row-level), then
-- the UNIQUE INDEX (constraint-level). Two independent failure modes,
-- two independent 23514 vs 23505 sqlstates.
--
-- ── IN-MIGRATION PRE-FLIGHT ASSERTION ──────────────────────────────
--
-- Jose confirmed 0 duplicate groups + A1's Q4 portfolio has none.
-- Same-session re-check inside the migration BEGIN block is the
-- discipline (Mateo Sep 2 §3): "re-run the check in the same session
-- as the apply rather than trusting it."
--
-- If any duplicate group exists, RAISE with the offending
-- (company_normalized, name_normalized) pairs + row ids in each
-- group so a cleanup pass is targetable. Rollback in the same
-- transaction — CREATE INDEX doesn't fire, no partial state.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
--
-- Wraps BEGIN/COMMIT — atomic apply. Note: CREATE INDEX (non-
-- concurrent) is transaction-safe; CREATE INDEX CONCURRENTLY is NOT
-- (cannot be inside a transaction block, does not rollback on
-- failure). We use plain CREATE INDEX for atomicity + rollback on
-- pre-flight failure.
--
-- Table lock during index build: ShareLock (blocks writes, allows
-- reads). properties is a low-write-volume table (property CRUD is
-- rare) so the lock is not disruptive. If it becomes a concern
-- later, this can be re-shipped as CREATE INDEX CONCURRENTLY in a
-- non-transactional migration, but that's not warranted today.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — In-migration pre-flight assertion ─────────────────────
-- Same-session re-check. If any duplicates exist (per normalized
-- key), name them in the RAISE and abort. Cleanup is a separate
-- decision (rename vs merge vs delete).
DO $$
DECLARE
  v_dup_group_count INT;
  v_offenders TEXT := '';
BEGIN
  SELECT COUNT(*) INTO v_dup_group_count
    FROM (
      SELECT lower(trim(company)) AS c_norm, lower(trim(name)) AS n_norm, COUNT(*) AS grp_size
        FROM public.properties
       GROUP BY 1, 2
      HAVING COUNT(*) > 1
    ) g;

  IF v_dup_group_count > 0 THEN
    SELECT string_agg(
             format('(company_normalized=%L, name_normalized=%L, ids=[%s])',
                    c_norm, n_norm, id_list),
             '; ')
      INTO v_offenders
      FROM (
        SELECT lower(trim(company)) AS c_norm,
               lower(trim(name))    AS n_norm,
               string_agg(id::TEXT, ',' ORDER BY id) AS id_list
          FROM public.properties
         GROUP BY 1, 2
        HAVING COUNT(*) > 1
      ) d;
    RAISE EXCEPTION
      'PRE-FLIGHT FAIL: % duplicate group(s) exist by (lower(trim(company)), lower(trim(name))) — CREATE UNIQUE INDEX would fail. Clean up (rename/merge/delete) before applying. Offenders: %',
      v_dup_group_count, v_offenders;
  END IF;
END $$;

-- ── PART 2 — Create the unique index ───────────────────────────────
-- Expression index on the normalized pair. Non-concurrent for
-- transaction safety.
CREATE UNIQUE INDEX properties_company_name_ci_unique
  ON public.properties (lower(trim(company)), lower(trim(name)));

-- ── PART 3 — Schema audit row ──────────────────────────────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_PROPERTIES_UNIQUE_COMPANY_NAME_CI',
  'public.properties',
  'unique_company_name_ci',
  jsonb_build_object(
    'migration',      '20260902_properties_unique_company_name_ci',
    'arc',            'Bar-2 launch prep §3 — A3 unique index (per-company, case+whitespace-insensitive)',
    'index_name',     'properties_company_name_ci_unique',
    'index_shape',    'UNIQUE (lower(trim(company)), lower(trim(name))) — expression index',
    'partial',        false,
    'partial_rationale', 'Full index applies to all rows regardless of is_active. Rationale: a property name is a stable identifier of "that lot at that company" — alive or dormant. Deactivate → new-property-with-same-name → reactivate would otherwise silently collide at the reactivate step. Full index blocks at the middle step where the human can rename.',
    'per_company',    true,
    'per_company_rationale', 'Same normalized name at DIFFERENT companies allowed. Two-column key.',
    'normalization',  'lower(trim(x)) — matches Cap Commit A (7b67ff8) get_company_property_limit lookup + metachar CHECK (1c3e8ef). One string comparison rule across all layers.',
    'pre_flight_baseline', '0 duplicate groups (Jose Sep 2 read + A1 Q4 portfolio confirmed clean; re-asserted in-migration).',
    'paired_with_client', '§3 Commit 2 — 23505 catches at admin addProperty (line 410) + CA saveProperty create (line 1534). Both create paths only per Mateo Sep 2 §3. Edit paths not wired (rename-lock trigger blocks renames at count>0; count=0 window is empirically small).',
    'other_layers',   'metachar CHECK (23514) fires row-level; UNIQUE INDEX (23505) fires constraint-level. Two independent failure modes.'
  ),
  now()
);

-- ── PART 4 — PostgREST cache reload ────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;

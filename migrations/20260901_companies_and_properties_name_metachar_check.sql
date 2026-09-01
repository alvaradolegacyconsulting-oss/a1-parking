-- ══════════════════════════════════════════════════════════════════════
-- 20260901_companies_and_properties_name_metachar_check.sql
--
-- 🟢 Bar-2 launch prep §4 — CHECK constraints closing the SQL LIKE
--    metacharacter vector at the name-column write layer.
--
-- ── THE VECTOR ──────────────────────────────────────────────────────
-- SQL LIKE (and PostgREST `.ilike`) treats `%` and `_` as wildcards;
-- `\` is the LIKE escape char. A company named `%` matches every
-- company via any ILIKE predicate; a property named `_` matches every
-- 1-char-name property. Under DEFINER context (which bypasses RLS),
-- that's a wrong-row read/write hazard.
--
-- Cap sequence Commit A (7b67ff8) closed the vector at
-- `get_company_property_limit()` specifically by moving from ILIKE to
-- `lower(trim())` equality. This migration closes it AT THE COLUMN by
-- refusing to let names containing those three characters into the
-- table in the first place. Every ILIKE-shaped consumer (`147 sites`
-- per Mateo Sep 1 followup §1) is transitively protected — no
-- surprise character can be there to match.
--
-- ── SCOPE ───────────────────────────────────────────────────────────
--
-- CHECK constraint on two columns:
--   public.companies.name
--   public.properties.name
--
-- NOT on public.properties.company — that column is a denormalized
-- copy of companies.name. A CHECK on companies.name is the source-of-
-- truth constraint; new properties.company values are derived from a
-- (constrained) companies.name (via `role?.company` at CA insert time
-- + auth flow provisioning), so bad values can't originate there once
-- companies.name is clean. The pre-flight scan below DOES cover
-- properties.company so any stale drift surfaces before the CHECK
-- lands.
--
-- Rename cascade companies.name → properties.company is a separate
-- concern being tracked by project_fk_property_id_migration.
--
-- ── CHARACTERS BLOCKED ──────────────────────────────────────────────
-- Exactly three: `%`, `_`, `\`. Mateo Sep 1 followup §5: "Do not
-- reject anything beyond those three characters. Apostrophes,
-- ampersands, hyphens and periods are ordinary in real property
-- names, and A1 is adding 10-15 properties by Q4 — a validator that
-- blocks a legitimate name blocks their rollout."
--
-- Regex: `name !~ '[%_\\]'` — POSIX character class of literal
-- `%`, `_`, `\`. Standard-conforming-strings mode assumed (Supabase
-- default; backslash is literal in single-quoted string).
--
-- ── IN-MIGRATION PRE-FLIGHT ASSERTION ──────────────────────────────
-- 🔴 Aug 28 baseline: 0 / 0 / 0 across companies.name, properties.name
-- and properties.company. Mateo Sep 1 followup §3: "Re-run the scan
-- immediately before applying — the Aug 28 read is not a guarantee
-- for today." This block does that re-run in the SAME transaction as
-- the CHECK apply, so if a bad name landed between Aug 28 and now
-- the apply fails RAISE'd rather than the CHECK apply erroring
-- mid-way and leaving one constraint on + one off.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- 1. Wraps in BEGIN/COMMIT (partial-apply hazard per SQL Editor
--    gotcha) — either the assertion passes AND both CHECKs land, or
--    nothing changes.
-- 2. Assertion RAISEs with counts named for each column, so a
--    non-zero result tells Jose exactly which column has bad rows.
-- 3. CHECKs are ADD CONSTRAINT NOT VALID? — NO, we want VALIDATE
--    against every existing row, because the pre-flight already
--    confirms clean baseline. NOT VALID would let a bad row survive
--    if the assertion somehow raced (it can't in one transaction,
--    but VALIDATE is the defensive shape).
-- 4. Paired verification (20260901_*_verification.sql) contains
--    execution probes: INSERT %-named company must 23514; UPDATE
--    company setting name to _ must 23514; INSERT _-named property
--    must 23514; UPDATE property to \ must 23514.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — In-migration pre-flight assertion ─────────────────────
-- Fail loud + fail early if any bad row exists in prod. If this
-- RAISEs, don't clean up in this migration — cleanup is a separate
-- decision (may want to rename vs delete vs report-to-CA). Just
-- surface the state.
DO $$
DECLARE
  v_companies_bad         INT;
  v_properties_name_bad   INT;
  v_properties_co_bad     INT;
  v_offenders_companies   TEXT := '';
  v_offenders_properties  TEXT := '';
  v_offenders_props_co    TEXT := '';
BEGIN
  SELECT COUNT(*) INTO v_companies_bad
    FROM public.companies WHERE name ~ '[%_\\]';
  SELECT COUNT(*) INTO v_properties_name_bad
    FROM public.properties WHERE name ~ '[%_\\]';
  SELECT COUNT(*) INTO v_properties_co_bad
    FROM public.properties WHERE company ~ '[%_\\]';

  IF v_companies_bad > 0 THEN
    SELECT string_agg(format('id=%s name=%L', id, name), '; ') INTO v_offenders_companies
      FROM public.companies WHERE name ~ '[%_\\]';
  END IF;
  IF v_properties_name_bad > 0 THEN
    SELECT string_agg(format('id=%s name=%L', id, name), '; ') INTO v_offenders_properties
      FROM public.properties WHERE name ~ '[%_\\]';
  END IF;
  IF v_properties_co_bad > 0 THEN
    SELECT string_agg(format('id=%s company=%L', id, company), '; ') INTO v_offenders_props_co
      FROM public.properties WHERE company ~ '[%_\\]';
  END IF;

  IF v_companies_bad > 0 OR v_properties_name_bad > 0 OR v_properties_co_bad > 0 THEN
    RAISE EXCEPTION
      'PRE-FLIGHT FAIL: metacharacter-bearing rows present. companies.name=% (%s); properties.name=% (%s); properties.company=% (%s). ROLLING BACK — clean up (rename OR delete OR audit-decision) before applying the CHECK. Aug 28 baseline was 0/0/0.',
      v_companies_bad, v_offenders_companies,
      v_properties_name_bad, v_offenders_properties,
      v_properties_co_bad, v_offenders_props_co;
  END IF;
END $$;

-- ── PART 2 — Add CHECK constraints ─────────────────────────────────
-- Regex `[%_\\]` in a standard-conforming single-quoted string is
-- literal `[%_\\]` — POSIX character class matching `%`, `_`, or `\`.
-- `!~` = "not matches"; NULL passes (nullable is a separate concern
-- not in scope here — existing NOT NULL on both columns is unaffected).

ALTER TABLE public.companies
  ADD CONSTRAINT companies_name_no_sql_metachar
  CHECK (name !~ '[%_\\]');

ALTER TABLE public.properties
  ADD CONSTRAINT properties_name_no_sql_metachar
  CHECK (name !~ '[%_\\]');

-- ── PART 3 — Schema audit row ──────────────────────────────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_NAME_METACHAR_CHECK',
  'public.companies + public.properties',
  'name_metachar_check',
  jsonb_build_object(
    'migration',      '20260901_companies_and_properties_name_metachar_check',
    'arc',            'Bar-2 launch prep §4 — SQL LIKE metacharacter vector close (server-side enforcement)',
    'constraints',    jsonb_build_array(
      'companies_name_no_sql_metachar CHECK (name !~ ''[%_\\]'')',
      'properties_name_no_sql_metachar CHECK (name !~ ''[%_\\]'')'
    ),
    'blocked_chars',  jsonb_build_array('%', '_', '\'),
    'not_blocked',    'apostrophes, ampersands, hyphens, periods, unicode — all legitimate in real names',
    'pre_flight_baseline', '0/0/0 companies.name/properties.name/properties.company (Aug 28 2026 read; re-asserted in-migration)',
    'paired_with_client', '§4 Commit 2 (client validator + wire-ups) ships separately; server-side is the enforcement boundary, client is UX so users see a readable message instead of raw 23514',
    'related',        'Cap sequence Commit A (7b67ff8) closed the same vector at get_company_property_limit() by switching from ILIKE to lower(trim()) equality; this closes it at the column so all 147 ILIKE-shaped consumers are transitively protected',
    'not_scope',      'properties.company (derived from companies.name; pre-flight covers it but CHECK on source column is authoritative). Rename cascade tracked by project_fk_property_id_migration.'
  ),
  now()
);

-- ── PART 4 — PostgREST cache reload ────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;

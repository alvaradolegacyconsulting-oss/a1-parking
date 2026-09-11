-- ══════════════════════════════════════════════════════════════════════
-- 20260911_user_roles_metachar_check.sql
--
-- 🔴 Constrain the PATTERN SIDE of ~80 tenancy policies. Two CHECKs.
--
-- ── WHAT THIS CLOSES ────────────────────────────────────────────────
-- Roughly eighty RLS policies scope tenancy through
--     company  ~~* get_my_company()
--     property ~~* ANY (get_my_properties())
-- and BOTH helpers read user_roles.company / user_roles.property.
--
-- `~~*` is ILIKE, so those columns are used as PATTERNS. A user_roles
-- row carrying '%' in company reads EVERY resident in EVERY tenant —
-- cross-tenant disclosure — and the manager property policies also
-- WRITE.
--
-- Constraining the two columns means the pattern cannot carry a
-- wildcard REGARDLESS of how many policies ILIKE against it. Two
-- constraints instead of eighty rewrites.
--
-- ── 🔴 THIS IS THE OPPOSITE CALL FROM THE EMAIL CASE. NOT A CONTRADICTION.
-- On 2026-09-11 we explicitly REJECTED an input constraint for the
-- email vector and fixed it at the policy layer instead. The reason was
-- specific, not general: `john_smith@gmail.com` is a legitimate address
-- a resident may actually hold, and eleven of 231 accounts contain `_`.
-- You cannot reject it.
--
-- Nothing legitimate is rejected here. companies.name and
-- properties.name have carried this exact CHECK since 2026-09-01, and
-- adding a CHECK VALIDATES EXISTING ROWS — so it passing then proves no
-- company or property name contains these characters. These two columns
-- hold REFERENCES to those names, so a value pointing at a real company
-- or property cannot need a metacharacter.
--
-- Read the two decisions together and they are the same rule: constrain
-- the input when the input has no legitimate use for the character, fix
-- the predicate when it does.
--
-- ── ⚠ THE ARRAY COLUMN NEEDS A DIFFERENT FORM ───────────────────────
-- user_roles.property is TEXT[], and the obvious spelling DOES NOT
-- APPLY — Postgres refuses subqueries in a CHECK outright:
--
--     CHECK (NOT EXISTS (SELECT 1 FROM unnest(property) p WHERE p ~ '…'))
--     -- ERROR: cannot use subquery in check constraint
--
-- array_to_string() is a plain function call with no subquery. It
-- flattens the array, so if ANY element carries a metacharacter the
-- joined string does. The comma separator is irrelevant — we test only
-- for %, _ and \.
--
-- ⚠ array_to_string is STABLE, not IMMUTABLE (it calls the element
-- type's output function). Postgres permits non-immutable functions in
-- a CHECK — the documented restrictions are subqueries and references
-- to other rows — and a CHECK is evaluated only at write time, so
-- stability is sufficient here. It would NOT be sufficient for an index
-- expression. Noted because the distinction is easy to carry across
-- wrongly.
--
-- Empty array → '' → passes. NULL elements are skipped by
-- array_to_string; a NULL element is not a wildcard, so that is correct.
--
-- ── PRE-FLIGHT (re-run immediately before applying) ─────────────────
-- Adding a CHECK validates existing rows, so a violating row is the one
-- thing that makes the ALTER fail. Returned zero rows on 2026-09-11:
--
--   SELECT email, role, company, property
--     FROM public.user_roles
--    WHERE company ~ '[%_\\]'
--       OR EXISTS (SELECT 1 FROM unnest(property) p WHERE p ~ '[%_\\]');
--
-- (The subquery form is fine HERE — it is a query, not a CHECK.)
--
-- ── ⚠ THIS DOES NOT RETIRE THE POLICY REWRITE ───────────────────────
-- The ~80 policies should still move to equality. Defence that depends
-- on a constraint on another table is fragile — the same objection
-- raised against `residents.company ~~* ur.company` in Tier 1, and it
-- applies to this constraint too. What this buys is the removal of
-- URGENCY: the rewrite becomes normal scheduled work instead of an open
-- cross-tenant hole.
--
-- ── ⚠ WRITE PATHS WILL SURFACE A RAW 23514 UNTIL THEY VALIDATE ──────
-- Checked 2026-09-11. Two shapes write these columns:
--   · insert_user_role (DEFINER RPC) — validates CALLER SCOPE but not
--     the characters. 4 call sites: admin x3, manager, /register.
--   · app/admin/page.tsx:874 — a DIRECT .from('user_roles').insert(),
--     bypassing the RPC entirely, with company from a free-text admin
--     field.
-- Neither validates, so a typo'd '%' becomes a bare 23514 in front of
-- an operator. Same shape as the punctuation-plate bug of 2026-09-10.
-- Filed as the follow-up; NOT in this migration, which is schema only.
--
-- ── APPLY DISCIPLINE (CRITICAL) ─────────────────────────────────────
-- Paste the ENTIRE BEGIN/COMMIT block as ONE block, click Run ONCE.
-- Paired file: 20260911_user_roles_metachar_check_verification.sql
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- Same character class as companies_and_properties_name_metachar_check
-- (2026-09-01): the three SQL LIKE metacharacters.
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_company_no_sql_metachar
  CHECK (company IS NULL OR company !~ '[%_\\]');

ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_property_no_sql_metachar
  CHECK (property IS NULL OR array_to_string(property, ',') !~ '[%_\\]');

COMMENT ON CONSTRAINT user_roles_company_no_sql_metachar ON public.user_roles IS
  'Blocks the SQL LIKE metacharacters %, _ and \ in user_roles.company. ~80 RLS policies scope tenancy via company ~~* get_my_company(), which reads this column — so a wildcard stored here is used as a PATTERN and reads across tenants. Constraining the pattern side closes that regardless of how many policies still use ILIKE. Costs nothing legitimate: companies.name has carried the same CHECK since 2026-09-01, so no real company name needs these characters. See 20260911_user_roles_metachar_check.sql.';

COMMENT ON CONSTRAINT user_roles_property_no_sql_metachar ON public.user_roles IS
  'Blocks %, _ and \ in any element of user_roles.property (TEXT[]). Same rationale as the company constraint — get_my_properties() reads this column and ~80 policies ILIKE against it. Uses array_to_string() because Postgres refuses subqueries in a CHECK, so the natural NOT EXISTS (SELECT ... FROM unnest(property)) form will not apply. See 20260911_user_roles_metachar_check.sql.';

INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_USER_ROLES_METACHAR_CHECK',
  'public.user_roles',
  'company_and_property_metachar',
  jsonb_build_object(
    'migration', '20260911_user_roles_metachar_check',
    'arc',       'email ~~* audit — constrain the PATTERN side of the company/property ILIKE class',
    'constraints', jsonb_build_array(
      'user_roles_company_no_sql_metachar  CHECK (company IS NULL OR company !~ ''[%_\\]'')',
      'user_roles_property_no_sql_metachar CHECK (property IS NULL OR array_to_string(property, '','') !~ ''[%_\\]'')'
    ),
    'closes', 'A user_roles.company of ''%'' reads every resident in every tenant through ~80 policies scoping on company ~~* get_my_company(); user_roles.property does the same for property-scoped policies, two of which also WRITE.',
    'why_opposite_of_the_email_call', 'We rejected an input constraint for email the same day because john_smith@gmail.com is legitimate and 11 of 231 accounts contain _. Nothing legitimate is rejected here: companies.name and properties.name have carried this exact CHECK since 2026-09-01, and these columns hold references to those names. Same rule, different inputs — constrain the input when it has no legitimate use for the character, fix the predicate when it does.',
    'array_form', 'Postgres refuses subqueries in a CHECK, so NOT EXISTS (SELECT 1 FROM unnest(property) ...) does not apply. array_to_string() flattens without a subquery. It is STABLE not IMMUTABLE, which a CHECK permits (evaluated at write time only) but an index expression would not.',
    'does_not_retire_the_rewrite', 'The ~80 policies should still move to equality — defence resting on a constraint on another table is fragile, the same objection raised against residents.company ~~* ur.company in Tier 1. This removes URGENCY, not the work.',
    'write_path_followup', 'insert_user_role validates caller scope but not characters (4 call sites), and app/admin/page.tsx:874 writes user_roles directly, bypassing the RPC. Until both validate, a typo''d % surfaces as a bare 23514 — same shape as the punctuation-plate bug of 2026-09-10.'
  ),
  now()
);

COMMIT;

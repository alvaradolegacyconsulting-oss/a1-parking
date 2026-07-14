-- ════════════════════════════════════════════════════════════════════
-- companies — UNIQUE(lower(trim(name))) — Bar-2 tenancy backstop
-- 2026-07-13
--
-- ORIGIN
--   A1 Wrecker LLC redeemed 2026-07-13 as the first live customer in a
--   database that also holds seed/demo/test data. Tenancy is
--   text-name-keyed across 7 tables (user_roles, properties, drivers,
--   residents, spaces, storage_facilities, guest_authorizations); RLS
--   scopes all of them via get_my_company() text comparison. With
--   public_signup_open=false today, a duplicate `companies.name` is a
--   dormant race in the app-layer disambiguation at
--   app/lib/stripe-event-handlers/checkout-session-completed.ts:184-194
--   (.ilike-then-INSERT with a check-then-write race window). This
--   migration makes the name effectively unique at the DB level so the
--   race becomes a clean 23505 rejection instead of a silent
--   cross-tenant merge.
--
-- WHY THIS INVARIANT MATTERS
--   RLS predicates read `.company ~~* get_my_company()` where
--   get_my_company() returns the caller's user_roles.company TEXT. If
--   two `companies` rows share a name (case- or whitespace-differing),
--   users of company A join by-name to tables owned by company B and
--   vice versa. Bar 2 (public_signup_open=true) opens the vector: an
--   attacker self-registers "A1 Wrecker llc" and their users join A1's
--   tenancy by string match. This constraint closes it structurally.
--
-- SCOPE GUARD
--   • This migration is a SINGLE UNIQUE INDEX. It does NOT:
--     - Touch RLS policies (get_my_company() and every ~~* predicate
--       stay text-based — that's the FK migration slice, spec-only).
--     - Rewrite the app-layer .ilike disambiguation (still fires; now
--       backed by DB rejection on the 100-suffix loop's race).
--     - Attempt data cleanup — Jose verified 5 distinct rows on
--       2026-07-13; no dedup needed.
--   • Uses CREATE UNIQUE INDEX (not ALTER TABLE ADD CONSTRAINT UNIQUE)
--     because Postgres can't use an expression (`lower(trim(name))`)
--     in a table constraint; a functional index is the correct form.
--     Prior art: user_roles_lower_email_uidx (2026-07-04, same reason).
--   • `trim()` covers whitespace variations
--     ('A1 Wrecker llc' vs 'A1 Wrecker  llc') which the app-layer
--     check misses. `lower()` covers case variations.
--
-- PRE-APPLY GATE (RUN BEFORE APPLYING — do NOT paste in the same run):
--   -- Expected: 0 rows. Jose verified 5 distinct on 2026-07-13.
--   SELECT lower(trim(name)) AS lowered_trimmed_name, COUNT(*) AS dup_count,
--          array_agg(id ORDER BY id) AS ids,
--          array_agg(name ORDER BY id) AS raw_names
--     FROM public.companies
--    GROUP BY lower(trim(name))
--   HAVING COUNT(*) > 1
--    ORDER BY dup_count DESC, lowered_trimmed_name;
--
-- FAIL-CLOSED SEMANTIC
--   If a duplicate somehow survives Jose's pre-apply check, CREATE
--   UNIQUE INDEX fails with 23505 unique_violation and the transaction
--   rolls back cleanly. Safe to attempt — it either succeeds
--   (invariant now locked) or refuses (surfaces the missed dedup
--   loudly).
--
-- COUPLED WORK (NOT IN THIS COMMIT — logged for Bar-2 checklist)
--   • Catch 23505 in the signup checkout-session-completed handler and
--     surface a clean "company name already exists" message to the
--     signup flow. Without this catch a race collision renders a raw
--     500 to the user instead of a friendly error. Load-bearing before
--     public_signup_open flips to true.
--   • Forbid a company-rename UI until the FK migration lands. Rename
--     without cascade orphans every child row's text-match.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS companies_name_lower_unique
  ON public.companies (lower(trim(name)));

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_COMPANIES_NAME_LOWER_UNIQUE',
  'companies',
  NULL,
  jsonb_build_object(
    'migration', '20260713_companies_name_lower_unique',
    'change',    'CREATE UNIQUE INDEX companies_name_lower_unique ON public.companies (lower(trim(name))). Bar-2 launch-gating constraint: closes the cross-tenant merge race in the self-serve signup path (checkout-session-completed.ts:184-194 does .ilike-then-INSERT). Functional index shape (not ALTER TABLE ADD CONSTRAINT) — Postgres requires an index for expression uniqueness. Prior art: user_roles_lower_email_uidx (2026-07-04).',
    'rationale', 'A1 redeemed 2026-07-13; tenancy is text-name-keyed across 7 tables with ~~* get_my_company() RLS scoping. Effective uniqueness on companies.name is the load-bearing invariant until the FK migration (user_roles.company_id + RLS rewrites) lands. Spec-only today; constraint holds Bar 2 in the interim.'
  ),
  now()
);

COMMIT;

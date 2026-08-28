-- ══════════════════════════════════════════════════════════════════════
-- 20260828_vehicles_add_company_column.sql
--
-- 🟢 vehicles.company arc — COMMIT 1 of 4
--
-- Adds a nullable `company` TEXT column to public.vehicles. No default,
-- no backfill, no writer references it yet, no reader references it,
-- no RLS policy references it. Fully invisible in behavior; fully
-- reversible by DROP COLUMN.
--
-- ── WHY ────────────────────────────────────────────────────────────
-- The A2 super-admin cascade at app/admin/page.tsx:481-483 + 511-512
-- updates residents/vehicles by property NAME with no company predicate.
-- residents already has a company column so the predicate can be added
-- there. vehicles carries property but nothing else — the cascade cannot
-- be scoped without a company discriminator. This arc adds it.
--
-- The window is closing: the backfill is only unambiguous while no
-- property name is shared across two tenants (per Mateo Aug 28 preflight
-- P1.BACKFILL_SAFE gate: ambiguous_names=0 required). Today that's true;
-- the moment self-serve opens two tenants can both have a "Green Acres."
--
-- ── COMMIT SEQUENCE ────────────────────────────────────────────────
--   Commit 1 (THIS FILE) — ADD COLUMN, nullable, no default
--   Commit 2               — writer changes populate company on every INSERT
--                            (5 production paths, each verified individually)
--   Commit 3               — backfill existing rows, gated on §1.4 in-session
--                            (unmatched=0 AND ambiguous_names=0 or STOP)
--   Commit 4               — SET NOT NULL, within the same week of Commit 3
--                            Pre: 5-path Test-Legacy-only smoke, probes deleted
--                            Post: V4.A1_DRIFT reads A1's normal traffic; pass =
--                                  null_company=0 AND created_since_deploy>0
--
-- ── 🔴 EXPLICIT NON-GOALS ────────────────────────────────────────────
--
-- 1. NO RLS POLICY MAY REFERENCE vehicles.company UNTIL COMMIT 4 HAS
--    LANDED AND BEEN VERIFIED. Mateo Aug 28 §D: with a policy keyed on
--    company, a NULL company doesn't fail loudly — the row matches no
--    predicate and becomes invisible to its own company admin. A
--    vehicle that exists, is active, and cannot be seen. On a table
--    where invisibility means a resident's car is towable, that is the
--    worst available failure mode. Policy rewrites are a separate arc
--    with their own preflight, AFTER Commit 4.
--
-- 2. NO BACKSTOP TRIGGER. Mateo Aug 28 §A declined the belt-and-braces
--    (writer-populated + BEFORE INSERT trigger fill on NULL). The whole
--    argument for writer-populated over trigger-populated is that a
--    missed writer is VISIBLE (NULL row → V3/V4 gates catch it). A
--    backstop trigger destroys that property by silently name-resolving
--    the missing writer's row. That's the class rule inverted — making
--    the failure output look like a legitimate value.
--
-- 3. NO WRITER CHANGES IN THIS COMMIT. Adding the column and populating
--    it are separate steps by design so Commit 1 is fully invisible
--    and Commit 2's writer-path verification runs against a known-empty
--    column state.
--
-- ── PostgREST SCHEMA CACHE ─────────────────────────────────────────
-- Supabase auto-issues a NOTIFY pgrst on DDL; we issue it explicitly
-- too. But that does not guarantee PostgREST has picked it up before
-- the next writer runs (Mateo Aug 28 new gate). The verification file
-- includes a Postgres-side structural check (G1-G5). PostgREST cache
-- visibility MUST be verified separately via REST — see
-- scripts/gate-vehicles-company-postgrest.ts.
--
-- APPLY: single database. Idempotent (IF NOT EXISTS on the ADD).
-- Verification: 20260828_vehicles_add_company_column_verification.sql
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── The one operation ───────────────────────────────────────────────
-- Postgres 11+ ADD COLUMN with no default is O(1) — no table rewrite,
-- no rows touched, no lock held longer than metadata update.
ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS company TEXT;

COMMENT ON COLUMN public.vehicles.company IS
  'Tenant discriminator column. Added 2026-08-28 as Commit 1 of the vehicles.company arc. NULL until Commit 3 backfill; NOT NULL after Commit 4. Populated by writers in Commit 2 (never by trigger — see migration header for the writer-populated-vs-trigger decision). 🔴 DO NOT REFERENCE IN RLS POLICIES until Commit 4 has landed and been verified — a NULL company on a policy-keyed column produces a row invisible to its own company admin. Policy rewrites are a separate arc.';

-- ── PostgREST schema cache reload ───────────────────────────────────
-- Belt-and-braces: Supabase auto-issues this on DDL, but making it
-- explicit means the reload NOTIFY fires from a known point in the
-- migration rather than at the transaction's commit fence. Still
-- doesn't guarantee PostgREST has reloaded before the next writer
-- runs — that's what the REST-side gate is for.
NOTIFY pgrst, 'reload schema';

-- ── Schema audit row ────────────────────────────────────────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_VEHICLES_ADD_COMPANY_COLUMN',
  'public.vehicles',
  'vehicles.company',
  jsonb_build_object(
    'migration', '20260828_vehicles_add_company_column',
    'arc',       'vehicles.company Commit 1 of 4',
    'change',    'ADD COLUMN company TEXT (nullable, no default, no backfill)',
    'reversible', TRUE,
    'reversal',  'ALTER TABLE public.vehicles DROP COLUMN company',
    'non_goals', jsonb_build_array(
      'NO RLS policy may reference this column until Commit 4 (Mateo §D)',
      'NO backstop trigger (writer-populated only; Mateo §A)',
      'NO writer changes in this commit'
    ),
    'next_step', 'Verify Postgres-side via 20260828_vehicles_add_company_column_verification.sql + PostgREST via scripts/gate-vehicles-company-postgrest.ts before any Commit 2 writer push'
  )
);

COMMIT;

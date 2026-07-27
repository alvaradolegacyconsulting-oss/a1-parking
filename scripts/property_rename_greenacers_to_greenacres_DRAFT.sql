-- ══════════════════════════════════════════════════════════════════════
-- Property rename: "Green Acers" → "Green Acres" (property id 143 ONLY)
--
-- DRAFT — NOT APPLIED. Jose runs when:
--   0. 🔴 property_name_aliases schema migration APPLIED + VERIFIED
--      (Test-LEGACY probe: alias-add → rename test property → old URL
--      resolves → cleanup). Alias for Green Acers → 143 INSERTED
--      BEFORE this rename runs; printed signage URLs remain functional
--      through the rename window because the RPC's 2-step resolver
--      falls through to the alias.
--   1. A1 confirmed target spelling: "Green Acres" (2026-07-27).
--      Property 143 ONLY. Miramar (144) and Sugarberry (145) NOT
--      being renamed per A1 confirmation same day.
--   2. Pre-flight count captured so post-verify numbers are anchored.
--
-- Application discipline (per feedback_sql_editor_partial_apply):
--   • Single paste, single transaction (SQL editor breaks on BEGIN/COMMIT
--     boundaries if pasted piecemeal — one shot).
--   • Editor cleared between (this script must be the only content).
--   • Pre-flight SELECT → APPLY txn → post-verify SELECT, one session.
--
-- Scope (per Mateo 2026-07-27):
--   • lower(trim()) matching on all 8 scalar name-keyed tables so
--     historical whitespace variants ("Green Acers ", " Green Acers")
--     match the same UPDATE as the trimmed form. Trim triggers (3adc2c5)
--     normalize writes going forward but historical rows may carry the
--     space — lower(trim(...)) catches both.
--   • Whitespace-stripped absence verification in the post-apply block
--     (STEP 3). AFTER-Acers counts use lower(trim(property)) so a
--     stray whitespace variant can't hide from the "expect 0" check.
--   • LIVE-SESSION NOTE — Miriam and any residents signed in during the
--     rename will have React state cached with the old property name.
--     They must sign out + sign back in to see the new name; any writes
--     they attempt mid-window inherit the alias fallback (safe) but
--     display remains stale until re-hydration. A1 comms includes this.
--
-- Tables covered:
--   • properties.name — the rename itself (parent row 143)
--   • 8 scalar 'property' name-keyed tables (denormalized for RLS)
--   • user_roles.property — TEXT[] array, uses array_replace
--   • drivers.assigned_properties — TEXT[] array (same shape as
--     user_roles.property; consulted by the rename-block trigger below).
--
-- Tables NOT covered (deliberate):
--   • authorized_plates — property_id BIGINT FK; automatic through
--     parent rename. Zero rows changed here. Reference architecture the
--     FK epic will generalize.
--   • audit_logs — immutable historical record (Chapter 2308 evidence
--     integrity — historical rows preserve name value AT TIME OF EVENT).
--   • property_name_aliases — the alias row for 'Green Acers' → 143
--     was INSERTED before this script (step 0). It stays after rename,
--     keeping printed signage functional. Retire only when signage is
--     confirmed replaced (unlikely — A1 may never reprint).
--
-- ── 🔴 RENAME-BLOCK TRIGGER (trg_properties_name_block_rename) ────
-- BEFORE UPDATE OF name on public.properties. Body verified 2026-07-27:
--   • Only fires if NEW.name IS DISTINCT FROM OLD.name
--   • admin-only bypass via get_my_role() = 'admin'
--   • Otherwise counts refs across THREE tables scoped by company:
--       user_roles.property (array), drivers.assigned_properties
--       (array), residents.property (scalar). If refs > 0, REJECTS
--       with "N active user assignments — rename blocked".
--
-- Green Acers has 6+ residents and 2 assigned managers → v_refs > 0.
-- Supabase SQL editor sessions have no JWT → get_my_role() returns
-- NULL → admin bypass does NOT fire → rename would abort.
--
-- Solution (Mateo 2026-07-27): targeted DISABLE/ENABLE of the trigger
-- INSIDE the transaction. If the transaction aborts, the trigger is
-- automatically restored — no window where the lock is off outside
-- this txn. Other triggers (trim, property_limit_check) stay active.
--
-- 🔴 DO NOT USE `SET session_replication_role = replica` — that
-- disables EVERY trigger on the connection, including trim triggers
-- and FK enforcement. Targeted `ALTER TABLE ... DISABLE TRIGGER` is
-- surgical.
-- ══════════════════════════════════════════════════════════════════════


-- ── STEP 1 — PRE-FLIGHT count. Capture the "before" numbers. ────────

SELECT 'BEFORE' AS phase, 'properties'          AS tbl, count(*)::int AS n FROM public.properties           WHERE lower(trim(name))     = 'green acers'
UNION ALL SELECT 'BEFORE', 'residents',                  count(*)::int FROM public.residents             WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'BEFORE', 'vehicles',                   count(*)::int FROM public.vehicles              WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'BEFORE', 'visitor_passes',             count(*)::int FROM public.visitor_passes        WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'BEFORE', 'spaces',                     count(*)::int FROM public.spaces                WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'BEFORE', 'space_requests',             count(*)::int FROM public.space_requests        WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'BEFORE', 'guest_authorizations',       count(*)::int FROM public.guest_authorizations  WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'BEFORE', 'violations',                 count(*)::int FROM public.violations            WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'BEFORE', 'vehicle_plate_changes',      count(*)::int FROM public.vehicle_plate_changes WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'BEFORE', 'user_roles(array)',          count(*)::int FROM public.user_roles            WHERE 'Green Acers' = ANY(property) OR 'Green Acers ' = ANY(property)
UNION ALL SELECT 'BEFORE', 'drivers(array)',             count(*)::int FROM public.drivers               WHERE 'Green Acers' = ANY(assigned_properties) OR 'Green Acers ' = ANY(assigned_properties)
ORDER BY 2;


-- ── STEP 2 — APPLY. Single transaction, all-or-nothing. ─────────────
-- Trigger DISABLE + ENABLE inside the txn so any abort restores the
-- lock automatically.

BEGIN;

-- 2a. Disable the rename-block trigger targeted to this txn.
ALTER TABLE public.properties DISABLE TRIGGER trg_properties_name_block_rename;

-- 2b. Parent row (the rename itself).
UPDATE public.properties SET name = 'Green Acres' WHERE id = 143;

-- 2c. Eight scalar-property child tables.
UPDATE public.residents             SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.vehicles              SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.visitor_passes        SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.spaces                SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.space_requests        SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.guest_authorizations  SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.violations            SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.vehicle_plate_changes SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';

-- 2d. user_roles.property (TEXT[] — array_replace, NOT scalar).
--     Two calls to handle both spaced + trimmed historical variants.
UPDATE public.user_roles SET property = array_replace(property, 'Green Acers',  'Green Acres') WHERE 'Green Acers'  = ANY(property);
UPDATE public.user_roles SET property = array_replace(property, 'Green Acers ', 'Green Acres') WHERE 'Green Acers ' = ANY(property);

-- 2e. drivers.assigned_properties (TEXT[] — same shape as user_roles).
UPDATE public.drivers SET assigned_properties = array_replace(assigned_properties, 'Green Acers',  'Green Acres') WHERE 'Green Acers'  = ANY(assigned_properties);
UPDATE public.drivers SET assigned_properties = array_replace(assigned_properties, 'Green Acers ', 'Green Acres') WHERE 'Green Acers ' = ANY(assigned_properties);

-- 2f. Re-enable the rename-block trigger.
ALTER TABLE public.properties ENABLE TRIGGER trg_properties_name_block_rename;

COMMIT;


-- ── STEP 3 — POST-APPLY verify. Expect: Acers count = 0, Acres = PRE-FLIGHT numbers. ──

SELECT 'AFTER-Acers' AS phase, 'properties'          AS tbl, count(*)::int AS n FROM public.properties           WHERE lower(trim(name))     = 'green acers'
UNION ALL SELECT 'AFTER-Acers', 'residents',                  count(*)::int FROM public.residents             WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'AFTER-Acers', 'vehicles',                   count(*)::int FROM public.vehicles              WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'AFTER-Acers', 'visitor_passes',             count(*)::int FROM public.visitor_passes        WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'AFTER-Acers', 'spaces',                     count(*)::int FROM public.spaces                WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'AFTER-Acers', 'space_requests',             count(*)::int FROM public.space_requests        WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'AFTER-Acers', 'guest_authorizations',       count(*)::int FROM public.guest_authorizations  WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'AFTER-Acers', 'violations',                 count(*)::int FROM public.violations            WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'AFTER-Acers', 'vehicle_plate_changes',      count(*)::int FROM public.vehicle_plate_changes WHERE lower(trim(property)) = 'green acers'
UNION ALL SELECT 'AFTER-Acers', 'user_roles(array)',          count(*)::int FROM public.user_roles            WHERE 'Green Acers' = ANY(property) OR 'Green Acers ' = ANY(property)
UNION ALL SELECT 'AFTER-Acers', 'drivers(array)',             count(*)::int FROM public.drivers               WHERE 'Green Acers' = ANY(assigned_properties) OR 'Green Acers ' = ANY(assigned_properties)
UNION ALL
SELECT 'AFTER-Acres',  'properties',                          count(*)::int FROM public.properties           WHERE lower(trim(name))     = 'green acres'
UNION ALL SELECT 'AFTER-Acres', 'residents',                  count(*)::int FROM public.residents             WHERE lower(trim(property)) = 'green acres'
UNION ALL SELECT 'AFTER-Acres', 'vehicles',                   count(*)::int FROM public.vehicles              WHERE lower(trim(property)) = 'green acres'
UNION ALL SELECT 'AFTER-Acres', 'visitor_passes',             count(*)::int FROM public.visitor_passes        WHERE lower(trim(property)) = 'green acres'
UNION ALL SELECT 'AFTER-Acres', 'spaces',                     count(*)::int FROM public.spaces                WHERE lower(trim(property)) = 'green acres'
UNION ALL SELECT 'AFTER-Acres', 'space_requests',             count(*)::int FROM public.space_requests        WHERE lower(trim(property)) = 'green acres'
UNION ALL SELECT 'AFTER-Acres', 'guest_authorizations',       count(*)::int FROM public.guest_authorizations  WHERE lower(trim(property)) = 'green acres'
UNION ALL SELECT 'AFTER-Acres', 'violations',                 count(*)::int FROM public.violations            WHERE lower(trim(property)) = 'green acres'
UNION ALL SELECT 'AFTER-Acres', 'vehicle_plate_changes',      count(*)::int FROM public.vehicle_plate_changes WHERE lower(trim(property)) = 'green acres'
UNION ALL SELECT 'AFTER-Acres', 'user_roles(array)',          count(*)::int FROM public.user_roles            WHERE 'Green Acres' = ANY(property)
UNION ALL SELECT 'AFTER-Acres', 'drivers(array)',             count(*)::int FROM public.drivers               WHERE 'Green Acres' = ANY(assigned_properties)
ORDER BY 1, 2;


-- ── STEP 4 — trigger re-enable verify (belt-and-braces). ────────────
-- COMMIT above should have re-enabled the trigger via step 2f. This
-- SELECT confirms it stayed enabled. A failed txn would have rolled
-- back the DISABLE too — this catches the case where step 2f was
-- somehow skipped.

SELECT tgname, tgenabled
  FROM pg_trigger
 WHERE tgrelid = 'public.properties'::regclass
   AND tgname = 'trg_properties_name_block_rename';
-- Expect: tgenabled = 'O' (enabled).

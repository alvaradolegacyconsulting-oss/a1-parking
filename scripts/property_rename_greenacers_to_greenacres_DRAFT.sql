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
--   • 8 scalar 'property' name-keyed tables (denormalized for RLS)
--   • user_roles.property — TEXT[] array, uses array_replace
--   • drivers.assigned_properties — TEXT[] array (same shape)
--   • properties.name — the rename itself (parent row 143), LAST
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
-- ── 🔴 CHILDREN-FIRST ORDER (the trigger becomes a completeness check) ─
-- trg_properties_name_block_rename fires BEFORE UPDATE OF name on
-- public.properties. Body verified 2026-07-27:
--   • Only fires if NEW.name IS DISTINCT FROM OLD.name
--   • admin-only bypass via get_my_role() = 'admin'
--   • Otherwise counts refs across THREE tables scoped by company:
--       user_roles.property (array), drivers.assigned_properties
--       (array), residents.property (scalar). If refs > 0, REJECTS
--       with "N active user assignments — rename blocked".
--   • v_refs = 0 → allowed for any role ("fresh-creation typo case").
--
-- Green Acers has 6+ residents + 2 assigned managers → v_refs > 0
-- at rest. Supabase SQL editor has no JWT → get_my_role() returns
-- NULL → admin bypass does NOT fire.
--
-- Order below is deliberate: all children UPDATE FIRST (residents,
-- user_roles, drivers, plus the 7 non-trigger-checked scalar tables),
-- THEN properties.name LAST. By the time the parent UPDATE runs,
-- every reference the trigger checks has been moved from OLD.name to
-- NEW.name → v_refs = 0 → trigger permits the rename REGARDLESS of
-- caller role. Fresh-creation typo case.
--
-- 🔴 Why NOT DISABLE the trigger instead:
--   With children-first, the trigger becomes a COMPLETENESS CHECK on
--   our own updates. If we forgot residents, user_roles, or drivers,
--   v_refs comes back non-zero and the transaction ABORTS — telling
--   us we missed a carrier before anything commits. Disabling would
--   throw that away and let a partial rename commit silently. Same
--   principle as the six-site VQs: let the mechanism that already
--   knows the invariant enforce it rather than switching it off.
--
--   Note: the trigger covers only those 3 carriers (residents,
--   user_roles, drivers). The other 5 scalar tables (vehicles,
--   visitor_passes, spaces, space_requests, guest_authorizations,
--   violations, vehicle_plate_changes) still need the post-verify
--   in STEP 3.
--
-- ── Race note ──────────────────────────────────────────────────────
-- A resident registration or a visitor-pass creation committing
-- BETWEEN our child updates and our parent update won't be visible
-- to our transaction's snapshot, so it can leave a straggler row on
-- the old name. STEP 3's AFTER-Acers counts catch this — any non-zero
-- straggler count reads as "expected under concurrent write, fix it
-- with a single follow-up UPDATE" NOT "the migration failed".
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


-- ── STEP 2 — APPLY. Single transaction, children first, parent last. ─

BEGIN;

-- 2a. Children — 8 scalar-property tables. Order within this block
--     doesn't matter (no cross-table constraints referenced).
UPDATE public.residents             SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.vehicles              SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.visitor_passes        SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.spaces                SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.space_requests        SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.guest_authorizations  SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.violations            SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.vehicle_plate_changes SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';

-- 2b. Children — user_roles.property (TEXT[]). Two array_replace calls
--     for spaced + trimmed historical variants. Consulted by trigger.
UPDATE public.user_roles SET property = array_replace(property, 'Green Acers',  'Green Acres') WHERE 'Green Acers'  = ANY(property);
UPDATE public.user_roles SET property = array_replace(property, 'Green Acers ', 'Green Acres') WHERE 'Green Acers ' = ANY(property);

-- 2c. Children — drivers.assigned_properties (TEXT[]). Consulted by
--     trigger. Same shape as user_roles.
UPDATE public.drivers SET assigned_properties = array_replace(assigned_properties, 'Green Acers',  'Green Acres') WHERE 'Green Acers'  = ANY(assigned_properties);
UPDATE public.drivers SET assigned_properties = array_replace(assigned_properties, 'Green Acers ', 'Green Acres') WHERE 'Green Acers ' = ANY(assigned_properties);

-- 2d. Parent — the rename itself. Trigger fires here; by now v_refs = 0
--     across residents + user_roles + drivers, so the rename is allowed
--     for any role. If any child UPDATE above was missed, the trigger
--     aborts the entire transaction — completeness check by construction.
UPDATE public.properties SET name = 'Green Acres' WHERE id = 143;

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

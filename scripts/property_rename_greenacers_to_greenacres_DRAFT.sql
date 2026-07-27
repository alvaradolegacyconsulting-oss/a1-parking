-- ══════════════════════════════════════════════════════════════════════
-- Property rename: "Green Acers" → "Green Acres" (property id 143)
--
-- DRAFT — NOT APPLIED. Jose runs when:
--   0. 🔴 property_name_aliases schema migration APPLIED + VERIFIED
--      (Test-LEGACY probe: alias-add → rename test property → old URL
--      resolves → cleanup). Alias for Green Acers → 143 INSERTED
--      BEFORE this rename runs; printed signage URLs remain functional
--      through the rename window because the RPC's 2-step resolver
--      falls through to the alias.
--   1. A1 confirmed target spelling: "Green Acres" (evidence: PM email
--      Greenacres@kmcmh.com, Google address match, /qr hardcoded array).
--   2. Miramar + Sugarberry disposition known (if all three need
--      rename, add sections at the bottom — same shape, one atomic txn).
--   3. Pre-flight count captured so post-verify numbers are anchored.
--
-- Application discipline (per feedback_sql_editor_partial_apply):
--   • Single paste, single transaction (SQL editor breaks on BEGIN/COMMIT
--     boundaries if pasted piecemeal — one shot).
--   • Editor cleared between (this script must be the only content).
--   • Pre-flight SELECT → APPLY txn → post-verify SELECT, one session.
--
-- Scope (three amendments per Mateo 2026-07-27):
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
ORDER BY 2;


-- ── STEP 2 — APPLY. Single transaction, all-or-nothing. ─────────────

BEGIN;

-- 2a. Parent row (the rename itself).
UPDATE public.properties SET name = 'Green Acres' WHERE id = 143;

-- 2b. Eight scalar-property child tables.
UPDATE public.residents             SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.vehicles              SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.visitor_passes        SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.spaces                SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.space_requests        SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.guest_authorizations  SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.violations            SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';
UPDATE public.vehicle_plate_changes SET property = 'Green Acres' WHERE lower(trim(property)) = 'green acers';

-- 2c. user_roles.property (TEXT[] — array_replace, NOT scalar).
--     Two calls to handle both spaced + trimmed historical variants.
UPDATE public.user_roles SET property = array_replace(property, 'Green Acers',  'Green Acres') WHERE 'Green Acers'  = ANY(property);
UPDATE public.user_roles SET property = array_replace(property, 'Green Acers ', 'Green Acres') WHERE 'Green Acers ' = ANY(property);

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
ORDER BY 1, 2;


-- ══════════════════════════════════════════════════════════════════════
-- TEMPLATE — extend to Miramar / Sugarberry if A1 confirms rename for them
-- ══════════════════════════════════════════════════════════════════════
-- Copy step 2 block above; substitute:
--   • WHERE id = <target_property_id>  in the properties UPDATE
--   • 'Green Acers' → <old spelling>   in every child UPDATE + user_roles
--   • 'Green Acres' → <new spelling>   in every child UPDATE + user_roles
-- Then extend steps 1 + 3 to include the additional properties.
--
-- Doing all three in one BEGIN/COMMIT is atomic and preferable to three
-- separate transactions (single source of truth for the correction window).
-- ══════════════════════════════════════════════════════════════════════

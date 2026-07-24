-- ═══════════════════════════════════════════════════════════════════════
-- 20260724_pm_plate_lookup_viewing_property_diagnostic.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Pre-apply diagnostic for
-- 20260724_pm_plate_lookup_viewing_property.sql.
--
-- ── Why this is a file, not a chat query ──────────────────────────────
-- Per the 9th codified discipline (2026-07-24): diagnostics ship as
-- files. Pasting from chat has now cost two consecutive negative-control
-- captures — AP-CATEGORY (migration applied before the pre-apply pass
-- ran) and this migration (wrong content pasted from a markdown
-- message, `syntax error at or near "#"`). Three files (diagnostic,
-- migration, verification), three identical pastes from VS Code, one
-- source.
--
-- ── Run motion ────────────────────────────────────────────────────────
--   1. Paste this file → capture the returned jsonb
--   2. Paste 20260724_pm_plate_lookup_viewing_property.sql → apply
--   3. Paste this file AGAIN → capture the returned jsonb
--   4. Paste 20260724_pm_plate_lookup_viewing_property_verification.sql
--      → expect fully silent
--
-- Read-only; safe to re-run any number of times. No RAISE, nothing
-- aborts — the transaction-wrap that makes the verification file
-- correct post-apply is exactly what makes it wrong for pre-apply.
--
-- ── Expected pre-apply ────────────────────────────────────────────────
--   {
--     "has_param": false,
--     "predicate_count": 0,
--     "ap_call_still_null": true,
--     "proc_count": 1,
--     "dnt_p_company_present": true,
--     "lifecycle_present": true
--   }
--
-- Every false/0/true captured pre-apply is a validated detector — the
-- assertion has been observed against the state it exists to catch.
-- The two invariants (dnt_p_company_present, lifecycle_present) hold
-- both pre and post; observing them pre is what makes their post-apply
-- truth meaningful (rules out "it was always true regardless of the
-- rewrite").
--
-- ── Expected post-apply ───────────────────────────────────────────────
--   {
--     "has_param": true,
--     "predicate_count": 6,
--     "ap_call_still_null": false,
--     "proc_count": 1,
--     "dnt_p_company_present": true,
--     "lifecycle_present": true
--   }
--
-- Four detectors flip · two invariants hold. If any diverges, stop
-- and investigate before running the verification file.

SELECT jsonb_pretty(jsonb_build_object(
  'has_param',              (SELECT pg_get_functiondef(oid) LIKE '%p_viewing_property%'
     FROM pg_proc WHERE proname='pm_plate_lookup' AND pronamespace='public'::regnamespace),
  'predicate_count',        (SELECT (length(pg_get_functiondef(oid))
                                     - length(replace(pg_get_functiondef(oid), 'p_viewing_property IS NULL OR', '')))
                                     / length('p_viewing_property IS NULL OR')
     FROM pg_proc WHERE proname='pm_plate_lookup' AND pronamespace='public'::regnamespace),
  'ap_call_still_null',     (SELECT pg_get_functiondef(oid) LIKE '%check_authorized_plate(v_normalized, NULL)%'
     FROM pg_proc WHERE proname='pm_plate_lookup' AND pronamespace='public'::regnamespace),
  'proc_count',             (SELECT count(*) FROM pg_proc
     WHERE proname='pm_plate_lookup' AND pronamespace='public'::regnamespace),
  -- Preservation invariants (B2) — must be true BOTH pre and post
  'dnt_p_company_present',  (SELECT pg_get_functiondef(oid) LIKE '%lower(trim(dnt_p.company))%'
     FROM pg_proc WHERE proname='pm_plate_lookup' AND pronamespace='public'::regnamespace),
  'lifecycle_present',      (SELECT pg_get_functiondef(oid) LIKE '%removed_at IS NULL%'
     FROM pg_proc WHERE proname='pm_plate_lookup' AND pronamespace='public'::regnamespace)
));

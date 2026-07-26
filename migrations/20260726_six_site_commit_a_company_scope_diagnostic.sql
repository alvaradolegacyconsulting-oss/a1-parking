-- ═══════════════════════════════════════════════════════════════════════
-- 20260726_six_site_commit_a_company_scope_diagnostic.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Pre/post-apply diagnostic per 9th discipline. 10 detectors (6 flip + 4
-- preservation invariants) covering all 6 sites + DNT-guard preservation
-- across the three tow-path functions.
--
-- ── Run motion ────────────────────────────────────────────────────────
--   1. Paste this file → capture the returned jsonb (PRE)
--   2. Paste 20260726_six_site_commit_a_company_scope.sql → apply
--   3. Paste this file AGAIN → capture (POST)
--   4. Paste 20260726_six_site_commit_a_company_scope_verification.sql
--      → expect fully silent
--
-- ── Expected pre-apply ────────────────────────────────────────────────
--   {
--     "wildcard_count_total":              6,
--     "A1_set_violation_status":           false,
--     "A2_regenerate_violation":           false,
--     "A3_regenerate_storage":             false,
--     "A4_stamp_violation":                false,
--     "A5_stamp_storage":                  false,
--     "A6_stamp_manager_property":         false,
--     "preserved_set_violation_dnt_guard": true,
--     "preserved_stamp_dnt_guard":         true,
--     "preserved_regenerate_dnt_guard":    true
--   }
--
-- ── Expected post-apply ───────────────────────────────────────────────
--   {
--     "wildcard_count_total":              0,
--     "A1_set_violation_status":           true,
--     "A2_regenerate_violation":           true,
--     "A3_regenerate_storage":             true,
--     "A4_stamp_violation":                true,
--     "A5_stamp_storage":                  true,
--     "A6_stamp_manager_property":         true,
--     "preserved_set_violation_dnt_guard": true,
--     "preserved_stamp_dnt_guard":         true,
--     "preserved_regenerate_dnt_guard":    true
--   }
--
-- Seven detectors flip · three preservation invariants hold across
-- pre + post.
-- ═══════════════════════════════════════════════════════════════════════

SELECT jsonb_pretty(jsonb_build_object(
  -- COUNT DETECTOR — sum of ~~* occurrences across the three functions.
  -- Post-apply must be 0. A missed site fails count without needing
  -- per-site coverage of every conceivable predicate variant.
  'wildcard_count_total',
    (SELECT COALESCE(SUM(
       (length(pg_get_functiondef(oid)) - length(replace(pg_get_functiondef(oid), '~~*', ''))) / length('~~*')
     ), 0)
     FROM pg_proc
     WHERE pronamespace='public'::regnamespace
       AND proname IN ('set_violation_status','stamp_tow_ticket','regenerate_tow_ticket')),

  -- SHAPE 1 — 5 company-equality sites present (one per fixed site).
  -- Each match is deliberately narrow enough to differentiate from
  -- the DNT-guard's `lower(trim(dnt_p.company))` pattern which is
  -- preserved separately below.
  'A1_set_violation_status',
    (SELECT pg_get_functiondef(oid) LIKE '%lower(trim(p.company)) = lower(trim(v_caller_company))%AND p.name = v_row.property%'
     FROM pg_proc WHERE proname='set_violation_status' AND pronamespace='public'::regnamespace),
  'A2_regenerate_violation',
    (SELECT pg_get_functiondef(oid) LIKE '%lower(trim(p.company)) = lower(trim(v_caller_company))%AND p.name = v_original.property%'
     FROM pg_proc WHERE proname='regenerate_tow_ticket' AND pronamespace='public'::regnamespace),
  'A3_regenerate_storage',
    (SELECT pg_get_functiondef(oid) LIKE '%NOT (lower(trim(v_storage.company)) = lower(trim(v_caller_company)))%'
     FROM pg_proc WHERE proname='regenerate_tow_ticket' AND pronamespace='public'::regnamespace),
  'A4_stamp_violation',
    (SELECT pg_get_functiondef(oid) LIKE '%p.name = v_row.property%lower(trim(p.company)) = lower(trim(v_company))%'
     FROM pg_proc WHERE proname='stamp_tow_ticket' AND pronamespace='public'::regnamespace),
  'A5_stamp_storage',
    (SELECT pg_get_functiondef(oid) LIKE '%NOT (lower(trim(v_storage.company)) = lower(trim(v_company)))%'
     FROM pg_proc WHERE proname='stamp_tow_ticket' AND pronamespace='public'::regnamespace),

  -- SHAPE 2 — 1 property-equality site (stamp_tow_ticket manager branch).
  -- NO company predicate here — get_my_properties() is already scoped.
  'A6_stamp_manager_property',
    (SELECT pg_get_functiondef(oid) LIKE '%unnest(v_properties) p%lower(trim(v_row.property)) = lower(trim(p))%'
     FROM pg_proc WHERE proname='stamp_tow_ticket' AND pronamespace='public'::regnamespace),

  -- PRESERVATION — DNT canonical guard blocks byte-identical (per function).
  -- Distinctive substring: the guard's specific comparison + error string.
  'preserved_set_violation_dnt_guard',
    (SELECT pg_get_functiondef(oid) LIKE '%lower(trim(dnt_p.company)) = lower(trim(get_my_company()))%do_not_tow_active%'
     FROM pg_proc WHERE proname='set_violation_status' AND pronamespace='public'::regnamespace),
  'preserved_stamp_dnt_guard',
    (SELECT pg_get_functiondef(oid) LIKE '%lower(trim(dnt_p.company)) = lower(trim(get_my_company()))%do_not_tow_active%'
     FROM pg_proc WHERE proname='stamp_tow_ticket' AND pronamespace='public'::regnamespace),
  'preserved_regenerate_dnt_guard',
    (SELECT pg_get_functiondef(oid) LIKE '%lower(trim(dnt_p.company)) = lower(trim(get_my_company()))%do_not_tow_active%'
     FROM pg_proc WHERE proname='regenerate_tow_ticket' AND pronamespace='public'::regnamespace)
));

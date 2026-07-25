-- ═══════════════════════════════════════════════════════════════════════
-- 20260725_submit_space_request_attach_hardening_diagnostic.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Pre/post-apply read-only diagnostic per 9th discipline. Nine detectors
-- (six flip + three preservation invariants) covering FUNCTION + INDEX.
--
-- ── Run motion ────────────────────────────────────────────────────────
--   1. Paste this file → capture the returned jsonb
--   2. Paste 20260725_submit_space_request_attach_hardening.sql → apply
--   3. Paste this file AGAIN → capture the returned jsonb (post)
--   4. Paste 20260725_submit_space_request_attach_hardening_verification.sql
--      → expect fully silent
--
-- ── Expected pre-apply ────────────────────────────────────────────────
--   {
--     "has_residency_property_binding":  false,
--     "has_order_by":                     false,
--     "has_pending_property_binding":     false,
--     "has_new_error_string":             false,
--     "old_index_email_only_present":     true,
--     "new_index_email_property_present": false,
--     "proc_count":                       1,
--     "signature_preserved":              true,
--     "role_gate_present":                true
--   }
--
-- ── Expected post-apply ───────────────────────────────────────────────
--   {
--     "has_residency_property_binding":  true,
--     "has_order_by":                     true,
--     "has_pending_property_binding":     true,
--     "has_new_error_string":             true,
--     "old_index_email_only_present":     false,
--     "new_index_email_property_present": true,
--     "proc_count":                       1,
--     "signature_preserved":              true,
--     "role_gate_present":                true
--   }
--
-- Six detectors flip · three invariants hold (proc_count, signature, role_gate).

SELECT jsonb_pretty(jsonb_build_object(
  -- Function body detectors
  'has_residency_property_binding',
    (SELECT (regexp_matches(pg_get_functiondef(oid), 'WHERE lower\(email\) = v_caller_email\s+AND lower\(trim\(property\)\)'))[1] IS NOT NULL
       FROM pg_proc WHERE proname='submit_space_request' AND pronamespace='public'::regnamespace),
  'has_order_by',
    (SELECT pg_get_functiondef(oid) LIKE '%ORDER BY id DESC%'
       FROM pg_proc WHERE proname='submit_space_request' AND pronamespace='public'::regnamespace),
  'has_pending_property_binding',
    (SELECT (regexp_matches(pg_get_functiondef(oid), 'FROM public\.space_requests\s+WHERE lower\(resident_email\) = v_caller_email\s+AND lower\(trim\(property\)\)'))[1] IS NOT NULL
       FROM pg_proc WHERE proname='submit_space_request' AND pronamespace='public'::regnamespace),
  'has_new_error_string',
    (SELECT pg_get_functiondef(oid) LIKE '%no_residency_at_property%'
       FROM pg_proc WHERE proname='submit_space_request' AND pronamespace='public'::regnamespace),
  -- Index detectors
  'old_index_email_only_present',
    (SELECT EXISTS(SELECT 1 FROM pg_indexes
                    WHERE schemaname='public' AND tablename='space_requests'
                      AND indexname='space_requests_one_pending_per_resident')),
  'new_index_email_property_present',
    (SELECT EXISTS(SELECT 1 FROM pg_indexes
                    WHERE schemaname='public' AND tablename='space_requests'
                      AND indexname='space_requests_one_pending_per_resident_property')),
  -- Invariants (hold BOTH pre and post)
  'proc_count',
    (SELECT count(*) FROM pg_proc
       WHERE proname='submit_space_request' AND pronamespace='public'::regnamespace),
  'signature_preserved',
    (SELECT pg_get_function_arguments(oid) = 'p_property text, p_note text DEFAULT NULL::text'
       FROM pg_proc WHERE proname='submit_space_request' AND pronamespace='public'::regnamespace),
  'role_gate_present',
    (SELECT pg_get_functiondef(oid) LIKE '%v_caller_role <> ''resident''%'
       FROM pg_proc WHERE proname='submit_space_request' AND pronamespace='public'::regnamespace)
));

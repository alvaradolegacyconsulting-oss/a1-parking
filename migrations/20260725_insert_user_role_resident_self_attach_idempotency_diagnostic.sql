-- ═══════════════════════════════════════════════════════════════════════
-- 20260725_insert_user_role_resident_self_attach_idempotency_diagnostic.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Pre/post-apply readout per 9th discipline. 4 detectors (2 flip + 2 invariants).
--
-- ── Run motion ────────────────────────────────────────────────────────
--   1. Paste this file → capture the returned jsonb
--   2. Paste 20260725_insert_user_role_resident_self_attach_idempotency.sql → apply
--   3. Paste this file AGAIN → capture (post)
--   4. Paste 20260725_insert_user_role_resident_self_attach_idempotency_verification.sql
--      → expect fully silent
--
-- ── Expected pre-apply ────────────────────────────────────────────────
--   {
--     "has_idempotency_branch":       false,
--     "has_matching_normalization":   false,
--     "signature_preserved":          true,
--     "else_deny_preserved":          true
--   }
--
-- ── Expected post-apply ───────────────────────────────────────────────
--   {
--     "has_idempotency_branch":       true,
--     "has_matching_normalization":   true,
--     "signature_preserved":          true,
--     "else_deny_preserved":          true
--   }
--
-- Two detectors flip · two invariants hold.

SELECT jsonb_pretty(jsonb_build_object(
  'has_idempotency_branch',
    (SELECT (regexp_matches(pg_get_functiondef(oid), 'v_caller_role = ''resident''\s+AND p_role = ''resident'''))[1] IS NOT NULL
       FROM pg_proc WHERE proname='insert_user_role' AND pronamespace='public'::regnamespace),
  'has_matching_normalization',
    (SELECT pg_get_functiondef(oid) LIKE '%lower(email) = lower(v_caller_email)%'
       FROM pg_proc WHERE proname='insert_user_role' AND pronamespace='public'::regnamespace),
  -- Invariants
  'signature_preserved',
    (SELECT pg_get_function_arguments(oid) = 'p_email text, p_role text, p_company text, p_property text[], p_name text DEFAULT NULL::text'
       FROM pg_proc WHERE proname='insert_user_role' AND pronamespace='public'::regnamespace),
  'else_deny_preserved',
    (SELECT pg_get_functiondef(oid) LIKE '%caller_role_not_authorized%'
       FROM pg_proc WHERE proname='insert_user_role' AND pronamespace='public'::regnamespace)
));

-- ════════════════════════════════════════════════════════════════════
-- redeem_proposal_code Texas attestation — VERIFICATION
-- 2026-06-30
-- ════════════════════════════════════════════════════════════════════

-- §1 — exactly one redeem_proposal_code overload (no trap)
SELECT
  '§1 — pg_proc count'                                                  AS check_name,
  COUNT(*)                                                              AS count,
  CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL — overload' END         AS verdict
FROM pg_proc
WHERE proname = 'redeem_proposal_code'
  AND pronamespace = 'public'::regnamespace;

-- §1b — function shape (DEFINER, search_path pinned)
SELECT
  '§1b — function shape'                                               AS check_name,
  proname,
  prosecdef                                                            AS definer,
  proconfig::TEXT LIKE '%search_path=public%'                          AS search_path_pinned,
  CASE WHEN prosecdef = TRUE
        AND proconfig::TEXT LIKE '%search_path=public%'
       THEN 'PASS' ELSE 'FAIL' END                                     AS verdict
FROM pg_proc
WHERE proname = 'redeem_proposal_code'
  AND pronamespace = 'public'::regnamespace;

-- §2 — grants (authenticated=X only)
SELECT
  '§2 — proacl'                                                         AS check_name,
  proname,
  pg_catalog.array_to_string(proacl, ',')                               AS proacl,
  CASE
    WHEN pg_catalog.array_to_string(proacl, ',') LIKE '%authenticated=X%'
     AND pg_catalog.array_to_string(proacl, ',') NOT LIKE '%anon=X%'
     AND pg_catalog.array_to_string(proacl, ',') NOT LIKE '%service_role=X%'
    THEN 'PASS'
    ELSE 'FAIL'
  END                                                                   AS verdict
FROM pg_proc
WHERE proname = 'redeem_proposal_code'
  AND pronamespace = 'public'::regnamespace;

-- §3 — audit row landed
SELECT
  '§3 — audit row'                                                      AS check_name,
  count(*)                                                              AS rows_found,
  CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END                   AS verdict
FROM public.audit_logs
WHERE action     = 'SCHEMA_REDEEM_TEXAS_ATTESTATION'
  AND new_values->>'migration' = '20260630_redeem_texas_attestation';

-- §4 — APP-LEVEL smoke prompts:
--   §4a — A1-shaped redeem: generate a fresh proposal code → sign up via
--         /signup/redeem → verify email → /signup/redeem/verify → check
--         Texas checkbox + ToS checkbox → Activate. Then:
--           SELECT document_type, attestation_version, tos_version,
--                  privacy_version
--             FROM tos_acceptances WHERE company_id = <new_company_id>;
--         Expect TWO rows:
--           - document_type='tos_and_privacy', tos+privacy populated
--           - document_type='texas_attestation', attestation_version set
--   §4b — Backward compatibility: passing p_attestation_version=NULL
--         (or omitting it via positional/named call) writes ONLY the
--         tos_and_privacy row — no texas_attestation row. This proves
--         the existing /signup self-serve path isn't disturbed if it
--         ever called this RPC without Texas (it doesn't today, but
--         the safety net matters).
--   §4c — Activate button stays disabled until BOTH checkboxes are
--         checked (existing tosChecked + new attestChecked gate).

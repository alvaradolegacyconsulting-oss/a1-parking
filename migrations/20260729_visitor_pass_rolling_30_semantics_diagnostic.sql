-- ══════════════════════════════════════════════════════════════════════
-- 20260729_visitor_pass_rolling_30_semantics_diagnostic.sql
-- Pre/post-apply detectors. Run twice — expect flips on 8 detectors.
--
-- ── 2026-07-29 v2 — whitespace-normalized ────────────────────────────
-- Detectors below normalize the deparsed function bodies (regexp_replace
-- '\s+' → ' ') so indentation / line-wrap variations can't false-fail
-- them. Same discipline shipped in the verification file's v2.
--
-- ── Expected pre-apply ────────────────────────────────────────────
--   {
--     "enforce_old_predicate_present":  true,   -- 'expires_at' anywhere
--     "enforce_new_predicate_present":  false,  -- 'created_at + 30 days'
--     "enforce_hint_new":               false,  -- new HINT copy
--     "rpc_old_predicate_present":      true,
--     "rpc_new_predicate_present":      false,
--     "rpc_has_v_is_anon":              false,
--     "rpc_gated_exit_count":           0,      -- expect 2 post-apply
--     "rpc_has_at_limit_gated_shape":   false,  -- THEN ... 'at_limit' ELSE
--     "rpc_has_within_gated_shape":     false,
--     "grants_preserved":               true    -- anon+authenticated on RPC
--   }
--
-- ── Expected post-apply ───────────────────────────────────────────
--   {
--     "enforce_old_predicate_present":  false,
--     "enforce_new_predicate_present":  true,
--     "enforce_hint_new":               true,
--     "rpc_old_predicate_present":      false,
--     "rpc_new_predicate_present":      true,
--     "rpc_has_v_is_anon":              true,
--     "rpc_gated_exit_count":           2,
--     "rpc_has_at_limit_gated_shape":   true,
--     "rpc_has_within_gated_shape":     true,
--     "grants_preserved":               true
--   }
--
-- 8 detectors flip. `grants_preserved` invariant across the pass;
-- `rpc_gated_exit_count` moves from 0 → 2.
-- ══════════════════════════════════════════════════════════════════════

WITH
enforce_def AS (
  SELECT regexp_replace(pg_get_functiondef(oid), '\s+', ' ', 'g') AS body
    FROM pg_proc
   WHERE proname = 'enforce_visitor_pass_limit'
     AND pronamespace = 'public'::regnamespace
),
rpc_def AS (
  SELECT regexp_replace(pg_get_functiondef(oid), '\s+', ' ', 'g') AS body
    FROM pg_proc
   WHERE proname = 'get_plate_pass_status'
     AND pronamespace = 'public'::regnamespace
)
SELECT jsonb_pretty(jsonb_build_object(
  'enforce_old_predicate_present',
    (SELECT body ILIKE '%expires_at%' FROM enforce_def),
  'enforce_new_predicate_present',
    (SELECT body ILIKE '%created_at%interval%30 days%' FROM enforce_def),
  'enforce_hint_new',
    (SELECT body ILIKE '%Contact the property manager if you need access%' FROM enforce_def),
  'rpc_old_predicate_present',
    (SELECT body ILIKE '%expires_at%' FROM rpc_def),
  'rpc_new_predicate_present',
    (SELECT body ILIKE '%created_at%interval%30 days%' FROM rpc_def),
  'rpc_has_v_is_anon',
    (SELECT body ILIKE '%v_is_anon := (auth.uid() IS NULL)%' FROM rpc_def),
  'rpc_gated_exit_count',
    (SELECT (length(body) - length(replace(body, 'CASE WHEN v_is_anon', '')))
              / length('CASE WHEN v_is_anon')
       FROM rpc_def),
  'rpc_has_at_limit_gated_shape',
    (SELECT body LIKE '%THEN jsonb_build_object(''state'', ''at_limit'') ELSE%' FROM rpc_def),
  'rpc_has_within_gated_shape',
    (SELECT body LIKE '%THEN jsonb_build_object(''state'', ''within'') ELSE%' FROM rpc_def),
  'grants_preserved',
    (has_function_privilege('anon',          'public.get_plate_pass_status(text,text)', 'EXECUTE')
 AND has_function_privilege('authenticated', 'public.get_plate_pass_status(text,text)', 'EXECUTE'))
));

-- ══════════════════════════════════════════════════════════════════════
-- 20260729_visitor_pass_rolling_30_semantics_diagnostic.sql
-- Pre/post-apply detectors. Run twice — expect flips on 8 detectors.
--
-- ── Expected pre-apply ────────────────────────────────────────────
--   {
--     "enforce_predicate_old":        true,   -- is_active + expires_at
--     "enforce_predicate_new":        false,  -- created_at 30-day window
--     "enforce_hint_new":             false,  -- new HINT copy
--     "rpc_predicate_old":            true,
--     "rpc_predicate_new":            false,
--     "rpc_has_v_is_anon":            false,
--     "rpc_at_limit_gated":           false,  -- v_is_anon at at_limit exit
--     "rpc_within_gated":             false,  -- v_is_anon at within exit
--     "grants_preserved":             true    -- anon+authenticated on RPC
--   }
--
-- ── Expected post-apply ───────────────────────────────────────────
--   {
--     "enforce_predicate_old":        false,
--     "enforce_predicate_new":        true,
--     "enforce_hint_new":             true,
--     "rpc_predicate_old":            false,
--     "rpc_predicate_new":            true,
--     "rpc_has_v_is_anon":            true,
--     "rpc_at_limit_gated":           true,
--     "rpc_within_gated":             true,
--     "grants_preserved":             true    -- invariant across the pass
--   }
--
-- 8 detectors flip. `grants_preserved` is invariant — CREATE OR REPLACE
-- retains grants; if this ever comes back false, someone converted to
-- DROP+CREATE and forgot to re-grant.
-- ══════════════════════════════════════════════════════════════════════

SELECT jsonb_pretty(jsonb_build_object(
  'enforce_predicate_old',
    (SELECT pg_get_functiondef(oid) ILIKE '%is_active = TRUE%expires_at > now()%'
       FROM pg_proc
      WHERE proname = 'enforce_visitor_pass_limit'
        AND pronamespace = 'public'::regnamespace),
  'enforce_predicate_new',
    (SELECT pg_get_functiondef(oid) ILIKE '%created_at > now() - interval%30 days%'
       FROM pg_proc
      WHERE proname = 'enforce_visitor_pass_limit'
        AND pronamespace = 'public'::regnamespace),
  'enforce_hint_new',
    (SELECT pg_get_functiondef(oid) ILIKE '%Contact the property manager if you need access%'
       FROM pg_proc
      WHERE proname = 'enforce_visitor_pass_limit'
        AND pronamespace = 'public'::regnamespace),
  'rpc_predicate_old',
    (SELECT pg_get_functiondef(oid) ILIKE '%is_active = TRUE%expires_at > now()%'
       FROM pg_proc
      WHERE proname = 'get_plate_pass_status'
        AND pronamespace = 'public'::regnamespace),
  'rpc_predicate_new',
    (SELECT pg_get_functiondef(oid) ILIKE '%created_at > now() - interval%30 days%'
       FROM pg_proc
      WHERE proname = 'get_plate_pass_status'
        AND pronamespace = 'public'::regnamespace),
  'rpc_has_v_is_anon',
    (SELECT pg_get_functiondef(oid) ILIKE '%v_is_anon%auth.uid() IS NULL%'
       FROM pg_proc
      WHERE proname = 'get_plate_pass_status'
        AND pronamespace = 'public'::regnamespace),
  'rpc_at_limit_gated',
    (SELECT pg_get_functiondef(oid) ILIKE '%at_limit%CASE WHEN v_is_anon%'
       FROM pg_proc
      WHERE proname = 'get_plate_pass_status'
        AND pronamespace = 'public'::regnamespace),
  'rpc_within_gated',
    (SELECT pg_get_functiondef(oid) ILIKE '%within%CASE WHEN v_is_anon%'
       FROM pg_proc
      WHERE proname = 'get_plate_pass_status'
        AND pronamespace = 'public'::regnamespace),
  'grants_preserved',
    (has_function_privilege('anon',          'public.get_plate_pass_status(text,text)', 'EXECUTE')
 AND has_function_privilege('authenticated', 'public.get_plate_pass_status(text,text)', 'EXECUTE'))
));

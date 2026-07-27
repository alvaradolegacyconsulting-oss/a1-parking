-- ══════════════════════════════════════════════════════════════════════
-- 20260728_property_name_aliases_schema_diagnostic.sql
-- Pre/post-apply detectors. Run twice — expect flips on 6 detectors.
--
-- ── Run motion ──────────────────────────────────────────────────────
--   1. Paste this file → capture jsonb (PRE)
--   2. Paste 20260728_property_name_aliases_schema.sql → apply
--   3. Paste this file AGAIN → capture (POST)
--   4. Paste 20260728_property_name_aliases_schema_verification.sql
--      → expect fully silent
--
-- ── Expected pre-apply ──────────────────────────────────────────────
--   {
--     "table_exists":             false,
--     "unique_index_exists":      false,
--     "no_shadow_trigger_exists": false,
--     "rpc_has_alias_cte":        false,
--     "rpc_overload_count":       1,
--     "rls_enabled":              false
--   }
--
-- ── Expected post-apply ─────────────────────────────────────────────
--   {
--     "table_exists":             true,
--     "unique_index_exists":      true,
--     "no_shadow_trigger_exists": true,
--     "rpc_has_alias_cte":        true,
--     "rpc_overload_count":       1,
--     "rls_enabled":              true
--   }
--
-- Five detectors flip. Overload count invariant (stays at 1 pre + post).
-- ══════════════════════════════════════════════════════════════════════

SELECT jsonb_pretty(jsonb_build_object(
  'table_exists',
    EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'property_name_aliases'
    ),
  'unique_index_exists',
    EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'property_name_aliases'
         AND indexname = 'property_name_aliases_alias_uidx'
    ),
  'no_shadow_trigger_exists',
    EXISTS (
      SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'property_name_aliases'
         AND t.tgname = 'property_name_alias_no_shadow_biu'
         AND NOT t.tgisinternal
    ),
  'rpc_has_alias_cte',
    (SELECT pg_get_functiondef(oid) ILIKE '%aliased AS%property_name_aliases%'
       FROM pg_proc
      WHERE proname = 'get_property_for_visitor'
        AND pronamespace = 'public'::regnamespace),
  'rpc_overload_count',
    (SELECT count(*)::int
       FROM pg_proc
      WHERE proname = 'get_property_for_visitor'
        AND pronamespace = 'public'::regnamespace),
  'rls_enabled',
    (SELECT COALESCE(c.relrowsecurity, FALSE)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'property_name_aliases')
));

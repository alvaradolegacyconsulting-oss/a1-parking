-- ══════════════════════════════════════════════════════════════════════
-- 20260728_property_name_aliases_schema_verification.sql
-- Post-apply structural verification. Silent success = PASS.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_def_rpc TEXT;
BEGIN
  -- ── VQ.TABLE — property_name_aliases exists ──
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'property_name_aliases'
  ) THEN
    RAISE EXCEPTION 'VQ.TABLE FAILED — property_name_aliases table does not exist';
  END IF;

  -- ── VQ.UNIQ — unique index on lower(trim(alias)) exists ──
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'property_name_aliases'
       AND indexname = 'property_name_aliases_alias_uidx'
  ) THEN
    RAISE EXCEPTION 'VQ.UNIQ FAILED — property_name_aliases_alias_uidx unique index missing';
  END IF;

  -- ── VQ.TRIG — no-shadow trigger exists ──
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'property_name_aliases'
       AND t.tgname = 'property_name_alias_no_shadow_biu'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'VQ.TRIG FAILED — property_name_alias_no_shadow_biu trigger missing';
  END IF;

  -- ── VQ.RPC_CTE — get_property_for_visitor body contains the alias CTE ──
  SELECT pg_get_functiondef(oid) INTO v_def_rpc
    FROM pg_proc
   WHERE proname = 'get_property_for_visitor'
     AND pronamespace = 'public'::regnamespace;
  IF v_def_rpc NOT ILIKE '%aliased AS%property_name_aliases%' THEN
    RAISE EXCEPTION 'VQ.RPC_CTE FAILED — get_property_for_visitor does not contain alias CTE';
  END IF;

  -- ── VQ.RPC_SIG — exactly 1 overload (no overload trap) ──
  IF (SELECT count(*) FROM pg_proc
       WHERE proname = 'get_property_for_visitor'
         AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'VQ.RPC_SIG FAILED — get_property_for_visitor not exactly 1 overload';
  END IF;

  -- ── VQ.RLS — RLS enabled on property_name_aliases ──
  IF NOT COALESCE((
    SELECT c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'property_name_aliases'
  ), FALSE) THEN
    RAISE EXCEPTION 'VQ.RLS FAILED — property_name_aliases does not have RLS enabled';
  END IF;

  -- ── VQ.GRANTS — anon + authenticated retain EXECUTE on the RPC ──
  IF NOT has_function_privilege('anon', 'public.get_property_for_visitor(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAILED — anon lost EXECUTE on get_property_for_visitor after DROP+CREATE';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_property_for_visitor(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAILED — authenticated lost EXECUTE on get_property_for_visitor after DROP+CREATE';
  END IF;
END $$;

COMMIT;

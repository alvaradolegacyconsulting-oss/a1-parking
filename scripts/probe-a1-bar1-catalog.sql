-- ═══════════════════════════════════════════════════════════════════
-- A1 Bar 1 catalog dump — paste into Supabase SQL Editor, single-run.
-- Returns 4 result sets (one per table). The Node probe script reads
-- column NAMES via .select('*').limit(1) but cannot reach
-- information_schema, so this dump surfaces data_type + nullability +
-- defaults that the Node side can't see.
--
-- USE: sanity-check the probe script's assertions against the real
-- column types here. Flag any column the probe writes/reads that
-- doesn't appear in this dump.
-- ═══════════════════════════════════════════════════════════════════

-- residents
SELECT 'residents' AS table_name, column_name, data_type, is_nullable, column_default, ordinal_position
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'residents'
 ORDER BY ordinal_position;

-- vehicles
SELECT 'vehicles' AS table_name, column_name, data_type, is_nullable, column_default, ordinal_position
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'vehicles'
 ORDER BY ordinal_position;

-- drivers
SELECT 'drivers' AS table_name, column_name, data_type, is_nullable, column_default, ordinal_position
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'drivers'
 ORDER BY ordinal_position;

-- user_roles
SELECT 'user_roles' AS table_name, column_name, data_type, is_nullable, column_default, ordinal_position
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'user_roles'
 ORDER BY ordinal_position;

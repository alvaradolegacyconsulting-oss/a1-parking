-- ════════════════════════════════════════════════════════════════════
-- seed_test_tenants — NEW RPC · seed/wipe Layer 2
-- 2026-07-11 · Post-launch parallel build
--
-- WHY
--   Post-launch we need reproducible test + demo tenants that (a) look
--   like real customers (proper tier + tier_type, features unlocked
--   via TIER_CONFIG) but (b) NEVER create Stripe artifacts and (c)
--   are structurally invisible to billing / dunning / webhooks (all
--   guarded on company_env='production').
--
--   Layer 1 (20260708_seed_wipe_layer1_company_env.sql) added the
--   company_env enum. Layer 2 is this: a SECURITY DEFINER RPC that
--   seeds 3 test companies + 1 demo, their user_roles, and a
--   property per company. Called by
--   scripts/seed-test-tenants-ONE-TIME.ts which handles the
--   auth.users half (createUser via admin API — email_confirm=true,
--   shared password from env).
--
--   Companies: Test-PM (pm_only) · Test-ENF (enforcement_only) ·
--              Test-LEGACY (legacy) · Demo Company (legacy for the
--              two-track showcase, per Jose 2026-07-11).
--
-- SHAPE (per Jose's report-first Q1-Q5 answers)
--   • Tier direct in DB — no stripe_customer_id, no
--     stripe_subscription_id populated. All 6 Stripe webhook handlers
--     + dunning cron filter on company_env='production' so test/demo
--     rows are structurally invisible even if Stripe IDs somehow
--     leaked in.
--   • Feature entitlement is pure TIER_CONFIG lookup (no Stripe read
--     in hasFeature()). Test Legacy CA sees Legacy features on first
--     login.
--   • Idempotent: SELECT-then-INSERT for companies + properties;
--     ON CONFLICT (lower(email)) DO NOTHING for user_roles (backed by
--     user_roles_lower_email_uidx). Re-runs skip existing rows;
--     zero 23505.
--   • Guard 1: every company lookup is scoped to
--     WHERE name = ? AND company_env = ?.
--   • Guard 2: never UPDATE an existing company row — SELECT-then-
--     conditional-INSERT only.
--   • Guard 3: pre-flight assertion — if any production row already
--     uses a seeded name, refuse. Cheap belt-and-suspenders.
--
-- WHAT IT DOES NOT DO
--   • auth.users creation (API-side; TS script handles).
--   • residents / vehicles / violations / spaces seed. v1 minimal:
--     empty properties. Manager can bulk-add spaces to exercise
--     the generate_spaces_from_pool path (which is exactly the
--     surface we most want tested).
--   • password handling — password comes from
--     scripts/seed-test-tenants-ONE-TIME.ts via SEED_TEST_PASSWORD env.
--
-- GRANTS
--   PUBLIC + anon + authenticated all revoked. service_role only.
--   Not exposed as a client-callable API — the TS script uses the
--   service key.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.seed_test_tenants()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_pm_id      BIGINT;
  v_enf_id     BIGINT;
  v_legacy_id  BIGINT;
  v_demo_id    BIGINT;

  v_pm_prop_id     BIGINT;
  v_enf_prop_id    BIGINT;
  v_legacy_prop_id BIGINT;
  v_demo_prop_id   BIGINT;

  v_prod_collision_count INT;

  v_companies_created  INT := 0;
  v_properties_created INT := 0;
  v_user_roles_created INT := 0;
  v_drivers_created    INT := 0;
  v_residents_created  INT := 0;
  v_skipped            INT := 0;
  v_exists             INT;

  -- Property names (used for both properties.name and user_roles.property array).
  c_pm_prop     CONSTANT TEXT := 'Test PM Property';
  c_enf_prop    CONSTANT TEXT := 'Test ENF Property';
  c_legacy_prop CONSTANT TEXT := 'Test Legacy Property';
  c_demo_prop   CONSTANT TEXT := 'Demo Property';
BEGIN
  -- ══════════════════════════════════════════════════════════════════
  -- GUARD 3: Production-safety collision check
  -- ══════════════════════════════════════════════════════════════════
  -- If any production row already uses a seeded name, refuse. This is
  -- the catchall for the pathological case where a real customer
  -- happened to name themselves "Test-PM" or similar. Astronomically
  -- unlikely but the guard is cheap.
  SELECT count(*) INTO v_prod_collision_count
    FROM public.companies
   WHERE company_env = 'production'
     AND name IN ('Test-PM', 'Test-ENF', 'Test-LEGACY', 'Demo Company');
  IF v_prod_collision_count > 0 THEN
    RAISE EXCEPTION 'seed_test_tenants: production name collision — % production companies already use seeded names. Refuse.', v_prod_collision_count
      USING HINT = 'Rename the production company or update seed name constants.';
  END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- COMPANIES — SELECT-then-conditional-INSERT (never UPDATE)
  -- ══════════════════════════════════════════════════════════════════

  -- Test-PM
  SELECT id INTO v_pm_id FROM public.companies
   WHERE name = 'Test-PM' AND company_env = 'test' LIMIT 1;
  IF v_pm_id IS NULL THEN
    INSERT INTO public.companies (
      name, tier, tier_type,
      primary_contact_name, phone,
      is_active, account_state, company_env
    ) VALUES (
      'Test-PM', 'pm_only', 'property_management',
      'Test PM Admin', NULL,
      TRUE, 'active', 'test'
    ) RETURNING id INTO v_pm_id;
    v_companies_created := v_companies_created + 1;
  ELSE
    v_skipped := v_skipped + 1;
  END IF;

  -- Test-ENF
  SELECT id INTO v_enf_id FROM public.companies
   WHERE name = 'Test-ENF' AND company_env = 'test' LIMIT 1;
  IF v_enf_id IS NULL THEN
    INSERT INTO public.companies (
      name, tier, tier_type,
      primary_contact_name, phone,
      is_active, account_state, company_env
    ) VALUES (
      'Test-ENF', 'enforcement_only', 'enforcement',
      'Test ENF Admin', NULL,
      TRUE, 'active', 'test'
    ) RETURNING id INTO v_enf_id;
    v_companies_created := v_companies_created + 1;
  ELSE
    v_skipped := v_skipped + 1;
  END IF;

  -- Test-LEGACY
  SELECT id INTO v_legacy_id FROM public.companies
   WHERE name = 'Test-LEGACY' AND company_env = 'test' LIMIT 1;
  IF v_legacy_id IS NULL THEN
    INSERT INTO public.companies (
      name, tier, tier_type,
      primary_contact_name, phone,
      is_active, account_state, company_env
    ) VALUES (
      'Test-LEGACY', 'legacy', 'enforcement',
      'Test Legacy Admin', NULL,
      TRUE, 'active', 'test'
    ) RETURNING id INTO v_legacy_id;
    v_companies_created := v_companies_created + 1;
  ELSE
    v_skipped := v_skipped + 1;
  END IF;

  -- Demo Company (legacy/enforcement per Jose 2026-07-11)
  SELECT id INTO v_demo_id FROM public.companies
   WHERE name = 'Demo Company' AND company_env = 'demo' LIMIT 1;
  IF v_demo_id IS NULL THEN
    INSERT INTO public.companies (
      name, tier, tier_type,
      primary_contact_name, phone,
      is_active, account_state, company_env
    ) VALUES (
      'Demo Company', 'legacy', 'enforcement',
      'Demo Admin', NULL,
      TRUE, 'active', 'demo'
    ) RETURNING id INTO v_demo_id;
    v_companies_created := v_companies_created + 1;
  ELSE
    v_skipped := v_skipped + 1;
  END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- PROPERTIES — 1 per company (SELECT-then-conditional-INSERT)
  -- ══════════════════════════════════════════════════════════════════

  SELECT id INTO v_pm_prop_id FROM public.properties
   WHERE name = c_pm_prop AND company ~~* 'Test-PM' LIMIT 1;
  IF v_pm_prop_id IS NULL THEN
    INSERT INTO public.properties (name, company, is_active, visitor_capacity)
    VALUES (c_pm_prop, 'Test-PM', TRUE, 10)
    RETURNING id INTO v_pm_prop_id;
    v_properties_created := v_properties_created + 1;
  END IF;

  SELECT id INTO v_enf_prop_id FROM public.properties
   WHERE name = c_enf_prop AND company ~~* 'Test-ENF' LIMIT 1;
  IF v_enf_prop_id IS NULL THEN
    INSERT INTO public.properties (name, company, is_active, visitor_capacity)
    VALUES (c_enf_prop, 'Test-ENF', TRUE, 10)
    RETURNING id INTO v_enf_prop_id;
    v_properties_created := v_properties_created + 1;
  END IF;

  SELECT id INTO v_legacy_prop_id FROM public.properties
   WHERE name = c_legacy_prop AND company ~~* 'Test-LEGACY' LIMIT 1;
  IF v_legacy_prop_id IS NULL THEN
    INSERT INTO public.properties (name, company, is_active, visitor_capacity)
    VALUES (c_legacy_prop, 'Test-LEGACY', TRUE, 10)
    RETURNING id INTO v_legacy_prop_id;
    v_properties_created := v_properties_created + 1;
  END IF;

  SELECT id INTO v_demo_prop_id FROM public.properties
   WHERE name = c_demo_prop AND company ~~* 'Demo Company' LIMIT 1;
  IF v_demo_prop_id IS NULL THEN
    INSERT INTO public.properties (name, company, is_active, visitor_capacity)
    VALUES (c_demo_prop, 'Demo Company', TRUE, 10)
    RETURNING id INTO v_demo_prop_id;
    v_properties_created := v_properties_created + 1;
  END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- USER_ROLES — 18 rows total; ON CONFLICT (lower(email)) DO NOTHING
  -- via user_roles_lower_email_uidx. Re-runs skip existing.
  -- ══════════════════════════════════════════════════════════════════
  --
  -- Convention:
  --   CA          → property = '{}'::text[]           (no property scope)
  --   Manager     → property = ARRAY[<property_name>]  (scope enforced
  --                 by generate_spaces_from_pool + other manager guards)
  --   Leasing     → property = ARRAY[<property_name>]  (same as manager)
  --   Driver      → property = '{}'::text[]            (driver is company-scoped)
  --   Resident    → property = '{}'::text[]            (residents table has scope)
  --
  -- can_approve_vehicles = TRUE on ALL seeded managers so the bulk-add
  -- + plate-approve paths are exercisable from any manager account.

  -- ── Test-PM (4 rows: CA, manager, leasing, resident — driver-less
  -- by design; pm_only tier has MAX_DRIVERS=0 per product spec).
  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('pm-ca@test.shieldmylot.com',       'company_admin', 'Test-PM', '{}'::text[],              FALSE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('pm-manager@test.shieldmylot.com',  'manager',       'Test-PM', ARRAY[c_pm_prop]::text[],  TRUE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('pm-leasing@test.shieldmylot.com',  'leasing_agent', 'Test-PM', ARRAY[c_pm_prop]::text[],  FALSE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('pm-resident@test.shieldmylot.com', 'resident',      'Test-PM', '{}'::text[],              FALSE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  -- ── Test-ENF (3 rows: CA, manager, driver — per spec)
  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('enf-ca@test.shieldmylot.com',      'company_admin', 'Test-ENF', '{}'::text[],              FALSE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('enf-manager@test.shieldmylot.com', 'manager',       'Test-ENF', ARRAY[c_enf_prop]::text[], TRUE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('enf-driver@test.shieldmylot.com',  'driver',        'Test-ENF', '{}'::text[],              FALSE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  -- ── Test-LEGACY (5 rows: full set — mirrors A1's Legacy shape)
  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('legacy-ca@test.shieldmylot.com',       'company_admin', 'Test-LEGACY', '{}'::text[],                  FALSE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('legacy-manager@test.shieldmylot.com',  'manager',       'Test-LEGACY', ARRAY[c_legacy_prop]::text[],  TRUE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('legacy-leasing@test.shieldmylot.com',  'leasing_agent', 'Test-LEGACY', ARRAY[c_legacy_prop]::text[],  FALSE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('legacy-driver@test.shieldmylot.com',   'driver',        'Test-LEGACY', '{}'::text[],                  FALSE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('legacy-resident@test.shieldmylot.com', 'resident',      'Test-LEGACY', '{}'::text[],                  FALSE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  -- ── Demo Company (5 rows: full set — showcases PM + Enforcement via Legacy tier)
  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('demo-ca@test.shieldmylot.com',       'company_admin', 'Demo Company', '{}'::text[],                FALSE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('demo-manager@test.shieldmylot.com',  'manager',       'Demo Company', ARRAY[c_demo_prop]::text[],  TRUE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('demo-leasing@test.shieldmylot.com',  'leasing_agent', 'Demo Company', ARRAY[c_demo_prop]::text[],  FALSE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('demo-driver@test.shieldmylot.com',   'driver',        'Demo Company', '{}'::text[],                FALSE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  INSERT INTO public.user_roles (email, role, company, property, can_approve_vehicles)
  VALUES ('demo-resident@test.shieldmylot.com', 'resident',      'Demo Company', '{}'::text[],                FALSE)
  ON CONFLICT (lower(email)) DO NOTHING;
  v_user_roles_created := v_user_roles_created + (CASE WHEN FOUND THEN 1 ELSE 0 END);

  -- ══════════════════════════════════════════════════════════════════
  -- DRIVERS — 4 rows (one per seeded driver user_roles row). Neither
  -- drivers nor residents has a UNIQUE(email) constraint, so
  -- idempotency is manual SELECT-then-INSERT keyed on (email, company).
  -- Portal renders off these rows directly — no auth.users FK.
  -- ══════════════════════════════════════════════════════════════════

  -- (No Test-PM driver — pm_only tier has MAX_DRIVERS=0, product design.)

  -- Test-ENF driver
  SELECT count(*) INTO v_exists FROM public.drivers
   WHERE lower(email) = 'enf-driver@test.shieldmylot.com' AND company = 'Test-ENF';
  IF v_exists = 0 THEN
    INSERT INTO public.drivers (email, name, company, assigned_properties, is_active)
    VALUES ('enf-driver@test.shieldmylot.com', 'ENF Test Driver', 'Test-ENF',
            ARRAY[c_enf_prop]::text[], TRUE);
    v_drivers_created := v_drivers_created + 1;
  END IF;

  -- Test-LEGACY driver
  SELECT count(*) INTO v_exists FROM public.drivers
   WHERE lower(email) = 'legacy-driver@test.shieldmylot.com' AND company = 'Test-LEGACY';
  IF v_exists = 0 THEN
    INSERT INTO public.drivers (email, name, company, assigned_properties, is_active)
    VALUES ('legacy-driver@test.shieldmylot.com', 'Legacy Test Driver', 'Test-LEGACY',
            ARRAY[c_legacy_prop]::text[], TRUE);
    v_drivers_created := v_drivers_created + 1;
  END IF;

  -- Demo Company driver
  SELECT count(*) INTO v_exists FROM public.drivers
   WHERE lower(email) = 'demo-driver@test.shieldmylot.com' AND company = 'Demo Company';
  IF v_exists = 0 THEN
    INSERT INTO public.drivers (email, name, company, assigned_properties, is_active)
    VALUES ('demo-driver@test.shieldmylot.com', 'Demo Driver', 'Demo Company',
            ARRAY[c_demo_prop]::text[], TRUE);
    v_drivers_created := v_drivers_created + 1;
  END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- RESIDENTS — 3 rows (one per seeded resident user_roles row). No
  -- Test-ENF resident (Enforcement-only track). DO NOT populate
  -- residents.space (deprecated per v1.1 — space_residents is
  -- authoritative). Unit numbers are plausible apartment-style.
  -- ══════════════════════════════════════════════════════════════════

  -- Test-PM resident
  SELECT count(*) INTO v_exists FROM public.residents
   WHERE lower(email) = 'pm-resident@test.shieldmylot.com' AND company = 'Test-PM';
  IF v_exists = 0 THEN
    INSERT INTO public.residents (email, name, unit, property, company, is_active, status)
    VALUES ('pm-resident@test.shieldmylot.com', 'PM Test Resident', '101',
            c_pm_prop, 'Test-PM', TRUE, 'active');
    v_residents_created := v_residents_created + 1;
  END IF;

  -- Test-LEGACY resident
  SELECT count(*) INTO v_exists FROM public.residents
   WHERE lower(email) = 'legacy-resident@test.shieldmylot.com' AND company = 'Test-LEGACY';
  IF v_exists = 0 THEN
    INSERT INTO public.residents (email, name, unit, property, company, is_active, status)
    VALUES ('legacy-resident@test.shieldmylot.com', 'Legacy Test Resident', '205',
            c_legacy_prop, 'Test-LEGACY', TRUE, 'active');
    v_residents_created := v_residents_created + 1;
  END IF;

  -- Demo Company resident
  SELECT count(*) INTO v_exists FROM public.residents
   WHERE lower(email) = 'demo-resident@test.shieldmylot.com' AND company = 'Demo Company';
  IF v_exists = 0 THEN
    INSERT INTO public.residents (email, name, unit, property, company, is_active, status)
    VALUES ('demo-resident@test.shieldmylot.com', 'Demo Resident', '308',
            c_demo_prop, 'Demo Company', TRUE, 'active');
    v_residents_created := v_residents_created + 1;
  END IF;

  RETURN jsonb_build_object(
    'companies_created',  v_companies_created,
    'properties_created', v_properties_created,
    'user_roles_created', v_user_roles_created,
    'drivers_created',    v_drivers_created,
    'residents_created',  v_residents_created,
    'skipped_existing',   v_skipped,
    'company_ids', jsonb_build_object(
      'test_pm',     v_pm_id,
      'test_enf',    v_enf_id,
      'test_legacy', v_legacy_id,
      'demo',        v_demo_id
    )
  );
END
$func$;

-- Not exposed as a public API. Service_role only — called by
-- scripts/seed-test-tenants-ONE-TIME.ts via the service key.
REVOKE EXECUTE ON FUNCTION public.seed_test_tenants() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.seed_test_tenants() FROM anon;
REVOKE EXECUTE ON FUNCTION public.seed_test_tenants() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.seed_test_tenants() TO service_role;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_ADDED',
  'companies',
  NULL,
  jsonb_build_object(
    'migration', '20260711_seed_test_tenants_rpc',
    'rpc',       'seed_test_tenants',
    'change',    'New SD RPC — seeds 3 test companies (Test-PM, Test-ENF, Test-LEGACY) + 1 demo (Demo Company) with company_env stamped, tier direct in DB (no Stripe artifacts), 1 property per company, 18 user_roles across all seeded roles, 4 drivers rows (one per seeded driver user_roles), and 3 residents rows (Test-PM, Test-LEGACY, Demo — no Test-ENF resident by design). Idempotent via SELECT-then-INSERT on companies/properties/drivers/residents + ON CONFLICT (lower(email)) DO NOTHING on user_roles. Guarded against production name collisions.',
    'rationale', 'Seed/wipe Layer 2. Reproducible test + demo tenants that look like real customers (features via TIER_CONFIG) but are structurally invisible to billing/dunning/webhooks (all guarded on company_env=production).'
  ),
  now()
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--
-- VQ.A — Function exists + SD + service_role-only grants
--   SELECT proname, prosecdef, pg_get_function_arguments(oid) AS args
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname = 'seed_test_tenants';
--   -- Expected: 1 row; prosecdef=true; args = '' (no params).
--
--   SELECT grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public' AND routine_name = 'seed_test_tenants';
--   -- Expected: service_role=EXECUTE (postgres owner harmless).
--   -- NOT authenticated, NOT anon, NOT PUBLIC.
--
-- VQ.B — First invocation (from psql or SQL Editor via service key):
--   SELECT seed_test_tenants();
--   -- Expected shape:
--   -- { "companies_created": 4, "properties_created": 4,
--   --   "user_roles_created": 17, "drivers_created": 3,
--   --   "residents_created": 3, "skipped_existing": 0,
--   --   "company_ids": { "test_pm": N, "test_enf": N,
--   --                    "test_legacy": N, "demo": N } }
--   -- 17 user_roles (not 18) — no pm-driver (pm_only MAX_DRIVERS=0).
--   -- 3 drivers (not 4) — no pm-driver.
--
-- VQ.C — Second invocation (idempotent):
--   SELECT seed_test_tenants();
--   -- Expected: companies_created=0, user_roles_created=0,
--   --           properties_created=0, drivers_created=0,
--   --           residents_created=0, skipped_existing=4.
--
-- VQ.C-add — Drivers + residents landed
--   SELECT count(*) FROM drivers WHERE company IN ('Test-ENF','Test-LEGACY','Demo Company');
--   -- Expected: 3 (no Test-PM driver — pm_only MAX_DRIVERS=0).
--   SELECT count(*) FROM residents WHERE company IN ('Test-PM','Test-LEGACY','Demo Company');
--   -- Expected: 3. No Test-ENF resident (Enforcement-only track).
--
-- VQ.D — Post-state
--   SELECT company_env, count(*) FROM companies GROUP BY 1;
--   -- Expected: test=3, demo=1 (+ any production rows untouched).
--
--   SELECT count(*) FROM user_roles WHERE email LIKE '%@test.shieldmylot.com';
--   -- Expected: 17.
--
--   SELECT count(*) FROM properties WHERE company IN
--     ('Test-PM','Test-ENF','Test-LEGACY','Demo Company');
--   -- Expected: 4.
--
-- VQ.E — Migration audit row landed
--   SELECT action, new_values->>'migration' AS migration, created_at
--   FROM audit_logs
--   WHERE new_values->>'migration' = '20260711_seed_test_tenants_rpc'
--   ORDER BY created_at DESC LIMIT 1;
-- ════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════
-- seed_demo_data — NEW RPC · seed/wipe Layer 2 (Demo Company portfolio)
-- 2026-07-11 · Post-launch parallel build
--
-- WHY
--   seed_test_tenants() (companion migration 20260711_seed_test_tenants_
--   rpc.sql) shipped 1 sparse property + 1 manager + 1 driver + 1 resident
--   under Demo Company. That's enough for a smoke, but too thin for
--   the Insights dashboards, approval queue, driver portal, and resident
--   portal to demo well.
--
--   This RPC extends Demo Company from 1 sparse property into a
--   3-property portfolio with realistic operating data:
--     • Sunset Ridge Apartments (RENAMED from "Demo Property") — larger
--       multifamily, 14 residents, 32 spaces, 22 vehicles, 14 violations
--     • Willowbrook Court (NEW) — smaller multifamily, 9 residents,
--       16 spaces, 13 vehicles, 7 violations
--     • Northgate Commerce Center (NEW) — commercial mixed lot,
--       7 residents, 20 spaces, 10 vehicles, 9 violations
--   Plus 15 space_residents ties, 15 visitor passes (10 active/5 expired),
--   1 storage facility.
--
--   30 violations tuned so the CA Enforcement Insights dashboards land
--   on plausible content:
--     • 13 OPEN distributed 4/5/4 across aging buckets (0-7d/8-30d/30+d)
--       — Aging chart populates all three columns
--     • Peak Enforcement hour-of-day clusters ~19 in 22-03 (late night),
--       6 in 5-7 (early morning), 3 in 12-14 (midday), 2 in 15-17
--     • 15 resolved + 2 disputed CLOSED rows across 0-90d
--     • 2 resolved rows carry voided_at so voided pipeline populates
--     • Fix E — all 30 rows set driver_name='Demo Driver' +
--       driver_license='TX-A2947153' so demo-driver's portal shows all
--       30 as their own submitted violations
--
-- SHAPE
--   • Idempotent — every INSERT is SELECT-then-conditional-INSERT keyed
--     on a natural key. Re-runs return all counters=0.
--   • All timestamps computed via
--       date_trunc('day', now()) - interval '<N> days'
--                                + interval '<H> hours <M> minutes'
--     — never hardcoded, so a demo re-seeded a month from now still
--     renders in the last 90d Insights window.
--   • Every child INSERT re-verifies its parent's company_env='demo'
--     via v_demo_id lookup (belt-and-suspenders).
--   • residents.space is DEPRECATED per Spaces v1.1 — NOT populated.
--     space_residents is authoritative for space ties.
--   • Vehicle plates: 45 randomized 8-char plates (TX + 6 random alnum),
--     no walking alphabet, distributed across 20/5/5 residents
--     (2/1/0 vehicles).
--   • Vehicles: 39 active + 4 pending (approval queue for demo-manager)
--     + 2 declined.
--   • Storage facility: 1 ("Demo Tow Yard").
--
-- WHAT IT DOES
--   1. Rename existing "Demo Property" → "Sunset Ridge Apartments" +
--      fill address; cascade rename in user_roles.property,
--      drivers.assigned_properties, residents.property.
--   2. INSERT properties Willowbrook Court + Northgate Commerce Center.
--   3. Extend demo-manager + demo-leasing.property + demo-driver.
--      assigned_properties to cover all 3 properties.
--   4. Move existing demo-resident to Sunset Ridge unit 101.
--   5. INSERT 29 new residents (demo-r01..demo-r29) — db-only, no
--      auth.users, no user_roles.
--   6. INSERT 68 spaces via type-loop (label-generation matches
--      generate_spaces_from_pool prefix/sequence rules).
--   7. INSERT 15 space_residents ties (mark those spaces status=assigned).
--   8. INSERT 45 vehicles distributed across residents.
--   9. INSERT 15 visitor_passes (10 active, 5 expired).
--   10. INSERT 1 storage facility (Demo Tow Yard).
--   11. INSERT 30 violations with the aging + peak-hour clustering above.
--
-- GUARDS
--   • Pre-flight: refuse if Demo Company absent or company_env<>'demo'
--   • Every child INSERT's `company` field is hardcoded to
--     'Demo Company' (never a dynamic string)
--   • Property lookups all go through v_prop_*_id BIGINT variables set
--     at INSERT time — never by name lookup elsewhere
--
-- GRANTS
--   PUBLIC + anon + authenticated all revoked. service_role only.
--   Called by scripts/seed-demo-data-ONE-TIME.ts via service key.
--
-- RETIRE
--   Keep as long as the demo pattern is useful. If retiring, drop
--   alongside seed_test_tenants + reset_test_tenants (Layer 3).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.seed_demo_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_demo_id  BIGINT;
  v_demo_env TEXT;

  v_prop_sunset_id BIGINT;
  v_prop_willow_id BIGINT;
  v_prop_north_id  BIGINT;

  v_facility_id BIGINT;

  v_day    TIMESTAMPTZ := date_trunc('day', now());
  v_exists INT;
  v_space_id BIGINT;

  v_properties_renamed        INT := 0;
  v_properties_created        INT := 0;
  v_facilities_created        INT := 0;
  v_spaces_created            INT := 0;
  v_residents_created         INT := 0;
  v_residents_moved           INT := 0;
  v_space_residents_created   INT := 0;
  v_vehicles_created          INT := 0;
  v_visitor_passes_created    INT := 0;
  v_violations_created        INT := 0;

  -- Property name constants — DO NOT rename these mid-run; every INSERT
  -- below re-uses them, and residents.property / vehicles.property are
  -- TEXT joins that would silently drift if these change.
  c_prop_sunset CONSTANT TEXT := 'Sunset Ridge Apartments';
  c_prop_willow CONSTANT TEXT := 'Willowbrook Court';
  c_prop_north  CONSTANT TEXT := 'Northgate Commerce Center';
  c_company     CONSTANT TEXT := 'Demo Company';
  c_actor       CONSTANT TEXT := 'seed_demo_data';

  -- Fix E — all 30 violations carry the same demo driver attribution
  -- so demo-driver@ sees the whole set as their own submitted work.
  c_driver_name    CONSTANT TEXT := 'Demo Driver';
  c_driver_license CONSTANT TEXT := 'TX-A2947153';
BEGIN
  -- ══════════════════════════════════════════════════════════════════
  -- PRE-FLIGHT — refuse if Demo Company absent or not env='demo'
  -- ══════════════════════════════════════════════════════════════════
  SELECT id, company_env INTO v_demo_id, v_demo_env
    FROM public.companies
   WHERE name = c_company
   LIMIT 1;

  IF v_demo_id IS NULL THEN
    RAISE EXCEPTION 'seed_demo_data: Demo Company does not exist. Run seed_test_tenants() first.'
      USING HINT = 'migrations/20260711_seed_test_tenants_rpc.sql seeds the Demo Company row.';
  END IF;

  IF v_demo_env <> 'demo' THEN
    RAISE EXCEPTION 'seed_demo_data: Demo Company company_env=%, expected demo. Refuse.', v_demo_env
      USING HINT = 'Only rows with company_env=demo may be extended by this seed.';
  END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- PART 1 — Rename "Demo Property" → "Sunset Ridge Apartments"
  -- ══════════════════════════════════════════════════════════════════
  -- In-place rename is cheaper than delete+recreate and preserves the
  -- demo-resident / demo-manager / demo-driver linkages. Cascade the
  -- rename into user_roles.property, drivers.assigned_properties, and
  -- residents.property so nothing dangles.
  UPDATE public.properties
     SET name             = c_prop_sunset,
         address          = '4820 Sunset Ridge Drive',
         city             = 'Katy',
         state            = 'TX',
         zip              = '77494',
         visitor_capacity = 25
   WHERE name = 'Demo Property' AND company = c_company;
  IF FOUND THEN
    v_properties_renamed := 1;
  END IF;

  SELECT id INTO v_prop_sunset_id
    FROM public.properties
   WHERE name = c_prop_sunset AND company = c_company
   LIMIT 1;

  -- Cascade rename in user_roles.property (managers + leasing agents)
  UPDATE public.user_roles
     SET property = array_replace(property, 'Demo Property', c_prop_sunset)
   WHERE company = c_company
     AND 'Demo Property' = ANY(property);

  -- Cascade rename in drivers.assigned_properties
  UPDATE public.drivers
     SET assigned_properties = array_replace(assigned_properties, 'Demo Property', c_prop_sunset)
   WHERE company = c_company
     AND 'Demo Property' = ANY(assigned_properties);

  -- Move existing demo-resident to Sunset Ridge unit 101 (aligns with
  -- the Sunset Ridge unit numbering below — r01..r13 hold 102..304).
  -- Guard the WHERE on "not already at target state" so re-runs are a
  -- true no-op and v_residents_moved stays 0 on the second call.
  UPDATE public.residents
     SET property = c_prop_sunset,
         unit     = '101'
   WHERE company = c_company
     AND lower(email) = 'demo-resident@test.shieldmylot.com'
     AND (property IS DISTINCT FROM c_prop_sunset OR unit IS DISTINCT FROM '101');
  IF FOUND THEN v_residents_moved := 1; END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- PART 2 — INSERT 2 new properties (Willowbrook + Northgate)
  -- ══════════════════════════════════════════════════════════════════
  SELECT id INTO v_prop_willow_id
    FROM public.properties
   WHERE name = c_prop_willow AND company = c_company
   LIMIT 1;
  IF v_prop_willow_id IS NULL THEN
    INSERT INTO public.properties (name, company, address, city, state, zip, visitor_capacity, is_active)
    VALUES (c_prop_willow, c_company, '1215 Willowbrook Court', 'Sugar Land', 'TX', '77479', 15, TRUE)
    RETURNING id INTO v_prop_willow_id;
    v_properties_created := v_properties_created + 1;
  END IF;

  SELECT id INTO v_prop_north_id
    FROM public.properties
   WHERE name = c_prop_north AND company = c_company
   LIMIT 1;
  IF v_prop_north_id IS NULL THEN
    INSERT INTO public.properties (name, company, address, city, state, zip, visitor_capacity, is_active)
    VALUES (c_prop_north, c_company, '8340 Northgate Boulevard', 'Houston', 'TX', '77066', 30, TRUE)
    RETURNING id INTO v_prop_north_id;
    v_properties_created := v_properties_created + 1;
  END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- PART 3 — Extend user_roles.property + drivers.assigned_properties
  -- to cover all 3 Demo Company properties
  -- ══════════════════════════════════════════════════════════════════
  -- demo-manager + demo-leasing get all 3 properties (so the manager
  -- portal shows the whole portfolio + property switcher works).
  -- demo-driver's assigned_properties gets all 3 too (driver portal
  -- sees violations across all 3).
  UPDATE public.user_roles
     SET property = ARRAY[c_prop_sunset, c_prop_willow, c_prop_north]::text[]
   WHERE company = c_company
     AND role IN ('manager', 'leasing_agent');

  UPDATE public.drivers
     SET assigned_properties = ARRAY[c_prop_sunset, c_prop_willow, c_prop_north]::text[]
   WHERE company = c_company
     AND lower(email) = 'demo-driver@test.shieldmylot.com';

  -- ══════════════════════════════════════════════════════════════════
  -- PART 4 — Storage facility (1 row)
  -- ══════════════════════════════════════════════════════════════════
  SELECT id INTO v_facility_id
    FROM public.storage_facilities
   WHERE name = 'Demo Tow Yard' AND company = c_company
   LIMIT 1;
  IF v_facility_id IS NULL THEN
    INSERT INTO public.storage_facilities (name, address, phone, company, is_active)
    VALUES ('Demo Tow Yard', '9200 Industrial Row, Houston, TX 77048', '713-555-0142', c_company, TRUE)
    RETURNING id INTO v_facility_id;
    v_facilities_created := 1;
  END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- PART 5 — Spaces (68 total)
  -- ══════════════════════════════════════════════════════════════════
  -- Label prefix mirrors generate_spaces_from_pool:
  --   regular=R  carport=CP  garage=G  covered=C  handicap=H  employee=E
  -- Idempotent: skip any (property, label) that already exists.
  --
  -- Sunset Ridge: 32 (5R / 4CP / 12G / 7C / 3H / 1E)
  -- Willowbrook:  16 (8R / 4CP / 0G / 2C / 2H / 0E)
  -- Northgate:    20 (10R / 0CP / 0G / 2C / 2H / 6E)

  -- Sunset Ridge spaces
  DECLARE
    r RECORD;
  BEGIN
    FOR r IN
      SELECT * FROM (VALUES
        -- (property, type, prefix, count)
        (c_prop_sunset, 'regular',  'R',  5),
        (c_prop_sunset, 'carport',  'CP', 4),
        (c_prop_sunset, 'garage',   'G',  12),
        (c_prop_sunset, 'covered',  'C',  7),
        (c_prop_sunset, 'handicap', 'H',  3),
        (c_prop_sunset, 'employee', 'E',  1),

        (c_prop_willow, 'regular',  'R',  8),
        (c_prop_willow, 'carport',  'CP', 4),
        (c_prop_willow, 'covered',  'C',  2),
        (c_prop_willow, 'handicap', 'H',  2),

        (c_prop_north,  'regular',  'R',  10),
        (c_prop_north,  'covered',  'C',  2),
        (c_prop_north,  'handicap', 'H',  2),
        (c_prop_north,  'employee', 'E',  6)
      ) AS t(prop, typ, prefix, cnt)
    LOOP
      DECLARE
        v_j INT;
        v_label TEXT;
      BEGIN
        FOR v_j IN 1..r.cnt LOOP
          v_label := r.prefix || '-' || v_j::TEXT;
          IF NOT EXISTS (
            SELECT 1 FROM public.spaces
             WHERE property = r.prop AND label = v_label
          ) THEN
            INSERT INTO public.spaces (
              company, property, label, type, status, is_active,
              created_at, created_by_email
            ) VALUES (
              c_company, r.prop, v_label, r.typ, 'available', TRUE,
              now(), c_actor
            );
            v_spaces_created := v_spaces_created + 1;
          END IF;
        END LOOP;
      END;
    END LOOP;
  END;

  -- ══════════════════════════════════════════════════════════════════
  -- PART 6 — Residents (29 new rows — demo-resident already moved)
  -- ══════════════════════════════════════════════════════════════════
  -- All db-only; no auth.users, no user_roles. company='Demo Company'
  -- hardcoded, is_active=true, status='active', space=NULL (deprecated).
  DECLARE
    r RECORD;
  BEGIN
    FOR r IN
      SELECT * FROM (VALUES
        -- Sunset Ridge (13 residents demo-r01..r13; +existing demo-resident=14)
        ('demo-r01@test.shieldmylot.com', 'Amelia Chen',      '102', c_prop_sunset),
        ('demo-r02@test.shieldmylot.com', 'Marcus Rivera',    '103', c_prop_sunset),
        ('demo-r03@test.shieldmylot.com', 'Priya Patel',      '104', c_prop_sunset),
        ('demo-r04@test.shieldmylot.com', 'Jordan Reeves',    '105', c_prop_sunset),
        ('demo-r05@test.shieldmylot.com', 'Zara Ahmed',       '201', c_prop_sunset),
        ('demo-r06@test.shieldmylot.com', 'Elena Vasquez',    '202', c_prop_sunset),
        ('demo-r07@test.shieldmylot.com', 'Cody Bennett',     '203', c_prop_sunset),
        ('demo-r08@test.shieldmylot.com', 'Maya Okonkwo',     '204', c_prop_sunset),
        ('demo-r09@test.shieldmylot.com', 'Ethan Park',       '205', c_prop_sunset),
        ('demo-r10@test.shieldmylot.com', 'Sofia Delacroix',  '301', c_prop_sunset),
        ('demo-r11@test.shieldmylot.com', 'Tyler Nguyen',     '302', c_prop_sunset),
        ('demo-r12@test.shieldmylot.com', 'Rachel Kaminski',  '303', c_prop_sunset),
        ('demo-r13@test.shieldmylot.com', 'Diego Rojas',      '304', c_prop_sunset),

        -- Willowbrook Court (9 residents demo-r14..r22)
        ('demo-r14@test.shieldmylot.com', 'Ashley Whitfield', 'A101', c_prop_willow),
        ('demo-r15@test.shieldmylot.com', 'Kenji Tanaka',     'A102', c_prop_willow),
        ('demo-r16@test.shieldmylot.com', 'Isabelle Fournier','A103', c_prop_willow),
        ('demo-r17@test.shieldmylot.com', 'Marcus Doyle',     'A104', c_prop_willow),
        ('demo-r18@test.shieldmylot.com', 'Harper Cole',      'A201', c_prop_willow),
        ('demo-r19@test.shieldmylot.com', 'Owen Blackwood',   'A202', c_prop_willow),
        ('demo-r20@test.shieldmylot.com', 'Nadia Petrov',     'A203', c_prop_willow),
        ('demo-r21@test.shieldmylot.com', 'Julian Vega',      'B101', c_prop_willow),
        ('demo-r22@test.shieldmylot.com', 'Grace Novak',      'B102', c_prop_willow),

        -- Northgate Commerce Center (7 residents demo-r23..r29)
        ('demo-r23@test.shieldmylot.com', 'Malik Robinson',   '100', c_prop_north),
        ('demo-r24@test.shieldmylot.com', 'Camila Herrera',   '105', c_prop_north),
        ('demo-r25@test.shieldmylot.com', 'Aiden Sullivan',   '110', c_prop_north),
        ('demo-r26@test.shieldmylot.com', 'Ruby Callahan',    '120', c_prop_north),
        ('demo-r27@test.shieldmylot.com', 'Xavier Mensah',    '200', c_prop_north),
        ('demo-r28@test.shieldmylot.com', 'Lily Zhao',        '210', c_prop_north),
        ('demo-r29@test.shieldmylot.com', 'Nora Hendricks',   '220', c_prop_north)
      ) AS t(email, name, unit, prop)
    LOOP
      SELECT count(*) INTO v_exists FROM public.residents
       WHERE lower(email) = r.email AND company = c_company;
      IF v_exists = 0 THEN
        INSERT INTO public.residents (email, name, unit, property, company, is_active, status)
        VALUES (r.email, r.name, r.unit, r.prop, c_company, TRUE, 'active');
        v_residents_created := v_residents_created + 1;
      END IF;
    END LOOP;
  END;

  -- ══════════════════════════════════════════════════════════════════
  -- PART 7 — space_residents ties + mark those spaces status=assigned
  -- ══════════════════════════════════════════════════════════════════
  -- 15 ties total:
  --   Sunset Ridge: G-1..G-8 → demo-r01..demo-r08 (8 ties)
  --   Willowbrook:  R-1..R-4 → demo-r14..demo-r17 (4 ties)
  --   Northgate:    E-1..E-3 → demo-r23..demo-r25 (3 ties)
  --
  -- Each tie: lookup space by (property, label), skip if already tied,
  -- else INSERT + UPDATE space.status='assigned'.

  DECLARE
    r RECORD;
  BEGIN
    FOR r IN
      SELECT * FROM (VALUES
        (c_prop_sunset, 'G-1',  'demo-r01@test.shieldmylot.com'),
        (c_prop_sunset, 'G-2',  'demo-r02@test.shieldmylot.com'),
        (c_prop_sunset, 'G-3',  'demo-r03@test.shieldmylot.com'),
        (c_prop_sunset, 'G-4',  'demo-r04@test.shieldmylot.com'),
        (c_prop_sunset, 'G-5',  'demo-r05@test.shieldmylot.com'),
        (c_prop_sunset, 'G-6',  'demo-r06@test.shieldmylot.com'),
        (c_prop_sunset, 'G-7',  'demo-r07@test.shieldmylot.com'),
        (c_prop_sunset, 'G-8',  'demo-r08@test.shieldmylot.com'),

        (c_prop_willow, 'R-1',  'demo-r14@test.shieldmylot.com'),
        (c_prop_willow, 'R-2',  'demo-r15@test.shieldmylot.com'),
        (c_prop_willow, 'R-3',  'demo-r16@test.shieldmylot.com'),
        (c_prop_willow, 'R-4',  'demo-r17@test.shieldmylot.com'),

        (c_prop_north,  'E-1',  'demo-r23@test.shieldmylot.com'),
        (c_prop_north,  'E-2',  'demo-r24@test.shieldmylot.com'),
        (c_prop_north,  'E-3',  'demo-r25@test.shieldmylot.com')
      ) AS t(prop, label, resident_email)
    LOOP
      SELECT id INTO v_space_id FROM public.spaces
       WHERE property = r.prop AND label = r.label
       LIMIT 1;
      IF v_space_id IS NULL THEN
        CONTINUE;  -- defensive; PART 5 should have created it
      END IF;

      SELECT count(*) INTO v_exists FROM public.space_residents
       WHERE space_id = v_space_id
         AND lower(resident_email) = r.resident_email;
      IF v_exists = 0 THEN
        INSERT INTO public.space_residents (space_id, resident_email, added_at, added_by_email)
        VALUES (v_space_id, r.resident_email, now(), c_actor);
        v_space_residents_created := v_space_residents_created + 1;

        UPDATE public.spaces
           SET status                     = 'assigned',
               assigned_to_resident_email = r.resident_email,
               assigned_at                = now(),
               assigned_by_email          = c_actor
         WHERE id = v_space_id;
      END IF;
    END LOOP;
  END;

  -- ══════════════════════════════════════════════════════════════════
  -- PART 8 — Vehicles (45 rows)
  -- ══════════════════════════════════════════════════════════════════
  -- Distribution:
  --   20 residents × 2 vehicles = 40 plates (1-40)
  --   5 residents × 1 vehicle = 5 plates (41-45)
  --   5 residents × 0 vehicles
  --
  -- Property allocation:
  --   Sunset Ridge: r01..r10 ×2 + r11 ×1 + demo-resident ×1 = 22 vehicles
  --   Willowbrook:  r14..r18 ×2 + r19..r21 ×1              = 13 vehicles
  --   Northgate:    r23..r27 ×2                             = 10 vehicles
  --   (r12, r13, r22, r28, r29 get 0 vehicles)
  --
  -- Status:
  --   4 pending (plates 10, 22, 34, 40) — approval queue for demo-manager
  --   2 declined (plates 7, 29)
  --   39 active

  DECLARE
    r RECORD;
  BEGIN
    FOR r IN
      SELECT * FROM (VALUES
        -- SR r01..r10 (2 each — plates 1-20)
        ('TX7HDN82', 'demo-r01@test.shieldmylot.com', '102', c_prop_sunset, 'Toyota',    'Camry',    2020, 'Silver', 'active'),
        ('TX3QLW56', 'demo-r01@test.shieldmylot.com', '102', c_prop_sunset, 'Honda',     'Civic',    2018, 'Black',  'active'),
        ('TX9KRV14', 'demo-r02@test.shieldmylot.com', '103', c_prop_sunset, 'Ford',      'F-150',    2021, 'White',  'active'),
        ('TX2FMB74', 'demo-r02@test.shieldmylot.com', '103', c_prop_sunset, 'Nissan',    'Altima',   2019, 'Gray',   'active'),
        ('TX6WXP38', 'demo-r03@test.shieldmylot.com', '104', c_prop_sunset, 'Chevrolet', 'Malibu',   2017, 'Red',    'active'),
        ('TX8CJT61', 'demo-r03@test.shieldmylot.com', '104', c_prop_sunset, 'Hyundai',   'Elantra',  2022, 'Blue',   'active'),
        ('TX4NBH25', 'demo-r04@test.shieldmylot.com', '105', c_prop_sunset, 'Kia',       'Sorento',  2016, 'Black',  'declined'),
        ('TX0RSY93', 'demo-r04@test.shieldmylot.com', '105', c_prop_sunset, 'Mazda',     'CX-5',     2020, 'White',  'active'),
        ('TX5GVK41', 'demo-r05@test.shieldmylot.com', '201', c_prop_sunset, 'Subaru',    'Outback',  2019, 'Green',  'active'),
        ('TX1ZMF87', 'demo-r05@test.shieldmylot.com', '201', c_prop_sunset, 'Volkswagen','Jetta',    2023, 'Silver', 'pending'),
        ('TX3TWQ29', 'demo-r06@test.shieldmylot.com', '202', c_prop_sunset, 'Toyota',    'RAV4',     2021, 'Gray',   'active'),
        ('TX7BLD56', 'demo-r06@test.shieldmylot.com', '202', c_prop_sunset, 'Honda',     'Accord',   2018, 'Black',  'active'),
        ('TX9PXS12', 'demo-r07@test.shieldmylot.com', '203', c_prop_sunset, 'Ford',      'Escape',   2020, 'Blue',   'active'),
        ('TX2JHN45', 'demo-r07@test.shieldmylot.com', '203', c_prop_sunset, 'Nissan',    'Sentra',   2017, 'White',  'active'),
        ('TX6VCR78', 'demo-r08@test.shieldmylot.com', '204', c_prop_sunset, 'Chevrolet', 'Equinox',  2022, 'Red',    'active'),
        ('TX4YKB33', 'demo-r08@test.shieldmylot.com', '204', c_prop_sunset, 'Hyundai',   'Tucson',   2019, 'Silver', 'active'),
        ('TX8DFR91', 'demo-r09@test.shieldmylot.com', '205', c_prop_sunset, 'Toyota',    'Highlander',2021,'Black',  'active'),
        ('TX0LWM47', 'demo-r09@test.shieldmylot.com', '205', c_prop_sunset, 'Honda',     'CR-V',     2020, 'Gray',   'active'),
        ('TX5NPT24', 'demo-r10@test.shieldmylot.com', '301', c_prop_sunset, 'Mazda',     '3',        2018, 'Blue',   'active'),
        ('TX1BSF68', 'demo-r10@test.shieldmylot.com', '301', c_prop_sunset, 'Kia',       'Optima',   2019, 'White',  'active'),

        -- WB r14..r18 (2 each — plates 21-30)
        ('TX3XKV52', 'demo-r14@test.shieldmylot.com', 'A101', c_prop_willow, 'Toyota',    'Corolla',  2020, 'Silver', 'active'),
        ('TX7RCB39', 'demo-r14@test.shieldmylot.com', 'A101', c_prop_willow, 'Ford',      'Fusion',   2017, 'Black',  'pending'),
        ('TX9MHT81', 'demo-r15@test.shieldmylot.com', 'A102', c_prop_willow, 'Honda',     'Pilot',    2019, 'Gray',   'active'),
        ('TX2QLS16', 'demo-r15@test.shieldmylot.com', 'A102', c_prop_willow, 'Chevrolet', 'Traverse', 2022, 'Blue',   'active'),
        ('TX6FVN75', 'demo-r16@test.shieldmylot.com', 'A103', c_prop_willow, 'Nissan',    'Rogue',    2018, 'White',  'active'),
        ('TX4JBM48', 'demo-r16@test.shieldmylot.com', 'A103', c_prop_willow, 'Subaru',    'Forester', 2020, 'Green',  'active'),
        ('TX8PWD24', 'demo-r17@test.shieldmylot.com', 'A104', c_prop_willow, 'Hyundai',   'Sonata',   2021, 'Silver', 'active'),
        ('TX0KTR91', 'demo-r17@test.shieldmylot.com', 'A104', c_prop_willow, 'Kia',       'Forte',    2016, 'Red',    'active'),
        ('TX5CXH37', 'demo-r18@test.shieldmylot.com', 'A201', c_prop_willow, 'Toyota',    'Prius',    2019, 'Gray',   'declined'),
        ('TX1YVN82', 'demo-r18@test.shieldmylot.com', 'A201', c_prop_willow, 'Volkswagen','Passat',   2020, 'Black',  'active'),

        -- NG r23..r27 (2 each — plates 31-40)
        ('TX3GBP54', 'demo-r23@test.shieldmylot.com', '100', c_prop_north,  'Ford',      'Transit',  2020, 'White',  'active'),
        ('TX7LMS29', 'demo-r23@test.shieldmylot.com', '100', c_prop_north,  'Chevrolet', 'Silverado',2018, 'Black',  'active'),
        ('TX9QDF63', 'demo-r24@test.shieldmylot.com', '105', c_prop_north,  'Toyota',    'Tacoma',   2019, 'Gray',   'active'),
        ('TX2HKW17', 'demo-r24@test.shieldmylot.com', '105', c_prop_north,  'Nissan',    'Frontier', 2022, 'Silver', 'pending'),
        ('TX6NVT48', 'demo-r25@test.shieldmylot.com', '110', c_prop_north,  'Honda',     'Ridgeline',2020, 'Blue',   'active'),
        ('TX4RBM75', 'demo-r25@test.shieldmylot.com', '110', c_prop_north,  'Ford',      'Ranger',   2021, 'Red',    'active'),
        ('TX8CLK39', 'demo-r26@test.shieldmylot.com', '120', c_prop_north,  'GMC',       'Sierra',   2018, 'Black',  'active'),
        ('TX0PXH52', 'demo-r26@test.shieldmylot.com', '120', c_prop_north,  'Ram',       '1500',     2019, 'Silver', 'active'),
        ('TX5WMR86', 'demo-r27@test.shieldmylot.com', '200', c_prop_north,  'Toyota',    'Tundra',   2020, 'White',  'active'),
        ('TX1TFN24', 'demo-r27@test.shieldmylot.com', '200', c_prop_north,  'Chevrolet', 'Colorado', 2017, 'Gray',   'pending'),

        -- Single-vehicle residents (plates 41-45)
        ('TX3JVB68', 'demo-r11@test.shieldmylot.com',      '302',  c_prop_sunset, 'Toyota',   'Camry',   2021, 'Silver', 'active'),
        ('TX7DXP41', 'demo-r19@test.shieldmylot.com',      'A202', c_prop_willow, 'Honda',    'Civic',   2019, 'Black',  'active'),
        ('TX9NKS85', 'demo-r20@test.shieldmylot.com',      'A203', c_prop_willow, 'Ford',     'Focus',   2017, 'White',  'active'),
        ('TX2VBH14', 'demo-r21@test.shieldmylot.com',      'B101', c_prop_willow, 'Nissan',   'Versa',   2020, 'Gray',   'active'),
        ('TX6FRM73', 'demo-resident@test.shieldmylot.com', '101',  c_prop_sunset, 'Toyota',   'Camry',   2022, 'Blue',   'active')
      ) AS t(plate, resident_email, unit, prop, make, model, yr, color, status)
    LOOP
      SELECT count(*) INTO v_exists FROM public.vehicles
       WHERE plate = r.plate AND property = r.prop;
      IF v_exists = 0 THEN
        INSERT INTO public.vehicles (
          plate, state, make, model, year, color,
          unit, property, resident_email,
          status, is_active
        ) VALUES (
          r.plate, 'TX', r.make, r.model, r.yr, r.color,
          r.unit, r.prop, r.resident_email,
          r.status,
          -- is_active = TRUE for active; FALSE for pending/declined
          (r.status = 'active')
        );
        v_vehicles_created := v_vehicles_created + 1;
      END IF;
    END LOOP;
  END;

  -- ══════════════════════════════════════════════════════════════════
  -- PART 9 — Visitor passes (15 rows: 10 active + 5 expired)
  -- ══════════════════════════════════════════════════════════════════
  -- Plates are FRESH — do not overlap with the 45 vehicles above.
  -- visitor_passes.created_at + expires_at drive is_active + rendering.
  -- Trigger enforce_visitor_pass_limit fires on INSERT; since each plate
  -- is used exactly once per property here, no cap is triggered.

  DECLARE
    r RECORD;
    v_days_before INT;
    v_hours_ahead INT;
    v_created TIMESTAMPTZ;
    v_expires TIMESTAMPTZ;
  BEGIN
    FOR r IN
      SELECT * FROM (VALUES
        -- ACTIVE (10) — created recently, expires in the future
        ('TX9GHK52', 'Diana Reyes',   '102',  c_prop_sunset, 'Silver Toyota Corolla', 24,  1,  1),  -- created 1d ago, expires in +1d
        ('TX1LMN18', 'Frank Chen',    '103',  c_prop_sunset, 'Blue Honda Civic',       48,  2,  2),
        ('TX6PQS93', 'Gabriela Ruiz', '201',  c_prop_sunset, 'Black Ford Escape',      72,  1,  3),
        ('TX4TUW26', 'Henry Osei',    '204',  c_prop_sunset, 'Red Nissan Sentra',      24,  0,  1),  -- created today, expires in +1d
        ('TX0XYZ58', 'Iris Kowalski', '301',  c_prop_sunset, 'White Chevy Malibu',     48,  1,  2),

        ('TX2BAX67', 'James Anders',  'A101', c_prop_willow, 'Green Subaru Forester', 24,  0,  1),
        ('TX8CQE45', 'Karina Volkov', 'A104', c_prop_willow, 'Gray Mazda 3',          72,  2,  3),
        ('TX3DHI29', 'Leon Marceau',  'A201', c_prop_willow, 'Blue Hyundai Elantra',  48,  1,  2),

        ('TX5EFN91', 'Mira Solberg',  '100',  c_prop_north,  'Silver Ford Transit',   48,  0,  2),
        ('TX7GJK83', 'Nathan Doyle',  '110',  c_prop_north,  'Black Toyota Tundra',   24,  1,  1),

        -- EXPIRED (5) — created in the past, expired days ago
        ('TX0AKL14', 'Ollie Patel',    '105', c_prop_sunset, 'Red Honda CR-V',        48,  10, -3),  -- created 10d ago, expired 3d ago
        ('TX2BMP48', 'Priya Nakamura', '205', c_prop_sunset, 'Blue Ford Explorer',    24,  8,  -5),
        ('TX4CNQ76', 'Quinn Fischer',  'A102',c_prop_willow, 'Gray Nissan Rogue',     24,  15, -12),
        ('TX6DPS39', 'Ravi Sundaram',  '120', c_prop_north,  'White Chevy Suburban',  48,  20, -18),
        ('TX8EQT92', 'Sara Bergstrom', '200', c_prop_north,  'Black Toyota Prius',    72,  6,  -3)
      ) AS t(plate, visitor_name, visiting_unit, prop, vehicle_desc, duration_hours,
             days_before_now, days_offset_from_now)
    LOOP
      -- Idempotent: match on (plate, property, visitor_name).
      SELECT count(*) INTO v_exists FROM public.visitor_passes
       WHERE plate = r.plate AND property = r.prop AND visitor_name = r.visitor_name;
      IF v_exists > 0 THEN
        CONTINUE;
      END IF;

      -- created_at = day_bucket - days_before, then arbitrary hour to
      -- avoid all-midnight clustering.
      v_created := v_day - (r.days_before_now || ' days')::INTERVAL + INTERVAL '10 hours';
      -- expires_at = day_bucket + days_offset_from_now (may be past/future)
      v_expires := v_day + (r.days_offset_from_now || ' days')::INTERVAL + INTERVAL '10 hours';

      INSERT INTO public.visitor_passes (
        plate, visitor_name, visiting_unit, property,
        vehicle_desc, duration_hours, created_at, expires_at, is_active
      ) VALUES (
        r.plate, r.visitor_name, r.visiting_unit, r.prop,
        r.vehicle_desc, r.duration_hours, v_created, v_expires, TRUE
      );
      v_visitor_passes_created := v_visitor_passes_created + 1;
    END LOOP;
  END;

  -- ══════════════════════════════════════════════════════════════════
  -- PART 10 — Violations (30 rows) — the load-bearing seed
  -- ══════════════════════════════════════════════════════════════════
  -- Every row:
  --   • plate matches a vehicle inserted above (active plates preferred)
  --   • driver_name / driver_license = Demo Driver / TX-A2947153 (Fix E)
  --   • is_confirmed=TRUE
  --   • property matches an existing demo property
  --   • created_at = day_bucket - N days + H hours + M minutes
  -- Distribution asserts:
  --   • 5 new + 8 tow_ticket = 13 OPEN, split 4/5/4 across
  --     0-7d / 8-30d / 30+d aging buckets
  --   • 15 resolved + 2 disputed = 17 CLOSED spread across 0-90d
  --   • 2 resolved rows carry voided_at (voided pipeline populates)
  --   • Property distribution: 14 SR / 7 WB / 9 NG
  --   • Hour clustering: ~19 in 22-03, 6 in 5-7, 3 in 12-14, 2 in 15-17
  --
  -- Idempotent: SELECT-then-INSERT keyed on (plate, property, created_at).

  DECLARE
    r RECORD;
    v_created TIMESTAMPTZ;
    v_voided TIMESTAMPTZ;
    v_veh_make  TEXT;
    v_veh_model TEXT;
    v_veh_year  INT;
    v_veh_color TEXT;
  BEGIN
    FOR r IN
      SELECT * FROM (VALUES
        -- ── OPEN 0-7d (4 rows) ──────────────────────────────────────
        ('TX7HDN82', c_prop_sunset, 'no_parking_permit',   'Building A rear lot',  'no_permit', 'new',        3,  23, 15, 0),
        ('TX6WXP38', c_prop_sunset, 'fire_lane',           'Main entry curb',      'fire lane', 'tow_ticket', 5,  22, 30, 0),
        ('TX3XKV52', c_prop_willow, 'no_parking_permit',   'Visitor spot 7',       'no permit', 'new',        6,  1,  20, 0),
        ('TX3GBP54', c_prop_north,  'reserved_parking',    'Employee row',         'occupied reserved', 'tow_ticket', 2, 6, 15, 0),

        -- ── OPEN 8-30d (5 rows) ─────────────────────────────────────
        ('TX0RSY93', c_prop_sunset, 'blocking_access',     'Dumpster area',        'blocking bin access', 'tow_ticket', 12, 23, 45, 0),
        ('TX3TWQ29', c_prop_sunset, 'no_parking_zone',     'Fire hydrant zone',    'red curb',      'tow_ticket', 18, 22, 10, 0),
        ('TX9MHT81', c_prop_willow, 'no_parking_permit',   'Building B lot',       'no permit',     'new',        15, 5,  30, 0),
        ('TX7LMS29', c_prop_north,  'reserved_parking',    'Loading dock 2',       'unauthorized loading', 'tow_ticket', 22, 0, 45, 0),
        ('TX6NVT48', c_prop_north,  'no_parking_permit',   'Building C south',     'no permit',     'new',        25, 6, 50, 0),

        -- ── OPEN 30+d (4 rows) ──────────────────────────────────────
        ('TX9PXS12', c_prop_sunset, 'no_parking_permit',   'Guest overflow row',   'no permit',     'new',        38, 2,  30, 0),
        ('TX6VCR78', c_prop_sunset, 'blocking_access',     'Gate approach',        'blocking gate', 'tow_ticket', 45, 22, 50, 0),
        ('TX9QDF63', c_prop_north,  'reserved_parking',    'Executive row',        'reserved',      'tow_ticket', 52, 23, 20, 0),
        ('TX6NVT48', c_prop_north,  'wrong_space',         'Handicap zone',        'not permitted', 'tow_ticket', 65, 13, 15, 0),

        -- ── CLOSED — Sunset Ridge resolved / disputed (8) ───────────
        ('TX3QLW56', c_prop_sunset, 'no_parking_permit',   'Visitor row',          NULL, 'resolved', 8,  0,  20, 0),
        ('TX9KRV14', c_prop_sunset, 'expired_visitor_pass','Visitor spot 3',       NULL, 'resolved', 14, 22, 45, 0),
        ('TX2FMB74', c_prop_sunset, 'no_parking_permit',   'Overflow row',         NULL, 'resolved', 20, 1,  15, 0),
        ('TX8CJT61', c_prop_sunset, 'blocking_access',     'Mailroom curb',        NULL, 'resolved', 28, 23, 30, 0),
        ('TX5GVK41', c_prop_sunset, 'no_parking_zone',     'Fire hydrant zone',    NULL, 'resolved', 35, 5,  40, 0),
        ('TX7BLD56', c_prop_sunset, 'no_parking_permit',   'Building A lot',       NULL, 'resolved', 42, 22, 15, 0),
        -- voided_at populated: row 20 (50d ago @ 06:20, voided 2d after created)
        ('TX2JHN45', c_prop_sunset, 'expired_visitor_pass','Visitor spot 5',       NULL, 'resolved', 50, 6,  20, 2),
        ('TX4YKB33', c_prop_sunset, 'wrong_space',         'Reserved row 12',      NULL, 'disputed', 55, 15, 45, 0),

        -- ── CLOSED — Willowbrook resolved (5) ───────────────────────
        -- voided_at populated: row 22 (4d ago @ 05:50, voided 1d later)
        ('TX2QLS16', c_prop_willow, 'expired_visitor_pass','Visitor spot A2',      NULL, 'resolved', 4,  5,  50, 1),
        ('TX4JBM48', c_prop_willow, 'no_parking_permit',   'Building B curb',      NULL, 'resolved', 11, 23, 10, 0),
        ('TX8PWD24', c_prop_willow, 'no_parking_zone',     'Fire lane B',          NULL, 'resolved', 32, 1,  40, 0),
        ('TX0KTR91', c_prop_willow, 'blocking_access',     'Compactor area',       NULL, 'resolved', 60, 12, 45, 0),
        ('TX1YVN82', c_prop_willow, 'expired_visitor_pass','Visitor spot B1',      NULL, 'resolved', 88, 22, 15, 0),

        -- ── CLOSED — Northgate resolved / disputed (4) ──────────────
        ('TX4RBM75', c_prop_north,  'reserved_parking',    'Loading dock 1',       NULL, 'resolved', 9,  0,  30, 0),
        ('TX8CLK39', c_prop_north,  'no_parking_zone',     'Fire hydrant zone',    NULL, 'resolved', 40, 22, 35, 0),
        ('TX0PXH52', c_prop_north,  'no_parking_permit',   'Contractor lot',       NULL, 'resolved', 70, 16, 20, 0),
        ('TX5WMR86', c_prop_north,  'wrong_space',         'Handicap zone',        NULL, 'disputed', 21, 14, 30, 0)
      ) AS t(plate, prop, viol_type, location, notes, status, days_ago, hh, mm, voided_days_after)
    LOOP
      v_created := v_day - (r.days_ago || ' days')::INTERVAL
                 + (r.hh || ' hours ' || r.mm || ' minutes')::INTERVAL;

      -- Idempotent: skip if a violation with this (plate, property,
      -- created_at) already exists.
      SELECT count(*) INTO v_exists FROM public.violations
       WHERE plate = r.plate AND property = r.prop AND created_at = v_created;
      IF v_exists > 0 THEN
        CONTINUE;
      END IF;

      -- Pull vehicle attributes for this plate/property (make/model/year/color)
      -- so the violation row's vehicle_* fields match the seeded vehicle.
      -- Reset the vars first (scalar SELECT INTO sets NULL on no-rows, but
      -- being explicit is cheap belt-and-suspenders across the loop).
      v_veh_make := NULL; v_veh_model := NULL; v_veh_year := NULL; v_veh_color := NULL;
      SELECT make, model, year, color
        INTO v_veh_make, v_veh_model, v_veh_year, v_veh_color
        FROM public.vehicles
       WHERE plate = r.plate AND property = r.prop
       LIMIT 1;

      v_voided := NULL;
      IF r.voided_days_after > 0 THEN
        v_voided := v_created + (r.voided_days_after || ' days')::INTERVAL;
      END IF;

      INSERT INTO public.violations (
        plate, violation_type, location, notes, property,
        driver_name, driver_license,
        vehicle_color, vehicle_make, vehicle_model, vehicle_year,
        is_confirmed, status, created_at, voided_at,
        voided_by_email, voided_by_role, void_reason
      ) VALUES (
        r.plate, r.viol_type, r.location, r.notes, r.prop,
        c_driver_name, c_driver_license,
        v_veh_color, v_veh_make, v_veh_model, v_veh_year,
        TRUE, r.status, v_created, v_voided,
        CASE WHEN v_voided IS NOT NULL THEN 'demo-manager@test.shieldmylot.com' END,
        CASE WHEN v_voided IS NOT NULL THEN 'manager' END,
        CASE WHEN v_voided IS NOT NULL THEN 'seed_demo_data_voided_sample' END
      );
      v_violations_created := v_violations_created + 1;
    END LOOP;
  END;

  RETURN jsonb_build_object(
    'properties_renamed',       v_properties_renamed,
    'properties_created',       v_properties_created,
    'facilities_created',       v_facilities_created,
    'residents_moved',          v_residents_moved,
    'residents_created',        v_residents_created,
    'spaces_created',           v_spaces_created,
    'space_residents_created',  v_space_residents_created,
    'vehicles_created',         v_vehicles_created,
    'visitor_passes_created',   v_visitor_passes_created,
    'violations_created',       v_violations_created,
    'company_id',               v_demo_id,
    'property_ids', jsonb_build_object(
      'sunset_ridge',            v_prop_sunset_id,
      'willowbrook_court',       v_prop_willow_id,
      'northgate_commerce',      v_prop_north_id
    )
  );
END
$func$;

-- Not exposed as a public API. service_role only — called by
-- scripts/seed-demo-data-ONE-TIME.ts via the service key.
REVOKE EXECUTE ON FUNCTION public.seed_demo_data() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.seed_demo_data() FROM anon;
REVOKE EXECUTE ON FUNCTION public.seed_demo_data() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.seed_demo_data() TO service_role;

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_RPC_ADDED',
  'companies',
  NULL,
  jsonb_build_object(
    'migration', '20260711_seed_demo_data_rpc',
    'rpc',       'seed_demo_data',
    'change',    'New SD RPC — extends Demo Company (company_env=demo) from 1 sparse property to a 3-property portfolio: renames Demo Property → Sunset Ridge Apartments (in-place); adds Willowbrook Court + Northgate Commerce Center; inserts 68 spaces, 29 residents, 15 space_residents ties, 45 vehicles (39 active + 4 pending + 2 declined), 15 visitor_passes (10 active + 5 expired), 1 storage_facilities (Demo Tow Yard), and 30 violations (13 OPEN across 4/5/4 aging buckets, 15 resolved + 2 disputed CLOSED, 2 resolved with voided_at, Peak Enforcement hour clustering, all attributed to Demo Driver). Cascades property rename into user_roles.property (mgr+leasing), drivers.assigned_properties, residents.property. Idempotent via SELECT-then-INSERT per row; guarded on company_env=demo pre-flight. Service_role only.',
    'rationale', 'Post-launch seed/wipe Layer 2 — Demo Company needed realistic operating data so the Insights dashboards, approval queue, and driver/resident portals render meaningfully in the demo tenant.'
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
--     AND proname = 'seed_demo_data';
--   -- Expected: 1 row; prosecdef=true; args = '' (no params).
--
--   SELECT grantee, privilege_type
--   FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public' AND routine_name = 'seed_demo_data';
--   -- Expected: service_role=EXECUTE (postgres owner harmless).
--   -- NOT authenticated, NOT anon, NOT PUBLIC.
--
-- VQ.B — First invocation (from SQL Editor as service key):
--   SELECT seed_demo_data();
--   -- Expected shape:
--   -- { "properties_renamed": 1, "properties_created": 2,
--   --   "facilities_created": 1, "residents_moved": 1,
--   --   "residents_created": 29, "spaces_created": 68,
--   --   "space_residents_created": 15, "vehicles_created": 45,
--   --   "visitor_passes_created": 15, "violations_created": 30,
--   --   "company_id": <N>,
--   --   "property_ids": { "sunset_ridge": <N>, "willowbrook_court": <N>,
--   --                     "northgate_commerce": <N> } }
--
-- VQ.C — Second invocation (idempotent):
--   SELECT seed_demo_data();
--   -- Expected: EVERY *_created / *_renamed / *_moved counter = 0.
--   -- property_ids stay the same.
--
-- VQ.D — Post-state row counts
--   SELECT count(*) FROM properties WHERE company = 'Demo Company';
--   -- Expected: 3.
--
--   SELECT count(*) FROM spaces WHERE company = 'Demo Company';
--   -- Expected: 68.
--
--   SELECT count(*) FROM residents WHERE company = 'Demo Company';
--   -- Expected: 30 (29 new + 1 moved demo-resident).
--
--   SELECT count(*) FROM space_residents sr
--     JOIN spaces s ON s.id = sr.space_id
--    WHERE s.company = 'Demo Company';
--   -- Expected: 15.
--
--   SELECT count(*) FROM vehicles v
--     JOIN properties p ON p.name = v.property
--    WHERE p.company = 'Demo Company';
--   -- Expected: 45.  Status breakdown: 39 active + 4 pending + 2 declined.
--
--   SELECT count(*) FROM visitor_passes vp
--     JOIN properties p ON p.name = vp.property
--    WHERE p.company = 'Demo Company';
--   -- Expected: 15.
--
--   SELECT count(*) FROM storage_facilities WHERE company = 'Demo Company';
--   -- Expected: 1 (Demo Tow Yard).
--
--   SELECT count(*) FROM violations v
--     JOIN properties p ON p.name = v.property
--    WHERE p.company = 'Demo Company';
--   -- Expected: 30.
--
-- VQ.D-add — Violation status + aging distribution
--   SELECT status, count(*) FROM violations v
--     JOIN properties p ON p.name = v.property
--    WHERE p.company = 'Demo Company' GROUP BY 1;
--   -- Expected: new=5, tow_ticket=8, resolved=15, disputed=2.
--
--   SELECT count(*) FROM violations v JOIN properties p ON p.name = v.property
--    WHERE p.company='Demo Company' AND voided_at IS NOT NULL;
--   -- Expected: 2 (both status=resolved).
--
--   SELECT CASE WHEN now()-created_at < interval '8 days'  THEN '0-7d'
--               WHEN now()-created_at < interval '31 days' THEN '8-30d'
--               ELSE '30+d' END AS bucket,
--          count(*)
--   FROM violations v JOIN properties p ON p.name = v.property
--   WHERE p.company='Demo Company' AND status IN ('new','tow_ticket')
--     AND voided_at IS NULL
--   GROUP BY 1;
--   -- Expected: 0-7d=4, 8-30d=5, 30+d=4.
--
-- VQ.D-add — Property distribution
--   SELECT v.property, count(*) FROM violations v
--     JOIN properties p ON p.name = v.property
--    WHERE p.company='Demo Company' GROUP BY 1;
--   -- Expected: Sunset Ridge Apartments=14, Willowbrook Court=7,
--   --           Northgate Commerce Center=9.
--
-- VQ.D-add — Driver attribution (Fix E)
--   SELECT count(*) FROM violations v JOIN properties p ON p.name = v.property
--    WHERE p.company='Demo Company' AND driver_name='Demo Driver'
--      AND driver_license='TX-A2947153';
--   -- Expected: 30 (every seeded violation carries the demo driver).
--
-- VQ.D-add — Cascade rename landed
--   SELECT email, property FROM user_roles
--    WHERE company='Demo Company' AND role IN ('manager','leasing_agent')
--    ORDER BY email;
--   -- Expected: each row's property array contains all 3 property names
--   -- (Sunset Ridge Apartments, Willowbrook Court, Northgate Commerce Center);
--   -- 'Demo Property' NEVER appears.
--
--   SELECT email, assigned_properties FROM drivers
--    WHERE company='Demo Company' AND lower(email)='demo-driver@test.shieldmylot.com';
--   -- Expected: assigned_properties = all 3 property names.
--
--   SELECT count(*) FROM properties WHERE company='Demo Company' AND name='Demo Property';
--   -- Expected: 0 (renamed).
--
-- VQ.E — Migration audit row landed
--   SELECT action, new_values->>'migration' AS migration, created_at
--   FROM audit_logs
--   WHERE new_values->>'migration' = '20260711_seed_demo_data_rpc'
--   ORDER BY created_at DESC LIMIT 1;
--
-- VQ.F — Structural safety: no Stripe artifacts on demo tenant
--   SELECT count(*) FROM companies
--    WHERE company_env IN ('test','demo')
--      AND (stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL);
--   -- Expected: 0. This seed adds ZERO Stripe writes.
-- ════════════════════════════════════════════════════════════════════

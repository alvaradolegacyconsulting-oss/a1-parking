-- ════════════════════════════════════════════════════════════════════
-- PRE-LAUNCH SCORCHED WIPE — TENANT DATA (ONE-TIME, ATOMIC)
-- 2026-07-09
--
-- Wraps the entire DB-side wipe (null-out + refuse-if-live guard +
-- DELETE cascade + user_roles preserve) in a single BEGIN/COMMIT so
-- a mid-run failure ROLLS BACK cleanly. Auth.users deletion is the
-- JS-side follow-up (240 API calls; can't be in a DB txn — expected).
--
-- ⚠️  DESTRUCTIVE. RETIRE THIS FILE (delete from repo) AFTER THE
--     ONE-TIME APPLY. Do not leave a general "wipe all tenants"
--     migration in the repo post-A1.
--
-- USAGE
--   1. scripts/prelaunch-reset-ONE-TIME.ts (--apply) does the JS
--      pre-flight asserts + interactive confirmations.
--   2. Script pauses and prints "Paste this file into Supabase SQL
--      Editor as ONE block, then press Enter here."
--   3. Operator pastes the ENTIRE contents of THIS FILE into SQL
--      Editor (single-paste discipline per
--      [[feedback_sql_editor_partial_apply]]).
--   4. Script verifies post-apply state (counts == 0 on tenant
--      tables, catalog stripe_prices unchanged, user_roles = 1).
--   5. Script proceeds to auth.users delete + summary.
--
-- SAFETY BUILT INTO THIS FILE
--   • Aegis role assertion (RAISE EXCEPTION if aegis.user_roles.role
--     is not 'admin') — post-wipe wouldn't have a super-admin.
--   • Refuse-if-live guard (RAISE EXCEPTION if any companies row
--     carries a Stripe ID post-null-out).
--   • user_roles post-delete count assertion (RAISE EXCEPTION if
--     != 1).
--   Any RAISE inside the BEGIN/COMMIT triggers auto-ROLLBACK. Zero
--   partial state possible.
--
-- ANCHORS
--   AEGIS_UUID  = 'a767da27-b452-475a-adda-1b75ae393c59'  (Jose lock July 9)
--   OLD_ADMIN   = '2066921f-edaf-45db-a29c-4129eee4a1d2'  (deleted in JS phase)
--   LEFTOVER_IDS = (52, 53, 56, 58, 80)  (Stripe-ID stale-pointer rows)
--
-- DELETE ORDER — reverse-topological per Jose's pg_constraint paste
-- (RESTRICT on stripe_prices→proposal_codes; NO ACTION on
-- dispute_requests→violations; rest CASCADE/SET NULL). Two additions
-- since first dry-run:
--   • space_assignment_history — explicit (cascade-independent; was
--     invisible in counts).
--   • flag_acknowledgments — explicit (B228 super-admin ack, tenant
--     scoped via company_id ON DELETE CASCADE).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

DO $wipe$
DECLARE
  v_aegis_id     UUID    := 'a767da27-b452-475a-adda-1b75ae393c59';
  v_aegis_email  TEXT;
  v_aegis_role   TEXT;
  v_stripe_count INT;
  v_ur_count     INT;
BEGIN
  -- ── SAFETY: aegis exists in auth.users + carries super-admin role
  SELECT email INTO v_aegis_email
    FROM auth.users WHERE id = v_aegis_id LIMIT 1;
  IF v_aegis_email IS NULL THEN
    RAISE EXCEPTION 'PRELAUNCH_WIPE: aegis (%) not in auth.users — refuse (Phase 3 not run)', v_aegis_id;
  END IF;

  SELECT role INTO v_aegis_role
    FROM public.user_roles
   WHERE lower(email) = lower(v_aegis_email) LIMIT 1;
  IF v_aegis_role IS NULL OR v_aegis_role <> 'admin' THEN
    RAISE EXCEPTION 'PRELAUNCH_WIPE: aegis user_roles.role=% (expected admin) — refuse (post-wipe would have no super-admin)', v_aegis_role;
  END IF;

  RAISE NOTICE 'PRELAUNCH_WIPE: aegis (%) confirmed as super-admin', v_aegis_email;

  -- ── STEP 1: Pre-wipe null-out on 5 leftover Stripe-ID stale-pointer rows
  UPDATE public.companies
     SET stripe_customer_id = NULL, stripe_subscription_id = NULL
   WHERE id IN (52, 53, 56, 58, 80);

  RAISE NOTICE 'PRELAUNCH_WIPE: null-out complete on 5 leftover rows';

  -- ── STEP 2: Refuse-if-live GUARD (LOAD-BEARING)
  --   Post-null-out, no row may carry a Stripe ID. If this ever fires
  --   in prod post-A1, a real customer's IDs are in scope and the
  --   entire transaction rolls back — customer protected.
  SELECT count(*) INTO v_stripe_count
    FROM public.companies
   WHERE stripe_customer_id IS NOT NULL
      OR stripe_subscription_id IS NOT NULL;
  IF v_stripe_count > 0 THEN
    RAISE EXCEPTION 'PRELAUNCH_WIPE: refuse-if-live GUARD failed — % companies still carry Stripe IDs post-null-out. ROLLING BACK.', v_stripe_count;
  END IF;

  RAISE NOTICE 'PRELAUNCH_WIPE: refuse-if-live guard passed (0 Stripe-ID rows)';

  -- ══════════════════════════════════════════════════════════════════
  -- STEP 3: DELETE cascade — reverse-topological
  -- ══════════════════════════════════════════════════════════════════

  -- Phase 3a — custom stripe_prices before proposal_codes (FK RESTRICT)
  DELETE FROM public.stripe_prices WHERE proposal_code_id IS NOT NULL;
  RAISE NOTICE 'PRELAUNCH_WIPE: deleted custom stripe_prices';

  -- Phase 3b — proposal_codes
  DELETE FROM public.proposal_codes;
  RAISE NOTICE 'PRELAUNCH_WIPE: deleted proposal_codes';

  -- Phase 3c — history (no FKs point into these from surviving tables)
  DELETE FROM public.audit_logs;
  DELETE FROM public.tos_acceptances;
  DELETE FROM public.stripe_events;
  RAISE NOTICE 'PRELAUNCH_WIPE: deleted history (audit_logs, tos_acceptances, stripe_events)';

  -- Phase 3d — tenant leaves (children first)
  DELETE FROM public.vehicle_plate_changes;      -- FK → vehicles
  DELETE FROM public.dispute_requests;            -- FK → violations (NO ACTION)
  DELETE FROM public.violation_photos;            -- FK → violations
  DELETE FROM public.violation_videos;            -- FK → violations
  DELETE FROM public.violations;
  DELETE FROM public.space_residents;             -- FK → spaces + residents
  DELETE FROM public.space_requests;              -- FK → properties
  DELETE FROM public.space_assignment_history;    -- NEW: FK → spaces (CASCADE)
  DELETE FROM public.spaces;                      -- FK → properties
  DELETE FROM public.guest_authorizations;        -- FK → properties
  DELETE FROM public.visitor_passes;              -- FK → properties
  DELETE FROM public.vehicles;                    -- FK → properties + residents/drivers
  RAISE NOTICE 'PRELAUNCH_WIPE: deleted tenant leaves';

  -- Phase 3e — intermediate tenant tables
  DELETE FROM public.flag_acknowledgments;        -- NEW: FK → companies (B228 tenant scoped)
  DELETE FROM public.storage_facilities;          -- FK → companies
  DELETE FROM public.residents;                   -- FK → properties
  DELETE FROM public.drivers;                     -- FK → companies
  RAISE NOTICE 'PRELAUNCH_WIPE: deleted intermediate tenant tables';

  -- Phase 3f — properties + user_roles preserve super-admin + companies
  DELETE FROM public.properties;                  -- FK → companies

  DELETE FROM public.user_roles
   WHERE lower(email) <> lower(v_aegis_email);

  SELECT count(*) INTO v_ur_count FROM public.user_roles;
  IF v_ur_count <> 1 THEN
    RAISE EXCEPTION 'PRELAUNCH_WIPE: post-delete user_roles count=% (expected 1: aegis). ROLLING BACK.', v_ur_count;
  END IF;

  RAISE NOTICE 'PRELAUNCH_WIPE: user_roles preserved 1 row (aegis)';

  DELETE FROM public.companies;

  RAISE NOTICE 'PRELAUNCH_WIPE: STEP 3 complete — all tenant data deleted';

END
$wipe$;

-- ── Audit-log INSERT ONCE the transaction commits (so a rollback
-- also rolls back this evidence). audit_logs was truncated above; this
-- becomes row #1 of the empty table.
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'PRELAUNCH_WIPE_APPLIED',
  'multiple',
  NULL,
  jsonb_build_object(
    'migration', '20260709_prelaunch_wipe_TENANT_DATA',
    'change',    'scorched wipe of tenant data + history; preserved aegis super-admin; catalog stripe_prices unchanged (proposal_code_id IS NULL)',
    'aegis_id',  'a767da27-b452-475a-adda-1b75ae393c59'
  ),
  now()
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION (the JS script runs these + halts if drift)
--
-- Expected post-apply state:
--
-- ── Tenant tables all empty:
--   SELECT
--     (SELECT count(*) FROM companies)                AS companies,
--     (SELECT count(*) FROM properties)               AS properties,
--     (SELECT count(*) FROM residents)                AS residents,
--     (SELECT count(*) FROM vehicles)                 AS vehicles,
--     (SELECT count(*) FROM drivers)                  AS drivers,
--     (SELECT count(*) FROM violations)               AS violations,
--     (SELECT count(*) FROM visitor_passes)           AS visitor_passes,
--     (SELECT count(*) FROM guest_authorizations)     AS guest_authorizations,
--     (SELECT count(*) FROM space_requests)           AS space_requests,
--     (SELECT count(*) FROM space_residents)          AS space_residents,
--     (SELECT count(*) FROM space_assignment_history) AS space_assignment_history,
--     (SELECT count(*) FROM spaces)                   AS spaces,
--     (SELECT count(*) FROM storage_facilities)       AS storage_facilities,
--     (SELECT count(*) FROM flag_acknowledgments)     AS flag_acknowledgments,
--     (SELECT count(*) FROM dispute_requests)         AS dispute_requests,
--     (SELECT count(*) FROM proposal_codes)           AS proposal_codes,
--     (SELECT count(*) FROM tos_acceptances)          AS tos_acceptances,
--     (SELECT count(*) FROM stripe_events)            AS stripe_events,
--     (SELECT count(*) FROM vehicle_plate_changes)    AS vehicle_plate_changes,
--     (SELECT count(*) FROM violation_photos)         AS violation_photos,
--     (SELECT count(*) FROM violation_videos)         AS violation_videos;
--   -- Expected: all 0.
--
-- ── user_roles = 1 (aegis only):
--   SELECT email, role FROM user_roles;
--   -- Expected: aegis@alvaradolegacyconsultingllc.com | admin
--
-- ── stripe_prices catalog KEPT (proposal_code_id IS NULL):
--   SELECT count(*) FROM stripe_prices WHERE proposal_code_id IS NULL;
--   -- Expected: 20 (unchanged from pre-wipe).
--   SELECT count(*) FROM stripe_prices WHERE proposal_code_id IS NOT NULL;
--   -- Expected: 0.
--
-- ── audit_logs = 1 (the PRELAUNCH_WIPE_APPLIED marker):
--   SELECT count(*) FROM audit_logs;
--   -- Expected: 1.
--
-- ── platform_settings UNCHANGED (never touched):
--   SELECT count(*) FROM platform_settings;
--   -- Expected: same count as pre-wipe.
--
-- If any of the above shows drift → snapshot restore.
-- ════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════
-- Cell 1 — PM Pro loses enforcement
-- ════════════════════════════════════════════════════════════════════
--
-- RULED by Jose 2026-10-23. PM Pro is sold as a property-management
-- plan; the home page's comparison table says "—" for full enforcement
-- on PM Pro. The product disagreed: property_management/legacy resolved
-- enforcement-capable on BOTH sides, because
--
--   • my_tier_enforcement_capable() reads `tier` and never `tier_type`,
--     and its FIRST branch is `legacy → TRUE` (load-bearing for A1);
--   • PM_LEGACY in tier-config.ts carries the enforcement flags, so the
--     CA Activity tab rendered.
--
-- A PM firm stamping tow tickets is a Chapter 2308 exposure and it
-- undercuts Operator Pro.
--
-- 🔴 ZERO CUSTOMER IMPACT, measured 2026-10-23: no company is on
-- property_management + legacy. All six tenants are
--   enforcement/legacy ....... Test-LEGACY, Demo Company, A1 Wrecker llc
--   enforcement/enforcement_only ... Test-ENF
--   property_management/pm_only .... Test-PM
--   property_management/pm_starter . Test PM Starter 2
-- PM Pro has never been sold. The three enforcement/legacy companies —
-- A1 among them — must keep every enforcement path, and are the
-- positive controls in the paired verification.
--
-- ── 🔴 WHY A TRIGGER AND NOT JUST THE HELPER ────────────────────────
-- The helper guards 8 SECURITY DEFINER RPCs. Violation creation also
-- has TWO direct client inserts that never reach an RPC:
--
--   app/driver/page.tsx:1456          the driver fallback insert
--   app/company_admin/page.tsx:3703   the CA-side insert
--
-- Changing the helper alone would leave both open — RLS and the column
-- grants from 20260904_violations_column_grant_tightening are all that
-- stands in front of them. The trigger is the one layer every writer
-- crosses. (tow_ticket_generated, by contrast, has NO direct writer in
-- app/: stamping and regeneration are RPC-only and already fully gated,
-- so this file does not touch that path.)
--
-- Jose's ruling: block the direct inserts with the trigger, do NOT
-- remove them here. The driver fallback's future is a separate
-- decision, filed with the driver-guard notes.
--
-- Apply: Supabase SQL Editor. No BEGIN/COMMIT.
-- Paired: wip-20261023_pm_pro_loses_enforcement_verification.sql
-- Code half: PM_LEGACY drops the enforcement flags (same commit),
--            gated by npm run verify:pmpronoenforcement
-- ════════════════════════════════════════════════════════════════════

-- ── PART 1 — the helper reads tier_type ─────────────────────────────
-- Reproduced from the applied 20260903_track_gating_helper.sql body.
-- Every error message, ERRCODE and the lower(trim()) equality
-- discipline are unchanged; the only change is the legacy branch.
--
-- CREATE OR REPLACE preserves grants and the comment. No parameters, so
-- there are no DEFAULTs to lose.
CREATE OR REPLACE FUNCTION public.my_tier_enforcement_capable()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_company   TEXT := public.get_my_company();
  v_tier      TEXT;
  v_tier_type TEXT;
BEGIN
  IF v_company IS NULL OR v_company = '' THEN
    RAISE EXCEPTION 'no_company_context: my_tier_enforcement_capable requires an authenticated user with a user_roles.company row. get_my_company() returned NULL/empty.'
      USING ERRCODE = '42501';
  END IF;

  -- lower(trim()) equality, NOT ILIKE. Metachar vector closed by
  -- companies_name_no_sql_metachar (1c3e8ef) but equality is the
  -- stronger discipline + matches Cap A un-neuter shape.
  SELECT tier, tier_type INTO v_tier, v_tier_type
    FROM public.companies
   WHERE lower(trim(name)) = lower(trim(v_company))
   LIMIT 1;

  IF v_tier IS NULL THEN
    RAISE EXCEPTION 'company_not_found: my_tier_enforcement_capable for company=%. get_my_company() returned a name not present in companies table.', v_company
      USING ERRCODE = '42501';
  END IF;

  -- 🔴 legacy IS NO LONGER UNCONDITIONAL. It is the backend key for
  -- BOTH Pro plans, so the track decides which Pro plan it is:
  --   enforcement/legacy          = Operator Pro  → enforcement YES
  --   property_management/legacy  = PM Pro        → enforcement NO
  -- A1 is enforcement/legacy and keeps TRUE, which is what the old
  -- unconditional branch existed for.
  IF v_tier = 'legacy' THEN
    IF v_tier_type = 'property_management' THEN
      RETURN FALSE;
    ELSIF v_tier_type = 'enforcement' THEN
      RETURN TRUE;
    ELSE
      -- Fail closed, same discipline as the unknown-tier branch below.
      -- companies.tier_type has no CHECK constraint today, so an
      -- unexpected value is possible; silently treating it as
      -- enforcement would hand Chapter 2308 authority to a row nobody
      -- classified. All 6 rows were verified standard on 2026-10-23.
      RAISE EXCEPTION 'tier_type_unrecognized: my_tier_enforcement_capable received tier_type=% for company=% on tier=legacy. legacy is the backend key for BOTH Pro plans, so the track must be known. Expected enforcement or property_management.',
        COALESCE(v_tier_type, 'NULL'), v_company;
    END IF;
  ELSIF v_tier = 'enforcement_only' THEN
    RETURN TRUE;
  ELSIF v_tier = 'pm_only' THEN
    -- Jose Sep 3 correction: negotiated PM customers ride pm_only.
    -- Enforcement capability is NOT bundled — a helper that granted
    -- enforcement to pm_only would hand negotiated-PM tenants
    -- Chapter 2308 tow-ticket authority they didn't buy.
    RETURN FALSE;
  ELSIF v_tier = 'pm_starter' THEN
    RETURN FALSE;
  ELSE
    RAISE EXCEPTION 'tier_unrecognized: my_tier_enforcement_capable received tier=% for company=%. Every value in companies_tier_valid must have an explicit branch in this fn. Add ELSIF v_tier = ''%'' THEN RETURN <bool>.',
      v_tier, v_company, v_tier;
  END IF;
END;
$func$;

COMMENT ON FUNCTION public.my_tier_enforcement_capable() IS
  'TRUE when the caller''s company may use enforcement features (violations, tow tickets, drivers). Reads companies.tier AND companies.tier_type, because legacy is the backend key for BOTH Pro plans: enforcement/legacy is Operator Pro (TRUE) and property_management/legacy is PM Pro (FALSE, ruled 2026-10-23). enforcement_only TRUE; pm_only and pm_starter FALSE. Raises on an unknown tier, and on an unknown tier_type when the tier is legacy, because the track then decides the answer. Gates 8 enforcement write-path RPCs plus the violations_require_enforcement_capability trigger.';

-- ── PART 2 — the trigger every writer crosses ───────────────────────
-- 🔴 SECURITY INVOKER, AND THAT IS THE WHOLE MECHANISM — the same
-- construction as public.vehicles_activation_guard()
-- (20261014_stage1c_vehicle_activation_guard.sql), for the same reason.
-- Inside a DEFINER function current_user is the OWNER, so a DEFINER
-- guard would see 'postgres' for every caller and this check would be
-- blind.
--
-- As INVOKER, current_user reflects the calling context:
--     PostgREST as a signed-in user  → 'authenticated'   GUARDED
--     any SECURITY DEFINER RPC       → its owner          passes
--     service_role (API routes, cron)→ 'service_role'     passes
--     psql / a migration             → 'postgres'         passes
--
-- 🔴 THE service_role EXEMPTION IS DELIBERATE AND TESTED, not
-- accidental: scripts and server routes such as app/lib/prospect-demo.ts
-- seed enforcement rows, they are trusted code, and they carry no JWT
-- company context — so my_tier_enforcement_capable() would raise
-- no_company_context at them rather than answering. The paired
-- verification asserts a service_role insert SUCCEEDS, so the exemption
-- cannot rot into a silent failure.
--
-- The DEFINER-RPC exemption is not a hole: driver_create_violation_with_
-- snapshot carries the same helper gate internally, so the RPC path is
-- checked once, inside the RPC, and the trigger covers everything else.
CREATE OR REPLACE FUNCTION public.reject_violation_without_enforcement_capability()
RETURNS TRIGGER
LANGUAGE plpgsql
-- 🔴 NO "SECURITY DEFINER" HERE. Adding it silently disables this
-- guard: current_user becomes the owner for every caller and the
-- branch below always returns early.
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- One comparison rather than a list of blessed callers. Everything
  -- that is not a signed-in PostgREST session passes.
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  -- Super-admin short-circuit, matching the `v_caller_role <> 'admin'
  -- AND` prefix the 8 RPC gates use. Admin has company = NULL by
  -- design, so without this the helper would raise no_company_context
  -- and lock super-admin out of the CA-portal insert path.
  IF public.get_my_role() = 'admin' THEN
    RETURN NEW;
  END IF;

  IF NOT public.my_tier_enforcement_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted: this subscription tier does not include enforcement features, so a violation cannot be created. Contact support to upgrade.'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Raised by violations_require_enforcement_capability. PM Pro (property_management + legacy) is a property-management plan; enforcement runs on the Operator plans.';
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.reject_violation_without_enforcement_capability() IS
  'BEFORE INSERT guard on violations. SECURITY INVOKER deliberately: current_user discriminates the calling context, so service_role, every SECURITY DEFINER RPC and psql pass while a direct PostgREST insert from a signed-in user is checked against my_tier_enforcement_capable(). Exists because violation creation has two direct client inserts (driver fallback, CA portal) that never reach the gated RPC. Super-admin short-circuits, as the 8 RPC gates do.';

DROP TRIGGER IF EXISTS violations_require_enforcement_capability ON public.violations;
CREATE TRIGGER violations_require_enforcement_capability
  BEFORE INSERT ON public.violations
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_violation_without_enforcement_capability();

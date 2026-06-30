-- ════════════════════════════════════════════════════════════════════
-- B228 Phase 2 — schema (api_cost_rates, flag_acknowledgments, indexes)
-- 2026-06-30
-- ════════════════════════════════════════════════════════════════════
--
-- WHAT
--   1. platform_settings.api_cost_rates JSONB — admin-editable per-call
--      cost rates for API_USAGE_METER cost estimation. Seeded with
--      defaults that read as "estimate".
--   2. flag_acknowledgments table — super-admin can mark a spike-flag
--      as "expected" (onboarding, planned bulk-upload, etc.) so it
--      doesn't keep alarming. Persisted per (company, flag_type) with
--      optional dismiss_until.
--   3. audit_logs(action, created_at) index — load-bearing for the
--      Phase 2 metering aggregations and spike-detection queries.
--      Safe IF NOT EXISTS.
--
-- WHY DEFAULTS for api_cost_rates
--   plate_read_usd ≈ Claude Sonnet 4-6 image cost / call (rough avg).
--   vin_lookup_usd ≈ typical third-party VIN/NHTSA service rate.
--   Both LABELED "estimate" in the console; admin tunes via Platform
--   tab when actuals from Anthropic/billing diverge.
--
-- WHY flag_acknowledgments owns its own table (not new_values JSON)
--   Indexed lookups: console reads "for each currently-spiking flag,
--   is it dismissed?" — a JOIN against this table is cleaner than
--   parsing audit_logs.new_values. Small write volume (clicks per
--   dismiss). Worth the table.
--
-- VERIFICATION
--   See _verification.sql:
--     §1 platform_settings.api_cost_rates exists + seeded
--     §2 flag_acknowledgments table + columns + RLS
--     §3 audit_logs index landed
--     §4 audit row landed
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. platform_settings.api_cost_rates JSONB ──────────────────────
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS api_cost_rates JSONB
    DEFAULT jsonb_build_object(
      'plate_read_usd', 0.012,
      'vin_lookup_usd', 0.05
    );

-- Backfill any existing row (id=1 per the platform_settings convention)
-- if api_cost_rates is null. Idempotent.
UPDATE public.platform_settings
   SET api_cost_rates = jsonb_build_object(
         'plate_read_usd', 0.012,
         'vin_lookup_usd', 0.05
       )
 WHERE id = 1
   AND api_cost_rates IS NULL;

COMMENT ON COLUMN public.platform_settings.api_cost_rates IS
  'B228 Phase 2 — per-call cost rate JSONB used by the super-admin console for cost estimates. Keys: plate_read_usd, vin_lookup_usd. Admin-editable. Labeled "estimate" in UI.';


-- ── 2. flag_acknowledgments table ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.flag_acknowledgments (
  id                       BIGSERIAL PRIMARY KEY,
  company_id               BIGINT      NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  flag_type                TEXT        NOT NULL,
  acknowledged_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by_email    TEXT        NOT NULL,
  dismiss_until            TIMESTAMPTZ,
  note                     TEXT,
  CONSTRAINT flag_acknowledgments_flag_type_valid CHECK (
    flag_type IN ('plate_reads', 'visitor_passes', 'self_registrations', 'bulk_uploads')
  )
);

-- One acknowledgment row per (company, flag_type) at a time — re-acking
-- the same flag replaces the prior row's dismiss_until. Index supports
-- the JOIN from the console aggregate query.
CREATE UNIQUE INDEX IF NOT EXISTS uq_flag_ack_company_flag
  ON public.flag_acknowledgments (company_id, flag_type);

-- RLS — super-admin (admin role) only, server-side enforced. Reads +
-- writes go through DEFINER RPCs (see _rpcs.sql), so the table itself
-- has restrictive default RLS with no policy. Service-role-bypass via
-- the DEFINER RPCs.
ALTER TABLE public.flag_acknowledgments ENABLE ROW LEVEL SECURITY;

-- Explicit grants. RLS denies all by default (no policies). DEFINER
-- RPCs in _rpcs.sql do the reads/writes with super-admin role check.
-- authenticated gets nothing direct — must go through the RPC.
REVOKE ALL ON public.flag_acknowledgments FROM PUBLIC, anon, authenticated;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.flag_acknowledgments TO service_role;

COMMENT ON TABLE public.flag_acknowledgments IS
  'B228 Phase 2 — super-admin acknowledges/dismisses a spike flag for (company, flag_type). RLS deny-all; access via DEFINER RPCs only.';


-- ── 3. audit_logs(action, created_at) index ───────────────────────
-- Load-bearing for the Phase 2 metering aggregations + spike queries.
-- IF NOT EXISTS so re-applying or running against a DB that already
-- has this is safe.
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created_at
  ON public.audit_logs (action, created_at DESC);

COMMENT ON INDEX public.idx_audit_logs_action_created_at IS
  'B228 Phase 2 — supports console metering aggregations (action=API_USAGE_METER) + spike detection (action IN multiple).';


-- ── 4. audit row ──────────────────────────────────────────────────
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_B228_PHASE2',
  'platform_settings',
  NULL,
  jsonb_build_object(
    'migration', '20260630_b228_phase2_schema',
    'changes',   jsonb_build_array(
      'ADD COLUMN platform_settings.api_cost_rates JSONB',
      'CREATE TABLE flag_acknowledgments with deny-all RLS',
      'CREATE INDEX idx_audit_logs_action_created_at'
    ),
    'phase',     'B228 Phase 2 — metering + cost + spikes + PM per-property permits'
  ),
  now()
);

COMMIT;

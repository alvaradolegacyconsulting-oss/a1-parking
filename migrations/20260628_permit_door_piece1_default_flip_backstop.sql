-- ════════════════════════════════════════════════════════════════════
-- Permit-Door Piece 1 — Migration B (default-flip backstop)
-- 2026-06-28
-- ════════════════════════════════════════════════════════════════════
--
-- WHAT:
--   ALTER TABLE public.vehicles ALTER COLUMN status SET DEFAULT 'pending';
--
-- WHY IT'S SAFE NOW (and was NOT before):
--   Piece 1 (commit b1ade67, deployed before this migration) routes
--   every vehicle-insert through `initialVehicleState(tier)`, which
--   EXPLICITLY sets `status` at each call site:
--     - PM-Only         → status='pending', is_active=false
--     - all other tiers → status='active',  is_active=true
--   Plus 2 sites that are correctly NOT helper-routed but still
--   explicit-set status:
--     - app/api/register/companion-vehicle/route.ts:247 → 'pending'
--       (public self-register; always pending by trust-model design)
--     - request_my_vehicle() RPC (deactivation_model.sql:267) →
--       'pending' (resident-portal self-request; always pending)
--   So NO insert relies on the column DEFAULT today.
--
-- WHY IT'S A BACKSTOP, NOT A POLICY CHANGE:
--   The flip changes behavior ONLY for a future insert site that
--   FORGETS the helper / forgets to explicit-set status. Those land
--   `pending` (operator-approves) instead of silent `active` (billing
--   leak on PM-Only). Fails SAFE.
--
-- WHY THIS SHIPS LAST (after Piece 1 deployed):
--   If applied BEFORE Piece 1 deploys, pre-Piece-1 code that didn't
--   explicit-set status would suddenly insert with `pending` across
--   all tiers — broken UX for Enforcement (where vehicles should
--   auto-activate). This is the deploy-window risk the original
--   single-commit plan flagged; we split the migrations to close it.
--
-- VERIFICATION:
--   See sibling file 20260628_permit_door_piece1_default_flip_backstop_verification.sql
--   - §0 preflight: confirm pre-flip default is still 'active'
--   - §1 default flipped to 'pending'
--   - §2 behavioral proof: a no-status insert lands 'pending'
--   - §3 audit row landed
--
-- ════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.vehicles ALTER COLUMN status SET DEFAULT 'pending';

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_PERMIT_DOOR_FIX',
  'vehicles',
  NULL,
  jsonb_build_object(
    'migration',     '20260628_permit_door_piece1_default_flip_backstop',
    'piece',         'permit-door piece 1 migration B (default-flip backstop)',
    'change',        'vehicles.status DEFAULT active → pending',
    'rationale',     'backstop only — Piece 1 (commit b1ade67) helper explicit-sets status at every insert site; flip makes a forgotten future site fail safe to pending not active',
    'safe_because',  'Piece 1 deployed; no insert relies on the default (verified §0.3 preflight)',
    'sites_audited', jsonb_build_array(
      'app/manager/page.tsx:1234 (helper-routed)',
      'app/manager/page.tsx:1339 (helper-routed)',
      'app/api/billing/bulk-invite/route.ts:315 (helper-routed)',
      'app/api/register/companion-vehicle/route.ts:247 (explicit pending; helper-excluded by design)',
      'request_my_vehicle() RPC (explicit pending; deactivation_model.sql:267)'
    )
  ),
  now()
);

COMMIT;

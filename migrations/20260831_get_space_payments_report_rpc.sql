-- ══════════════════════════════════════════════════════════════════════
-- 20260831_get_space_payments_report_rpc.sql
--
-- 🟢 Reserved-space payment tracking arc — COMMIT 4 of 4 (DB half)
--
-- Creates public.get_space_payments_report(TEXT, DATE) — read-only
-- aggregate for the month view. INVOKER, not DEFINER: RLS on
-- public.spaces + public.space_payments applies inside the function,
-- so the caller's row-level policies do the scoping.
--
-- ── 🔴 WHY INVOKER (Mateo Aug 31 §4) ────────────────────────────────
--
-- I initially proposed DEFINER "to keep property-scope enforcement
-- in one place." That was WRONG — DEFINER would mean writing the
-- property-scope check by hand in the function body, which is
-- exactly the gap update_space_metadata has and record_space_payment
-- was specifically written not to inherit.
--
-- INVOKER lets the RLS policies we shipped in Commit 2 do the work:
--   • manager sees rows where property ∈ get_my_properties() (equality)
--   • leasing_agent sees the same
--   • company_admin sees rows where company matches theirs
--   • admin sees all
-- The function inherits these automatically. No re-implementation,
-- no drift risk.
--
-- Concrete case: the ~100 orphaned Test-LEGACY spaces at the
-- July-15-renamed property surfaced Aug 31 §2 — under INVOKER, a
-- manager's RLS excludes them automatically (property isn't in
-- their list). Under DEFINER with company-only filter, they'd all
-- appear in a report for a property that doesn't exist. INVOKER
-- avoids that by construction.
--
-- ── SIGNATURE + BEHAVIOR ───────────────────────────────────────────
-- get_space_payments_report(
--   p_property     TEXT,
--   p_period_month DATE
-- ) RETURNS TABLE (one row per fee-bearing space at that property):
--   space_id, space_label, space_type, monthly_fee, recorded_total,
--   status ('paid'|'partial'|'outstanding'|'overpaid'),
--   is_vacant, is_decommissioned (FLAGS — a decommissioned space can
--     also be partially paid, per Mateo Aug 31 §4),
--   latest_resident_email, latest_resident_name, latest_resident_unit
--     (from the most recent unvoided payment in the period, if any)
--
-- SCOPE:
--   • WHERE monthly_fee IS NOT NULL — only fee-bearing spaces
--   • NO is_active filter — vacant + decommissioned still appear
--     (property wants to see revenue it isn't collecting)
--   • lower(trim(property)) equality — NOT ~~*, mirrors Commit 2 divergence
--   • Voided payments EXCLUDED from recorded_total (consistent with
--     the tow-rate widget excluding voided from both numerator and
--     denominator; a voided payment recorded that a correction
--     happened — the money didn't actually come in)
--   • Period normalized to first-of-month via date_trunc at the
--     boundary — friendlier than raising on mid-month input.
--
-- STATUS classification (recorded_total vs monthly_fee):
--   recorded_total = 0                     → 'outstanding'
--   0 < recorded_total < monthly_fee       → 'partial'
--   recorded_total = monthly_fee           → 'paid'
--   recorded_total > monthly_fee           → 'overpaid'
--
-- ── GRANTS ─────────────────────────────────────────────────────────
-- authenticated has EXECUTE. INVOKER means the caller's role + RLS
-- policies control what rows come back — no additional grants
-- needed on spaces / space_payments because those already grant
-- SELECT to authenticated + have RLS policies.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.get_space_payments_report(
  p_property     TEXT,
  p_period_month DATE
)
RETURNS TABLE (
  space_id                BIGINT,
  space_label             TEXT,
  space_type              TEXT,
  monthly_fee             NUMERIC(10,2),
  recorded_total          NUMERIC(12,2),
  status                  TEXT,
  is_vacant               BOOLEAN,
  is_decommissioned       BOOLEAN,
  latest_resident_email   TEXT,
  latest_resident_name    TEXT,
  latest_resident_unit    TEXT
)
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = public, pg_temp
AS $func$
  WITH p AS (
    SELECT date_trunc('month', p_period_month::timestamp)::date AS period
  ),
  fee_spaces AS (
    -- Fee-bearing spaces at this property. No is_active filter;
    -- decommissioned spaces stay in the report so the property can
    -- see revenue it isn't collecting. RLS on public.spaces filters
    -- to the caller's scope automatically (INVOKER — see header).
    SELECT
      s.id,
      s.label,
      s.type,
      s.monthly_fee,
      s.is_active,
      -- Decommissioned = soft-deleted via is_active=FALSE. Independent
      -- of vacancy — a decommissioned space might still have been
      -- paid before decommission (rare but honest).
      NOT s.is_active AS is_decomm,
      -- Vacant = no space_residents ties right now, regardless of
      -- historical state. Independent of decommissioned per Mateo
      -- Aug 31 §4 (a decommissioned space can also be partially paid).
      NOT EXISTS (
        SELECT 1 FROM public.space_residents sr WHERE sr.space_id = s.id
      ) AS is_vac
    FROM public.spaces s
    WHERE lower(trim(s.property)) = lower(trim(p_property))
      AND s.monthly_fee IS NOT NULL
  ),
  agg AS (
    -- Per-space recorded_total for the period, excluding voided rows.
    -- LEFT JOIN so fee-bearing spaces with NO payments in the period
    -- still land in the report (recorded_total = 0, status = outstanding).
    SELECT
      fs.id,
      fs.label,
      fs.type,
      fs.monthly_fee,
      fs.is_decomm,
      fs.is_vac,
      COALESCE(SUM(sp.amount) FILTER (WHERE sp.voided_at IS NULL), 0)::NUMERIC(12,2) AS rec_total
    FROM fee_spaces fs
    LEFT JOIN public.space_payments sp
      ON sp.space_id     = fs.id
     AND sp.period_month = (SELECT period FROM p)
    GROUP BY fs.id, fs.label, fs.type, fs.monthly_fee, fs.is_decomm, fs.is_vac
  ),
  latest_res AS (
    -- Latest unvoided payment's resident snapshot per space in the
    -- period. DISTINCT ON returns one row per space_id. If no
    -- unvoided payment has resident info (all NULL snapshots from
    -- the multi-tie / vacant case), no row is returned — the
    -- final LEFT JOIN below yields NULL resident fields.
    SELECT DISTINCT ON (sp.space_id)
      sp.space_id,
      sp.resident_email,
      sp.resident_name,
      sp.unit
    FROM public.space_payments sp
    WHERE sp.period_month = (SELECT period FROM p)
      AND sp.voided_at IS NULL
      AND sp.resident_email IS NOT NULL
    ORDER BY sp.space_id, sp.recorded_at DESC
  )
  SELECT
    a.id                              AS space_id,
    a.label                           AS space_label,
    a.type                            AS space_type,
    a.monthly_fee,
    a.rec_total                       AS recorded_total,
    CASE
      WHEN a.rec_total = 0             THEN 'outstanding'
      WHEN a.rec_total < a.monthly_fee THEN 'partial'
      WHEN a.rec_total = a.monthly_fee THEN 'paid'
      WHEN a.rec_total > a.monthly_fee THEN 'overpaid'
    END                               AS status,
    a.is_vac                          AS is_vacant,
    a.is_decomm                       AS is_decommissioned,
    lr.resident_email                 AS latest_resident_email,
    lr.resident_name                  AS latest_resident_name,
    lr.unit                           AS latest_resident_unit
  FROM agg a
  LEFT JOIN latest_res lr ON lr.space_id = a.id
  -- Decommissioned to the bottom so active spaces surface first in
  -- the UI. Alpha by label within each group.
  ORDER BY a.is_decomm ASC, a.label ASC;
$func$;

COMMENT ON FUNCTION public.get_space_payments_report(TEXT, DATE) IS
  '2026-08-31. Reserved-space payment tracking Commit 4 — read-only aggregate for the month view. INVOKER (not DEFINER) so RLS on spaces + space_payments applies inside the function per Mateo Aug 31 §4. One row per fee-bearing space at the property, for the given period. Voided payments excluded from recorded_total. Vacant + decommissioned are independent BOOLEAN flags (not statuses) so a decommissioned space can also carry a partial-payment status. Status: paid/partial/outstanding/overpaid. Resident snapshot from most recent unvoided payment in the period. Property scoping via lower(trim()) equality — mirrors Commit 2 RLS divergence.';

-- ── GRANTS ──────────────────────────────────────────────────────────
-- INVOKER inheriting caller's RLS, so authenticated is all we need.
REVOKE EXECUTE ON FUNCTION public.get_space_payments_report(TEXT, DATE) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_space_payments_report(TEXT, DATE) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_space_payments_report(TEXT, DATE) TO authenticated;

-- ── Schema audit row ────────────────────────────────────────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_GET_SPACE_PAYMENTS_REPORT_V1',
  'public.get_space_payments_report',
  'commit_4a_of_4',
  jsonb_build_object(
    'migration', '20260831_get_space_payments_report_rpc',
    'arc',       'Reserved-space payment tracking — Commit 4a of 4 (RPC only; UI is 4b)',
    'signature', 'get_space_payments_report(p_property TEXT, p_period_month DATE) → TABLE(11 cols)',
    'security',  'INVOKER — RLS on spaces + space_payments applies inside. Property-scope enforcement is NOT re-implemented in this body (avoids the update_space_metadata gap that record_space_payment was written not to inherit).',
    'behavior',  jsonb_build_object(
      'scope',              'lower(trim(property)) equality (mirrors Commit 2 RLS divergence — NOT ~~*)',
      'fee_filter',         'WHERE monthly_fee IS NOT NULL — only fee-bearing spaces',
      'active_filter',      'NONE — vacant + decommissioned still appear (see revenue not collecting)',
      'voided_excluded',    'Voided payments excluded from recorded_total (consistent with tow-rate widget)',
      'status_classify',    '0→outstanding, <fee→partial, =fee→paid, >fee→overpaid',
      'independent_flags',  'is_vacant + is_decommissioned are both BOOLEAN, both can be true, neither is a status',
      'resident_snapshot',  'latest unvoided payment in period; NULL if none or if that payment has NULL resident snapshot'
    ),
    'grants',    'REVOKE PUBLIC/anon; GRANT EXECUTE to authenticated. INVOKER means caller RLS controls row visibility.',
    'next',      'Commit 4b: sub-panel UI in Spaces tab (manager + capability-prop mount for CA), CSV export as client-side transform on RPC result'
  ),
  now()
);

NOTIFY pgrst, 'reload schema';

COMMIT;

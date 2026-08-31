-- ══════════════════════════════════════════════════════════════════════
-- 20260831_get_space_payments_report_rpc_v2.sql
--
-- 🟢 Reserved-space payment tracking arc — Commit 4a AMENDMENT
--   (Mateo Aug 31 §2: roster-first correction)
--
-- Two changes to public.get_space_payments_report:
--
-- 1. ADD `assigned_residents JSONB` — from CURRENT space_residents
--    ties, NOT from payments. This is the roster column, and it's
--    what a manager most needs — "who should I bill for this space
--    this period?" — independent of whether a payment has been
--    recorded yet.
--
--    🔴 The 2+-tied → NULL rule from record_space_payment does NOT
--    apply here. That rule exists because assigning a payment to a
--    guessed resident is a false claim on a permanent financial
--    record. The roster is a factual list of who is currently
--    assigned — not a claim about who paid. Return ALL tied
--    residents. Two on a bundled space is information the manager
--    wants, not ambiguity to suppress.
--
--    latest_resident_* stays — the two answer different questions
--    ("who's on the space now" vs "who paid last for this period").
--
-- 2. RENAME status 'outstanding' → 'no_payment_recorded'
--
--    🔴 "Outstanding" asserts the resident didn't pay. We cannot
--    make that claim — most likely the money went through the rent
--    system and we simply never saw it. The Aug 21 record-only rule,
--    the other direction: we don't assert a payment happened, and
--    we don't assert one didn't.
--
--    UI displays as "No payment recorded".
--
-- ── DEPLOY SHAPE ────────────────────────────────────────────────────
-- Adding a column to RETURNS TABLE requires DROP + CREATE (Postgres
-- refuses "cannot change return type" on plain REPLACE). DROP first
-- kills the old signature entirely — no overload risk. No callers
-- exist yet (4b UI is unshipped), so the DROP window has zero blast
-- radius; the RPC is not yet used.
--
-- Safe to apply whether or not 0239dfa was applied first:
--   • If 0239dfa applied: DROP removes the v1 signature, CREATE
--     lands v2.
--   • If 0239dfa NOT applied: DROP IF EXISTS is a no-op, CREATE
--     lands v2 straight.
--
-- ── APPLY AFTER ─────────────────────────────────────────────────────
-- 1. Re-run 20260831_get_space_payments_report_rpc_verification.sql
--    (updated in this commit — VE1 expects 'no_payment_recorded'
--    now, adds VE8 for assigned_residents roster)
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- DROP the v1 signature. IF EXISTS handles the "not applied yet" case.
DROP FUNCTION IF EXISTS public.get_space_payments_report(TEXT, DATE);

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
  -- 🟢 v2 additions
  assigned_residents      JSONB,   -- CURRENT ties: [{email, name, unit}, ...] or []
  latest_resident_email   TEXT,    -- from latest unvoided payment in period
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
    SELECT
      s.id,
      s.label,
      s.type,
      s.monthly_fee,
      s.is_active,
      NOT s.is_active AS is_decomm,
      NOT EXISTS (
        SELECT 1 FROM public.space_residents sr WHERE sr.space_id = s.id
      ) AS is_vac
    FROM public.spaces s
    WHERE lower(trim(s.property)) = lower(trim(p_property))
      AND s.monthly_fee IS NOT NULL
  ),
  agg AS (
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
  -- 🟢 v2 — current space_residents ties, aggregated per space.
  -- Returns ALL active tied residents as a JSONB array; NULL becomes
  -- [] via COALESCE at the SELECT (jsonb_agg of empty rowset is NULL).
  -- No 2+-tied → NULL suppression: this is roster data, not a claim
  -- about who paid.
  ties AS (
    SELECT
      sr.space_id,
      jsonb_agg(
        jsonb_build_object(
          'email', r.email,
          'name',  r.name,
          'unit',  r.unit
        )
        ORDER BY r.name NULLS LAST, r.email
      ) AS residents
    FROM public.space_residents sr
    JOIN public.residents r ON lower(r.email) = lower(sr.resident_email)
    WHERE r.is_active
    GROUP BY sr.space_id
  ),
  latest_res AS (
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
    -- 🟢 v2 — status codes lowercase snake_case. UI maps to display:
    --   'no_payment_recorded' → "No payment recorded"
    --   'partial'             → "Partial"
    --   'paid'                → "Paid"
    --   'overpaid'            → "Overpaid"
    CASE
      WHEN a.rec_total = 0             THEN 'no_payment_recorded'
      WHEN a.rec_total < a.monthly_fee THEN 'partial'
      WHEN a.rec_total = a.monthly_fee THEN 'paid'
      WHEN a.rec_total > a.monthly_fee THEN 'overpaid'
    END                               AS status,
    a.is_vac                          AS is_vacant,
    a.is_decomm                       AS is_decommissioned,
    -- 🟢 v2 — always JSONB array (empty [] when no ties), never NULL,
    -- for cleaner UI iteration.
    COALESCE(t.residents, '[]'::jsonb) AS assigned_residents,
    lr.resident_email                 AS latest_resident_email,
    lr.resident_name                  AS latest_resident_name,
    lr.unit                           AS latest_resident_unit
  FROM agg a
  LEFT JOIN ties       t  ON t.space_id  = a.id
  LEFT JOIN latest_res lr ON lr.space_id = a.id
  ORDER BY a.is_decomm ASC, a.label ASC;
$func$;

COMMENT ON FUNCTION public.get_space_payments_report(TEXT, DATE) IS
  '2026-08-31 v2 (roster-first amendment per Mateo Aug 31 §2). Reserved-space payment tracking Commit 4a. Read-only aggregate for the month view. SECURITY INVOKER — RLS on spaces + space_payments applies inside. Returns one row per fee-bearing space at the property, for the period. v2 additions: assigned_residents JSONB array of CURRENT space_residents ties (roster; always [], never NULL), status ''outstanding'' renamed to ''no_payment_recorded'' (we don''t assert unpaid — money likely went through rent system we don''t see). Multi-tie roster returns ALL residents (not NULL like record_space_payment) — roster is factual, ledger is a claim. Voided payments still excluded from recorded_total. is_vacant + is_decommissioned still independent flags. UI displays codes: no_payment_recorded → "No payment recorded", paid/partial/overpaid → title case.';

REVOKE EXECUTE ON FUNCTION public.get_space_payments_report(TEXT, DATE) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_space_payments_report(TEXT, DATE) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_space_payments_report(TEXT, DATE) TO authenticated;

INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_GET_SPACE_PAYMENTS_REPORT_V2',
  'public.get_space_payments_report',
  'commit_4a_v2',
  jsonb_build_object(
    'migration',      '20260831_get_space_payments_report_rpc_v2',
    'arc',            'Reserved-space payment tracking — Commit 4a v2 (roster-first amendment)',
    'changes',        jsonb_build_array(
      'ADDED column: assigned_residents JSONB — CURRENT space_residents ties as [{email, name, unit}, ...], always [] never NULL',
      'RENAMED status: outstanding → no_payment_recorded (never assert unpaid — money likely went through rent)',
      'DROPPED then recreated v1 signature — RETURNS TABLE change forced full replace'
    ),
    'roster_epistemics', 'Multi-tie roster returns ALL residents. record_space_payment''s NULL-on-ambiguity rule does NOT apply here — roster is a factual list of who is currently assigned; ledger is a claim about who paid. Different questions, different rules.',
    'next',           'Commit 4b: sub-panel UI in Spaces tab, CSV export = roster columns, per-row opens SpaceDetailModal for that space (reuses payments section already there — no duplicate record form)'
  ),
  now()
);

NOTIFY pgrst, 'reload schema';

COMMIT;

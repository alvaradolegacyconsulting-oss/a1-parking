-- ══════════════════════════════════════════════════════════════════════
-- ORPHAN SPACES REPORT — report only, do not fix
-- 2026-08-31 · Mateo §2 (surfaced when VE4's Test-LEGACY orphan
--                        fixture was discovered)
--
-- Root incident: ~100 spaces at Test-LEGACY still reference
-- 'Test Legacy Property--- checkers ground', a property gone from
-- public.properties since the July-15 rename. Every manager RLS
-- policy scopes by property NAME, so these spaces are invisible to
-- every manager; company_admin scopes by company, so a CA sees them
-- at a property that isn't in their property list.
--
-- The Commit 4 concern: get_space_payments_report joins spaces to
-- space_payments and scopes fee-bearing spaces. If any orphan
-- carries monthly_fee (or accumulates payments), it lands in a
-- report for a property that doesn't exist.
--
-- These queries answer TWO SPECIFIC QUESTIONS:
--   Q1. Do any orphaned spaces carry a monthly_fee?
--   Q2. Does the same orphan class exist for A1 Wrecker LLC or Demo
--       Company, or only at Test-LEGACY?
--
-- 🔴 Report only. Do NOT UPDATE or DELETE any rows. The mechanism
-- (why renaming a property created orphans) belongs to a separate
-- arc — BACKLOG_property_rename_orphan_july15_2026.
-- ══════════════════════════════════════════════════════════════════════

-- ── R1: All orphaned spaces (property missing from public.properties) ─
-- Case-insensitive + trim match to compare spaces.property against
-- properties.name — same shape the app uses in fetchSpacesList /
-- pm_plate_lookup / RLS policies.
SELECT 'R1.ALL_ORPHANS' AS gate,
       s.company,
       s.property AS orphaned_property_name,
       COUNT(*) AS orphan_space_count,
       COUNT(*) FILTER (WHERE s.is_active) AS active_count,
       COUNT(*) FILTER (WHERE s.monthly_fee IS NOT NULL) AS with_fee_count,
       COALESCE(SUM(s.monthly_fee), 0) AS sum_monthly_fee_usd
  FROM public.spaces s
 WHERE NOT EXISTS (
   SELECT 1 FROM public.properties p
    WHERE lower(trim(p.name)) = lower(trim(s.property))
      AND lower(trim(p.company)) = lower(trim(s.company))
 )
 GROUP BY s.company, s.property
 ORDER BY s.company, orphan_space_count DESC;

-- ── R2: Fee-bearing orphaned spaces (the Commit 4 concern) ─────────
-- Any row here is a fee-bearing space that would appear in
-- get_space_payments_report for a property that doesn't exist. Zero
-- rows = Commit 4 safe from this class; any row = Commit 4 must
-- decide how to render orphaned fee-bearing spaces.
SELECT 'R2.FEE_BEARING_ORPHANS' AS gate,
       s.company,
       s.property AS orphaned_property_name,
       s.id AS space_id,
       s.label,
       s.monthly_fee,
       s.is_active
  FROM public.spaces s
 WHERE s.monthly_fee IS NOT NULL
   AND NOT EXISTS (
   SELECT 1 FROM public.properties p
    WHERE lower(trim(p.name)) = lower(trim(s.property))
      AND lower(trim(p.company)) = lower(trim(s.company))
 )
 ORDER BY s.company, s.property, s.label;

-- ── R3: Any space_payments rows against orphaned spaces? ───────────
-- If Commit 4's INVOKER RPC is safe (RLS filters via manager
-- property-scope), R3 rows would still be visible to CA via
-- company scope. Report presence + count.
SELECT 'R3.PAYMENTS_AGAINST_ORPHANS' AS gate,
       sp.company,
       sp.property AS orphaned_property_name,
       COUNT(*) AS payment_count,
       COUNT(*) FILTER (WHERE sp.voided_at IS NULL) AS unvoided_count,
       COALESCE(SUM(sp.amount) FILTER (WHERE sp.voided_at IS NULL), 0) AS unvoided_total_usd
  FROM public.space_payments sp
 WHERE NOT EXISTS (
   SELECT 1 FROM public.properties p
    WHERE lower(trim(p.name)) = lower(trim(sp.property))
      AND lower(trim(p.company)) = lower(trim(sp.company))
 )
 GROUP BY sp.company, sp.property
 ORDER BY sp.company, payment_count DESC;

-- ── R4: Cross-company breakdown — is this a Test-LEGACY thing? ─────
-- Answers Q2. Shows orphan-space counts by company. If A1 or Demo
-- Company have non-zero counts, the mechanism affects real tenants
-- (not just seeded test data) — that's a bigger arc.
SELECT 'R4.BY_COMPANY' AS gate,
       s.company,
       COUNT(DISTINCT s.property) AS distinct_orphaned_properties,
       COUNT(*) AS orphaned_space_count,
       COUNT(*) FILTER (WHERE s.is_active) AS active_count,
       COUNT(*) FILTER (WHERE s.monthly_fee IS NOT NULL) AS fee_bearing_count
  FROM public.spaces s
 WHERE NOT EXISTS (
   SELECT 1 FROM public.properties p
    WHERE lower(trim(p.name)) = lower(trim(s.property))
      AND lower(trim(p.company)) = lower(trim(s.company))
 )
 GROUP BY s.company
 ORDER BY orphaned_space_count DESC;

-- ── R5: Property-rename evidence — audit_logs from July 15 ─────────
-- If the mechanism was a rename via update_property_metadata (or
-- similar), audit_logs should have entries showing the old and new
-- names. Confirms the July-15 hypothesis + reveals whether the
-- mechanism has fired since.
SELECT 'R5.RENAME_EVIDENCE' AS gate,
       action,
       new_values,
       created_at
  FROM public.audit_logs
 WHERE action ILIKE '%PROPERTY%RENAME%'
    OR action ILIKE '%UPDATE_PROPERTY%'
    OR (new_values::text ILIKE '%old_name%'
        AND new_values::text ILIKE '%new_name%')
 ORDER BY created_at DESC
 LIMIT 20;

-- ══════════════════════════════════════════════════════════════════════
-- WHAT TO REPORT BACK
--
-- R1: total orphan population (should be ~100 at Test-LEGACY per
--     Mateo Aug 31; any surprise from A1/Demo is the finding)
-- R2: 🔴 if zero rows, Commit 4 unblocked. If any rows, the report
--     must decide how to render fee-bearing orphans.
-- R3: whether the ledger already has rows against orphaned spaces
--     (would explain any weird CA-vs-manager visibility divergence)
-- R4: cross-company breakdown — is this only Test-LEGACY?
-- R5: audit trail for the rename mechanism
--
-- Repair belongs to BACKLOG_property_rename_orphan_july15_2026 —
-- do NOT fix here. Mechanism (property rename creating orphans)
-- comes before data cleanup, per Mateo Aug 31.
-- ══════════════════════════════════════════════════════════════════════

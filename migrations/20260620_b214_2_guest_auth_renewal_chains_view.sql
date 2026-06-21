-- B214 commit 4 — renewal-chain aware oversight view.
--
-- Q6 (Jose 2026-06-20): make guest-auth-as-fake-residency VISIBLE if it
-- happens; don't pre-build enforcement. Surfaces plates with N+ consecutive
-- renewals so CA can eyeball patterns.
--
-- CRITICAL INSIGHT (Jose carry-forward 2026-06-20): renewal intentionally
-- creates a brief old+new overlap (cascade's order-by-end-date-desc returns
-- the new one — enforcement stays seamless). A naive "find plates with
-- overlapping active grants" view would flag every legit renewal as a
-- duplicate-grant. The view MUST walk the renewed_from_id chain so a
-- renewal-link reads as ONE logical chain, not two grants.
--
-- SCOPE (trimmed per Jose 2026-06-20):
--   • View A (guest_auth_chain_summary) — base, trimmed to columns long_chains uses
--   • View C (guest_auth_long_chains) — the actual report, filters chain_summary by renewal count
--   • View B (suspicious_overlaps) was SKIPPED — speculative; "two independent
--     overlapping chains" is unusual but not clearly abuse (likely benign
--     re-authorization after revoke). Build that view if real weird behavior
--     surfaces in practice. ~20 min add then; don't pre-build now.
--
-- THRESHOLD (Jose 2026-06-20): >= 2 renewals excluding root (i.e., 3+ grants
-- total — root + 2 renewals = 90+ days max under the 60-day-per-grant cap).
-- That's the cheapest-defensible "this plate has been here a while" filter.
--
-- RLS: both views declare `security_invoker = on` so they execute under the
-- caller's role with guest_authorizations' table RLS applied. Default
-- Postgres view ownership is the migration runner (typically postgres/
-- superuser), which would bypass RLS — explicit invoker mode keeps the
-- views company-scoped exactly like the underlying table.
--
-- GRANTs: REVOKE FROM anon + public; GRANT SELECT TO authenticated only.
-- Mirrors guest_authorizations table grants from the schema migration.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- VIEW A — guest_auth_chain_summary (base; one row per renewal chain)
-- ════════════════════════════════════════════════════════════════════
-- A "chain" = a root grant + 0..N renewals linked via renewed_from_id.
-- The recursive CTE walks the link tree top-down from each root, then
-- aggregates per-chain. The final SELECT exposes only the columns the
-- long_chains report consumes (Jose trim 2026-06-20).

CREATE OR REPLACE VIEW public.guest_auth_chain_summary
WITH (security_invoker = on) AS
WITH RECURSIVE chain AS (
  -- Seed: root grants (NOT renewed from anything)
  SELECT
    id          AS root_id,
    id          AS link_id,
    company,
    property,
    plate,
    guest_name,
    start_date,
    end_date,
    created_by_email,
    1           AS link_depth
  FROM public.guest_authorizations
  WHERE renewed_from_id IS NULL

  UNION ALL

  -- Walk: each renewal inherits its predecessor's root_id
  SELECT
    chain.root_id,
    ga.id,
    ga.company,
    ga.property,
    ga.plate,
    ga.guest_name,
    ga.start_date,
    ga.end_date,
    ga.created_by_email,
    chain.link_depth + 1
  FROM public.guest_authorizations ga
  JOIN chain ON ga.renewed_from_id = chain.link_id
)
SELECT
  root_id,
  company,
  property,
  plate,
  -- Latest guest_name in the chain — most recent renewal wins if a manager
  -- corrected a spelling mid-chain (rare but possible). Correlated subquery
  -- on the chain CTE itself; cheap because chains are short (max ~5-10 links
  -- under any realistic abuse pattern; usually 1-3).
  (SELECT guest_name FROM chain c2
    WHERE c2.root_id = chain.root_id
    ORDER BY link_depth DESC LIMIT 1)                  AS current_guest_name,
  COUNT(*)                                             AS renewal_count,
  COUNT(*) - 1                                         AS renewal_count_excl_root,
  SUM(end_date - start_date + 1)                       AS total_days_authorized,
  MIN(start_date)                                      AS first_grant_start,
  MAX(end_date)                                        AS latest_end,
  -- Distinct creators across the chain — surfaces "always the same manager"
  -- vs "rotating approval" patterns at a glance.
  ARRAY_AGG(DISTINCT created_by_email ORDER BY created_by_email) AS creator_emails
FROM chain
GROUP BY root_id, company, property, plate;

REVOKE ALL ON public.guest_auth_chain_summary FROM anon, public;
GRANT  SELECT ON public.guest_auth_chain_summary TO authenticated;

-- ════════════════════════════════════════════════════════════════════
-- VIEW C — guest_auth_long_chains (the actual oversight report)
-- ════════════════════════════════════════════════════════════════════
-- Filters chain_summary to chains with >= 2 renewals (3+ grants total,
-- 90+ days possible — the "this plate has been here a while" signal).
-- Ordered by total_days_authorized desc so the longest accumulated
-- presence surfaces first, with renewal_count desc as tie-break.

CREATE OR REPLACE VIEW public.guest_auth_long_chains
WITH (security_invoker = on) AS
SELECT *
FROM public.guest_auth_chain_summary
WHERE renewal_count_excl_root >= 2
ORDER BY total_days_authorized DESC, renewal_count DESC;

REVOKE ALL ON public.guest_auth_long_chains FROM anon, public;
GRANT  SELECT ON public.guest_auth_long_chains TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── A. Views exist + security_invoker is on ─────────────────────────
--   SELECT viewname, viewowner,
--          (SELECT option_value FROM pg_options_to_table(c.reloptions)
--           WHERE option_name = 'security_invoker') AS sec_invoker
--   FROM pg_views v
--   JOIN pg_class c ON c.relname = v.viewname
--   WHERE schemaname = 'public'
--     AND viewname IN ('guest_auth_chain_summary', 'guest_auth_long_chains')
--   ORDER BY viewname;
--   -- Expected: both viewname rows present, sec_invoker = 'on'.
--
-- ── B. Grants — authenticated only (NOT anon, NOT public) ───────────
--   SELECT table_name, grantee, privilege_type
--     FROM information_schema.role_table_grants
--    WHERE table_schema = 'public'
--      AND table_name IN ('guest_auth_chain_summary', 'guest_auth_long_chains')
--    ORDER BY table_name, grantee;
--   -- Expected: each view granted SELECT to 'authenticated' (and owner).
--   -- 'anon' and 'PUBLIC' MUST NOT appear.
--
-- ── C. Smoke: empty state ────────────────────────────────────────────
--   SELECT * FROM public.guest_auth_chain_summary LIMIT 5;
--   SELECT * FROM public.guest_auth_long_chains LIMIT 5;
--   -- Expected: chain_summary may return rows (every root grant becomes a
--   -- single-link chain); long_chains returns ZERO rows until a plate has
--   -- at least 2 renewals beyond its root.
--
-- ── D. Smoke: chain-walk works on a renewal ────────────────────────
--   -- After Jose creates an auth, renews 3x in succession:
--   -- SELECT root_id, plate, renewal_count, renewal_count_excl_root,
--   --        total_days_authorized, first_grant_start, latest_end, creator_emails
--   --   FROM public.guest_auth_chain_summary
--   --   WHERE plate = '<test_plate>';
--   -- Expected: 1 row with renewal_count = 4 (root + 3 renewals),
--   -- renewal_count_excl_root = 3, total_days = sum of all 4 spans
--   -- including any intentional renewal overlaps.
--
-- ── E. Smoke: threshold filter ─────────────────────────────────────
--   -- After ONE renewal (root + 1 renewal = renewal_count_excl_root = 1):
--   -- SELECT * FROM public.guest_auth_long_chains WHERE plate = '<test_plate>';
--   -- Expected: ZERO rows (1 < threshold of 2).
--   -- After TWO renewals: 1 row appears (passes threshold).
-- ════════════════════════════════════════════════════════════════════

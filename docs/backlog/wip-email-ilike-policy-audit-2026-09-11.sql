-- ══════════════════════════════════════════════════════════════════════
-- READ-ONLY AUDIT — `email ~~* (auth.jwt() ->> 'email')` policy sites
-- 2026-09-11. Resumes the audit stopped at §1 on 2026-09-07.
--
-- NOT A MIGRATION. Lives in docs/backlog/ per the standing rule —
-- migrations/ is reserved for applied files with paired verification.
-- Nothing here writes. Safe to run any number of times.
--
-- ── WHAT IS ALREADY ESTABLISHED ─────────────────────────────────────
-- `~~*` is ILIKE, so the caller's own email is used as a PATTERN. `_`
-- matches one character and is ordinary in an email address, so a
-- resident holding john_smith@x.com also matches johnasmith@x.com.
--
-- Escalation was ruled out in July: get_my_role(), get_my_company() and
-- get_my_properties() use equality, locked by
-- 20260610_b155_2_f9_helper_lower_match.sql. The auth spine holds.
-- THIS IS DISCLOSURE, NOT PRIVILEGE ESCALATION.
--
-- The Sept 4 company-name fix does not transfer: that was closed with a
-- metacharacter CHECK on input, and john_smith@gmail.com is a
-- legitimate address. The fix has to be at the policy layer.
--
-- ── 🔴 METHOD NOTE ──────────────────────────────────────────────────
-- String-matching `qual` is correct for DISCOVERY and wrong for a
-- verification GATE. Nothing below proves a policy is safe or unsafe —
-- it finds candidates to read. When the fix lands, its gates must be
-- EXECUTION-based: attempt the access as a real session, read the
-- actual denial, assert on that.
--
-- Run order: A, B, C, D. A and B are the enumeration; C classifies;
-- D answers "is anyone exposed right now."
-- ══════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════
-- A — ENUMERATION. Runtime catalog, not a grep of migrations/.
--
-- Policies get replaced and dropped; file history is not live state
-- (feedback_catalog_is_audit_surface_not_migrations). Deliberately
-- broad: catches ~~*, bare ~~, spelled-out ILIKE/LIKE, and
-- lower(email) ~~* variants.
-- ══════════════════════════════════════════════════════════════════════
SELECT
  schemaname, tablename, policyname, cmd, permissive, roles,
  qual, with_check
FROM pg_policies
WHERE qual       ~* '(email|e_?mail)[^,)]*(~~\*|~~|ILIKE|LIKE)'
   OR with_check ~* '(email|e_?mail)[^,)]*(~~\*|~~|ILIKE|LIKE)'
ORDER BY cmd, tablename, policyname;


-- ══════════════════════════════════════════════════════════════════════
-- B — COUNT vs THE EXPECTED 24.
--
-- 🔴 A discrepancy IS A FINDING, not something to reconcile silently.
-- Fewer than 24 means sites were closed (good — which ones?) or the
-- pattern missed a spelling (bad). More than 24 means new sites landed
-- since the Sept 7 count. Either way it is reported, not adjusted.
-- ══════════════════════════════════════════════════════════════════════
SELECT
  COUNT(*)                                   AS sites_found,
  24                                         AS sites_expected_2026_09_07,
  COUNT(*) - 24                              AS delta,
  CASE
    WHEN COUNT(*) = 24 THEN 'matches the Sept 7 count'
    WHEN COUNT(*) <  24 THEN 'FEWER than Sept 7 — sites closed, or this pattern misses a spelling. Investigate before trusting the list.'
    ELSE                     'MORE than Sept 7 — new sites landed since. Each needs classifying.'
  END                                        AS finding
FROM pg_policies
WHERE qual       ~* '(email|e_?mail)[^,)]*(~~\*|~~|ILIKE|LIKE)'
   OR with_check ~* '(email|e_?mail)[^,)]*(~~\*|~~|ILIKE|LIKE)';


-- ══════════════════════════════════════════════════════════════════════
-- C — CLASSIFY BY cmd AND BY ROLE.
--
-- SELECT            → disclosure.
-- UPDATE/DELETE/ALL → 🔴 CROSS-ACCOUNT WRITES. Higher severity, fixed
--                     first. The July note flags resident_update_vehicles
--                     and resident_update_passes as FOR UPDATE on this
--                     predicate, with some possibly superseded by
--                     7da03d2's DEFINER RPC. This query settles it —
--                     the catalog, not the note.
--
-- `roles` matters independently: a policy granted to `anon` is a
-- different problem from one granted to `authenticated`, because the
-- former needs no account at all.
--
-- `qual_is_only_email_match` separates the mechanical rewrites from the
-- ones that need reading — a policy whose predicate is ONLY the email
-- comparison can be rewritten by pattern; one with extra conditions
-- cannot.
-- ══════════════════════════════════════════════════════════════════════
SELECT
  cmd,
  roles::text                                        AS granted_to,
  tablename,
  policyname,
  (with_check IS NOT NULL)                           AS has_with_check,
  -- crude but useful: does the qual contain anything beyond the email
  -- comparison and boolean glue?
  (qual !~* '\mAND\M' AND qual !~* '\mOR\M')          AS qual_is_only_email_match,
  length(qual)                                       AS qual_len,
  CASE
    WHEN cmd IN ('UPDATE','DELETE','ALL') THEN '🔴 WRITE — cross-account write, fix first'
    WHEN cmd = 'INSERT'                   THEN '⚠ INSERT — check with_check, not qual'
    ELSE                                       'disclosure'
  END                                                AS severity_class
FROM pg_policies
WHERE qual       ~* '(email|e_?mail)[^,)]*(~~\*|~~|ILIKE|LIKE)'
   OR with_check ~* '(email|e_?mail)[^,)]*(~~\*|~~|ILIKE|LIKE)'
ORDER BY
  CASE cmd WHEN 'ALL' THEN 0 WHEN 'DELETE' THEN 1 WHEN 'UPDATE' THEN 2 WHEN 'INSERT' THEN 3 ELSE 4 END,
  tablename, policyname;


-- ══════════════════════════════════════════════════════════════════════
-- D — IS ANYONE EXPOSED TODAY?
--
-- Self-join every public table carrying an `email` column: does any
-- stored address, used as an ILIKE pattern, match a DIFFERENT stored
-- address? That is exactly what the policy predicate does at runtime.
--
-- Built as a loop over information_schema rather than a hand-written
-- query per table, because a hand-written list is a list someone has to
-- remember to extend — and the table that gets forgotten is the finding
-- that gets missed. Results go to a TEMP table so the run ENDS IN ROWS
-- (feedback_verification_returns_rows_no_transaction): a silent pass
-- and a not-run must not look alike.
--
-- ZERO rows everywhere → LATENT. The rewrite is properly-scoped work.
-- ANY rows                → LIVE. Stop and fix those tables immediately.
--
-- Note the asymmetry: A matching B does NOT imply B matches A. The
-- pattern holder is the one with the metacharacter, so both directions
-- are reported separately.
-- ══════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS _email_exposure_findings;
CREATE TEMP TABLE _email_exposure_findings (
  table_name     TEXT,
  pattern_email  TEXT,
  exposed_email  TEXT
);

DO $exposure$
DECLARE
  r         RECORD;
  v_sql     TEXT;
BEGIN
  FOR r IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'email'
       AND t.table_type   = 'BASE TABLE'
     ORDER BY c.table_name
  LOOP
    v_sql := format(
      'INSERT INTO _email_exposure_findings (table_name, pattern_email, exposed_email)
       SELECT %L, a.email, b.email
         FROM public.%I a
         JOIN public.%I b
           ON b.email ILIKE a.email
          AND lower(a.email) <> lower(b.email)',
      r.table_name, r.table_name, r.table_name);
    EXECUTE v_sql;
  END LOOP;
END
$exposure$;

-- Terminal SELECT — returns rows either way, so "no exposure" is
-- DISTINGUISHABLE from "the block did not run."
SELECT
  COALESCE(f.table_name, '(none)')                       AS table_name,
  f.pattern_email,
  f.exposed_email,
  CASE
    WHEN f.table_name IS NULL
      THEN '✅ LATENT — no stored address currently matches another. The rewrite is scoped work, not an incident.'
    ELSE '🔴 LIVE — this pattern_email already exposes exposed_email through every ILIKE policy on this table. Fix this table first.'
  END                                                    AS finding,
  (SELECT COUNT(*) FROM _email_exposure_findings)        AS total_exposure_pairs,
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'email')  AS email_columns_scanned,
  now()                                                  AS checked_at
FROM (SELECT NULL::TEXT AS table_name, NULL::TEXT AS pattern_email, NULL::TEXT AS exposed_email
      WHERE NOT EXISTS (SELECT 1 FROM _email_exposure_findings)
      UNION ALL
      SELECT table_name, pattern_email, exposed_email FROM _email_exposure_findings) f
ORDER BY f.table_name NULLS FIRST, f.pattern_email;


-- ══════════════════════════════════════════════════════════════════════
-- E — EVERY policy on `residents`, not just the ILIKE ones.
--     Added 2026-09-11 after Tier 2.
--
-- 🔴 WHY THE ILIKE-ONLY ENUMERATION IS NOT ENOUGH HERE. Tier 3's Group
-- C policies (spaces, vehicles, properties, visitor_passes, violations)
-- do not match on their own table's email — they SUBQUERY residents:
--
--     property IN (SELECT residents.property FROM residents
--                   WHERE residents.email ~~* (auth.jwt() ->> 'email'))
--
-- RLS on `residents` applies inside that subquery, and RLS is the OR of
-- ALL PERMISSIVE POLICIES — not just the one we rewrote. So the
-- subquery returns whatever the caller can see through ANY residents
-- policy. Rewriting resident_read_own to equality bounds it only if
-- nothing ELSE grants a resident broader visibility of that table.
--
-- Group C requires role = 'resident', so the question narrows to:
-- does any policy on residents grant a RESIDENT more than their own row?
--
--   · only resident_read_own applies to residents  → the inheritance
--     argument holds cleanly
--   · something else is permissive and broader      → that is a finding
--     independent of this arc, and it widens Group C by a route the
--     ILIKE enumeration never showed
--
-- Read `roles` and `qual` together: a policy scoped to manager or
-- company_admin does not widen a resident, but one gated on a role the
-- attacker could hold does.
-- ══════════════════════════════════════════════════════════════════════
SELECT
  policyname,
  cmd,
  permissive,
  roles::text AS granted_to,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename  = 'residents'
ORDER BY cmd, policyname;

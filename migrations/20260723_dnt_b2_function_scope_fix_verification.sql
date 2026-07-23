-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_dnt_b2_function_scope_fix_verification.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Verifies DNT Commit B2 — function-level company scope fix on 5 DNT
-- lookups + canonical DNT guard block + role-conditional reason.
--
-- ── Negative controls (pre-apply state) ───────────────────────────────
-- Every VQ was designed to fail (or pass, when preservation is asserted)
-- against the unfixed schema before this migration is applied. Silence
-- post-apply then means the fix landed, not that the check is toothless.
--
--   VQ.PARITY       — expect FAIL naming regenerate_tow_ticket
--                     (Commit A's confirmation query: regenerate has
--                      no do_not_tow_plates reference; other 4 do)
--   VQ.COMPANY      — expect FAIL naming all 5 sites (none contain
--                     `lower(trim(dnt_p.company))` shape yet)
--   VQ.LIFECYCLE    — expect PASS on 4 existing sites, FAIL on
--                     regenerate_tow_ticket (no DNT lookup yet)
--   VQ.SIGNATURE    — expect PASS pre and post (each function already
--                     single-definition; asserts no CREATE OR REPLACE
--                     created an overload)
--   VQ.UNRESOLVED   — expect FAIL naming all 3 tow-path guards
--                     (company_unresolved sentinel not yet present)
--   VQ.ISDNT_ORDER  — expect FAIL (v_is_dnt doesn't exist yet in
--                     check_dnt_plate)
--   VQ.REASON_ROLE  — expect FAIL (role-conditional CASE not yet
--                     present in check_dnt_plate)
--   VQ.AUDIT        — expect FAIL pre; PASS post
--
-- ── Scope disclaimer ──────────────────────────────────────────────────
-- All VQs are STRUCTURAL: they assert source-syntax shapes in
-- pg_get_functiondef output. They do NOT prove any guard refuses
-- anything. Behavioral proof (sessioned as manager/CA/driver, attempt
-- tow on a DNT plate → expect do_not_tow_active refusal; attempt
-- resolved/disputed transitions → expect success) is Commit 4.5's job.
-- Silence here means the source shape is right; refusal is proven
-- separately.
--
-- All queries silent on pass; failure RAISEs with a named site list.
-- Safe to re-run (read-only). Wrapped in BEGIN...COMMIT — first
-- RAISE aborts the transaction and subsequent VQs do not execute.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.PARITY — DNT guard present in BOTH tow-producing functions
-- ══════════════════════════════════════════════════════════════════════
-- Retires the ⚠ KEEP IN SYNC banner as documentation, replaces with an
-- executable control. The banner already failed once (regenerate had
-- no guard); a comment is not a control.
DO $vq_parity$
DECLARE
  v_stamp BOOLEAN;
  v_regen BOOLEAN;
BEGIN
  SELECT pg_get_functiondef(oid) LIKE '%do_not_tow_plates%' INTO v_stamp
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'stamp_tow_ticket'
    LIMIT 1;

  SELECT pg_get_functiondef(oid) LIKE '%do_not_tow_plates%' INTO v_regen
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'regenerate_tow_ticket'
    LIMIT 1;

  IF NOT (COALESCE(v_stamp, FALSE) AND COALESCE(v_regen, FALSE)) THEN
    RAISE EXCEPTION 'VQ.PARITY FAILED — DNT guard present in stamp_tow_ticket=% regenerate_tow_ticket=%',
      v_stamp, v_regen;
  END IF;
END $vq_parity$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.COMPANY — company-scoped DNT lookup on all 5 sites
-- ══════════════════════════════════════════════════════════════════════
-- Asserts the exact string `lower(trim(dnt_p.company)) = lower(trim(get_my_company()))`
-- appears in each of the 5 function definitions. `dnt_p` is unique to
-- the DNT block by convention, so this predicate cannot false-pass on
-- unrelated get_my_company() calls elsewhere in the function bodies
-- (e.g., set_violation_status:509 caller-auth check).
DO $vq_company$
DECLARE
  v_missing TEXT[];
  v_sites CONSTANT TEXT[] := ARRAY[
    'check_dnt_plate', 'pm_plate_lookup', 'set_violation_status',
    'stamp_tow_ticket', 'regenerate_tow_ticket'
  ];
BEGIN
  SELECT COALESCE(array_agg(proname ORDER BY proname), '{}') INTO v_missing
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = ANY (v_sites)
    AND pg_get_functiondef(oid) NOT LIKE '%lower(trim(dnt_p.company)) = lower(trim(get_my_company()))%';

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VQ.COMPANY FAILED — DNT lookup missing company predicate on: %', v_missing;
  END IF;
END $vq_company$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.LIFECYCLE — soft-delete + expiry filters preserved on all 5
-- ══════════════════════════════════════════════════════════════════════
-- Same class as B1's VQ.1b: assert the PRE-EXISTING predicates survived
-- the addition of new ones. If removed_at IS NULL is dropped from one
-- site, a soft-deleted plate keeps blocking tows forever ("removed from
-- the list but still can't tow"). If the expires_at clause is dropped,
-- expired protections never expire.
DO $vq_lifecycle$
DECLARE
  v_missing TEXT[];
  v_sites CONSTANT TEXT[] := ARRAY[
    'check_dnt_plate', 'pm_plate_lookup', 'set_violation_status',
    'stamp_tow_ticket', 'regenerate_tow_ticket'
  ];
BEGIN
  SELECT COALESCE(array_agg(proname ORDER BY proname), '{}') INTO v_missing
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = ANY (v_sites)
    AND (
      pg_get_functiondef(oid) NOT LIKE '%dnt.removed_at IS NULL%'
      OR pg_get_functiondef(oid) NOT LIKE '%dnt.expires_at IS NULL OR dnt.expires_at > now()%'
    );

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VQ.LIFECYCLE FAILED — removed_at/expires_at filter missing in DNT lookup on: %', v_missing;
  END IF;
END $vq_lifecycle$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.SIGNATURE — exactly one definition per function (no overloads)
-- ══════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE with a different arg signature creates a duplicate,
-- not a replacement. Assert exactly one row per function name.
DO $vq_signature$
DECLARE
  v_bad TEXT[];
BEGIN
  SELECT COALESCE(array_agg(proname || ':' || cnt::text ORDER BY proname), '{}') INTO v_bad
  FROM (
    SELECT proname, COUNT(*) AS cnt
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN (
        'check_dnt_plate', 'pm_plate_lookup', 'set_violation_status',
        'stamp_tow_ticket', 'regenerate_tow_ticket'
      )
    GROUP BY proname
  ) c
  WHERE cnt <> 1;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'VQ.SIGNATURE FAILED — function has overload(s), expected 1: %', v_bad;
  END IF;

  -- Also assert all 5 are present (a dropped function is count=0, not
  -- caught by the GROUP BY above since it groups only over existing).
  IF (SELECT COUNT(*)
        FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname IN (
           'check_dnt_plate', 'pm_plate_lookup', 'set_violation_status',
           'stamp_tow_ticket', 'regenerate_tow_ticket'
         )) <> 5 THEN
    RAISE EXCEPTION 'VQ.SIGNATURE FAILED — expected 5 DNT-scope functions, found different count';
  END IF;
END $vq_signature$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.UNRESOLVED — company_unresolved sentinel in the 3 tow-path guards
-- ══════════════════════════════════════════════════════════════════════
-- Fail-closed for non-admin callers with NULL/whitespace company.
-- Distinct sentinel from do_not_tow_active — context failure MUST NOT
-- be rendered as "vehicle protected" (lying-message class).
--
-- pm_plate_lookup and check_dnt_plate deliberately omitted:
--   • pm_plate_lookup — refused earlier by role gate and no-assigned-
--     properties path (fail-closed by construction)
--   • check_dnt_plate — deliberately fail-soft (READ; returns
--     {is_dnt:false,reason:null} on NULL company via auth branch).
--     Downstream tow guards remain protection.
DO $vq_unresolved$
DECLARE
  v_missing TEXT[];
  v_guards CONSTANT TEXT[] := ARRAY[
    'set_violation_status', 'stamp_tow_ticket', 'regenerate_tow_ticket'
  ];
BEGIN
  SELECT COALESCE(array_agg(proname ORDER BY proname), '{}') INTO v_missing
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = ANY (v_guards)
    AND pg_get_functiondef(oid) NOT LIKE '%company_unresolved%';

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'VQ.UNRESOLVED FAILED — company_unresolved sentinel missing in tow-path guard(s): %', v_missing;
  END IF;
END $vq_unresolved$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.ISDNT_ORDER — v_is_dnt assigned BEFORE use in return
-- ══════════════════════════════════════════════════════════════════════
-- Catches the driver-card-disappears failure mode: if v_is_dnt is
-- derived from a suppressed v_reason (or omitted entirely), a driver's
-- reason:NULL flips is_dnt:false silently and the DO NOT TOW warning
-- vanishes from their surface. Asserts the assignment `v_is_dnt :=`
-- occurs at a lower position than the use `'is_dnt', v_is_dnt` in the
-- return. position() returns the FIRST occurrence, so an earlier
-- assignment position beating a later use position proves ordering.
DO $vq_isdnt_order$
DECLARE
  v_def   TEXT;
  v_asgn  INTEGER;
  v_use   INTEGER;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'check_dnt_plate'
  LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'VQ.ISDNT_ORDER FAILED — check_dnt_plate not found';
  END IF;

  v_asgn := position('v_is_dnt :=' in v_def);
  v_use  := position('''is_dnt'', v_is_dnt' in v_def);

  IF v_asgn = 0 OR v_use = 0 OR v_use <= v_asgn THEN
    RAISE EXCEPTION 'VQ.ISDNT_ORDER FAILED — v_is_dnt not assigned before use in check_dnt_plate (assign_pos=% use_pos=%)',
      v_asgn, v_use;
  END IF;
END $vq_isdnt_order$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.REASON_ROLE — role-conditional reason with default-deny ELSE
-- ══════════════════════════════════════════════════════════════════════
-- Asserts the CASE shape in check_dnt_plate: reason returned only for
-- portal roles, default-deny for everything else (driver, resident,
-- unknown future roles).
DO $vq_reason_role$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'check_dnt_plate'
  LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'VQ.REASON_ROLE FAILED — check_dnt_plate not found';
  END IF;

  IF     v_def NOT LIKE '%CASE%v_role IN (''manager'',''leasing_agent'',''company_admin'',''admin'')%'
      OR v_def NOT LIKE '%THEN v_reason%'
      OR v_def NOT LIKE '%ELSE NULL%'
  THEN
    RAISE EXCEPTION 'VQ.REASON_ROLE FAILED — role-conditional CASE shape not present in check_dnt_plate reason field';
  END IF;
END $vq_reason_role$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.CANONICAL — DNT guard block byte-identical across 3 tow paths
-- ══════════════════════════════════════════════════════════════════════
-- Per Mateo item 5: three textual variants of one control is how the
-- stamp / regenerate divergence happened. Identical text is what makes
-- a single control-invariant assertion meaningful across all three.
--
-- Extracts the region between the CANONICAL/END markers in each of
-- the 3 tow-path guards, whitespace-normalizes (so nesting indentation
-- inside set_violation_status's IF p_new_status='tow_ticket' branch
-- doesn't cause a false-fail against stamp/regenerate), hashes, and
-- asserts the 3 hashes are equal.
--
-- ── Anchor discipline ─────────────────────────────────────────────────
-- Anchors are the CORE SEMANTIC substrings (no `-- ── ` prefix or
-- trailing decoration) — that's what caught set_violation_status's
-- 22-vs-24-dash trailing divergence on first apply. Line 763 of the
-- migration header contains `plus the CANONICAL DNT guard block.`
-- (without `(Commit B2)`) — the parens-qualified anchor is unique to
-- the marker lines and skips that footnote.
--
-- ── Pre-check discipline ──────────────────────────────────────────────
-- Two failure modes VQ.CANONICAL almost missed on first design:
--   1. Marker absent → position() returns 0, substring is empty,
--      empty-hash across all 3 false-passes. Covered by the
--      exactly-once assertion (count = 1 forces presence).
--   2. Marker duplicated → position() returns FIRST match, extraction
--      shifts silently, hash is wrong (either direction — false pass
--      possible if two functions happen to mis-extract identically).
--      Covered by exactly-once.
--   3. END precedes CANONICAL → length arg to substring is negative,
--      Postgres raises raw "negative substring length not allowed"
--      instead of a named VQ finding. Covered by the order assertion.
-- All three pre-checks run before extraction.
DO $vq_canonical$
DECLARE
  r RECORD;
  v_open  CONSTANT TEXT := 'CANONICAL DNT guard block (Commit B2)';
  v_close CONSTANT TEXT := 'END CANONICAL BLOCK';
  v_hashes TEXT[];
BEGIN
  -- Pre-checks (hardening 1: exactly-once + order)
  FOR r IN SELECT proname, pg_get_functiondef(oid) AS def
             FROM pg_proc
            WHERE pronamespace = 'public'::regnamespace
              AND proname IN ('set_violation_status', 'stamp_tow_ticket', 'regenerate_tow_ticket')
  LOOP
    IF (length(r.def) - length(replace(r.def, v_open, ''))) / length(v_open) <> 1
       OR (length(r.def) - length(replace(r.def, v_close, ''))) / length(v_close) <> 1 THEN
      RAISE EXCEPTION 'VQ.CANONICAL FAILED — marker not exactly once in %', r.proname;
    END IF;

    IF position(v_close IN r.def) <= position(v_open IN r.def) THEN
      RAISE EXCEPTION 'VQ.CANONICAL FAILED — markers out of order in %', r.proname;
    END IF;
  END LOOP;

  -- Extraction + hash
  SELECT array_agg(
    md5(regexp_replace(trim(
      substring(
        pg_get_functiondef(oid)
          FROM position(v_open IN pg_get_functiondef(oid))
          FOR position(v_close IN pg_get_functiondef(oid))
            - position(v_open IN pg_get_functiondef(oid))
      )
    ), '\s+', ' ', 'g'))
    ORDER BY proname
  )
  INTO v_hashes
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('set_violation_status', 'stamp_tow_ticket', 'regenerate_tow_ticket');

  IF v_hashes IS NULL OR array_length(v_hashes, 1) <> 3 THEN
    RAISE EXCEPTION 'VQ.CANONICAL FAILED — expected 3 tow-path guards, found %',
      COALESCE(array_length(v_hashes, 1), 0);
  END IF;

  IF v_hashes[1] IS DISTINCT FROM v_hashes[2] OR v_hashes[2] IS DISTINCT FROM v_hashes[3] THEN
    RAISE EXCEPTION 'VQ.CANONICAL FAILED — DNT guard block not identical (whitespace-normalized) across 3 tow paths (hashes=%)', v_hashes;
  END IF;
END $vq_canonical$;

-- ══════════════════════════════════════════════════════════════════════
-- VQ.AUDIT — SCHEMA_ audit row landed
-- ══════════════════════════════════════════════════════════════════════
DO $vq_audit$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.audit_logs
  WHERE action = 'SCHEMA_DNT_B2_FUNCTION_SCOPE_FIX'
    AND new_values->>'migration' = '20260723_dnt_b2_function_scope_fix';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'VQ.AUDIT FAILED — SCHEMA_DNT_B2_FUNCTION_SCOPE_FIX row missing';
  END IF;
END $vq_audit$;

COMMIT;

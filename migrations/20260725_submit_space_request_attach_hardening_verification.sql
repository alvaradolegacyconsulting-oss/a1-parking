-- ════════════════════════════════════════════════════════════════════
-- 20260725_submit_space_request_attach_hardening_verification.sql
-- Post-apply structural verification. Silent success = PASS.
-- BEGIN…COMMIT wrap: aborts at first RAISE, correct post-apply shape.
-- Covers function body + index shape.
--
-- Note (2026-07-25 pass): VQ.INDEX_NEW_PRESENT asserts stable substrings
-- (name + column list + case-insensitive 'status'…'pending'), NOT the
-- exact indexdef spelling. Postgres's deparser is version-dependent about
-- cast/parenthesization of the predicate — a byte-exact match would fail
-- on correct code the day the deparser spells it differently. Same class
-- of near-miss as ~~* and IN (…) → = ANY(ARRAY[…]) renderings.
--
-- Note (2026-07-25 apply, VQ.OLD_PROPERTY_CHECK_ABSENT): absence-check
-- VQs on pg_get_functiondef() must match executable syntax specific
-- enough that no prose could contain it. pg_get_functiondef() returns
-- comments too — an absence-check on a bare construct name matches its
-- own documentation and fires on correct code. First observed live
-- 2026-07-25 when the comment documenting the removed IF matched a
-- LIKE '%v_resident.property <> p_property%' absence-check. Fixed by
-- matching the fuller `IS NULL OR … <>` form the executable body uses.
-- Reinforces #3 and the assert-the-positive meta-lesson.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_def   TEXT;
  v_args  TEXT;
  v_count INT;
BEGIN
  -- ── VQ.PROC_COUNT — exactly one function, no overload trap ──
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE proname = 'submit_space_request' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.PROC_COUNT FAILED — expected 1, got %', v_count;
  END IF;

  -- ── VQ.SIG — signature preserved ──
  SELECT pg_get_function_arguments(oid) INTO v_args
    FROM pg_proc WHERE proname='submit_space_request' AND pronamespace='public'::regnamespace;
  IF v_args <> 'p_property text, p_note text DEFAULT NULL::text' THEN
    RAISE EXCEPTION 'VQ.SIG FAILED — got: %', v_args;
  END IF;

  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc WHERE proname='submit_space_request' AND pronamespace='public'::regnamespace;

  -- ── VQ.RESIDENCY_PROPERTY_BIND — residency-load WHERE binds to p_property ──
  IF (regexp_matches(v_def, 'WHERE lower\(email\) = v_caller_email\s+AND lower\(trim\(property\)\) = lower\(trim\(p_property\)\)'))[1] IS NULL THEN
    RAISE EXCEPTION 'VQ.RESIDENCY_PROPERTY_BIND FAILED — residency-load WHERE missing property binding';
  END IF;

  -- ── VQ.ORDER_BY — determinism via ORDER BY id DESC ──
  IF v_def NOT LIKE '%ORDER BY id DESC%' THEN
    RAISE EXCEPTION 'VQ.ORDER_BY FAILED — ORDER BY id DESC missing';
  END IF;

  -- ── VQ.PENDING_PROPERTY_BIND — pending-request pre-check WHERE binds to p_property ──
  IF (regexp_matches(v_def, 'FROM public\.space_requests\s+WHERE lower\(resident_email\) = v_caller_email\s+AND lower\(trim\(property\)\) = lower\(trim\(p_property\)\)'))[1] IS NULL THEN
    RAISE EXCEPTION 'VQ.PENDING_PROPERTY_BIND FAILED — pending-request pre-check WHERE missing property binding';
  END IF;

  -- ── VQ.NEW_ERROR_STRING — renamed error present ──
  IF v_def NOT LIKE '%no_residency_at_property%' THEN
    RAISE EXCEPTION 'VQ.NEW_ERROR_STRING FAILED — no_residency_at_property missing';
  END IF;

  -- ── VQ.OLD_PROPERTY_CHECK_ABSENT — redundant IF removed FROM CODE ──
  -- Match the fuller executable form (`IS NULL OR … <>`) — not the bare
  -- `v_resident.property <> p_property`, which also appears verbatim in
  -- the comment documenting the removal. pg_get_functiondef() returns
  -- comments too, so an absence-check on a bare construct name matches
  -- its own documentation and fires on correct code. Discipline #3
  -- (2026-07-25 pass): absence-VQs must match syntax specific enough to
  -- executable code that no prose would contain it.
  IF v_def LIKE '%v_resident.property IS NULL OR v_resident.property <> p_property%' THEN
    RAISE EXCEPTION 'VQ.OLD_PROPERTY_CHECK_ABSENT FAILED — redundant IF still present in executable body';
  END IF;

  -- ── VQ.INVARIANT_ROLE_GATE — role gate preserved ──
  IF v_def NOT LIKE '%v_caller_role <> ''resident''%' THEN
    RAISE EXCEPTION 'VQ.INVARIANT_ROLE_GATE FAILED — role gate reshaped';
  END IF;

  -- ── VQ.INVARIANT_AUDIT — audit_logs INSERT preserved ──
  IF v_def NOT LIKE '%SPACE_REQUEST_SUBMITTED%' THEN
    RAISE EXCEPTION 'VQ.INVARIANT_AUDIT FAILED — audit log INSERT dropped';
  END IF;

  -- ── VQ.INDEX_OLD_ABSENT — email-only index dropped ──
  IF EXISTS(SELECT 1 FROM pg_indexes
             WHERE schemaname='public' AND tablename='space_requests'
               AND indexname='space_requests_one_pending_per_resident') THEN
    RAISE EXCEPTION 'VQ.INDEX_OLD_ABSENT FAILED — old email-only UNIQUE index still exists';
  END IF;

  -- ── VQ.INDEX_NEW_PRESENT — property-bound index exists with correct shape ──
  -- Stable-substring match: name + column list (deparser-stable) +
  -- ILIKE '%status%pending%' (predicate present, punctuation-agnostic).
  -- See file header for the deparser-version rationale.
  IF NOT EXISTS(SELECT 1 FROM pg_indexes
                 WHERE schemaname='public' AND tablename='space_requests'
                   AND indexname='space_requests_one_pending_per_resident_property'
                   AND indexdef LIKE '%UNIQUE%'
                   AND indexdef LIKE '%(resident_email, property)%'
                   AND indexdef ILIKE '%status%pending%') THEN
    RAISE EXCEPTION 'VQ.INDEX_NEW_PRESENT FAILED — expected UNIQUE (resident_email, property) partial on pending';
  END IF;
END $$;

COMMIT;

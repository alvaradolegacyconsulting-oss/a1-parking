-- ════════════════════════════════════════════════════════════════════
-- 20260726_six_site_commit_a_company_scope_verification.sql
-- Post-apply structural verification. Silent success = PASS.
-- BEGIN…COMMIT wrap: aborts at first RAISE, correct post-apply shape.
-- 12 VQs — count + per-site (6 sites, 2 shapes) + preservation (3 DNT
-- guards) + signature invariants (3 functions, no overload trap).
--
-- Notes carried forward from prior verification passes:
--   • VQ.WILDCARD_COUNT is an absence-count assertion on the ~~* operator.
--     Safe because ~~* doesn't appear in ANY comment inside these three
--     function bodies (verified pre-apply). If a future comment mentions
--     ~~* the assertion would false-fail — reword the comment then.
--   • Absence-VQs per discipline #3 (2026-07-25 pass): none in this file
--     — all 12 VQs assert PRESENCE (either the fixed predicate or the
--     preserved guard). The count-VQ is the only absence-shaped check
--     and it asserts on the executable operator, not a bare identifier.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_def_set   TEXT;
  v_def_stamp TEXT;
  v_def_regen TEXT;
  v_wildcard_count INT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def_set
    FROM pg_proc WHERE proname='set_violation_status' AND pronamespace='public'::regnamespace;
  SELECT pg_get_functiondef(oid) INTO v_def_stamp
    FROM pg_proc WHERE proname='stamp_tow_ticket' AND pronamespace='public'::regnamespace;
  SELECT pg_get_functiondef(oid) INTO v_def_regen
    FROM pg_proc WHERE proname='regenerate_tow_ticket' AND pronamespace='public'::regnamespace;

  -- ── VQ.WILDCARD_COUNT — the count gate. Zero ~~* across three functions. ──
  v_wildcard_count :=
    (length(v_def_set)   - length(replace(v_def_set,   '~~*', ''))) / length('~~*') +
    (length(v_def_stamp) - length(replace(v_def_stamp, '~~*', ''))) / length('~~*') +
    (length(v_def_regen) - length(replace(v_def_regen, '~~*', ''))) / length('~~*');
  IF v_wildcard_count <> 0 THEN
    RAISE EXCEPTION 'VQ.WILDCARD_COUNT FAILED — expected 0 ~~* in the three functions post-apply, got %', v_wildcard_count;
  END IF;

  -- ── SHAPE 1 (5 sites) — company-equality present ──
  IF v_def_set NOT LIKE '%lower(trim(p.company)) = lower(trim(v_caller_company))%AND p.name = v_row.property%' THEN
    RAISE EXCEPTION 'VQ.A1 FAILED — set_violation_status cross_company_denied predicate missing';
  END IF;
  IF v_def_regen NOT LIKE '%lower(trim(p.company)) = lower(trim(v_caller_company))%AND p.name = v_original.property%' THEN
    RAISE EXCEPTION 'VQ.A2 FAILED — regenerate_tow_ticket violation-scope predicate missing';
  END IF;
  IF v_def_regen NOT LIKE '%NOT (lower(trim(v_storage.company)) = lower(trim(v_caller_company)))%' THEN
    RAISE EXCEPTION 'VQ.A3 FAILED — regenerate_tow_ticket storage-scope predicate missing';
  END IF;
  IF v_def_stamp NOT LIKE '%p.name = v_row.property%lower(trim(p.company)) = lower(trim(v_company))%' THEN
    RAISE EXCEPTION 'VQ.A4 FAILED — stamp_tow_ticket violation-scope predicate missing';
  END IF;
  IF v_def_stamp NOT LIKE '%NOT (lower(trim(v_storage.company)) = lower(trim(v_company)))%' THEN
    RAISE EXCEPTION 'VQ.A5 FAILED — stamp_tow_ticket storage-scope predicate missing';
  END IF;

  -- ── SHAPE 2 (1 site) — property-equality present, NO company ──
  IF v_def_stamp NOT LIKE '%unnest(v_properties) p%lower(trim(v_row.property)) = lower(trim(p))%' THEN
    RAISE EXCEPTION 'VQ.A6 FAILED — stamp_tow_ticket manager property-in-scope predicate missing';
  END IF;

  -- ── PRESERVATION — DNT canonical guard blocks byte-identical ──
  IF v_def_set NOT LIKE '%lower(trim(dnt_p.company)) = lower(trim(get_my_company()))%do_not_tow_active%' THEN
    RAISE EXCEPTION 'VQ.PRESERVED_SET_DNT FAILED — set_violation_status DNT guard reshaped';
  END IF;
  IF v_def_stamp NOT LIKE '%lower(trim(dnt_p.company)) = lower(trim(get_my_company()))%do_not_tow_active%' THEN
    RAISE EXCEPTION 'VQ.PRESERVED_STAMP_DNT FAILED — stamp_tow_ticket DNT guard reshaped';
  END IF;
  IF v_def_regen NOT LIKE '%lower(trim(dnt_p.company)) = lower(trim(get_my_company()))%do_not_tow_active%' THEN
    RAISE EXCEPTION 'VQ.PRESERVED_REGEN_DNT FAILED — regenerate_tow_ticket DNT guard reshaped';
  END IF;

  -- ── SIGNATURES — unchanged, no overload trap (per-function exactly 1 row) ──
  IF (SELECT count(*) FROM pg_proc WHERE proname='set_violation_status' AND pronamespace='public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'VQ.SIG_SET FAILED — set_violation_status not exactly 1 overload';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname='stamp_tow_ticket' AND pronamespace='public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'VQ.SIG_STAMP FAILED — stamp_tow_ticket not exactly 1 overload';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname='regenerate_tow_ticket' AND pronamespace='public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'VQ.SIG_REGEN FAILED — regenerate_tow_ticket not exactly 1 overload';
  END IF;
END $$;

COMMIT;

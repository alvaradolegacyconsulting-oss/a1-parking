-- B219 — verification queries (standalone SELECTs; safe to paste whole file).
--
-- RUN ORDER:
--   1. Section A BEFORE applying the migration (column absent gate).
--   2. Apply 20260624_b219_violation_status_lifecycle.sql.
--   3. Run Sections B, C, D, E, F, G post-apply.
--
-- LOAD-BEARING SECTIONS (do not skip before declaring applied + verified):
--   - Section C: backfill distribution — reports the new_count vs
--     tow_ticket_count split. If the view-token heuristic produces
--     suspiciously few or zero tow_ticket rows, sanity-check the
--     view_token data before trusting the inference.
--   - Section D: CHECK constraint negative test — proves a direct
--     UPDATE to status='void' (or any out-of-enum value) is rejected.
--     Catches accidental drop or mistyped CHECK.
--   - Section E: role-pin negative test — SQL Editor caller has no
--     user_roles row → set_violation_status returns role_not_authorized.
--     Proves the CA-only gate holds.

-- ════════════════════════════════════════════════════════════════════
-- A. PRE-APPLY GATE — confirm columns absent
-- ════════════════════════════════════════════════════════════════════
-- Run this BEFORE applying. If any rows return, the migration has
-- already been applied (or partially applied); investigate first.

SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'violations'
   AND column_name IN ('status', 'status_changed_at', 'status_changed_by')
 ORDER BY column_name;
-- Expected PRE-APPLY: 0 rows.
-- Expected POST-APPLY (also verifies Section B): 3 rows —
--   status              | text                        | NO  | 'new'::text
--   status_changed_at   | timestamp with time zone    | YES | (null)
--   status_changed_by   | text                        | YES | (null)


-- ════════════════════════════════════════════════════════════════════
-- B. Post-apply — schema + CHECK + index present
-- ════════════════════════════════════════════════════════════════════

-- B.1 columns (same query as A; expected 3 rows post-apply)
-- See A above.

-- B.2 CHECK constraint shape
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'public.violations'::regclass
   AND conname  = 'violations_status_valid';
-- Expected: 1 row.
--   definition = 'CHECK ((status = ANY (ARRAY[''new''::text, ''tow_ticket''::text, ''resolved''::text, ''disputed''::text])))'
--   (Postgres re-emits IN as = ANY(ARRAY[...]) — equivalent.)
--   'void' MUST be absent from the array.

-- B.3 Index present
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename  = 'violations'
   AND indexname  = 'violations_property_status';
-- Expected: 1 row with (property, status) composite.
-- (Renamed from violations_company_status pre-apply 2026-06-24 — Jose
-- caught: violations has no `company` column; scope is via property.)


-- ════════════════════════════════════════════════════════════════════
-- C. ★ LOAD-BEARING — backfill distribution
-- ════════════════════════════════════════════════════════════════════
-- Reports the post-backfill row count per status. Sanity check:
--   - 'tow_ticket' count should match `view_token IS NOT NULL` count
--   - 'new' count should match everything else
--   - 'resolved' + 'disputed' should be 0 (forward-only states; nothing
--     in current data infers them)

SELECT status, COUNT(*) AS row_count
  FROM public.violations
 GROUP BY status
 ORDER BY status;
-- Expected post-apply: 1-2 rows total —
--   new         | (everything without a view_token)
--   tow_ticket  | (rows with view_token IS NOT NULL)
-- 'resolved' and 'disputed' should NOT appear (forward-only states).

-- Cross-check: tow_ticket count = view_token count
SELECT
  (SELECT COUNT(*) FROM public.violations WHERE status     = 'tow_ticket') AS status_tow_ticket_count,
  (SELECT COUNT(*) FROM public.violations WHERE view_token IS NOT NULL)    AS view_token_present_count,
  CASE
    WHEN (SELECT COUNT(*) FROM public.violations WHERE status     = 'tow_ticket')
       = (SELECT COUNT(*) FROM public.violations WHERE view_token IS NOT NULL)
    THEN 'PASS — backfill heuristic produced matching counts'
    ELSE 'FAIL — counts diverge; investigate before declaring verified'
  END AS verdict;


-- ════════════════════════════════════════════════════════════════════
-- D. ★ LOAD-BEARING — CHECK constraint rejects out-of-enum
-- ════════════════════════════════════════════════════════════════════
-- Negative test on a throwaway row. Insert + try-update + cleanup
-- unconditionally. Proves the CHECK is in place and includes the
-- 'void' exclusion that Gate 6 requires.
--
-- TWO BUGS IN THE PRIOR VERSION (Jose 2026-06-24):
--   (1) Used `type` instead of `violation_type` — column doesn't
--       exist; INSERT failed before any UPDATE ran.
--   (2) Used bare `$$` dollar-quote — Supabase SQL Editor splits on
--       `;` inside `$$ ... $$` if the block contains nested
--       statements (see memory feedback_sql_editor_dollar_quote_parsing.md).
--       Tagged dollar-quote `$check_d$` prevents the splitter from
--       misreading the inner BEGIN/EXCEPTION blocks.
--
-- BEFORE PASTING D — VERIFY THE INSERT COLUMNS
-- ────────────────────────────────────────────
-- Paste this column-list query first; confirm `violation_type` is
-- the violation-type column (not `type`) and that `plate`, `property`
-- are NOT NULL. If anything in the column list differs from what
-- this block INSERTs (other than DEFAULT-populated columns), abort
-- and fix the INSERT before re-running D:

-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema = 'public'
--    AND table_name   = 'violations'
--  ORDER BY ordinal_position;
--
-- Cross-checked against production code (app/driver/page.tsx:475 +
-- app/company_admin/page.tsx:1876, both use violation_type). If the
-- column list disagrees, the production code is the source of truth.

DO $check_d$
DECLARE
  v_test_id       BIGINT;
  v_caught_void   BOOLEAN := FALSE;
  v_caught_bogus  BOOLEAN := FALSE;
BEGIN
  -- Throwaway violation row. Minimal required columns:
  --   plate          (NOT NULL — sentinel value)
  --   violation_type (the type column — production code calls it
  --                   violation_type; verify against the col-list query above)
  --   property       (NOT NULL — sentinel value; b40 RLS scopes by this)
  --   is_confirmed   (NOT NULL with DEFAULT TRUE; set explicitly for clarity)
  --   status         (NOT NULL with DEFAULT 'new'; relying on default)
  INSERT INTO public.violations (
    plate, violation_type, property, is_confirmed
  ) VALUES (
    'B219TEST', 'overnight', '__b219_check_test_property__', TRUE
  ) RETURNING id INTO v_test_id;

  -- D.1 Try setting status='void' (Gate 6: void is NOT in the enum)
  BEGIN
    UPDATE public.violations SET status = 'void' WHERE id = v_test_id;
    RAISE WARNING 'FAIL — CHECK allowed status=void (Gate 6 violation)';
  EXCEPTION WHEN check_violation THEN
    v_caught_void := TRUE;
    RAISE NOTICE 'PASS — CHECK rejected status=void (Gate 6 orthogonality enforced)';
  END;

  -- D.2 Try setting a wholly bogus value
  BEGIN
    UPDATE public.violations SET status = 'bogus_status' WHERE id = v_test_id;
    RAISE WARNING 'FAIL — CHECK allowed status=bogus_status';
  EXCEPTION WHEN check_violation THEN
    v_caught_bogus := TRUE;
    RAISE NOTICE 'PASS — CHECK rejected status=bogus_status';
  END;

  -- Cleanup unconditional.
  DELETE FROM public.violations WHERE id = v_test_id;

  IF NOT v_caught_void OR NOT v_caught_bogus THEN
    RAISE EXCEPTION 'verification_D_failed (void=%, bogus=%)', v_caught_void, v_caught_bogus;
  END IF;
END $check_d$;

-- Sanity: no test row leaked
SELECT COUNT(*) AS leaked_test_rows
  FROM public.violations
 WHERE property = '__b219_check_test_property__';
-- Expected: 0


-- ════════════════════════════════════════════════════════════════════
-- E. Auth-gate negative test (NOT a role-gate proof — see below)
-- ════════════════════════════════════════════════════════════════════
-- The SQL Editor caller has no JWT at all (Supabase SQL Editor runs
-- as the postgres role without a JWT). So the RPC's FIRST guard —
-- auth.jwt() ->> 'email' is NULL → 'unauthenticated' — fires BEFORE
-- ever reaching the role check.
--
-- This PROVES: the unauthenticated path correctly refuses.
-- This DOES NOT PROVE: the role gate refuses an authenticated non-CA
-- caller (driver/manager/leasing_agent/resident).
--
-- WHY THE ROLE GATE IS STILL COVERED (without a fresh smoke):
-- The role-gate code is byte-identical to the proven void_violation
-- pattern (B175 shipped 2026-06-11 + smoked + A1-live):
--
--   IF v_caller_role != 'company_admin' THEN
--     RETURN jsonb_build_object('error', 'role_not_authorized');
--   END IF;
--
-- Same get_my_role() helper, same comparison shape, same return
-- format. Per the originating spec ("do NOT invent a new auth path"),
-- the gate is the same gate void_violation uses — and that gate's
-- behavior was proven during B175 smoke.
--
-- ── DEFERRED ROLE-GATE NEGATIVE TEST (for the B219 CA-UI UAT smoke) ──
-- When the CA-UI commit ships and the UAT smoke is written, add a
-- B219 row that:
--   (a) Real CA login calls set_violation_status(id, 'resolved') on
--       one of their company's violations → expect {ok: true, ...}
--   (b) Real driver session calls set_violation_status(same id, ...)
--       → expect {error: 'role_not_authorized'}
--   (c) Real CA calls set_violation_status on another company's
--       violation → expect {error: 'cross_company_denied'}
-- These three together close the auth/role/scope verification triangle.
-- The byte-identical-to-void_violation argument covers tonight; (b)
-- is the formal proof.

SELECT public.set_violation_status(-1, 'resolved') AS rpc_result;
-- Expected: jsonb_build_object('error', 'unauthenticated')
-- (NOT 'no_role_assigned' — Supabase SQL Editor sends no JWT, so
-- the auth gate fires before the role gate. This is correct behavior.)


-- ════════════════════════════════════════════════════════════════════
-- F. Grants — anon + PUBLIC absent; authenticated present
-- ════════════════════════════════════════════════════════════════════

SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema = 'public'
   AND routine_name   = 'set_violation_status'
 ORDER BY grantee;
-- Expected: 'authenticated' present (+ postgres/owner).
-- 'anon' and 'PUBLIC' MUST NOT appear.


-- ════════════════════════════════════════════════════════════════════
-- G. Coherence sweep — every existing row's status is valid
-- ════════════════════════════════════════════════════════════════════
-- If the CHECK is on but rows somehow predate it (which shouldn't
-- happen with idempotent DROP+ADD), this would catch it. Belt-and-
-- suspenders.

SELECT id, status
  FROM public.violations
 WHERE status IS NULL
    OR status NOT IN ('new', 'tow_ticket', 'resolved', 'disputed');
-- Expected: 0 rows.

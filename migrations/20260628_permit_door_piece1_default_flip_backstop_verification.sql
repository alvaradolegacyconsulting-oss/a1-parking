-- ════════════════════════════════════════════════════════════════════
-- Permit-Door Piece 1 — Migration B (default-flip backstop) — VERIFICATION
-- 2026-06-28
-- ════════════════════════════════════════════════════════════════════
--
-- Run AFTER applying 20260628_permit_door_piece1_default_flip_backstop.sql.
-- Section §0 is preflight (run BEFORE the migration to confirm
-- pre-conditions); §1–§3 run AFTER apply.
--
-- ════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- §0 — PREFLIGHT (run BEFORE applying)
-- ─────────────────────────────────────────────────────────────────

-- §0.A — Pre-flip default is still 'active' (haven't applied yet).
--        Expected: column_default = 'active'::text
--        If this returns 'pending'::text already → Mig B was already
--        applied or someone else flipped it — STOP, investigate.
SELECT
  'PREFLIGHT §0.A — pre-flip default'                AS check_name,
  column_default                                     AS current_default,
  CASE WHEN column_default = '''active''::text'      THEN 'PASS — ready to apply'
       WHEN column_default = '''pending''::text'     THEN 'STOP — already flipped'
       ELSE 'INVESTIGATE — unexpected default: ' || COALESCE(column_default, '<null>')
  END                                                AS verdict
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'vehicles'
  AND column_name  = 'status';

-- §0.B — Piece 1 app code is deployed. (Cannot verify from SQL;
--        confirm in Vercel deploy log that commit b1ade67 deployed
--        before applying Mig B. The flip is safe ONLY if every
--        insert site is helper-routed / explicit-status.)


-- ─────────────────────────────────────────────────────────────────
-- §1 — POST-APPLY: default flipped
-- ─────────────────────────────────────────────────────────────────

-- §1.A — Default is now 'pending'.
SELECT
  '§1.A — post-flip default'                         AS check_name,
  column_default                                     AS current_default,
  CASE WHEN column_default = '''pending''::text'     THEN 'PASS'
       ELSE 'FAIL — expected pending, got: ' || COALESCE(column_default, '<null>')
  END                                                AS verdict
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'vehicles'
  AND column_name  = 'status';


-- ─────────────────────────────────────────────────────────────────
-- §2 — BEHAVIORAL PROOF: a no-status insert lands 'pending'
-- ─────────────────────────────────────────────────────────────────

-- §2.A — Insert a vehicle WITHOUT specifying status, confirm it
--        lands 'pending', then clean up. RAISEs on mismatch.
DO $b$
DECLARE
  v_id     BIGINT;
  v_status TEXT;
BEGIN
  INSERT INTO public.vehicles (plate, property, is_active)
  VALUES ('__migB_backstop_test__', '__migB_test_prop__', FALSE)
  RETURNING id, status INTO v_id, v_status;

  DELETE FROM public.vehicles WHERE id = v_id;

  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'FAIL §2.A — default-omitted insert landed % not pending', v_status;
  END IF;

  RAISE NOTICE 'PASS §2.A — default-omitted insert correctly landed pending (id=%, cleaned up)', v_id;
END $b$;

-- §2.B — Insert WITH explicit status='active' — confirm the explicit
--        value wins over the (now-pending) default. This is the
--        load-bearing check that the helper's explicit-set sites
--        are unaffected by the flip.
DO $b$
DECLARE
  v_id     BIGINT;
  v_status TEXT;
BEGIN
  INSERT INTO public.vehicles (plate, property, is_active, status)
  VALUES ('__migB_explicit_active_test__', '__migB_test_prop__', TRUE, 'active')
  RETURNING id, status INTO v_id, v_status;

  DELETE FROM public.vehicles WHERE id = v_id;

  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'FAIL §2.B — explicit status=active was overridden to %', v_status;
  END IF;

  RAISE NOTICE 'PASS §2.B — explicit status=active wins over default (id=%, cleaned up)', v_id;
END $b$;


-- ─────────────────────────────────────────────────────────────────
-- §3 — AUDIT row landed
-- ─────────────────────────────────────────────────────────────────

SELECT
  '§3 — audit row'                                                       AS check_name,
  count(*)                                                               AS rows_found,
  CASE WHEN count(*) = 1 THEN 'PASS'
       WHEN count(*) = 0 THEN 'FAIL — no audit row found'
       ELSE 'FAIL — too many audit rows (' || count(*)::text || ')'
  END                                                                    AS verdict
FROM public.audit_logs
WHERE action     = 'SCHEMA_PERMIT_DOOR_FIX'
  AND table_name = 'vehicles'
  AND new_values->>'migration' = '20260628_permit_door_piece1_default_flip_backstop';


-- ─────────────────────────────────────────────────────────────────
-- §4 — SMOKE prompts (run in app, not SQL)
-- ─────────────────────────────────────────────────────────────────
--
-- §4.A — Enforcement company: manual-add a vehicle from manager
--        portal → confirm it lands status='active' (helper explicit-
--        sets active; default-flip is invisible to it).
--        ★ This is the key check — the flip must NOT accidentally
--        make enforcement vehicles pending.
--
-- §4.B — PM-Only company: manual-add a vehicle → lands status='pending'
--        (was already pending; default-flip is invisible).
--
-- §4.C — Approve a pending vehicle → flips to active (approval RPC
--        unaffected by default change).
--
-- ════════════════════════════════════════════════════════════════════

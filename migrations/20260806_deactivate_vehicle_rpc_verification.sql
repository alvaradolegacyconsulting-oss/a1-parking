-- ══════════════════════════════════════════════════════════════════════
-- 20260806_deactivate_vehicle_rpc_verification.sql
-- POST-APPLY: RPC exists with correct signature, grants (anon DENIED,
-- authenticated GRANTED), volatility, SECURITY DEFINER, body carries
-- the deliberate divergences from approve_vehicle (can_approve_vehicles
-- + lower(trim) scope), and the SCHEMA_ audit was written.
-- BEGIN…COMMIT wrap. Silent = pass.
-- ══════════════════════════════════════════════════════════════════════
--
-- Run AFTER 20260806_deactivate_vehicle_rpc.sql. Paste WHOLE.
-- Inspection only — no probe rows.
--
-- Source-inspection VQs strip `-- ...` comments before matching per
-- discipline #11.
--
-- Behavioural probes (role rejection / cross-property / system-code
-- reject / percent-in-property-name) require a JWT-scoped test caller
-- + fixture data and are deferred to the manual test recipe in the
-- commit message.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── VQ.RPC_EXISTS ────────────────────────────────────────────────────
DO $$
DECLARE v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc
   WHERE proname = 'deactivate_vehicle'
     AND pronamespace = 'public'::regnamespace
     AND pronargs = 3;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VQ.RPC_EXISTS: expected 1 deactivate_vehicle(BIGINT,TEXT,TEXT); got %', v_count;
  END IF;
END $$;

-- ── VQ.VOLATILITY_VOLATILE + SECURITY_DEFINER ────────────────────────
-- Write RPC → VOLATILE. DEFINER required for scope-check + write.
DO $$
DECLARE v_provolatile "char"; v_prosecdef boolean;
BEGIN
  SELECT provolatile, prosecdef INTO v_provolatile, v_prosecdef
    FROM pg_proc
   WHERE proname = 'deactivate_vehicle' AND pronamespace = 'public'::regnamespace;
  IF v_provolatile <> 'v' THEN
    RAISE EXCEPTION 'VQ.VOLATILITY_VOLATILE: expected VOLATILE (v); got %', v_provolatile;
  END IF;
  IF NOT v_prosecdef THEN
    RAISE EXCEPTION 'VQ.SECURITY_DEFINER: expected SECURITY DEFINER; got INVOKER';
  END IF;
END $$;

-- ── VQ.GRANTS ────────────────────────────────────────────────────────
-- anon MUST NOT have EXECUTE; authenticated MUST.
DO $$
DECLARE v_has_anon boolean; v_has_authenticated boolean; v_has_public boolean;
BEGIN
  SELECT
    has_function_privilege('anon',          'public.deactivate_vehicle(bigint,text,text)', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.deactivate_vehicle(bigint,text,text)', 'EXECUTE'),
    has_function_privilege('public',        'public.deactivate_vehicle(bigint,text,text)', 'EXECUTE')
  INTO v_has_anon, v_has_authenticated, v_has_public;
  IF v_has_anon THEN
    RAISE EXCEPTION 'VQ.GRANTS: anon HAS EXECUTE on deactivate_vehicle (must be REVOKED)';
  END IF;
  IF NOT v_has_authenticated THEN
    RAISE EXCEPTION 'VQ.GRANTS: authenticated MISSING EXECUTE on deactivate_vehicle';
  END IF;
  IF v_has_public THEN
    RAISE EXCEPTION 'VQ.GRANTS: PUBLIC HAS EXECUTE on deactivate_vehicle (must be REVOKED)';
  END IF;
END $$;

-- ── VQ.BODY_LOWER_TRIM_SCOPE ─────────────────────────────────────────
-- Deliberate divergence from approve_vehicle: scope MUST use
-- lower(trim(...)), NOT ILIKE (~~*). If a future edit "aligns" to
-- approve_vehicle's looser convention, this fires.
DO $$
DECLARE v_body text; v_body_code text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'deactivate_vehicle' AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  IF v_body_code !~ 'lower\(trim\(v_vehicle\.property\)\)' THEN
    RAISE EXCEPTION 'VQ.BODY_LOWER_TRIM_SCOPE: manager scope predicate must use lower(trim(v_vehicle.property)) (deliberate divergence from approve_vehicle ILIKE)';
  END IF;
  IF v_body_code !~ 'lower\(trim\(p\.name\)\)' THEN
    RAISE EXCEPTION 'VQ.BODY_LOWER_TRIM_SCOPE: CA scope predicate must use lower(trim(p.name)) (deliberate divergence from approve_vehicle ILIKE)';
  END IF;
  IF v_body_code ~ 'v_vehicle\.property\s*~~\*' THEN
    RAISE EXCEPTION 'VQ.BODY_LOWER_TRIM_SCOPE: body uses ILIKE (~~*) on v_vehicle.property — inherited from approve_vehicle; must use lower(trim(...))';
  END IF;
END $$;

-- ── VQ.BODY_AUTHORITY_CHECK ──────────────────────────────────────────
-- Manager path MUST check can_approve_vehicles. If a future edit
-- drops the check (or moves it to CA), the render-side-only gap
-- re-opens and Task 1's discipline breaks.
DO $$
DECLARE v_body text; v_body_code text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'deactivate_vehicle' AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  IF v_body_code !~ 'can_approve_vehicles' THEN
    RAISE EXCEPTION 'VQ.BODY_AUTHORITY_CHECK: body missing can_approve_vehicles read (Task 1 authority-gate discipline broken)';
  END IF;
  IF v_body_code !~ 'authority_not_granted' THEN
    RAISE EXCEPTION 'VQ.BODY_AUTHORITY_CHECK: body missing ''authority_not_granted'' error return';
  END IF;
END $$;

-- ── VQ.BODY_SYSTEM_CODE_REJECT ───────────────────────────────────────
-- All three system codes must be listed in the reject block.
DO $$
DECLARE v_body text; v_body_code text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'deactivate_vehicle' AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  IF v_body_code !~ 'cascade_resident_deactivated' THEN
    RAISE EXCEPTION 'VQ.BODY_SYSTEM_CODE_REJECT: cascade_resident_deactivated missing from reject block';
  END IF;
  IF v_body_code !~ 'owner_trim' THEN
    RAISE EXCEPTION 'VQ.BODY_SYSTEM_CODE_REJECT: owner_trim missing from reject block';
  END IF;
  IF v_body_code !~ 'admin_cascade' THEN
    RAISE EXCEPTION 'VQ.BODY_SYSTEM_CODE_REJECT: admin_cascade missing from reject block';
  END IF;
  IF v_body_code !~ 'reason_is_system_code' THEN
    RAISE EXCEPTION 'VQ.BODY_SYSTEM_CODE_REJECT: reason_is_system_code error return missing';
  END IF;
END $$;

-- ── VQ.BODY_NOTE_REQUIRED_ON_OTHER ───────────────────────────────────
DO $$
DECLARE v_body text; v_body_code text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body
    FROM pg_proc
   WHERE proname = 'deactivate_vehicle' AND pronamespace = 'public'::regnamespace;
  v_body_code := regexp_replace(v_body, '--[^\n]*', '', 'g');

  IF v_body_code !~ 'note_required_when_reason_other' THEN
    RAISE EXCEPTION 'VQ.BODY_NOTE_REQUIRED_ON_OTHER: note-required-when-other check missing';
  END IF;
END $$;

-- ── VQ.COMMENT_ON_PRESENT ────────────────────────────────────────────
DO $$
DECLARE v_comment text;
BEGIN
  SELECT obj_description('public.deactivate_vehicle(bigint,text,text)'::regprocedure, 'pg_proc')
    INTO v_comment;
  IF v_comment IS NULL OR length(v_comment) < 100 THEN
    RAISE EXCEPTION 'VQ.COMMENT_ON_PRESENT: COMMENT ON FUNCTION missing or truncated';
  END IF;
END $$;

-- ── VQ.SCHEMA_AUDIT_ROW ──────────────────────────────────────────────
DO $$
DECLARE v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.audit_logs
   WHERE action = 'SCHEMA_DEACTIVATE_VEHICLE_RPC'
     AND new_values->>'migration' = '20260806_deactivate_vehicle_rpc';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'VQ.SCHEMA_AUDIT_ROW: SCHEMA_ audit row missing';
  END IF;
END $$;

COMMIT;

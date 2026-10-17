-- Verification for wip-20261017_visitor_pass_renewal.sql
-- 🔴 No BEGIN/COMMIT: the terminal SELECT must return its PASS row.
--
-- 🔴 EXECUTION, NOT STRUCTURE. A gate that greps the body for
-- "2 minutes" passes against a function that never reaches the check.
-- All three outcomes are produced for real, on a throwaway property at
-- a TEST tenant, with a limit of 2 set on it so limit_reached is
-- reachable without touching anyone's configuration. Everything is
-- removed and read back.
DO $do$
DECLARE
  v_fail    TEXT[] := '{}';
  v_prop    TEXT;
  v_co      TEXT;
  v_plate   TEXT := 'ZZRENEW01';
  v_unit    TEXT := '9001';
  v_r1      jsonb;
  v_r2      jsonb;
  v_r3      jsonb;
  v_r4      jsonb;
  v_rows    INT;
  v_audits  INT;
  v_prop_id BIGINT;
BEGIN
  -- A throwaway property at a test tenant, limit 2.
  SELECT name INTO v_co FROM public.companies WHERE company_env = 'test' ORDER BY id LIMIT 1;
  IF v_co IS NULL THEN RAISE EXCEPTION 'VERIFICATION INCONCLUSIVE: no test-env company'; END IF;
  v_prop := 'zzrenew-' || extract(epoch FROM now())::BIGINT;

  INSERT INTO public.properties (name, company, is_active, visitor_pass_limit)
  VALUES (v_prop, v_co, TRUE, 2)
  RETURNING id INTO v_prop_id;

  -- ── 1. a first pass ─────────────────────────────────────────────
  v_r1 := public.issue_visitor_pass(v_plate, 'Probe', v_unit, v_prop, 'probe', 4);
  IF COALESCE(v_r1 ->> 'action', '') <> 'issued' THEN
    v_fail := array_append(v_fail, format('G1: first call returned %s, expected issued', v_r1));
  END IF;
  IF (v_r1 ->> 'created_at') IS NULL OR (v_r1 ->> 'expires_at') IS NULL THEN
    v_fail := array_append(v_fail, 'G1: created_at/expires_at missing — the confirmation has nothing server-side to render');
  END IF;

  -- ── 2. an immediate identical call is a DOUBLE TAP ──────────────
  v_r2 := public.issue_visitor_pass(v_plate, 'Probe', v_unit, v_prop, 'probe', 4);
  IF COALESCE(v_r2 ->> 'action', '') <> 'double_tap' THEN
    v_fail := array_append(v_fail, format('G2: second call returned %s, expected double_tap', v_r2 ->> 'action'));
  END IF;
  IF (v_r2 ->> 'pass_id') IS DISTINCT FROM (v_r1 ->> 'pass_id') THEN
    v_fail := array_append(v_fail, 'G2: the double tap returned a DIFFERENT pass — it created a row');
  END IF;
  SELECT count(*) INTO v_rows FROM public.visitor_passes WHERE property = v_prop;
  IF v_rows <> 1 THEN
    v_fail := array_append(v_fail, format('G2: %s row(s) after a double tap, expected 1', v_rows));
  END IF;

  -- ── 3. a RENEWAL outside the window is a NEW row ────────────────
  -- The window is measured from the last row's created_at, so moving
  -- that row back is the honest way to be "outside the window" without
  -- a sleep.
  UPDATE public.visitor_passes
     SET created_at = now() - INTERVAL '10 minutes'
   WHERE property = v_prop;

  v_r3 := public.issue_visitor_pass(v_plate, 'Probe', v_unit, v_prop, 'probe', 4);
  IF COALESCE(v_r3 ->> 'action', '') <> 'issued' THEN
    v_fail := array_append(v_fail, format('G3: a renewal outside the window returned %s, expected issued', v_r3 ->> 'action'));
  END IF;
  SELECT count(*) INTO v_rows FROM public.visitor_passes WHERE property = v_prop;
  IF v_rows <> 2 THEN
    v_fail := array_append(v_fail, format('G3: %s row(s) after a renewal, expected 2', v_rows));
  END IF;
  -- 🔴 The returned expiry must BE the row's expiry. This is the whole
  -- incident: the guest was shown a time the row did not carry.
  IF NOT EXISTS (
    SELECT 1 FROM public.visitor_passes
     WHERE id = (v_r3 ->> 'pass_id')::BIGINT
       AND expires_at = (v_r3 ->> 'expires_at')::TIMESTAMPTZ
       AND created_at = (v_r3 ->> 'created_at')::TIMESTAMPTZ
  ) THEN
    v_fail := array_append(v_fail, 'G3: the returned created_at/expires_at do not match the row in the table');
  END IF;

  -- ── 4. at the limit: refused, no row, real expiry returned ──────
  UPDATE public.visitor_passes
     SET created_at = now() - INTERVAL '10 minutes'
   WHERE property = v_prop;

  v_r4 := public.issue_visitor_pass(v_plate, 'Probe', v_unit, v_prop, 'probe', 4);
  IF COALESCE(v_r4 ->> 'action', '') <> 'limit_reached' THEN
    v_fail := array_append(v_fail, format('G4: the third pass at a limit of 2 returned %s, expected limit_reached', v_r4 ->> 'action'));
  END IF;
  IF COALESCE((v_r4 ->> 'ok')::BOOLEAN, TRUE) THEN
    v_fail := array_append(v_fail, 'G4: limit_reached reported ok=true — a refusal must not look like a success');
  END IF;
  SELECT count(*) INTO v_rows FROM public.visitor_passes WHERE property = v_prop;
  IF v_rows <> 2 THEN
    v_fail := array_append(v_fail, format('G4: %s row(s) after a refusal, expected 2 — the refusal created one', v_rows));
  END IF;
  IF (v_r4 ->> 'expires_at') IS NULL THEN
    v_fail := array_append(v_fail, 'G4: the refusal carries no current expiry, so the guest cannot be told what they still hold');
  END IF;

  -- ── 5. every outcome left an audit row ──────────────────────────
  SELECT count(*) INTO v_audits
    FROM public.audit_logs
   WHERE action = 'VISITOR_TOS_ACCEPTED'
     AND new_values ->> 'property' = v_prop;
  IF v_audits <> 4 THEN
    v_fail := array_append(v_fail, format('G5: %s audit row(s) for 4 calls — one per call, every branch', v_audits));
  END IF;
  FOR v_rows IN
    SELECT 1 FROM (VALUES ('issued'), ('double_tap'), ('limit_reached')) AS o(x)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.audit_logs
        WHERE action = 'VISITOR_TOS_ACCEPTED'
          AND new_values ->> 'property' = v_prop
          AND new_values ->> 'outcome'  = o.x)
  LOOP
    v_fail := array_append(v_fail, 'G5: an outcome is missing from the audit trail — a dedup hit leaving no trace is what made this incident unmeasurable');
  END LOOP;

  -- ── cleanup, checked ────────────────────────────────────────────
  DELETE FROM public.visitor_passes WHERE property = v_prop;
  DELETE FROM public.audit_logs WHERE action = 'VISITOR_TOS_ACCEPTED' AND new_values ->> 'property' = v_prop;
  DELETE FROM public.properties WHERE id = v_prop_id;

  SELECT count(*) INTO v_rows FROM public.visitor_passes WHERE property = v_prop;
  IF v_rows <> 0 THEN v_fail := array_append(v_fail, 'G6: probe passes survived cleanup'); END IF;
  IF EXISTS (SELECT 1 FROM public.properties WHERE id = v_prop_id) THEN
    v_fail := array_append(v_fail, 'G6: the probe property survived cleanup');
  END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n%', array_to_string(v_fail, E'\n');
  END IF;
END
$do$;

SELECT 'PASS — issued / double_tap / limit_reached all produced; returned times match the row; the refusal creates no row and carries the real expiry; one audit row per call; probes removed' AS result;

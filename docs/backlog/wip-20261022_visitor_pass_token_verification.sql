-- Verification for wip-20261022_visitor_pass_token.sql
-- 🔴 No BEGIN/COMMIT: the terminal SELECT must return its PASS row.
--
-- 🔴 IT SETS THE service_role CLAIM FIRST. issue_visitor_pass reads
-- auth.jwt() ->> 'role'; from a DO block that is NULL, it takes the
-- resident branch and raises 'unauthenticated' — correctly. Same note
-- as the renewal verification: what keeps anon out of that function is
-- the GRANT, not the claim.
--
-- Two throwaway properties at a test tenant: one with the printable
-- switch ON, one OFF. Both removed, with a read-back.
DO $do$
DECLARE
  v_fail   TEXT[] := '{}';
  v_co     TEXT;
  v_on     TEXT;
  v_off    TEXT;
  v_on_id  BIGINT;
  v_off_id BIGINT;
  v_r      jsonb;
  v_tok    TEXT;
  v_tok2   TEXT;
  v_out    jsonb;
  v_keys   TEXT[];
  v_want   TEXT[] := ARRAY['plate', 'property', 'status', 'valid', 'valid_until'];
  v_extra  TEXT[];
  v_id     BIGINT;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim',  '{"role":"service_role"}', true);

  SELECT name INTO v_co FROM public.companies WHERE company_env = 'test' ORDER BY id LIMIT 1;
  IF v_co IS NULL THEN RAISE EXCEPTION 'VERIFICATION INCONCLUSIVE: no test-env company'; END IF;
  v_on  := 'zzpass-on-'  || extract(epoch FROM now())::BIGINT;
  v_off := 'zzpass-off-' || extract(epoch FROM now())::BIGINT;

  INSERT INTO public.properties (name, company, is_active, printable_visitor_passes_enabled)
  VALUES (v_on, v_co, TRUE, TRUE)   RETURNING id INTO v_on_id;
  INSERT INTO public.properties (name, company, is_active, printable_visitor_passes_enabled)
  VALUES (v_off, v_co, TRUE, FALSE) RETURNING id INTO v_off_id;

  -- ── G1 — switch ON mints a token of the right shape ──────────────
  v_r := public.issue_visitor_pass('ZZPASS01', 'Probe', '9001', v_on, 'probe', 4);
  SELECT pass_token, id INTO v_tok, v_id
    FROM public.visitor_passes WHERE id = (v_r ->> 'pass_id')::BIGINT;
  IF v_tok IS NULL THEN
    v_fail := array_append(v_fail, 'G1: the printable switch is ON and no token was minted');
  ELSE
    IF length(v_tok) < 40 THEN
      v_fail := array_append(v_fail, format('G1: token is only %s chars; 32 bytes base64 is 43', length(v_tok)));
    END IF;
    -- 🔴 URL-SAFE, asserted. A '+' or '/' in a path segment is a
    -- different URL, and the card prints the link.
    IF v_tok ~ '[+/=]' THEN
      v_fail := array_append(v_fail, format('G1: token is not URL-safe: %s', v_tok));
    END IF;
  END IF;

  -- ── G2 — switch OFF mints nothing ────────────────────────────────
  v_r := public.issue_visitor_pass('ZZPASS02', 'Probe', '9002', v_off, 'probe', 4);
  IF (SELECT pass_token FROM public.visitor_passes WHERE id = (v_r ->> 'pass_id')::BIGINT) IS NOT NULL THEN
    v_fail := array_append(v_fail, 'G2: a token was minted at a property with the printable switch OFF');
  END IF;

  -- ── G3 — the valid answer is EXACTLY five keys ───────────────────
  v_out := public.get_visitor_pass_by_token(v_tok);
  IF (v_out ->> 'valid') IS DISTINCT FROM 'true' THEN
    v_fail := array_append(v_fail, format('G3: a live pass did not read as valid: %s', v_out));
  END IF;
  SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(v_out) AS k;
  SELECT array_agg(k) INTO v_extra FROM unnest(v_keys) k WHERE NOT (k = ANY (v_want));
  IF v_extra IS NOT NULL THEN
    v_fail := array_append(v_fail, format('G3: UNEXPECTED keys: %s', array_to_string(v_extra, ', ')));
  END IF;
  -- 🔴 Named individually, so a failure says WHICH field leaked.
  FOR v_tok2 IN SELECT x FROM unnest(ARRAY[
      'visitor_name','visiting_unit','vehicle_desc','id','created_at',
      'pass_token','duration_hours','is_active']) x
  LOOP
    IF v_out ? v_tok2 THEN
      v_fail := array_append(v_fail, format('G3: 🔴 %s was published to an anonymous viewer', v_tok2));
    END IF;
  END LOOP;

  -- ── G4 — the four refusals are IDENTICAL ─────────────────────────
  -- 🔴 This is the assertion that keeps the page from being an oracle.
  -- If any of these ever differ, someone can probe whether a token
  -- existed.
  IF public.get_visitor_pass_by_token('tooshort')          IS DISTINCT FROM '{"valid": false}'::jsonb
  OR public.get_visitor_pass_by_token(repeat('z', 43))     IS DISTINCT FROM '{"valid": false}'::jsonb
  OR public.get_visitor_pass_by_token(NULL)                IS DISTINCT FROM '{"valid": false}'::jsonb THEN
    v_fail := array_append(v_fail,
      format('G4: the short / unknown / null refusals are not identical: %s | %s | %s',
        public.get_visitor_pass_by_token('tooshort'),
        public.get_visitor_pass_by_token(repeat('z', 43)),
        public.get_visitor_pass_by_token(NULL)));
  END IF;

  -- revoked — is_active FALSE, still unexpired
  UPDATE public.visitor_passes SET is_active = FALSE WHERE id = v_id;
  IF public.get_visitor_pass_by_token(v_tok) IS DISTINCT FROM '{"valid": false}'::jsonb THEN
    v_fail := array_append(v_fail, format('G4: a REVOKED pass did not read as the standard refusal: %s',
      public.get_visitor_pass_by_token(v_tok)));
  END IF;

  -- expired — is_active TRUE again, expiry in the past
  UPDATE public.visitor_passes SET is_active = TRUE, expires_at = now() - INTERVAL '1 hour' WHERE id = v_id;
  IF public.get_visitor_pass_by_token(v_tok) IS DISTINCT FROM '{"valid": false}'::jsonb THEN
    v_fail := array_append(v_fail, format('G4: an EXPIRED pass did not read as the standard refusal: %s',
      public.get_visitor_pass_by_token(v_tok)));
  END IF;

  -- ── G5 — grants ──────────────────────────────────────────────────
  IF NOT has_function_privilege('anon', 'public.get_visitor_pass_by_token(text)', 'EXECUTE') THEN
    v_fail := array_append(v_fail, 'G5: anon cannot execute the reader — the printed card would not work');
  END IF;
  IF has_function_privilege('anon', 'public.mint_pass_token_if_printable(text)', 'EXECUTE') THEN
    v_fail := array_append(v_fail, 'G5: 🔴 anon can execute the MINTER');
  END IF;
  IF has_function_privilege('anon', 'public.issue_visitor_pass(text,text,text,text,text,integer)', 'EXECUTE') THEN
    v_fail := array_append(v_fail, 'G5: 🔴 anon regained EXECUTE on issue_visitor_pass — that was the CAPTCHA bypass');
  END IF;

  -- ── cleanup, checked ─────────────────────────────────────────────
  DELETE FROM public.visitor_passes WHERE property IN (v_on, v_off);
  DELETE FROM public.audit_logs
   WHERE action = 'VISITOR_TOS_ACCEPTED' AND new_values ->> 'property' IN (v_on, v_off);
  DELETE FROM public.properties WHERE id IN (v_on_id, v_off_id);
  IF EXISTS (SELECT 1 FROM public.visitor_passes WHERE property IN (v_on, v_off))
  OR EXISTS (SELECT 1 FROM public.properties WHERE id IN (v_on_id, v_off_id)) THEN
    v_fail := array_append(v_fail, 'G6: probes survived cleanup');
  END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'VERIFICATION FAILED:\n%', array_to_string(v_fail, E'\n');
  END IF;
END
$do$;

SELECT 'PASS — token minted only with the switch on, URL-safe and 43 chars; the valid answer is exactly five keys with no name/unit/desc/token; short, unknown, null, revoked and expired all return the identical refusal; anon reads but cannot mint or issue; probes removed' AS result;

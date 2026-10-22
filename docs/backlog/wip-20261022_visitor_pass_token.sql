-- ════════════════════════════════════════════════════════════════════
-- Piece 2 — a printable visitor pass has a token, and the page it
--           points at tells an anonymous viewer four facts
-- ════════════════════════════════════════════════════════════════════
-- Design approved 2026-10-17, build authorised 2026-10-22.
--
--   • a 256-bit pass_token, minted in issue_visitor_pass ONLY when the
--     property's printable-passes switch is on;
--   • lifetime = the PASS's lifetime. No second expiry column: a token
--     that outlived its pass would be a working link to an expired
--     pass, which is the Oct 17 defect in another costume;
--   • the valid answer is exactly plate / property / valid_until /
--     status, and nothing else;
--   • unknown, expired and revoked all return ONE IDENTICAL refusal;
--   • no visitor name and no unit, anywhere.
--
-- 🔴 WHY THE REFUSALS ARE IDENTICAL, UNLIKE THE TOW-TICKET READER.
-- get_violation_by_view_token distinguishes invalid_token from
-- not_found_or_expired, and that is right there: the reader is the
-- vehicle's owner and the distinction helps them. Here the reader is
-- whoever scanned a code in a car park. Telling them apart would let
-- anyone probe whether a token ever existed, and turn the page into an
-- oracle for guessing. One answer, for all three.
--
-- 🔴 AND THE TOKEN IS NOT A PERMIT. It proves nothing about the
-- vehicle to enforcement: the driver's lookup reads visitor_passes, not
-- this page. The card is for a windscreen, so that a passing manager
-- can see a pass exists without calling the office.
--
-- Paired: wip-20261022_visitor_pass_token_verification.sql

-- ── 1. the column ───────────────────────────────────────────────────
-- 🔴 UNIQUE, and nullable. Postgres permits many NULLs in a UNIQUE
-- index, which is what makes "most passes have no token" expressible
-- without a partial index. Passes issued before this, and passes at
-- properties with the switch off, simply carry NULL and have no page.
ALTER TABLE public.visitor_passes
  ADD COLUMN IF NOT EXISTS pass_token TEXT;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.visitor_passes'::regclass
       AND conname = 'visitor_passes_pass_token_key'
  ) THEN
    ALTER TABLE public.visitor_passes
      ADD CONSTRAINT visitor_passes_pass_token_key UNIQUE (pass_token);
  END IF;
END
$do$;

COMMENT ON COLUMN public.visitor_passes.pass_token IS
  'Capability token for the printable pass page, /pass/<token>. 256 bits from gen_random_bytes(32), base64, URL-safe — 43 characters. Minted by issue_visitor_pass ONLY when the property''s printable_visitor_passes_enabled is true; NULL everywhere else, and NULL on every pass issued before 2026-10-22. There is no separate expiry: the token lives exactly as long as the pass, because a token outliving its pass is a working link to an expired pass. Read only through get_visitor_pass_by_token, which never returns it.';

-- ── 2. the reader ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_visitor_pass_by_token(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_pass public.visitor_passes%ROWTYPE;
BEGIN
  -- 🔴 ONE REFUSAL, AND IT IS BUILT ONCE. Every failure path below
  -- returns this same object: a token that is too short, a token that
  -- matches nothing, a pass that expired, a pass that was revoked.
  -- Writing them as separate returns is how they drift apart, and the
  -- moment they differ the page becomes an oracle.
  IF p_token IS NULL OR length(p_token) < 32 THEN
    RETURN jsonb_build_object('valid', FALSE);
  END IF;

  -- Liveness is BOTH predicates, always. Nothing flips is_active on
  -- expiry, so the flag alone would serve a long-expired pass; and
  -- expires_at alone would serve a pass a manager revoked.
  SELECT * INTO v_pass
    FROM public.visitor_passes vp
   WHERE vp.pass_token = p_token
     AND vp.is_active = TRUE
     AND vp.expires_at > now();

  IF v_pass.id IS NULL THEN
    RETURN jsonb_build_object('valid', FALSE);
  END IF;

  -- 🔴 FOUR FACTS. No visitor_name, no visiting_unit, no vehicle_desc,
  -- no id, no created_at, and never the token itself. This card ends up
  -- on a dashboard behind glass, readable by anyone walking past, and
  -- the page is readable by anyone who photographs the code.
  --
  -- status is 'active' in every valid answer by construction — the
  -- other states are indistinguishable by design, above. It is
  -- returned anyway because the page renders a status chip and a
  -- literal in the page would be a second place to change.
  RETURN jsonb_build_object(
    'valid',      TRUE,
    'status',     'active',
    'plate',      v_pass.plate,
    'property',   v_pass.property,
    'valid_until', v_pass.expires_at
  );
END
$fn$;

-- Anonymous by design: the token IS the credential, and the page is
-- reached by scanning a code. 🔴 anon is GRANTED here deliberately,
-- unlike issue_visitor_pass where an anon grant was a CAPTCHA bypass.
-- This function only reads, and only four fields.
REVOKE ALL ON FUNCTION public.get_visitor_pass_by_token(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_visitor_pass_by_token(TEXT) TO anon, authenticated;

COMMENT ON FUNCTION public.get_visitor_pass_by_token(TEXT) IS
  'Anonymous read for /pass/<token>. Returns {valid:true, status, plate, property, valid_until} for a live pass — liveness being is_active AND expires_at > now(), both — and the IDENTICAL {valid:false} for a short token, an unknown token, an expired pass and a revoked pass. The refusals are deliberately indistinguishable: unlike the tow-ticket reader, whose audience is the vehicle owner, this page is reached by anyone who photographs a code, and distinguishing would let them probe whether a token ever existed. Never returns visitor_name, visiting_unit, vehicle_desc, id, created_at or the token.';

-- ── 3. minting, gated on the property switch ────────────────────────
-- Reproduces the 2026-10-17 renewal body verbatim and adds the token.
-- Only the INSERT changes; the double-tap window, the limit branch, the
-- audit row and the returns are untouched.
CREATE OR REPLACE FUNCTION public.mint_pass_token_if_printable(p_property TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_on BOOLEAN;
BEGIN
  SELECT printable_visitor_passes_enabled INTO v_on
    FROM public.properties
   WHERE lower(trim(name)) = lower(trim(p_property))
   LIMIT 1;
  -- 🔴 NULL is OFF. A property whose switch has never been set, and a
  -- property name that matches no row, both yield NULL — and neither
  -- is a reason to mint a token. Absence is not permission.
  IF v_on IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  -- 32 bytes (256 bits), base64, URL-safe, '=' padding translated out.
  -- Same shape as the tow-ticket view_token, which is the form this
  -- codebase has already reviewed.
  RETURN translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');
END
$fn$;

REVOKE ALL ON FUNCTION public.mint_pass_token_if_printable(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mint_pass_token_if_printable(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.mint_pass_token_if_printable(TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.mint_pass_token_if_printable(TEXT) IS
  'Returns a fresh 256-bit URL-safe token when the named property has printable_visitor_passes_enabled = TRUE, and NULL otherwise — including when the switch is unset or the property name matches no row, because absence is not permission. Split out of issue_visitor_pass so the switch is consulted in exactly one place.';

-- ── 4. issue_visitor_pass — mint the token on insert ────────────────
-- 🔴 REPRODUCED FROM THE APPLIED 2026-10-17 BODY, NOT REWRITTEN. The
-- double-tap window, the limit branch, the single audit row and every
-- return are byte-identical; the only change is the INSERT, which now
-- carries pass_token. A double tap returns the existing row and so
-- keeps the token it already had — minting there would invalidate a
-- card the guest may already be holding.
--
-- CREATE OR REPLACE drops parameter DEFAULTs; this function has none,
-- so there is nothing to preserve.
CREATE OR REPLACE FUNCTION public.issue_visitor_pass(
  p_plate          TEXT,
  p_visitor_name   TEXT,
  p_visiting_unit  TEXT,
  p_property       TEXT,
  p_vehicle_desc   TEXT,
  p_duration_hours INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_normalized TEXT;
  v_unit_key   TEXT;
  v_jwt_role   TEXT;
  v_caller     TEXT;
  v_last       public.visitor_passes%ROWTYPE;
  v_created    public.visitor_passes%ROWTYPE;
  v_report     public.visitor_passes%ROWTYPE;
  v_expires    TIMESTAMPTZ;
  v_outcome    TEXT;
  v_err        TEXT;
  v_limit_msg  TEXT;
  -- A tap, not a renewal. Two minutes is long enough to cover a
  -- re-submit by someone who did not believe the first one worked
  -- (the Oct 9 bursts ran to 109 seconds) and far short of any real
  -- renewal interval.
  DOUBLE_TAP_WINDOW CONSTANT INTERVAL := INTERVAL '2 minutes';
BEGIN
  -- ── 1. Input validation (carried over verbatim) ─────────────────
  IF p_plate IS NULL OR length(trim(p_plate)) = 0 THEN
    RAISE EXCEPTION 'plate required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_property IS NULL OR length(trim(p_property)) = 0 THEN
    RAISE EXCEPTION 'property required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_duration_hours IS NULL OR p_duration_hours <= 0 THEN
    RAISE EXCEPTION 'duration_hours must be positive' USING ERRCODE = 'check_violation';
  END IF;

  v_normalized := upper(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'));
  IF length(v_normalized) = 0 THEN
    RAISE EXCEPTION 'plate empty after normalization' USING ERRCODE = 'check_violation';
  END IF;

  -- Unit comparison key. Same aggressive strip the plate and the
  -- vehicle-duplicate work use, so "Apt 1089" and "apt1089" are one
  -- unit. Digits are preserved, so "Unit 1" and "Unit 01" stay
  -- distinct — zero-padding is a real distinction in some buildings.
  v_unit_key := upper(regexp_replace(COALESCE(p_visiting_unit, ''), '[^A-Za-z0-9]', '', 'g'));

  -- ── 2. Caller scoping ───────────────────────────────────────────
  -- Two legitimate callers:
  --   service_role — /api/visitor/create-pass, which owns the CAPTCHA
  --                  and the anon-visitor checks. Unscoped by design.
  --   a resident   — scoped to their OWN (property, unit).
  --
  -- 🔴 THE SECURITY OF THE UNSCOPED BRANCH RESTS ON THE GRANT BELOW.
  -- anon is deliberately NOT granted EXECUTE on this function, unlike
  -- create_visitor_pass, which granted anon directly and so let a
  -- crafted call skip the CAPTCHA the route enforces. If anyone ever
  -- re-grants anon here, that bypass returns. The role is read from the
  -- JWT claim rather than current_user, which SECURITY DEFINER rewrites
  -- to the function owner.
  v_jwt_role := auth.jwt() ->> 'role';

  IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
    v_caller := lower(trim(COALESCE(auth.jwt() ->> 'email', '')));
    IF v_caller = '' THEN
      RAISE EXCEPTION 'unauthenticated'
        USING HINT = 'Issuing a visitor pass requires a signed-in resident or the server route.';
    END IF;
    IF public.get_my_role() IS DISTINCT FROM 'resident' THEN
      RAISE EXCEPTION 'caller is not a resident'
        USING HINT = 'Only a resident may issue a pass for their own unit from this path.';
    END IF;
    -- Replaces what RLS used to do for the direct .insert(). A DEFINER
    -- function bypasses resident_own_passes, so the equivalent scope
    -- check has to live here or an authenticated resident could issue a
    -- pass at any property and unit in the system.
    --
    -- Stricter than the policy it replaces: that one matched the email
    -- with ~~* (ILIKE), so a resident whose address contains _ or %
    -- matched other people's rows. Exact lower(trim()) here, consistent
    -- with the direction of the email-ILIKE arc.
    IF NOT EXISTS (
      SELECT 1 FROM public.residents r
       WHERE lower(trim(r.email)) = v_caller
         AND lower(trim(r.property)) = lower(trim(p_property))
         AND upper(regexp_replace(COALESCE(r.unit, ''), '[^A-Za-z0-9]', '', 'g')) = v_unit_key
         AND r.is_active = TRUE
    ) THEN
      RAISE EXCEPTION 'not_your_unit'
        USING HINT = 'You can only issue a visitor pass for the unit you live in.';
    END IF;
  END IF;

  -- ── 3. Serialize concurrent callers for THIS pass key ───────────
  -- 🔴 WITHOUT THIS THE GUARD IS DECORATIVE. The whole defect is a
  -- race: four requests arrived inside 9 seconds, each ran its own
  -- "does a live pass exist?" check, each found none, and each
  -- inserted. A select-then-insert is not atomic, and no unique index
  -- can help because liveness needs expires_at > now() and now() is not
  -- IMMUTABLE, so it cannot appear in an index predicate.
  --
  -- A transaction-scoped advisory lock on the (property, plate, unit)
  -- key makes the check-then-act atomic for exactly the callers that
  -- would collide, and blocks nothing else. Released at commit.
  PERFORM pg_advisory_xact_lock(
    hashtext(lower(trim(p_property)) || '|' || v_normalized || '|' || v_unit_key)
  );

  -- ── 4. Double tap, renewal, or limit ────────────────────────────
  -- The LAST row for this key, newest first. Not "the oldest live row"
  -- as the Oct 9 form did: the question is no longer "is one live" but
  -- "did this same request just happen".
  SELECT * INTO v_last
    FROM public.visitor_passes vp
   WHERE lower(trim(vp.property)) = lower(trim(p_property))
     AND upper(regexp_replace(COALESCE(vp.plate, ''), '[^A-Za-z0-9]', '', 'g')) = v_normalized
     AND upper(regexp_replace(COALESCE(vp.visiting_unit, ''), '[^A-Za-z0-9]', '', 'g')) = v_unit_key
   ORDER BY vp.id DESC
   LIMIT 1;

  IF v_last.id IS NOT NULL AND v_last.created_at > now() - DOUBLE_TAP_WINDOW THEN
    -- The same request, seconds ago. Return that row; count nothing.
    v_outcome := 'double_tap';
    v_report  := v_last;
  ELSE
    v_expires := now() + (p_duration_hours || ' hours')::INTERVAL;
    BEGIN
      -- enforce_visitor_pass_limit is a BEFORE INSERT trigger, so the
      -- limit is enforced here and cannot be bypassed by any caller.
      INSERT INTO public.visitor_passes (
        plate, visitor_name, visiting_unit, property,
        vehicle_desc, duration_hours, created_at, expires_at, is_active,
        pass_token
      ) VALUES (
        v_normalized, p_visitor_name, p_visiting_unit, p_property,
        p_vehicle_desc, p_duration_hours, now(), v_expires, TRUE,
        -- 🔴 NULL unless the property's printable-passes switch is on.
        -- The switch is consulted in one place, and a renewal mints a
        -- FRESH token: the new row is a new pass, and reusing the old
        -- token would leave a printed card pointing at a row that is
        -- no longer the one in force.
        public.mint_pass_token_if_printable(p_property)
      )
      RETURNING * INTO v_created;
      v_outcome := 'issued';
      v_report  := v_created;
    EXCEPTION WHEN check_violation THEN
      -- 🔴 sqlstate 23514 IS NOT UNIQUELY THE LIMIT. A real CHECK
      -- constraint on the table raises the same code, and reporting
      -- that as "you have reached the limit" would send the guest to
      -- the office over a bug. Discriminate on the message the trigger
      -- raises, and re-raise anything else unchanged.
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      IF v_err NOT LIKE '%visitor passes at this property%' THEN
        RAISE;
      END IF;
      v_outcome   := 'limit_reached';
      v_limit_msg := v_err;
      -- The pass they still hold, if any. 🔴 BOTH predicates: nothing
      -- on this table ever flips is_active, so the flag alone would
      -- report a long-expired pass as current.
      SELECT * INTO v_report
        FROM public.visitor_passes vp
       WHERE lower(trim(vp.property)) = lower(trim(p_property))
         AND upper(regexp_replace(COALESCE(vp.plate, ''), '[^A-Za-z0-9]', '', 'g')) = v_normalized
         AND vp.is_active = TRUE
         AND vp.expires_at > now()
       ORDER BY vp.expires_at DESC
       LIMIT 1;
    END;
  END IF;

  -- ── 5. One audit row per call, every branch ─────────────────────
  INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
  VALUES (
    'VISITOR_TOS_ACCEPTED',
    'visitor_passes',
    CASE WHEN v_outcome = 'issued' THEN v_report.id::TEXT ELSE NULL END,
    jsonb_build_object(
      'outcome',        v_outcome,
      'plate',          v_normalized,
      'property',       p_property,
      'visiting_unit',  p_visiting_unit,
      'duration_hours', p_duration_hours,
      'pass_id',        v_report.id,
      'expires_at',     v_report.expires_at,
      'issued_by',      COALESCE(v_caller, 'service_role')
    )
  );

  -- ── 6. The answer, and ONLY server values ───────────────────────
  -- created_at is returned now as well: the confirmation screen must
  -- render the row's own times and never compute its own.
  IF v_outcome = 'limit_reached' THEN
    RETURN jsonb_build_object(
      'ok',             FALSE,
      'action',         'limit_reached',
      'message',        v_limit_msg,
      'pass_id',        v_report.id,
      'plate',          v_normalized,
      'created_at',     v_report.created_at,
      'expires_at',     v_report.expires_at,
      'has_active_pass', v_report.id IS NOT NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'ok',             TRUE,
    'action',         v_outcome,
    'pass_id',        v_report.id,
    'plate',          v_report.plate,
    'visitor_name',   v_report.visitor_name,
    'visiting_unit',  v_report.visiting_unit,
    'duration_hours', v_report.duration_hours,
    'created_at',     v_report.created_at,
    'expires_at',     v_report.expires_at
  );
END;
$func$;

-- 🔴 NO anon GRANT, unchanged. /visitor reaches this only through
-- /api/visitor/create-pass, which verifies the CAPTCHA server-side.
REVOKE ALL ON FUNCTION public.issue_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.issue_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.issue_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;


COMMENT ON FUNCTION public.issue_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) IS
  'Issue a visitor pass. THE single write path for /visitor (via /api/visitor/create-pass as service_role) and the resident portal. A RENEWAL CREATES A NEW ROW (now() -> now()+duration) and counts toward the rolling-30 visitor_pass_limit; a DOUBLE TAP within 2 minutes of the last row for (property, normalized plate, normalized unit) returns that row and creates nothing, checked inside the advisory lock. At the limit it returns action=limit_reached with the live pass found by BOTH is_active AND expires_at > now(). Every call writes exactly one audit row carrying the outcome (issued | double_tap | limit_reached). 🔴 2026-10-22: a new row also receives a pass_token when the property has printable_visitor_passes_enabled, via mint_pass_token_if_printable — NULL otherwise. A double tap keeps the token the returned row already had. Grants: authenticated + service_role; anon DELIBERATELY REVOKED.';

-- ── 5. grants re-affirmed, unchanged ────────────────────────────────
REVOKE ALL ON FUNCTION public.issue_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.issue_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.issue_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;

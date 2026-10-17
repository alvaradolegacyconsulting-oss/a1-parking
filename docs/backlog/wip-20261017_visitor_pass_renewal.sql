-- ════════════════════════════════════════════════════════════════════
-- issue_visitor_pass — a renewal is a new pass; a double tap is not
-- ════════════════════════════════════════════════════════════════════
-- Incident 2026-10-17, A1 / Green Acres, plate XGJ5870.
--
-- 🔴 WHAT WENT WRONG. The Oct 9 dedup had NO TIME WINDOW: it matched
-- any live pass. A guest renewing a 24h pass at 8:30 PM, while the
-- previous pass still had 2h31m to run, got that old row back —
-- unextended — and /visitor showed them "valid until 8:30 PM tomorrow"
-- because it computed the times in the browser instead of reading the
-- row. The real pass lapsed at 11:01 PM. At 12:16 AM a driver looked
-- the plate up, correctly found nothing, and a citation was written at
-- 12:35 AM against a guest who had been told they were covered.
--
-- TWO RULINGS, BOTH HERE:
--   1. A RENEWAL CREATES A NEW ROW (now() → now() + duration). Limit
--      counting, audit history and driver lookups are all row-based
--      already, so a new row makes every one of them correct with no
--      other change.
--   2. A RENEWAL COUNTS toward the visitor-pass limit. That falls out
--      of (1): enforce_visitor_pass_limit counts rows in the rolling
--      30 days, and now there is a row to count.
--
-- A DOUBLE TAP IS STILL NOT A RENEWAL. An identical request within
-- DOUBLE_TAP_WINDOW of the LAST row for the key returns that row and
-- creates nothing, so the Oct 9 guarantee holds: N concurrent taps →
-- 1 row. The window is checked INSIDE the advisory lock, because two
-- taps 1 ms apart would otherwise both see "no recent row".
--
-- 🔴 AND EVERY OUTCOME IS AUDITED. Before today a dedup hit wrote
-- nothing at all, which is why the incident could not be sized from
-- the database — the event we most needed to count left no trace. One
-- audit row per call now, on every branch, carrying the outcome. The
-- action name stays VISITOR_TOS_ACCEPTED: it is a legacy misnomer (it
-- marks pass issuance, not TOS acceptance) but it is the only existing
-- trace of /visitor issuance and every grep and count depends on it.
--
-- Paired: wip-20261017_visitor_pass_renewal_verification.sql

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
        vehicle_desc, duration_hours, created_at, expires_at, is_active
      ) VALUES (
        v_normalized, p_visitor_name, p_visiting_unit, p_property,
        p_vehicle_desc, p_duration_hours, now(), v_expires, TRUE
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
  'Issue a visitor pass. THE single write path for /visitor (via /api/visitor/create-pass as service_role) and the resident portal (as the signed-in resident). 🔴 2026-10-17: a RENEWAL CREATES A NEW ROW (now() -> now()+duration) and therefore counts toward the rolling-30 visitor_pass_limit; the Oct 9 form returned any live pass unextended, and /visitor showed browser-computed times, so a guest was told they were covered 20 hours past their real expiry and was cited. A DOUBLE TAP is still not a renewal: an identical request within 2 minutes of the LAST row for (property, normalized plate, normalized unit) returns that row and creates nothing, checked inside the advisory lock. At the limit it returns action=limit_reached with the live pass found by BOTH is_active AND expires_at > now(). Every call writes exactly one audit row carrying the outcome (issued | double_tap | limit_reached) — before this, a dedup hit left no trace and the incident could not be sized. created_at and expires_at are returned so the confirmation can render server values only. Grants: authenticated + service_role; anon DELIBERATELY REVOKED.';

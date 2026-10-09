-- ════════════════════════════════════════════════════════════════════
-- issue_visitor_pass — one select-or-create path for both surfaces
-- ════════════════════════════════════════════════════════════════════
--
-- Ruling: Jose, 2026-10-09.
--
-- WHAT HAPPENED. A Green Acres resident issued the same 24h pass four
-- times in 9 seconds (ids 2203/2205/2204/2206). Not isolated: 22 bursts
-- across 4 properties, 27 duplicate rows, back to 2026-08-09. Two
-- distinct causes, and only one of them is a double-tap:
--   • sub-2-second bursts — no in-flight guard on the resident button
--   • 20-109 SECOND bursts — someone re-submitting because they did not
--     believe it had worked. A disabled button does nothing for those.
--
-- The two surfaces did not share a write path, which is why a guard in
-- one place could never have covered both:
--   /visitor (anon) -> /api/visitor/create-pass -> create_visitor_pass
--   /resident       -> a DIRECT .insert() on visitor_passes
-- The reported incident came through the direct insert.
--
-- 🔴 WHY AN RPC AND NOT A TRIGGER. A BEFORE INSERT trigger is the only
-- other thing that covers both paths, but it can only SUPPRESS the row
-- (RETURN NULL) — and then the client's .insert() reports success
-- having written nothing. That is the same lying-success shape removed
-- from approve_vehicle and deactivate_my_vehicle this week. An RPC can
-- say "you already have a pass for this plate, it expires at 03:28
-- tomorrow", which is both honest and better copy than silence.
--
-- 🔴 LIVE MEANS BOTH PREDICATES. is_active = true AND expires_at >
-- now(). On this table is_active is close to meaningless on its own:
-- 1,874 of 1,877 rows are flagged active and only 30 are unexpired,
-- because nothing ever flips the flag. A dedup guard reading is_active
-- alone would hand back a pass that expired three weeks ago. (The flag
-- never flipping is filed separately —
-- docs/backlog/visitor-pass-is-active-never-flips-2026-10-09.md.)
--
-- 🔴 SERVER TIME. The resident path set created_at from the browser
-- clock, which is why ids 2203/2205/2204/2206 are out of chronological
-- order. Both created_at and expires_at are now computed from now()
-- inside the function and are not parameters.
--
-- Paired: wip-20261009_issue_visitor_pass_dedup_verification.sql

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
  v_existing   public.visitor_passes%ROWTYPE;
  v_created    public.visitor_passes%ROWTYPE;
  v_expires    TIMESTAMPTZ;
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

  -- ── 4. Select-or-create ─────────────────────────────────────────
  -- ORDER BY id, not created_at: created_at was client-supplied until
  -- today, so the lowest id is the only trustworthy "first".
  SELECT * INTO v_existing
    FROM public.visitor_passes vp
   WHERE lower(trim(vp.property)) = lower(trim(p_property))
     AND upper(regexp_replace(COALESCE(vp.plate, ''), '[^A-Za-z0-9]', '', 'g')) = v_normalized
     AND upper(regexp_replace(COALESCE(vp.visiting_unit, ''), '[^A-Za-z0-9]', '', 'g')) = v_unit_key
     AND vp.is_active = TRUE
     AND vp.expires_at > now()
   ORDER BY vp.id
   LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok',             TRUE,
      'action',         'existing',
      'pass_id',        v_existing.id,
      'plate',          v_existing.plate,
      'visitor_name',   v_existing.visitor_name,
      'visiting_unit',  v_existing.visiting_unit,
      'duration_hours', v_existing.duration_hours,
      'expires_at',     v_existing.expires_at
    );
  END IF;

  v_expires := now() + (p_duration_hours || ' hours')::INTERVAL;

  -- enforce_visitor_pass_limit fires on this INSERT, as it did on both
  -- old paths. Its rolling-30 count is unchanged; this function just
  -- stops feeding it duplicates.
  INSERT INTO public.visitor_passes (
    plate, visitor_name, visiting_unit, property,
    vehicle_desc, duration_hours, created_at, expires_at, is_active
  ) VALUES (
    v_normalized, p_visitor_name, p_visiting_unit, p_property,
    p_vehicle_desc, p_duration_hours, now(), v_expires, TRUE
  )
  RETURNING * INTO v_created;

  -- Audit action preserved from create_visitor_pass so existing log
  -- greps keep working. The resident surface additionally writes its own
  -- ISSUE_VISITOR_PASS row from the client, as it always has.
  INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
  VALUES (
    'VISITOR_TOS_ACCEPTED',
    'visitor_passes',
    NULL,
    jsonb_build_object(
      'plate', v_normalized, 'property', p_property,
      'pass_id', v_created.id, 'visiting_unit', p_visiting_unit,
      'issued_by', COALESCE(v_caller, 'service_role')
    )
  );

  RETURN jsonb_build_object(
    'ok',             TRUE,
    'action',         'created',
    'pass_id',        v_created.id,
    'plate',          v_created.plate,
    'visitor_name',   v_created.visitor_name,
    'visiting_unit',  v_created.visiting_unit,
    'duration_hours', v_created.duration_hours,
    'expires_at',     v_created.expires_at
  );
END;
$func$;

-- 🔴 NO anon GRANT. See §2. /visitor reaches this only through
-- /api/visitor/create-pass, which verifies the CAPTCHA server-side.
REVOKE ALL ON FUNCTION public.issue_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.issue_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.issue_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;

COMMENT ON FUNCTION public.issue_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) IS
  'Select-or-create visitor pass. THE single write path for both /visitor (via /api/visitor/create-pass as service_role) and the resident portal (as the signed-in resident); replaces create_visitor_pass and the resident page''s direct .insert(). Returns action=''existing'' with the live pass instead of creating a duplicate. Live = is_active AND expires_at > now() — both, because nothing flips is_active on expiry. Dedup key is (property, normalized plate, normalized unit), serialized by a transaction advisory lock because select-then-insert is not atomic and no unique index can express expires_at > now(). created_at and expires_at come from now(), never from the caller. Resident callers are scoped to their own active (property, unit) with exact lower(trim()) matching, replacing what resident_own_passes RLS did for the direct insert. Grants: authenticated + service_role; anon DELIBERATELY REVOKED — create_visitor_pass granted anon and so allowed a CAPTCHA bypass.';

-- ── Close the old path ────────────────────────────────────────────
-- create_visitor_pass is left in place but made unreachable from any
-- client: nothing calls it after this arc, and its anon grant was the
-- CAPTCHA bypass described above. Not dropped — a DROP would have to be
-- re-created exactly if anything unfound still references it, and
-- revoking is enough to make it dead.
REVOKE ALL ON FUNCTION public.create_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.create_visitor_pass(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM authenticated;

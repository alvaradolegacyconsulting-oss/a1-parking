-- ═══════════════════════════════════════════════════════════════════
-- B182 — Collapse tow-ticket reprints into capability URL + PM view
-- Date:   2026-06-14
-- Branch: feat/b182-pm-ticket-summary
--
-- TWO CONCERNS, ONE ATOMIC MIGRATION
--
-- 1. stamp_tow_ticket "already-stamped" guard. Closes a silent-overwrite
--    integrity gap surfaced during B182 diagnostic: today a driver can
--    re-call stamp_tow_ticket on an already-stamped live row and silently
--    overwrite tow_fee + tow_storage_*. No audit trail of the old stamp
--    values. After this migration, re-stamping a live ticket returns
--    'already_stamped'. Reissue must follow Jose's locked rule: void the
--    existing ticket (B175 void_violation), then create a NEW violation
--    row for the corrected tow, then stamp the new row. Voided rows stay
--    voided forever as immutable audit truth (B175 principle preserved).
--
-- 2. get_pm_ticket_summary SECURITY DEFINER RPC. New auth-surface RPC
--    that returns a single violation's data EXPLICITLY PRICE-STRIPPED on
--    the server (not CSS-hidden) for the PM view. Locked omission per
--    B182 spec (2026-06-14 corrected): tow_fee. Storage facility info
--    (tow_storage_name/address/phone) IS included — PM needs it to tell
--    residents where the towed vehicle went; storage isn't money.
--    Caller-role gate: manager / leasing_agent only. Property-scope gate:
--    violation.property must be in caller's get_my_properties().
--    Voided guard: refuses voided rows so the PM never sees a
--    no-longer-in-effect ticket.
--
-- WHY ONE ATOMIC APPLY
-- PART 1 + PART 2 ship together so the B182 build (new PM route +
-- portal refactor + probe) lands against a database that both enforces
-- void-first-on-reissue AND exposes the price-free PM read path.
-- Single paste / single run per the standing apply discipline.
--
-- PER-COLUMN AUDIT — what get_pm_ticket_summary RETURNS vs OMITS
-- ──────────────────────────────────────────────────────────────
-- SCOPE CORRECTION (2026-06-14, second apply): PM view hides PRICE
-- ONLY, not storage. Original spec over-stripped — PM legitimately
-- needs storage facility info to tell residents where a towed vehicle
-- went. Storage isn't money. Net change vs first apply:
-- tow_storage_name/address/phone re-included in the returned payload.
--
-- INCLUDED in returned payload (each field's reason):
--   id, plate                              — identify the row + vehicle
--   vehicle_year/make/model/color          — vehicle identity for PM
--   violation_type, location, notes        — what happened + where
--   property                               — property context
--   driver_name, driver_license            — operator identity (B120)
--   created_at                             — when it happened
--   tow_ticket_generated_at                — when the ticket was issued
--   was_authorized_at_time                 — B71 authorized-plate flag
--   decline_reason, decline_reason_note    — B71 decline context
--   tow_storage_name/address/phone         — facility identity; PM
--                                            needs to tell residents
--                                            where the towed vehicle
--                                            went. NOT money.
--   photos                                 — PM may need to verify
--   video_url                              — PM may need to verify
--
-- EXPLICITLY OMITTED (each field's reason):
--   tow_fee                                — MONEY (Jose lock; the
--                                            only omission about price)
--   view_token / view_token_expires_at     — would let PM jump to the
--                                            priced public capability
--                                            URL, defeating the price
--                                            omission
--   voided_at / voided_by_* / void_reason  — always NULL in PM payload
--                                            anyway (voided guard filters)
--   is_confirmed                           — PM only sees confirmed
--                                            (draft view is not their
--                                            audience)
--   tow_ticket_generated                   — always true in PM payload
--
-- KNOWN SCHEMA-DRIFT NOTE
-- violations table has NO `state` column despite the public ticket view's
-- ViolationRow interface declaring `state: string | null`. That field is
-- always undefined on actual rows; the public render shows '—' as
-- fallback. Out of scope for B182; flagged for cleanup pass.
-- ═══════════════════════════════════════════════════════════════════


-- ── PRE-APPLY VERIFICATION ──────────────────────────────────────────

-- Current stamp_tow_ticket body — confirm it's the B178 form (no
-- already_stamped guard yet).
SELECT pg_get_functiondef(p.oid) AS current_body
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname = 'stamp_tow_ticket';

-- get_pm_ticket_summary should NOT exist yet.
SELECT p.proname FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname = 'get_pm_ticket_summary';

-- Helpers — body depends on these.
SELECT p.proname FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('get_my_role', 'get_my_properties')
 ORDER BY p.proname;


-- ═══════════════════════════════════════════════════════════════════
-- PART 1 — stamp_tow_ticket: add already-stamped guard
-- ═══════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE preserves signature (BIGINT, BIGINT, NUMERIC) so
-- no grant re-affirmation needed. Body adds ONE new check before the
-- UPDATE; everything else is byte-identical to the B178 form.

CREATE OR REPLACE FUNCTION public.stamp_tow_ticket(
  p_violation_id        BIGINT,
  p_storage_facility_id BIGINT,
  p_tow_fee             NUMERIC
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_company        TEXT;
  v_properties     TEXT[];
  v_row            violations%ROWTYPE;
  v_storage        storage_facilities%ROWTYPE;
  v_updated_row    jsonb;
BEGIN
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;

  IF v_caller_role NOT IN ('admin', 'company_admin', 'driver', 'manager') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  SELECT * INTO v_row FROM violations WHERE id = p_violation_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'violation_not_found');
  END IF;
  IF v_row.is_confirmed = false THEN
    RETURN jsonb_build_object('error', 'not_confirmed');
  END IF;
  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'voided');
  END IF;

  -- B182 — already-stamped guard (NEW).
  -- Today the function silently overwrites an existing live stamp,
  -- destroying the prior tow_fee / facility values with no audit
  -- trail. Per Jose's locked rule: reissue requires void-first AND a
  -- new violation row. A non-voided already-stamped row cannot be
  -- re-stamped on the same row. Driver flow on reissue: void the row
  -- (B175 void_violation) + create a new violation entry + stamp the
  -- new entry.
  IF v_row.tow_ticket_generated = true THEN
    -- USING HINT is RAISE-only syntax; folding the guidance into the
    -- jsonb payload as 'hint' is actually preferable — the UI reads
    -- the JSON, vs USING HINT which only surfaces on raised exceptions.
    RETURN jsonb_build_object(
      'error', 'already_stamped',
      'hint',  'Void the existing ticket and create a new violation entry to reissue.'
    );
  END IF;

  IF v_caller_role IN ('company_admin', 'driver') THEN
    v_company := get_my_company();
    IF v_company IS NULL OR NOT EXISTS (
      SELECT 1 FROM properties p
       WHERE p.name = v_row.property
         AND p.company ~~* v_company
    ) THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  ELSIF v_caller_role = 'manager' THEN
    v_properties := get_my_properties();
    IF v_properties IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM unnest(v_properties) p
          WHERE v_row.property ~~* p
       )
    THEN
      RETURN jsonb_build_object('error', 'violation_out_of_scope');
    END IF;
  END IF;

  SELECT * INTO v_storage FROM storage_facilities WHERE id = p_storage_facility_id;
  IF v_storage.id IS NULL THEN
    RETURN jsonb_build_object('error', 'storage_facility_not_found');
  END IF;

  IF v_caller_role IN ('company_admin', 'driver', 'manager') THEN
    v_company := get_my_company();
    IF v_company IS NULL
       OR v_storage.company IS NULL
       OR NOT (v_storage.company ~~* v_company)
    THEN
      RETURN jsonb_build_object('error', 'storage_facility_out_of_scope');
    END IF;
  END IF;

  UPDATE violations
     SET tow_ticket_generated     = true,
         tow_ticket_generated_at  = now(),
         tow_storage_name         = v_storage.name,
         tow_storage_address      = v_storage.address,
         tow_storage_phone        = v_storage.phone,
         tow_fee                  = p_tow_fee
   WHERE id = p_violation_id
  RETURNING to_jsonb(violations.*) INTO v_updated_row;

  RETURN jsonb_build_object(
    'ok',        true,
    'violation', v_updated_row
  );
END
$func$;

-- Grants unchanged from B178 (signature preserved) but re-affirm
-- defensively in case any drift crept in.
REVOKE EXECUTE ON FUNCTION public.stamp_tow_ticket(BIGINT, BIGINT, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stamp_tow_ticket(BIGINT, BIGINT, NUMERIC) FROM anon;
GRANT  EXECUTE ON FUNCTION public.stamp_tow_ticket(BIGINT, BIGINT, NUMERIC) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════
-- PART 2 — get_pm_ticket_summary: PM view RPC (price-stripped)
-- ═══════════════════════════════════════════════════════════════════
-- New SECURITY DEFINER function. Auth-surface — same class as
-- insert_user_role's B155.2 closure. Standard discipline: SET
-- search_path pin, explicit REVOKE PUBLIC + REVOKE anon, GRANT
-- authenticated only, accompanied by a behavioral probe at
-- scripts/probe-b182-pm-ticket-summary.ts.

CREATE OR REPLACE FUNCTION public.get_pm_ticket_summary(p_violation_id BIGINT)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_role TEXT;
  v_properties  TEXT[];
  v_row         violations%ROWTYPE;
  v_photos      jsonb;
BEGIN
  -- ── 1. ROLE GATE — manager / leasing_agent only ────────────────
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;
  IF v_caller_role NOT IN ('manager', 'leasing_agent') THEN
    -- USING HINT is RAISE-only; hint lands in the JSON payload instead.
    RETURN jsonb_build_object(
      'error', 'role_not_authorized',
      'hint',  'This view is for property managers and leasing agents only. Drivers + CA use the public capability URL; admin uses portal tools.'
    );
  END IF;

  -- ── 2. PROPERTY-SCOPE GATE ─────────────────────────────────────
  v_properties := get_my_properties();
  IF v_properties IS NULL OR array_length(v_properties, 1) = 0 THEN
    RETURN jsonb_build_object('error', 'no_property_scope');
  END IF;

  -- ── 3. LOAD VIOLATION + STATE CHECKS ───────────────────────────
  SELECT * INTO v_row FROM violations WHERE id = p_violation_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM unnest(v_properties) p
     WHERE v_row.property ~~* p
  ) THEN
    RETURN jsonb_build_object('error', 'out_of_scope');
  END IF;

  IF v_row.is_confirmed = false THEN
    RETURN jsonb_build_object('error', 'not_confirmed');
  END IF;

  IF v_row.voided_at IS NOT NULL THEN
    -- Voided ticket — PM never sees these even if they were the most
    -- recent ticket for the (property, plate) tuple. Per Jose's lock:
    -- voided ≠ in effect.
    RETURN jsonb_build_object('error', 'voided');
  END IF;

  IF v_row.tow_ticket_generated = false THEN
    -- Confirmed violation without a generated ticket — not a PM
    -- audience yet (the ticket is the artifact PM views).
    RETURN jsonb_build_object('error', 'not_ticketed');
  END IF;

  -- ── 4. PHOTOS — active only (soft-deletes excluded) ────────────
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('id', vp.id, 'photo_url', vp.photo_url)
      ORDER BY vp.id
    ),
    '[]'::jsonb
  )
    INTO v_photos
    FROM violation_photos vp
   WHERE vp.violation_id = v_row.id
     AND vp.removed_at IS NULL;

  -- ── 5. RETURN PRICE-STRIPPED PAYLOAD ───────────────────────────
  -- EXPLICITLY enumerate every field — NEVER use to_jsonb(violations.*).
  -- The whole point of this RPC is that PRICE fields can't accidentally
  -- leak into the PM view via a refactor that returns the full row.
  -- Adding a column to violations does NOT automatically expose it
  -- here — that's by design.
  --
  -- 2026-06-14 spec correction: tow_storage_name/address/phone moved
  -- back IN (PM needs storage info to inform residents where the towed
  -- vehicle went; storage isn't money). tow_fee + view_token /
  -- view_token_expires_at remain omitted (price + price-routing).
  RETURN jsonb_build_object(
    'ok', true,
    'violation', jsonb_build_object(
      'id',                      v_row.id,
      'plate',                   v_row.plate,
      'vehicle_year',            v_row.vehicle_year,
      'vehicle_make',            v_row.vehicle_make,
      'vehicle_model',           v_row.vehicle_model,
      'vehicle_color',           v_row.vehicle_color,
      'violation_type',          v_row.violation_type,
      'location',                v_row.location,
      'notes',                   v_row.notes,
      'property',                v_row.property,
      'driver_name',             v_row.driver_name,
      'driver_license',          v_row.driver_license,
      'created_at',              v_row.created_at,
      'tow_ticket_generated_at', v_row.tow_ticket_generated_at,
      'was_authorized_at_time',  v_row.was_authorized_at_time,
      'decline_reason',          v_row.decline_reason,
      'decline_reason_note',     v_row.decline_reason_note,
      'tow_storage_name',        v_row.tow_storage_name,
      'tow_storage_address',     v_row.tow_storage_address,
      'tow_storage_phone',       v_row.tow_storage_phone,
      'video_url',               v_row.video_url
    ),
    'photos', v_photos
  );
END
$func$;

REVOKE EXECUTE ON FUNCTION public.get_pm_ticket_summary(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_pm_ticket_summary(BIGINT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_pm_ticket_summary(BIGINT) TO authenticated;


-- ── POST-APPLY VERIFICATION ─────────────────────────────────────────

-- 1. stamp_tow_ticket signature unchanged, DEFINER intact.
SELECT p.proname,
       p.prosecdef AS is_security_definer,
       pg_get_function_arguments(p.oid) AS args
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname = 'stamp_tow_ticket';
-- Expected: prosecdef=true, args='p_violation_id bigint, p_storage_facility_id bigint, p_tow_fee numeric'.

-- 2. get_pm_ticket_summary exists with correct shape.
SELECT p.proname,
       p.prosecdef AS is_security_definer,
       pg_get_function_arguments(p.oid) AS args,
       l.lanname AS language
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname = 'get_pm_ticket_summary';
-- Expected: prosecdef=true, args='p_violation_id bigint', language=plpgsql.

-- 3. search_path pin landed on the new function.
SELECT p.proname, p.proconfig
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname = 'get_pm_ticket_summary';
-- Expected: proconfig = {"search_path=public, pg_temp"}.

-- 4. Grant table — load-bearing per [[feedback-revoke-from-anon-explicitly]].
SELECT r.routine_name, r.grantee, r.privilege_type
  FROM information_schema.routine_privileges r
 WHERE r.specific_schema = 'public'
   AND r.routine_name IN ('stamp_tow_ticket', 'get_pm_ticket_summary')
   AND r.grantee IN ('anon', 'authenticated', 'PUBLIC')
 ORDER BY r.routine_name, r.grantee;
-- Expected exactly:
--   get_pm_ticket_summary | authenticated | EXECUTE
--   stamp_tow_ticket      | authenticated | EXECUTE
-- 'anon' / 'PUBLIC' MUST NOT appear for either.


-- ── BEHAVIORAL VERIFICATION (probe re-run, seven caller cases) ─────
-- Post-apply: scripts/probe-b182-pm-ticket-summary.ts must run green.
--   pm.own_property_price_stripped_storage_kept
--     manager sees own-property non-voided ticket; payload has NO
--     tow_fee but DOES include tow_storage_name (positive + negative
--     assertion). 2026-06-14 spec correction.
--   pm.cross_property_denied   — out_of_scope.
--   pm.voided_denied           — voided ticket refused even if recent.
--   pm.not_ticketed_denied     — confirmed but not stamped → refused.
--   pm.leasing_agent_works     — same access pattern as manager.
--   pm.driver_denied           — role_not_authorized.
--   pm.anon_denied             — Postgres grant table denies anon.

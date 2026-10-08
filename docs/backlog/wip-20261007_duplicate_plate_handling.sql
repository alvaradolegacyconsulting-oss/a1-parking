-- ════════════════════════════════════════════════════════════════════
-- Duplicate plate handling — refuse at the source, explain at approve
-- ════════════════════════════════════════════════════════════════════
--
-- Ruling: Jose, 2026-10-07, after A1 live hit it.
--
-- WHAT HAPPENED. request_my_vehicle inserted a new pending row on every
-- submission with no duplicate check, and the resident portal gave no
-- confirmation, so residents re-submitted. The rows sat harmless until
-- a manager clicked Approve: vehicles_plate_norm_uniq raised 23505,
-- PostgREST returned 409, approve_vehicle had no handler for it, and
-- the manager's button hung on "Approving…" permanently. 18 of 29
-- pending rows at Green Acres were in this state.
--
-- The index is correct — one active plate per property is the whole
-- basis of the driver plate lookup. The HANDLING was missing at three
-- layers, and this file fixes the two in the database:
--
--   PART 1  request_my_vehicle  — refuse the duplicate at submission,
--                                 with a message the resident can act on
--   PART 2  approve_vehicle     — structured plate_already_active
--                                 instead of a raw 23505
--   PART 3  normalize_plate     — harmonize with every other normalizer
--
-- The third layer (a manager button that resets and explains) is client
-- side and ships in the same commit.
--
-- 🔴 ORDER MATTERS. Run scripts/clear-duplicate-pending-vehicles.ts
-- --apply BEFORE this file. PART 3 rebuilds a unique index; it fails
-- closed if duplicates exist. (Today they do not — the index is partial
-- on active rows and the duplicates are all pending — but the sweep
-- first keeps the two steps independent.)
--
-- Paired: wip-20261007_duplicate_plate_handling_verification.sql

-- ══════════════════════════════════════════════════════════════════
-- PART 1 — request_my_vehicle refuses a duplicate instead of queuing one
-- ══════════════════════════════════════════════════════════════════
--
-- Reproduced from 20260828_request_my_vehicle_stamp_company.sql with
-- ONE block added before the INSERT. Header, signature, RETURNS BIGINT,
-- SECURITY DEFINER and search_path reproduced exactly.
--
-- 🔴 RAISE, not a return value. Every other refusal in this function
-- raises, and the resident page matches on error.message. A structured
-- return would need a new client branch and would make this the only
-- resident RPC that reports failure two ways.
--
-- Two distinct messages, because the resident's next action differs:
--   vehicle_already_registered — it is already approved and parked
--     legally. There is nothing to do.
--   vehicle_already_pending — the office has it and has not decided.
--     Submitting again does not speed it up; it is what created this
--     mess.
CREATE OR REPLACE FUNCTION public.request_my_vehicle(
  p_plate TEXT,
  p_state TEXT,
  p_make  TEXT,
  p_model TEXT,
  p_year  INTEGER,
  p_color TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_email            TEXT;
  v_role             TEXT;
  v_property         TEXT;
  v_unit             TEXT;
  v_company          TEXT;
  v_normalized_plate TEXT;
  v_vehicle_id       BIGINT;
  v_existing         public.vehicles%ROWTYPE;
BEGIN
  v_email := auth.jwt() ->> 'email';

  IF NOT public.get_my_effective_active() THEN
    RAISE EXCEPTION 'account_deactivated'
      USING HINT = 'Your access has been deactivated. Contact your property manager.';
  END IF;

  SELECT role INTO v_role
    FROM public.user_roles
    WHERE lower(email) = lower(v_email)
    LIMIT 1;
  IF v_role IS DISTINCT FROM 'resident' THEN
    RAISE EXCEPTION 'caller is not a resident'
      USING HINT = 'This RPC is for resident-self vehicle requests only.';
  END IF;

  SELECT property, unit, company INTO v_property, v_unit, v_company
    FROM public.residents
    WHERE lower(email) = lower(v_email)
    LIMIT 1;
  IF v_property IS NULL OR v_unit IS NULL THEN
    RAISE EXCEPTION 'no residents row for caller';
  END IF;

  v_normalized_plate := upper(regexp_replace(COALESCE(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));
  IF length(v_normalized_plate) = 0 THEN
    RAISE EXCEPTION 'plate required'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── 🔴 2026-10-07 — DUPLICATE GATE ────────────────────────────────
  -- Scoped to the PROPERTY, matching vehicles_plate_norm_uniq, because
  -- that index is what will reject this row later. Checking only the
  -- caller's own rows would still queue a submission that can never be
  -- approved.
  --
  -- Active first: that is the terminal state and the more reassuring
  -- message.
  SELECT * INTO v_existing
    FROM public.vehicles v
   WHERE lower(trim(v.property)) = lower(trim(v_property))
     AND public.normalize_plate(v.plate) = v_normalized_plate
     AND v.is_active = TRUE
     AND v.status = 'active'
   LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    -- 🔴 The HINT says nothing about WHOSE vehicle it is. If the plate
    -- belongs to another household, telling this resident the unit and
    -- the name would disclose a neighbour's registration to anyone
    -- willing to type plates. The manager's copy carries that detail
    -- because a manager is already entitled to the whole property.
    RAISE EXCEPTION 'vehicle_already_registered'
      USING HINT = 'This vehicle is already registered and approved at your property. There is nothing more to do.';
  END IF;

  -- Pending second, and scoped to THIS resident. A pending row under a
  -- different resident is a dispute for the office, not something to
  -- tell a resident about — it falls through to the INSERT and the
  -- manager resolves it, exactly as before.
  SELECT * INTO v_existing
    FROM public.vehicles v
   WHERE lower(trim(v.property)) = lower(trim(v_property))
     AND public.normalize_plate(v.plate) = v_normalized_plate
     AND v.status = 'pending'
     AND lower(trim(v.resident_email)) = lower(trim(v_email))
   LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    RAISE EXCEPTION 'vehicle_already_pending'
      USING HINT = 'This vehicle is already waiting for approval by the property office. Submitting it again will not speed it up.';
  END IF;

  INSERT INTO public.vehicles (
    plate, state, make, model, year, color,
    unit, property, resident_email,
    company,
    is_active, status
  ) VALUES (
    v_normalized_plate,
    p_state, p_make, p_model, p_year, p_color,
    v_unit, v_property, lower(v_email),
    v_company,
    FALSE,
    'pending'
  )
  RETURNING id INTO v_vehicle_id;

  RETURN v_vehicle_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.request_my_vehicle(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.request_my_vehicle(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.request_my_vehicle(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════
-- PART 2 — approve_vehicle returns plate_already_active
-- ══════════════════════════════════════════════════════════════════
--
-- Reproduced from 20260626_approve_vehicle_rpc.sql. Two additions, both
-- about the same collision:
--
--   (a) a PRE-CHECK before the UPDATE, so the normal case produces a
--       structured answer with the detail the manager needs; and
--   (b) an EXCEPTION handler on the UPDATE as the backstop, because two
--       managers approving two duplicate rows at once would still race
--       past any pre-check. A pre-check alone would leave the original
--       hang reachable, just rarer — and a rare hang is worse than a
--       common one, because nobody can reproduce it.
--
-- 🔴 The `~~*` scope comparisons are preserved VERBATIM. They are ILIKE
-- and they belong to the open email/property ILIKE arc (Tier 3). Fixing
-- them here would smuggle a security change into a bug fix and would
-- not be covered by this file's verification.
CREATE OR REPLACE FUNCTION public.approve_vehicle(
  p_vehicle_id   BIGINT,
  p_manager_note TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_role        TEXT;
  v_caller_company     TEXT;
  v_caller_properties  TEXT[];
  v_vehicle            public.vehicles%ROWTYPE;
  v_in_scope           BOOLEAN := FALSE;
  v_updated            public.vehicles%ROWTYPE;
  v_clash              public.vehicles%ROWTYPE;
BEGIN
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  IF v_caller_role NOT IN ('manager', 'company_admin') THEN
    RETURN jsonb_build_object(
      'error', 'role_not_authorized',
      'hint',  'approve_vehicle requires manager or company_admin role; got ' || v_caller_role
    );
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id;
  IF v_vehicle.id IS NULL THEN
    RETURN jsonb_build_object('error', 'vehicle_not_found');
  END IF;

  IF v_caller_role = 'manager' THEN
    v_caller_properties := get_my_properties();
    IF v_caller_properties IS NULL OR array_length(v_caller_properties, 1) IS NULL THEN
      RETURN jsonb_build_object('error', 'no_properties_in_scope');
    END IF;
    v_in_scope := v_vehicle.property ~~* ANY(v_caller_properties);
  ELSIF v_caller_role = 'company_admin' THEN
    v_caller_company := get_my_company();
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM public.properties p
       WHERE p.name ~~* v_vehicle.property
         AND p.company ~~* v_caller_company
    ) INTO v_in_scope;
  END IF;

  IF NOT v_in_scope THEN
    RETURN jsonb_build_object(
      'error', 'vehicle_out_of_scope',
      'hint',  'The vehicle belongs to a property outside your role''s scope.'
    );
  END IF;

  IF v_vehicle.status = 'active' AND v_vehicle.is_active = TRUE THEN
    RETURN jsonb_build_object(
      'ok',      TRUE,
      'action',  'noop_already_active',
      'vehicle', to_jsonb(v_vehicle)
    );
  END IF;

  -- ── 🔴 2026-10-07 (a) — DUPLICATE PRE-CHECK ──────────────────────
  -- Same predicate as vehicles_plate_norm_uniq: normalized plate, same
  -- property, active only.
  --
  -- The clash row is in this manager's scope by construction — it is at
  -- the same property as the vehicle whose scope was just verified — so
  -- returning its unit and resident discloses nothing the manager
  -- cannot already read.
  SELECT * INTO v_clash
    FROM public.vehicles v
   WHERE lower(trim(v.property)) = lower(trim(v_vehicle.property))
     AND public.normalize_plate(v.plate) = public.normalize_plate(v_vehicle.plate)
     AND v.is_active = TRUE
     AND v.status = 'active'
     AND v.id <> p_vehicle_id
   LIMIT 1;
  IF v_clash.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'error',                   'plate_already_active',
      -- same_resident drives which of the two manager messages the UI
      -- shows: a duplicate to clear, or a record to deactivate first.
      'same_resident',           lower(trim(COALESCE(v_clash.resident_email, ''))) = lower(trim(COALESCE(v_vehicle.resident_email, ''))),
      'existing_vehicle_id',     v_clash.id,
      'existing_unit',           v_clash.unit,
      'existing_resident_email', v_clash.resident_email,
      'plate',                   v_clash.plate,
      'hint',                    format('Plate %s is already active at %s, unit %s.', v_clash.plate, v_clash.property, COALESCE(v_clash.unit, '?'))
    );
  END IF;

  -- ── THE APPROVAL UPDATE ─────────────────────────────────────────
  -- (b) The backstop. Two managers approving two duplicate pending rows
  -- in the same instant both pass the pre-check; the index refuses the
  -- second. Without this handler that path is the original 23505 hang.
  BEGIN
    UPDATE public.vehicles
       SET is_active     = TRUE,
           status        = 'active',
           resident_read = TRUE,
           manager_note  = p_manager_note
     WHERE id = p_vehicle_id
    RETURNING * INTO v_updated;
  EXCEPTION WHEN unique_violation THEN
    -- Re-read the winner so the message names a real row rather than
    -- echoing the constraint.
    SELECT * INTO v_clash
      FROM public.vehicles v
     WHERE lower(trim(v.property)) = lower(trim(v_vehicle.property))
       AND public.normalize_plate(v.plate) = public.normalize_plate(v_vehicle.plate)
       AND v.is_active = TRUE
       AND v.status = 'active'
       AND v.id <> p_vehicle_id
     LIMIT 1;
    RETURN jsonb_build_object(
      'error',                   'plate_already_active',
      'raced',                   TRUE,
      'same_resident',           lower(trim(COALESCE(v_clash.resident_email, ''))) = lower(trim(COALESCE(v_vehicle.resident_email, ''))),
      'existing_vehicle_id',     v_clash.id,
      'existing_unit',           v_clash.unit,
      'existing_resident_email', v_clash.resident_email,
      'plate',                   COALESCE(v_clash.plate, v_vehicle.plate),
      'hint',                    'Another approval for this plate completed first.'
    );
  END;

  RETURN jsonb_build_object(
    'ok',      TRUE,
    'action',  'approved',
    'vehicle', to_jsonb(v_updated)
  );
END;
$func$;

REVOKE EXECUTE ON FUNCTION public.approve_vehicle(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_vehicle(BIGINT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.approve_vehicle(BIGINT, TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════
-- PART 3 — normalize_plate joins the other four normalizers
-- ══════════════════════════════════════════════════════════════════
--
-- There are five plate normalizers in this system. Four strip every
-- non-alphanumeric character:
--   • the client            app/lib/plate.ts normalizePlate  [^A-Z0-9]
--   • pm_plate_lookup       [^A-Za-z0-9] on BOTH sides
--   • dnt_plate_normalize   trigger on do_not_tow_plates
--   • vehicle_removal_plate_normalize  trigger on vehicle_removals
-- One strips whitespace only, and it is the one backing the vehicles
-- unique index:
--   • normalize_plate()     \s  ← the outlier
--
-- 🔴 WHY THIS IS THE COMPLETING MOVE, NOT A PARTIAL ONE.
-- 20260909_tow_log_vehicle_removals.sql:127 fences this: "Any future
-- sweep that consolidates plate normalizers must update the client
-- normalizePlate, pm_plate_lookup, the server normalize_plate, AND this
-- trigger — together... Picking one form and applying it in one place
-- breaks the linked_vehicle_id silent." That warning is about adopting
-- the WHITESPACE-ONLY form somewhere, or changing one of the four
-- aggressive ones. Here the four aggressive normalizers stay exactly as
-- they are and the lone outlier is brought to meet them, so after this
-- all five agree and no coordination debt remains.
--
-- The soft-link gets STRICTLY BETTER. vehicle_removals compares an
-- already-alphanumeric input against normalize_plate(v.plate); today a
-- vehicle stored as 'ABC-123' fails to match an input of 'ABC123' and
-- the resident sitting right there does not resolve. After this they do.
--
-- WHAT WAS WRONG. 'ABC-123' and 'ABC123' are ONE plate to the client,
-- to the enforcement lookup, and to a human reading a bumper — and TWO
-- plates to the unique index. So the index would permit both as active
-- at one property, which is precisely the ambiguous driver-plate lookup
-- the index exists to prevent (app/lib/plate.ts:12-15).
--
-- LATENT, NOT LIVE: 0 of 815 vehicle rows normalize differently under
-- the two rules today, because every write path already normalizes
-- aggressively before storing. The first plate typed with a hyphen
-- would have been the first failure. The pre-flight below re-measures
-- rather than trusting that.
--
-- 🔴 THE REINDEX IS MANDATORY. CREATE OR REPLACE on an IMMUTABLE
-- function used in an expression index does NOT recompute the stored
-- keys. Postgres keeps the OLD values while queries compute NEW ones:
-- uniqueness stops being enforced on the real expression and index
-- scans silently miss rows. Replacing the function without rebuilding
-- every dependent index leaves the database quietly wrong.

-- ── 3a. Pre-flight — would the new rule create a duplicate? ────────
-- Fail BEFORE touching the function. A failed REINDEX afterwards would
-- leave a replaced function and a broken index.
DO $$
DECLARE
  v_dupes INT;
  v_detail TEXT;
BEGIN
  SELECT count(*), string_agg(DISTINCT detail, ' | ')
    INTO v_dupes, v_detail
  FROM (
    SELECT format('%s @ %s (%s rows)', k, property, n) AS detail
    FROM (
      SELECT lower(trim(property)) AS property,
             upper(regexp_replace(COALESCE(plate, ''), '[^A-Za-z0-9]', '', 'g')) AS k,
             count(*) AS n
        FROM public.vehicles
       WHERE is_active = TRUE
       GROUP BY 1, 2
      HAVING count(*) > 1
    ) d
  ) x;
  IF COALESCE(v_dupes, 0) > 0 THEN
    RAISE EXCEPTION
      'PRE-FLIGHT FAILED: % active plate group(s) collide under the aggressive rule but not under the whitespace-only rule. Resolve these before harmonizing, or the REINDEX in 3c will fail and leave the index broken: %',
      v_dupes, v_detail;
  END IF;
  RAISE NOTICE 'pre-flight: no new active-plate collisions under the aggressive rule';
END $$;

-- ── 3b. The function ──────────────────────────────────────────────
-- Stays IMMUTABLE and LANGUAGE sql. Only the expression changes:
-- '\s' -> '[^A-Za-z0-9]'. Character class written out rather than using
-- \W, which would keep underscores.
CREATE OR REPLACE FUNCTION public.normalize_plate(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

COMMENT ON FUNCTION public.normalize_plate(text) IS
  'Canonical plate form: uppercase, alphanumeric only. 2026-10-07 — was whitespace-only, which made it the lone outlier among five normalizers (client normalizePlate, pm_plate_lookup, dnt_plate_normalize, vehicle_removal_plate_normalize all strip [^A-Za-z0-9]). As the whitespace-only form it let ABC-123 and ABC123 both be active at one property, which is the ambiguous driver-plate lookup vehicles_plate_norm_uniq exists to prevent. 🔴 BACKS EXPRESSION INDEXES — any future change to this body MUST REINDEX every dependent index in the same migration; CREATE OR REPLACE does not recompute stored keys.';

-- ── 3c. Rebuild every dependent index ─────────────────────────────
-- Discovered from the catalog rather than hardcoded: the index set is
-- what the database actually has, not what this repo remembers. It
-- currently covers vehicles, do_not_tow_plates and vehicle_removals.
DO $$
DECLARE
  r RECORD;
  v_count INT := 0;
BEGIN
  FOR r IN
    SELECT schemaname, indexname
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexdef ILIKE '%normalize_plate%'
     ORDER BY indexname
  LOOP
    EXECUTE format('REINDEX INDEX %I.%I', r.schemaname, r.indexname);
    v_count := v_count + 1;
    RAISE NOTICE 'reindexed %.%', r.schemaname, r.indexname;
  END LOOP;

  -- Absence must not be the success condition. Finding zero dependent
  -- indexes would mean the discovery query is wrong, not that there is
  -- nothing to do — and it would pass silently.
  IF v_count = 0 THEN
    RAISE EXCEPTION 'REINDEX step found NO indexes referencing normalize_plate. vehicles_plate_norm_uniq is known to use it, so the discovery query is broken and stale keys would survive. Refusing to report success.';
  END IF;
  RAISE NOTICE 'reindexed % dependent index(es)', v_count;
END $$;


-- ══════════════════════════════════════════════════════════════════
-- PART 4 — deactivate_vehicle: pending is not "already deactivated"
-- ══════════════════════════════════════════════════════════════════
--
-- Reproduced from the 2026-10-06 applied version (migrations/
-- 20261006_resident_vehicle_removal.sql PART 2), which is itself the
-- live pg_get_functiondef with resident_removed added. ONE condition
-- changes; the header, the p_note DEFAULT, volatility, search_path and
-- the v_system_codes array are untouched.
--
-- Diff against the live definition before applying: the only expected
-- change is the IF at step 6 plus its comment.
CREATE OR REPLACE FUNCTION public.deactivate_vehicle(p_vehicle_id bigint, p_reason text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller_email       TEXT;
  v_caller_role        TEXT;
  v_caller_properties  TEXT[];
  v_caller_company     TEXT;
  v_vehicle            public.vehicles%ROWTYPE;
  v_in_scope           BOOLEAN;
  v_updated            public.vehicles%ROWTYPE;
  -- 🔴 2026-10-06 — 'resident_removed' added. Stamped only by
  -- deactivate_my_vehicle. A manager must not be able to claim the
  -- resident removed their own car, so it is system-only here for the
  -- same reason the three cascade codes are.
  v_system_codes       TEXT[] := ARRAY['cascade_resident_deactivated','owner_trim','admin_cascade','resident_removed'];
BEGIN
  -- ── 1. Auth ────────────────────────────────────────────────────────
  v_caller_email := auth.email();
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- ── 2. Role gate ───────────────────────────────────────────────────
  SELECT role INTO v_caller_role
    FROM public.user_roles
   WHERE lower(trim(email)) = lower(trim(v_caller_email))
   ORDER BY id DESC LIMIT 1;
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object(
      'error', 'no_role',
      'hint',  'No role row for the calling email.'
    );
  END IF;
  IF v_caller_role NOT IN ('manager', 'company_admin') THEN
    RETURN jsonb_build_object(
      'error', 'role_not_permitted',
      'hint',  'Only managers or company_admins may deactivate vehicles.'
    );
  END IF;
  IF v_caller_role = 'manager' THEN
    IF NOT COALESCE((
      SELECT can_approve_vehicles FROM public.user_roles
        WHERE lower(trim(email)) = lower(trim(v_caller_email))
        ORDER BY id DESC LIMIT 1
    ), false) THEN
      RETURN jsonb_build_object(
        'error', 'authority_not_permitted',
        'hint',  'This manager account lacks vehicle-approval authority.'
      );
    END IF;
  END IF;

  -- ── 3. Load target vehicle ─────────────────────────────────────
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id;
  IF v_vehicle.id IS NULL THEN
    RETURN jsonb_build_object('error', 'vehicle_not_found');
  END IF;

  -- ── 3b. Property presence gate (Mateo Aug 9 Item 2, Layer 1) ───
  -- Distinct error class BEFORE the scope check. A NULL-property
  -- vehicle cannot have its scope verified in either branch; treat
  -- it as a data defect that needs manual attention, NOT as an
  -- out-of-scope refusal.
  IF v_vehicle.property IS NULL OR length(trim(v_vehicle.property)) = 0 THEN
    RETURN jsonb_build_object(
      'error', 'vehicle_property_missing',
      'hint',  'Vehicle has no property — cannot verify scope. Data-fix required.'
    );
  END IF;

  -- ── 4. Scope gate — lower(trim(...)) (STRICTER than approve_vehicle) ─
  -- Deliberate divergence from approve_vehicle. See header §2.
  IF v_caller_role = 'manager' THEN
    v_caller_properties := get_my_properties();
    IF v_caller_properties IS NULL OR array_length(v_caller_properties, 1) IS NULL THEN
      RETURN jsonb_build_object('error', 'no_properties_in_scope');
    END IF;
    v_in_scope := lower(trim(v_vehicle.property)) IN (
      SELECT lower(trim(p)) FROM unnest(v_caller_properties) AS p
    );
  ELSIF v_caller_role = 'company_admin' THEN
    v_caller_company := get_my_company();
    IF v_caller_company IS NULL THEN
      RETURN jsonb_build_object('error', 'no_company_assigned');
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM public.properties p
       WHERE lower(trim(p.name))    = lower(trim(v_vehicle.property))
         AND lower(trim(p.company)) = lower(trim(v_caller_company))
    ) INTO v_in_scope;
  END IF;

  -- ── 4b. Scope decision (Mateo Aug 9 Item 2, Layer 2) ─────────────
  -- COALESCE the flag so any future column added to the scope check
  -- that could return NULL will fail CLOSED rather than open. Belt-
  -- and-suspenders alongside the Layer-1 property presence gate.
  IF NOT COALESCE(v_in_scope, false) THEN
    RETURN jsonb_build_object(
      'error', 'vehicle_out_of_scope',
      'hint',  'The vehicle belongs to a property outside your role''s scope.'
    );
  END IF;

  -- ── 5. Reason gate (presence + note-required + system-code reject) ──
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF trim(p_reason) = ANY(v_system_codes) THEN
    RETURN jsonb_build_object(
      'error', 'system_reason_not_permitted',
      'hint',  format('%L is a system-only cascade code; managers must not select it.', p_reason)
    );
  END IF;
  IF trim(p_reason) = 'other' THEN
    IF p_note IS NULL OR length(trim(p_note)) = 0 THEN
      RETURN jsonb_build_object('error', 'note_required_when_reason_other');
    END IF;
  END IF;

  -- ── 6. Already-deactivated shortcut ───────────────────────────────
  --
  -- 🔴 2026-10-07 — replaced `is_active = false` with an ALLOWLIST of
  -- the statuses a deactivation may act on.
  --
  -- THE BUG: is_active=false is TRUE FOR EVERY PENDING ROW (39 live).
  -- So this shortcut treated "waiting for approval" as "already
  -- deactivated", returned ok:true without stamping anything, and made
  -- the duplicate-clearing action this arc adds a silent no-op.
  --
  -- 🔴 WHY NOT simply `status = 'deactivated'`, which was the first
  -- draft: that would let a manager deactivate a DECLINED row (55
  -- live), which is destructive rather than merely odd. The resident
  -- portal fetches `is_active = true OR status = 'declined'`, so a
  -- declined vehicle is visible to the resident along with the
  -- manager's note; rewriting its status to 'deactivated' makes that
  -- record VANISH from their view and puts it beyond
  -- mark_my_vehicle_declined_read. A declined vehicle was also never in
  -- the authorized set, so deactivating it is not a meaningful action.
  --
  -- So: proceed only for rows that are IN the authorized set or
  -- awaiting entry to it — active, pending, under_review. Everything
  -- else short-circuits, including any status added later, because an
  -- allowlist fails closed where a denylist fails open.
  --
  -- The action string stays 'already_deactivated' so no existing caller
  -- changes, even though for a declined row the wording is loose.
  -- Tightening that vocabulary is a separate change with its own
  -- callers to audit.
  --
  -- Live effect: 694 active + 39 pending + 2 under_review proceed;
  -- 55 declined + 6 deactivated no-op. The 19 status='active' /
  -- is_active=false rows the CRM calls "orphaned plates" proceed, which
  -- is right — a manager should be able to clear them.
  IF v_vehicle.status IS NULL OR v_vehicle.status NOT IN ('active', 'pending', 'under_review') THEN
    RETURN jsonb_build_object(
      'ok',     true,
      'action', 'already_deactivated',
      'vehicle', to_jsonb(v_vehicle)
    );
  END IF;

  -- ── 7. THE DEACTIVATION UPDATE ──────────────────────────────────
  UPDATE public.vehicles
     SET is_active           = false,
         status              = 'deactivated',
         deactivation_reason = trim(p_reason),
         deactivation_note   = NULLIF(trim(COALESCE(p_note, '')), ''),
         deactivated_by      = v_caller_email,
         deactivated_at      = now()
   WHERE id = p_vehicle_id
  RETURNING * INTO v_updated;

  RETURN jsonb_build_object(
    'ok',      true,
    'action',  'deactivated',
    'vehicle', to_jsonb(v_updated)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.deactivate_vehicle(BIGINT, TEXT, TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- 20260910_record_vehicle_removal_plate_normalize_fix.sql
--
-- 🔴 Tow Log arc — correctness fix: record_vehicle_removal used
--    normalize_plate() (WHITESPACE-ONLY) in four places where the
--    AGGRESSIVE alphanumeric strip belongs.
--
-- ── EMPIRICAL TRIGGER (Jose, Sept 9 2026 runbook) ───────────────────
-- A punctuation-only plate ('---') cleared the RPC's validation and
-- detonated inside the table trigger:
--
--   ERROR:  22004: vehicle_removals.plate cannot be empty after
--           normalization (only alphanumeric chars kept)
--   CONTEXT: PL/pgSQL function vehicle_removal_plate_normalize() line 7
--            SQL statement "INSERT INTO public.vehicle_removals (…)"
--            PL/pgSQL function record_vehicle_removal(…) line 116
--
-- A property manager on a phone at 11pm got a raw SQLSTATE with the
-- whole INSERT statement in the message text, where a clean
-- {"error":"plate_required"} belonged.
-- (feedback_raw_error_never_reaches_user)
--
-- ── ROOT CAUSE — THE THREE-NORMALIZER GAP, BITING IN THE MIDDLE ─────
-- Both halves were individually correct:
--   · normalize_plate()  strips WHITESPACE ONLY, deliberately — dashes
--     must survive so genuinely-distinct plates don't merge, and it
--     backs vehicles_plate_norm_uniq as an IMMUTABLE index expression.
--     Scope guard locked 2026-07-03.
--   · vehicle_removal_plate_normalize() (the table trigger) uses the
--     AGGRESSIVE alphanumeric strip, mirroring dnt_plate_normalize.
-- '---' has length 3 under the first and length 0 under the second.
-- Validation passed; the write raised.
--
-- ── FOUR USES, ONE SUBSTITUTION ─────────────────────────────────────
-- The same wrong-normalizer substitution appeared four times, with
-- escalating quietness:
--
--   line 137-140  validation  → punctuation-only plate escapes, raw
--                               22004 reaches the user (LOUD)
--   line 209      soft-link   → 'AB-123' never matches stored 'AB123',
--                               linked_vehicle_id silently NULL (QUIET)
--   line 230      INSERT      → raw p_plate handed to the table; the
--                               trigger was doing the normalization
--   line 263      audit       → audit row records 'AB-123' while the
--                               vehicle_removals row holds 'AB123' —
--                               the log disagrees with itself, on a
--                               table whose entire purpose is being a
--                               log of record
--
-- ── THE SHAPE — normalize ONCE, use the local everywhere ────────────
-- Patching four sites individually is how a fifth appears. One local
-- computed at the top, four uses, internally consistent by
-- construction. Nothing downstream of the DECLARE can drift from
-- anything else inside this function.
--
-- Canonical validate-then-normalize shape this follows:
--   migrations/20260723_ap_cascade_check_authorized_plate.sql:248-256
-- (a diff target, not a paragraph — cite it if you are changing this)
--
-- ── WHY THIS IS *NOT* THE FENCED COORDINATED ARC ────────────────────
-- The Commit 3 header (20260909_tow_log_vehicle_removals.sql:127-135)
-- fences CONSOLIDATING normalizers across the client normalizePlate,
-- pm_plate_lookup, and the server normalize_plate(). This touches none
-- of them.
--
-- 🔴 The v.plate SIDE OF THE SOFT-LINK IS UNCHANGED — still
-- normalize_plate(v.plate). That expression must keep matching
-- vehicles_plate_norm_uniq or the index stops being usable for the
-- lookup. Only the INCOMING PARAMETER's normalization changes, and
-- only inside this one function.
--
-- Asymmetric on purpose: the stored side keeps its contract, the input
-- side is normalized to meet it.
--
-- ── 🔴 prosrc DISCIPLINE — READ BEFORE EDITING THIS BODY ────────────
-- The paired verification asserts pg_proc.prosrc contains the literal
-- normalize_plate(p_plate) ZERO times. prosrc stores the body VERBATIM
-- as submitted — INCLUDING COMMENTS. A body comment that merely
-- MENTIONS the wrong form in call syntax fails the gate.
--
-- Precedent: Sept 4 — a section-header comment inside
-- driver_create_violation_with_snapshot tripped a prosrc body check
-- looking for jsonb_populate_record.
--
-- So: inside the function body, refer to it in PROSE ("the
-- whitespace-only server normalizer"), never in call syntax. The
-- full explanation lives in COMMENT ON FUNCTION (PART 2), which is
-- stored in pg_description and never appears in prosrc.
--
-- ── ⚠ CREATE OR REPLACE DROPS PARAMETER DEFAULTS ────────────────────
-- All NINE defaults are re-typed verbatim below: p_plate_state,
-- p_make, p_model, p_color, p_reason_notes, p_space_id,
-- p_authorized_by_name, p_removal_type, p_notes. A silently-lost
-- default on p_removal_type would turn every call that omits it into
-- an error. Verification VS3 asserts pronargdefaults = 9 AND that
-- p_removal_type still renders its 'tow' default.
-- (feedback_create_or_replace_drops_defaults)
--
-- ── SIGNATURE: UNCHANGED ────────────────────────────────────────────
-- CREATE OR REPLACE on the SAME 15-arg signature. No DROP, no arity
-- change, therefore no overload risk and no change to the structural
-- verification's signature string. The 14-arg form was dropped by
-- 20260909_tow_log_vehicle_removals_notes_column.sql and stays gone
-- (asserted again as VS2 — a regression lock, not a new claim).
--
-- ── BLAST RADIUS: ZERO CLIENTS ──────────────────────────────────────
-- No TypeScript calls record_vehicle_removal today — Commit 5
-- (tow-log-writes.ts + the mobile screen) has not landed. This ships
-- ahead of its only caller, so Commit 5 is written against the fixed
-- contract instead of inheriting a normalization assumption.
--
-- ── RESIDUAL, NOT FIXED HERE ────────────────────────────────────────
-- If a vehicles row was written by a path that skipped the client's
-- normalizePlate, it can hold 'AB-123' verbatim. The whitespace-only
-- normalizer leaves that as 'AB-123', which will not equal the
-- aggressively-stripped 'AB123' — so the soft link still misses.
--
-- That is landmine #3 from the Sept 7 preflight: vehicles is the one
-- plate-bearing table with NO normalizer trigger (confirmed — its only
-- trigger is vehicles_inactive_clear_space_designation). The durable
-- fix is a BEFORE INSERT OR UPDATE OF plate trigger on vehicles,
-- already filed alongside the company-derivation trigger. Noted above
-- the soft-link block in the body so the next reader knows the miss is
-- UPSTREAM of this function.
--
-- ── APPLY DISCIPLINE (CRITICAL) ─────────────────────────────────────
-- Paste the ENTIRE BEGIN/COMMIT block below into SQL Editor as ONE
-- block, then click Run ONCE. Do NOT click Run on individual
-- statements — that breaks BEGIN/COMMIT atomicity and can produce
-- a partial-apply state.
--
-- Report-first → eyeball → apply (Jose) → run the paired verification.
-- Paired file: 20260910_record_vehicle_removal_plate_normalize_fix_verification.sql
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- PART 1 — CREATE OR REPLACE record_vehicle_removal (15-arg, unchanged
--          signature; body normalizes the plate parameter once)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.record_vehicle_removal(
  p_property             TEXT,
  p_plate                TEXT,
  p_reason_code          TEXT,
  p_towed_at             TIMESTAMPTZ,
  p_authorized_by_email  TEXT,
  p_tow_operator_id      BIGINT,
  p_plate_state          TEXT        DEFAULT NULL,
  p_make                 TEXT        DEFAULT NULL,
  p_model                TEXT        DEFAULT NULL,
  p_color                TEXT        DEFAULT NULL,
  p_reason_notes         TEXT        DEFAULT NULL,
  p_space_id             BIGINT      DEFAULT NULL,
  p_authorized_by_name   TEXT        DEFAULT NULL,
  p_removal_type         TEXT        DEFAULT 'tow',
  p_notes                TEXT        DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_caller_email       TEXT;
  v_caller_role        TEXT;
  v_company            TEXT;
  v_property_id        BIGINT;
  v_operator           tow_operators%ROWTYPE;
  v_linked_vehicle_id  BIGINT;
  v_new_id             BIGINT;
  v_plate_norm         TEXT;
BEGIN
  -- ── Auth ────────────────────────────────────────────────────────
  v_caller_email := auth.jwt() ->> 'email';
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- ── Role ────────────────────────────────────────────────────────
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;
  IF v_caller_role NOT IN ('manager', 'company_admin', 'admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- ── Tier (super-admin bypass FIRST) ─────────────────────────────
  IF v_caller_role <> 'admin' AND NOT public.my_tier_pm_capable() THEN
    RAISE EXCEPTION 'tier_not_permitted'
      USING HINT = 'Vehicle-removal recording is a property-management feature. Your subscription tier does not include it.',
            ERRCODE = 'insufficient_privilege';
  END IF;

  -- ── Plate normalization — ONCE, here, for every downstream use ──
  -- Same character set the vehicle_removals BEFORE-write trigger uses.
  -- Validation MUST track that trigger, not the whitespace-only server
  -- normalizer: a punctuation-only plate is non-empty under the latter
  -- and empty under the former, which is exactly the gap that let a
  -- raw SQLSTATE reach a manager on Sept 9. See COMMENT ON FUNCTION
  -- below for the full contract.
  v_plate_norm := upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));

  -- ── Validation ─────────────────────────────────────────────────
  IF p_property IS NULL OR length(trim(p_property)) = 0 THEN
    RETURN jsonb_build_object('error', 'property_required');
  END IF;
  IF length(v_plate_norm) = 0 THEN
    RETURN jsonb_build_object('error', 'plate_required');
  END IF;
  IF p_reason_code IS NULL OR length(trim(p_reason_code)) = 0 THEN
    RETURN jsonb_build_object('error', 'reason_code_required');
  END IF;
  IF p_towed_at IS NULL THEN
    RETURN jsonb_build_object('error', 'towed_at_required');
  END IF;
  IF p_towed_at > now() + interval '5 minutes' THEN
    RETURN jsonb_build_object('error', 'towed_at_future');
  END IF;
  IF p_authorized_by_email IS NULL OR length(trim(p_authorized_by_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'authorized_by_email_required');
  END IF;
  IF p_tow_operator_id IS NULL THEN
    RETURN jsonb_build_object('error', 'tow_operator_id_required');
  END IF;
  IF p_removal_type NOT IN ('tow', 'boot', 'relocation') THEN
    RETURN jsonb_build_object('error', 'invalid_removal_type');
  END IF;

  -- ── Company + property scope + property_id resolution ──────────
  IF v_caller_role = 'admin' THEN
    SELECT p.id, p.company
      INTO v_property_id, v_company
      FROM public.properties p
     WHERE lower(trim(p.name)) = lower(trim(p_property));
    IF v_property_id IS NULL THEN
      RETURN jsonb_build_object('error', 'property_not_found');
    END IF;
  ELSE
    v_company := get_my_company();
    IF v_company IS NULL OR length(trim(v_company)) = 0 THEN
      RETURN jsonb_build_object('error', 'no_company_context');
    END IF;

    IF v_caller_role = 'manager' AND NOT EXISTS (
      SELECT 1 FROM unnest(get_my_properties()) x
       WHERE lower(trim(x)) = lower(trim(p_property))
    ) THEN
      RETURN jsonb_build_object('error', 'property_not_authorized_for_manager');
    END IF;

    SELECT p.id INTO v_property_id
      FROM public.properties p
     WHERE lower(trim(p.name))    = lower(trim(p_property))
       AND lower(trim(p.company)) = lower(trim(v_company));
    IF v_property_id IS NULL THEN
      RETURN jsonb_build_object('error', 'property_not_found');
    END IF;
  END IF;

  -- ── Load tow_operator + verify active + within company ─────────
  SELECT * INTO v_operator
    FROM public.tow_operators
   WHERE id = p_tow_operator_id;
  IF v_operator.id IS NULL THEN
    RETURN jsonb_build_object('error', 'tow_operator_not_found');
  END IF;
  IF v_operator.is_active IS NOT TRUE THEN
    RETURN jsonb_build_object('error', 'tow_operator_inactive');
  END IF;
  IF v_caller_role <> 'admin'
     AND lower(trim(v_operator.company)) <> lower(trim(v_company)) THEN
    RETURN jsonb_build_object('error', 'tow_operator_out_of_scope');
  END IF;

  -- ── Soft-link resolution ───────────────────────────────────────
  -- 🔴 ASYMMETRIC ON PURPOSE. The v.plate side keeps the whitespace-
  -- only server normalizer so this expression stays identical to
  -- vehicles_plate_norm_uniq and the index remains usable. The input
  -- side is already aggressively normalized above, so a caller-
  -- supplied 'AB-123' now meets a stored 'AB123'. Do NOT "harmonize"
  -- the two sides — see the migration header, and the fenced
  -- consolidation note at 20260909_tow_log_vehicle_removals.sql:127.
  --
  -- RESIDUAL (upstream, not fixable here): if a vehicles row itself
  -- holds punctuation — written by some path that skipped the client
  -- normalizer — the stored side normalizes to 'AB-123' and this still
  -- misses. vehicles is the one plate table with no normalizer
  -- trigger; a BEFORE-write trigger there is the durable fix and is
  -- filed alongside the company-derivation trigger. A NULL
  -- linked_vehicle_id is a soft outcome by design, never an error.
  SELECT v.id INTO v_linked_vehicle_id
    FROM public.vehicles v
   WHERE normalize_plate(v.plate) = v_plate_norm
     AND lower(trim(v.property))  = lower(trim(p_property))
     AND v.is_active              = true
   LIMIT 1;

  -- ── Write ──────────────────────────────────────────────────────
  -- v_plate_norm, not the raw parameter. The table's BEFORE-write
  -- trigger now no-ops on every RPC write — that is intended. It stays
  -- as the FLOOR for any future non-RPC write path, not the mechanism.
  -- See COMMENT ON FUNCTION vehicle_removal_plate_normalize.
  INSERT INTO public.vehicle_removals (
    company, property, property_id, removal_type,
    plate, plate_state, make, model, color, linked_vehicle_id,
    reason_code, reason_notes, space_id,
    towed_at,
    authorized_by_email, authorized_by_name,
    tow_operator_id, operator_name, operator_phone,
    notes,
    recorded_by_email
  ) VALUES (
    trim(v_company),
    trim(p_property),
    v_property_id,
    p_removal_type,
    v_plate_norm,
    NULLIF(trim(p_plate_state), ''),
    NULLIF(trim(p_make),        ''),
    NULLIF(trim(p_model),       ''),
    NULLIF(trim(p_color),       ''),
    v_linked_vehicle_id,
    trim(p_reason_code),
    NULLIF(trim(p_reason_notes), ''),
    p_space_id,
    p_towed_at,
    lower(trim(p_authorized_by_email)),
    NULLIF(trim(p_authorized_by_name), ''),
    p_tow_operator_id,
    v_operator.name,
    v_operator.phone,
    NULLIF(trim(p_notes), ''),
    lower(v_caller_email)
  )
  RETURNING id INTO v_new_id;

  -- ── Audit ──────────────────────────────────────────────────────
  -- v_plate_norm — the SAME value written to the row above. The audit
  -- entry and the row it describes must never carry different plates
  -- on a table whose purpose is being a log of record.
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_caller_email),
    'VEHICLE_REMOVAL_RECORDED',
    'vehicle_removals',
    v_new_id::text,
    jsonb_build_object(
      'company',              v_company,
      'property',             p_property,
      'property_id',          v_property_id,
      'plate',                v_plate_norm,
      'removal_type',         p_removal_type,
      'reason_code',          p_reason_code,
      'towed_at',             p_towed_at,
      'tow_operator_id',      p_tow_operator_id,
      'tow_operator_name',    v_operator.name,
      'authorized_by_email',  lower(trim(p_authorized_by_email)),
      'authorized_by_name',   NULLIF(trim(p_authorized_by_name), ''),
      'linked_vehicle_id',    v_linked_vehicle_id,
      'notes',                NULLIF(trim(p_notes), ''),
      'recorded_by_role',     v_caller_role
    ),
    now()
  );

  RETURN jsonb_build_object('ok', true, 'id', v_new_id);
END
$func$;


-- ══════════════════════════════════════════════════════════════════════
-- PART 2 — COMMENT ON FUNCTION record_vehicle_removal
-- ══════════════════════════════════════════════════════════════════════
-- Lives in pg_description, NOT prosrc — so it can name both normalizers
-- in call syntax without tripping the prosrc gate, and it is what a
-- person reading the catalog actually sees.
COMMENT ON FUNCTION public.record_vehicle_removal(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT
) IS
'Records a vehicle removal (tow / boot / relocation). SECURITY DEFINER; manager, company_admin, admin only; PM-capable tier required (super-admin bypasses).

PLATE NORMALIZATION CONTRACT — read before changing any plate expression in this function:

The incoming p_plate is normalized ONCE at the top of the body into v_plate_norm using the AGGRESSIVE alphanumeric strip: upper(regexp_replace(coalesce(p_plate,''''), ''[^A-Za-z0-9]'', '''', ''g'')). That local is then used for ALL FOUR downstream purposes — validation, soft-link comparison, the INSERT, and the audit payload. One local, four uses, consistent by construction.

WHY AGGRESSIVE AND NOT normalize_plate(): validation must track vehicle_removal_plate_normalize() — the table''s BEFORE-write trigger — because that trigger is what actually rejects. normalize_plate() strips whitespace ONLY (deliberate: dashes must survive for vehicles_plate_norm_uniq). A punctuation-only plate such as ''---'' is length 3 under normalize_plate() and length 0 under the trigger, so before 20260910 it cleared validation and raised a raw SQLSTATE 22004 at the user. Fixed 2026-09-10.

THE SOFT-LINK IS ASYMMETRIC ON PURPOSE: the v.plate side still reads normalize_plate(v.plate) so the expression matches vehicles_plate_norm_uniq and the index stays usable; only the input side changed. Harmonizing both sides is the fenced coordinated arc (client normalizePlate + pm_plate_lookup + normalize_plate + this trigger, together, with fresh soft-link smoke) — see 20260909_tow_log_vehicle_removals.sql:127-135.

Canonical validate-then-normalize shape: 20260723_ap_cascade_check_authorized_plate.sql:248-256.

A future consolidation pass that reintroduces normalize_plate(p_plate) fails VS4 of 20260910_record_vehicle_removal_plate_normalize_fix_verification.sql.';


-- ══════════════════════════════════════════════════════════════════════
-- PART 3 — COMMENT ON FUNCTION vehicle_removal_plate_normalize
-- ══════════════════════════════════════════════════════════════════════
-- 🔴 The reason this comment exists: as of 20260910 this trigger is
-- UNREACHABLE through any production path. It looks like dead code to
-- an auditor, and dead-looking code gets dropped. A migration file
-- three weeks back is not where someone looks before dropping
-- something that appears unused — pg_description is.
COMMENT ON FUNCTION public.vehicle_removal_plate_normalize() IS
'BEFORE INSERT OR UPDATE OF plate trigger on public.vehicle_removals. Applies the aggressive alphanumeric strip and raises SQLSTATE 22004 when nothing survives. Mirrors dnt_plate_normalize.

🔴 DO NOT DROP — this is a FLOOR, not the mechanism, and as of 2026-09-10 it is deliberately unreachable in production.

record_vehicle_removal now normalizes the plate itself and inserts the already-normalized value, so this trigger no-ops on every write that can reach the table (vehicle_removals grants are SELECT-only for authenticated; the DEFINER RPC is the sole write path). Its 22004 therefore fires for NO production caller. That is the intended end state — the trigger exists to catch a FUTURE write path that skips normalization, e.g. a bulk import, a probe, or a second RPC.

CONSEQUENCE FOR VERIFICATION: any gate proving this trigger still raises must INSERT into public.vehicle_removals DIRECTLY as service_role. Routing such a gate through record_vehicle_removal will now return {"error":"plate_required"} instead, and a gate asserting 22004 through the RPC is asserting the bug, not the fix. See the Commit 3 execution verification file.';


-- ══════════════════════════════════════════════════════════════════════
-- PART 4 — Grants (re-asserted; CREATE OR REPLACE preserves the ACL,
--          this makes the file self-describing and idempotent)
-- ══════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION public.record_vehicle_removal(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_vehicle_removal(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT
) FROM anon;
GRANT  EXECUTE ON FUNCTION public.record_vehicle_removal(
  TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BIGINT,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT
) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- PART 5 — Schema audit row
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_RECORD_VEHICLE_REMOVAL_PLATE_NORMALIZE_FIX',
  'public.vehicle_removals',
  'record_vehicle_removal_plate_normalization',
  jsonb_build_object(
    'migration', '20260910_record_vehicle_removal_plate_normalize_fix',
    'arc',       'Tow Log — correctness fix: normalize the plate parameter once, use the local for all four downstream purposes',
    'depends_on', jsonb_build_array(
      'Commit 3 (8617c22) — vehicle_removals + vehicle_removal_media',
      'Commit 4 (e991c7a) — 3 DEFINER RPCs',
      '20260909_tow_log_vehicle_removals_notes_column — 15-arg signature'
    ),
    'signature_change', 'NONE — CREATE OR REPLACE on the same 15-arg signature. No DROP, no overload risk.',
    'body_delta', jsonb_build_array(
      'DECLARE gains v_plate_norm TEXT',
      'v_plate_norm computed once with the aggressive alphanumeric strip, before validation',
      'validation: length(v_plate_norm) = 0 replaces the whitespace-only length checks',
      'soft-link: input side compares against v_plate_norm; v.plate side UNCHANGED (index-matching)',
      'INSERT: v_plate_norm replaces the raw p_plate',
      'audit payload: v_plate_norm — same value as the row'
    ),
    'empirical_trigger', 'Jose runbook Sept 9 2026: punctuation-only plate cleared validation and raised SQLSTATE 22004 from vehicle_removal_plate_normalize() with the full INSERT statement in the message text.',
    'four_uses', 'validation (loud failure), soft-link (silent NULL), INSERT (raw value stored), audit payload (log disagreed with the row it described). One substitution, four sites — fixed as one local rather than four patches.',
    'asymmetry_is_deliberate', 'Soft-link keeps normalize_plate(v.plate) on the stored side so the expression still matches vehicles_plate_norm_uniq. Only the input side changed. Harmonizing both sides is the FENCED coordinated arc (20260909_tow_log_vehicle_removals.sql:127-135).',
    'trigger_now_unreachable', 'vehicle_removal_plate_normalize() no-ops on every production write after this change. Intended — floor, not mechanism. COMMENT ON FUNCTION added so an auditor reading pg_proc does not drop it as dead code. Any gate proving it still raises must INSERT directly as service_role.',
    'residual_upstream', 'vehicles has NO plate normalizer trigger (only vehicles_inactive_clear_space_designation). A vehicles row holding punctuation still misses the soft link. Landmine #3, Sept 7 preflight — durable fix is a BEFORE-write trigger on vehicles, filed with the company-derivation trigger.',
    'blast_radius', 'Zero clients — no TypeScript calls this RPC yet. Commit 5 (tow-log-writes.ts + mobile screen) is written against the fixed contract.'
  ),
  now()
);


-- ══════════════════════════════════════════════════════════════════════
-- PART 6 — PostgREST schema cache reload
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

COMMIT;

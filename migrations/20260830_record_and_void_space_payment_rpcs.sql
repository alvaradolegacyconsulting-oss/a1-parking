-- ══════════════════════════════════════════════════════════════════════
-- 20260830_record_and_void_space_payment_rpcs.sql
--
-- 🟢 Reserved-space payment tracking arc — COMMIT 3 of 4
--
-- Two DEFINER RPCs paired in this migration:
--   public.record_space_payment(BIGINT, DATE, NUMERIC, TEXT, TEXT) → BIGINT
--   public.void_space_payment(BIGINT, TEXT) → BOOLEAN
--
-- Both are the ONLY write paths into public.space_payments — the table
-- has SELECT-only grant for authenticated (Commit 2). Every INSERT and
-- UPDATE flows through here. The record RPC populates snapshot columns
-- server-side; the void RPC only touches the three void columns.
--
-- ── LOAD-BEARING RULES (unchanged from Commit 1 + Commit 2) ─────────
--
-- 1. Non-payment changes nothing. Neither RPC ever de-authorizes a
--    vehicle, updates a space status, or fires a violation. The whole
--    reserved-space arc is INERT to enforcement.
--
-- 2. recorded_by_email is UNFORGEABLE. Always resolved from
--    auth.jwt() ->> 'email', NEVER from any parameter. The table has
--    no INSERT grant precisely so this can't be bypassed.
--
-- 3. Snapshot columns are captured at INSERT time from the current
--    spaces + space_residents + residents state — never resolved by
--    lookup at read time. A resident moving out or a space being
--    relabelled must not rewrite payment history.
--
-- 4. Void UPDATEs only the three void columns (voided_at,
--    voided_by_email, void_reason). Amount, period, snapshots, method
--    and note stay verbatim. A void records that a correction
--    happened; it never rewrites what was originally claimed.
--
-- ── DIVERGENCES from existing sibling patterns — call out explicitly ─
--
-- • Company + property scoping uses lower(trim()) EQUALITY, not the
--   shipped `!~~*` / `~~*` ILIKE pattern. Same metacharacter-vector
--   rationale as Commit 2 RLS + docs/CURRENT_STATE.md. DEFINER RPCs
--   are exactly the place where the ILIKE-treats-value-as-pattern
--   vulnerability bites hardest (bypasses RLS).
--
-- • Property scoping is ENFORCED for manager + leasing_agent, NOT
--   inherited from update_space_metadata's company-only pattern.
--   update_space_metadata has a gap (manager at property A can edit
--   a space at property B in the same company); that gap is filed as
--   a separate finding and NOT re-introduced here. Recording a
--   payment on a space you're not assigned to is a scope escape and
--   this RPC refuses.
--
-- ── ROLE GATES ──────────────────────────────────────────────────────
--
-- record_space_payment:  ('manager', 'leasing_agent', 'company_admin')
--   Rationale: recording a payment is a front-desk act. The leasing
--   agent is often who takes the payment. Diverges from update_space_
--   metadata which is (manager, company_admin) only — that's a
--   configuration change, not a transaction. Header note in Commit 2:
--   granting leasing_agent SELECT on the ledger but withholding the
--   record RPC would be incoherent — you can see it but can't add
--   to it.
--
-- void_space_payment: ('manager', 'company_admin')
--   Rationale: voiding CORRECTS a financial record. Narrower than
--   recording. Leasing agents can record; they cannot void. This is
--   the standard "front-desk records, manager corrects" pattern.
--
-- ── DOUBLE-SUBMIT GUARD (record only) ───────────────────────────────
-- Reject if an unvoided row exists with the same (space_id,
-- period_month, amount, lower(recorded_by_email)) within the last 60
-- seconds. Catches double-clicked-button; doesn't block a legitimate
-- second payment (those are rarely the same amount within a minute).
-- UI disables the button on submit as the first line; this is the
-- backstop.
--
-- ── PERIOD NORMALIZATION ────────────────────────────────────────────
-- p_period_month is normalized via date_trunc('month',
-- p_period_month::timestamp)::date at RPC boundary. Friendlier than
-- raising on non-first-of-month. The CHECK on the table
-- (space_payments_period_first_of_month) is the backstop.
--
-- ── RESIDENT SNAPSHOT: NULL ON AMBIGUITY ────────────────────────────
-- Space with 1 active tie: snapshot email/name/unit. Space with 0 or
-- 2+ ties: all three fields NULL. No arbitrary precedence. Wrong
-- attribution is worse than absent — a resident who didn't pay
-- landing on a receipt is a support problem, an unknown resident is
-- a small data gap.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- record_space_payment
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.record_space_payment(
  p_space_id     BIGINT,
  p_period_month DATE,
  p_amount       NUMERIC,
  p_method       TEXT DEFAULT NULL,
  p_note         TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email             TEXT;
  v_role              TEXT;
  v_company           TEXT;
  v_properties        TEXT[];
  v_space_company     TEXT;
  v_space_property    TEXT;
  v_space_label       TEXT;
  v_normalized_period DATE;
  v_amount_scaled     NUMERIC(10,2);
  v_normalized_method TEXT;
  v_normalized_note   TEXT;
  v_tie_count         INT;
  v_resident_email    TEXT;
  v_resident_name     TEXT;
  v_resident_unit     TEXT;
  v_dup_count         INT;
  v_payment_id        BIGINT;
BEGIN
  -- ── JWT identity ──────────────────────────────────────────────────
  v_email := auth.jwt() ->> 'email';
  IF v_email IS NULL OR length(trim(v_email)) = 0 THEN
    RAISE EXCEPTION 'unauthenticated'
      USING HINT = 'JWT missing email claim.';
  END IF;

  -- ── Role + company + properties (text[]) in one round-trip ────────
  -- user_roles.property is text[], NOT text — same shape get_my_
  -- properties() reads. Never trim() a text[] value directly.
  SELECT role, company, property
    INTO v_role, v_company, v_properties
    FROM public.user_roles
   WHERE lower(email) = lower(v_email)
   LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager', 'leasing_agent', 'company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed'
      USING HINT = 'Only managers, leasing agents, and company admins can record payments.';
  END IF;

  -- ── Load target space ─────────────────────────────────────────────
  SELECT company, property, label
    INTO v_space_company, v_space_property, v_space_label
    FROM public.spaces WHERE id = p_space_id;
  IF v_space_company IS NULL THEN
    RAISE EXCEPTION 'space_not_found'
      USING ERRCODE = 'no_data_found',
            HINT   = 'p_space_id does not match any spaces row.';
  END IF;

  -- ── Company scope — lower(trim()) equality, NOT ~~* ───────────────
  IF lower(trim(v_space_company)) <> lower(trim(v_company)) THEN
    RAISE EXCEPTION 'space_not_in_company'
      USING HINT = 'The space does not belong to your company.';
  END IF;

  -- ── Property scope for manager + leasing_agent ────────────────────
  -- DEFINER RPC bypasses RLS. Enforce property scope explicitly.
  -- CA is company-wide; skip.
  IF v_role IN ('manager', 'leasing_agent') THEN
    IF v_properties IS NULL OR array_length(v_properties, 1) IS NULL THEN
      RAISE EXCEPTION 'no_property_assignments'
        USING HINT = 'Your user has no property assignments; cannot scope.';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM unnest(v_properties) AS p
       WHERE lower(trim(p)) = lower(trim(v_space_property))
    ) THEN
      RAISE EXCEPTION 'space_not_in_your_properties'
        USING HINT = 'This space is at a property you are not assigned to.';
    END IF;
  END IF;

  -- ── Amount validation ─────────────────────────────────────────────
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount_not_positive'
      USING HINT = 'amount must be greater than zero.';
  END IF;
  -- Round to 2 decimals at RPC boundary — column is NUMERIC(10,2), so
  -- 3+ decimals would silently truncate on write. Normalize here.
  v_amount_scaled := round(p_amount, 2);

  -- ── Period normalization (friendlier than raising) ────────────────
  IF p_period_month IS NULL THEN
    RAISE EXCEPTION 'period_required'
      USING HINT = 'period_month is required (any date within the month; normalized to first-of-month).';
  END IF;
  v_normalized_period := date_trunc('month', p_period_month::timestamp)::date;

  -- ── Method + note normalization: '' → NULL ────────────────────────
  v_normalized_method := NULLIF(trim(COALESCE(p_method, '')), '');
  v_normalized_note   := NULLIF(trim(COALESCE(p_note, '')), '');

  -- ── Resident snapshot: 1 tie → snapshot; 0 or 2+ → NULL ───────────
  -- Count first, then fetch. LIMIT 2 in a plain SELECT would only be
  -- read into the first row via INTO; GET DIAGNOSTICS ROW_COUNT would
  -- reflect what INTO consumed, not the underlying result cardinality.
  -- Two round-trips is the clean shape.
  SELECT COUNT(*) INTO v_tie_count
    FROM public.space_residents sr
    JOIN public.residents r ON lower(r.email) = lower(sr.resident_email)
   WHERE sr.space_id = p_space_id
     AND r.is_active;
  IF v_tie_count = 1 THEN
    SELECT lower(r.email), r.name, r.unit
      INTO v_resident_email, v_resident_name, v_resident_unit
      FROM public.space_residents sr
      JOIN public.residents r ON lower(r.email) = lower(sr.resident_email)
     WHERE sr.space_id = p_space_id
       AND r.is_active
     LIMIT 1;
  END IF;
  -- If v_tie_count = 0 or > 1, snapshots stay NULL (declared defaults).

  -- ── Double-submit guard ───────────────────────────────────────────
  SELECT COUNT(*) INTO v_dup_count
    FROM public.space_payments
   WHERE space_id = p_space_id
     AND period_month = v_normalized_period
     AND round(amount, 2) = v_amount_scaled
     AND lower(recorded_by_email) = lower(v_email)
     AND voided_at IS NULL
     AND recorded_at >= (now() - interval '60 seconds');
  IF v_dup_count > 0 THEN
    RAISE EXCEPTION 'duplicate_payment_suspected'
      USING HINT = 'A payment with the same space, period, amount, and recorder was recorded in the last 60 seconds. If this is a legitimate second payment, wait 60 seconds and retry.';
  END IF;

  -- ── INSERT ────────────────────────────────────────────────────────
  -- Snapshots from server-side (v_space_*), recorded_by_email from
  -- JWT-derived v_email. Never from any parameter.
  INSERT INTO public.space_payments (
    space_id, company, property, space_label,
    period_month, amount, method,
    resident_email, resident_name, unit,
    note, recorded_by_email
  ) VALUES (
    p_space_id, v_space_company, v_space_property, v_space_label,
    v_normalized_period, v_amount_scaled, v_normalized_method,
    v_resident_email, v_resident_name, v_resident_unit,
    v_normalized_note, lower(v_email)
  ) RETURNING id INTO v_payment_id;

  -- ── Audit row (mirrors Commit 1 + Commit 2 pattern) ──────────────
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_email),
    'AUTH_SPACE_PAYMENT_RECORD',
    'space_payments',
    v_payment_id,
    jsonb_build_object(
      'space_id',                  p_space_id,
      'company',                   v_space_company,
      'property',                  v_space_property,
      'period_month',              v_normalized_period,
      'amount',                    v_amount_scaled,
      'method',                    v_normalized_method,
      'resident_snapshot_present', v_resident_email IS NOT NULL,
      'tie_count_observed',        v_tie_count,
      'note_present',              v_normalized_note IS NOT NULL
    ),
    now()
  );

  RETURN v_payment_id;
END;
$func$;

COMMENT ON FUNCTION public.record_space_payment(BIGINT, DATE, NUMERIC, TEXT, TEXT) IS
  '2026-08-30. Reserved-space payment tracking Commit 3 — record a payment against a reserved space. DEFINER; recorded_by_email is UNFORGEABLE (resolved from auth.jwt(), never from payload). Roles: manager/leasing_agent/company_admin. Property scope enforced for manager/leasing_agent (company-only for CA). Snapshots resolved server-side from spaces + space_residents + residents. If space has 0 or 2+ active ties, resident snapshot fields are NULL (no arbitrary precedence). Period normalized to first-of-month. Amount rounded to 2 decimals. Double-submit guard rejects same-shape unvoided row within last 60s. Returns the new payment id. Errors: unauthenticated, role_not_allowed, space_not_found, space_not_in_company, no_property_assignments, space_not_in_your_properties, amount_not_positive, period_required, duplicate_payment_suspected. NOT authorization-affecting — the ledger is INERT to enforcement.';

REVOKE EXECUTE ON FUNCTION public.record_space_payment(BIGINT, DATE, NUMERIC, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_space_payment(BIGINT, DATE, NUMERIC, TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.record_space_payment(BIGINT, DATE, NUMERIC, TEXT, TEXT) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- void_space_payment
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.void_space_payment(
  p_payment_id BIGINT,
  p_reason     TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email             TEXT;
  v_role              TEXT;
  v_company           TEXT;
  v_properties        TEXT[];
  v_pay_company       TEXT;
  v_pay_property      TEXT;
  v_pay_voided_at     TIMESTAMPTZ;
  v_normalized_reason TEXT;
BEGIN
  v_email := auth.jwt() ->> 'email';
  IF v_email IS NULL OR length(trim(v_email)) = 0 THEN
    RAISE EXCEPTION 'unauthenticated' USING HINT = 'JWT missing email claim.';
  END IF;

  SELECT role, company, property
    INTO v_role, v_company, v_properties
    FROM public.user_roles
   WHERE lower(email) = lower(v_email)
   LIMIT 1;
  -- Void role gate: NARROWER than record. Only manager + company_admin.
  IF v_role IS NULL OR v_role NOT IN ('manager', 'company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed'
      USING HINT = 'Only managers and company admins can void payments.';
  END IF;

  -- Reason required + non-blank BEFORE loading payment — cheap validation first.
  v_normalized_reason := NULLIF(trim(COALESCE(p_reason, '')), '');
  IF v_normalized_reason IS NULL THEN
    RAISE EXCEPTION 'void_reason_required'
      USING HINT = 'A non-blank void_reason is required. Not just visible in the audit trail — recorded on the row.';
  END IF;

  -- Load payment.
  SELECT company, property, voided_at
    INTO v_pay_company, v_pay_property, v_pay_voided_at
    FROM public.space_payments WHERE id = p_payment_id;
  IF v_pay_company IS NULL THEN
    RAISE EXCEPTION 'payment_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  -- Already-voided check BEFORE scope check — a "you shouldn't have voided
  -- this because it was already voided" is a cleaner message than
  -- "you can't see this payment" for a case where the row exists.
  IF v_pay_voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_voided'
      USING HINT = 'This payment has already been voided.';
  END IF;

  -- Company scope.
  IF lower(trim(v_pay_company)) <> lower(trim(v_company)) THEN
    RAISE EXCEPTION 'payment_not_in_company'
      USING HINT = 'The payment does not belong to your company.';
  END IF;

  -- Property scope for manager (CA is company-wide).
  IF v_role = 'manager' THEN
    IF v_properties IS NULL OR array_length(v_properties, 1) IS NULL THEN
      RAISE EXCEPTION 'no_property_assignments';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM unnest(v_properties) AS p
       WHERE lower(trim(p)) = lower(trim(v_pay_property))
    ) THEN
      RAISE EXCEPTION 'payment_not_in_your_properties';
    END IF;
  END IF;

  -- UPDATE: ONLY the three void columns. Never touch amount, period,
  -- method, note, or any snapshot. A void records that a correction
  -- happened; it does not rewrite what was originally claimed.
  -- The void_coherence CHECK on the table enforces all-3-set.
  UPDATE public.space_payments
     SET voided_at       = now(),
         voided_by_email = lower(v_email),
         void_reason     = v_normalized_reason
   WHERE id = p_payment_id;

  -- Audit.
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_email),
    'AUTH_SPACE_PAYMENT_VOID',
    'space_payments',
    p_payment_id,
    jsonb_build_object(
      'payment_id', p_payment_id,
      'reason',     v_normalized_reason,
      'company',    v_pay_company,
      'property',   v_pay_property
    ),
    now()
  );

  RETURN TRUE;
END;
$func$;

COMMENT ON FUNCTION public.void_space_payment(BIGINT, TEXT) IS
  '2026-08-30. Reserved-space payment tracking Commit 3 — void an existing payment. DEFINER; voided_by_email from auth.jwt(). Roles: manager/company_admin only (narrower than record — voiding corrects). Property scope enforced for manager. UPDATEs only the three void columns (voided_at, voided_by_email, void_reason) — never amount, period, snapshots, method or note. Errors: unauthenticated, role_not_allowed, void_reason_required, payment_not_found, already_voided, payment_not_in_company, no_property_assignments, payment_not_in_your_properties. Returns TRUE on success. NOT authorization-affecting.';

REVOKE EXECUTE ON FUNCTION public.void_space_payment(BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.void_space_payment(BIGINT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.void_space_payment(BIGINT, TEXT) TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- Schema audit row
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_SPACE_PAYMENT_RPCS_V1',
  'public.record_space_payment + public.void_space_payment',
  'commit_3_of_4',
  jsonb_build_object(
    'migration',       '20260830_record_and_void_space_payment_rpcs',
    'arc',             'Reserved-space payment tracking — Commit 3 of 4 (record + void RPCs)',
    'schema_changes',  jsonb_build_array(
      'CREATED FUNCTION public.record_space_payment(BIGINT, DATE, NUMERIC, TEXT, TEXT) → BIGINT',
      'CREATED FUNCTION public.void_space_payment(BIGINT, TEXT) → BOOLEAN',
      'GRANTED EXECUTE on both to authenticated (REVOKED from PUBLIC/anon)'
    ),
    'load_bearing',    jsonb_build_object(
      'unforgeable_attribution', 'recorded_by_email + voided_by_email always from auth.jwt(), never from payload',
      'snapshots_server_side',   'company/property/space_label/resident_* resolved from spaces + space_residents + residents at INSERT time, never by lookup at read time',
      'void_untouches_originals', 'UPDATE sets only voided_at/voided_by_email/void_reason; amount, period, method, note, and all snapshots stay verbatim',
      'null_on_ambiguity',       'space with 0 or 2+ active ties → resident_email/name/unit snapshots NULL',
      'property_scope_enforced', 'manager + leasing_agent must have space property in user_roles.property (text[]); DEFINER RPC bypasses RLS so this is the actual scope enforcement'
    ),
    'divergences',     jsonb_build_object(
      'company_scope',  'lower(trim()) equality, NOT ~~* (metacharacter vector per docs/CURRENT_STATE.md; DEFINER context makes ILIKE-treats-value-as-pattern bite hardest)',
      'property_scope', 'ENFORCED for manager/leasing_agent (not company-only). update_space_metadata has the gap; this RPC refuses to re-introduce it. Gap filed as its own finding.',
      'record_role_gate', 'includes leasing_agent (diverges from update_space_metadata). Rationale: recording is a front-desk act; the ledger SELECT grant already includes leasing_agent — withholding record would be incoherent.'
    ),
    'next_commit',     'Commit 4: monthly report (cross-space month view per property/period). Read-only; consumes both RPCs indirectly via space_payments.'
  ),
  now()
);

NOTIFY pgrst, 'reload schema';

COMMIT;

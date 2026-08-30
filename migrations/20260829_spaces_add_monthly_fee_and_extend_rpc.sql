-- ══════════════════════════════════════════════════════════════════════
-- 20260829_spaces_add_monthly_fee_and_extend_rpc.sql
--
-- 🟢 Reserved-space payment tracking arc — COMMIT 1 of 4
--
-- Adds `spaces.monthly_fee NUMERIC(10,2) NULL` and extends
-- update_space_metadata() from 5-arg → 6-arg to include p_monthly_fee.
-- NULL means no fee.
--
-- ── SCOPE OF THIS COMMIT ────────────────────────────────────────────
-- Column + RPC extension only. Ledger (space_payments), record action,
-- month view, and monthly report ship in Commits 2–4. Non-payment
-- affects nothing in the system (see LOAD-BEARING RULE below).
--
-- ── 🔴 LOAD-BEARING RULE (write it once, read it forever) ───────────
-- Non-payment changes NOTHING. The space stays assigned. The
-- designated vehicle stays authorized. No violation fires, no
-- warning surfaces, no status transitions. Non-payment is a lease
-- matter between the property and the resident.
--
-- The reserved-space form of the Aug 21 record-only rule:
--   • A visitor pass is never revoked for non-payment, because
--     revocation is the tow.
--   • An authorization is never withdrawn for non-payment, because
--     withdrawal is the tow.
--
-- If any future commit ever de-authorizes a vehicle over an unpaid
-- fee, ShieldMyLot would be causing a tow over money. That is the
-- exact behavior the record-only model exists to refuse. The
-- COMMENT ON COLUMN below preserves this rule at the schema level
-- so the next person who proposes "auto-suspend on 30-day overdue"
-- reads it before writing code.
--
-- ── FEE HISTORY (deliberately deferred) ─────────────────────────────
-- No version history on monthly_fee in v1. Considered and rejected:
-- one field doesn't earn a full property_house_rules_versions-style
-- audit table. If "the fee changed from $25 to $40 and nobody knows
-- when" becomes a real customer question later, adopt the
-- property_house_rules_versions pattern (migrations/20260820_...) —
-- do NOT invent a second history mechanism. The audit_logs row on
-- every update_space_metadata call captures WHO changed WHAT and
-- WHEN as a soft trail in the interim.
--
-- ── RPC SIGNATURE CHANGE — DROP-THEN-CREATE, NOT OVERLOAD ───────────
-- Postgres overloads functions by (name, arg-type list). A naïve
-- CREATE OR REPLACE with a new 6th arg would leave the 5-arg version
-- alive and callable — every stale caller silently keeps working
-- against the old signature and misses the new column entirely.
--
-- Instead: DROP the 5-arg signature FIRST, then CREATE the 6-arg
-- version. Any 5-arg caller left in the codebase now errors loudly at
-- runtime with "function does not exist" — the correct failure mode.
--
-- Every 5-arg caller in the tracked codebase is updated in the same
-- commit. Search performed 2026-08-29:
--   • app/manager/page.tsx:1222         — updated to 6-arg
--   • app/company_admin/page.tsx:1367   — updated to 6-arg
--   • scripts/probe-spaces-metadata-rpc.ts (6 sites) — updated to 6-arg
-- Zero 5-arg callers remain.
--
-- ── ALL-FIELDS-REQUIRED CONTRACT (unchanged) ────────────────────────
-- Per the original RPC (2026-06-21 header): "Caller passes the CURRENT
-- value for any field they're not changing. Simpler than COALESCE-
-- nullable pattern (which can't distinguish 'skip field' from 'set
-- to empty')." Same contract extended to p_monthly_fee — NO DEFAULT,
-- caller ALWAYS passes the intended value. This avoids the DEFAULT
-- NULL trap where a 5-arg caller silently wipes the fee on every
-- description edit (Mateo Aug 29 §2.4).
--
-- ── PARAMETER DEFAULTS (audit for the standing rule) ────────────────
-- The original 5-arg RPC had NO parameter defaults on any of its
-- five parameters (verified via pg_get_functiondef 2026-08-29). The
-- 6-arg replacement also has no defaults. CREATE OR REPLACE FUNCTION
-- silently drops DEFAULTs — there are none to preserve, so this is a
-- no-op here. If the RPC ever grows a default, re-declare verbatim
-- per feedback_create_or_replace_drops_defaults.md.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART 1 — ADD COLUMN ─────────────────────────────────────────────
-- NUMERIC(10,2) matches violations.tow_fee precedent (max $99,999,999.99;
-- more than enough for any monthly parking fee). Nullable — NULL means
-- "no fee tracked on this space." No CHECK constraint on positivity: the
-- fee is metadata for the property's tracking, not a value the system
-- computes on (Jose Aug 29 §3: "the value doesn't really matter to the
-- system — it's metadata for their tracking"). The RPC-level guard on
-- negative values is the friendly-error path; a table CHECK would be
-- structural overkill for a field the system doesn't act on.
ALTER TABLE public.spaces
  ADD COLUMN IF NOT EXISTS monthly_fee NUMERIC(10,2) NULL;

COMMENT ON COLUMN public.spaces.monthly_fee IS
  '2026-08-29. Reserved-space payment tracking — Commit 1. Monthly fee for this space, in USD, NUMERIC(10,2). NULL means no fee is tracked. Set via update_space_metadata RPC (6th parameter). Rendered on manager space edit form, CA space edit form, and (per scope Aug 28 §4) the resident portal space display — fee amount only, payment status is manager-only in v1. 🔴 LOAD-BEARING: this value is INERT to the system. No violation fires, no authorization withdraws, no status transitions on non-payment. Non-payment is a lease matter. The reserved-space form of the Aug 21 record-only rule — withdrawal-of-authorization is the tow, so causing a tow over money is exactly what this refuses. The monthly report sums it; nothing else consumes it. If the fee changes and the customer asks "when," the audit_logs row from each update_space_metadata call is the interim trail — full versioning was deliberately deferred (adopt property_house_rules_versions pattern if it ever becomes a real question).';

-- ── PART 2 — DROP old 5-arg signature ───────────────────────────────
-- Kills the old overload so no stale caller silently keeps working.
-- Every tracked caller updated in this same commit.
DROP FUNCTION IF EXISTS public.update_space_metadata(BIGINT, TEXT, TEXT, TEXT, BOOLEAN);

-- ── PART 3 — CREATE 6-arg replacement ───────────────────────────────
-- Body identical to the 5-arg version PLUS:
--   • p_monthly_fee validation (negative rejected, NULL accepted)
--   • UPDATE SET monthly_fee = p_monthly_fee
--   • audit row includes monthly_fee_set boolean + old/new fee
-- Preserves: DEFINER, search_path=public,pg_temp, role-pin guard,
-- company scope, clean-raise on UNIQUE(property,label), all
-- validations, audit convention.
CREATE OR REPLACE FUNCTION public.update_space_metadata(
  p_space_id    BIGINT,
  p_label       TEXT,
  p_description TEXT,
  p_type        TEXT,
  p_is_bundled  BOOLEAN,
  p_monthly_fee NUMERIC(10,2)
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_email          TEXT;
  v_role           TEXT;
  v_company        TEXT;
  v_space_company  TEXT;
  v_old_label      TEXT;
  v_old_fee        NUMERIC(10,2);
  v_normalized_label       TEXT;
  v_normalized_description TEXT;
BEGIN
  v_email := auth.jwt() ->> 'email';

  -- Role + company in one round-trip (matches the 5 other RPCs).
  SELECT role, company INTO v_role, v_company
    FROM public.user_roles WHERE lower(email) = lower(v_email) LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('manager','company_admin') THEN
    RAISE EXCEPTION 'role_not_allowed'
      USING HINT = 'Only managers and company admins can edit space metadata.';
  END IF;

  -- Load space + verify company + capture old label + old fee
  -- (both feed the audit row + error context).
  SELECT company, label, monthly_fee
    INTO v_space_company, v_old_label, v_old_fee
    FROM public.spaces WHERE id = p_space_id;
  IF v_space_company IS NULL THEN
    RAISE EXCEPTION 'space_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_space_company !~~* v_company THEN
    RAISE EXCEPTION 'space_not_in_company'
      USING HINT = 'The space does not belong to your company.';
  END IF;

  -- Field validations (all-required contract; null/empty label → raise).
  v_normalized_label := NULLIF(trim(COALESCE(p_label, '')), '');
  IF v_normalized_label IS NULL THEN
    RAISE EXCEPTION 'label_required'
      USING HINT = 'label cannot be empty.';
  END IF;

  IF p_type IS NULL OR p_type NOT IN ('regular','carport','garage','covered','handicap','employee') THEN
    RAISE EXCEPTION 'invalid_type'
      USING HINT = 'type must be one of: regular, carport, garage, covered, handicap, employee';
  END IF;

  IF p_is_bundled IS NULL THEN
    RAISE EXCEPTION 'is_bundled_required'
      USING HINT = 'is_bundled must be TRUE or FALSE (not null).';
  END IF;

  -- 🟢 2026-08-29 monthly_fee validation. NULL is accepted (means
  -- "no fee tracked"). Non-null values must be >= 0. Zero is
  -- deliberately allowed — a manager may want to record $0/mo
  -- explicitly (e.g., during a promotion, or before setting a rate).
  IF p_monthly_fee IS NOT NULL AND p_monthly_fee < 0 THEN
    RAISE EXCEPTION 'monthly_fee_negative'
      USING HINT = 'monthly_fee must be zero or greater. Use NULL to clear the fee.';
  END IF;

  -- description normalization: '' → NULL (don't store empty strings;
  -- match the migration's NULLIF backfill convention)
  v_normalized_description := NULLIF(trim(COALESCE(p_description, '')), '');

  -- ── UPDATE in a protected block so UNIQUE(property,label) raises
  --    a CLEAN label_already_exists instead of the raw constraint error.
  BEGIN
    UPDATE public.spaces
       SET label       = v_normalized_label,
           description = v_normalized_description,
           type        = p_type,
           is_bundled  = p_is_bundled,
           monthly_fee = p_monthly_fee
     WHERE id = p_space_id;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'label_already_exists'
        USING HINT = 'Another space at this property already uses label "' || v_normalized_label || '". Labels must be unique per property.';
  END;

  -- Audit row (extends AUTH_SPACE_UPDATE_METADATA with fee context).
  -- old_fee + new_fee is the interim trail for "when did the fee
  -- change?" until (if ever) full versioning is adopted.
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    lower(v_email),
    'AUTH_SPACE_UPDATE_METADATA',
    'spaces',
    p_space_id,
    jsonb_build_object(
      'old_label',        v_old_label,
      'new_label',        v_normalized_label,
      'type',             p_type,
      'is_bundled',       p_is_bundled,
      'description_set',  v_normalized_description IS NOT NULL,
      'old_fee',          v_old_fee,
      'new_fee',          p_monthly_fee,
      'fee_changed',      (v_old_fee IS DISTINCT FROM p_monthly_fee),
      'company',          v_company
    ),
    now()
  );

  RETURN TRUE;
END;
$func$;

-- ── PART 4 — Grants on the NEW 6-arg signature ──────────────────────
-- The DROP above wiped the grants on the old 5-arg signature; re-issue
-- on the new. Deny-by-default matches the pattern in
-- 20260722_grant_remediation_deny_by_default.sql.
REVOKE EXECUTE ON FUNCTION public.update_space_metadata(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, NUMERIC(10,2)) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_space_metadata(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, NUMERIC(10,2)) FROM anon;
GRANT  EXECUTE ON FUNCTION public.update_space_metadata(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, NUMERIC(10,2)) TO authenticated;

-- ── PART 5 — PostgREST schema cache reload ──────────────────────────
NOTIFY pgrst, 'reload schema';

-- ── PART 6 — Schema audit row ───────────────────────────────────────
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_SPACES_ADD_MONTHLY_FEE',
  'public.spaces + public.update_space_metadata',
  'monthly_fee + update_space_metadata(6-arg)',
  jsonb_build_object(
    'migration',       '20260829_spaces_add_monthly_fee_and_extend_rpc',
    'arc',             'Reserved-space payment tracking — Commit 1 of 4',
    'schema_changes',  jsonb_build_array(
      'ADDED COLUMN public.spaces.monthly_fee NUMERIC(10,2) NULL',
      'DROPPED public.update_space_metadata(BIGINT, TEXT, TEXT, TEXT, BOOLEAN)',
      'CREATED public.update_space_metadata(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, NUMERIC(10,2))',
      'REGRANTED EXECUTE on new signature to authenticated (REVOKED from PUBLIC/anon)'
    ),
    'callers_updated', jsonb_build_array(
      'app/manager/page.tsx',
      'app/company_admin/page.tsx',
      'scripts/probe-spaces-metadata-rpc.ts (6 sites)'
    ),
    'load_bearing_rule', 'Non-payment changes nothing. Reserved-space form of the Aug 21 record-only rule. No violation fires, no authorization withdraws, no status transitions on non-payment. Withdrawal-of-authorization is the tow; causing a tow over money is what this refuses.',
    'fee_history',      'Deliberately deferred in v1. Interim trail via audit_logs old_fee/new_fee/fee_changed on every update_space_metadata call. If full versioning ever becomes needed, adopt property_house_rules_versions pattern (2026-08-20).',
    'next_commits',     'Commit 2 (space_payments ledger + RLS), Commit 3 (record action + month view), Commit 4 (monthly report). All obey the load-bearing rule above.'
  ),
  now()
);

COMMIT;

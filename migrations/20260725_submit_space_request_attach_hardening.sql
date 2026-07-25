-- ════════════════════════════════════════════════════════════════════
-- submit_space_request — attach-hardening (function + index)
-- Locked: July 25, 2026
--
-- WHY THIS EXISTS
--   Ships BEFORE the re-registration attach arc. Attach creates the
--   two-residency state that turns three today-latent defects into
--   live ones, all in this one RPC + its supporting UNIQUE index.
--
-- THREE DEFECTS FIXED HERE
--
--   1. Residency load — LIMIT-1-no-ORDER-BY, no property binding.
--      Prior WHERE lower(email) = v_caller_email LIMIT 1 was safe
--      today (one row per email); goes nondeterministic the moment
--      concurrent residencies exist. Same class as get_my_role() /
--      user_roles_lower_email_uidx (2026-07-04 pre-written).
--
--   2. Pending-request pre-check — email-scoped, not property-scoped.
--      Prior WHERE lower(resident_email) = v_caller_email AND
--      status = 'pending' fires on ANY pending request for this email
--      across ALL properties. A Dallas-approved + Houston-approved
--      resident with a pending Dallas request cannot submit at
--      Houston — the pre-check finds Dallas and refuses. Feature
--      enables concurrent residencies; this line silently forbids
--      concurrent requests.
--
--   3. UNIQUE index space_requests_one_pending_per_resident — same
--      email-scoped shape as the pre-check. Even if the pre-check
--      is property-bound, INSERT throws 23505 at the constraint
--      level for a second (email, other-property) pending. Fix is
--      cosmetic without the index change.
--
--   All three must move together — property-binding two of the three
--   is a half-fix that surfaces the first time a dual-resident
--   submits a second request.
--
-- FIX SHAPE (minimum-blast-radius, five items)
--
--   Function changes:
--     a. Bind residency load to p_property in WHERE, lower(trim())
--        both sides — mirrors AP-CASCADE-DB / pm_plate_lookup
--        normalization convention.
--     b. ORDER BY id DESC — see rationale below.
--     c. Retain is_active/status IF-check for user-actionable error
--        (resident_not_active copy is more actionable than a
--        collapsed 'no residency' catch-all).
--     d. Remove redundant IF v_resident.property <> p_property —
--        WHERE binds it.
--     e. Rename 'resident_not_found' → 'no_residency_at_property'
--        (client-safe per grep: only pending_request_exists is
--        specially handled).
--     f. Bind pending-request pre-check to p_property (same
--        lower(trim()) shape).
--
--   Index change:
--     g. DROP + CREATE UNIQUE INDEX ON (resident_email, property)
--        WHERE status='pending'. Strictly weaker than the old
--        (email-only) constraint — cannot fail on existing data.
--        Fail-closed inside BEGIN regardless.
--
-- WHY ORDER BY id DESC (differs from submit_guest_authorization_request's ASC)
--   The two RPCs disagree on ordering because they answer different
--   questions:
--
--     submit_guest_authorization_request — NO property parameter.
--       The RPC picks "the resident's property" from among their
--       active residencies. First-registered (id ASC) reads as
--       "primary" — a resident's oldest active residency is
--       arguably their home base. WHERE narrows to is_active=TRUE
--       across all rows; ORDER BY picks one from potentially many.
--
--     submit_space_request — TAKES p_property.
--       WHERE narrows to (email, this property). Multiple rows at
--       the same property is possible ONLY in the deactivate-then-
--       re-register case: an old declined row + a new pending row
--       at the same property. id DESC picks the new one (the
--       registration the resident just went through), which is
--       correct. ASC would pick the old declined row, which would
--       return resident_not_active for a legitimately-just-approved
--       resident.
--
--   Both are correct for their surface. State the reasoning here
--   so the divergence is intent, not drift.
--
-- INVARIANTS PRESERVED
--   • Function signature UNCHANGED: (p_property TEXT, p_note TEXT
--     DEFAULT NULL) -> jsonb. CREATE OR REPLACE in-place safe.
--   • SECURITY DEFINER + search_path = public, pg_temp preserved.
--   • GRANT EXECUTE preserved (CREATE OR REPLACE retains grants).
--   • auth gate, role gate, args validation, INSERT, audit — all
--     UNCHANGED.
--   • Fallback client regex /pending_request_exists|duplicate
--     key|unique/i in app/resident/page.tsx:608 still catches
--     23505 from the new (email, property) UNIQUE — no client
--     change needed.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PART A — Function ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_space_request(
  p_property TEXT,
  p_note     TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email TEXT;
  v_caller_role  TEXT;
  v_resident     residents%ROWTYPE;
  v_new_id       BIGINT;
BEGIN
  -- ── Auth gate ──────────────────────────────────────────────
  v_caller_email := lower(auth.jwt() ->> 'email');
  IF v_caller_email IS NULL OR length(trim(v_caller_email)) = 0 THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- ── Role gate ──────────────────────────────────────────────
  v_caller_role := get_my_role();
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('error', 'no_role_assigned');
  END IF;
  IF v_caller_role <> 'resident' THEN
    RETURN jsonb_build_object('error', 'role_not_authorized',
                              'hint',  'Only residents can submit space requests.');
  END IF;

  -- ── Args ───────────────────────────────────────────────────
  IF p_property IS NULL OR length(trim(p_property)) = 0 THEN
    RETURN jsonb_build_object('error', 'property_required');
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 500 THEN
    RETURN jsonb_build_object('error', 'note_too_long',
                              'hint',  'Note is capped at 500 characters.');
  END IF;

  -- ── Resident load + state ─────────────────────────────────
  -- 2026-07-25 attach-hardening: WHERE binds to p_property with
  -- lower(trim()) both sides; ORDER BY id DESC picks the newest
  -- row at that (email, property) — correct for the re-register-
  -- after-deactivate case (old declined + new pending → pick new).
  -- See migration header for the DESC-vs-ASC rationale vs guest-auth.
  SELECT * INTO v_resident
    FROM public.residents
   WHERE lower(email) = v_caller_email
     AND lower(trim(property)) = lower(trim(p_property))
   ORDER BY id DESC
   LIMIT 1;
  IF v_resident.id IS NULL THEN
    RETURN jsonb_build_object('error', 'no_residency_at_property',
                              'hint',  'You do not have a residency at this property.');
  END IF;
  IF v_resident.is_active IS NOT TRUE OR v_resident.status <> 'active' THEN
    RETURN jsonb_build_object('error', 'resident_not_active',
                              'hint',  'Your registration must be approved before requesting a space.');
  END IF;
  -- Prior redundant `v_resident.property <> p_property` check removed —
  -- the WHERE clause now binds to p_property directly.

  -- ── Pre-check: no existing pending AT THIS PROPERTY ────────
  -- 2026-07-25 attach-hardening: property-bound to match the
  -- new (resident_email, property) UNIQUE partial index below.
  -- Prior email-only check silently forbade concurrent requests
  -- across a dual-resident's multiple properties.
  IF EXISTS (
    SELECT 1 FROM public.space_requests
     WHERE lower(resident_email) = v_caller_email
       AND lower(trim(property)) = lower(trim(p_property))
       AND status = 'pending'
  ) THEN
    RETURN jsonb_build_object('error', 'pending_request_exists',
                              'hint',  'You already have a pending space request at this property. Wait for a decision or cancel it first.');
  END IF;

  -- ── INSERT ─────────────────────────────────────────────────
  INSERT INTO public.space_requests (resident_email, property, note)
  VALUES (v_caller_email, p_property, NULLIF(trim(COALESCE(p_note, '')), ''))
  RETURNING id INTO v_new_id;

  -- ── Audit ──────────────────────────────────────────────────
  INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
  VALUES (
    v_caller_email,
    'SPACE_REQUEST_SUBMITTED',
    'space_requests',
    v_new_id,
    jsonb_build_object(
      'property',      p_property,
      'note_present',  p_note IS NOT NULL AND length(trim(p_note)) > 0
    ),
    now()
  );

  RETURN jsonb_build_object('ok', TRUE, 'request_id', v_new_id);
END;
$func$;

-- ── PART B — UNIQUE partial index: email → (email, property) ─────────
-- Strictly weaker than the prior email-only shape (old satisfaction
-- implies new satisfaction) — cannot fail on existing data. Fail-closed
-- inside BEGIN regardless: if any (email, property) collision existed
-- somehow, CREATE would 23505 and roll back the whole migration.

DROP INDEX IF EXISTS public.space_requests_one_pending_per_resident;

CREATE UNIQUE INDEX space_requests_one_pending_per_resident_property
  ON public.space_requests (resident_email, property)
  WHERE status = 'pending';

-- ── PART C — Migration audit row ─────────────────────────────────────

INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_SUBMIT_SPACE_REQUEST_ATTACH_HARDENING',
  'multi',
  NULL,
  jsonb_build_object(
    'migration', '20260725_submit_space_request_attach_hardening',
    'purpose',   'Prep for concurrent residencies enabled by re-registration attach arc. ' ||
                 'Three coupled fixes: residency-load property binding + ORDER BY DESC + ' ||
                 'is_active filter; pending-request pre-check property binding; ' ||
                 'UNIQUE partial index property-bound.',
    'invariants', jsonb_build_object(
      'signature',        'UNCHANGED (p_property TEXT, p_note TEXT DEFAULT NULL) -> jsonb',
      'grants',           'UNCHANGED (CREATE OR REPLACE preserves EXECUTE grants)',
      'security_definer', 'PRESERVED',
      'search_path',      'PRESERVED (public, pg_temp)',
      'other_branches',   'auth gate / role gate / args / INSERT / audit UNCHANGED'
    ),
    'error_string_renames', jsonb_build_object(
      'resident_not_found', 'no_residency_at_property (more accurate; client-safe per grep)'
    ),
    'index_change', jsonb_build_object(
      'old_name', 'space_requests_one_pending_per_resident',
      'old_shape', '(resident_email) WHERE status=pending',
      'new_name', 'space_requests_one_pending_per_resident_property',
      'new_shape', '(resident_email, property) WHERE status=pending',
      'safety',  'strictly weaker — old satisfaction implies new, cannot fail on existing data'
    ),
    'related', jsonb_build_object(
      'sibling_pattern',   'submit_guest_authorization_request uses ORDER BY id ASC without property binding — different surface, see migration header rationale',
      'related_migration', '20260704_user_roles_unique_lower_email.sql (same LIMIT-1-nondeterminism class, still apply-later)'
    )
  ),
  now()
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- insert_user_role — resident-self-attach idempotency
-- Locked: July 25, 2026
--
-- WHY THIS EXISTS
--   Re-registration attach arc, commit 2 addendum. The client at
--   /register/page.tsx:193 calls insert_user_role unconditionally after
--   the L175 residents INSERT, regardless of create vs attach. On create
--   (brand-new email), the RPC's v_caller_role IS NULL branch admits
--   and creates the load-bearing role row. On attach (existing
--   resident), v_caller_role='resident' hits the ELSE default-deny
--   branch and RAISEs 'caller_role_not_authorized: resident' — a
--   correct refusal (the caller already has their role row). The client
--   fallback at /register:201 catches the raise and writes a SECOND
--   user_roles row (RLS admits via authenticated_self_insert_resident).
--   That second row:
--     • is redundant — resident RLS is company-AGNOSTIC (verified
--       across every resident_read_own_* policy + every resident-write
--       DEFINER RPC on 2026-07-25 trace); one role='resident' row
--       serves all of a resident's residencies at any company
--     • feeds LIMIT-1-no-ORDER-BY nondeterminism in get_my_company()
--       and get_my_properties() for cross-company dual residency
--     • ships as a bypassed guard: insert_user_role refused, client
--       caught-and-overrode
--
-- FIX
--   Make insert_user_role IDEMPOTENT for the resident-self-attach
--   case. If the caller is a resident (v_caller_role='resident'),
--   invoking with p_role='resident' AND p_email matching their JWT
--   email, and a resident-role row already exists for that email
--   → RETURN silently. The load-bearing role row exists; this
--   operation is a no-op.
--
--   Client stays unchanged — the call still fires unconditionally,
--   the RPC just handles both shapes cleanly. Fallback becomes dead
--   code on the happy path (still catches unforeseen errors).
--
-- NORMALIZATION
--   Matches get_my_role()'s user_roles read byte-for-byte:
--     WHERE lower(email) = lower(auth.jwt() ->> 'email')
--   No trim on either side (get_my_role doesn't trim). This IS the
--   critical detail — a mismatch means an existence check that reads
--   "no row" while get_my_role reads "yes row" for the same email.
--
-- INVARIANTS PRESERVED
--   • Signature UNCHANGED: (TEXT, TEXT, TEXT, TEXT[], TEXT DEFAULT NULL) → void
--   • SECURITY DEFINER + search_path = public, pg_temp preserved
--   • GRANT EXECUTE preserved (CREATE OR REPLACE)
--   • ADMIN / CA-MGR-LA / SELF-REG-NULL / ELSE-DENY branches UNCHANGED
--   • The new branch fires ONLY when v_caller_role='resident' AND
--     p_role='resident' AND emails match — every other caller-shape
--     hits the existing role-based branches exactly as before
-- ════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.insert_user_role(
  p_email     TEXT,
  p_role      TEXT,
  p_company   TEXT,
  p_property  TEXT[],
  p_name      TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_caller_email   TEXT;
  v_caller_role    TEXT;
  v_caller_company TEXT;
BEGIN
  -- ── AUTH CONTEXT ────────────────────────────────────────────────
  v_caller_email := auth.jwt() ->> 'email';
  v_caller_role := get_my_role();

  -- ── 2026-07-25 attach-hardening — RESIDENT-SELF-ATTACH IDEMPOTENCY ──
  -- If the caller is a resident invoking with p_role='resident' AND
  -- p_email matches their JWT email, and a resident-role row already
  -- exists for them, return silently. Same normalization as
  -- get_my_role() reads (lower(email) = lower(auth.jwt().email)). The
  -- load-bearing role row exists; this is a no-op. See migration
  -- header for full rationale.
  IF v_caller_role = 'resident'
     AND p_role = 'resident'
     AND v_caller_email IS NOT NULL
     AND lower(p_email) = lower(v_caller_email)
     AND EXISTS (
       SELECT 1 FROM public.user_roles
        WHERE lower(email) = lower(v_caller_email)
          AND role = 'resident'
     )
  THEN
    RETURN;
  END IF;

  -- ── CALLER-ROLE-CONDITIONAL GUARDS ──────────────────────────────
  -- (UNCHANGED from 2026-06-13 — every branch below preserved byte-identical)

  IF v_caller_role = 'admin' THEN
    NULL;

  ELSIF v_caller_role IN ('company_admin', 'manager', 'leasing_agent') THEN
    IF p_role NOT IN ('manager', 'leasing_agent', 'driver', 'resident') THEN
      RAISE EXCEPTION 'role_not_allowed: %', p_role
        USING HINT = 'admin/company_admin can only be minted by admin callers (or via service-role migration). This RPC restricts non-admin callers to tenant-level roles.';
    END IF;
    v_caller_company := get_my_company();
    IF v_caller_company IS NULL
       OR p_company IS NULL
       OR LOWER(p_company) <> LOWER(v_caller_company)
    THEN
      RAISE EXCEPTION 'company_scope_violation: caller scoped to "%" cannot insert into "%"', v_caller_company, p_company
        USING HINT = 'Tenant roles can only provision users for their own company. Admin caller required for cross-company provisioning.';
    END IF;

  ELSIF v_caller_role IS NULL THEN
    IF p_role <> 'resident' THEN
      RAISE EXCEPTION 'self_reg_role_violation: self-reg can only mint resident roles (got %)', p_role
        USING HINT = 'New users in self-reg flow can only create their own resident row. Other roles require a CA or admin caller.';
    END IF;
    IF v_caller_email IS NULL OR LOWER(p_email) <> LOWER(v_caller_email) THEN
      RAISE EXCEPTION 'self_reg_email_violation: self-reg can only mint own email'
        USING HINT = 'Self-registering user can only create a user_roles row for their own authenticated email.';
    END IF;

  ELSE
    RAISE EXCEPTION 'caller_role_not_authorized: %', v_caller_role
      USING HINT = 'insert_user_role is callable only by admin, company_admin, manager, leasing_agent, or first-time self-reg users.';
  END IF;

  -- ── INSERT (UNCHANGED) ──────────────────────────────────────────
  INSERT INTO public.user_roles (email, role, company, property, name)
  VALUES (p_email, p_role, p_company, p_property, p_name);
END
$func$;

-- Grants preserved by CREATE OR REPLACE on unchanged signature.
-- (Defensive re-affirm omitted; verification asserts EXECUTE holds.)

-- Migration audit row
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_INSERT_USER_ROLE_RESIDENT_SELF_ATTACH_IDEMPOTENCY',
  'multi',
  NULL,
  jsonb_build_object(
    'migration', '20260725_insert_user_role_resident_self_attach_idempotency',
    'purpose',   'Idempotency for the resident-self-attach case. Client at /register/page.tsx:193 calls this RPC unconditionally on both create and attach paths. On attach, existing residents hit the ELSE default-deny; client fallback caught the raise and wrote a redundant second user_roles row that fed get_my_company/properties nondeterminism. New branch: if caller is a resident invoking with p_role=resident on own email AND a resident row already exists, RETURN silently.',
    'invariants', jsonb_build_object(
      'signature',        'UNCHANGED ((TEXT, TEXT, TEXT, TEXT[], TEXT DEFAULT NULL) -> void)',
      'grants',           'UNCHANGED (CREATE OR REPLACE preserves EXECUTE grants)',
      'security_definer', 'PRESERVED',
      'search_path',      'PRESERVED (public, pg_temp)',
      'existing_branches','admin / CA-mgr-la / self-reg-NULL / ELSE-deny UNCHANGED byte-identical'
    ),
    'normalization', 'lower(email) = lower(auth.jwt() ->> ''email'') — matches get_my_role() byte-for-byte, no trim',
    'related', jsonb_build_object(
      'client_code',            'app/register/page.tsx:193-207 UNCHANGED — RPC handles both shapes',
      'existing_readers',       'app/login/page.tsx:116, app/resident/layout.tsx:27, NavBar, portal-account-gate, etc.',
      'nondeterminism_epic',    'get_my_role/company/properties LIMIT-1-no-ORDER-BY — still deferred; this migration removes ONE source of duplicate rows going forward'
    )
  ),
  now()
);

COMMIT;

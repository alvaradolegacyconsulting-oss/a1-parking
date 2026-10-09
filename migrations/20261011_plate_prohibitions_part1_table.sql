-- ════════════════════════════════════════════════════════════════════
-- property_plate_prohibitions — PART 1: table, scope, normalization
-- ════════════════════════════════════════════════════════════════════
--
-- Feature request: A1, 2026-10-10. Rulings: Jose, 2026-10-11.
--
-- A per-property list of plates that MAY NOT be registered or passed in.
-- Blocks resident registration, visitor passes, manager adds and guest
-- authorizations; surfaces as "Not permitted at this property" in the
-- driver and PM plate lookups.
--
-- ── 🔴 WHY NOT "banned" ANYWHERE IN THE CODE ────────────────────────
-- plate-status.ts already carries `doNotTow: boolean`, described there
-- as "the load-bearing invariant". It does NOT mean "on the
-- do_not_tow list" — it means ENFORCEMENT MUST NOT TOW, and it is TRUE
-- for authorized, guest_authorized and visitor. A prohibited plate is
-- the opposite: maximally towable, doNotTow = false.
--
-- So "banned" would have given us a status whose `doNotTow` is false,
-- sitting beside a table called do_not_tow_plates whose members are the
-- least towable things in the system. Three similar names, two opposite
-- meanings, on the surface where a mistake gets a car towed.
--
-- `prohibited` has no overlap, and the manager-facing label — "Not
-- permitted at this property" — is also the resident-facing copy, so
-- there is no translation layer that can drift.
--
-- ── SHAPE: MIRRORS do_not_tow_plates, DELIBERATELY ──────────────────
-- property_id FK (not property TEXT — the text-keyed scoping is the
-- rename fragility the FK convention exists to close), plate
-- pre-normalized by trigger, required reason, optional expiry, soft
-- delete, attribution. Where this diverges, it diverges on purpose:
--
--   • removal REQUIRES a reason    — DNT records only removed_by/at.
--     Jose: removal is the key requirement. A prohibition removed with
--     no stated reason is indistinguishable from one removed by
--     mistake, and managers can remove a CA's prohibition, so "who and
--     why" is the whole audit value.
--   • removed_reason_code + note   — a short list plus free text, the
--     same two-field shape as the deactivation vocabulary.
--
-- PROPERTY-WIDE ONLY. No company-wide option (ruled). A company-wide
-- prohibition would be a different object with a different blast
-- radius, and adding the column now would invite someone to set it.
--
-- Paired: 20261011_plate_prohibitions_verification.sql (covers all three parts)
-- Parts 2 (triggers + RPCs) and 3 (reason code + lookups) follow.

CREATE TABLE IF NOT EXISTS public.property_plate_prohibitions (
  id             BIGSERIAL PRIMARY KEY,
  property_id    BIGINT NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,

  -- Stored PRE-NORMALIZED by trigger (upper, alphanumeric only), so the
  -- enforcement check is an indexed equality and not a per-row regex.
  plate          TEXT NOT NULL,

  -- 🔴 REQUIRED, and NEVER shown to a resident, visitor or driver.
  -- Managers and CAs see it. A prohibition reason is likely a dispute,
  -- a trespass notice or a person; a tow driver does not need it to
  -- act, and a resident being told why would hand them the office's
  -- internal note. This is the inverse of do_not_tow_plates.reason,
  -- which IS shown to drivers because there a bare flag invites
  -- second-guessing.
  reason         TEXT NOT NULL,
  note           TEXT NULL,

  added_by       TEXT NOT NULL,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- NULL = indefinite. A lapsed prohibition stops applying
  -- automatically and STAYS IN HISTORY (ruled) — the enforcement check
  -- is (expires_at IS NULL OR expires_at > now()), never a delete.
  expires_at     TIMESTAMPTZ NULL,

  -- ── Soft delete, with a reason. Hard DELETE is refused by RLS. ────
  removed_at         TIMESTAMPTZ NULL,
  removed_by         TEXT NULL,
  removed_reason     TEXT NULL,
  removed_note       TEXT NULL,

  CONSTRAINT ppp_reason_nonempty   CHECK (length(trim(reason)) > 0),
  CONSTRAINT ppp_added_by_nonempty CHECK (length(trim(added_by)) > 0),

  -- 🔴 THE REMOVAL INVARIANT, at the table level.
  -- Removal without a reason is refused by the DATABASE, not only by
  -- the RPC — the RPC gives the message, this makes it impossible. All
  -- four removal columns move together or none do: a row cannot be
  -- removed anonymously, nor carry a removal reason while still active.
  CONSTRAINT ppp_removal_is_complete CHECK (
    (removed_at IS NULL AND removed_by IS NULL AND removed_reason IS NULL AND removed_note IS NULL)
    OR
    (removed_at IS NOT NULL
      AND removed_by IS NOT NULL AND length(trim(removed_by)) > 0
      AND removed_reason IS NOT NULL AND length(trim(removed_reason)) > 0)
  ),

  -- An expiry in the past at insert time would be a prohibition that
  -- never applied — almost certainly a typo'd year.
  CONSTRAINT ppp_expiry_not_already_past CHECK (
    expires_at IS NULL OR removed_at IS NOT NULL OR expires_at > added_at
  )
);

COMMENT ON TABLE public.property_plate_prohibitions IS
  'Plates that MAY NOT be registered or passed in at a property. Blocks resident registration, visitor passes, manager adds and guest authorizations via BEFORE triggers on vehicles / visitor_passes / guest_authorizations; surfaces as "Not permitted at this property" in the driver and PM plate lookups. ACTIVE means removed_at IS NULL AND (expires_at IS NULL OR expires_at > now()) — both, always. 🔴 `reason` is MANAGER/CA-ONLY and must never reach a resident, visitor or driver: the opposite of do_not_tow_plates.reason, which is shown to drivers deliberately. Removal is soft and REQUIRES a reason (enforced by ppp_removal_is_complete, not only by the RPC); a manager may remove a prohibition a CA added, and the full add/remove history stays visible to both. Removal does NOT restore anything that was revoked — the resident re-registers through normal approval. Property-wide only; there is deliberately no company-wide option.';

COMMENT ON COLUMN public.property_plate_prohibitions.reason IS
  'Why this plate is not permitted. REQUIRED. Visible to managers and company admins ONLY — never to residents, visitors or drivers.';
COMMENT ON COLUMN public.property_plate_prohibitions.expires_at IS
  'NULL = indefinite. A lapsed prohibition stops applying automatically and remains in history; it is never deleted on expiry.';
COMMENT ON COLUMN public.property_plate_prohibitions.removed_reason IS
  'Why the prohibition was lifted. REQUIRED when removed_at is set — ppp_removal_is_complete makes an anonymous or unexplained removal impossible at the table level.';

-- ══════════════════════════════════════════════════════════════════
-- Indexes
-- ══════════════════════════════════════════════════════════════════
-- Partial unique on ACTIVE rows only, so remove-then-re-add works
-- without colliding while both stay in history.
--
-- 🔴 `removed_at IS NULL` is the only predicate that can live in an
-- index: expiry needs now(), which is STABLE not IMMUTABLE and cannot
-- appear here. The expiry half is applied in the query — the same
-- constraint do_not_tow_plates documents, and the reason a lapsed row
-- must be filtered by every caller rather than trusted to the index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ppp_property_plate_active
  ON public.property_plate_prohibitions (property_id, plate)
  WHERE removed_at IS NULL;

-- The enforcement lookup: (plate, property_id), non-removed.
CREATE INDEX IF NOT EXISTS idx_ppp_plate_active
  ON public.property_plate_prohibitions (plate, property_id)
  WHERE removed_at IS NULL;

-- The management panel: full history per property, newest first. NOT
-- partial — history includes removed and expired rows by requirement.
CREATE INDEX IF NOT EXISTS idx_ppp_property_history
  ON public.property_plate_prohibitions (property_id, added_at DESC);

-- ══════════════════════════════════════════════════════════════════
-- Plate normalization trigger
-- ══════════════════════════════════════════════════════════════════
-- Mirrors dnt_plate_normalize exactly. One of the five normalizers
-- harmonized on 2026-10-07; all of them now strip [^A-Za-z0-9] and
-- uppercase, so an indexed equality hit is independent of how the
-- caller formatted the plate.
CREATE OR REPLACE FUNCTION public.ppp_plate_normalize()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
BEGIN
  NEW.plate := UPPER(regexp_replace(COALESCE(NEW.plate, ''), '[^A-Za-z0-9]', '', 'g'));
  IF NEW.plate = '' THEN
    RAISE EXCEPTION 'property_plate_prohibitions.plate cannot be empty after normalization (only alphanumeric characters are kept)'
      USING ERRCODE = '22004',
            HINT    = 'Provide a plate containing at least one letter or digit.';
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS ppp_plate_normalize_trigger ON public.property_plate_prohibitions;
CREATE TRIGGER ppp_plate_normalize_trigger
  BEFORE INSERT OR UPDATE OF plate ON public.property_plate_prohibitions
  FOR EACH ROW
  EXECUTE FUNCTION public.ppp_plate_normalize();

-- ══════════════════════════════════════════════════════════════════
-- RLS — mirrors do_not_tow_plates
-- ══════════════════════════════════════════════════════════════════
-- 🔴 NO DELETE POLICY ANYWHERE. Soft delete only (ruled). Absence of a
-- policy is the enforcement: with RLS enabled and no permissive DELETE
-- policy, a hard delete matches nothing for every role.
--
-- 🔴 The management panel is in the CA portal for EVERY tier, including
-- Operator Starter, and managers have it for their own properties
-- (ruled). On Operator Starter there are no residents or visitors to
-- block, so the payoff there is the driver lookup — which is why this
-- is NOT gated on my_tier_pm_capable().
ALTER TABLE public.property_plate_prohibitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ppp_admin_all" ON public.property_plate_prohibitions;
CREATE POLICY "ppp_admin_all" ON public.property_plate_prohibitions
  FOR ALL TO authenticated
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

-- Manager: their own properties. SELECT covers full history, by
-- requirement — removed and expired rows included.
DROP POLICY IF EXISTS "ppp_manager_select" ON public.property_plate_prohibitions;
CREATE POLICY "ppp_manager_select" ON public.property_plate_prohibitions
  FOR SELECT TO authenticated
  USING (
    get_my_role() = ANY (ARRAY['manager', 'leasing_agent'])
    AND property_id IN (
      SELECT id FROM public.properties WHERE name = ANY (get_my_properties())
    )
  );

-- 🔴 INSERT/UPDATE for 'manager' ONLY — leasing_agent reads, never
-- writes. A prohibition blocks a resident from registering a car;
-- that is a decision, not a convenience, and the leasing-agent
-- write-expansion trap is a named pattern in this codebase.
DROP POLICY IF EXISTS "ppp_manager_insert" ON public.property_plate_prohibitions;
CREATE POLICY "ppp_manager_insert" ON public.property_plate_prohibitions
  FOR INSERT TO authenticated
  WITH CHECK (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT id FROM public.properties WHERE name = ANY (get_my_properties())
    )
  );

-- Manager UPDATE — this is how removal happens, and it is deliberately
-- NOT restricted to rows the manager added: a manager may remove a
-- prohibition a CA added at their property (ruled), always audited.
DROP POLICY IF EXISTS "ppp_manager_update" ON public.property_plate_prohibitions;
CREATE POLICY "ppp_manager_update" ON public.property_plate_prohibitions
  FOR UPDATE TO authenticated
  USING (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT id FROM public.properties WHERE name = ANY (get_my_properties())
    )
  )
  WITH CHECK (
    get_my_role() = 'manager'
    AND property_id IN (
      SELECT id FROM public.properties WHERE name = ANY (get_my_properties())
    )
  );

-- Company admin: every property their company owns, all tiers.
DROP POLICY IF EXISTS "ppp_company_admin_all" ON public.property_plate_prohibitions;
CREATE POLICY "ppp_company_admin_all" ON public.property_plate_prohibitions
  FOR ALL TO authenticated
  USING (
    get_my_role() = 'company_admin'
    AND property_id IN (
      SELECT p.id FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
    )
  )
  WITH CHECK (
    get_my_role() = 'company_admin'
    AND property_id IN (
      SELECT p.id FROM public.properties p
       WHERE lower(trim(p.company)) = lower(trim(get_my_company()))
    )
  );

-- 🔴 Exact lower(trim()) on the company match, not ILIKE. The DNT
-- template and most sibling policies use `~~*`, which treats the
-- caller's own company name as a PATTERN; the user_roles metacharacter
-- CHECKs make that latent rather than live, but a new policy has no
-- reason to inherit it.

REVOKE ALL ON public.property_plate_prohibitions FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.property_plate_prohibitions TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.property_plate_prohibitions_id_seq TO authenticated;

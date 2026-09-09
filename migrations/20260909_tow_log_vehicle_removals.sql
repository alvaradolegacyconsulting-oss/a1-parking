-- ══════════════════════════════════════════════════════════════════════
-- 20260909_tow_log_vehicle_removals.sql
--
-- 🟢 Tow Log arc — COMMIT 3 of N. Two tables:
--     • public.vehicle_removals       — the tow record (parent)
--     • public.vehicle_removal_media  — evidence attachments (child)
--
-- NO RPCs in this commit — those land in Commit 4. This is tables,
-- constraints, indexes, trigger, RLS, and grants only. Nothing writes
-- to either table from the app until Commit 4 ships. Commit 4's DEFINER
-- RPCs own all writes; SELECT-only grants here are the append/mutate
-- enforcement.
--
-- ── DOMAIN — WHAT THESE TABLES RECORD ──────────────────────────────
-- vehicle_removals is the property's legal-defense record of a tow.
-- A mis-entered row is corrected by VOID, never DELETE — a tow is a
-- physical event that happened, and the file that defends the property
-- should not have holes in it. Same shape as `space_payments`
-- (three-column void coherence CHECK verbatim).
--
-- vehicle_removal_media is where photos + the tow ticket + receipts
-- attach. ON DELETE RESTRICT to the parent — removals are never
-- deleted, so a cascade path shouldn't exist to be found later.
-- Soft-delete columns match the violation_photos convention exactly
-- (removed_at + removed_by_email + removed_by_role + removal_reason).
--
-- ── 🔴 THE SNAPSHOT PRINCIPLE (same as space_payments) ─────────────
-- Snapshots are the record; references are conveniences. Every
-- "snapshot" column captured at INSERT time (property, operator_name,
-- operator_phone, plate_state, make/model/color, authorized_by_email,
-- authorized_by_name) stays FOREVER alongside any future FK.
-- Converting a snapshot to an FK-only reference silently rewrites
-- history when the referenced row renames or reassigns — that is the
-- exact value-join drift class the design refuses (see
-- project_fk_property_id_migration).
--
-- Concrete consequences here:
--   • tow_operator_id has ON DELETE SET NULL — if the FK is ever lost
--     to a future migration or a service_role hard-delete, the
--     operator_name + operator_phone snapshots still tell the story.
--   • linked_vehicle_id is a soft link resolved at WRITE time (in
--     Commit 4's create RPC), never JOINed on read. If the vehicles
--     row is later renamed/deactivated/reassigned, the removal record
--     still describes the vehicle towed via its own make/model/color/
--     plate columns.
--   • operator_name is NOT NULL. Even if tow_operator_id is NULL
--     (unlisted operator called inline), the name is captured verbatim.
--
-- ── VOID, NOT DELETE ───────────────────────────────────────────────
-- vehicle_removals_void_coherence CHECK verbatim from
-- space_payments_void_coherence — all-null OR all-set. Enforces that a
-- half-voided write (voided_at set, void_reason left NULL) can't land
-- at the schema level. Commit 4's void RPC sets the triple atomically;
-- this CHECK guards the invariant against any future writer that
-- forgets one field.
--
-- ── 🔴 MANAGER SCOPE DIVERGES BETWEEN THE TWO TOW-LOG TABLES ───────
-- Deliberate, and worth stating in the header so a future "unify all
-- RLS" sweep doesn't collapse them:
--
--   tow_operators (Commit 2)     — MANAGER sees own-COMPANY rows.
--                                   Operators are the company's
--                                   address book; they serve every
--                                   property the company manages.
--   vehicle_removals (this)      — MANAGER sees own-PROPERTY rows via
--                                   get_my_properties(). Removals are
--                                   property events; a manager at one
--                                   property does not need to see
--                                   another property's tow log.
--
-- CA and admin both see the whole company / everything respectively —
-- same as every other table in this arc.
--
-- ── 🔴 CROSS-TABLE EXISTS TRAP — vehicle_removal_media RLS ─────────
-- vehicle_removal_media scopes THROUGH its parent via an EXISTS
-- subquery against vehicle_removals. The subquery evaluates as the
-- caller, which means:
--
--   • authenticated MUST hold table-level SELECT on vehicle_removals
--     (it will — this migration grants exactly that).
--   • RLS on vehicle_removals filters the subquery, so a media row
--     with a parent the caller can't see returns 0 rows.
--
-- 🔴 This is the same predicate class that broke the proposal-PDF
-- policy (September 7 remediation). Filed as
-- feedback_permissive_wildcard_hides_scoped_policies. It works here
-- because (a) no wildcard SELECT policy is up on this table and (b)
-- the authenticated grant that the EXISTS subquery relies on is
-- itself scoped to public.vehicle_removals — no other table needs
-- reading. If a future sweep introduces a permissive-OR policy on
-- storage.objects that reads a vehicle_removals row, revisit.
--
-- ── 🔴 THREE PLATE NORMALIZERS EXIST — READ THIS BEFORE CLEANING UP
--
-- Three normalizers ship in this codebase; they disagree, and the
-- disagreement is load-bearing. Cleaning them up to one form is a
-- coordinated arc, not a one-liner:
--
--   Client normalizePlate           — [^A-Z0-9] + uppercase.
--     app/lib/plate.ts:7-10           Strips all non-alphanumerics.
--                                     UI onChange + client pre-write.
--                                     vehicles.plate values arrive
--                                     through this on write.
--
--   Server normalize_plate()        — \s + uppercase.
--     20260703_slice5_plate_          Whitespace only. IMMUTABLE, backs
--     normalize_fn.sql:44-50          the vehicles_plate_norm_uniq
--                                     partial index. Deliberately
--                                     narrower — dashes stay.
--
--   dnt_plate_normalize() trigger   — [^A-Za-z0-9] + uppercase.
--     20260723_do_not_tow_plates       Table-scoped floor on
--     .sql:115-131                    do_not_tow_plates. Matches the
--                                     client's aggressive strip.
--
-- FOR THIS TABLE:
--   • Client sends alphanumeric-only via normalizePlate.
--   • vehicle_removal_plate_normalize() (this migration, PART 3) is
--     the FLOOR — catches slips, uses the aggressive alphanumeric
--     strip. Mirrors dnt_plate_normalize exactly.
--   • Index expression uses normalize_plate(plate) — the whitespace-
--     only server function. On an already-alphanumeric-only value it
--     is a no-op canonicalization, and keeping the index expression
--     identical to vehicles_plate_norm_uniq means both sides of the
--     linked_vehicle_id soft-link comparison read the same.
--
-- 🔴 The trigger is a floor, not the mechanism. Any future sweep
-- that "consolidates" plate normalizers must update: the client
-- normalizePlate, pm_plate_lookup (which uses [^A-Za-z0-9] on both
-- sides today), the server normalize_plate() (currently whitespace-
-- only, backs vehicles unique index), AND this trigger — together,
-- in one arc, with fresh smoke on the soft-link resolution. Picking
-- one form and applying it in one place breaks the linked_vehicle_id
-- silent — a resident sitting right there won't match. Follow-up
-- notes in 20260703_slice5_plate_normalize_fn.sql:30-34.
--
-- ── authorized_by_email vs recorded_by_email ───────────────────────
-- authorized_by_email  = who on the property MADE THE CALL. NOT NULL.
--                        Defaults to the caller in Commit 4's create
--                        RPC. Statement of fact — NOT validated
--                        against user_roles (a courtesy officer, an
--                        owner, an after-hours contact all authorize
--                        without necessarily having a system account).
-- authorized_by_name   = optional human name when the authorizer has
--                        no account. NULL when the caller is also
--                        the authorizer.
-- recorded_by_email    = who TYPED IT. Server-side from auth.jwt();
--                        forge-proof. In the common case identical to
--                        authorized_by_email; in the case the split
--                        exists for (courtesy officer at 11:40pm,
--                        manager types it up Monday), they diverge.
--
-- Both are TEXT snapshots. No FK to auth.users — same reason as
-- audit_logs.user_email: attribution survives the user row.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- Report-first → eyeball → apply (Jose) → verify → push.
-- One BEGIN/COMMIT. Verification is a companion _verification file —
-- STRUCTURAL gates only, no execution assertions. Execution gates for
-- this commit + Commit 2's E1-E11 land together in one empirical pass
-- after Jose runs the Commit 2 runbook.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- PART 1 — public.vehicle_removals table
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.vehicle_removals (
  id                    BIGSERIAL     PRIMARY KEY,

  -- Scope + snapshot. company is the PM/enforcement subscriber that
  -- owns the record. Populated server-side from get_my_company() in
  -- Commit 4's create RPC; never accepted from client input.
  company               TEXT          NOT NULL,

  -- Snapshot columns (see header §SNAPSHOT PRINCIPLE).
  property              TEXT          NOT NULL,
  property_id           BIGINT        NULL,       -- soft reference; snapshot is the record

  -- Removal shape.
  removal_type          TEXT          NOT NULL DEFAULT 'tow',
  plate                 TEXT          NOT NULL,   -- normalized by trigger (PART 3)
  plate_state           TEXT          NULL,
  make                  TEXT          NULL,
  model                 TEXT          NULL,
  color                 TEXT          NULL,

  -- Soft link: resolved by Commit 4's create RPC via
  -- normalize_plate(plate) against vehicles at write time. Never
  -- JOINed on read; if the vehicles row is later renamed or
  -- deactivated, the snapshot columns above still describe the tow.
  linked_vehicle_id     BIGINT        NULL,

  -- Reason: TOW_REASONS canonical enum lives in app/lib/tow-reasons.ts.
  -- NOT enforced by SQL CHECK — the enum evolves faster than a
  -- migration cycle can catch up, and the human is more forgiving
  -- than a constraint violation. The RPC in Commit 4 validates
  -- against the current enum before insert; historical rows with a
  -- retired reason_code stay valid records of what happened.
  reason_code           TEXT          NOT NULL,
  reason_notes          TEXT          NULL,

  -- Optional space context (reserved-space enforcement).
  space_id              BIGINT        NULL,

  -- Physical event vs. record-entry timeline. See header — the lead
  -- photographs the car Saturday at 11:40pm and may not finish the
  -- record until Monday. Collapsing towed_at into created_at puts the
  -- wrong timeline in the one artifact that exists to defend the
  -- property.
  towed_at              TIMESTAMPTZ   NOT NULL,

  -- Authorization: who made the call (statement of fact, NOT auth
  -- check). Defaults to the caller in Commit 4's create RPC.
  authorized_by_email   TEXT          NOT NULL,
  -- Optional human name when the authorizer has no system account
  -- (courtesy officer, owner, after-hours contact). NULL when the
  -- authorizer is the caller.
  authorized_by_name    TEXT          NULL,

  -- Tow operator: FK reference + snapshot pair.
  -- ON DELETE SET NULL: snapshot preserves the record if the FK is
  -- lost. tow_operators discipline is deactivate-not-delete (Commit
  -- 2), so this rarely fires in normal ops.
  tow_operator_id       BIGINT        NULL
    REFERENCES public.tow_operators(id) ON DELETE SET NULL,
  operator_name         TEXT          NOT NULL,   -- snapshot; NEVER null even when tow_operator_id is null (unlisted operator)
  operator_phone        TEXT          NULL,       -- snapshot

  -- Bookkeeping.
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- Server-side from auth.jwt() ->> 'email' in Commit 4's RPC.
  -- Forge-proof (see feedback_last_write_wins_race_on_state_fetch
  -- for why client-supplied attribution is a landmine).
  recorded_by_email     TEXT          NOT NULL,

  -- Void triple. See vehicle_removals_void_coherence CHECK below.
  voided_at             TIMESTAMPTZ   NULL,
  voided_by_email       TEXT          NULL,
  void_reason           TEXT          NULL,

  -- ── CHECKs ─────────────────────────────────────────────────────
  -- removal_type: `tow` is the v1 path. `boot` + `relocation` reserve
  -- the shape without a later migration.
  CONSTRAINT vehicle_removals_type_valid
    CHECK (removal_type IN ('tow', 'boot', 'relocation')),

  -- Void coherence: verbatim from space_payments_void_coherence.
  -- Either all three fields set (voided) or all three NULL (active).
  CONSTRAINT vehicle_removals_void_coherence
    CHECK (
      (voided_at IS NULL AND voided_by_email IS NULL AND void_reason IS NULL)
      OR
      (voided_at IS NOT NULL AND voided_by_email IS NOT NULL AND void_reason IS NOT NULL)
    )
);

COMMENT ON TABLE public.vehicle_removals IS
  '2026-09-09 Tow Log Commit 3. Legal-defense record of a vehicle removal (tow / boot / relocation). VOID never DELETE — a tow is a physical event that happened. Snapshot columns (property, operator_name, operator_phone, make/model/color/plate_state, authorized_by_email/name) are THE record; FKs are conveniences. linked_vehicle_id is a soft link resolved at write time — never JOINed on read. Writes ONLY via Commit 4 DEFINER RPCs (create_vehicle_removal, void_vehicle_removal). RLS is manager-per-property (unlike tow_operators which is company-wide — deliberate divergence, see migration header).';

COMMENT ON COLUMN public.vehicle_removals.plate IS
  'Alphanumeric-only after trigger (mirror of dnt_plate_normalize shape). Client sends via normalizePlate; trigger is the floor. Index uses normalize_plate() for canonicalization consistent with vehicles_plate_norm_uniq. See migration header §THREE PLATE NORMALIZERS.';

COMMENT ON COLUMN public.vehicle_removals.authorized_by_email IS
  'Who on the property MADE THE CALL. Statement of fact — NOT validated against user_roles. A courtesy officer, an owner, an after-hours contact all authorize without necessarily having a system account. Distinct from recorded_by_email (who TYPED IT — server-side from auth.jwt(), forge-proof).';

COMMENT ON COLUMN public.vehicle_removals.authorized_by_name IS
  'Optional human name when the authorizer has no system account. NULL when the authorizer is the caller (common case).';

COMMENT ON COLUMN public.vehicle_removals.operator_name IS
  'Snapshot of tow_operators.name at write time. NOT NULL even when tow_operator_id is NULL (unlisted operator called inline). If the referenced operator is later renamed or the FK is lost via ON DELETE SET NULL, this column still tells the story.';

COMMENT ON COLUMN public.vehicle_removals.towed_at IS
  'Timestamp of the PHYSICAL event (when the car was towed). Distinct from created_at (when the record was entered). Split deliberately: the lead may photograph Saturday and finalize the record Monday.';


-- ══════════════════════════════════════════════════════════════════════
-- PART 2 — vehicle_removals indexes
-- ══════════════════════════════════════════════════════════════════════
-- Plate lookup by company: Monday-morning "was this car towed?" search.
-- Expression identical to vehicles_plate_norm_uniq's normalize_plate()
-- call so both sides of the linked_vehicle_id soft-link read the same.
CREATE INDEX IF NOT EXISTS vehicle_removals_plate_lookup
  ON public.vehicle_removals (lower(trim(company)), normalize_plate(plate));

-- Property list view: ordered by physical-event time descending.
CREATE INDEX IF NOT EXISTS vehicle_removals_property_towed_at
  ON public.vehicle_removals (lower(trim(property)), towed_at DESC);


-- ══════════════════════════════════════════════════════════════════════
-- PART 3 — Plate normalizer function + trigger
-- ══════════════════════════════════════════════════════════════════════
-- Function body identical to dnt_plate_normalize (mirror shape).
-- SECURITY DEFINER + SET search_path = public per design spec — the
-- trigger is a pure computation, but the DEFINER context defends
-- against a hostile search_path if a future writer bypasses the
-- Commit 4 RPCs and INSERTs directly (currently impossible via grant,
-- but the belt-and-suspenders is cheap).
CREATE OR REPLACE FUNCTION public.vehicle_removal_plate_normalize()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
  -- Aggressive alphanumeric strip. Matches the client's normalizePlate
  -- character set (see migration header §THREE PLATE NORMALIZERS).
  NEW.plate := UPPER(regexp_replace(COALESCE(NEW.plate, ''), '[^A-Za-z0-9]', '', 'g'));
  IF NEW.plate = '' THEN
    RAISE EXCEPTION 'vehicle_removals.plate cannot be empty after normalization (only alphanumeric chars kept)'
      USING ERRCODE = '22004',
            HINT    = 'Provide a plate value containing at least one letter or digit.';
  END IF;
  RETURN NEW;
END;
$func$;

-- BEFORE INSERT OR UPDATE OF plate: fires on any write that touches
-- the plate column. Matches dnt_plate_normalize_trigger shape.
DROP TRIGGER IF EXISTS vehicle_removal_plate_normalize_trigger ON public.vehicle_removals;
CREATE TRIGGER vehicle_removal_plate_normalize_trigger
  BEFORE INSERT OR UPDATE OF plate ON public.vehicle_removals
  FOR EACH ROW
  EXECUTE FUNCTION public.vehicle_removal_plate_normalize();


-- ══════════════════════════════════════════════════════════════════════
-- PART 4 — vehicle_removals GRANTS (writes via DEFINER RPCs only)
-- ══════════════════════════════════════════════════════════════════════
-- SELECT only for authenticated. All INSERT/UPDATE via Commit 4 RPCs.
-- Attribution unforgeable via auth.jwt() ->> 'email' inside the RPC.
REVOKE ALL ON public.vehicle_removals FROM PUBLIC;
REVOKE ALL ON public.vehicle_removals FROM anon;
REVOKE ALL ON public.vehicle_removals FROM authenticated;
GRANT  SELECT ON public.vehicle_removals TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- PART 5 — vehicle_removals RLS (3 policies)
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.vehicle_removals ENABLE ROW LEVEL SECURITY;
-- No FORCE ROW LEVEL SECURITY: service_role bypass required for
-- Commit 4 DEFINER RPC bodies + probe/cleanup ops.

-- admin — full visibility
DROP POLICY IF EXISTS "admin_all_vehicle_removals" ON public.vehicle_removals;
CREATE POLICY "admin_all_vehicle_removals" ON public.vehicle_removals
  FOR SELECT TO authenticated
  USING ((SELECT get_my_role()) = 'admin'::text);

-- CA — own-company scope. Equality via lower(trim), NEVER ~~*.
DROP POLICY IF EXISTS "ca_own_vehicle_removals" ON public.vehicle_removals;
CREATE POLICY "ca_own_vehicle_removals" ON public.vehicle_removals
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'company_admin'::text
    AND lower(trim(company)) = lower(trim((SELECT get_my_company())))
  );

-- Manager — PROPERTY-scoped (diverges from tow_operators company-wide
-- scope, deliberately — see migration header §MANAGER SCOPE DIVERGES).
DROP POLICY IF EXISTS "manager_own_vehicle_removals" ON public.vehicle_removals;
CREATE POLICY "manager_own_vehicle_removals" ON public.vehicle_removals
  FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'manager'::text
    AND lower(trim(property)) = ANY (
      SELECT lower(trim(p)) FROM unnest(get_my_properties()) AS p
    )
  );

-- driver + resident + leasing_agent: no policy = SELECT returns 0
-- rows (RLS filters, doesn't throw — feedback_rls_denials_return_
-- empty_not_error). Tow-log data is manager-and-above only in v1.


-- ══════════════════════════════════════════════════════════════════════
-- PART 6 — public.vehicle_removal_media table
-- ══════════════════════════════════════════════════════════════════════
-- ON DELETE RESTRICT to the parent — vehicle_removals are never
-- DELETE'd (void is the correction path). If somehow a hard-delete
-- attempt reaches the parent (service_role bypass, direct SQL), the
-- FK blocks so orphan media doesn't accumulate. A CASCADE path would
-- give a would-be deleter the illusion of a clean removal.
CREATE TABLE IF NOT EXISTS public.vehicle_removal_media (
  id                BIGSERIAL     PRIMARY KEY,
  removal_id        BIGINT        NOT NULL
    REFERENCES public.vehicle_removals(id) ON DELETE RESTRICT,

  -- 🔴 PATH, not URL. The violation_photos convention (photo_url =
  -- full public CDN URL) is exactly why switching that bucket to
  -- private would require a column migration. Storing the path
  -- decouples the record from any specific URL scheme; retrieval is
  -- a signed URL from a server route (Commit 4).
  storage_path      TEXT          NOT NULL,

  kind              TEXT          NOT NULL,   -- CHECK below

  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by_email  TEXT          NOT NULL,   -- server-side from auth.jwt()

  -- Soft-delete columns — verbatim from violation_photos convention.
  -- removed_at here CORRECTLY means soft-delete of THIS ROW (the
  -- media attachment), not the physical tow event. The parent uses
  -- towed_at for the physical event; the two meanings live on
  -- different tables and don't collide.
  removed_at        TIMESTAMPTZ   NULL,
  removed_by_email  TEXT          NULL,
  removed_by_role   TEXT          NULL,
  removal_reason    TEXT          NULL,

  -- Kind: v1 whitelisted set. `photo` for evidence images, `ticket`
  -- for the tow ticket PDF Commit N will generate, `receipt` for
  -- operator receipts.
  CONSTRAINT vehicle_removal_media_kind_valid
    CHECK (kind IN ('photo', 'ticket', 'receipt'))
);

COMMENT ON TABLE public.vehicle_removal_media IS
  '2026-09-09 Tow Log Commit 3. Evidence attachments for vehicle_removals. ON DELETE RESTRICT to parent (removals are never DELETE''d). storage_path stores the bucket path, NEVER a URL — signed URLs come from a server route. Soft-delete via removed_at/removed_by_email/removed_by_role/removal_reason (violation_photos convention verbatim). Writes ONLY via Commit 4 DEFINER RPCs; SELECT scoped via parent RLS (see EXISTS subquery in PART 9). RLS delegation depends on authenticated holding SELECT on vehicle_removals — this migration grants it.';

COMMENT ON COLUMN public.vehicle_removal_media.storage_path IS
  'Bucket-relative path (e.g. "<property_id>/<removal_id>/photo1.jpg"). NEVER a full URL. Retrieval is a signed URL from a server route in Commit 4. Compare violation_photos.photo_url (full CDN URL) — that column is why switching that bucket to private would need a column migration; this design avoids that trap.';


-- ══════════════════════════════════════════════════════════════════════
-- PART 7 — vehicle_removal_media indexes
-- ══════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS vehicle_removal_media_removal_id
  ON public.vehicle_removal_media (removal_id);


-- ══════════════════════════════════════════════════════════════════════
-- PART 8 — vehicle_removal_media GRANTS
-- ══════════════════════════════════════════════════════════════════════
REVOKE ALL ON public.vehicle_removal_media FROM PUBLIC;
REVOKE ALL ON public.vehicle_removal_media FROM anon;
REVOKE ALL ON public.vehicle_removal_media FROM authenticated;
GRANT  SELECT ON public.vehicle_removal_media TO authenticated;


-- ══════════════════════════════════════════════════════════════════════
-- PART 9 — vehicle_removal_media RLS (scoped via parent EXISTS)
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.vehicle_removal_media ENABLE ROW LEVEL SECURITY;

-- Single SELECT policy delegating to the parent's RLS. The EXISTS
-- subquery evaluates as the caller (RLS applies to vehicle_removals),
-- so a media row with a parent the caller can't see resolves to
-- EXISTS = FALSE.
--
-- Dependencies:
--   1. authenticated has table-level SELECT grant on
--      vehicle_removals (PART 4 above).
--   2. vehicle_removals has RLS + 3 SELECT policies (PART 5).
--
-- 🔴 If either dependency is later removed or a permissive-OR
-- wildcard policy is introduced on vehicle_removals, this delegation
-- pattern silently over-shares (feedback_permissive_wildcard_hides_
-- scoped_policies). Retest after any policy change on the parent.
DROP POLICY IF EXISTS "scoped_via_parent_vehicle_removal_media" ON public.vehicle_removal_media;
CREATE POLICY "scoped_via_parent_vehicle_removal_media" ON public.vehicle_removal_media
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.vehicle_removals vr
       WHERE vr.id = vehicle_removal_media.removal_id
    )
  );


-- ══════════════════════════════════════════════════════════════════════
-- PART 10 — Schema audit row
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_TOW_LOG_VEHICLE_REMOVALS',
  'public.vehicle_removals',
  'commit_3_of_N',
  jsonb_build_object(
    'migration',           '20260909_tow_log_vehicle_removals',
    'arc',                 'Tow Log Commit 3 — vehicle_removals + vehicle_removal_media (tables/RLS/indexes/trigger/grants only; NO RPCs)',
    'depends_on',          jsonb_build_array(
      'Commit 1 (d1a2d48) — vehicle-removal-photos bucket + storage.objects RLS',
      'Commit 2 (e7d5ccb) — tow_operators table + 3 DEFINER RPCs'
    ),
    'schema_changes',      jsonb_build_array(
      'CREATED TABLE public.vehicle_removals (25 cols, 2 CHECKs including verbatim space_payments_void_coherence, 1 FK to tow_operators ON DELETE SET NULL)',
      'CREATED 2 indexes on vehicle_removals (plate_lookup + property_towed_at)',
      'CREATED FUNCTION public.vehicle_removal_plate_normalize (SECURITY DEFINER, alphanumeric-strip mirror of dnt_plate_normalize)',
      'CREATED TRIGGER vehicle_removal_plate_normalize_trigger BEFORE INSERT OR UPDATE OF plate ON vehicle_removals',
      'ENABLED RLS + 3 SELECT policies on vehicle_removals (admin_all / ca_own / manager_own — manager PROPERTY-scoped, not company-wide)',
      'CREATED TABLE public.vehicle_removal_media (10 cols, 1 CHECK, 1 FK to vehicle_removals ON DELETE RESTRICT)',
      'CREATED 1 index on vehicle_removal_media (removal_id)',
      'ENABLED RLS + 1 SELECT policy on vehicle_removal_media (scoped-via-parent EXISTS)',
      'REVOKED all writes from PUBLIC/anon/authenticated on both tables; GRANTED SELECT ONLY to authenticated (writes via Commit 4 DEFINER RPCs)'
    ),
    'snapshot_principle',  'Snapshots ARE the record; FKs are conveniences. tow_operator_id ON DELETE SET NULL — snapshot preserves the record if FK is lost. linked_vehicle_id is a soft link, resolved at write, NEVER JOINed on read. operator_name NOT NULL even when tow_operator_id is NULL (unlisted operator called inline).',
    'manager_scope_diverges', 'tow_operators (Commit 2) = MANAGER sees own-COMPANY rows (address book). vehicle_removals (this) = MANAGER sees own-PROPERTY rows via get_my_properties() (property events). Deliberate divergence; do NOT unify in a future RLS sweep.',
    'cross_table_exists_trap', 'vehicle_removal_media SELECT policy uses EXISTS against vehicle_removals. Subquery evaluates as the caller. Works only because authenticated has SELECT on vehicle_removals (granted here) AND no wildcard SELECT policy is up on vehicle_removals. If a future sweep introduces a permissive-OR policy on the parent, retest — this is the same class that broke proposal-PDF on Sept 7.',
    'plate_normalizer_floor', 'Trigger is a FLOOR, not the mechanism. Three normalizers exist (client normalizePlate [^A-Z0-9], server normalize_plate() \\s, dnt_plate_normalize [^A-Za-z0-9]). vehicle_removal_plate_normalize mirrors dnt_plate_normalize — alphanumeric strip. Consolidating them is a coordinated arc across client + pm_plate_lookup + server + this trigger; do NOT unilaterally normalize one and break the linked_vehicle_id soft link.',
    'authorized_vs_recorded', 'authorized_by_email = who MADE THE CALL (statement of fact, NOT auth-check; a courtesy officer / owner / after-hours contact all authorize). authorized_by_name = optional when authorizer has no account. recorded_by_email = who TYPED IT (server-side from auth.jwt(), forge-proof).',
    'void_not_delete',     'vehicle_removals_void_coherence CHECK verbatim from space_payments_void_coherence. Mis-entered rows corrected by void, never delete — tow records are legal defense; the file should not have holes.',
    'no_rpcs_yet',         'Commit 4 lands 2 DEFINER RPCs (create_vehicle_removal, void_vehicle_removal) + 1 signed-URL helper for media retrieval. Until then this table pair is inert (SELECT-only, no writers).',
    'execution_gates',     'Deferred to the empirical pass with Commit 2 E1-E11.'
  ),
  now()
);


-- ══════════════════════════════════════════════════════════════════════
-- PART 11 — PostgREST schema cache reload
-- ══════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';

COMMIT;

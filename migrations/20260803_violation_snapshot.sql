-- ══════════════════════════════════════════════════════════════════════
-- 20260803_violation_snapshot.sql
-- Pass snapshot onto the violation record — Green Acres arc close
-- ══════════════════════════════════════════════════════════════════════
--
-- Depends on: 0efa235 (composite display), f4b7d28 (modal copy).
-- Motivation: composite made the driver's knowledge visible; snapshot
-- makes it durable. A violation issued while a live visitor pass
-- existed should carry a record OF that pass, so the artifact a
-- dispute turns on can answer "what did the driver know when they
-- decided?" for the record — not just "what reason did they pick."
--
-- ── LOCKED DECISIONS (Mateo, 2026-08-02) ──────────────────────────────
--
-- 1. Shape: child table (violation_context_records), NOT JSONB.
--    Follows the existing violations pattern (typed columns for
--    single-value data; child tables for arrays — violation_photos,
--    violation_videos). Pass snapshot is inherently 1-to-many.
--
-- 2. Atomicity: RPC-based INSERT with EXPLICIT fallback that never
--    blocks the tow. Physical tow happens regardless of software;
--    blocking violation creation to protect evidence quality gets
--    the priority backwards. The `snapshot_status` column makes the
--    fallback path queryable (`failed` != `none_present`).
--
-- 3. `headline_status_at_scan` on the parent violations row (one
--    per scan; denormalizing to N child rows invites drift).
--
-- 4. `was_live_at_scan` on child rows means:
--    "was this record in force as a protective state at scan time"
--    - visitor_pass_live: TRUE
--    - visitor_pass_recently_expired: FALSE
--    - guest_auth (within date window): TRUE
--    - vehicle_pending: TRUE (pending is protective; see the composite
--      arc's cascade discipline in feedback_pending_vs_decided_no.md)
--    - vehicle_declined/expired: FALSE
--    - do_not_tow / vehicle_active / authorized_plate / plate_under_
--      review: TRUE
--    Definition matters because "live" does different work per record
--    type; without the comment, a future reader guesses and guesses
--    differently.
--
-- 5. CHECK constraint on record_type: kept even though it means a
--    migration per new type. Making new types a deliberate act is a
--    feature — the composite discipline (declared types match the
--    CompositeRecord union in app/driver/page.tsx) is the invariant.
--
-- 6. No backfill. Violations issued before this ships have NULL
--    snapshot_status — genuinely no snapshot possible. Distinguishable
--    from `none_present` (RPC ran, nothing was present) and `failed`
--    (RPC broke, direct-insert fallback used).
--
-- 7. `authorizedDetail` retired from the decline modal (confirmed
--    display-only, never persisted — see f4b7d28 review). Guest
--    `non_resident_reason` reconstructable via snapshot →
--    guest_authorizations join for dispute purposes.
--
-- ── SNAPSHOT_STATUS SEMANTICS ─────────────────────────────────────────
--
--   captured     — RPC succeeded; snapshot rows exist
--   none_present — RPC succeeded; no protective records at scan time
--   failed       — RPC failed; direct-insert fallback used, snapshot
--                  gap is EXPLICIT (queryable for reconciliation)
--   NULL         — Pre-feature row; snapshot never possible
--
-- Four distinguishable states; no ambiguity; failure never looks like
-- clean absence. This closes the class of bug the composite arc has
-- been battling (RLS-empty vs error, revoked-as-live, silent-403,
-- ignored-.ok).
--
-- ── JOSE PRE-APPLY ────────────────────────────────────────────────────
--
-- No diagnostic needed — this is purely additive. New nullable column
-- on violations; new table; new RPC. Zero data mutation on existing
-- rows.
--
-- Paste WHOLE. Single-transaction wrap; single Supabase-editor paste.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. violations parent — new columns ───────────────────────────────
ALTER TABLE public.violations
  ADD COLUMN IF NOT EXISTS scanned_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS headline_status_at_scan TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_status         TEXT
    CHECK (snapshot_status IS NULL OR snapshot_status IN ('captured','none_present','failed'));

COMMENT ON COLUMN public.violations.scanned_at IS
  'Client-provided ISO timestamp of when the driver saw the plate on their scan card. Distinct from created_at (server insert time). Nullable — pre-2026-08-03 violations have no snapshot.';

COMMENT ON COLUMN public.violations.headline_status_at_scan IS
  'The plate_status the driver saw as the HEADLINE at scan time (authorized / pending / declined / etc). One per violation; denormalizing to violation_context_records rows invites drift.';

COMMENT ON COLUMN public.violations.snapshot_status IS
  'captured=RPC succeeded with children; none_present=RPC succeeded with no children; failed=RPC broke, direct-insert fallback used (evidence gap explicit); NULL=pre-feature.';

-- ── 2. violation_context_records child table ─────────────────────────
CREATE TABLE IF NOT EXISTS public.violation_context_records (
  id                BIGSERIAL   PRIMARY KEY,
  violation_id      INT         NOT NULL REFERENCES public.violations(id) ON DELETE CASCADE,
  record_type       TEXT        NOT NULL CHECK (record_type IN (
    'visitor_pass_live',
    'visitor_pass_recently_expired',
    'guest_auth',
    'do_not_tow',
    'vehicle_active',
    'authorized_plate',
    'vehicle_pending',
    'vehicle_declined',
    'vehicle_expired',
    'plate_under_review'
  )),
  source_id         TEXT,                 -- nullable: DNT + authorized_plate RPCs don't return an id
  expires_at        TIMESTAMPTZ,          -- visitor passes (live + recently_expired)
  start_date        DATE,                 -- guest_auth
  end_date          DATE,                 -- guest_auth
  was_live_at_scan  BOOLEAN     NOT NULL, -- see header block for semantics per record_type
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  -- No plate column (on parent violations.plate). NO PII per B225:
  -- no visitor_name, no vehicle_*, no visiting_unit, no non_resident_reason.
);

CREATE INDEX IF NOT EXISTS violation_context_records_violation_id_idx
  ON public.violation_context_records (violation_id);
CREATE INDEX IF NOT EXISTS violation_context_records_live_type_idx
  ON public.violation_context_records (record_type)
  WHERE was_live_at_scan;

COMMENT ON TABLE public.violation_context_records IS
  '2026-08-03 — Pass snapshot per violation. One row per protective record present at scan time (visitor pass, guest auth, pending vehicle, etc). Written atomically with the parent violation via driver_create_violation_with_snapshot RPC; on RPC failure, direct-insert fallback sets violations.snapshot_status=failed and this table is empty (evidence gap explicit).';

-- ── 3. RLS enable + policies ─────────────────────────────────────────
ALTER TABLE public.violation_context_records ENABLE ROW LEVEL SECURITY;

-- Deny writes to all client roles. INSERTs happen only via the DEFINER
-- RPC below. Updates + deletes never allowed on evidence records.
DROP POLICY IF EXISTS "violation_context_records_no_client_write"
  ON public.violation_context_records;

-- Manager + CA + admin SELECT — scope inherited from the parent
-- violations row. Pattern parallels violation_photos read policies.
DROP POLICY IF EXISTS "manager_read_violation_context"
  ON public.violation_context_records;
CREATE POLICY "manager_read_violation_context"
  ON public.violation_context_records FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) IN ('manager', 'leasing_agent')
    AND EXISTS (
      SELECT 1 FROM public.violations v
       WHERE v.id = violation_context_records.violation_id
         AND v.property ~~* ANY (SELECT unnest(get_my_properties()))
    )
  );

DROP POLICY IF EXISTS "company_admin_read_violation_context"
  ON public.violation_context_records;
CREATE POLICY "company_admin_read_violation_context"
  ON public.violation_context_records FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'company_admin'
    AND EXISTS (
      SELECT 1 FROM public.violations v
       WHERE v.id = violation_context_records.violation_id
         AND v.property IN (
           SELECT properties.name FROM properties
            WHERE properties.company ~~* (SELECT get_my_company())
         )
    )
  );

DROP POLICY IF EXISTS "admin_read_violation_context"
  ON public.violation_context_records;
CREATE POLICY "admin_read_violation_context"
  ON public.violation_context_records FOR SELECT TO authenticated
  USING ((SELECT get_my_role()) = 'admin');

-- Driver SELECT — only their own submissions (via driver_name join
-- match; pattern parallels violation_photos driver-read policy).
DROP POLICY IF EXISTS "driver_read_own_violation_context"
  ON public.violation_context_records;
CREATE POLICY "driver_read_own_violation_context"
  ON public.violation_context_records FOR SELECT TO authenticated
  USING (
    (SELECT get_my_role()) = 'driver'
    AND EXISTS (
      SELECT 1 FROM public.violations v
       WHERE v.id = violation_context_records.violation_id
         AND lower(v.driver_email) = lower(auth.jwt() ->> 'email')
    )
  );

REVOKE ALL ON TABLE public.violation_context_records FROM anon;
GRANT SELECT ON TABLE public.violation_context_records TO authenticated;

-- ── 4. DEFINER RPC — driver_create_violation_with_snapshot ───────────
-- Atomic: parent INSERT + N child INSERTs in one transaction.
-- On any error, entire transaction rolls back; caller falls back to
-- direct-insert with snapshot_status='failed' (see driver/page.tsx
-- submitViolation).
--
-- p_violation: jsonb payload matching violations row shape (all
--   INSERTable fields; DEFAULT columns like id/created_at/is_confirmed
--   auto-populate). scanned_at + headline_status_at_scan REQUIRED.
--   snapshot_status set BY THIS RPC (never by caller).
--
-- p_snapshot: jsonb array of {record_type, source_id?, expires_at?,
--   start_date?, end_date?, was_live_at_scan} objects. Empty array is
--   valid — parent gets snapshot_status='none_present'.
--
-- RETURNS jsonb: {ok: bool, id: int, snapshot_status: text} or
--                {error: text}.

CREATE OR REPLACE FUNCTION public.driver_create_violation_with_snapshot(
  p_violation JSONB,
  p_snapshot  JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $rpc$
DECLARE
  v_role            TEXT;
  v_violation_id    INT;
  v_snapshot_status TEXT;
  v_record          JSONB;
  v_snapshot_count  INT;
BEGIN
  -- Auth check
  v_role := (SELECT get_my_role());
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  IF v_role NOT IN ('driver', 'company_admin', 'admin') THEN
    RETURN jsonb_build_object('error', 'role_not_authorized');
  END IF;

  -- Input validation
  IF p_violation IS NULL OR jsonb_typeof(p_violation) <> 'object' THEN
    RETURN jsonb_build_object('error', 'p_violation must be a jsonb object');
  END IF;
  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'array' THEN
    RETURN jsonb_build_object('error', 'p_snapshot must be a jsonb array (may be empty)');
  END IF;
  IF NOT p_violation ? 'scanned_at' OR NOT p_violation ? 'headline_status_at_scan' THEN
    RETURN jsonb_build_object('error', 'p_violation missing required scanned_at or headline_status_at_scan');
  END IF;
  IF NOT p_violation ? 'plate' OR NOT p_violation ? 'violation_type' OR NOT p_violation ? 'property' THEN
    RETURN jsonb_build_object('error', 'p_violation missing required plate/violation_type/property');
  END IF;

  v_snapshot_count := jsonb_array_length(p_snapshot);
  v_snapshot_status := CASE WHEN v_snapshot_count > 0 THEN 'captured' ELSE 'none_present' END;

  -- Parent INSERT. Use jsonb_populate_record to map all provided keys
  -- to the row type; snapshot_status set from computed value above
  -- (never taken from caller — RPC owns it).
  INSERT INTO public.violations
  SELECT (r).*
  FROM (
    SELECT jsonb_populate_record(
      NULL::public.violations,
      p_violation || jsonb_build_object('snapshot_status', v_snapshot_status)
    ) AS r
  ) s
  RETURNING id INTO v_violation_id;

  -- Child INSERTs — one per snapshot record.
  IF v_snapshot_count > 0 THEN
    FOR v_record IN SELECT * FROM jsonb_array_elements(p_snapshot)
    LOOP
      INSERT INTO public.violation_context_records (
        violation_id, record_type, source_id,
        expires_at, start_date, end_date, was_live_at_scan
      ) VALUES (
        v_violation_id,
        v_record->>'record_type',
        v_record->>'source_id',
        NULLIF(v_record->>'expires_at', '')::TIMESTAMPTZ,
        NULLIF(v_record->>'start_date', '')::DATE,
        NULLIF(v_record->>'end_date',   '')::DATE,
        COALESCE((v_record->>'was_live_at_scan')::BOOLEAN, false)
      );
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'ok',              true,
    'id',              v_violation_id,
    'snapshot_status', v_snapshot_status,
    'snapshot_count',  v_snapshot_count
  );
END;
$rpc$;

REVOKE ALL ON FUNCTION public.driver_create_violation_with_snapshot(JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_create_violation_with_snapshot(JSONB, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.driver_create_violation_with_snapshot(JSONB, JSONB) TO authenticated;

COMMIT;

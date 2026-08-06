-- ══════════════════════════════════════════════════════════════════════
-- 20260805_deactivation_cascade_orphan_diagnostic.sql
-- PRE-BUILD DIAGNOSTIC (Jose runs, read-only). Runs AHEAD of Task 3
-- Commit 2 (deactivateResidentWrite extraction).
--
-- ZERO ROWS on Query 1 is the expected outcome. Any row on Query 1 is
-- a LIVE TOW RISK — orphaned vehicles under a still-active resident —
-- and needs triage before we build the extraction.
-- ══════════════════════════════════════════════════════════════════════
--
-- ── WHY THIS FILE EXISTS ─────────────────────────────────────────────
--
-- Mateo Aug 5 relay #3 identified that runOneDeactivate at
-- app/manager/page.tsx:2314-2317 does not destructure {error} on the
-- residents.update() call. On failure, the update silently fails but:
--   - logAudit('DEACTIVATE_RESIDENT') runs anyway
--   - trimDepartedResidentVehicles() runs anyway → vehicles trimmed to
--     is_active=FALSE
--   - cascadeVehiclesIfUnitVacant() runs anyway
--   - space_request + guest_auth cascades run anyway
--
-- Failure mode: an active resident with all their vehicles marked
-- inactive. Their cars scan unauthorized and get towed while the CRM
-- shows them as an active resident with vehicles.
--
-- Same shape as the guest-auth boundary bug closed today: correct-
-- looking state, silently wrong, tow at the end. Live at A1 now.
--
-- ── SCHEMA PRE-CHECK (Mateo Aug 5 discipline) ────────────────────────
--
-- The morning's `violations.company` round-trip (2026-08-05) is the
-- reason for the pre-check. Any hand-off query must assert its column
-- assumptions before executing. If pre-check fires, queries do not run
-- and Jose sees the mismatch immediately.
-- ══════════════════════════════════════════════════════════════════════

-- ── Schema pre-check ────────────────────────────────────────────────
DO $$
DECLARE
  v_missing text := '';
  v_have    int;
BEGIN
  SELECT COUNT(*) INTO v_have
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'residents'
     AND column_name IN ('id','email','name','unit','property','company','is_active','created_at');
  IF v_have <> 8 THEN
    v_missing := v_missing || format('residents (expected 8 cols, have %s); ', v_have);
  END IF;

  SELECT COUNT(*) INTO v_have
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vehicles'
     AND column_name IN ('id','property','resident_email','is_active');
  IF v_have <> 4 THEN
    v_missing := v_missing || format('vehicles (expected 4 cols, have %s); ', v_have);
  END IF;

  SELECT COUNT(*) INTO v_have
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'audit_logs'
     AND column_name IN ('id','created_at','user_email','action','table_name','record_id');
  IF v_have <> 6 THEN
    v_missing := v_missing || format('audit_logs (expected 6 cols, have %s); ', v_have);
  END IF;

  IF length(v_missing) > 0 THEN
    RAISE EXCEPTION 'Schema pre-check FAILED: %', v_missing;
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- QUERY 1 — THE SMOKING GUN (VARIANT A: is_active-only)
--
-- Residents with is_active=TRUE whose vehicles are ALL is_active=FALSE.
-- Excludes residents with no vehicles at all (never-registered — not
-- the failure shape).
--
-- Any row = live tow risk. Manager thinks the resident is active,
-- resident thinks their car is registered, enforcement says
-- unauthorized.
--
-- Doesn't depend on the audit log being honest.
--
-- 🔴 SCOPE — this variant catches BOTH orphaned-trim AND pending-approval.
--
-- A resident whose ONLY vehicles are `status='pending', is_active=FALSE`
-- (waiting for manager approval) will match here. That's not orphaned;
-- it's queued. Jose's 2026-08-05 run surfaced 3 Green Acres residents
-- of this shape (694, 635, 678 — Gloria Morales's plate has been
-- waiting since Jul 27); those are operations findings, not defects.
--
-- To narrow to ORPHANED-TRIM ONLY (previously-approved-then-trimmed —
-- the resident 690 shape), add `AND v.status = 'active'` to the
-- active_vehicles COUNT FILTER. That variant answers:
--
--   "residents with is_active=TRUE whose vehicles were previously
--    approved (status='active') and have since been trimmed
--    (is_active=FALSE)"
--
-- Both variants are useful; they answer different questions. The
-- variant below intentionally ships wider — better to see the
-- pending-queue-stale case as a false positive and triage than to
-- narrow past a real orphan.
-- ══════════════════════════════════════════════════════════════════════
WITH resident_vehicle_activity AS (
  SELECT
    r.id                                                    AS resident_id,
    r.email                                                 AS resident_email,
    r.name                                                  AS resident_name,
    r.unit,
    r.property,
    r.company,
    r.created_at                                            AS resident_created_at,
    COUNT(v.id)                                             AS vehicle_count,
    COUNT(v.id) FILTER (WHERE v.is_active = TRUE)           AS active_vehicles,
    COUNT(v.id) FILTER (WHERE v.is_active = FALSE)          AS inactive_vehicles
  FROM public.residents r
  LEFT JOIN public.vehicles v
    ON lower(v.resident_email) = lower(r.email)
   AND v.property ILIKE r.property
  WHERE r.is_active = TRUE
  GROUP BY r.id, r.email, r.name, r.unit, r.property, r.company, r.created_at
)
SELECT
  resident_id,
  resident_email,
  resident_name,
  unit,
  property,
  company,
  resident_created_at,
  vehicle_count,
  active_vehicles,
  inactive_vehicles
FROM resident_vehicle_activity
WHERE vehicle_count   > 0     -- has at least one vehicle
  AND active_vehicles = 0     -- but ALL are inactive
ORDER BY property, unit, resident_name;


-- ══════════════════════════════════════════════════════════════════════
-- QUERY 2 — THE AUDIT CONTRADICTION
--
-- audit_logs rows for DEACTIVATE_RESIDENT whose target resident is
-- still is_active=TRUE. The audit claims deactivation happened; the
-- resident row says it didn't. That's the audit-vs-outcome split — an
-- audit written after an unchecked write records intent, not outcome.
--
-- record_id is TEXT (accepts both scalar ids and CSV values elsewhere
-- in the schema). DEACTIVATE_RESIDENT specifically writes a scalar
-- residentId (see manager/page.tsx:2314). The `~ '^\d+$'` regex
-- filter excludes any CSV values before casting to BIGINT, so the
-- cast is safe.
-- ══════════════════════════════════════════════════════════════════════
SELECT
  al.id                    AS audit_log_id,
  al.created_at            AS audit_created_at,
  al.user_email            AS actor_email,
  al.record_id             AS target_record_id,
  r.id                     AS resident_id,
  r.email                  AS resident_email,
  r.name                   AS resident_name,
  r.unit,
  r.property,
  r.is_active              AS resident_is_active
FROM public.audit_logs al
JOIN public.residents r
  ON al.record_id ~ '^\d+$'
 AND al.record_id::BIGINT = r.id
WHERE al.action     = 'DEACTIVATE_RESIDENT'
  AND al.table_name = 'residents'
  AND r.is_active   = TRUE
ORDER BY al.created_at DESC;

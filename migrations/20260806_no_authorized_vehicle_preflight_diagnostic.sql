-- ══════════════════════════════════════════════════════════════════════
-- 20260806_no_authorized_vehicle_preflight_diagnostic.sql
-- PREFLIGHT diagnostic for the "No authorized vehicle" manager panel
-- (Mateo Aug 6). Read-only. Jose runs; results feed the panel's
-- final design.
--
-- Reports, per property (Green Acres + Test Legacy), the count of
-- active residents in each bucket + age distribution for pending.
-- Populations decide whether the panel needs an age threshold on A
-- and confirm E is large enough to exclude rather than label.
-- ══════════════════════════════════════════════════════════════════════
--
-- ── BUCKETS (Mateo Aug 6 lock) ────────────────────────────────────────
--
--   E_no_vehicles           — 0 vehicle rows (EXCLUDED from panel)
--   F_already_authorized    — ≥1 vehicle with is_active=TRUE (EXCLUDED)
--   ─────────────  panel population begins here  ─────────────
--   C_orphaned              — any vehicle is_active=FALSE + status='active'
--   B_all_declined          — all vehicles status='declined'
--   A_all_pending           — all vehicles status='pending'
--   D_mixed                 — anything else (mix of pending + declined, etc.)
--
-- Precedence C > B > A > D (a resident's bucket is the FIRST matching
-- of C, B, A; else D). Precedence justification is in the report to
-- Mateo, not this file — this query implements it verbatim.
--
-- ── PREDICATE — ENFORCEMENT, NOT countVehicles ────────────────────────
--
-- Uses `vehicles.is_active` as the enforcement predicate — matches
-- check_resident_plate (20260524:139). Does NOT read countVehicles or
-- any status-derived bucket, per the class documented in
-- docs/backlog/vehicles-status-is_active-divergence.md.
--
-- ── SCHEMA PRE-CHECK ──────────────────────────────────────────────────
-- Standing discipline (2026-08-05 hand-off queries): assert columns
-- exist before running. Aborts on missing.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_missing text := ''; v_have int;
BEGIN
  SELECT COUNT(*) INTO v_have
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='residents'
     AND column_name IN ('id','email','is_active','status','property','name','unit');
  IF v_have <> 7 THEN v_missing := v_missing || format('residents (have %s of 7); ', v_have); END IF;

  SELECT COUNT(*) INTO v_have
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='vehicles'
     AND column_name IN ('id','property','resident_email','is_active','status','plate','created_at');
  IF v_have <> 7 THEN v_missing := v_missing || format('vehicles (have %s of 7); ', v_have); END IF;

  IF length(v_missing) > 0 THEN
    RAISE EXCEPTION 'Schema pre-check FAILED: %', v_missing;
  END IF;
END $$;


-- ══════════════════════════════════════════════════════════════════════
-- QUERY 1 — BUCKET COUNTS per property + age summary for pending
-- ══════════════════════════════════════════════════════════════════════
WITH scoped AS (
  SELECT unnest(ARRAY['Green Acres','Test Legacy Property']::text[]) AS property_name
),
active_residents AS (
  SELECT r.id, r.email, r.name, r.unit, r.property,
         s.property_name AS scoped_property
  FROM public.residents r, scoped s
  WHERE r.is_active = TRUE
    AND r.status    = 'active'
    AND r.property ILIKE s.property_name
),
resident_vehicles AS (
  SELECT ar.id AS resident_id, ar.email AS resident_email,
         ar.name AS resident_name, ar.unit, ar.scoped_property AS property,
         v.id AS vehicle_id, v.plate,
         v.status AS v_status, v.is_active AS v_is_active,
         v.created_at AS v_created_at
  FROM active_residents ar
  LEFT JOIN public.vehicles v
    ON lower(v.resident_email) = lower(ar.email)
   AND v.property ILIKE ar.scoped_property
),
per_resident AS (
  SELECT
    property, resident_id, resident_email, resident_name, unit,
    COUNT(vehicle_id)                                                            AS v_total,
    COUNT(vehicle_id) FILTER (WHERE v_is_active = TRUE)                          AS v_active,
    COUNT(vehicle_id) FILTER (WHERE v_is_active = FALSE AND v_status = 'active') AS v_orphaned,
    COUNT(vehicle_id) FILTER (WHERE v_status = 'pending')                        AS v_pending,
    COUNT(vehicle_id) FILTER (WHERE v_status = 'declined')                       AS v_declined,
    MIN(v_created_at) FILTER (WHERE v_status = 'pending')                        AS oldest_pending_at
  FROM resident_vehicles
  GROUP BY property, resident_id, resident_email, resident_name, unit
),
classified AS (
  SELECT
    *,
    CASE
      WHEN v_total = 0                              THEN 'E_no_vehicles'
      WHEN v_active > 0                             THEN 'F_already_authorized'
      WHEN v_orphaned > 0                           THEN 'C_orphaned'
      WHEN v_declined > 0 AND v_pending = 0         THEN 'B_all_declined'
      WHEN v_pending > 0 AND v_declined = 0         THEN 'A_all_pending'
      ELSE                                               'D_mixed'
    END AS bucket
  FROM per_resident
)
SELECT
  property,
  bucket,
  COUNT(*)                                                                     AS resident_count,
  ROUND(AVG(EXTRACT(EPOCH FROM (now() - oldest_pending_at))/86400.0)::numeric, 1) AS avg_oldest_pending_age_days,
  ROUND(MAX(EXTRACT(EPOCH FROM (now() - oldest_pending_at))/86400.0)::numeric, 1) AS max_oldest_pending_age_days
FROM classified
GROUP BY property, bucket
ORDER BY property, bucket;


-- ══════════════════════════════════════════════════════════════════════
-- QUERY 2 — DETAIL LISTING for panel-eligible buckets (A, B, C, D)
-- Excludes E (no vehicles) and F (already authorized).
--
-- Any row is a resident who would land in the panel today.
-- Verify against known cases: Natalie 690 (Green Acres) should be C;
-- unit 144 residents should be B; Courtney 678 at unit 76 should be
-- D (has both declined AND pending).
-- ══════════════════════════════════════════════════════════════════════
WITH scoped AS (
  SELECT unnest(ARRAY['Green Acres','Test Legacy Property']::text[]) AS property_name
),
active_residents AS (
  SELECT r.id, r.email, r.name, r.unit, r.property,
         s.property_name AS scoped_property
  FROM public.residents r, scoped s
  WHERE r.is_active = TRUE
    AND r.status    = 'active'
    AND r.property ILIKE s.property_name
),
resident_vehicles AS (
  SELECT ar.id AS resident_id, ar.email AS resident_email,
         ar.name AS resident_name, ar.unit, ar.scoped_property AS property,
         v.id AS vehicle_id, v.plate,
         v.status AS v_status, v.is_active AS v_is_active,
         v.created_at AS v_created_at
  FROM active_residents ar
  LEFT JOIN public.vehicles v
    ON lower(v.resident_email) = lower(ar.email)
   AND v.property ILIKE ar.scoped_property
),
per_resident AS (
  SELECT
    property, resident_id, resident_email, resident_name, unit,
    COUNT(vehicle_id)                                                            AS v_total,
    COUNT(vehicle_id) FILTER (WHERE v_is_active = TRUE)                          AS v_active,
    COUNT(vehicle_id) FILTER (WHERE v_is_active = FALSE AND v_status = 'active') AS v_orphaned,
    COUNT(vehicle_id) FILTER (WHERE v_status = 'pending')                        AS v_pending,
    COUNT(vehicle_id) FILTER (WHERE v_status = 'declined')                       AS v_declined,
    MIN(v_created_at) FILTER (WHERE v_status = 'pending')                        AS oldest_pending_at
  FROM resident_vehicles
  GROUP BY property, resident_id, resident_email, resident_name, unit
),
classified AS (
  SELECT
    *,
    CASE
      WHEN v_total = 0                              THEN 'E_no_vehicles'
      WHEN v_active > 0                             THEN 'F_already_authorized'
      WHEN v_orphaned > 0                           THEN 'C_orphaned'
      WHEN v_declined > 0 AND v_pending = 0         THEN 'B_all_declined'
      WHEN v_pending > 0 AND v_declined = 0         THEN 'A_all_pending'
      ELSE                                               'D_mixed'
    END AS bucket
  FROM per_resident
)
SELECT
  property, bucket, resident_id, resident_email, resident_name, unit,
  v_total, v_orphaned, v_pending, v_declined,
  oldest_pending_at,
  ROUND(EXTRACT(EPOCH FROM (now() - oldest_pending_at))/86400.0::numeric, 1)   AS oldest_pending_age_days
FROM classified
WHERE bucket IN ('A_all_pending','B_all_declined','C_orphaned','D_mixed')
ORDER BY property, bucket, unit, resident_name;

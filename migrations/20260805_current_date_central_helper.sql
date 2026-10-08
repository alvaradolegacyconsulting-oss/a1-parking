-- ══════════════════════════════════════════════════════════════════════
-- 20260805_current_date_central_helper.sql
-- Commit A of the guest-auth CURRENT_DATE fix — install the helper.
-- Additive. Zero callers today. Zero behavior change.
-- Commit B (20260805_pm_plate_lookup_current_date_central_sweep.sql,
-- pending Mateo greenlight) migrates pm_plate_lookup to use it.
-- ══════════════════════════════════════════════════════════════════════
--
-- ── WHY THIS HELPER EXISTS ──────────────────────────────────────────
--
-- Postgres CURRENT_DATE resolves in the SESSION TimeZone. Supabase's
-- session default is UTC. Vercel's Node runtime is also UTC. So a
-- CURRENT_DATE comparison in a user-facing DATE boundary (guest-auth
-- windows, lease dates, etc.) evaluates to TOMORROW starting at 7pm
-- Central every day — 5 hours before the calendar rolls in Central.
--
-- Consequence measured 2026-08-04: a guest authorized THROUGH Aug 3
-- would be denied at 7pm CDT on Aug 3, because CURRENT_DATE
-- evaluates to Aug 4. The mirror also fires: a guest whose window
-- STARTS Aug 4 gets admitted at 7pm CDT on Aug 3.
--
-- Enumeration (Mateo lock 2026-08-05): all 8 CURRENT_DATE hits from
-- the migration audit collapse to 2 refs in ONE live function
-- (pm_plate_lookup, latest revision 20260724). Both refs compared
-- to DATE columns — no timestamptz cast concern. This helper is
-- called from that function in Commit B; no other caller today.
--
-- ── STABLE, NOT IMMUTABLE ────────────────────────────────────────────
--
-- now() forbids IMMUTABLE. Even if allowed, IMMUTABLE would let the
-- planner fold the return value to a constant across statements — a
-- bug that surfaces only near midnight, which is exactly when it
-- matters. STABLE is correct: same value within a statement; may
-- change between statements.
--
-- ── NO HARDCODED OFFSET ──────────────────────────────────────────────
--
-- 'America/Chicago' resolves CDT (UTC-5) in summer and CST (UTC-6)
-- in winter via tzdata. A fixed 5 or 6 hours tests clean in August
-- and breaks in November. Do NOT rewrite this as
-- `now() - interval '5 hours'`; do NOT rewrite as CURRENT_DATE.
--
-- ── GRANTS ────────────────────────────────────────────────────────────
--
-- REVOKE ALL FROM PUBLIC (Supabase default GRANTs EXECUTE to PUBLIC on
-- every new function; missed REVOKE lands as public-executable).
-- REVOKE explicitly from anon per revoke-anon discipline (feedback
-- memory: REVOKE PUBLIC alone may leave anon EXECUTE).
--
-- No GRANT TO authenticated: the current caller is a SECURITY DEFINER
-- RPC (pm_plate_lookup) that runs as postgres — the helper is reachable
-- from within the definer context without an explicit grant. If a
-- future INVOKER-role caller needs the helper, that migration owns
-- the GRANT decision.
--
-- The return value (today's date in Central) leaks nothing; this is
-- default-deny hygiene, not a security boundary.
--
-- ── DO NOT ────────────────────────────────────────────────────────────
--
-- - DO NOT mark IMMUTABLE (see STABLE rationale above)
-- - DO NOT replace `AT TIME ZONE 'America/Chicago'` with a fixed
--   interval offset (breaks at DST transition)
-- - DO NOT add per-property timezone plumbing here — Texas is
--   mostly Central; when a Mountain-time property onboards (El Paso
--   or Hudspeth county) this fn takes a p_property arg and
--   'America/Chicago' becomes the default. Not built now.
-- - DO NOT grant to app roles unless a specific INVOKER caller
--   needs it. Every added grant widens the attack surface for no
--   current use case.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.current_date_central()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $func$
  SELECT (now() AT TIME ZONE 'America/Chicago')::date
$func$;

REVOKE ALL ON FUNCTION public.current_date_central() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_date_central() FROM anon;
-- No GRANT to authenticated: current caller is SECURITY DEFINER
-- (pm_plate_lookup, 20260724). Add GRANT here if a future INVOKER
-- caller needs it.

COMMENT ON FUNCTION public.current_date_central() IS
  'Returns today''s date in the property timezone (America/Chicago). Use this INSTEAD OF CURRENT_DATE in any user-facing DATE boundary — CURRENT_DATE resolves in the session TimeZone (Supabase default UTC, Vercel Node UTC), which produces a 5-hour early rollover at 7pm Central every day. STABLE (not IMMUTABLE — depends on now()). No hardcoded offset — America/Chicago resolves CDT/CST from tzdata. WARNING: if you are comparing a timestamptz column to a date, this helper alone is NOT sufficient — the implicit timestamptz->date cast ALSO uses the session TimeZone. For a timestamptz column, use (col AT TIME ZONE ''America/Chicago'')::date or compare instants via now(). Installed 2026-08-05 alongside the pm_plate_lookup CURRENT_DATE sweep (Commit B).';

COMMIT;

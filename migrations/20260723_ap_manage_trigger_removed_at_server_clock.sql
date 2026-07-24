-- ═══════════════════════════════════════════════════════════════════════
-- 20260723_ap_manage_trigger_removed_at_server_clock.sql
-- ═══════════════════════════════════════════════════════════════════════
-- AP-MANAGE-TRIGGER — stamp `authorized_plates.removed_at` with server
-- clock in the soft-delete transition, same as `removed_by`.
--
-- ── Why ───────────────────────────────────────────────────────────────
-- AP-MANAGE's remove flow sends `NEW.removed_at = new Date().toISOString()`
-- from the client. The trigger stamped `removed_by` server-side (via
-- `auth.jwt() ->> 'email'`) for exactly the right reason — RLS validates
-- which rows a caller may write, not what they put in the columns.
-- **`removed_at` has the same property and was not protected.**
-- A skewed machine writes a wrong timestamp; a badly skewed one writes a
-- future timestamp into an audit trail.
--
-- Fix: stamp `NEW.removed_at := now()` in the same soft-delete branch
-- that already stamps `removed_by`. The client still sends a value to
-- signal soft-delete intent (the branch keys on `NEW.removed_at IS NOT
-- NULL`), but the server's clock is what's stored.
--
-- ── Scope ─────────────────────────────────────────────────────────────
-- Single CREATE OR REPLACE FUNCTION on
-- `authorized_plates_normalize_and_attribute`. All other logic
-- (plate immutability, no-reactivation, normalization, added_by
-- stamping, empty-plate/empty-attribution RAISEs) preserved byte-
-- identical.
--
-- ── Rollback ──────────────────────────────────────────────────────────
-- Re-apply the trigger function from
-- migrations/20260723_authorized_plates_v1_schema.sql (STEP 4).

BEGIN;

CREATE OR REPLACE FUNCTION public.authorized_plates_normalize_and_attribute()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
BEGIN
  -- ── Immutability guards (UPDATE only) ─────────────────────────────
  IF TG_OP = 'UPDATE' AND NEW.plate IS DISTINCT FROM OLD.plate THEN
    RAISE EXCEPTION 'plate is immutable — remove this row and add a new one'
      USING ERRCODE = 'check_violation',
            HINT    = 'Remove the existing authorization and add the corrected plate.';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.removed_at IS NOT NULL AND NEW.removed_at IS NULL THEN
    RAISE EXCEPTION 'removed rows cannot be reactivated — add a new row instead'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── Normalize plate ──────────────────────────────────────────────
  NEW.plate := UPPER(regexp_replace(COALESCE(NEW.plate,''), '[^A-Za-z0-9]', '', 'g'));
  IF NEW.plate = '' THEN
    RAISE EXCEPTION 'plate empty after normalization'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── Server-side attribution (added_by / removed_by / removed_at) ─
  -- RLS validates which rows a caller may write, not what they put in
  -- the columns. Attribution + timestamp MUST be server-set or a
  -- caller could write any value. Empty-string check catches the
  -- COALESCE-fell-through-to-placeholder failure mode (a non-empty
  -- placeholder would satisfy `IS NULL OR btrim = ''` if we only
  -- checked NULL).
  IF TG_OP = 'INSERT' THEN
    NEW.added_by := COALESCE(auth.jwt() ->> 'email', NEW.added_by);
    IF NEW.added_by IS NULL OR btrim(NEW.added_by) = '' THEN
      RAISE EXCEPTION 'added_by unresolvable — no email in JWT and no fallback provided'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Nothing is born removed. A row inserted with removed_at set would
    -- be invisible in every list (all queries filter removed_at IS NULL)
    -- while still holding the partial unique index — re-adding that
    -- plate would then fail against a row nobody can see. CHECK
    -- permits (removed_at NULL OR removed_by NOT NULL) but doesn't
    -- forbid both-set on INSERT; enforce here at the trigger.
    NEW.removed_at := NULL;
    NEW.removed_by := NULL;
  END IF;

  -- Soft-delete transition: stamp removed_at + removed_by server-side.
  -- Client still sends removed_at to signal intent (branch keys on it),
  -- but server's clock overrides. Same principle as added_by.
  IF TG_OP = 'UPDATE' AND NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL THEN
    NEW.removed_at := now();                                    -- NEW (AP-MANAGE-TRIGGER)
    NEW.removed_by := COALESCE(auth.jwt() ->> 'email', NEW.removed_by);
    IF NEW.removed_by IS NULL OR btrim(NEW.removed_by) = '' THEN
      RAISE EXCEPTION 'removed_by unresolvable — no email in JWT and no fallback provided'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$func$;

-- ══════════════════════════════════════════════════════════════════════
-- SCHEMA_ audit (NOT EXISTS-guarded, safe to re-run)
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
SELECT
  'system_migration_v1',
  'SCHEMA_AP_MANAGE_TRIGGER_REMOVED_AT_SERVER_CLOCK',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260723_ap_manage_trigger_removed_at_server_clock',
    -- Long strings broken into short concatenated segments so no
    -- single line wraps in a paste buffer — earlier attempt hit
    -- `relation "the" does not exist` from post-COMMIT parse fallout
    -- when a wrapped audit string mangled Jose's paste.
    'purpose',   'AP-MANAGE-TRIGGER — stamp removed_at server-side (now()) '
              || 'alongside removed_by. Client-supplied timestamp would allow '
              || 'skewed-clock writes into the audit trail.',
    'change',    'authorized_plates_normalize_and_attribute — '
              || '(a) soft-delete branch now sets NEW.removed_at := now() '
              || 'alongside removed_by (server clock, not client); '
              || '(b) INSERT branch forces NEW.removed_at := NULL and '
              || 'NEW.removed_by := NULL so nothing is born removed '
              || '(would be invisible in all lists but hold the '
              || 'partial-unique-index slot).',
    'preserved', ARRAY['plate immutability guard', 'no-reactivation guard', 'plate normalization', 'added_by stamping', 'empty-attribution RAISE (btrim = empty)'],
    'rollback',  'Re-apply trigger function from migrations/20260723_authorized_plates_v1_schema.sql STEP 4'
  ),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.audit_logs
   WHERE action = 'SCHEMA_AP_MANAGE_TRIGGER_REMOVED_AT_SERVER_CLOCK'
     AND new_values->>'migration' = '20260723_ap_manage_trigger_removed_at_server_clock'
);

COMMIT;

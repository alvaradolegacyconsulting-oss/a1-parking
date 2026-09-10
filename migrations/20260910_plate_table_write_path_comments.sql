-- ══════════════════════════════════════════════════════════════════════
-- 20260910_plate_table_write_path_comments.sql
--
-- COMMENT-ONLY. No DDL, no grants, no policy changes. Appends a
-- plate-write-path requirement to the COMMENT ON TABLE of the two
-- tables that carry a raising alphanumeric normalizer trigger:
--   · public.do_not_tow_plates   (dnt_plate_normalize)
--   · public.authorized_plates   (authorized_plates_normalize_and_attribute)
--
-- ── WHY ─────────────────────────────────────────────────────────────
-- On 2026-09-09 a punctuation-only plate cleared record_vehicle_removal's
-- validation and raised a raw SQLSTATE 22004 from the vehicle_removals
-- trigger — the whole INSERT statement in the message text, to a
-- property manager on a phone. Fixed the next day
-- (20260910_record_vehicle_removal_plate_normalize_fix.sql).
--
-- Three tables share that trigger shape. The other two are clean TODAY,
-- but for reasons a future writer cannot see from the table:
--
--   do_not_tow_plates  — clean because it has NO write path at all.
--                        Capability parked 2026-07-23; INSERT/UPDATE
--                        revoked from authenticated. Un-parking it
--                        means writing that path from scratch.
--   authorized_plates  — clean because AuthorizedPlatesManager.tsx:126
--                        normalizes with the SAME character set before
--                        checking emptiness. That is LOAD-BEARING, not
--                        incidental. A second write path (an RPC, a
--                        bulk import, another screen) that validates
--                        the raw input reintroduces the bug.
--
-- A comment on each table makes the requirement discoverable from the
-- table itself, rather than from a July migration header or a
-- September one. That is the same argument that put the DO-NOT-DROP
-- note on vehicle_removal_plate_normalize(): pg_description is where
-- someone looks; a migration file weeks back is not.
--
-- ── 🔴 APPEND, NEVER REPLACE ────────────────────────────────────────
-- COMMENT ON TABLE overwrites the entire comment. Both tables already
-- carry substantial comments that must survive:
--   do_not_tow_plates — the PARKED notice and the do-not-re-grant
--                       warning (20260723_dnt_park_revoke_writes.sql:60)
--   authorized_plates — the three-way distinction between standing
--                       authorization, tow protection, and quota
--                       exemption (20260723_authorized_plates_v1_schema.sql:85)
--
-- So this file READS the live comment with obj_description() and
-- appends to it, rather than pasting a copy of what the migrations say
-- it should be. The catalog is the audit surface — a comment edited via
-- the dashboard would not appear in the repo, and a blind rewrite would
-- silently discard it. (feedback_catalog_is_audit_surface_not_migrations)
--
-- Idempotent: skips a table whose comment already carries the marker,
-- so re-running never double-appends.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- Paste the ENTIRE BEGIN/COMMIT block as ONE block, click Run ONCE.
-- Paired file: 20260910_plate_table_write_path_comments_verification.sql
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- PART 1 — do_not_tow_plates
-- ══════════════════════════════════════════════════════════════════════
DO $dnt$
DECLARE
  v_existing TEXT;
  v_append   TEXT;
BEGIN
  v_existing := obj_description('public.do_not_tow_plates'::regclass, 'pg_class');

  v_append :=
    'PLATE WRITE-PATH REQUIREMENT (added 2026-09-10): any future write path — RPC, UI, or bulk import — MUST normalize the plate with the AGGRESSIVE alphanumeric strip and validate the POST-STRIP value. dnt_plate_normalize() raises SQLSTATE 22004 when nothing survives the strip, so a caller that validates with normalize_plate() (whitespace-only) lets a punctuation-only plate such as ''---'' through validation and detonates in the trigger, surfacing a raw SQLSTATE with the INSERT statement in its message text to whoever is holding the phone. That exact bug shipped in record_vehicle_removal and was found by runbook on 2026-09-09; fix is 20260910_record_vehicle_removal_plate_normalize_fix.sql. Canonical validate-then-normalize shape: 20260723_ap_cascade_check_authorized_plate.sql:248-256. This requirement applies BEFORE any un-park re-grants INSERT/UPDATE — the table is clean today only because nothing can write to it.';

  IF v_existing IS NULL THEN
    RAISE EXCEPTION
      'do_not_tow_plates has NO table comment. Expected the PARKED notice from 20260723_dnt_park_revoke_writes.sql. Appending to nothing would silently drop it — investigate before re-running.';
  END IF;

  IF position('PLATE WRITE-PATH REQUIREMENT' IN v_existing) > 0 THEN
    RAISE NOTICE 'do_not_tow_plates comment already carries the requirement — skipping (idempotent).';
  ELSE
    EXECUTE format('COMMENT ON TABLE public.do_not_tow_plates IS %L',
                   v_existing || ' ' || v_append);
    RAISE NOTICE 'do_not_tow_plates comment extended (% chars -> % chars).',
                 length(v_existing), length(v_existing || ' ' || v_append);
  END IF;
END $dnt$;


-- ══════════════════════════════════════════════════════════════════════
-- PART 2 — authorized_plates
-- ══════════════════════════════════════════════════════════════════════
DO $ap$
DECLARE
  v_existing TEXT;
  v_append   TEXT;
BEGIN
  v_existing := obj_description('public.authorized_plates'::regclass, 'pg_class');

  v_append :=
    'PLATE WRITE-PATH REQUIREMENT (added 2026-09-10): any write path MUST normalize the plate with the AGGRESSIVE alphanumeric strip and validate the POST-STRIP value. authorized_plates_normalize_and_attribute() raises on a plate that is empty after the strip, and the table CHECK requires the stored value to already equal its own normalization. The add-path in AuthorizedPlatesManager.tsx:126-127 is correct TODAY only because it applies the same character set before checking emptiness — that is LOAD-BEARING, not incidental. A second write path (an RPC, a bulk import, another screen) that validates the RAW input will let a punctuation-only plate such as ''---'' through and raise a bare SQLSTATE at the user instead of a clean rejection. That exact bug shipped in record_vehicle_removal; found 2026-09-09, fixed by 20260910_record_vehicle_removal_plate_normalize_fix.sql. Canonical validate-then-normalize shape: 20260723_ap_cascade_check_authorized_plate.sql:248-256.';

  IF v_existing IS NULL THEN
    RAISE EXCEPTION
      'authorized_plates has NO table comment. Expected the three-way distinction from 20260723_authorized_plates_v1_schema.sql. Appending to nothing would silently drop it — investigate before re-running.';
  END IF;

  IF position('PLATE WRITE-PATH REQUIREMENT' IN v_existing) > 0 THEN
    RAISE NOTICE 'authorized_plates comment already carries the requirement — skipping (idempotent).';
  ELSE
    EXECUTE format('COMMENT ON TABLE public.authorized_plates IS %L',
                   v_existing || ' ' || v_append);
    RAISE NOTICE 'authorized_plates comment extended (% chars -> % chars).',
                 length(v_existing), length(v_existing || ' ' || v_append);
  END IF;
END $ap$;


-- ══════════════════════════════════════════════════════════════════════
-- PART 3 — Schema audit row
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_PLATE_TABLE_WRITE_PATH_COMMENTS',
  'public.do_not_tow_plates,public.authorized_plates',
  'plate_write_path_requirement_comments',
  jsonb_build_object(
    'migration', '20260910_plate_table_write_path_comments',
    'arc',       'Tow Log plate-normalization fix — make the post-strip validation requirement discoverable from the two sibling tables that carry a raising normalizer trigger',
    'ddl_changes', 'NONE — COMMENT ON TABLE only. No columns, grants, policies, indexes or functions touched.',
    'tables', jsonb_build_array('public.do_not_tow_plates', 'public.authorized_plates'),
    'method', 'obj_description() read, then append. COMMENT ON TABLE replaces the whole comment, and both tables carry substantial existing text (the DNT PARKED notice; the AP three-way distinction). Reading the LIVE comment rather than pasting what the migrations say it should be means a dashboard-edited comment is preserved too.',
    'idempotent', 'Skips a table whose comment already contains PLATE WRITE-PATH REQUIREMENT. Re-runnable.',
    'why', 'record_vehicle_removal validated a plate with normalize_plate() (whitespace-only) while the table trigger used the aggressive alphanumeric strip. A punctuation-only plate cleared validation and raised a raw SQLSTATE 22004 at a property manager on 2026-09-09. These two tables carry the same trigger shape and are clean only for reasons invisible from the table itself — DNT has no write path (parked, writes revoked 2026-07-23), AP is clean because its client normalizes post-strip before validating.',
    'related', jsonb_build_array(
      '20260910_record_vehicle_removal_plate_normalize_fix.sql — the fix these comments point at',
      '20260723_ap_cascade_check_authorized_plate.sql:248-256 — canonical shape',
      'app/components/AuthorizedPlatesManager.tsx:126-127 — working client precedent'
    )
  ),
  now()
);

COMMIT;

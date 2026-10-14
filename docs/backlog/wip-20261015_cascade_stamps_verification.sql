-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION — cascade stamps
-- ════════════════════════════════════════════════════════════════════
-- Re-runnable. No BEGIN/COMMIT.
--
-- 🔴 THIS FILE IS THE DISCOVERABILITY MECHANISM FOR THE REVOKE. Piece
-- 0's objection to column grants was that they do not appear in a
-- pg_policies dump, so the next auditor concludes the columns are
-- writable. The REVOKE is asserted here, from pg_attribute.attacl —
-- NOT from information_schema.column_privileges, which under-reports
-- grants and would pass while the column was wide open.

DO $do$
DECLARE
  v_fail TEXT[] := '{}';
  v_n    INT;
  v_col  TEXT;
BEGIN

  -- ── G1. The three columns, nullable ───────────────────────────────
  FOREACH v_col IN ARRAY ARRAY['cascade_deactivated_by_property','cascade_deactivated_run','cascade_deactivated_at']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid='public.user_roles'::regclass AND attname=v_col
                      AND attnum>0 AND NOT attisdropped) THEN
      v_fail := array_append(v_fail, format('G1: user_roles.%s is missing', v_col));
      CONTINUE;
    END IF;
    -- NOT NULL would be wrong: the absence of a stamp is the meaningful
    -- "unknown provenance" state, and every pre-existing row has it.
    IF (SELECT attnotnull FROM pg_attribute
         WHERE attrelid='public.user_roles'::regclass AND attname=v_col) THEN
      v_fail := array_append(v_fail, format('G1a: user_roles.%s is NOT NULL — an unstamped row is the point', v_col));
    END IF;

    -- ── G2. 🔴 The REVOKE, from attacl. ─────────────────────────────
    -- attacl NULL means "default privileges", i.e. the TABLE grant
    -- applies and authenticated CAN write it. So NULL is a FAILURE
    -- here, not an absence — exactly the absence-as-answer trap.
    IF (SELECT attacl FROM pg_attribute
         WHERE attrelid='public.user_roles'::regclass AND attname=v_col) IS NULL THEN
      v_fail := array_append(v_fail, format(
        'G2: 🔴 user_roles.%s has attacl NULL, so it inherits the TABLE grant and authenticated can write the provenance. A CA could then stamp a user and make a later cascade reactivation restore someone it never took.', v_col));
    ELSIF has_column_privilege('authenticated', 'public.user_roles', v_col, 'UPDATE') THEN
      v_fail := array_append(v_fail, format('G2a: 🔴 authenticated still holds UPDATE on user_roles.%s', v_col));
    END IF;
    IF has_column_privilege('anon', 'public.user_roles', v_col, 'UPDATE') THEN
      v_fail := array_append(v_fail, format('G2b: 🔴 anon holds UPDATE on user_roles.%s', v_col));
    END IF;
  END LOOP;

  -- ── G3. service_role must still be able to write them ─────────────
  -- A REVOKE that catches the writer is a feature nobody can use. This
  -- is the positive control: service_role bypasses RLS but NOT column
  -- grants, so if the REVOKE was issued against the wrong role the
  -- cascade silently stops stamping and reactivation skips everyone.
  IF NOT has_column_privilege('service_role', 'public.user_roles', 'cascade_deactivated_by_property', 'UPDATE') THEN
    v_fail := array_append(v_fail, 'G3: 🔴 service_role cannot UPDATE the stamp — the cascade could not write it, and reactivation would skip every user forever');
  END IF;

  -- ── G4. The FK direction ──────────────────────────────────────────
  -- ON DELETE SET NULL, so losing the property loses the provenance and
  -- the row falls to SKIP. CASCADE would delete the user_roles row and
  -- RESTRICT would block deleting a property — both wrong.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid='public.user_roles'::regclass AND c.contype='f'
       AND c.confrelid='public.properties'::regclass
       AND c.confdeltype='n') THEN
    v_fail := array_append(v_fail, format(
      'G4: the FK to properties is not ON DELETE SET NULL (confdeltype=%s). Losing a property must fail toward "leave them deactivated", never toward "restore them".',
      (SELECT string_agg(c.confdeltype::TEXT, ',') FROM pg_constraint c
        WHERE c.conrelid='public.user_roles'::regclass AND c.contype='f'
          AND c.confrelid='public.properties'::regclass)));
  END IF;

  -- ── G5. Nothing is stamped yet ────────────────────────────────────
  SELECT count(*) INTO v_n FROM public.user_roles WHERE cascade_deactivated_by_property IS NOT NULL;
  IF v_n <> 0 THEN
    v_fail := array_append(v_fail, format('G5: %s rows are already stamped before the route exists — somebody wrote them another way', v_n));
  END IF;

  -- ── G6. The deactivated rows are all unstamped, as ruled ──────────
  SELECT count(*) INTO v_n FROM public.user_roles
   WHERE is_active IS NOT TRUE AND cascade_deactivated_by_property IS NULL;
  IF v_n <> (SELECT count(*) FROM public.user_roles WHERE is_active IS NOT TRUE) THEN
    v_fail := array_append(v_fail, 'G6: some pre-existing deactivated row carries a stamp it cannot have earned');
  END IF;

  IF array_length(v_fail,1) > 0 THEN
    RAISE EXCEPTION E'CASCADE STAMPS VERIFICATION FAILED:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
END
$do$;

SELECT 'PASS — cascade stamps' AS result,
       (SELECT count(*) FROM pg_attribute
         WHERE attrelid='public.user_roles'::regclass
           AND attname LIKE 'cascade_deactivated%' AND attnum>0 AND NOT attisdropped) AS columns_want_3,
       has_column_privilege('authenticated','public.user_roles','cascade_deactivated_by_property','UPDATE') AS authenticated_update_want_false,
       has_column_privilege('service_role','public.user_roles','cascade_deactivated_by_property','UPDATE')  AS service_role_update_want_true,
       (SELECT count(*) FROM public.user_roles WHERE cascade_deactivated_by_property IS NOT NULL) AS stamped_want_0,
       (SELECT count(*) FROM public.user_roles WHERE is_active IS NOT TRUE) AS deactivated_all_unstamped_so_all_skipped,
       '🔴 these 4 will be SKIPPED by any reactivation — "deactivated separately", as ruled' AS note;

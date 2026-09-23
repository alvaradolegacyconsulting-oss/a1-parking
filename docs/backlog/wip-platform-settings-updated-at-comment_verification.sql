-- ════════════════════════════════════════════════════════════════════
-- DRAFT VERIFICATION — pairs with
-- wip-platform-settings-updated-at-comment.sql
-- ════════════════════════════════════════════════════════════════════
--
-- No BEGIN/COMMIT. Re-runnable. Terminal SELECT returns a PASS row.

-- ── VS1: the comment exists and says the load-bearing thing ─────────
DO $$
DECLARE v_comment text;
BEGIN
  SELECT col_description(
           (SELECT oid FROM pg_class
             WHERE relname = 'platform_settings'
               AND relnamespace = 'public'::regnamespace),
           (SELECT attnum FROM pg_attribute
             WHERE attrelid = (SELECT oid FROM pg_class
                                WHERE relname = 'platform_settings'
                                  AND relnamespace = 'public'::regnamespace)
               AND attname = 'updated_at'))
    INTO v_comment;

  IF v_comment IS NULL THEN
    RAISE EXCEPTION 'VS1 FAIL: no comment on platform_settings.updated_at';
  END IF;

  -- Assert the WARNING, not merely that some text is present. A comment
  -- that says anything at all would pass a NOT NULL check while telling
  -- the next reader nothing.
  IF position('NOT maintained on UPDATE' IN v_comment) = 0 THEN
    RAISE EXCEPTION 'VS1 FAIL: comment present but does not state that the column is not maintained on UPDATE. Got: %', left(v_comment, 120);
  END IF;
END $$;

-- ── VS2: the claim is still TRUE — no trigger maintains the column ──
-- 🔴 The comment would become a lie the moment someone adds a trigger,
-- and a stale warning is worse than none. This asserts the state the
-- comment describes, not just the comment's existence.
DO $$
DECLARE v_triggers int;
BEGIN
  SELECT count(*) INTO v_triggers
    FROM pg_trigger
   WHERE tgrelid = 'public.platform_settings'::regclass
     AND NOT tgisinternal;

  IF v_triggers > 0 THEN
    RAISE EXCEPTION 'VS2 FAIL: % non-internal trigger(s) now exist on platform_settings. If one of them maintains updated_at, the column comment is now WRONG and must be rewritten, not kept.', v_triggers;
  END IF;
END $$;

-- ── PASS row ────────────────────────────────────────────────────────
SELECT
  'PASS'                                         AS result,
  'VS1 comment present + states the warning'     AS vs1,
  'VS2 no trigger maintains the column'          AS vs2,
  (SELECT col_description(
            (SELECT oid FROM pg_class WHERE relname='platform_settings' AND relnamespace='public'::regnamespace),
            (SELECT attnum FROM pg_attribute
              WHERE attrelid=(SELECT oid FROM pg_class WHERE relname='platform_settings' AND relnamespace='public'::regnamespace)
                AND attname='updated_at'))) AS comment_text;

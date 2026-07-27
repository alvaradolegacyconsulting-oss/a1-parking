-- ══════════════════════════════════════════════════════════════════════
-- 20260728_property_name_aliases_schema.sql
-- ══════════════════════════════════════════════════════════════════════
-- Alias mechanism for property name renames when physical/distributed
-- material carries the old name and can't be recalled. Green Acers →
-- Green Acres is the first user: A1 has printed signage generated
-- from the CA portal (DB-derived, spells "Green Acers"), and reprint
-- isn't planned. This lets the URL keep resolving after the rename.
--
-- Rule of use — alias ONLY where distributed material justifies it.
-- Miramar Apartments + Sugarberry Place get plain rename (nothing
-- printed or in circulation). Aliases widen the anon name-collision
-- surface; create sparingly.
--
-- Ships as ONE unit with:
--   • This schema migration (table + trigger + RPC amend)
--   • /visitor and /register page changes that use the resolved name
--     in write paths (canonical writes). Alias-alone re-opens the
--     phantom-pass scenario by making the read succeed while the
--     write still uses the raw URL param.
--
-- ── Design notes ──────────────────────────────────────────────────
--   • Table maps alias → property_id (NOT another name column).
--     Matches the FK-epic direction: names resolve to IDs, we don't
--     add more name-keying.
--   • ON DELETE CASCADE so aliases die with the property.
--   • Global unique index on lower(trim(alias)) so aliases can't
--     collide with each other.
--   • Trigger blocks alias↔current-name shadow — the unique index
--     spans one table only; the trigger spans both.
--   • RPC uses a CTE with priority ordering: direct name match wins
--     over alias. Alias can never shadow a live property.
--
-- ── Direct-name collision behaviour (pre-existing, unchanged) ────
--   get_property_for_visitor's LIMIT 1 on the direct branch returns
--   an arbitrary row if two active properties share a name. That's
--   the pre-existing hazard owned by the FK epic — this migration
--   does NOT introduce or fix it. The comment in the function body
--   preserves that ownership.
-- ══════════════════════════════════════════════════════════════════════


BEGIN;

-- ── STEP 1 — property_name_aliases table ────────────────────────────

CREATE TABLE IF NOT EXISTS public.property_name_aliases (
  id           bigserial   PRIMARY KEY,
  property_id  bigint      NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  alias        text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  note         text
);

-- Global uniqueness on normalized alias (case- and whitespace-insensitive).
-- Prevents alias↔alias collision. Alias↔current-name shadow is caught by
-- the trigger below (unique index can't span two tables).
CREATE UNIQUE INDEX IF NOT EXISTS property_name_aliases_alias_uidx
  ON public.property_name_aliases (lower(trim(alias)));


-- ── STEP 2 — no-shadow trigger (alias must not duplicate a current name)

CREATE OR REPLACE FUNCTION public.property_name_alias_no_shadow()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $trg$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.properties
     WHERE lower(trim(name)) = lower(trim(NEW.alias))
       AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'alias % shadows an active property name (name→ID resolution requires uniqueness)', NEW.alias
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $trg$;

DROP TRIGGER IF EXISTS property_name_alias_no_shadow_biu ON public.property_name_aliases;
CREATE TRIGGER property_name_alias_no_shadow_biu
  BEFORE INSERT OR UPDATE OF alias ON public.property_name_aliases
  FOR EACH ROW EXECUTE FUNCTION public.property_name_alias_no_shadow();


-- ── STEP 3 — RLS ────────────────────────────────────────────────────

ALTER TABLE public.property_name_aliases ENABLE ROW LEVEL SECURITY;

-- Anon SELECT allowed (the RPC reads it via SECURITY DEFINER; explicit
-- policy so a direct-read regression fails visibly rather than silently).
-- Writes require admin (super-admin operational tool — no CA/manager
-- write path today; adding one would be a separate arc).
DROP POLICY IF EXISTS property_name_aliases_read_all ON public.property_name_aliases;
CREATE POLICY property_name_aliases_read_all
  ON public.property_name_aliases FOR SELECT
  USING (TRUE);


-- ── STEP 4 — amend get_property_for_visitor (2-step resolver) ───────

DROP FUNCTION IF EXISTS public.get_property_for_visitor(TEXT);

CREATE FUNCTION public.get_property_for_visitor(p_name TEXT)
RETURNS TABLE (id BIGINT, name TEXT, company TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
  -- 2-step resolver: direct name match wins over alias match (priority 1
  -- < priority 2). Alias can never shadow a live property because the
  -- direct branch takes precedence. Alias↔current-name shadow at INSERT
  -- time is blocked by property_name_alias_no_shadow trigger.
  --
  -- LIMIT 1 on the direct branch is pre-existing behaviour: if two
  -- active properties share a name, an arbitrary row is returned. That
  -- collision hazard is owned by the FK epic and is NOT introduced or
  -- fixed by this migration — the CTE preserves it verbatim.
  WITH direct AS (
    SELECT p.id, p.name, p.company, 1 AS priority
      FROM public.properties p
     WHERE lower(trim(p.name)) = lower(trim(p_name))
       AND p.is_active = TRUE
  ), aliased AS (
    SELECT p.id, p.name, p.company, 2 AS priority
      FROM public.property_name_aliases pna
      JOIN public.properties p ON p.id = pna.property_id
     WHERE lower(trim(pna.alias)) = lower(trim(p_name))
       AND p.is_active = TRUE
  )
  SELECT id, name, company
    FROM (SELECT * FROM direct UNION ALL SELECT * FROM aliased) matches
   ORDER BY priority
   LIMIT 1;
$func$;

-- Preserve original grants (DROP FUNCTION removes them).
REVOKE EXECUTE ON FUNCTION public.get_property_for_visitor(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_property_for_visitor(TEXT) TO anon, authenticated;


-- ── STEP 5 — signature invariant (exactly 1 overload) ──────────────

DO $chk$
DECLARE v_count INT;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'get_property_for_visitor';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_property_for_visitor has % overloads; expected 1', v_count;
  END IF;
END $chk$;

COMMIT;

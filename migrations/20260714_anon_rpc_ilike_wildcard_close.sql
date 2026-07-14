-- ════════════════════════════════════════════════════════════════════
-- Anon-callable RPCs — close ILIKE wildcard vector on all 3 name-args
-- 2026-07-14
--
-- ═══ CONVENTION CODIFIED HERE ═══════════════════════════════════════
-- 🔴 NO ANON-CALLABLE RPC TAKES A CALLER-SUPPLIED STRING INTO ILIKE.
-- 🔴 EVER. USE EXACT MATCH ON lower(trim(...)) INSTEAD.
--
-- ILIKE interprets wildcard metacharacters (%, _). A caller-supplied
-- string from a URL query param that reaches an ILIKE predicate is a
-- wildcard-injection primitive: %  matches all rows, %partial% enables
-- targeted confirmation, etc. Zero rows returned when the arg is
-- literal, every row returned when the arg is a wildcard. That is
-- exactly the class of bug this migration closes.
--
-- Prior art: get_company_admin_emails carries this exact rule in its
-- own header (2026-06-15 migration:226-228) — "The case-insensitive
-- equality (lower=lower) is deliberate; do NOT switch to ILIKE — see
-- the header block for the wildcard-injection reasoning." Rule was
-- documented a month ago and then violated by two RPCs shipped in the
-- same day (2026-06-12 B155.3). Writing the rule down was not enough.
-- This migration makes it a check, not a comment.
-- ════════════════════════════════════════════════════════════════════
--
-- ORIGIN
--   P0 identified 2026-07-13: unauthenticated cross-tenant property
--   enumeration via /visitor-select. Root cause: p_company=NULL
--   short-circuit AND ILIKE wildcard predicate — two vectors, one
--   RPC.  17a415b removed the login link (discovery-reduction).
--   20260713_visitor_select_null_branch_close.sql was drafted then
--   HELD when review caught that closing only the NULL branch left
--   the wildcard vector wide open (`?company=%` → every tenant).
--
--   Sweep (2026-07-13, requested by Mateo) confirmed two more RPCs
--   with identical vulnerability shape:
--     • get_company_branding(p_name)     — ILIKE p_name; LIMIT 1
--     • get_property_for_visitor(p_name) — ILIKE p_name; LIMIT 1
--
--   All three ship in this one migration atomically. If any one
--   assertion trips, all three roll back — no partial fix state.
--
-- WHAT CHANGES (predicate delta only; bodies preserved verbatim)
--   1. get_properties_for_visitor_select(p_company TEXT)
--        WHERE p.is_active = TRUE
--          AND (p_company IS NULL OR p.company ILIKE p_company)   ← REMOVED
--        →
--        WHERE p.is_active = TRUE
--          AND lower(trim(p.company)) = lower(trim(p_company))    ← NEW
--        Also: DEFAULT NULL removed from p_company signature.
--        NULL arg still returns zero rows (NULL = anything → UNKNOWN
--        → filtered by WHERE). Wildcard args now return zero rows too.
--
--   2. get_company_branding(p_name TEXT)
--        WHERE c.name ILIKE p_name AND c.is_active = TRUE         ← REMOVED
--        →
--        WHERE lower(trim(c.name)) = lower(trim(p_name))
--          AND c.is_active = TRUE                                 ← NEW
--
--   3. get_property_for_visitor(p_name TEXT)
--        WHERE p.name ILIKE p_name AND p.is_active = TRUE         ← REMOVED
--        →
--        WHERE lower(trim(p.name)) = lower(trim(p_name))
--          AND p.is_active = TRUE                                 ← NEW
--
--   All three use the SAME lower(trim(...)) normalization as
--   companies_name_lower_unique (256b803, 2026-07-13) and the
--   Commit A derivation join (d707e14, 2026-07-13). One normalization
--   rule across the schema.
--
-- 🔴 STANDING RULE (also codified in the header block above): any
--    free-text prose in a jsonb_build_object audit payload is
--    dollar-quoted using $txt$...$txt$, never single-quoted. Every
--    migration carries a paragraph of rationale; it is only a matter
--    of time before one contains an apostrophe, and the failure is a
--    parse error that points at the wrong line (the Supabase editor
--    parser has known-brittle string-state tracking across -- comment
--    boundaries). Dollar-quoting removes the whole class. Same rule
--    for header comments themselves: reword to avoid apostrophes
--    rather than rely on -- comment safety.
--
-- HAPPY PATH PRESERVED
--   Callers pass real, stored names — those names remain equal to
--   themselves under lower(trim(...)) on both sides. Every existing
--   flow (visitor QR, multi-property link, company branding lookup)
--   continues to resolve identically. Only wildcard-metacharacter
--   arguments change behavior — from "return matches" to "return zero".
--
-- WHY BUNDLED
--   Three RPCs, one class of bug, one migration. If we shipped them
--   separately, the second and third windows leave partial exposure
--   for as long as it takes to apply the follow-ups. Atomic apply
--   means the class is closed all at once.
--
-- DISCIPLINE (per 2026-07-13 correction)
--   DROP-first per RPC + pg_proc overload=1 assertion + REVOKE PUBLIC
--   + GRANT anon,authenticated re-applied. Whole migration in ONE
--   transaction. VQs test the threat, not the diff (see verification
--   pair).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════
-- RPC 1 of 3 — get_properties_for_visitor_select
-- ══════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.get_properties_for_visitor_select(TEXT);

CREATE FUNCTION public.get_properties_for_visitor_select(p_company TEXT)
RETURNS TABLE (id BIGINT, name TEXT, company TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
  SELECT p.id, p.name, p.company
  FROM properties p
  WHERE p.is_active = TRUE
    AND lower(trim(p.company)) = lower(trim(p_company))
  ORDER BY p.name;
$func$;

REVOKE EXECUTE ON FUNCTION public.get_properties_for_visitor_select(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_properties_for_visitor_select(TEXT) TO anon, authenticated;

DO $chk1$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_properties_for_visitor_select';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_properties_for_visitor_select has % overloads; expected 1', v_count;
  END IF;
END $chk1$;


-- ══════════════════════════════════════════════════════════════════
-- RPC 2 of 3 — get_company_branding
-- ══════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.get_company_branding(TEXT);

CREATE FUNCTION public.get_company_branding(p_name TEXT)
RETURNS TABLE (
  id              BIGINT,
  name            TEXT,
  display_name    TEXT,
  logo_url        TEXT,
  theme           TEXT,
  support_phone   TEXT,
  support_email   TEXT,
  support_website TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
  SELECT c.id, c.name, c.display_name, c.logo_url, c.theme,
         c.support_phone, c.support_email, c.support_website
  FROM companies c
  WHERE lower(trim(c.name)) = lower(trim(p_name))
    AND c.is_active = TRUE
  LIMIT 1;
$func$;

REVOKE EXECUTE ON FUNCTION public.get_company_branding(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_company_branding(TEXT) TO anon, authenticated;

DO $chk2$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_company_branding';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_company_branding has % overloads; expected 1', v_count;
  END IF;
END $chk2$;


-- ══════════════════════════════════════════════════════════════════
-- RPC 3 of 3 — get_property_for_visitor
-- ══════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.get_property_for_visitor(TEXT);

CREATE FUNCTION public.get_property_for_visitor(p_name TEXT)
RETURNS TABLE (id BIGINT, name TEXT, company TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
  SELECT p.id, p.name, p.company
  FROM properties p
  WHERE lower(trim(p.name)) = lower(trim(p_name))
    AND p.is_active = TRUE
  LIMIT 1;
$func$;

REVOKE EXECUTE ON FUNCTION public.get_property_for_visitor(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_property_for_visitor(TEXT) TO anon, authenticated;

DO $chk3$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_property_for_visitor';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_property_for_visitor has % overloads; expected 1', v_count;
  END IF;
END $chk3$;


-- ══════════════════════════════════════════════════════════════════
-- SCHEMA_ audit
-- ══════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (user_email, action, table_name, record_id, new_values, created_at)
VALUES (
  'system_migration_v1',
  'SCHEMA_ANON_RPC_ILIKE_WILDCARD_CLOSED',
  'proc',
  NULL,
  jsonb_build_object(
    'migration', '20260714_anon_rpc_ilike_wildcard_close',
    'change',    $txt$Replace ILIKE predicate with lower(trim(x)) = lower(trim(y)) on 3 anon-callable RPCs: get_properties_for_visitor_select (also removes DEFAULT NULL from p_company), get_company_branding, get_property_for_visitor. Closes wildcard injection vector (?company=%, ?name=%wrecker%, etc.). Preserves happy path for real names via same normalization used by companies_name_lower_unique + Commit A derivation join. Bundled atomically — one transaction, three DROP-first + pg_proc overload=1 assertions.$txt$,
    'rationale', $txt$B155.3 (2026-06-12) shipped these three RPCs with ILIKE predicates on caller-supplied strings. get_company_admin_emails migration (2026-06-15) documented the wildcard-injection class in its header and used the lower=lower exact-match pattern — but the three earlier RPCs kept ILIKE. P0 caught 2026-07-13 on /visitor-select (NULL branch AND wildcard branch); Commit 2 draft closing only NULL was HELD when review caught the wildcard vector remained. This migration closes all three atomically. Convention codified in header: no anon-callable RPC takes a caller-supplied string into ILIKE — ever. Companion standing rule (added 2026-07-14 after apostrophe-in-comment tripped the SQL editor): dollar-quote any free-text prose in audit payloads, never single-quote.$txt$
  ),
  now()
);

COMMIT;

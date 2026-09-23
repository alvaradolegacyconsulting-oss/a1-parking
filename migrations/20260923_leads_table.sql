-- ════════════════════════════════════════════════════════════════════
-- leads — negotiated-deal intake (2026-09-23)
-- Commit 1 of 4. Implements SCOPE_negotiated_intake_and_quote_generator
-- _aug28_2026.md plus the Sept 23 greenlight decisions D1–D3.
-- ════════════════════════════════════════════════════════════════════
--
-- 🔴 APPLY DISCIPLINE — paste this whole file, Run ONCE. It is a
-- one-time migration, NOT re-runnable: the CREATE TABLE is guarded by
-- IF NOT EXISTS but the policy and grant statements are idempotent by
-- DROP-then-CREATE. Run the paired _verification.sql afterwards.
--
-- ── WHAT THIS IS ────────────────────────────────────────────────────
-- Prospect intake for the two NEGOTIATED tracks. Two entry surfaces
-- write here — the /operators ad landing page and (later) the full
-- public form — through ONE server route using the service role. There
-- is deliberately no second table and no second endpoint.
--
-- ── 🔴 THIS TABLE HOLDS PROSPECT PII AND HAS NO PUBLIC READ PATH ────
-- Name, email and phone of people who are not customers. The insert
-- path is an UNAUTHENTICATED public POST, which is exactly why anon
-- gets NO grant at all: the server route holds the service role and
-- writes on the caller's behalf. Adding an anon INSERT policy would
-- make the table directly writable from any browser — do not add one,
-- and see the grant block below for why the absence is deliberate
-- rather than an oversight.
--
-- ── VOCABULARY: track reuses the EXISTING strings ───────────────────
-- app/lib/stripe-catalog.ts already defines
--     type Track = 'enforcement' | 'property_management'
-- and those are the same two branches the scope describes (a towing /
-- enforcement operator, versus a company that manages properties).
-- Inventing a parallel spelling here — 'legacy' / 'pm_multi' — would
-- create a vocabulary boundary that every future join has to translate
-- across, and a cast at a vocabulary boundary turns compile-time errors
-- into runtime ones. Same strings, no translation layer.
--
-- Track is DERIVED, never selected by the prospect. The public form
-- asks "which describes your business"; /operators pre-sets it to
-- 'enforcement' because the ads driving that traffic aim at operators.
--
-- ── 🔴 NULLABILITY: three-state booleans, on purpose ────────────────
-- texas_confirmed and wants_demo are NULLABLE with no default, which
-- may look like an omission. It is not.
--
--   NULL   the form did not ask
--   false  the form asked and they said no
--   true   they said yes
--
-- A NOT NULL DEFAULT false would collapse the first two, and "nobody
-- has confirmed they are in Texas" would become indistinguishable from
-- "they told us they are not." The /operators page collects fewer
-- fields than the full form by design, so this distinction is live from
-- day one, not hypothetical. Every field the ad page omits must be
-- nullable; only email and track are NOT NULL, because a lead without
-- an address is not a lead and track is always derived.
--
-- ── D1: source is jsonb with a DATABASE-LEVEL ALLOWLIST BACKSTOP ────
-- The route filters query parameters to four keys and caps their
-- length. The CHECK below enforces the same shape at the table, because
-- this column is written from attacker-controlled URL parameters and a
-- single guard layer is one refactor away from being no guard layer.
--
-- It is expressed WITHOUT a subquery: CHECK constraints forbid them
-- (the same restriction that shaped the user_roles metachar CHECK).
-- Subtracting the four permitted keys must leave an empty object — any
-- surviving key is a key we did not allow. The total-length cap bounds
-- volume without needing to walk the values.
--
-- 🔴 The route remains the PRIMARY filter. This CHECK rejects the write
-- outright, which for a lead form means losing the lead. The route must
-- DROP unknown keys silently so a stray parameter never costs us a
-- prospect; this constraint exists to catch a route that stops doing so.

CREATE TABLE IF NOT EXISTS public.leads (
  id                      BIGSERIAL PRIMARY KEY,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- identity ────────────────────────────────────────────────────────
  company_name            TEXT,
  contact_name            TEXT,
  email                   TEXT NOT NULL,
  phone                   TEXT,

  -- qualification ───────────────────────────────────────────────────
  track                   TEXT NOT NULL,
  property_count          INTEGER,
  scale_note              TEXT,   -- rough unit/permit scale, free text
  timeline                TEXT,
  growth_trend            TEXT,
  texas_confirmed         BOOLEAN,

  -- intent ──────────────────────────────────────────────────────────
  wants_demo              BOOLEAN,

  -- attribution ─────────────────────────────────────────────────────
  source                  JSONB,

  -- housekeeping ────────────────────────────────────────────────────
  status                  TEXT NOT NULL DEFAULT 'new',

  -- D2: alert bookkeeping. Turns "did anyone get told about this lead"
  -- into a query instead of a question. NULL = the send has not been
  -- attempted yet, which is distinct from false = attempted and failed.
  alert_email_sent        BOOLEAN,
  alert_email_message_id  TEXT,
  alert_email_error       TEXT,

  CONSTRAINT leads_track_valid CHECK (
    track IN ('enforcement', 'property_management')
  ),

  CONSTRAINT leads_status_valid CHECK (
    status IN ('new', 'quoted', 'sent', 'won', 'lost')
  ),

  CONSTRAINT leads_property_count_sane CHECK (
    property_count IS NULL OR (property_count >= 0 AND property_count <= 10000)
  ),

  -- Subquery-free allowlist. See the note above.
  CONSTRAINT leads_source_allowlisted CHECK (
    source IS NULL OR (
      jsonb_typeof(source) = 'object'
      AND source - 'utm_source' - 'utm_medium' - 'utm_campaign' - 'src' = '{}'::jsonb
      AND length(source::text) <= 400
    )
  )
);

COMMENT ON TABLE public.leads IS
  'Negotiated-deal prospect intake (2026-09-23). Written ONLY by the server route at /api/leads using the service role; anon has no grant. Holds prospect PII — readable by super-admin only via RLS. track reuses the stripe-catalog Track vocabulary (enforcement | property_management) and is DERIVED, never selected by the prospect. texas_confirmed and wants_demo are three-state on purpose: NULL means the form did not ask.';

COMMENT ON COLUMN public.leads.source IS
  'Ad attribution from URL query parameters. Allowlisted to utm_source / utm_medium / utm_campaign / src by the route AND by leads_source_allowlisted. NULL when the visitor arrived with no recognized parameters — never {} and never a guessed value.';

-- Console Leads view will read newest-first. Cheap now, awkward later.
CREATE INDEX IF NOT EXISTS leads_created_at_desc_idx ON public.leads (created_at DESC);
CREATE INDEX IF NOT EXISTS leads_status_idx          ON public.leads (status);


-- ════════════════════════════════════════════════════════════════════
-- GRANTS — anon gets nothing, and that is the whole design
-- ════════════════════════════════════════════════════════════════════
-- Standing rule: REVOKE anon explicitly on every new public-schema
-- table. Supabase's default grants to anon/authenticated on new tables
-- are the reason this is stated rather than assumed.
--
-- 🔴 The INSERT path is a PUBLIC UNAUTHENTICATED POST and anon still
-- gets no grant. That is not a contradiction: the browser never touches
-- this table. It POSTs to /api/leads, which verifies Turnstile, runs
-- guardEmail, and inserts with the SERVICE ROLE. Granting anon INSERT
-- would let anyone skip all three and write rows directly.
--
-- authenticated keeps SELECT ONLY, narrowed to super-admin by the
-- policy below. The grant has to exist for the policy to have anything
-- to narrow — REVOKE-ing it would make the admin read fail regardless
-- of the policy.

REVOKE ALL ON public.leads FROM anon;
REVOKE ALL ON public.leads FROM authenticated;
REVOKE ALL ON SEQUENCE public.leads_id_seq FROM anon;
REVOKE ALL ON SEQUENCE public.leads_id_seq FROM authenticated;

GRANT SELECT ON public.leads TO authenticated;
GRANT ALL    ON public.leads TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.leads_id_seq TO service_role;


-- ════════════════════════════════════════════════════════════════════
-- RLS — super-admin read, nothing else
-- ════════════════════════════════════════════════════════════════════
-- 🔴 RLS enabled with EXACTLY ONE policy. A table with RLS enabled and
-- NO policy denies everyone, which is safe but looks identical to a
-- misconfiguration; a table with RLS enabled and a permissive wildcard
-- looks safe and is not. One named SELECT policy, admin only.
--
-- get_my_role() is the equality-locked helper (b155.2 shape). It is
-- deliberately NOT an `email ~~*` comparison — this table is exactly
-- the kind the September ILIKE arc exists to keep off that pattern.
--
-- service_role BYPASSES RLS, which is how the route inserts. No INSERT,
-- UPDATE or DELETE policy is defined for anyone. If a super-admin Leads
-- view later needs to change `status`, that is an UPDATE policy added
-- deliberately at that time — not pre-granted here on the theory that
-- it will be wanted.

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_select_leads ON public.leads;
CREATE POLICY admin_select_leads ON public.leads
  FOR SELECT TO authenticated
  USING (public.get_my_role() = 'admin');


-- ════════════════════════════════════════════════════════════════════
-- Schema audit row
-- ════════════════════════════════════════════════════════════════════
INSERT INTO public.audit_logs (action, table_name, record_id, new_values, created_at)
VALUES (
  'SCHEMA_LEADS_TABLE_CREATE',
  'public.leads',
  'leads',
  jsonb_build_object(
    'migration',  '20260923_leads_table',
    'commit',     'Commit 1 of 4 — negotiated intake + /operators',
    'track_vocab','enforcement | property_management (reuses stripe-catalog Track)',
    'status_vocab','new | quoted | sent | won | lost',
    'rls',        'ENABLED, one policy: admin_select_leads (SELECT, authenticated, get_my_role()=admin)',
    'grants',     'anon REVOKED entirely; authenticated SELECT only; service_role ALL',
    'insert_path','server route /api/leads via service role — no anon INSERT policy by design',
    'source',     'jsonb, allowlisted to utm_source/utm_medium/utm_campaign/src by CHECK as a backstop to the route filter',
    'nullability','texas_confirmed and wants_demo are three-state (NULL = form did not ask)'
  ),
  now()
);

-- ════════════════════════════════════════════════════════════════════
-- B118 commit 1.1 — tos_acceptances CHECK constraint extension (hotfix)
-- Drafted: 2026-05-26 — NOT YET APPLIED.
--
-- Hotfix for the smoke Test 1 failure on B118 arc. The B118 commit 1
-- migration (20260604_b118_consent_version_tracking.sql, applied
-- e956f54) added the schema columns + RPCs but did NOT extend the
-- two pre-existing CHECK constraints on tos_acceptances. Those
-- constraints date to B66.3 commit 1 (20260601_b66_3_b99_signup_and_
-- password_reset.sql) and only admit the 'tos_and_privacy' + 'texas_
-- attestation' document_type values + corresponding version-population
-- shapes. B118's separate 'tos' + 'privacy' row INSERTs from
-- accept_signup_consents and accept_tos (2-arg) are rejected by both
-- constraints at write time.
--
-- Symptom captured during smoke Test 1 (sampayo@alvaradolegacy
-- consultingllc.com, /signup/verify mount → /api/signup/attest call):
--   accept_signup_consents RPC failed: new row for relation
--   "tos_acceptances" violates check constraint
--   "tos_acceptances_document_type_valid"
--
-- Transaction rolled back atomically — production state clean (no
-- orphan rows; B118 commit 1 columns + RPCs + GRANTs all intact).
-- Smoke retry waits on this hotfix applying.
--
-- ── AUDIT-PASS DISCIPLINE GAP (Jose-flagged for memory) ─────────────
-- The B118 commit 1 audit-pass (AP.1 + AP.2 + AP.3) covered columns,
-- RLS, RPCs, and grants — but did NOT query CHECK constraints. Second
-- recurrence of "schema gap missed at audit-pass time" in the B118
-- arc alone (first being the partial-apply finding). For memory
-- housekeeping: extend feedback_audit_pass_must_query_production_
-- schema with the constraint-surface case. Going-forward query
-- pattern for any work that INSERTs/UPDATEs:
--
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.<table>'::regclass AND contype = 'c';
--
-- ── PARTS ───────────────────────────────────────────────────────────
--   1. tos_acceptances_document_type_valid CHECK — extend whitelist
--      from 2 values to 4 (add 'tos' + 'privacy').
--   2. tos_acceptances_version_match CHECK — extend from 2 branches
--      to 4 (add separate 'tos' and 'privacy' single-version-populated
--      shapes alongside the existing 'tos_and_privacy' both-versions-
--      populated and 'texas_attestation' attestation-version-only
--      shapes).
--
-- ── PATTERN — DROP + ADD with DO $func$ IF NOT EXISTS guard ─────────
-- Postgres has no ALTER CHECK CONSTRAINT in-place. The DROP + ADD
-- sequence replaces each constraint atomically within the BEGIN/COMMIT.
-- DROP CONSTRAINT IF EXISTS makes the drop idempotent. The ADD is
-- wrapped in DO $func$ IF NOT EXISTS so re-apply is a no-op after
-- the constraint exists with the new shape. Tagged $func$ delimiter
-- per feedback_sql_editor_dollar_quote_parsing (single function body
-- here; the discipline still applies).
--
-- ── DELIBERATELY OUT OF SCOPE ────────────────────────────────────────
-- • RPC bodies (accept_signup_consents, accept_tos 2-arg, redeem_
--   proposal_code) — all correct as shipped in B118 commit 1. The
--   constraint shape was the gap, not the RPC logic.
-- • Backfill of existing 'tos_and_privacy' rows to separate 'tos' +
--   'privacy' rows — intentional. Existing rows stay in the legacy
--   single-row shape; the modal-decision query (commit 3) already
--   handles both shapes (document_type IN ('tos','tos_and_privacy')
--   for the ToS check; same for Privacy). No data migration needed.
--
-- ── APPLY DISCIPLINE ────────────────────────────────────────────────
-- SINGLE-PASTE SINGLE-RUN. Single function body uses $func$ tagged
-- delimiter per feedback_sql_editor_dollar_quote_parsing. BEGIN/COMMIT
-- atomic. All DDL idempotent (DROP CONSTRAINT IF EXISTS + DO $func$
-- IF NOT EXISTS guard on ADD). Safe to re-apply.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- PART 1 — Extend document_type whitelist to 4 values
-- ════════════════════════════════════════════════════════════════════
-- Old whitelist: 'tos_and_privacy', 'texas_attestation' (2 values, B66.3
-- commit 1 era).
-- New whitelist: + 'tos' + 'privacy' (B118 separate-row shapes).
-- The legacy values are preserved so existing rows (1 row from the
-- May 25 B65.4 smoke, normalized in B118 commit 1 PART 5) continue
-- to validate.

ALTER TABLE tos_acceptances DROP CONSTRAINT IF EXISTS tos_acceptances_document_type_valid;

DO $func$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tos_acceptances_document_type_valid'
  ) THEN
    ALTER TABLE tos_acceptances
      ADD CONSTRAINT tos_acceptances_document_type_valid
      CHECK (document_type = ANY (ARRAY['tos_and_privacy', 'texas_attestation', 'tos', 'privacy']));
  END IF;
END
$func$;

-- ════════════════════════════════════════════════════════════════════
-- PART 2 — Extend version_match constraint to 4 branches
-- ════════════════════════════════════════════════════════════════════
-- Preserves Jose's locked Option A choice (extend both, vs Option B
-- drop version_match entirely). Each row shape stays validated; just
-- adds the two new B118 shapes to the disjunction.
--
-- Four valid row shapes covered:
--   1. tos_and_privacy: both tos_version + privacy_version populated;
--      attestation_version NULL. Legacy B65 proposal-code shape.
--   2. texas_attestation: attestation_version populated; tos_version
--      + privacy_version NULL. B66.3 self-serve shape.
--   3. tos: tos_version populated; privacy_version + attestation_version
--      NULL. B118 separate-row shape (accept_signup_consents +
--      accept_tos 2-arg).
--   4. privacy: privacy_version populated; tos_version + attestation_
--      version NULL. Sibling B118 shape.

ALTER TABLE tos_acceptances DROP CONSTRAINT IF EXISTS tos_acceptances_version_match;

DO $func$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tos_acceptances_version_match'
  ) THEN
    ALTER TABLE tos_acceptances
      ADD CONSTRAINT tos_acceptances_version_match
      CHECK (
        (document_type = 'tos_and_privacy'
           AND tos_version IS NOT NULL
           AND privacy_version IS NOT NULL
           AND attestation_version IS NULL)
        OR
        (document_type = 'texas_attestation'
           AND attestation_version IS NOT NULL
           AND tos_version IS NULL
           AND privacy_version IS NULL)
        OR
        (document_type = 'tos'
           AND tos_version IS NOT NULL
           AND privacy_version IS NULL
           AND attestation_version IS NULL)
        OR
        (document_type = 'privacy'
           AND privacy_version IS NOT NULL
           AND tos_version IS NULL
           AND attestation_version IS NULL)
      );
  END IF;
END
$func$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run after migration applies)
--
-- ── VQ.A — document_type whitelist now has 4 values
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'tos_acceptances_document_type_valid';
--   -- Expected: CHECK ((document_type = ANY (ARRAY['tos_and_privacy'::text,
--   --   'texas_attestation'::text, 'tos'::text, 'privacy'::text])))
--
-- ── VQ.B — version_match constraint now has 4 branches
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'tos_acceptances_version_match';
--   -- Expected: CHECK ((( ... 'tos_and_privacy' ... ) OR ( ... 'texas_attestation' ...
--   --   ) OR ( ... 'tos' AND tos_version IS NOT NULL ... )
--   --   OR ( ... 'privacy' AND privacy_version IS NOT NULL ... )))
--
-- ── VQ.C — load-bearing: existing rows still pass under new constraints
-- Validates that the extension didn't break any pre-existing row's
-- compliance. If any row appears with "violates" semantics, the
-- migration is broken; investigate before retrying smoke.
--
--   SELECT id, document_type,
--          tos_version IS NOT NULL AS has_tos,
--          privacy_version IS NOT NULL AS has_priv,
--          attestation_version IS NOT NULL AS has_attest
--   FROM tos_acceptances;
--   -- Expected: every row falls into one of the 4 valid shapes.
--   -- After B118 commit 1 PART 5 normalization, the one row from May
--   -- 25 B65.4 smoke should show as document_type='tos_and_privacy',
--   -- has_tos=true, has_priv=true, has_attest=false.
--
-- ── VQ.D — negative test: rejected shape still gets rejected
-- Confirms the constraint actually enforces the 4-shape disjunction
-- + nothing else. Direct INSERT outside DO/EXCEPTION per
-- feedback_sql_editor_dollar_quote_parsing extension (transparent
-- error display vs. RAISE NOTICE buried in Messages panel).
--
-- Run as service_role (admin RLS gates non-admin INSERTs). Uses a
-- real user_id (any existing auth.users row will do; substitute one
-- from your AP.2 query results) to force the CHECK to evaluate vs.
-- failing at FK first.
--
--   INSERT INTO tos_acceptances (user_id, document_type, accepted_at)
--   VALUES ('<real-uuid-here>'::uuid, 'invalid_doc_type', now());
--   -- Expected: red error in SQL Editor —
--   --   "ERROR: new row for relation 'tos_acceptances' violates check
--   --    constraint 'tos_acceptances_document_type_valid'"
--   --   (because 'invalid_doc_type' is not in the 4-value whitelist).
--   -- No row inserted. Cleanup not needed (CHECK rejects pre-write).
--
-- ── SAFETY ──────────────────────────────────────────────────────────
-- All DDL idempotent:
--   • DROP CONSTRAINT IF EXISTS (no-op when already dropped)
--   • DO $func$ IF NOT EXISTS ... ADD CONSTRAINT (no-op on re-apply
--     when constraint exists with target name)
-- BEGIN/COMMIT atomic — any failure rolls back both PARTs. Safe to
-- re-apply.
-- ════════════════════════════════════════════════════════════════════

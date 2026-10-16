-- ════════════════════════════════════════════════════════════════════
-- Load / Return / Reject notification outcomes on import_batches
-- ════════════════════════════════════════════════════════════════════
-- Ruled 2026-10-16. A load, a return and a reject each send mail, and a
-- mail failure MUST NOT fail the action. The outcome is therefore
-- recorded on the batch and shown in the queue, so a send that did not
-- happen is visible instead of being a best-effort reported as success.
--
-- 🔴 WHY THREE-VALUED AND NOT A BOOLEAN. sendCompanyScopedEmail already
-- answers 'sent' | 'overridden' | 'failed', because a test or demo
-- tenant's mail is redirected to EMAIL_OVERRIDE_TO rather than sent to
-- the customer. Collapsing that into sent/not-sent would report every
-- demo load as a successful notification to a CA who was never written
-- to. The column keeps the provider's own vocabulary plus 'skipped'
-- for the case where there was no recipient to write to at all.
--
-- 🔴 NULL MEANS NOT ATTEMPTED, AND THAT IS A REAL STATE. Batches 8
-- through 56 pre-date this and must not read as failures. A gate that
-- treats NULL as a failure would light up the whole history; the queue
-- shows nothing for NULL and a reason only for 'failed'.

ALTER TABLE public.import_batches
  ADD COLUMN IF NOT EXISTS notify_ca_outcome    TEXT,
  ADD COLUMN IF NOT EXISTS notify_admin_outcome TEXT,
  ADD COLUMN IF NOT EXISTS notify_error         TEXT,
  ADD COLUMN IF NOT EXISTS notified_at          TIMESTAMPTZ;

-- The vocabulary, so a typo'd outcome cannot be written and then read
-- back as if it meant something. NULL stays allowed: see above.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.import_batches'::regclass
       AND conname = 'import_batches_notify_ca_outcome_check'
  ) THEN
    ALTER TABLE public.import_batches
      ADD CONSTRAINT import_batches_notify_ca_outcome_check
      CHECK (notify_ca_outcome IS NULL
             OR notify_ca_outcome IN ('sent', 'overridden', 'failed', 'skipped'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.import_batches'::regclass
       AND conname = 'import_batches_notify_admin_outcome_check'
  ) THEN
    ALTER TABLE public.import_batches
      ADD CONSTRAINT import_batches_notify_admin_outcome_check
      CHECK (notify_admin_outcome IS NULL
             OR notify_admin_outcome IN ('sent', 'overridden', 'failed', 'skipped'));
  END IF;
END
$do$;

COMMENT ON COLUMN public.import_batches.notify_ca_outcome IS
  'Mail to the submitting company_admin: sent | overridden (redirected to EMAIL_OVERRIDE_TO for a test/demo tenant) | failed | skipped (no recipient). NULL = not attempted, which is every batch before 2026-10-16. Written AFTER the action commits; a mail failure never fails a load.';
COMMENT ON COLUMN public.import_batches.notify_admin_outcome IS
  'Mail to super-admin, anchored on the BATCH''S company rather than on the recipient, because a super-admin address resolves to no company and would land in the resolver''s company-not-found branch. Same vocabulary as notify_ca_outcome.';
COMMENT ON COLUMN public.import_batches.notify_error IS
  'The reason a send did not succeed, shown in the queue as "loaded · notification failed: {reason}". Set only when an outcome is failed.';
COMMENT ON COLUMN public.import_batches.notified_at IS
  'When the notification attempt finished. Set on every attempt, including a failed one — the attempt happened even though the mail did not.';

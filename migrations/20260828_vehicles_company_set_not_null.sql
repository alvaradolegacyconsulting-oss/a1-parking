-- ══════════════════════════════════════════════════════════════════════
-- 20260828_vehicles_company_set_not_null.sql
--
-- 🟢 vehicles.company arc — COMMIT 4 of 4 (final)
--
-- Flips public.vehicles.company from nullable → NOT NULL. Every prior
-- commit exists to make this ALTER structurally safe:
--
--   Commit 1 (45a46c0)  ADD COLUMN nullable, no default; PostgREST gate
--   Commit 2 (4f08f06)  Every writer path stamps company on INSERT
--                       (5 production paths + 2 seed scripts verified)
--   Commit 2 DB (0209534 + e740df6)
--                       request_my_vehicle + get_residents_row_by_precedence
--                       stamp company on RPC-driven writes
--   Commit 3 (99503c8)  Backfill legacy NULL rows from properties JOIN
--                       (337 backfilled; PASS on 4 gates 22:35 2026-08-28)
--   Seed Commit 2 (a71d7d2)
--                       seed_demo_data() stamps c_company on demo INSERTs
--   ── THIS FILE ──     SET NOT NULL
--
-- ── PRECONDITIONS (verified live before write) ─────────────────────
--   • Commit 3 backfill PASS: rows_backfilled_last_run=337, still_null=0,
--     mismatched=0, orphaned=0 (Jose apply 2026-08-28 22:31–22:35)
--   • Zero A1 vehicles with NULL company (V3.1 gate)
--   • seed_demo_data() body carries `company, c_company` on the demo
--     vehicles INSERT (a71d7d2; before-and-after pg_get_functiondef
--     diff MUST show only that change)
--   • Test-LEGACY 5-path smoke run, probe rows deleted (Jose responsibility
--     immediately before apply — see APPLY checklist below)
--
-- ── ACCESS EXCLUSIVE LOCK WINDOW ────────────────────────────────────
-- SET NOT NULL requires ACCESS EXCLUSIVE on public.vehicles for the
-- duration of a full-table scan (Postgres validates every row satisfies
-- NOT NULL before flipping the flag). At A1's current row count
-- (~345 as of Aug 28), the scan is sub-second. Not streamed / not
-- concurrent — inline is fine.
--
-- Any concurrent writer during the ALTER window queues briefly then
-- proceeds. No writer failures expected. Deploy window: any time.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────
-- Reversible by a separate migration issuing
--   ALTER TABLE public.vehicles ALTER COLUMN company DROP NOT NULL;
-- Not scripted here — production is expected to hold this constraint
-- permanently. Any rollback path first requires re-auditing every
-- consumer that came to depend on the NOT NULL invariant.
--
-- ── APPLY CHECKLIST (Jose) ──────────────────────────────────────────
--   1. Test-LEGACY 5-path smoke: exercise each of the 5 production
--      writers (Commit 2 paths). Confirm every INSERT lands with a
--      non-NULL company. Delete probe rows.
--   2. Re-run backfill verification (still_null must remain 0):
--        \i migrations/20260828_vehicles_company_backfill_verification.sql
--   3. Apply THIS file. Expect: `NOTICE: SET NOT NULL applied cleanly`
--   4. Run paired verification:
--        \i migrations/20260828_vehicles_company_set_not_null_verification.sql
--      Expect one PASS row on 5 structural+execution gates.
--   5. Deferred: re-run the V4.A1_DRIFT block (bottom of the verification
--      file) after A1 has had a few hours of natural traffic so
--      created_since_deploy > 0 becomes real. Zero created_since_deploy
--      is NOT a pass — it means nothing has exercised the new constraint.
--
-- ── 🔴 EXPLICIT NON-GOAL (unchanged from Commit 1) ──────────────────
-- No RLS policy may reference vehicles.company yet. That's the A2
-- cascade arc, separate preflight, separate commit. This commit only
-- guarantees the column is present + non-NULL on every row + enforced
-- on every future write. RLS rewrites keyed on company are the payoff
-- but come next.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── The one operation ───────────────────────────────────────────────
-- Postgres validates every existing row satisfies NOT NULL, then
-- flips pg_attribute.attnotnull. If any row has NULL company, the
-- ALTER raises 23502 and the transaction aborts — safe fail.
ALTER TABLE public.vehicles
  ALTER COLUMN company SET NOT NULL;

-- Schema audit row — anchor timestamp for V4.A1_DRIFT deferred gate.
INSERT INTO public.audit_logs (action, table_name, record_id, new_values)
VALUES (
  'SCHEMA_VEHICLES_COMPANY_SET_NOT_NULL',
  'public.vehicles',
  'company',
  jsonb_build_object(
    'migration',        '20260828_vehicles_company_set_not_null',
    'arc',              'vehicles.company arc — Commit 4 of 4 (final)',
    'operation',        'ALTER COLUMN company SET NOT NULL',
    'preconditions',    jsonb_build_object(
      'commit_3_pass',        'rows_backfilled_last_run=337, still_null=0, mismatched=0, orphaned=0',
      'seed_rpc_updated',     'a71d7d2 — seed_demo_data() stamps c_company on vehicles INSERT',
      'writers_stamped',      '4f08f06 — 5 production writer paths',
      'test_legacy_smoke',    'Jose runs immediately pre-apply; probes deleted'
    ),
    'lock_window',      'ACCESS EXCLUSIVE on public.vehicles for full-table scan (~345 rows, sub-second)',
    'next_verify',      '20260828_vehicles_company_set_not_null_verification.sql (5 gates immediate; V4.A1_DRIFT deferred)',
    'unlocks',          'A2 super-admin cascade RLS rewrites keyed on vehicles.company (separate arc, own preflight)'
  )
);

COMMIT;

-- ── After COMMIT — schema cache reload ──────────────────────────────
-- NOTIFY pgrst so PostgREST picks up the NOT NULL constraint change
-- (affects error messages surfaced to the client on failed writes,
-- and any generated OpenAPI schema).
NOTIFY pgrst, 'reload schema';

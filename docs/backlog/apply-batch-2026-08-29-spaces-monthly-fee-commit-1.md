# APPLY BATCH — Reserved-space payment tracking Commit 1 (2026-08-29)

**For:** Jose. Paste, read, next.
**Two files. One goes first.** File 2 (verification) hard-fails if File 1 wasn't applied.
**Prereq:** vehicles.company Commit 4 (`855a034`) applied and VQ1-VQ4 passed. Nothing else.
**TS changes ship with this commit** — no Jose action needed for the app code; Vercel picks it up on the next deploy after the DB migration lands. But the DB migration must land BEFORE the deploy, or the deployed app calls a 6-arg RPC that doesn't exist yet.

---

## What this adds

- `spaces.monthly_fee NUMERIC(10,2) NULL` — nullable metadata column, INERT to the system.
- `update_space_metadata()` extends from 5-arg to 6-arg. Old 5-arg signature is DROPPED, not left as an overload. Every tracked caller updated in the same commit (manager, CA, probe script — 3 files, 8 sites total).

Ledger table, record action, month view, and monthly report are Commits 2-4. This is column + RPC only.

---

## 🔴 Deploy sequencing — DB first, THEN Vercel

The TypeScript changes call the 6-arg RPC. If Vercel deploys the app while production DB still has the 5-arg signature, every space edit fails with `function does not exist`. Order:

1. Apply the two DB files below in SQL Editor. Confirm PASS row.
2. THEN merge/deploy the app changes (they're already committed at SHA populated on push).

The reverse order breaks manager + CA space editing until step 1 completes.

---

## Files in order

| # | File | Type | Size |
|---|------|------|------|
| 1 | `migrations/20260829_spaces_add_monthly_fee_and_extend_rpc.sql` | DDL: ADD COLUMN + DROP old RPC + CREATE new RPC + audit | ~185 lines |
| 2 | `migrations/20260829_spaces_add_monthly_fee_and_extend_rpc_verification.sql` | 8 gates including 4 execution tests; returns PASS row | ~220 lines |

Raw-file access for one-click paste: replace `/blob/` with `/raw/` in any GitHub URL.

---

## FILE 1 — ADD COLUMN + RPC signature swap

### Pre-apply — nothing required

The migration is `IF NOT EXISTS` on the ADD COLUMN and `DROP FUNCTION IF EXISTS` on the old RPC, so a re-run is a no-op. But re-runs write duplicate schema audit rows. Prefer applying once.

### Apply

Paste File 1. Wrapped in `BEGIN; ... COMMIT;`.

**Expected output:**
- `NOTICE` messages: none expected in the happy path
- Silent COMMIT
- `NOTIFY pgrst 'reload schema'` fires

**Failure mode:** any DDL error → transaction rolls back → nothing changed. Safe.

### What just happened (for your mental model)

- New column `spaces.monthly_fee NUMERIC(10,2) NULL` — every row's fee is NULL (no backfill; the column starts empty).
- Old `update_space_metadata(BIGINT, TEXT, TEXT, TEXT, BOOLEAN)` — GONE.
- New `update_space_metadata(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, NUMERIC)` — LIVE.
- Any 5-arg caller from a previous Vercel deploy that hasn't been redeployed yet would now fail with `function does not exist`. That's the correct failure mode — noisy, not silent. Ship the app deploy immediately after.

### Idempotency + failure

- **Idempotent:** Yes on structural changes (`IF NOT EXISTS`, `DROP ... IF EXISTS`); a re-run adds a duplicate schema audit row.
- **Blocks File 2:** Yes. Every gate in File 2 asserts something File 1 changed.
- **Safe to stop after:** Yes. Rollback is:
  ```sql
  ALTER TABLE public.spaces DROP COLUMN monthly_fee;
  DROP FUNCTION public.update_space_metadata(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, NUMERIC);
  -- Then re-apply the pre-2026-08-29 5-arg CREATE OR REPLACE from
  -- migrations/20260621_spaces_v1_metadata_rpc.sql
  ```
  Not scripted. Production is expected to hold this permanently.

---

## FILE 2 — Verification (8 gates)

### Apply

Paste File 2. NO `BEGIN/COMMIT` wrap (v2 pattern).

**Expected output:** one PASS row with the 8 gate names. Any gate raises → paste aborts with a specific FAIL message.

### 🔴 One prereq for the execution gates

**VQ4-VQ7 impersonate a Test-LEGACY manager via `SET LOCAL request.jwt.claims`.** The DO block resolves any manager/company_admin at Test-LEGACY, so as long as one exists (which it does), no manual JWT setup is needed. If VQ4 raises `PREREQ FAIL: no manager or company_admin found for company Test-LEGACY`, the gate would need a hand-supplied email — but that shouldn't fire.

### What each VQ asserts

| VQ | Asserts | Pass shape |
|----|---------|------------|
| VQ1 | `spaces.monthly_fee` is NUMERIC(10,2) nullable | silent |
| VQ2 | OLD 5-arg `update_space_metadata` is GONE (no overload alive that a stale caller could hit) | silent |
| VQ3 | NEW 6-arg `update_space_metadata` exists + is SECURITY DEFINER | silent |
| **VQ4** | 🔴 EXECUTION — RPC call with fee=42.50 stores 42.50 (write-then-read) | silent |
| **VQ5** | 🔴 EXECUTION — RPC no-op edit (same 6 args) preserves fee, not nulls it. Belt-and-braces on Mateo Aug 29 §2.4's "single most likely way Commit 1 goes wrong." Even with the DROP-old-signature approach making 5-arg calls fail-loud, this proves no-op edits don't wipe. | silent |
| **VQ6** | 🔴 EXECUTION — RPC call with fee=NULL clears the fee (semantics = "no fee") | silent |
| VQ7 | EXECUTION — RPC call with fee=-1 raises `monthly_fee_negative` (validation branch fires) | silent |
| VQ8 | `SCHEMA_SPACES_ADD_MONTHLY_FEE` audit row exists | silent |
| — | Terminal SELECT returns one row: `status='PASS'`, 8 gates, verified_at | one row visible |

**Probe row lifecycle:** VQ4-VQ7 share one synthetic Test-LEGACY space with label prefix `__V-COMMIT-1-PROBE-<epoch>`. Deleted at end of the DO block. If any VQ raises mid-sequence, the row survives — manual cleanup is:

```sql
DELETE FROM public.spaces WHERE label LIKE '__V-COMMIT-1-PROBE-%';
```

(Also documented at the bottom of File 2.)

### Idempotency + failure

- **Idempotent:** Yes (read-mostly; the one INSERT is deleted by end of DO block on success).
- **Failure mode:** RAISE with specific FAIL prefix identifying which VQ.
- **Blocks anything downstream:** VQ4-VQ6 pass is the greenlight for Commits 2-4 to depend on the RPC behaving correctly. VQ5 in particular is the "we didn't reintroduce the fee-wipe class" gate.

---

## App code — TypeScript changes shipped in this commit

For your awareness (no action needed):

| File | Change |
|------|--------|
| `app/lib/spaces.ts` | Added `monthly_fee: number \| null` to `Space` interface |
| `app/manager/page.tsx` | `editForm` state, form-open populate, RPC call, edit UI (new numeric input); description label copy updated |
| `app/company_admin/page.tsx` | Mirror of manager changes for CA edit surface |
| `scripts/probe-spaces-metadata-rpc.ts` | 6 sites updated — each passes `p_monthly_fee: null` (probe doesn't test fee behavior; that's the migration's VQ4-VQ7 job) |

`npm run build` passes. `tsc --noEmit` clean.

---

## After apply — reply with

- File 1: silent COMMIT (or the specific error if it failed)
- File 2: the PASS row values, OR the specific FAIL message
- Confirmation the app deploy is triggered

---

## Not in this batch

- **Resident portal fee display** — deliberately deferred to a follow-up commit. Requires changes to [app/resident/page.tsx:378](app/resident/page.tsx#L378) SELECT + `assignedSpaces` state + display markup. Not blocking Commit 2.
- **Ledger table (Commit 2)** — separate batch when scoped for build.
- **Vehicles arc V4.A1_DRIFT re-run** — still deferred. Independent of this batch.

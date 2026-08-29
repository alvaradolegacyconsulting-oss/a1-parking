# APPLY BATCH — vehicles.company Commit 4 (SET NOT NULL) — 2026-08-28

**For:** Jose. Paste, read, next.
**Two files. One goes first.** File 2 (verification) fails hard if File 1 wasn't applied.
**Prereq:** Files 1–3 from `apply-batch-2026-08-28-tow-triad.md` applied and PASSED.
Do NOT run this batch until that batch is closed.

---

## Files in order

| # | File | GitHub (at SHA on push) | Type | Size |
|---|------|------|------|------|
| 1 | `migrations/20260828_vehicles_company_set_not_null.sql` | (populated on push) | DDL — `ALTER … SET NOT NULL` | ~108 lines |
| 2 | `migrations/20260828_vehicles_company_set_not_null_verification.sql` | (populated on push) | 4 immediate gates + 1 deferred; returns PASS row | ~180 lines |

Raw-file access: replace `/blob/` with `/raw/` in the URL for one-click paste.

---

## FILE 1 — `ALTER TABLE public.vehicles ALTER COLUMN company SET NOT NULL;`

### Pre-apply — Test-LEGACY 5-path smoke, probes deleted

Before pasting File 1, run the standard 5-path writer smoke at Test-LEGACY only. Each of the five production writers should INSERT one probe vehicle with a non-NULL company and you delete each probe row after. This confirms every live writer stamps company today (would have been caught by Commit 2 verification, but re-checking under the impending constraint is the safety belt).

If any smoke probe writer produces a NULL company today, HALT — that writer path is broken and this batch cannot proceed until fixed.

### Apply

Paste the entire contents of File 1. Wrapped in `BEGIN; ... COMMIT;`.

**Expected output:**
- `NOTICE` (none expected — pure DDL)
- If any row in `public.vehicles` has `company IS NULL`, the ALTER raises `check_violation`-like NOT NULL failure and the entire transaction rolls back. That's a **safe fail** — nothing changes. If it fires, run:
  ```sql
  SELECT id, plate, property, created_at FROM public.vehicles WHERE company IS NULL;
  ```
  and either backfill or investigate before retrying.

- On success (expected): silent COMMIT, followed by `NOTIFY pgrst 'reload schema'` (fires PostgREST cache reload).

**Lock window:** `ACCESS EXCLUSIVE` on `public.vehicles` for a full-table scan (~345 rows) — sub-second. Concurrent writers queue briefly.

### Idempotency + failure

- **Idempotent:** Yes, in the sense that re-applying an already-NOT-NULL column is a no-op. But the schema audit INSERT would fire twice (creating two audit rows). Prefer applying once.
- **Failure mode:** Any pre-existing NULL row → hard fail, rollback, no state change. Any concurrent write inserting NULL during the ALTER window → the ALTER may still succeed and the concurrent write fails (whichever races). Safe.
- **Blocks File 2:** Yes — File 2's VQ1 asserts is_nullable='NO'; VQ2 asserts an INSERT with NULL company REJECTS. Both fail if File 1 didn't apply.
- **Safe to stop after:** Yes. Rollback is `ALTER TABLE public.vehicles ALTER COLUMN company DROP NOT NULL;` (not scripted — production is expected to hold this permanently).

---

## FILE 2 — Verification (4 immediate gates + 1 deferred)

### Apply

Paste the entire contents of File 2. NO `BEGIN/COMMIT` wrap (v2 verification pattern).

**Expected output:** One PASS row with the four gate names. If any gate fires, the DO block raises with a specific FAIL message identifying which VQ and why.

### What each VQ asserts

| VQ | Asserts | Pass shape |
|----|---------|------------|
| VQ1 | `is_nullable = 'NO'` on `vehicles.company` (attnotnull structural) | silent (no exception) |
| **VQ2** | 🔴 EXECUTION — INSERT with `company=NULL` REJECTS with `not_null_violation` on column `company` | silent (nested BEGIN catches expected exception) |
| VQ3 | `SELECT COUNT(*) WHERE company IS NULL = 0` (belt-and-braces post-ALTER) | silent |
| VQ4 | Schema audit row for `SCHEMA_VEHICLES_COMPANY_SET_NOT_NULL` exists | silent |
| — | Terminal SELECT returns one row: `status='PASS'`, gates_verified array, deferred note, verified_at timestamp | one row visible |

**VQ2 note:** This is the "constraint rejects, not merely attnotnull is set" gate. If VQ2 fires with `probe INSERT was ACCEPTED`, the phantom row is already deleted by the DO block, and the exception message says the constraint isn't enforcing — investigate at the pg_catalog level (`SELECT attname, attnotnull FROM pg_attribute WHERE attrelid = 'public.vehicles'::regclass AND attname = 'company';`).

If VQ2 fires with `not_null_violation raised on column X (not company)`, some other column on vehicles is NOT NULL and my probe INSERT didn't provide it. The error message names the column — add it to the probe's INSERT list with a synthetic value and rerun.

### Idempotency + failure

- **Idempotent:** Yes. Read-only + no state change (VQ2's phantom row only exists on failure and is auto-cleaned by the DO block).
- **Failure mode:** Any DO block raises → paste aborts, no PASS row returned, exception message identifies the issue.
- **Safe to stop after:** Yes. Both files are complete.

---

## VQ5 (deferred) — V4.A1_DRIFT

Bottom of File 2 is a **commented-out standalone SELECT** for V4.A1_DRIFT. This is NOT part of the immediate PASS. Copy it (uncomment) and run manually after A1 has had a few hours of natural traffic — say, T+4h and again the next morning.

**Pass shape:**
```
deploy_ts            = <timestamp of the ALTER, from audit row>
a1_company           = 'A1 Wrecker LLC'
a1_total             = >= 140
null_company         = 0        ← trivially true post-ALTER
created_since_deploy = > 0      ← THE load-bearing signal
pass                 = true
```

**Zero created_since_deploy is NOT a pass** — it means nothing has exercised the new constraint yet. Keep re-running periodically until natural traffic writes at least one A1 vehicle post-deploy. Then and only then is Commit 4 fully validated.

---

## After apply — reply with

- File 1: silent COMMIT, or the specific `plate/id/property/created_at` list from the NULL-row diagnostic if it failed
- File 2: the PASS row (`status`, `gates_verified`, `deferred`, `verified_at` values), OR the specific FAIL message if a gate fired
- VQ5 re-runs: paste each result as you get them. `pass=true` closes the arc.

---

## Not in this batch

- The A2 super-admin cascade RLS rewrites keyed on `vehicles.company` — separate arc, own preflight. Commit 4 UNLOCKS that work; it does not start it.
- The cap sequence (A → B → C → A₀) — separate arc, unrelated to `vehicles.company`.

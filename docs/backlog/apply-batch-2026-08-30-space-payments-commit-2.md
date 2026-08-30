# APPLY BATCH — Reserved-space payment tracking Commit 2 (2026-08-30)

**For:** Jose. Paste, read, next.
**Prereq:** Commit 1 (`c5ccd83` + `b0efe56` VQ fix) applied and PASS on all 8 gates.
**Two files. Structural change; no client code touches this table yet — no Vercel deploy needed to close a window.**

---

## What this adds

- `public.space_payments` table — 17 columns, 3 CHECKs, 1 FK ON DELETE RESTRICT, 3 indexes, RLS enabled with 4 SELECT policies.
- **Append-only by GRANT** — `authenticated` gets `SELECT` only. No INSERT, UPDATE, or DELETE for any application role.

Nothing writes to this table yet. The record and void RPCs ship in Commit 3.

---

## Two deliberate divergences from the shipped pattern — call them out here so nobody "fixes" them later

1. **RLS uses `lower(trim())` equality, not `~~*` ILIKE.** Every existing sibling table (spaces, vehicles, residents, violations, visitor_passes) uses the `~~*` pattern, which treats stored values as ILIKE patterns — a property named `Smith_Lot` matches `SmithXLot` because `_` is a wildcard. That's the top Bar-2 blocker in [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md) (147 company sites + 82 property sites carry it). This table is new, no legacy constraint; ships with the safer form. Sibling tables get fixed in the metacharacter-normalization sweep (separate arc). **Do NOT normalize this back to `~~*`.**

2. **Snapshot columns stay forever, alongside any future FK.** `property`, `space_label`, `resident_email/name/unit` are all snapshots captured at INSERT time. When the wider `property_id` FK arc lands, this table gains `property_id` ADDITIONALLY — the text `property` column stays. Converting a snapshot to an FK-only reference silently rewrites payment history on rename/reassign. That's the value-join drift class the whole snapshot design refuses.

Both rules are documented in the migration header. Header comment is the only defense against a future "consistency sweep" undoing them.

---

## Files in order

| # | File | Type | Size |
|---|------|------|------|
| 1 | `migrations/20260830_space_payments_v1_table.sql` | DDL: TABLE + CHECKs + FK + indexes + RLS + grants + audit | ~200 lines |
| 2 | `migrations/20260830_space_payments_v1_table_verification.sql` | 14 gates including 3 execution tests; returns PASS row | ~380 lines |

Raw-file access: replace `/blob/` with `/raw/` in the GitHub URL for one-click paste.

---

## FILE 1 — CREATE TABLE + RLS + grants

### Apply

Paste File 1. Wrapped in `BEGIN; ... COMMIT;`.

**Expected output:**
- `NOTICE` messages: none expected in the happy path
- Silent COMMIT
- `NOTIFY pgrst 'reload schema'` fires

**Failure mode:** any DDL error → transaction rolls back → nothing changed. Safe. If the CREATE fails on a name collision, `to_regclass('public.space_payments')` will already return non-NULL; investigate whether a previous partial apply left the table behind.

### Idempotency + failure

- **Idempotent on the CREATE TABLE** (`IF NOT EXISTS`). But if the table already exists from a partial prior apply, the ALTER/GRANT/POLICY statements will run against it and could conflict with different state. Prefer a clean apply.
- **The schema audit INSERT is NOT idempotent** — a re-apply writes a second audit row. Prefer applying once.
- **Blocks File 2:** Yes — every gate in File 2 asserts something File 1 created.
- **Safe to stop after:** Yes. Rollback is `DROP TABLE public.space_payments CASCADE;` (would also drop the indexes and policies). Not scripted.

---

## FILE 2 — Verification (14 gates)

### Apply

Paste File 2. NO `BEGIN/COMMIT` wrap (v2 pattern).

**Expected output:** one PASS row with the 14 gate names. Any gate raises → paste aborts with a specific FAIL message.

### What each VQ asserts

| VQ | Class | Asserts | Pass shape |
|----|-------|---------|------------|
| VQ1 | structural | table exists | silent |
| VQ2 | structural | 17 columns with correct types + nullability | silent |
| VQ3 | structural | `CHECK amount > 0` present | silent |
| VQ4 | structural | `CHECK period_month = date_trunc('month', ...)` present | silent |
| VQ5 | structural | `CHECK void coherence` (all-3-null or all-3-set) present | silent |
| VQ6 | structural | FK space_id → spaces has ON DELETE RESTRICT (not CASCADE, not NO ACTION) | silent |
| VQ7 | structural | 3 named indexes present | silent |
| VQ8 | structural | RLS enabled on table | silent |
| **VQ9** | 🔴 grants | `authenticated` has SELECT (readers can access) | silent |
| **VQ10** | 🔴 grants | `authenticated` does NOT have INSERT, UPDATE, or DELETE — asserts ABSENCE | silent |
| **VQ11** | 🔴 execution | Impersonated Test-LEGACY manager SELECTs their own probe row (RLS admits) | NOTICE with count |
| **VQ12** | 🔴 execution | Same manager INSERT REJECTED with SQLSTATE 42501 (insufficient_privilege — from grants, before RLS) | NOTICE on catch |
| **VQ13** | 🔴 execution | Unauthorized role (resident preferred) SEES 0 ROWS silently — RLS filters, does NOT throw | NOTICE with role + email |
| VQ14 | audit | `SCHEMA_SPACE_PAYMENTS_TABLE_V1` audit row present | silent |
| — | | terminal SELECT returns PASS row | one row visible |

### Execution gate mechanics (VQ11-VQ13)

Each execution gate is its own DO block. Inside:
- `PERFORM set_config('role', 'authenticated', true)` — become the authenticated Postgres role (RLS + grants apply)
- `PERFORM set_config('request.jwt.claims', json_build_object('email', ...)::text, true)` — set the JWT that `auth.jwt()` returns
- Run the test
- LOCAL settings expire when the DO block ends — no explicit reset

Prereq: at least one Test-LEGACY manager exists in `user_roles`; VQ11-VQ12 SKIP-fails if not (RAISE with "PREREQ FAIL"). At least one resident or driver exists SOMEWHERE in user_roles for VQ13 (silently skips with NOTICE if none). All three should be satisfiable at any real Test-LEGACY seed.

**Probe row lifecycle:** SETUP DO block (between VQ10 and VQ11) inserts one probe as service_role/postgres. Note field prefixed `__V-COMMIT-2-PROBE-<epoch>`. Deleted by CLEANUP DO block (between VQ14 and the final SELECT). If any gate raises mid-sequence, the row survives — manual cleanup one-liner at the bottom of the file:
```sql
DELETE FROM public.space_payments WHERE note LIKE '__V-COMMIT-2-PROBE-%';
```

### If VQ12 SUCCEEDS in inserting (grant restriction not enforcing)

VQ12 raises `VQ12 FAIL: authenticated manager INSERT was ACCEPTED` BEFORE the transaction commits — but the INSERT statement itself commits first, then the RAISE. That means a phantom row lands with property='placeholder'. Cleanup:
```sql
DELETE FROM public.space_payments WHERE property = 'placeholder';
```

This is the gate that catches the "commit's main claim" going wrong. If VQ12 fires, the grant restriction is broken — halt and re-run:
```sql
REVOKE ALL ON public.space_payments FROM authenticated;
GRANT SELECT ON public.space_payments TO authenticated;
```

### Idempotency + failure

- **Idempotent:** Yes (setup + cleanup DO blocks bracket the execution gates).
- **Failure mode:** RAISE with specific FAIL prefix identifying which VQ + what to check.
- **Blocks anything downstream:** Commit 3 depends on all 14 passing. In particular VQ10 (no writes for authenticated) and VQ12 (execution proof of same) are the whole reason Commit 3's DEFINER RPCs make sense.

---

## No client code changes in this commit

Nothing in `app/` touches `space_payments` yet. The Commit 3 record/void RPCs + their UI wiring ship in a separate commit.

---

## After apply — reply with

- File 1: silent COMMIT
- File 2: the PASS row values, OR the specific FAIL message + gate number
- Any NOTICE lines from VQ11 / VQ13 (they log the impersonated email + count for the record)

---

## Not in this batch

- **Commit 3** — `record_space_payment` + `void_space_payment` DEFINER RPCs + manager/CA UI wiring + snapshot resolution from `spaces` + `space_residents` at INSERT time.
- **Commit 4** — monthly report per property/period.
- **Resident portal fee display** — deliberately deferred to a follow-up commit on the Commit 1 arc. Not blocking either Commit 2 or Commit 3.
- **Metacharacter normalization sweep** — separate arc that eventually moves sibling tables to the equality pattern used here.

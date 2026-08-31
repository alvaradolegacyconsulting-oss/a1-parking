# APPLY BATCH — Reserved-space payment tracking Commit 3a (2026-08-30)

**For:** Jose. Paste, read, next.
**Prereq:** Commit 2 (`cad877a` table + RLS + grants) applied. Manual verification of Commit 2's execution behavior sufficient — no dependency on the automated verification file passing.
**No client code shipped yet.** Manager + CA UI is Commit 3b, follows in a separate commit. This batch is the DB layer only.

---

## What this adds

Two DEFINER RPCs:
- `public.record_space_payment(BIGINT, DATE, NUMERIC, TEXT, TEXT) → BIGINT`
- `public.void_space_payment(BIGINT, TEXT) → BOOLEAN`

Both are the ONLY write paths into `public.space_payments`. Table has SELECT-only grant for authenticated (Commit 2); every write flows through here. `recorded_by_email` and `voided_by_email` resolved server-side from `auth.jwt() ->> 'email'` — unforgeable. Snapshots (company/property/space_label/resident_*) captured at INSERT time from spaces + space_residents + residents state.

Ledger + audit_logs written per action (two writes per record, two per void). Void UPDATE touches only the three void columns.

---

## Divergences called out in the migration header

**Company + property scope uses `lower(trim())` equality, not `!~~*`.** DEFINER context is exactly where the ILIKE-treats-value-as-pattern vulnerability bites hardest (bypasses RLS). Same rationale as Commit 2 RLS + `docs/CURRENT_STATE.md`.

**Property scope is ENFORCED for manager + leasing_agent, not inherited from `update_space_metadata`'s company-only pattern.** `update_space_metadata` has a gap (manager at property A can edit a space at property B in the same company); that gap is filed as a separate finding and NOT re-introduced here.

**Record role gate includes `leasing_agent` (record only, not void).** Diverges from `update_space_metadata`. Recording a payment is a front-desk act; the ledger SELECT grant already includes leasing_agent — withholding record would be incoherent. Void narrower — corrections belong to manager + company_admin only.

---

## Files in order

| # | File | Type | Size |
|---|------|------|------|
| 1 | `migrations/20260830_record_and_void_space_payment_rpcs.sql` | 2 CREATE FUNCTION + grants + audit | ~300 lines |
| 2 | `migrations/20260830_record_and_void_space_payment_rpcs_verification.sql` | 5 structural + 8 execution gates in consolidated block; returns PASS row | ~340 lines |

Raw-file access: replace `/blob/` with `/raw/` in the GitHub URL for one-click paste.

---

## FILE 1 — CREATE FUNCTIONs

### Apply

Paste File 1. Wrapped in `BEGIN; ... COMMIT;`.

**Expected output:** silent COMMIT. `NOTIFY pgrst 'reload schema'` fires.

**Failure mode:** any parse error → rollback → nothing changed. Safe.

### Idempotency + failure

- **Idempotent:** Yes (`CREATE OR REPLACE FUNCTION` for both). Schema audit INSERT writes a fresh row per apply — prefer applying once.
- **Blocks File 2:** Yes. Every gate in File 2 asserts something File 1 created.
- **Safe to stop after:** Yes. Rollback is `DROP FUNCTION public.record_space_payment(BIGINT, DATE, NUMERIC, TEXT, TEXT); DROP FUNCTION public.void_space_payment(BIGINT, TEXT);` (not scripted — production expected to hold these permanently).

---

## FILE 2 — Verification (5 structural + 8 execution gates)

### Apply

Paste File 2. NO `BEGIN/COMMIT` wrap.

**Expected output:** one PASS row with 13 gate labels. Any gate raises → paste aborts with a specific FAIL message.

### The lessons applied (not iterated to)

Every rule from the past 3 days' gate-writing failures baked into the initial file:

1. **`to_regprocedure` for signature checks** — not string matching against `pg_get_function_identity_arguments` (different PG versions render it differently)
2. **ONE consolidated DO block** for the execution section — same transaction, same scope. If any gate raises, the whole block rolls back including any probe INSERTs.
3. **SETUP uses one JOIN** to link manager + space at a matching property — no two-independent-`SELECT LIMIT 1` pattern
4. **Impersonation cycle**: `PERFORM set_config('role','authenticated', true)` + JWT set at start of each impersonation section; `EXECUTE 'RESET role'` between sections
5. **CLEANUP at end of the consolidated block** — DELETE runs inside the same transaction as SETUP
6. **`user_roles.property` is `text[]`** — array ops (`unnest(...)`, `ANY(...)`), never `trim()` directly
7. **Period uses `CURRENT_DATE`** (bare DATE, no TZ conversion), not `now()::date`
8. **Failure messages state observations**, list candidate causes, never assert a cause the gate did not test

### Per-VS/VE assertion table

| Gate | Class | Asserts |
|----|-------|---------|
| VS1 | structural | `record_space_payment(bigint,date,numeric,text,text)` exists via to_regprocedure |
| VS2 | structural | `void_space_payment(bigint,text)` exists |
| VS3 | structural | Both SECURITY DEFINER + search_path pinned |
| VS4 | grants | Both have authenticated EXECUTE (=1); PUBLIC + anon EXECUTE (=0) |
| VS5 | audit | `SCHEMA_SPACE_PAYMENT_RPCS_V1` audit row present |
| **VE1** | execution | Manager records → row lands with correct snapshots + `recorded_by_email = JWT email` (unforgeable attribution proof) |
| **VE2** | execution | Mid-month input date normalizes to first-of-month on write |
| **VE3** | execution | `amount=0` rejected with `amount_not_positive` |
| **VE4** | execution | Cross-property manager rejected with `space_not_in_your_properties` (SKIPS with NOTICE if no cross-property space seeded) |
| **VE5** | execution | Double-submit within 60s rejected with `duplicate_payment_suspected` |
| **VE6** | execution | Void sets `voided_at + voided_by_email + void_reason`; `amount` and `period` UNCHANGED |
| **VE7** | execution | Second void on already-voided row rejected with `already_voided` |
| **VE8** | execution | Void with blank reason rejected with `void_reason_required` |
| — | terminal | Returns PASS row on all 13 gates |

### Setup prereqs

- At least one Test-LEGACY manager with a non-empty `user_roles.property` (text[])
- At least one active Test-LEGACY space at ONE OF that manager's properties
- For VE4 specifically: at least one active Test-LEGACY space at a property OUTSIDE that manager's assignments (skips gracefully if none)

If the JOIN in SETUP returns no row, SETUP raises with a specific message; VE1-VE8 don't run. Diagnose Test-LEGACY seed.

### Probe row lifecycle

Both VE1 and VE2 create probe payments (id captured in DECLAREd vars). CLEANUP at end of the consolidated block deletes both by id. If any VE raises mid-sequence, the whole block's transaction rolls back and no probe survives.

### Idempotency + failure

- **Idempotent:** Yes (read-mostly; probe INSERTs are DELETEd or rolled back).
- **Failure mode:** RAISE with specific FAIL prefix + observation + candidate causes.

---

## After apply — reply with

- File 1: silent COMMIT (or specific error)
- File 2: the PASS row values, OR the specific FAIL message + gate label
- Any NOTICE lines from VE1/VE2/VE4 (they log the impersonated email + probe id for the record)

---

## Not in this batch

- **Commit 3b — UI wiring**: manager + CA per-space payment list + record + void buttons. Ships as a separate commit after this DB batch lands. UI changes are TypeScript-only; no DB dependency.
- **Commit 4 — monthly report**: cross-space month view per property/period. Read-only.
- **2+ tied resident case**: NOT tested in the automated verification (needs specific seed). Filed as manual follow-up.

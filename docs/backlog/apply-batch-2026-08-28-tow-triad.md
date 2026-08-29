# APPLY BATCH — Tow Triad + Seed vehicles.company (2026-08-28)

**For:** Jose, end of long day. Paste, read, next. No commit-message archaeology.
**By:** Claude, 2026-08-28 evening.
**Repo SHA:** `a71d7d2` (main).

---

## 🔴 Read this first — corrected apply expectation

Commit `a71d7d2`'s message said "expect only the two company lines in the pg_get_functiondef diff; HALT if anything else differs." **That is wrong.** Production `seed_demo_data()` currently has NEITHER change. HEAD carries BOTH the `should_tow` block (~58 lines) AND the `company` column addition (2 lines). So your BEFORE→AFTER diff will show:

- `should_tow BOOLEAN` added to the VALUES tuple; conditional stamp block for `tow_ticket_generated_at`, `tow_storage_name`, `tow_storage_address`, `tow_storage_phone`, `tow_fee`
- `company` added to the vehicles INSERT column list; `c_company` in the matching VALUES position
- Two arc-context inline comments

**Both changes are expected. The file gets applied ONCE — not once per commit.** Halt only if you see anything BEYOND those two changes: changed function signature, dropped `SECURITY DEFINER`, altered `SET search_path = public, pg_temp`, missing `RETURNS jsonb`, changed `LANGUAGE plpgsql`, dropped grants at the end.

---

## Files in order

Apply in this order. Do not skip. Do not reorder. File 2 depends on File 1 being applied first (or the future re-seed constraint won't hold). File 3 depends on File 2 (verifies what File 2 changed).

| # | File | GitHub link (at SHA) | Type | Size |
|---|------|----|------|------|
| 1 | `migrations/20260711_seed_demo_data_rpc.sql` | https://github.com/alvaradolegacyconsulting-oss/a1-parking/blob/a71d7d2/migrations/20260711_seed_demo_data_rpc.sql | CREATE OR REPLACE (DEFINER RPC) | 918 lines |
| 2 | `migrations/20260711_seed_demo_data_tow_ticket_backfill.sql` | https://github.com/alvaradolegacyconsulting-oss/a1-parking/blob/de62aab/migrations/20260711_seed_demo_data_tow_ticket_backfill.sql | UPDATE on 12 live rows | 111 lines |
| 3 | `migrations/20260711_seed_demo_data_tow_ticket_backfill_verification.sql` | https://github.com/alvaradolegacyconsulting-oss/a1-parking/blob/de62aab/migrations/20260711_seed_demo_data_tow_ticket_backfill_verification.sql | 6 VQ gates, returns rows | 119 lines |

**Raw-file access** for one-click paste: replace `/blob/` with `/raw/` in any URL above. E.g. `https://github.com/alvaradolegacyconsulting-oss/a1-parking/raw/a71d7d2/migrations/20260711_seed_demo_data_rpc.sql`.

---

## FILE 1 — `seed_demo_data()` RPC body (both changes)

### Step 1 — Capture BEFORE (in SQL Editor, save the output)

```sql
-- BEFORE
SELECT pg_get_functiondef(p.oid) AS before_body
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname = 'seed_demo_data';
```

Copy the returned `before_body` value into a scratch buffer.

### Step 2 — Apply

Paste the entire contents of File 1 (linked above). The file is wrapped in `BEGIN; ... COMMIT;` and does not run the RPC — it only redefines it.

Expected output: `NOTICE: function "seed_demo_data" already exists, replacing`. Rows returned: none.

### Step 3 — Capture AFTER

Same query as Step 1, save the `after_body` value. Diff BEFORE vs AFTER.

**Expected diff — allow these:**
- `should_tow` column added to the VALUES tuple, new conditional block that stamps `tow_ticket_generated`/`tow_ticket_generated_at`/`tow_storage_*`/`tow_fee` when TRUE (~58 insertions / ~34 deletions in that region)
- `company` column added to the vehicles INSERT list; `c_company` in the matching VALUES position (2-line change)
- Two new inline arc-context comment blocks

**Halt and investigate if:**
- Function signature changes (should stay `RETURNS jsonb`, `LANGUAGE plpgsql`)
- `SECURITY DEFINER` disappears
- `SET search_path = public, pg_temp` changes
- Any grant/revoke block below `$func$;` changes
- Any change to constants at :123-127 (`c_prop_sunset`, `c_prop_willow`, `c_prop_north`, `c_company`, `c_actor`)

### Idempotency + failure

- **Idempotent:** Yes. `CREATE OR REPLACE FUNCTION` is safe on re-run. If you paste twice, second paste replaces itself with identical bytes.
- **Single-shot alternative:** Not applicable.
- **Failure mode:** Any parse error rolls the transaction back — no partial state. Safe to stop mid-batch here.
- **Blocks File 2/3:** Not strictly (they touch data, not the function). But: the whole point of applying File 1 is so that any future demo re-seed writes both `should_tow`-driven columns AND `company`. Files 2/3 backfill existing rows for the tow-rate widget; the RPC redefine covers future rows.

---

## FILE 2 — Tow-ticket backfill (12 live Demo rows)

### Step 1 — Apply

Paste the entire contents of File 2 (linked above). Wrapped in `BEGIN; ... COMMIT;` with a pre-flight sanity check.

**Expected output:**
- `NOTICE` from pre-flight sanity if any target (plate, property, status) triple has duplicates — should not fire; if it does, HALT.
- The UPDATE fires. Rows returned by the UPDATE (visible in the SQL Editor's row-count line): **12** on the first run.
- On a re-run (if you paste File 2 twice): **0 rows updated** — the `WHERE v.tow_ticket_generated IS NOT TRUE` guard makes it a no-op.

**Any row count other than 12 or 0 → HALT and investigate.** Something else is writing to those rows, or the scope guard has drifted.

### Scope reminder

Triple-guarded. WHERE clause requires ALL of:
1. `driver_name = 'Demo Driver'` (literal string, unique to seed)
2. `tow_ticket_generated IS NOT TRUE` (idempotency)
3. One of 12 specific `(plate, status)` pairs (TX-prefix demo plates)

`driver_name = 'Demo Driver'` is the load-bearing gate. A1 driver names are real people — never that literal string. Cross-tenant reach is zero by construction. If VQ5 flags anything, the guard has been circumvented and that's the story.

### Idempotency + failure

- **Idempotent:** Yes. Re-run = 0 rows updated (safe).
- **Safe to stop mid-batch after File 2:** Yes — the RPC (File 1) is redefined, the 12 rows are stamped. File 3 only reads.
- **Failure mode:** Sanity check raises → nothing written, transaction rolls back. UPDATE constraint violation (unlikely — writes only to existing rows) → transaction rolls back.
- **Blocks File 3:** Yes — File 3's VQ1 asserts count=12 towed rows, VQ4 asserts tow_rate_pct in a healthy range. Running File 3 without File 2 will fail VQ1/VQ4 (which is the correct behavior).

---

## FILE 3 — Verification (6 gates, returns rows)

### Step 1 — Apply

Paste the entire contents of File 3 (linked above). NO `BEGIN/COMMIT` wrap. Read-only.

**Each block returns 1 row.** Every row's `ok` column must be `TRUE`. Any `ok = FALSE` = a gate failure — investigate before moving on.

### What each VQ asserts

| VQ | Asserts | Pass shape |
|----|---------|------------|
| VQ1 | 12 `driver_name='Demo Driver'` rows now have `tow_ticket_generated = TRUE` | `towed_count=12`, `ok=true` |
| VQ2 | Those 12 rows are the expected `plate:status` set | `towed_rows` = alphabetical string ending `TX9QDF63:tow_ticket`, `ok=true` |
| VQ3 | Storage + fee columns all populated on all 12 (`tow_storage_name='Demo Tow Yard'`, `tow_fee=275.00`, etc.) | All FILTER counts = 12, `ok=true` |
| **VQ4** | Widget formula: `tow_rate_pct > 0 AND 25-55%` AND no `status='tow_ticket'` row lacks `tow_ticket_generated=TRUE` | `tow_rate_pct` reported (no hardcoded target; expect ~39%), `status_tow_ticket_without_generated=0`, `ok=true` |
| **VQ5** | 🔴 Cross-tenant safety: no non-`Demo Driver` violation was stamped with the demo tow_storage_address | `non_demo_towed_today=0`, `ok=true` |
| VQ6 | Idempotency: 0 rows are candidates for re-apply | `candidates_for_reapply=0`, `ok=true` |

**VQ4 note:** The tile in the CA Enforcement Insights card should now show ~"39%" (11 towed ÷ 28 non-voided) rather than "0%". If you eyeball the widget in a live browser, that's the human-visible confirmation.

**VQ5 note:** This is belt-and-suspenders. `driver_name='Demo Driver'` is a literal-string gate — the only way VQ5 could fire is if the guard drifted, or if a real A1 violation carries the literal string `'9200 Industrial Row, Houston, TX 77048'` in its `tow_storage_address` for reasons unrelated to this backfill. If VQ5 fires, stop everything and report — cross-tenant stamp is a data-integrity issue.

### Idempotency + failure

- **Idempotent:** Yes. Read-only.
- **Failure mode:** Any `ok=FALSE` → investigate the failing VQ before proceeding. VQ4 in particular is the "widget works" gate.
- **Blocks anything downstream:** VQ4 pass is the "greenlight the tow-rate widget in demo" signal. VQ5 pass is the cross-tenant safety confirmation. Both must be `ok=TRUE` before flagging the batch complete.

---

## Not in this batch (already applied or not yet built)

- **`99503c8`** — vehicles.company Commit 3 backfill. **Applied 22:31:47 on 2026-08-28, verified 22:35:58** (rows_backfilled_last_run=337, still_null=0, mismatched=0, orphaned=0). Do NOT re-run.
- **Commit 4** (`vehicles.company SET NOT NULL`) — migration file drafted at `migrations/20260828_vehicles_company_set_not_null.sql`, verification pending. Separate future batch.

---

## After apply — reply with

- BEFORE and AFTER `pg_get_functiondef` diffs (either the full outputs or a summary — "matches expected shape (should_tow + company)" is fine if it does)
- File 2's UPDATE row count (should be 12)
- File 3's six `ok` columns (all should be `true`)
- Any surprise

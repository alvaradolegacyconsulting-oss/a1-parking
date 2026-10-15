# Re-validation at three points — one blocker, one limit, one gap

Schema: all four ruled changes plus the fifth they imply are written and
gated (`33b554f`). Ready for you to apply:

- `docs/backlog/wip-20261015_approval_queue_schema.sql`
- `docs/backlog/wip-20261015_approval_queue_schema_verification.sql`
- then `npm run verify:approvalschema` (the execution half — it refuses
  with exit 2 if the migration is not applied, so run it after)

**Re-validation at the three ruled points cannot be built yet.** One
blocker needs your yes; the migration for it is written and marked
pending. Two further things are worth knowing before the loader.

---

## 🔴 1. Blocker — an admin is refused by the validator

Proven by execution on an admin canary, created, used and deleted:

```
get_my_role()                 = "admin"
may_bulk_upload_at(139)       = false
bulk_validate_rows(139, …)    = REFUSED: property_not_in_scope
download batches/8.csv        = ok, 30998 bytes
select from import_batches     = ok
```

So you can read the batch row and download the exact bytes that were
submitted, and **cannot run the check that says whether they would
still load**. `bulk_validate_rows` gates on `may_bulk_upload_at()`,
which requires `ur.role = 'company_admin'`. All three re-validation
points go through that function.

**`may_bulk_upload_at` must not be the thing widened**, because the
storage INSERT policy calls it:

```sql
bulk_csv_ca_insert … AND public.may_bulk_upload_at(<the path's id>)
```

An admin branch there would let an admin upload a CSV into any
property's prefix. Upload authority and validate authority are different
questions — "may you put a file here" versus "may you check a file
already here" — and one function cannot answer both.

So: a second function, `may_bulk_validate_at(property_id)` =
`may_bulk_upload_at(…) OR an active admin`, and the validator's gate
points at that instead. `may_bulk_upload_at` is left byte-identical.

**The body is not retyped.** `bulk_validate_rows` is ~100 lines whose
correctness rests on the rehearsal against your published fixture
expectations, and `CREATE OR REPLACE` also drops parameter defaults a
retyped signature can lose. So Postgres writes the new definition: the
migration reads `pg_get_functiondef()`, asserts the gate line appears
**exactly once**, substitutes that one substring, asserts the old line
is gone and the new one landed, and executes the result. Zero
occurrences would mean a silent no-op reporting success; two would mean
a second gate site this was not written for. Both raise.

No new disclosure: an admin already reads `vehicles`, `residents` and
`properties`, and the RPC's sibling-property scoping is by the
*property's* company, not the caller's, so it stays correct for an admin
caller.

**Ready to apply on your word:**
`docs/backlog/wip-20261015_admin_validate_gate.sql`.

## 2. The limit — only half of validation can go stale, and it is the SQL half

Worth being precise, because it changes what re-validation has to mean.

The validator has two halves:

| half | where | can it change after submission? |
|---|---|---|
| field validation (`validateBulkRows`) — unit shape, state codes, duplicates **within the file** | TypeScript | **No.** It reads only the file's own bytes, which are immutable and hashed. |
| record collisions (`bulk_validate_rows` + `dbFlagErrors`) — plate active here, plate active at a sibling property, plate prohibited, email already on file | SQL, then TS over its flags | **Yes.** These are live reads of the property. |

So "the file was clean at submit" stays true forever about the file, and
can stop being true about the property. **Re-validation is the SQL half
plus the TS code that reads its flags** — which is exactly what the
blocker above unlocks.

The consequence: re-validation happens in a route, not in the RPC,
because `dbFlagErrors` is TypeScript. The RPC that flips the status can
verify the **file hash** and that the caller is an active admin, but it
cannot verify that re-validation was run. The trust boundary is your own
session. If you want it enforced in the database, the TS flag-reading
would have to be ported into SQL — a rewrite of logic the rehearsal
already proved, so I would not recommend it, but it is your call.

## 🔴 3. The gap — the stale/transient split does not cover "the property is gone"

The ruling gives a load failure two outcomes: transient (no validation
errors) stays approved and retries; stale (validation errors) returns to
the company. There is a third case and it is neither:

- the property was deactivated between submit and load;
- the company was suspended or cancelled;
- the company's `bulk_onboarding_enabled` was switched back off.

None of those produce a validation error — the file is still perfectly
clean against the property's records. Under the ruling as written this
reads as **transient**, so the queue would offer "Retry load", and the
retry would succeed, loading 228 residents into a deactivated property
where nobody can see them. Or it would be returned to a company that
cannot resubmit, because the upload flag is off.

Two of these are already checked by `may_bulk_validate_at` for the
customer branch, but not for the admin branch — deliberately, because an
admin reviewing an old batch should still be able to see what it
contains.

My recommendation: the review screen and both RPCs check property and
company state separately from validation, and a failure there is a
**third outcome — "blocked"** — shown as a reason, with no Retry and no
Return offered, because neither action helps. It is not a new status on
the row: the batch stays `approved` and the queue simply says why it
cannot be loaded right now. That keeps "no new status" intact.

If you would rather fold it into transient, say so and I will — but the
Retry button would then be a button that works and should not.

---

## What I am building while this is pending

None of it needs the blocker resolved to be written, only to be
exercised:

1. The queue list and review screen in `/admin_console` — the list
   needs no new policy (`ib_admin_select` already covers it) and the
   file download needs none either (`bulk_csv_admin_select` does).
2. `approve_import_batch` and `return_import_batch_to_company` as
   DEFINER RPCs, and the admin routes that re-validate and call them.
3. The gate, on batch 8.

The gate will refuse rather than skip if either migration is unapplied,
the same way `verify:approvalschema` already does.

# Phase B step 2 — the super-admin approval queue

Report-first, as ruled. Two decisions are already made and this is built
around them:

> Approve and Load are separate actions, both Jose's; a failed load
> leaves the batch approved and retryable.

The queue itself is straightforward. **Four things in the ruling do not
fit the schema as it stands**, and one needs a decision before the
loader can be specified.

Grounded in: `docs/backlog/wip-20261015_phaseA_import_batches.sql`
(applied), and batch **8** — the Alden Park clean fixture, 358 rows /
228 residents / 358 vehicles, on Sunset Ridge Apartments at Demo
Company, submitted through the real routes by
`demo-ca@test.shieldmylot.com`. It is in place to build against.

---

## 🔴 1. There is no `approved` status

```sql
CONSTRAINT import_batches_status_allowed
  CHECK (status IN ('submitted', 'rejected', 'loaded', 'rolled_back'))
```

Approve-then-Load needs a state between them. Today a batch Jose has
approved but not yet loaded would have to sit in either:

- `submitted` — indistinguishable from one nobody has looked at, so the
  queue could not show Jose what he has already decided; or
- `loaded` — a lie, and the one that makes `import_batch_id` meaningless,
  because no rows carry it.

So `'approved'` is added to the allowlist. It is an **allowlist, not a
denylist** by design — "an unknown status must fail closed" — which is
why this is a migration rather than nothing.

## 🔴 2. The duplicate-submit index stops covering an approved batch

```sql
CREATE UNIQUE INDEX import_batches_one_live_per_file
  ON public.import_batches (property_id, file_sha256)
  WHERE status IN ('submitted', 'loaded');
```

An `approved` batch is not in that list, so it would **fall out of
"live"**. Consequences, in order of severity:

1. The CA resubmits the identical file (reasonably — nothing told them
   it was approved) and the insert now succeeds, because the only live
   batch is no longer live.
2. There are now two rows for the same bytes on the same property.
3. Both are loadable. Loading both inserts 228 residents and 358
   vehicles **twice**.

The index must become `WHERE status IN ('submitted', 'approved',
'loaded')`. This is the half of the ruling that bites silently: nothing
errors, the second load just works.

## 🔴 3. `approved` must be in the approval-complete check

```sql
CONSTRAINT import_batches_approval_complete
  CHECK (status NOT IN ('loaded', 'rolled_back')
         OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
```

Without `'approved'` in that list, a row could reach `approved` with
`approved_by` NULL — an approval with no record of who approved it. The
constraint's own intent ("approval and load must name who and when")
already covers this; the list just predates the state.

## 4. `approved_by` is TEXT where `attested_by_user_id` is UUID

```sql
attested_by_user_id UUID NOT NULL     -- the CA who submitted
approved_by         TEXT              -- whoever approves
```

The customer's side of the record is pinned to a uid; the operator's
side is a string. An email identifies a person until they change it, and
then the audit trail names a mailbox that may belong to someone else.

Not a blocker and not something I would change under the queue — the
existing audit-log convention is email-keyed throughout — but flagged
because this row is the provenance of 586 inserted records and is the
one place where "who approved this" has to still be answerable in a
year. If it should become `approved_by_user_id UUID` plus the email for
display, now is the cheap moment: no rows have been approved yet.

---

## 🔴 5. The decision: a file clean at submit can be dirty at load

This is the one I need an answer on.

The validator's duplicate checks are against **live records at that
property** — plate already active here, plate active at a sibling
property, email already on file. Batch 8 previewed clean at 15:10 today.
Approval is Jose's and may be days later, and in between:

- a manager adds a vehicle whose plate is in the file;
- a resident self-registers with an email in the file;
- the property is deactivated;
- the company is suspended or its tier changes.

So the submit-time verdict is **evidence, not a guarantee**. The loader
has to re-run `bulk_validate_rows` against current state immediately
before inserting, inside the same transaction. Otherwise it inserts rows
the validator would now reject, and some of them will hit
`vehicles_plate_norm_uniq` and abort anyway — just later, and with a
constraint name instead of a row number.

What I need ruled is **what a load that fails re-validation does**,
because the two existing rulings point different ways:

| | effect |
|---|---|
| **(a) stays `approved`, as ruled** | Matches "a failed load leaves the batch approved and retryable" exactly. But retrying changes nothing — the file is stale, and it will fail identically every time. Jose gets a button that cannot work and no way to tell this failure from a transient one. |
| **(b) returns to `submitted` with the new errors attached** | The CA sees the fresh error list and can fix and resubmit, which is the only action that actually resolves it. Costs Jose's approval — he has to approve again. |
| **(c) stays `approved`, and the queue distinguishes the two failures** | Transient failure → "Retry". Stale-file failure → "Send back to the CA", which is Jose's one-click move to (b). Keeps the ruling literally and still gives the stale case a way out. |

**I recommend (c).** It honours the ruling as written — a failed load
never loses the approval — while making the dead end impossible, and the
distinction is cheap because re-validation returns the error list that
tells you which kind of failure it was. (a) alone ships a button that
is sometimes a lie.

---

## The queue, assuming the above

**Where.** `/admin_console`, a new tab beside the company drawer that
already carries the bulk-onboarding toggle. `ib_admin_select` already
grants an active `admin` SELECT on every batch, so the list needs no new
policy.

**The list.** `submitted` first, then `approved`, both oldest-first
(`import_batches_queue` is already `(status, created_at DESC)`), with
`loaded` / `rejected` / `rolled_back` behind a filter. Per row: company,
property, counts, who attested and their title, when, and the file hash
abbreviated.

**Review.** Jose opens a batch and can download the file. The bytes come
from `batches/{id}.csv` — not from the CA's upload, which the submit
route removes precisely so the reviewed file cannot be swapped — through
`bulk_csv_admin_select`, which already gives an `admin` SELECT on the
whole bucket.

🔴 **The review screen re-runs the preview against current state**, and
shows that result rather than the submit-time one. Same reason as §5: a
stale clean verdict on a review screen is worse than no verdict, because
it is the thing Jose would reasonably rely on.

**Three actions, all through DEFINER RPCs.** `import_batches` has no
UPDATE grant and no UPDATE policy — deliberately, so "a forgotten policy
cannot become a write path" — so every transition is an RPC:

| RPC | from → to | notes |
|---|---|---|
| `approve_import_batch(id)` | `submitted` → `approved` | writes `approved_by`, `approved_at`. Re-validates and **refuses** if the file is now dirty, so Jose never approves something that cannot load. |
| `reject_import_batch(id, reason)` | `submitted`/`approved` → `rejected` | reason is mandatory — the CHECK already enforces that a rejection without one is not a rejection the CA can act on. |
| `load_import_batch(id)` | `approved` → `loaded` | the loader. Its own piece of work; the queue only calls it. |

Each asserts the caller is an active `admin` from `auth.jwt()`, not from
a parameter, and each is `REVOKE ALL FROM PUBLIC, anon` before
`GRANT EXECUTE TO authenticated` — the Supabase-default class.

**Approve and Load are separate buttons and never chained**, per the
ruling. Approving 358 rows and loading them are different decisions and
the second one writes records.

---

## 🔴 The loader can be genuinely atomic, and must be

Worth stating because the last multi-subject ruling went the other way.
For the property cascade the ruling was *pre-flight all targets, then
process each user independently, no all-or-nothing rollback across
auth* — correct there, because banning an auth user is an HTTP call to
GoTrue that no database transaction can undo.

**The loader touches no auth at all.** A bulk-loaded resident gets a
`residents` row and `vehicles` rows and no login; the login comes later
through the `/claim` door they are mailed a link to. So the entire load
is `INSERT ... SELECT` inside one function, and a failure anywhere rolls
back everything.

That is not a preference — **the ruling requires it**. "Retryable" is
only true if a failed attempt left nothing behind. A load that inserted
120 of 228 residents and then failed would, on retry, either insert the
first 120 again or trip the plate unique index, and the batch would be
stuck in a state no button can resolve.

So: one RPC, one transaction, `import_batch_id` stamped on every row it
writes (which the write-once guard makes truthful), and rollback deletes
by that column.

---

## What I would build, in order

1. **The migration** — `'approved'` into the status allowlist, the live
   index, and the approval-complete check. Three lines of real change,
   paired verification, Jose applies.
2. **The three RPCs** + their gate, exercised on batch 8 against a
   canary batch that gets rolled back, never on batch 8 itself until the
   loader is real.
3. **The queue UI** in `/admin_console`, with the re-validating review
   screen.
4. **The loader**, as its own piece. Its gate carries the staff-role
   assertion the claim route already has: nothing in the ingest path can
   create a staff role — confirmed today for the template (11 columns,
   no role column) and both ingest libraries (zero occurrences of
   "role"), and assertable for the loader once it exists.
5. Then same-day rollback, the billing guard, and a full rehearsal
   ending in a real claim.

Nothing in 1–3 writes a resident or a vehicle, so the queue can be
built, gated and reviewed before the loader exists.

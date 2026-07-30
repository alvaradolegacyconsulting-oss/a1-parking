# Manager bulk approve — ordered combined action (restore `approveAllPendingProperty`)

**Filed:** 2026-07-30. **Status:** designed, NOT built.
**Blocker for:** [Manager mobile approval + lookup view](manager-mobile-approval-lookup.md).
**Supersedes:** the earlier "skip pending-resident vehicles" decision — data below drove the change.

---

## The distribution settles it

Green Acres, current:

| resident | vehicle | count |
|---|---|---|
| active | active | 31 |
| **active** | **pending** | **4** |
| **pending** | **pending** | **4** |

39 vehicles total, 8 pending — **split evenly between the two cases.**

- **4 pending vehicles under pending residents** → registration-wizard vehicles. `/register` collects a vehicle
  at step 2, before any approval, so both rows land pending together. Confirmed.
- **4 pending vehicles under active residents** → later additions via `+ Request New Vehicle`, which requires
  portal access and therefore an approved resident. Leslie Abarca's row 700 is one of these.

**Plain skipping would skip half the queue** and report *"4 approved, 4 skipped."* Technically correct,
practically useless.

**Also clean:** zero `NULL` resident rows, so every vehicle joins to a resident. No orphans.

**And Miriam is working it** — 24 vehicles yesterday, 39 today; pending down from 23 to 8. She's engaged. Bulk
approve is about the next 200 units, not about rescuing a stalled queue.

---

## Decision — one ordered action, not a skip

**Primary: `Approve all pending`** — residents first, then vehicles. Nothing skipped, correct ordering by
construction, one tap.

```
Phase 1  approve pending residents  → collect per-row results
Phase 2  approve pending vehicles whose resident is NOW active
         (i.e. was already active, or succeeded in phase 1)
Phase 3  one refreshCrmData() — not per item
Phase 4  report, then refresh
```

🔴 **Phase 2's eligibility check is the important part.** If a resident approval *fails* in phase 1, their
vehicle must **not** be approved — otherwise a failed resident approval leaves an authorized car for someone
who isn't an approved resident. So gate on the phase-1 result, not on the pre-phase-1 snapshot.

**Retain per-row approve and decline** for the exceptions — a commercial truck that shouldn't be authorized, a
registration that looks wrong.

**Keep the skip logic, but only on a vehicles-only bulk action** as a safety net: if vehicles are bulk-approved
while residents are pending, skip those and say so. With the combined action existing, nobody should reach it.

### Worth confirming while building

Does `approve_vehicle` itself check resident status? If not — likely — then resident-before-vehicle is **our**
policy rather than an enforced invariant. That's fine and correct, but it should be a comment in the handler so
the ordering doesn't get "optimized" into parallel phases later.

---

## 🔴 Per-item failure visibility — the part that makes it trustworthy

A bulk action that reports success while one row silently stayed pending is worse than no bulk action, because
the manager stops checking.

- Collect each result's `error`; do **not** `Promise.all` and discard
- Summary the manager actually sees:
  *"4 residents approved · 7 of 8 vehicles approved · 1 failed: TXP4471"*
- Failures named by plate or resident name, not row id
- Console log per failure with the tag pattern, `[Manager approveAllPending] failed`

**Plate collisions are the likely real failure.** `vehicles_authorized_plate_uidx` is on
`(upper(plate), property)` — two residents submitting the same plate means the second approval violates the
index. At 250 units that will happen. The summary should make it legible rather than mysterious.

## Two disciplines that already apply here

- **One `refreshCrmData()` after the loop, not per item.** Per-item would be N×5 queries; the bulk handlers
  already got this right in `4440457` and the new path must too.
- **Feedback before refresh** (`9a47464`) — show the summary, then refetch. On mobile over cellular the gap is
  visible.

## Surfaces

`approveAllPendingProperty` is the stranded legacy-branch handler. Restore it into `PmResidentCrm` as the
combined ordered action. **Same handler serves the mobile view** — that's what unblocks it.

---

## Verify

- Seed a pending resident **with** a wizard vehicle, and a pending vehicle under an already-active resident —
  both cases from the distribution table above
- `Approve all pending` → both residents and all vehicles end active; nothing skipped
- Force one resident approval to fail → **their vehicle stays pending**, summary names it
- Force a plate collision → summary names the plate, other rows still succeed
- Counts refresh once, not per row
- Summary appears before the list refreshes

## Sequencing, unchanged from the mobile spec

1. **This** — bulk approve restored with the ordered action. Desktop relief immediately.
2. **Mobile view** — lands with bulk working from day one.

## Cross-references

- [manager-mobile-approval-lookup.md](manager-mobile-approval-lookup.md) — blocked on this
- `4440457` `refreshCrmData()` fan-out — the once-per-loop discipline
- `9a47464` feedback-before-refresh — summary before refetch
- Confirmed-bugs entry "bulk-approve per-item failure visibility" — this closes it

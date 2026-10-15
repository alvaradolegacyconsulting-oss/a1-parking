# Billing guard — built, and two legs I will not fake

Built and committed. `verify:billingguard` is green on everything
reachable, and **states two legs as untested rather than passing them.**

## What the guard does

`companyPerPermitLineItems(companyId)` in `app/lib/stripe-mutations.ts`
— read-only, beside `syncOnAdd` so there is one place that knows how to
find a line item on a subscription. It returns the same vocabulary
`syncOnAdd` already uses (`skipped_no_sub`, `skipped_no_line_item`), so
an operator reading a queue refusal and a developer reading a sync log
see the same words for the same state.

🔴 **It fails closed.** If Stripe cannot be reached, the load is
refused. Refusing costs an operator a retry; proceeding costs a customer
a charge they did not agree to, or a silent under-bill nobody notices
until renewal.

🔴 **And the metered case is a different KIND of block.** Approve and
Load are refused; **Return and Reject are not.** Sending the batch back
is precisely the right answer for a metered tenant — *"we cannot
bulk-load you, your plan bills per permit"* — and folding it into the
hard block would leave the batch stuck with no move the operator could
make. The queue shows it as its own panel saying so.

## 🔴 The two legs, and why

Measured, not assumed:

- **A1 Wrecker llc is the only company in the system with a
  `stripe_subscription_id`.**
- **No subscription anywhere carries a `per_permit` item.**
  `syncOnAdd`'s own comment says why: *"Until slice 2 ships checkout
  creating subscriptions with per_permit items, this returns
  action='skipped_no_line_item'"*.
- There are **8** `per_permit` Prices in the catalog, all
  `property_management` track (pm_only, pm_starter).

So:

| leg | state | why |
|---|---|---|
| a tenant with no subscription is not blocked | ✅ tested | Demo Company, and every test company |
| the guard is on the load path at all | ✅ tested | the response carries both block kinds |
| Return survives a load-only block | ✅ tested | a property of the routes, no metered tenant needed |
| **a metered tenant is refused** | ✅ decision logic | the production decision functions, handed a metered check result. Real end-to-end required in the slice-2 checkout gate. |
| **an A1-shaped tenant (subscribed, not metered) is unaffected** | ✅ from the cron record | latest `BILLING_SYNC_CRON` run, ≥31 consecutive, A1 → `skipped_no_line_item` |

## How the two legs were covered — ruled 2026-10-16

**No Stripe writes, and no reads of A1 from this session.** Live keys
stay with Jose. So:

### Metered — decision-logic coverage

The two decisions are pure functions in
`app/lib/import-batch-block.ts`, which carries no `server-only`:

- `meteredLoadReasons(check, companyName, vehicleCount)` — a
  `MeteredLineItemCheck` in, the load-blocking sentences out.
- `blockRefusesAction(action, block)` — the per-action truth table.

The gate hands the first one a metered result and reads the answer, then
drives the second over **three block shapes × four actions** and
asserts all twelve cells.

🔴 **Neither is a fault-injection seam.** The standing rule is no such
seam in production code, and there is none: these are the functions the
real path calls, with the inputs it gives them. Extracting them also
removed four inline copies of a per-action condition from the four
routes — which is where the fourth copy drifts.

🔴 **And it is labelled as what it is.** This proves that *when* a
subscription carries a `per_permit` item the refusals and the
permissions are the ruled ones. It does **not** prove Stripe would
return such a result, because nothing carries one yet.

### A1 — from the cron's own record

The nightly permit sync already asks Stripe this exact question every
day and writes the answer down, so the evidence exists:

```
BILLING_SYNC_CRON, latest run
outcomes: [{ ok: true, action: "skipped_no_line_item",
             company_id: 91, company_name: "A1 Wrecker llc" }]
```

Asserted: the latest run records A1 as `skipped_no_line_item`, it has
done so for **every consecutive run on record** (≥31), and no run has
ever recorded an `incremented` outcome for anyone — the same fact from
the other side. No live call, no production read.

### Required in the slice-2 checkout gate

🔴 **The real metered end-to-end is a required leg in the slice-2
checkout gate**, to be added when per_permit subscriptions first exist.
Recorded in the Sweep #2 backlog as a binding note, not a suggestion:
checkout is the thing that will create the first metered subscription,
so its gate is the first place the full path can be exercised, and the
decision-logic coverage above is explicitly not a substitute.

## 🔴 One thing I got wrong three times today

The first version of this gate failed its own route-source check:
it asserted `!/loadBlocked/.test(returnSrc)` and the route carries the
comment *"ONLY THE HARD BLOCK, NOT loadBlocked"*. The comment explaining
the rule defeated the check for the rule — the third instance today,
after two in SQL, and after I had already written the memory about it.

The memory said presence checks survive it and COUNT/POSITION checks do
not. That was incomplete: a **negative** presence check — "this token
must be absent" — is just as vulnerable, and in any language. The
memory now says so, and every gate that reads source in this feature
strips comments first and asserts that the strip removed something.

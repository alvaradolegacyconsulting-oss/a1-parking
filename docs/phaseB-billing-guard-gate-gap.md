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
| **a metered tenant is refused** | ➖ untested | nothing carries a `per_permit` item to match |
| **an A1-shaped tenant (subscribed, not metered) is unaffected** | ➖ untested | A1 is the only subscribed company, and it is production |

## The decision I need

Testing the metered leg means **creating a Stripe subscription** with
one of the 8 catalog `per_permit` Prices. That is a Stripe write, and
two standing rules point at it:

- `seed-demo-data-ONE-TIME.ts` **refuses** if a demo company carries
  Stripe artifacts — *"demo tenants must be Stripe-invisible"*.
- A1 is production and stays out of tests.

Three ways forward, and my recommendation:

**(a) A throwaway company, test mode, cancelled and deleted in the same
run.** The gate creates a company, a Stripe test-mode customer and a
subscription carrying a `pm_starter` `per_permit` Price, asserts the
refusal, then cancels the subscription and deletes the company. The
Stripe objects are test-mode and cancelled within a minute.
**This is what I would do** — it exercises the real branch against a
real subscription, and the Stripe-invisible rule is about the
*persistent* demo tenant rather than an ephemeral fixture. But it is a
Stripe write and I have made none this session, so it is yours to
approve.

**(b) Leave it until slice 2.** Checkout will create subscriptions with
`per_permit` items, and at that point a metered tenant exists naturally
and the leg becomes testable with no fabrication. The guard is correct
and inert until then — which is also exactly the state `syncOnAdd` is
in, and has been since it shipped.

**(c) A read-only leg on A1.** `subscriptions.retrieve` on A1's real
subscription, no writes, no batch, proving `skipped_no_line_item`
against the one real subscription that exists. It covers the second
untested leg only, not the metered one. Low risk, but it reads
production billing from a gate, so I am not doing it unasked.

**(a) plus (c) covers both legs. (b) covers neither and costs nothing.**

Until you pick, the gate says ➖ on both rather than ✅, because a gate
that reports green on a branch it never ran is worse than one that
admits the hole.

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

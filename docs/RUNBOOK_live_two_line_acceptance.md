# RUNBOOK — live two-line acceptance: Operator Pro, 2 properties

**For Jose. Mateo prepared it; Jose runs it. Live keys and the card stay with Jose.**

Closes the long-open P1: **a base + per-property subscription has never run live.** A1's code is
base-only (`custom_per_property_fee = 0`, so the $0-omit rule dropped the line), so every Pro
customer would otherwise be the first real test of that path.

**Expected first invoice: $339.00** — $299 base + 2 × $20 per property, pre-tax.
Texas sales tax is added at checkout, so the card total will be higher. That is correct.

> 🔴 **This spends real money on a real card and then refunds it.** Budget ~20 minutes and do it
> in one sitting — a half-finished run leaves a live subscription on a throwaway company.

---

## Before you start

| | |
|---|---|
| Browser steps | the signup flow and Stripe Checkout — **your card** |
| Terminal steps | the checks, the add-a-property step, the refund and the cleanup |

**Restricted key — minimum scope.** Dashboard → Developers → API keys → Create restricted key,
name it `two-line-acceptance-TEMP`:

| Resource | Permission | Why |
|---|---|---|
| **Subscriptions** | **Write** | read the sub, update the per-property quantity, cancel |
| **Invoices** | **Write** | read the first invoice; `always_invoice` would create one |
| **Charges** | **Write** | issue the refund |
| **Customers** | **Read** | resolve the customer behind the subscription |

Everything else **None**. No Products, no Prices — this run creates neither.

---

## 1 — Terminal: open the shell and record the "before"

```zsh
cd /Users/ALC/a1-parking
read -s "K?Stripe LIVE restricted key: "; echo; export STRIPE_LIVE_SECRET_KEY="$K"; unset K
set -a; . ./.env.local; set +a
```

`read -s "K?prompt"` is the zsh form. The value is never a command argument, so it never lands in
`~/.zsh_history`, and it dies with the shell.

```zsh
npx tsx scripts/acceptance-two-line.ts before
```

**Should print:** A1's subscription id, its single item at $325.00 qty 1, and `companies` rows =
6. Write the A1 line down — step 6 compares against it.

---

## 2 — Browser: sign up as a throwaway

1. Open a **private window** → `https://shieldmylot.com/signup?tier=operator_pro`
2. **Operator Pro** should already be selected. Set **Properties = 2**. Cycle **monthly**.
3. Company name: **`ZZ Two Line Acceptance`** — the cleanup script matches on it exactly.
4. Email: a `+` alias you control, e.g. `alvaradolegacyconsulting+twoline@gmail.com`.
5. Complete signup, confirm the email, and on `/signup/verify`:
   - **sign the SaaS Agreement** (the Continue button stays disabled until you do — and as of
     today the server refuses checkout without it too, so this is no longer skippable),
   - then **Continue → Stripe Checkout**.
6. Pay with your real card.

**🔴 Check the Stripe Checkout page before paying.** It must show **two line items**:

```
ShieldMyLot Operator Pro — Base            $299.00
ShieldMyLot Operator Pro — Per-Property    $40.00   (2 × $20.00)
                                  subtotal $339.00
                                     + TX sales tax
```

**If you see one line item, stop and tell me.** One line means the per-property line was dropped,
which is exactly the failure this test exists to find.

---

## 3 — Terminal: verify the subscription and the first invoice

```zsh
npx tsx scripts/acceptance-two-line.ts after
```

**Should print:**
- subscription `status=active`, **2 items**
- base qty 1 @ 29900, per-property **qty 2**, graduated
- first invoice **subtotal 33900** (`$339.00`), plus a tax line
- the `companies` row for `ZZ Two Line Acceptance`, tier `legacy`, with a `stripe_subscription_id`

---

## 4 — Browser: add a third property

In the same private window, in the CA portal → **Properties → Add**. Name it anything.

It must be **accepted** — the ceiling is 50, and this is property 3.

---

## 5 — Terminal: confirm the quantity ratcheted, with a proration

```zsh
npx tsx scripts/acceptance-two-line.ts after-add
```

**Should print:** per-property **qty 3**, and an **upcoming invoice** carrying a prorated
line for the partial month on the 3rd property (a few dollars, not $20 — it is pro-rated for the
days remaining).

> This is `create_prorations`: on **monthly** the proration lands on the invoice ~30 days out,
> which is fine. The same behaviour on an **annual** plan is the open question in my separate
> report — there it could sit for up to a year.

---

## 6 — Terminal: refund, cancel, clean up

```zsh
npx tsx scripts/acceptance-two-line.ts teardown
```

It refunds the charge, cancels the subscription immediately, and deletes the throwaway company,
its properties and its login — printing a count for each. It **refuses** to touch anything whose
company name is not exactly `ZZ Two Line Acceptance`.

Then re-run the A1 comparison:

```zsh
npx tsx scripts/acceptance-two-line.ts before
```

**A1's line must be byte-identical to step 1.** Same subscription id, same price, same quantity.

---

## 7 — Revoke and close

Dashboard → API keys → `two-line-acceptance-TEMP` → **Revoke**.

```zsh
unset STRIPE_LIVE_SECRET_KEY
exit
```

Also delete the throwaway's Stripe **Customer** in the dashboard if you want it gone entirely —
the script leaves it, because deleting a customer removes the refund record from the dashboard's
customer view and the refund is the evidence this ran.

---

## If something goes wrong

- **🔴 `legal consent not recorded at current versions`, with `saas_agreement` in `missing`.**
  New as of today: the SaaS Agreement is now enforced **server-side**, not just by the disabled
  button. If you reach this, the signature on `/signup/verify` did not record — go back, sign it,
  and retry. Do not try to work around it; refusing here is the gate doing its job, and it is the
  one that makes the agreement a contract rather than a checkbox.
- **One line item at checkout** → stop, do not pay, tell me. That is the defect.
- **Subtotal is not $339** → pay nothing, screenshot, tell me the figure.
- **Teardown fails partway** → re-run `teardown`; it is idempotent and reports what is left.
- **A1's line differs in step 6** → stop everything and tell me immediately. Nothing in this run
  touches A1, so a difference means something else did.

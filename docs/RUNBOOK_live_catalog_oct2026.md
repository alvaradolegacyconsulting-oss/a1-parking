# RUNBOOK — live Stripe catalog run, Oct 2026 Pro lineup

**For Jose. Mateo prepared it; Jose runs it. Live keys stay with Jose.**

Creates 10 live Stripe prices for **Operator Starter**, **Operator Pro** and **PM Pro**.
Already run and verified in test mode (commit `e0c0c4f`).

---

## 1 — The restricted key: the minimum that works

Stripe Dashboard → Developers → API keys → **Create restricted key**.

Name it something you will recognise in the revoke list, e.g. `oct2026-catalog-TEMP`.

**Grant exactly two permissions, both Write:**

| Resource | Permission | Why |
|---|---|---|
| **Products** | **Write** | creates 4 new Products; reads and stamps `tax_code` on them |
| **Prices** | **Write** | creates 10 prices; archives the old flat per-property price |

Leave **everything else at None.** The script makes six kinds of call and no others — I counted
them in the source rather than guessing:

```
products.create · products.retrieve ×2 · products.update
prices.create ×2 · prices.list ×2 · prices.update
```

No customers, no subscriptions, no invoices, no charges. A key with only those two scopes
**cannot touch A1's subscription even by accident**, which is the point of using one.

---

## 2 — The commands, in order

Run from the repo root. **Each block is one paste.**

### 2a — load the key without putting it in your shell history

```bash
cd /Users/ALC/a1-parking
read -s -p "Stripe LIVE restricted key: " STRIPE_LIVE_SECRET_KEY; echo
export STRIPE_LIVE_SECRET_KEY
set -a; . ./.env.local; set +a
export STRIPE_MODE=live
```

`read -s` hides the typing and, because the value never appears as a command argument, it does
not land in `~/.zsh_history`. `set -a; . ./.env.local` supplies the two Supabase variables the
script also needs (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).

> 🔴 `.env.local` has no live Stripe key in it, and should not gain one. The `export` above is
> what makes this a live run, and it dies with the shell.

### 2b — dry run. **No network calls. Compare against §3 before continuing.**

```bash
npx tsx scripts/create-stripe-prices.ts --dry-run
```

### 2c — the real run

```bash
npx tsx scripts/create-stripe-prices.ts
```

### 2d — verify the projection

```bash
npm run verify:catalog -- live
```

Expect `✅ ALL CATALOG ASSERTIONS PASS`, including **"A1's proposal price untouched"**.

### 2e — revoke the key, then close the shell

Stripe Dashboard → API keys → the `oct2026-catalog-TEMP` key → **Revoke**.

```bash
unset STRIPE_LIVE_SECRET_KEY STRIPE_MODE
exit
```

---

## 3 — What the dry run must show

It prints all 24 addresses. The 14 without a 🆕 are existing v3 rows and must be **unchanged** —
if any of those shows a different amount, stop.

**The 10 marked 🆕 are what will be created.** Line by line:

```
🆕 ShieldMyLot Operator Starter — Per-Property  graduated [{"up_to":20,"unit_amount":1500},{"up_to":null,"unit_amount":0}]
   sml.enforcement.enforcement_only.per_property.monthly.v4
🆕 ShieldMyLot Operator Starter — Per-Property  graduated [{"up_to":20,"unit_amount":15000},{"up_to":null,"unit_amount":0}]
   sml.enforcement.enforcement_only.per_property.annual.v4
🆕 ShieldMyLot Operator Pro — Base              flat 29900c
   sml.enforcement.legacy.base.monthly.v4
🆕 ShieldMyLot Operator Pro — Per-Property      graduated [{"up_to":20,"unit_amount":2000},{"up_to":null,"unit_amount":0}]
   sml.enforcement.legacy.per_property.monthly.v4
🆕 ShieldMyLot Operator Pro — Base              flat 299000c
   sml.enforcement.legacy.base.annual.v4
🆕 ShieldMyLot Operator Pro — Per-Property      graduated [{"up_to":20,"unit_amount":20000},{"up_to":null,"unit_amount":0}]
   sml.enforcement.legacy.per_property.annual.v4
🆕 ShieldMyLot PM Pro — Base                    flat 24900c
   sml.property_management.legacy.base.monthly.v4
🆕 ShieldMyLot PM Pro — Per-Property            graduated [{"up_to":20,"unit_amount":1500},{"up_to":null,"unit_amount":0}]
   sml.property_management.legacy.per_property.monthly.v4
🆕 ShieldMyLot PM Pro — Base                    flat 249000c
   sml.property_management.legacy.base.annual.v4
🆕 ShieldMyLot PM Pro — Per-Property            graduated [{"up_to":20,"unit_amount":15000},{"up_to":null,"unit_amount":0}]
   sml.property_management.legacy.per_property.annual.v4

Dry run complete. 10 of 24 are new (🆕).
```

**The four checks worth making by eye:**

1. **Ten 🆕 lines, no more.** An eleventh means something else changed shape.
2. **Every annual amount is exactly ten times its monthly one** — `29900`→`299000`,
   `2000`→`20000`, `1500`→`15000`. Amounts are **cents**.
3. **Every graduated line ends `{"up_to":null,"unit_amount":0}`.** That zero is the 21–50
   band. Without it you are charging per property forever.
4. **`PM Pro` has no `Per-Permit` line.** PM Pro has unlimited permits; a permit line here
   would meter a plan sold as unmetered.

Sanity, against the decision table — base + 20 × rate:

```
Operator Pro      $299 + 20×$20 = $699       PM Pro  $249 + 20×$15 = $549
Operator Starter  $199 + 20×$15 = $499
```

---

## 4 — Two things the real run does that the dry run cannot show

**It archives the old flat price in the same pass.** Operator Starter's per-property changes
from flat to graduated, so its lookup key moves `v3 → v4`. The script's MIGRATE path archives
the old Stripe price and creates the new one **in one run** — it is not a separate step and it
is not optional. You will see:

```
MIGRATE sml.enforcement.enforcement_only.per_property.monthly.v4 (from ....v3, archiving old price price_...)
ARCHIVE old price price_... (active=false)
CREATE  sml.enforcement.enforcement_only.per_property.monthly.v4 (...)
```

This is safe: **zero live subscriptions use that price** (verified — only A1 and Test PM Starter
2 have subscriptions, and A1 is on its own proposal-code price). Archiving a price never affects
a subscription already using it in any case.

**It updates the projection row in place.** The `stripe_prices` row keeps its id and becomes the
v4 graduated row. The old flat price survives only in Stripe, not in our database. Correct for
checkout, but it means the DB will hold no record that $15-flat ever existed.

---

## 5 — If something goes wrong

- **The script is idempotent.** It matches on lookup key, so re-running after a failure skips
  what exists and creates only what is missing. Re-run it.
- **`verify:catalog live` fails** → do not proceed to the signup work. Send me the output; the
  gate names the exact assertion.
- **Nothing to roll back on our side.** Prices are immutable; an unwanted one is archived in
  the Stripe dashboard, not deleted.
- **A1 is the thing to protect.** The gate asserts A1's proposal price is still active at
  $325.00. If that line ever fails, stop everything and tell me before touching anything else.

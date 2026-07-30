# Manager mobile approval + lookup view

**Filed:** 2026-07-30. **Updated:** 2026-07-30 (bulk-approve shape locked as ordered combined action —
see delta below). **Status:** designed, NOT built. **Blocked on:**
[manager-bulk-approve-ordered-combined.md](manager-bulk-approve-ordered-combined.md).

Scoped deliberately narrow instead of a responsive pass on the resident CRM.

---

## What it's for

Miriam manages a 250-unit manufactured home community. She's walking lots, not sitting at a desk. What she
needs on a phone is three things:

1. **See what's waiting** — residents and vehicles pending approval
2. **Approve or decline** — including in bulk
3. **Look someone up** — by unit or plate, standing in front of a car

That's it. Everything else stays on desktop.

## Architecture — share the writes, narrow the reads, separate the presentation

**New route** (`/manager/mobile` or similar), not a breakpoint inside the CRM. Zero risk to the desktop
surface, and it can be purpose-built rather than a compromise. The cost is two surfaces — acceptable because
the mobile one has three jobs, not thirty.

**Reuse the existing write handlers verbatim** — `approveResident`, `declineResident`, `approveVehicle`,
`declineVehicle`, and the `residentDisplayStatus()` helper. That means the tier logic (`initialVehicleState`),
the audit rows, and the status semantics all come along for free. **Do not reimplement an approve.**

🔴 **But do NOT reuse the CRM's data loading.** `refreshCrmData()` fans out five queries across the entire
property — fine on a desktop with 24 residents, slow on cellular at 250. The mobile view should:

- fetch **pending rows only** on load
- run **search on demand**, not by filtering a preloaded array
- after a write, refetch **just the pending list** — not the fan-out

That's faster, simpler, and it keeps the mobile surface from inheriting the desktop's payload growth.

## Screen 1 — Pending queue (landing)

```
Green Acres                              [Look up ▸]

RESIDENTS AWAITING APPROVAL      4
VEHICLES AWAITING APPROVAL       8

  [ Approve all pending ]        ← residents first, then their vehicles

  ┌────────────────────────────────────┐
  │ Maria Gonzalez        Unit 214     │
  │ maria…@gmail.com                   │
  │  [ Approve ]      [ Decline ]      │
  └────────────────────────────────────┘
  …

  ┌────────────────────────────────────┐
  │ TXP4471   Unit 214                 │
  │ 2019 Honda Civic · Silver          │
  │ Maria Gonzalez                     │
  │  [ Approve ]      [ Decline ]      │
  └────────────────────────────────────┘
  …
```

**Delta 2026-07-30 (bulk-approve shape lock):** replaced the two separate bulk buttons ("Approve all N
residents" + "Approve all N vehicles") with a single **`Approve all pending`** — the ordered combined action
from [manager-bulk-approve-ordered-combined.md](manager-bulk-approve-ordered-combined.md). Residents first, then
vehicles whose resident is NOW active (phase-1 result, not pre-phase-1 snapshot). A vehicles-only bulk on a
phone is the exact way someone authorizes a car for an unapproved resident; the combined action removes that
foot-gun. Per-row approve/decline stay on each card.

Empty state: **"Nothing waiting."** Which is itself useful — a five-second check is most of what the missing
pending-queue notification would have given her.

**Per-item failure summary shown before refresh** — per the bulk-approve spec:
*"4 residents approved · 7 of 8 vehicles approved · 1 failed: TXP4471"*. Named by plate or resident, not row
id. Feedback before refresh (`9a47464` discipline) — on cellular the gap is visible.

## Screen 2 — Lookup

Single input, searches **unit or plate** (one field, not two — she doesn't want to choose).

```
[ 214 or TXP4471                    ]

Maria Gonzalez              ● Active
Unit 214 · maria…@gmail.com · 555-0147
Space R-12

  TXP4471   Approved
  2019 Honda Civic · Silver

  BXR8890   Pending approval
  2021 Toyota RAV4 · White
    [ Approve ]      [ Decline ]
```

Plate search should normalize the same way enforcement does — uppercase, non-alphanumerics stripped — so
`txp-4471` finds it. Reuse the existing normalization rather than writing a new one.

## Deliberately excluded

No editing, no space management, no violations, no visitor passes, no CSV export, and **no deactivate**.
Deactivation cascades (vehicles dropped from authorization, spaces freed, pending requests declined) — not a
thing to do by accident on a phone. Keep destructive actions on desktop.

## Role gate

Managers only. **Use `get_my_role()`**, not `.ilike('email', …)` — per the `/qr` lesson (`9b73b53`): the ilike
form can pattern-match another user's row, and `.maybeSingle()` errors on duplicate rows. And scope to the
manager's assigned properties from `user_roles.property`.

## One thing available today, no build required

The app already ships `manifest.webmanifest`. **Miriam can add the site to her phone's home screen right now**
and get a full-screen, app-like launcher. Worth telling A1 in the meantime — it costs nothing and it's the
"is there an app?" answer.

## Size

One route, mobile-first, reusing existing handlers with narrow queries of its own. **Roughly a day**, plus
real verification on an actual phone rather than a resized browser — touch targets, the on-screen keyboard
covering inputs, and how it behaves when a request times out on cellular.

**Dependency:** bulk approve. If that isn't restored first, the highest-value part of this view can't be
built.

## Sequencing

1. **`approveAllPendingProperty` restore** — needed here, and it independently fixes 23 clicks on desktop
2. **Mobile view** — lands with bulk approve working from day one

Doing them in that order means the desktop gets the immediate relief while the mobile view is built, rather
than Miriam waiting for both.

## Cross-references

- [manager-bulk-approve-ordered-combined.md](manager-bulk-approve-ordered-combined.md) — the blocker; ordered
  combined action + per-item failure visibility both live there. Reflected in the delta above.
- `9a47464` feedback-before-refresh discipline — applies to every write on this surface
- `9b73b53` role-gate lesson — `get_my_role()` RPC, not `.ilike('email')` + `.maybeSingle()`
- Pending-queue notification (confirmed bug) — landing on the mobile view partly answers this; a persistent
  badge/notification is still worth doing for managers who don't open the app

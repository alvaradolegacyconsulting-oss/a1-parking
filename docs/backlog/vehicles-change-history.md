# `vehicles` has no edit history — filed 2026-10-14, not built

## Why this is filed

Asked "has the plate-state overwrite already happened?", the answer could
only be given **indirectly**: all 82 audit rows carrying a state change
read `undefined → "TX"` (creation, not an overwrite), and the strongest
evidence was that the vulnerable rows still held their original values.

That is a weak form of proof, and it was the only form available.

## What is actually missing

| | |
|---|---|
| `vehicles.updated_at` | **absent** |
| `vehicles.updated_by` | **absent** |
| row-level change history | **none** |
| `VEHICLE_STATE_CHANGE` trigger (Stage 1a) | fires on **`status` / `is_active` only** |
| client audit rows | written per *intent* (`EDIT_VEHICLE`, `RESIDENT_EDIT_VEHICLE`), so a direct PATCH from anywhere else writes nothing |

So a change to `plate`, `state`, `unit`, `space`, `make`, `model`,
`color`, `resident_email` or `manager_note` leaves **no trace at all**
unless the client that made it happened to log one.

🔴 `plate` and `resident_email` are the two that matter most: the plate
IS the authorization, and `resident_email` is the owner stamp that
`reactivate_resident_vehicles` and the B166 owner-trim both scope on.
Neither is covered today.

## Options, cheapest first

1. **`updated_at` + `updated_by`** — a BEFORE UPDATE trigger stamping
   `now()` and the JWT email. Answers "when, and by whom" but not
   "from what to what". ~half a day including the gate.
2. **Widen the Stage 1a trigger** from `status, is_active` to the
   identity-bearing columns (`plate`, `state`, `resident_email`, `unit`),
   emitting old→new the way it already does. Answers "from what to what"
   for the columns that matter, and reuses a trigger that exists and is
   verified. 🔴 Watch the volume: 852 vehicles, and a bulk import could
   write a thousand audit rows in one transaction — the
   `VEHICLE_STATE_CHANGE` action is already in `audit_logs`, which is at
   ~4,900 rows, so this needs a row-count estimate before it ships.
3. **A dedicated `vehicle_changes` table.** Cleanest, most work, and the
   only option that survives an `audit_logs` retention policy.

**Recommendation: option 2.** It answers the question that was actually
asked, costs one `CREATE OR REPLACE` on a verified trigger, and needs no
new table or RLS. Option 1 is cheaper but would not have answered
"has this already happened?" either — it would only have told us
*something* changed.

## Prerequisite, from the binding lesson

A full **writer sweep of `vehicles`** before widening the trigger, so the
volume estimate covers every path — not only the verbs in the ruling.
The sweep from 2026-10-14 is the starting point: 22 write sites, of
which 3 are the add paths now behind `manager_add_vehicle`.

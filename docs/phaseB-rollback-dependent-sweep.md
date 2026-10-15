# Rollback dependents — the full sweep, with matching keys

Swept the **live schema** (43 tables via PostgREST's own OpenAPI
definitions, not the repo), classified every column that could point at
a resident or a vehicle, and checked which candidates are views.

**You were right and the number is not 9 either. It is 11.** Your six,
plus the three the FK walk already finds, plus **two you did not list
that are the likeliest of all in practice.**

---

## The 11 dependent checks

### Already covered — by foreign key (3)

The dynamic walk finds these. Kept as-is.

| table | column | → | on delete |
|---|---|---|---|
| `vehicle_plate_changes` | `vehicle_id` | `vehicles.id` | **CASCADE** |
| `vehicle_parking_tags` | `vehicle_id` | `vehicles.id` | **CASCADE** |
| `spaces` | `designated_vehicle_id` | `vehicles.id` | SET NULL |

### By resident email (6) — your six, confirmed

| table | key | scope | why it orphans |
|---|---|---|---|
| `space_residents` | `resident_email` | via `space_id` → `spaces.property` | the resident is gone, the space still says it is theirs |
| `space_assignment_history` | `resident_email` | via `space_id` → `spaces.property` | history pointing at nobody |
| `space_payments` | `resident_email` | `property` | **a payment record with no payer** |
| `space_requests` | `resident_email` | `property` | a pending request from a resident who does not exist |
| `guest_authorizations` | `resident_email` | `property` | a guest still admitted by a resident who is gone |
| `dispute_requests` | `resident_email` | `property` | a live dispute with no disputant |

`space_residents` and `space_assignment_history` have **no property
column** — they scope through `space_id` → `spaces.property`. Matching
`resident_email` alone would over-refuse, because the same address can
be a resident at another property.

### 🔴 By vehicle plate (2) — not in your six, and the most likely

| table | key | scope | why it orphans |
|---|---|---|---|
| `violations` | `normalize_plate(plate)` | `property` | **a ticket against a plate with no vehicle** |
| `vehicle_removals` | `normalize_plate(plate)` | `property` | **a tow log entry for a car we no longer know** |

These matter more than the other eight combined, because enforcement is
what the product is *for*. A property bulk-loads 358 cars in the
morning; by the afternoon one of them is parked wrong and gets a
violation, or gets towed. Roll the batch back and the ticket points at a
plate with no vehicle row — and `vehicle_removals` is the tow log,
which my standing note says is *a log, not enforcement*, so an entry
there must not be quietly detached either.

`normalize_plate`, not `=`: that is the function the plate uniqueness
index uses, and enforcement matches on plate alone.

### 🔴 One refinement I recommend rather than assume

For the two plate-keyed tables, scope to **`created_at >= loaded_at`**.

A plate was in the lot before it was loaded. A violation written last
week against that same plate — when the car was unregistered — is not a
dependent of the batch: it never referred to the vehicle row, and the
row's removal does not orphan it. Without the time scope, rollback would
refuse because of history that predates the load it is undoing.

The email-keyed six need no time scope: the validator refuses a file
containing an address already on file at that property, so any match
there must have arrived after the load.

---

## Deliberately NOT dependents, with reasons

| not checked | why |
|---|---|
| `audit_logs.user_email` | A log is meant to outlive its subject. 🔴 And rollback writes its own audit row through the trigger — blocking on audit rows would make it block on itself. |
| `visitor_passes.plate` | A pass belongs to a **visitor**, not to a resident's vehicle row. The same plate is a coincidence, not a reference. |
| `authorized_plates`, `do_not_tow_plates`, `property_plate_prohibitions` | Plate **lists** — configuration about a plate, independent of whether a vehicle row exists. |
| `guest_authorizations.plate` | That is the **guest's** plate, not the resident's vehicle. The `resident_email` on the same table is the real dependency and is checked. |
| `guest_auth_chain_summary`, `guest_auth_long_chains` | 🔴 **Views.** Confirmed: `cannot delete from view`. A view cannot hold a dependent row. |
| `companies.email`, `drivers.email`, `leads.email`, `storage_facilities.email`, `tow_operators.created_by_email`, `proposal_codes.issued_by`, `property_house_rules_versions.created_by_email`, `vehicle_removal_media.created_by_email`, `spaces.created_by_email` | **Actor** columns — a staff member who did something, not a resident the batch created. |
| `vehicle_plate_changes.submitted_by` / `decided_by` | Actor columns, and that table is already covered by its FK. |
| `user_roles.email` | That is a table rollback **deletes**, not one that depends on it. |

Two of those are judgment calls rather than facts, and I would rather
you overturn them than not see them: **`visitor_passes`** and
**`authorized_plates`**. Both key on a plate at a property, so a strict
reading would make them dependents. I have them as independent because
neither was created *because* a vehicle row existed — a pass is issued
to a visitor and a plate list is configuration — so removing the vehicle
leaves them exactly as true as they were. Say the word and they become
checks.

---

## What I propose to build

`rollback_import_batch` keeps the dynamic FK walk **and** gains an
explicit block of value-based checks — 8 more, each with its key and its
scope above, each returning the table and row count the way the FK
blockers already do. The FK walk stays because it still catches a
referencing table added later; the explicit list exists because value
references cannot be discovered.

🔴 **And the explicit list gets a count assertion in the paired
verification**, so a ninth value-reference added to the schema later
fails the gate rather than silently going unchecked. That is the only
defence against this exact finding happening again: the FK walk is
self-maintaining and the value list is not, so the list has to be
counted.

Gate: a `guest_authorizations` row issued by an imported resident must
make rollback refuse, built and taken down the way the
`vehicle_plate_changes` dependent already is.

Not building until you confirm the 11 and the `created_at >= loaded_at`
refinement.

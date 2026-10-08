# Backlog — let a resident withdraw their own pending request

**Date filed:** 2026-10-07
**Ruling:** Jose, 2026-10-07.
**Queue position:** behind the plan-names work
(docs/backlog/tier-display-names-and-price-sources-2026-10-02.md).

## The ruling

> Let residents withdraw their own pending request. Same ownership guard
> as `deactivate_my_vehicle`, a confirm dialog, recorded as
> resident-withdrawn, visible to the PM. Until it's built, make the
> pending case return an honest refusal (`not_active`) instead of
> `{ok:true}` for a no-op.

**The interim half is DONE** — `20261007_deactivate_my_vehicle_honest_refusal.sql`.
A pending row now raises `not_active` with a hint that says withdrawal
isn't available yet, instead of reporting `{ok:true,
action:'already_deactivated'}` and touching nothing. Asserted by
execution in `npm run verify:residentremove`.

This file is the remaining half.

## Why it's wanted

A resident who submits the wrong plate currently has no way to take it
back. The request sits in the manager's queue until someone decides on
it, and the resident's only move is to contact the office — for a
mistake they could undo themselves in one tap. It is also the natural
companion to the duplicate refusals shipped 2026-10-07: we now tell a
resident "this is already waiting for approval", which is only helpful
if they can act on it.

## Scope

1. **New RPC** — `withdraw_my_pending_vehicle(p_vehicle_id)`, or widen
   `deactivate_my_vehicle`'s allowlist to include `pending`. Prefer a
   **separate RPC**: the two actions mean different things to a PM
   (removing an approved car vs retracting a request), they want
   different reason codes, and a separate function keeps
   `deactivate_my_vehicle`'s guard narrow rather than growing a mode
   flag.
2. **Ownership guard — copy it verbatim, do not re-derive it:**
   - `public.get_my_effective_active()` first, raising
     `account_deactivated` with the existing string + HINT so the
     client matcher needs no change;
   - resident-role check;
   - `lower(trim(v.resident_email)) = lower(trim(auth.jwt()->>'email'))`
     **AND** the caller still an ACTIVE resident at that
     `(property, unit)`. 🔴 Both halves. Email alone lets a moved-out
     resident act on an address that is no longer theirs; residency
     alone is the roommate hole — `update_my_vehicle_cosmetic` scopes by
     unit and would let a roommate retract someone else's request.
   - the no-oracle error (`vehicle not found or not yours`) for
     anything that fails the predicate.
3. **Status guard** — `status = 'pending'` only. 🔴 NOT `is_active =
   false`: that is also true of declined, expired and deactivated rows,
   and conflating them is precisely the bug the interim fix removed.
   `under_review` is excluded too — a plate change in flight would
   leave an orphaned `vehicle_plate_changes` row.
4. **Recorded as resident-withdrawn.** A new code, and it belongs in
   `SYSTEM_DEACTIVATION_REASONS` for the same reason
   `resident_removed` does: a manager must not be able to claim the
   resident retracted a request. 🔴 **And the enforcement is a second
   copy of that list** — `v_system_codes` inside `deactivate_vehicle`.
   Adding a code to the TS list alone leaves the manager path open.
   Both, in one migration.
   Distinct from `resident_removed`: that means "I took my approved car
   off the list"; this means "never mind, don't review this". A PM
   reading the history should see which happened.
5. **Confirm dialog**, matching the Remove-This-Vehicle copy: say what
   happens and that re-submitting means a fresh review. The withdrawal
   itself is reversible only by re-submitting.
6. **PM visibility** — the CRM restore panel already renders
   `deactivation_reason` + `deactivated_by` and, since 2026-10-07,
   falls back to the SYSTEM vocabulary with the `[system] ` prefix
   stripped. A new system code will render correctly with no component
   change. Check the pending-queue count copy: a withdrawn request
   should leave the queue, not linger as a zero-state.

## Billing

None. Permit counting keys on `status='active' AND is_active=true`, so
a pending row was never counted and withdrawing it changes nothing.
There is no `syncOnRemove`; `syncOnAdd` only ratchets up. No sync call.

## Verification when picked up

Extend `verify:residentremove`:
- A withdraws A's own pending request → succeeds, stamped, audited.
- **A cannot withdraw B's pending request at the same unit** — the
  roommate case, with two residents at one unit as the existing gate
  already sets up.
- A cannot withdraw an ACTIVE vehicle through this RPC (that is
  `deactivate_my_vehicle`'s job) — keeps the two actions distinct.
- A manager cannot stamp the new code via `deactivate_vehicle`.
- Positive control: `deactivate_vehicle` still works with a legitimate
  reason, and `deactivate_my_vehicle` still removes an active car.

## Related

- `migrations/20261006_resident_vehicle_removal.sql` — the guard to copy.
- `migrations/20261007_duplicate_plate_handling.sql` — PART 4 is the
  same lying-shortcut class on the manager side; PART 1 is the
  duplicate refusal this feature complements.
- [[feedback_absence_must_not_be_failure_output]] — an `{ok:true}` that
  touched nothing is the inverse: a *presence* that means absence.

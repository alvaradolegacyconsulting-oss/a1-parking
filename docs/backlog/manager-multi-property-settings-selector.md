# Manager settings tab — no property selector for multi-property managers

**Status:** open, deferred. Pre-existing gap inherited by AP-MANAGE-CLIENT.
**Priority:** LOW — cosmetic + visibility gap; RLS enforces scoping correctly regardless.
**Filed:** 2026-07-23 (during AP-MANAGE-CLIENT design)
**Affects:** `app/manager/page.tsx` settings tab — Visitor Pass Quota Exemptions AND Authorized Plates sections.

## The gap

The manager settings tab (`activeTab === 'settings'`) uses `manager.property` (string, singular) as the implicit property context for both:

1. **Visitor Pass Quota Exemptions** (`app/manager/page.tsx:4158-4195`) — `exemptPlates` state, `addExemptPlate`/`removeExemptPlate` handlers (lines 240, 724-738) all operate on the ONE property `manager.property` resolves to.
2. **Authorized Plates** (post AP-MANAGE-CLIENT ship) — same pattern; single implicit property.

**A multi-property manager sees / manages one property's settings; the other property's settings are unreachable via UI.** No error; no signal; just missing.

## Concrete instance

`alvaradolegacyconsulting+forcee@gmail.com` (Test-LEGACY) is assigned to BOTH:
- `Test Legacy Property` (id 138)
- `Test Property for Driver` (id 146)

Whichever property `manager.property` resolves to first is manageable via the settings tab. The other's exemptions + authorizations are visible only via SQL or via a manager account assigned to that specific property.

## Why AP-MANAGE-CLIENT inherits rather than fixes

Mirroring the existing Visitor Pass Quota Exemptions pattern was the correct call — a manager finding two adjacent sections on the same tab behaving differently is worse than one consistent limitation. **But inheriting a gap knowingly and recording it is a different act from inheriting it silently.** This entry is the record.

## Solution shape

**Property selector at the top of the settings tab header**, applied uniformly to BOTH sections that render below it. Options for the selector:
- Segmented control (radio-style) if manager has 2-3 properties
- Dropdown if manager has 4+
- Hidden entirely for single-property managers (99% case; no cost)

Selector state drives:
- `exemptPlates` fetch (currently keyed on `manager.property`)
- `AuthorizedPlatesManager` prop (currently keyed on `manager.property`)

Small refactor of the two existing handlers to accept the selected property as parameter rather than reading from `manager.property`.

## Not fixed now because

- Zero functional impact — RLS enforces correct scoping regardless. A multi-property manager can access the other property's data by asking a CA or by SQL.
- The Test-LEGACY multi-property manager is a probe account (`+forcee`), not a real customer.
- Real customers today (A1) have single-property managers per the tenant inventory.
- Fixing inside AP-MANAGE-CLIENT would balloon its scope and delay the switch that makes the whole arc real.

## Named trigger for pickup

**When a real multi-property manager surfaces** (customer #2+ onboards with a manager assigned to multiple properties AND raises the visibility issue), pick this up as a small standalone commit. The refactor is confined to the settings tab; no schema, no RPC, no other surfaces affected.

Alternative trigger: bundle with the next non-trivial settings-tab UI work (e.g., a new per-property configuration section landing there).

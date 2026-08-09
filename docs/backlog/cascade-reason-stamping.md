# Backlog — cascade-deactivated vehicles carry `deactivation_reason = NULL`

**Filed:** 2026-08-09 (surfaced by deactivation-email arc preflight; separate commit).
**Priority:** LOW. Enum values `cascade_resident_deactivated`, `owner_trim`, `admin_cascade` exist in `app/lib/deactivation-reasons.ts` but nothing writes them. Additive fix — cannot turn a silent cascade into a sending one.

## What surfaced this

The deactivation-email arc's Correction 3 answer traced that `deactivateResidentWrite` writes only `residents` + `audit_logs`. Vehicle cascade happens outside the writer, via `trimDepartedResidentVehicles` and `cascadeVehiclesIfUnitVacant`. Those cascades do direct `.update({ is_active: false })` and **stamp no `deactivation_reason`.** Same class as the 5 other cascade sites documented in [vehicles-status-is_active-divergence.md](vehicles-status-is_active-divergence.md).

Email suppression doesn't need the stamp — the notification hook lives inside the writer, cascade paths bypass the writer, no hook fires. Three-cars-one-email is automatic under that placement.

But the **CRM display** needs the stamp. Deactivated-vehicle rows show `deactivation_reason ?? '(no reason recorded)'`; a cascade-deactivated row therefore reads as "(no reason recorded)" to a manager who wants to distinguish a decision from a cascade — which is the reason the reason field exists.

## The mapping isn't what the enum list implies

`app/lib/deactivation-reasons.ts` has three `SystemReasonCode` values:
- `cascade_resident_deactivated`
- `owner_trim`
- `admin_cascade`

Three cascade paths reach `vehicles.is_active = false` today:

| Path | Site | Likely code |
|---|---|---|
| `trimDepartedResidentVehicles` (B166 owner turnover) | [app/lib/manager-crm-writes.ts:186](../../app/lib/manager-crm-writes.ts#L186) | `owner_trim` |
| `cascadeVehiclesIfUnitVacant` (B150 unit vacancy) | [app/manager/page.tsx:3053](../../app/manager/page.tsx#L3053)-area | **unmapped — no code fits** |
| admin `/admin/page.tsx:481` property cascade | [app/admin/page.tsx:481](../../app/admin/page.tsx#L481)-area | `admin_cascade` |

`cascade_resident_deactivated` reads like it was written for the trim path — but the trim path already has a fitting code (`owner_trim`). So under the current layout: **one enum value is redundant (`cascade_resident_deactivated`), and one path has no matching code (the B150 unit-vacant cascade).**

### Resolve the mapping BEFORE stamping

Before writing any cascade reason, pin one of the two shapes:

**Option A: keep `cascade_resident_deactivated`, retire `owner_trim`, add a B150 code.**
- Trim + unit-vacant cascades both stamp `cascade_resident_deactivated` (unified — "this vehicle was deactivated because the resident left")
- Admin cascade stamps `admin_cascade`
- Retire `owner_trim` from the enum
- Trade-off: loses the "was it turnover vs unit-vacancy?" distinction

**Option B: keep `owner_trim`, retire `cascade_resident_deactivated`, add a B150 code.**
- Trim path stamps `owner_trim`
- Unit-vacant path stamps something new (`cascade_unit_vacated`?)
- Admin cascade stamps `admin_cascade`
- Retire `cascade_resident_deactivated`
- Trade-off: three distinct codes for three distinct cascades — more precise, more to maintain

**Lean: Option A.** The trim vs unit-vacant distinction is B166 vs B150 internal; from a manager's read it's the same cause ("resident deactivation cascaded to their vehicles"). Unifying keeps the CRM copy simple. Retiring `owner_trim` is a small change (three code sites reference it: enum entry, module-load assertion path, whatever consumes the label).

## Scope

Small commit, additive. No trigger changes. No RPC changes. Three files touched:

1. `app/lib/manager-crm-writes.ts` — `trimDepartedResidentVehicles` stamps the picked cascade code in its `.update()` call
2. `app/manager/page.tsx` — `cascadeVehiclesIfUnitVacant` does the same
3. `app/admin/page.tsx` — admin cascade at `:481` stamps `admin_cascade`
4. `app/lib/deactivation-reasons.ts` — enum + label alignment per Option A or B

## Verification when picked up

- Deactivate a resident → their trim-cascaded vehicles carry the picked cascade code, visible in the CRM's deactivated panel
- Deactivate the last resident at a unit → the B150 unit-vacant cascade stamps the picked code
- Admin cascade at a property → cascade-deactivated residents' vehicles stamp `admin_cascade`
- `noAuthorizedBucket` classification is unchanged (the buckets read `status` + `is_active`, not `deactivation_reason`)
- `reasonLabel('vehicle', <code>)` returns the human string for CRM display

## Safe to defer

The writer-only email hook placement means this fix is purely additive — stamping cascade reasons cannot promote a silent cascade to a sending one. The email arc ships first without depending on this backlog item.

## Related

- [vehicles-status-is_active-divergence.md](vehicles-status-is_active-divergence.md) — the 6-site divergence class that this reason gap is a subset of
- Deactivation-email arc preflight (2026-08-09 FOR MATEO thread — Correction 3)
- `app/lib/deactivation-reasons.ts` — enum + assertion definitions

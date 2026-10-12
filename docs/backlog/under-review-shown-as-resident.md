# Managers see "resident" for a vehicle under plate review — low priority

Filed 2026-10-12. Ruled **intentional, no change** (Jose): under-review
vehicles stay protected during plate review. This note is only about the
label a manager sees.

## What happens

`pm_plate_lookup` Branch 1 (resident) tests `v.is_active = TRUE` and does
not test `status`. Two rows satisfy `is_active = TRUE AND status <> 'active'`,
both `under_review`:

| id | plate | property | company | unit | created |
|---|---|---|---|---|---|
| 1301 | 9F7422 | Green Acres | A1 Wrecker llc | 222 | 2026-09-24 |
| 650 | LESLY | Test Legacy Property | Test-LEGACY | 205 | 2026-07-17 |

Both return `result_type = 'resident'`, so a manager's plate lookup shows a
plain authorized resident with nothing indicating a review is open.

**This is the correct enforcement outcome** — `is_active = TRUE` is the
authorization, and the vehicle must not be towed while its plate change is
being reviewed. Only the label is lossy.

🔴 Do not "fix" this by adding `status = 'active'` to Branch 1. That would
flip both rows to unauthorized and make a protected vehicle towable — the
opposite of the intent. Contrast the 19 rows with
`is_active = FALSE AND status = 'active'`, which read as not authorized:
that direction is fail-closed and harmless.

## The change, when ruled

Show **"Under review"** to managers instead of plain "resident", without
changing the enforcement answer. Two ways:

1. A new `result_type` — `resident_under_review`. 🔴 Then
   `app/manager/page.tsx:1281` MUST gain it in the same commit; that
   whitelist degrades any unlisted type to "Unexpected response from
   server." The same audit applies to the CA portal.
2. An additive field on the existing `resident` result (e.g.
   `under_review: true`) that the badge renders as a qualifier. Cheaper,
   and it cannot break the whitelist, because the `result_type` does not
   change.

Option 2 is the lower-risk one and keeps the do-not-tow semantics of
`resident` exactly as they are. `plate_status.ts` already distinguishes
`plate_under_review`, but that status means a pending **`vehicle_plate_changes`
row**, which is a different condition from `vehicles.status = 'under_review'`
— don't conflate them.

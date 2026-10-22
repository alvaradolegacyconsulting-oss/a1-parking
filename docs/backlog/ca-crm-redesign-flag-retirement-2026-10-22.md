# Retire CA_CRM_REDESIGN — its rollback is now one-way, and 11 dead blocks remain

**Filed:** 2026-10-22 · **Owner:** unassigned · **Not blocking**

## Why now

`CA_CRM_REDESIGN` has been `true` in `app/company_admin/page.tsx` since the v4 IA landed. Its
`!CA_CRM_REDESIGN` branches were kept so the redesign could be rolled back without a revert. That
reason no longer holds, and the cost is still being paid.

**The rollback is gone.** Deleting the dead Manage sub-tab bar (1abfbd6) removed the only nav that
could reach `manageSection` values other than the four the v4 nav routes. Flipping the flag to
`false` now yields a Manage tab with no navigation at all — and it was already mostly illusory,
because the v4 top-level nav is itself gated on the flag being *true*. There is no state of this
file in which `false` produces a working portal.

**The cost is three lost features and one false conclusion.** `verify:tdlrcaller` maps **11 dead
blocks** in this one file. Work has landed in them four times:

| | what was lost |
|---|---|
| 2026-09-16 | assign-drivers panel |
| 2026-09-17 | Plate Activity tab |
| 2026-10-13 | a parking-tag field in the sibling `PM_CRM_ENABLED` dead branch |
| 2026-10-22 | the Manage → Company TDLR panel |

The last one cost more than a feature. Because a dead copy of the TDLR field existed, a help-docs
review concluded that company admins **cannot** set their own TDLR licence number, and nearly
published "email support@ to set it" — while the live field sat in Billing → Company info the whole
time. Dead code made a live capability look absent.

## The work

1. Delete every `!CA_CRM_REDESIGN` block in `app/company_admin/page.tsx` (11 ranges; `npm run
   verify:tdlrcaller` prints them).
2. Delete the constant and unwrap the `CA_CRM_REDESIGN &&` guards.
3. Same pass for `PM_CRM_ENABLED` in `app/manager/page.tsx` — same shape, same hazard, one casualty
   already.
4. Then retire `scripts/check-dead-branch-additions.ts`, or re-point `TARGETS` at whatever
   always-on flag exists next. 🔴 Do not leave it pointing at a removed flag: its own guard raises
   when the flag is absent precisely so it cannot silently stop checking.

## Care required

- Several dead blocks are **near-duplicates** of live ones. Diff each against its live sibling
  before deleting, because a few carry parallel maintenance that was correctly applied to both —
  the 2026-09-17 audit found five such commits and every one was right.
- `npx tsc --noEmit` and `npm run build` both pass with dead JSX present, so neither will tell you
  whether you deleted the right copy. The gates will.

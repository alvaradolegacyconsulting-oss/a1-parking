# `!CA_CRM_REDESIGN` is ~1,150 lines of dead code that reads as live code

**Two features lost in it in two days.** Filed 2026-09-17.

## The measurement

`CA_CRM_REDESIGN = true` at `app/company_admin/page.tsx:73`. Twelve
`!CA_CRM_REDESIGN` blocks:

```
line 4504  ~21      line 4756  ~69      line 7787  ~304
line 4548  ~15      line 4828  ~30      line 8098  ~237
line 4573   ~8      line 6441  ~29      line 9164  ~201
line 4582   ~6      line 7037  ~222
line 4591  ~12
                    total ~1,154 of 9,785 lines — ~11% of the file
```

58 references to the flag in one file.

## Why it keeps catching things

**Every dead block is a near-duplicate of a live one.** Same component
names, same labels, same handlers, same markup. Searching for
`showAddProperty`, `tab('qrcodes')` or a field list returns hits in both,
and nothing in the surrounding lines says which one renders. The nearest
enclosing conditional can be 50+ lines above the match.

So the natural workflow — grep for a nearby landmark, insert next to it —
has roughly even odds of landing in code that will never execute. And it
fails **silently**: `tsc` passes, the build passes, the deploy succeeds,
and the feature is simply absent.

## What it has cost

- **2026-09-16** — the assign-drivers panel was inlined after the
  `showAddProperty` block in the `!CA_CRM_REDESIGN` properties section.
  Jose added three properties to a company with two active drivers and saw
  no step. Diagnosis started on the drivers query, the company filter and
  `is_active` — all fine. Nothing was wrong downstream of a component that
  never mounted.
- **2026-09-17** — the Plate Activity tab button was added next to
  `tab('qrcodes')`, which lives in the legacy nav at line 4756. Deployed,
  confirmed live, signed in as a real `company_admin` — no tab. Same
  failure, one day later, **after I had said I checked the branch**. I had
  checked it for the Ask 1 field list (correctly, a different structure)
  and carried the conclusion across.

## Options

**1. Delete it.** The flag has been `true` long enough that the legacy
path is not a rollback anyone would take — a revert would restore a UI
that predates months of work in the live branch. Removing ~1,150 lines and
58 conditionals is a large diff but a mechanical one, and it is the only
option that makes the failure impossible rather than less likely.

**2. Mark it unmissably.** A banner comment at the top of every
`!CA_CRM_REDESIGN` block: `DEAD WHILE CA_CRM_REDESIGN=true — code added
here will never render.` Cheap, no behaviour change, and it puts the
warning where the grep hit lands rather than 50 lines above it.

**3. Leave it.** It will catch a third thing.

⚠ Whichever is chosen, the durable fix for new work is the shape already
used by the drivers panel: **a render function called from both branches.**
A flag flip cannot drop it, and there is no second copy to drift.

## What was done 2026-09-17

**Option 2, plus a guard that does not rely on anyone reading anything.**

- **12 banner markers**, one immediately before each `{!CA_CRM_REDESIGN &&` opener.
- **`scripts/check-dead-branch-additions.ts`** — run it before committing, or pass a sha. Exit 1 if additions land in a dead block.

⚠ **Markers deeper inside each block are NOT POSSIBLE.** The first attempt inserted one every ~40 lines and **broke the build**: JSX comments are only valid at *child* positions, and these blocks contain arrow-function bodies and expression contexts where one breaks the parse. Reverted. So the banner really is 50+ lines from where a grep hit lands — which is precisely why the script exists and the comment alone was never going to be enough.

Self-tested against both known failures:

```
7e03abec (assign-drivers panel)  → 🔴 86 of 165 added lines dead
ff0458a  (Plate Activity button) → 🔴  7 of  93 added lines dead
c2acec6  (the fix)               → ✅ 0 dead
```

🔴 **A hit is not automatically wrong.** Parallel maintenance — the same change applied to both branches — is correct and common. The audit found five such commits and every one was right. The failure mode is an addition landing **only** in the dead branch, so the script prints both counts rather than a verdict.

## Recommendation

**Deletion when there is an appetite for the diff.** The marker costs
minutes and stops the bleeding; the deletion is the real answer but wants
its own commit and its own smoke, because ~11% of a 9,785-line file is not
a change to make alongside a feature.

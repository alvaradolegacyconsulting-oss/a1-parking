# B113's "Bulk Upload →" link renders nowhere

Found 2026-10-15 while mounting the Phase A resident-upload entry point.

`app/company_admin/page.tsx:4985` gates the link on
`hasFeature(FEATURE_FLAGS.BULK_UPLOAD, …)` — correctly — but it sits
inside the `{!CA_CRM_REDESIGN && (` legacy nav, and `CA_CRM_REDESIGN`
is `true`. So the button never renders. It is the only link to
`/company_admin/bulk-upload` in the codebase: grep finds exactly one
other hit, a comment.

The live nav says so, in as many words:

> QR Codes / Plan / Bulk Upload / Plate Lookup omitted from new nav
> (their functions re-homed elsewhere or standalone).

So this may be intentional — but "omitted from the nav" and "reachable
only by typing the URL" are different outcomes, and the tier gate still
being written against it suggests the latter was not the intent. Three
features have now been lost to this branch (assign-drivers 09-16, Plate
Activity 09-17, and this).

## What to decide

1. **Is `/company_admin/bulk-upload` meant to be reachable from the
   UI?** If yes, the button moves into the `CA_CRM_REDESIGN` nav, next
   to the Resident Upload link added today. If no, the dead copy should
   be deleted so the next reader does not take it for a live feature.
2. Either way the page itself stays — it is tier-gated at mount and
   works when reached.

## Not in scope here

Phase A deliberately did not touch it. Its own entry point went into
the live nav and is asserted by
`npx tsx scripts/check-dead-branch-additions.ts`.

## Checking it

```
grep -n "bulk-upload" app/company_admin/page.tsx
npx tsx scripts/check-dead-branch-additions.ts
```

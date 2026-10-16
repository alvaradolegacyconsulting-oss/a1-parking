# Bulk resident and vehicle upload — instructions

<!--
AUDIENCE: the customer's property-management staff (A1), not ShieldMyLot.
Reviewed and approved by Jose, 2026-10-14. Changes to this wording need
his sign-off: the first paragraph in particular is a liability boundary,
not copy — accuracy sits with the customer under the SaaS Agreement, and
an earlier draft implying ShieldMyLot vouched for the data was rejected
for exactly that reason.

🔴 THE COPY MOVED, AND THIS FILE IS NO LONGER THE SOURCE — 2026-10-16.
It was approved on 2026-10-14 and then never shipped: nothing in app/
read, linked or rendered it, so no customer could reach a word of it.
It now lives in app/lib/bulk-instructions.ts, which the upload page and
/company_admin/resident-upload/instructions both render. Editing a
second copy here would only let the two drift, with the unshipped one
looking authoritative. Edit the module; this file is a pointer.
-->

**The approved copy now ships from
[`app/lib/bulk-instructions.ts`](../../app/lib/bulk-instructions.ts).**

- `INSTRUCTIONS` — the full instructions, rendered at
  `/company_admin/resident-upload/instructions`
- `BEFORE_YOU_UPLOAD` — the eight-bullet checklist in step 2 of
  `/company_admin/resident-upload`

The CSV header is not written out in either place: both print
`BULK_CSV_HEADER` from `app/lib/bulk-onboarding.ts`, which is also what
the submission route demands and what `docs/bulk-onboarding/template.csv`
must carry (asserted by `npm run verify:bulkbucket`).

`VALIDATION-RULES.md` in this folder is the rule-by-rule reference and is
still authored here.

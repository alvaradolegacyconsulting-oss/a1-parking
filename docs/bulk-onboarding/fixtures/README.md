# Alden Park rehearsal fixtures

Built 2026-10-14 by the architect from A1's real Alden Park Kingsland
export (249 resident profiles, 360 vehicles), converted into the
ShieldMyLot template.

🔴 **The raw export is never committed.** These are the anonymized
derivative, and they are the only copy that enters the repo.

## What was anonymized, and what was deliberately kept

**Replaced:** every name, email, phone and plate.

- names are deterministic fakes;
- emails are `residentNNN@example.com`, with corporate-housing units as
  `units+demo{unit}@corp-housing.example` to keep the Landing shape;
- phones are `(555) 01x-xxxx`;
- plates are scrambled keeping length, letter/digit positions and the
  TMP prefix/suffix — **a real duplicate stays a duplicate**, which is
  what makes row 322/355 a real test.

**Kept as-is:** units, make and model, and the one-row-per-vehicle
grouping. The units carry the real format defects and the make/model
fields carry the real typos — that is the entire value of the fixture.
A sanitized fixture would have proven the validator against data no
customer will ever send.

Residents were joined to vehicles by unit + name overlap, which is the
join A1 has to do themselves. Pending residents are excluded.

## `alden_fixture_clean.csv` — what a correct file looks like

358 rows, 228 residents. **Validates clean.**

It is DERIVED from the dirty file by `derive-clean.ts`, which applies
exactly the documented fixes and then asserts 358 rows / 228 residents.
The pair therefore cannot drift, and every difference between them is
accounted for in one place.

Unit `6` — really 6310, with building and unit swapped in A1's system —
is still in there. **The validator cannot catch that, by design.** It is
a well-formed unit that happens to be wrong, and it is the reason
accuracy is A1's attestation rather than our check.

## `alden_fixture_dirty.csv` — realistic mistakes

Row numbers are the customer's: header is row 1.

| row | defect | expected |
|---|---|---|
| 7 | `Apt 1104` | ❌ unit noise word — names the fix |
| 11 | blank email | ❌ email required |
| 79, 167, 204 | `Texas` | ❌ names the code: "TX, not Texas" |
| 133 | plate `HMD` | ❌ minimum 5 alphanumerics |
| 322, 355 | same plate on units 9313 and 10301 | ❌ **both** rows flagged, each naming the other |
| 328, 329 | `#7201`, `#1105` | ✅ pass — `#` is stripped by the comparison key anyway |
| 360, 361 | `3-3302` | ✅ pass — key `33302`. A semantic error only A1 can know about, so it falls under the attestation. |

**Exactly 8 error rows. Any other row flagged is a false positive**, and
`npm run rehearse:bulk` reports it as one by name.

## Running it

```
npx tsx docs/bulk-onboarding/fixtures/derive-clean.ts   # rebuild + check counts
npm run rehearse:bulk                                   # both files through the real validator
```

The rehearsal runs what the preview route runs — `parseBulkCsv`, then
`bulk_validate_rows` with a real company_admin JWT, then
`validateBulkRows` + `dbFlagErrors`. It enables the flag for
Test-LEGACY and restores it, verified.

It reports database-side errors (plate already active, resident already
on file) **separately** from file errors, because those depend on
whatever the test property happens to hold and are not a validator
fault — but they must be visible rather than folded into a count.

# Validator rules — the build spec behind the instructions

Internal. The customer-facing wording is `INSTRUCTIONS.md`; this is what
the validator actually enforces, and why.

## Allowed transforms — only these three

Everything else is an **error, not a correction**. "Reject, never fix" is
the ruling: a file we silently repaired is a file whose accuracy nobody
owns.

| transform | scope |
|---|---|
| trim leading/trailing whitespace | every field |
| uppercase the plate | plate only |
| strip ONE leading `'` | unit only — spreadsheet text-forcing |

🔴 **No unit normalization and no merging.** `Apt 1150` is an error, not a
row to be turned into `1150`.

### 🔴 The unit rule was narrowed after being measured

The spec first said a unit must already equal `normalizeUnit()`'s
output. Checked against the **423 resident units in production**, that
rule rejects **90 of them (21%)** — including `B-1`, `Trlr 129`,
`Traila 80` and `#197`, all of which the product stores and matches
perfectly well. `normalizeUnit` is a **comparison key, not a storage
format**; `app/lib/plate.ts` says so in as many words ("NOT for display
and NOT for storage"). The template must not be stricter than the
product — the same reason paper tags are accepted.

What actually breaks matching is a leading noise word:

| stored | comparison key | a manager typing `1150` / `197` |
|---|---|---|
| `#197` | `197` | ✅ matches — `#` is stripped by the key anyway |
| `B-1` | `B1` | ✅ matches `B1` or `B-1` |
| `Trlr 129` | `TRLR129` | a real designation at a mobile-home park, kept |
| `Apt 1150` | `APT1150` | ❌ matches nothing anyone will type |

So the rule is: **reject a unit when removing a leading noise word
would change its comparison key.** That rejects **37 of 423 (9%)**, and
for all 37 the key genuinely does break. `Trlr`, `Traila` and `Unidad`
are deliberately not noise — A1 serves mobile-home parks and those read
as designations, not prefixes.

## Checks

| check | rule | why |
|---|---|---|
| required fields | unit, first_name, last_name, email, plate, plate_state | phone, make, model, color, tag_number optional |
| email format | `findBlockedEmailChar` (`app/lib/email-guard.ts`) | the same guard the bulk-invite path already uses |
| email present | **required on every row** | without one the resident can never claim a login |
| unit shape | reject only a leading **noise word** (`Apt`, `Apartment`, `Unit`, `Ste`, `Suite`, `No.`, `Num.`, and the Spanish `Apartamento`) — see below | the strict rule was measured and withdrawn |
| plate length | **≥ 5 alphanumerics** after normalization | production holds vanity plates `LESLY`, `TWICE`, `1XYFR` at 5; a 6-minimum would reject 7 live rows |
| plate pattern | **none**, and no maximum | `DLR67841` (dealer), `339P9T` (motorcycle), `8MCX006` (out-of-state) are all valid and no one regex covers them |
| paper tags | **accepted** | production already holds 12 `TMP…` plates; the template must not be stricter than the product |
| plate_state | US 50 + DC | ruled 2026-10-14; **not** MX, Canada or territories, because the product's own forms accept neither |
| duplicate plate in file | error | |
| plate active at this property | error | same predicate as `vehicles_plate_norm_uniq` |
| plate active at ANOTHER property | error | 0 such rows exist today, so one in a file is new |
| plate prohibited | error | `vehicles_check_plate_prohibition` is BEFORE INSERT and would abort the load mid-batch |
| resident already exists (email + property) | error | no merging into existing rows in v1 |
| grouping | rows sharing email + unit become one resident with N vehicles | multi-car support |
| conflicting identity | same email + unit with a different name → error | Alden Park 6206 (`Lawrence` vs `Lawrence Robert`) |
| two emails in one unit | **allowed — two residents** | Alden Park 3302 and 6113 are real households |
| make / model / color | presence and length only | "Hundai", "Xfinity G37", a year in the make field all pass; rejecting cosmetics would stall every file |

## 🔴 Plate normalization must be the DATABASE function

The validator calls **`public.normalize_plate()`**, not a TypeScript copy.

Both normalizers strip every non-alphanumeric:

- client: `value.replace(/[^A-Z0-9]/gi,'').toUpperCase()`
- SQL: `upper(regexp_replace(coalesce(p,''),'[^A-Za-z0-9]','','g'))`

The SQL one was aligned to the client on 2026-10-07 because the older
whitespace-only form was "the lone outlier among five normalizers" and
let `ABC-123` and `ABC123` both be active at one property.
`vehicles_plate_norm_uniq` is an **expression index over that function**,
and the function's own comment warns that changing its body requires a
REINDEX. A TypeScript copy would drift from the index the moment either
changed — and predicting what that index will do is the validator's whole
job.

So `ABC 1234`, `ABC-1234` and `ABC1234` are accepted and **collide with
each other**.

## File format

CSV, UTF-8, one property per file, **max 1,000 data rows**.

The ceiling is the one-transaction loader: 1,000 inserts each firing the
audit trigger, the prohibition trigger and the activation guard. At the
~1–3 ms per row expected inside a single transaction that is 1–3 s,
inside the statement timeout; 2,000 would be close to it. Alden Park is
360 rows and the largest expected property ~600, so 1,000 is headroom
with margin. **To be measured against the real fixture in Phase B.**

## Error file

Row numbers match the spreadsheet **as the customer sees it**: header is
row 1, the first data row is row 2.

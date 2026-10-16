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

### 🔴 The unit rule was narrowed twice, and the second narrowing matters most

**First narrowing.** The spec originally said a unit must already equal
`normalizeUnit()`'s output. Checked against the resident units in
production, that rule rejected **21%** of them — including `B-1`,
`Trlr 129`, `Traila 80` and `#197`, all of which the product stores and
matches perfectly well. `normalizeUnit` is a **comparison key, not a
storage format**; `app/lib/plate.ts` says so in as many words ("NOT for
display and NOT for storage"). The template must not be stricter than
the product — the same reason paper tags are accepted.

What actually breaks matching is a leading noise word:

| stored | comparison key | a manager typing `1150` / `197` |
|---|---|---|
| `#197` | `197` | ✅ matches — `#` is stripped by the key anyway |
| `B-1` | `B1` | ✅ matches `B1` or `B-1` |
| `Trlr 129` | `TRLR129` | a real designation at a mobile-home park, kept |
| `Apt 1150` | `APT1150` | ❌ matches nothing anyone will type |

### 🔴 A NOISE WORD IS A PREFIX, NOT A SUBSTRING — the boundary condition

**Do not implement the rule as "reject a unit when removing a leading
noise word would change its comparison key."** That is how this spec
read until 2026-10-16, and it is wrong in a way that reaches customers:
`no`, `ste` and `num` match inside ordinary words, so the validator
rejected real unit and building names and told the customer to rewrite
them as debris.

| unit | the old rule's advice | correct |
|---|---|---|
| `North Tower 3` | *"write it plainly: rth Tower 3"* | 🔴 **must not be rejected** |
| `Nogales 5` | *"write it plainly: gales 5"* | must not be rejected |
| `Stevens 4` · `Steele 9` | *"vens 4"* · *"ele 9"* | must not be rejected |
| `Normandy 1` · `Nova 12` | *"rmandy 1"* · *"va 12"* | must not be rejected |
| `Apto 1116` | *"write it plainly: o 1116"* | reject, advising `1116` |

Production carried `Apto 1116` and `Apto 1003 unidad 1`, and both were
rejected with severed advice. So the rule has a **boundary condition**,
and it differs by language:

- **English forms** (`Apt`, `Apt.`, `Appt`, `Apartment(s)`,
  `Apartamento(s)`, `Unit(s)`, `Ste`, `Suite(s)`, `Number(s)`, `Num.`,
  `No.`) — the noise word must be followed by a **separator
  (`[\s.#-]`) or a digit**. That keeps `Apt1150` and `No. 12` and
  `Unit B`, and releases `North Tower 3`.
- **Spanish forms** (`Apto`, `Aptos`, `Depto`, `Dpto`) — the noise word
  must be followed by a **digit**, after any separators. A separator is
  not enough to tell `Apto 1116` from `Aptos Village 3`: both are a
  noise word and a space. What distinguishes them is that a real prefix
  is followed by a unit designator, and after a place name comes a
  word.

The expression is `UNIT_NOISE` in `app/lib/bulk-validator.ts`; read it
there rather than restating it here. Both fixture lists — must-reject
and must-not-reject, with the plain unit each rejection must name —
live in `unitPrefixChecks()` in `scripts/verify-bulk-validate.ts`, which
also holds the rule to the live `residents.unit` values.

As of **2026-10-16** the rule rejects **37 of 427** live units, and for
all 37 the comparison key genuinely does break. `Trlr`, `Traila` and
`Unidad` are deliberately not noise — A1 serves mobile-home parks and
those read as designations, not prefixes.

## Checks

| check | rule | why |
|---|---|---|
| required fields | unit, email, plate, plate_state, **and at least one of first_name / last_name** | phone, make, model, color, tag_number optional |
| name pair | 🔴 `first_name` and `last_name` are a PAIR rule, not two field rules: either alone is fine, neither is `name_required` on `last_name`. Requiring both rejected a shape the Alden file contains and that real tenancies produce — a mononym, a business name on the lease, a resident whose given name nobody recorded. The error points at `last_name` because that is where the instructions tell the customer to put a single name. | ruled 2026-10-16 |
| what is stored | 🔴 `residents` has a SINGLE `name` column — there is no first/last in the database. The loader concatenates and trims, so `('Alex','')` → `'Alex'` and `('','Draper')` → `'Draper'`, with no double space (measured: 0 stray spaces across 228 loaded rows). Blank stores as blank; **nothing writes `TBD`** and nothing should — measured 0 of 654 residents contain it, and a placeholder in a name column is a value somebody later has to recognise as not a name. | |
| email format | **two checks, not one.** `guardEmail()` (`app/lib/email-guard.ts`) — which wraps `findBlockedEmailChar` — and then a shape check, `^[^@\s]+@[^@\s]+\.[^@\s]{2,}$`. The guard rejects characters that break downstream handling; the shape check rejects `jane.doe` and `jane@example` | the guard is the same one the bulk-invite path uses; the shape check is the validator's own, because a row whose email cannot receive an invite can never be claimed |
| email present | **required on every row** | without one the resident can never claim a login |
| unit shape | reject only a leading **noise word**, and only where the **boundary condition** below holds. The list is `UNIT_NOISE` in `app/lib/bulk-validator.ts`: `Apt`, `Apt.`, `Appt`, `Apartment(s)`, `Apartamento(s)`, `Unit(s)`, `Ste`, `Suite(s)`, **`Number(s)`**, `Num.`, `No.`, and the Spanish **`Apto`/`Aptos`**, **`Depto`/`Dpto`** | the strict rule was measured and withdrawn; the boundary condition was added 2026-10-16 after it rejected `North Tower 3` |
| plate length | **≥ `MIN_PLATE` alphanumerics** after normalization (`app/lib/bulk-validator.ts`, currently 5) | production holds vanity plates `LESLY`, `TWICE`, `1XYFR` at 5; a 6-minimum would reject 7 live rows |
| plate pattern | **none**, and no maximum | `DLR67841` (dealer), `339P9T` (motorcycle), `8MCX006` (out-of-state) are all valid and no one regex covers them |
| paper tags | **accepted** | production already holds 12 `TMP…` plates; the template must not be stricter than the product |
| plate_state | exactly the codes in `PLATE_STATES` (`app/lib/us-states.ts`): the 50 states, `DC`, and **`MX`** | MX added 2026-10-16. A1 is in Texas and Mexican plates park in these lots; before that the product could not record one anywhere, so the copy could not honestly say what to do with the car. **Still not** Canadian provinces or US territories. The reason is the same one as always — the template matches what the product's own forms accept, and they now offer MX, labelled "Mexico (MX)" |
| duplicate plate in file | error | |
| plate active at this property | error | same predicate as `vehicles_plate_norm_uniq` |
| plate active at ANOTHER property | error — and the scope is **the caller's own company's other properties only**, never another tenant's | the RPC's `siblings` CTE selects properties whose `company` matches the caller's; a plate active at a different tenant's property is invisible here and must stay so. The error names which sibling property holds it, because the fix is a decision only the customer can make |
| plate prohibited | error | `vehicles_check_plate_prohibition` is BEFORE INSERT and would abort the load mid-batch |
| resident already exists (email + property) | error, split into exists-**active** ("remove the row") and exists-**deactivated** ("reactivate them instead") | no merging into existing rows in v1; the two are different situations for the customer |
| 🔴 how property is keyed | **by `property` NAME (text), not `property_id`.** Every predicate above compares `v.property = <the property's name>` / `rr.property = <name>`, and the match is the text | this is the known text-keyed fragility: two properties sharing a name, or a rename between submit and load, change what these checks see. Stated here so nobody reads "at this property" as an id comparison. See the `FK property_id` migration note |
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

CSV, UTF-8, one property per file, **max `MAX_BULK_ROWS` data rows**
(`app/lib/bulk-onboarding.ts`, currently 1,000). The customer-facing
copy prints the same constant; `npm run verify:bulkbucket` asserts the
two agree and that no second figure appears anywhere in the copy.

The ceiling is the one-transaction loader: 1,000 inserts each firing the
audit trigger, the prohibition trigger and the activation guard. At the
~1–3 ms per row expected inside a single transaction that is 1–3 s,
inside the statement timeout; 2,000 would be close to it. Alden Park is
360 rows and the largest expected property ~600, so 1,000 is headroom
with margin. **To be measured against the real fixture in Phase B.**

## Error file

Row numbers match the spreadsheet **as the customer sees it**: header is
row 1, the first data row is row 2.

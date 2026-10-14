# Bulk resident and vehicle upload — instructions

<!--
AUDIENCE: the customer's property-management staff (A1), not ShieldMyLot.
Reviewed and approved by Jose, 2026-10-14. Changes to this wording need
his sign-off: the first paragraph in particular is a liability boundary,
not copy — accuracy sits with the customer under the SaaS Agreement, and
an earlier draft implying ShieldMyLot vouched for the data was rejected
for exactly that reason.
-->

**Before you start.** This file creates real parking records that will be
used for enforcement. **You are responsible for the accuracy of this data
and for having the property's authorization to submit it.** When you
upload, you'll be asked to confirm that. ShieldMyLot checks the file's
format and releases the load. We do not verify the accuracy of your data.

**One row per vehicle.** A resident with three cars gets three rows with
the same unit and the same email. First and last name are the resident
the vehicle is registered under (the leaseholder whose email is on the
row), not the person who drives it. Rows with the same email and unit are
grouped as one resident, so they must carry the same name. If two
leaseholders in one unit each want their own login, give each their own
email and their own rows.

**Residents without a vehicle are not included in this file.** They can
sign up themselves using the property's QR code.

**Every row needs:** unit, first name, last name, email, plate, plate
state. **Phone is optional.**

**Email is required on every row.** It is how the resident later sets up
their own login. A row without an email cannot be loaded. If you don't
hold an email for a unit, get one before including it.

**Plate state is required and we do not guess it.** Write the two-letter
state code (`TX`, not `Texas`). US states and DC are accepted.

**Write the plate exactly as it appears. Spaces and dashes are ignored** —
`ABC-1234` and `ABC 1234` are both read as `ABC1234`. At least five
letters or numbers. Temporary paper tags are fine. Specialty, motorcycle
and out-of-state plates are fine.

**Units must be written plainly.** `1150`, not `Apt 1150` or
`Unit 1150` — a unit with "Apt" or "Unit" written in front of it will not
match what your managers search for. `#1150`, `B-1`, `Trlr 129` and
`Traila 80` are all fine. If your spreadsheet shows `'1150` with a
leading quote that is fine too — we remove it.

**Only approved residents.** Leave out anyone still pending approval in
your current system.

**Make, model and color** are for recognizing the car. We don't check
spelling.

**Parking tag number** is optional, and only used if your property has
parking tags switched on.

**Save the file as CSV (UTF-8).** One property per file, up to 1,000 rows.
The first row must be the header exactly as in the template.

```
unit,first_name,last_name,email,phone,plate,plate_state,make,model,color,tag_number
101,Jane,Doe,jane.doe@example.com,,ABC1234,TX,Toyota,Camry,Silver,
```

**Coming from another system?** Export from it and map your columns onto
ours. **ShieldMyLot does not map, convert or prepare files** — accuracy
stays with you.

**Corporate / furnished-rental units.** Where the email on file belongs to
the leasing company rather than the occupant (for example a
`hellolanding.com` address), the login-setup email goes to that company,
not the person in the unit. That is expected; just be aware of it.

**What happens next.** We check the file and return a list of errors by
row number. Row numbers in the error list match the row numbers in your
spreadsheet. Nothing loads until it is clean. You fix your file and upload
again.

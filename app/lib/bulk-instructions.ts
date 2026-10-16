// ════════════════════════════════════════════════════════════════════
// The customer-facing copy for the resident upload
// ════════════════════════════════════════════════════════════════════
//
// AUDIENCE: the customer's property-management staff, not ShieldMyLot.
//
// 🔴 THIS COPY IS APPROVED, NOT DRAFTED HERE. The paragraphs below are
// the version Jose approved on 2026-10-14. Changes need his sign-off —
// the opening paragraph in particular is a liability boundary, not
// copy: accuracy sits with the customer under the SaaS Agreement, and
// an earlier draft implying ShieldMyLot vouched for the data was
// rejected for exactly that reason.
//
// 🔴 NO VENDOR NAMES IN HERE — ruled 2026-10-16. An earlier bullet read
// "your ParkingSnap export does not include it". Naming a competitor in
// our own onboarding copy dates the sentence, is wrong for every
// customer who came from something else or from a spreadsheet, and
// reads as though we integrate with them. The wording says what the
// data must contain, not where it came from. verify:novendornames
// holds this file, the page and the template to it.
//
// 🔴 AND IT HAD NEVER SHIPPED. It lived in docs/bulk-onboarding/
// INSTRUCTIONS.md, which nothing in app/ read, linked or rendered — a
// customer could not reach a word of it. That is why the source now
// lives here, beside the page that renders it, and the docs file points
// at this module instead of holding a second copy that can drift.

export interface InstructionPara {
  /** The bolded lead-in. */
  lead: string
  /** The rest of the paragraph. Empty when the lead says all of it. */
  text: string
}

/**
 * The short list on the upload page itself, step 2.
 *
 * 🔴 EIGHT BULLETS IS THE CEILING, NOT A TARGET. A checklist nobody
 * finishes reading is the same as no checklist. Everything that needs a
 * paragraph belongs in the full instructions, which this links to.
 */
export const BEFORE_YOU_UPLOAD: readonly string[] = [
  'Save as CSV (UTF-8). One property per file, up to 1,000 rows.',
  'Approved residents only — leave out anyone still pending in your current system.',
  'Residents without a vehicle are not in this file. They sign themselves up with the property QR code.',
  'One row per vehicle. A resident with three cars gets three rows carrying the same unit, name and email.',
  "Plate state is required, written as the two-letter code (TX, not Texas). If your data doesn't include it, add it — most plates will be TX. Check out-of-state cars.",
  'One error rejects the whole file. The row numbers we return match the row numbers in your spreadsheet.',
  'You confirm the data is accurate and that you are authorized to submit it. We check the format, not the facts.',
  'Nobody is emailed when the file loads. Residents set up their own login afterwards, from the flyer or QR code.',
]

/** The full instructions, as approved. */
export const INSTRUCTIONS: readonly InstructionPara[] = [
  { lead: 'Before you start.',
    text: "This file creates real parking records that will be used for enforcement. You are responsible for the accuracy of this data and for having the property's authorization to submit it. When you upload, you'll be asked to confirm that. ShieldMyLot checks the file's format and releases the load. We do not verify the accuracy of your data." },
  { lead: 'One row per vehicle.',
    text: 'A resident with three cars gets three rows with the same unit and the same email. The name is the resident the vehicle is registered under (the leaseholder whose email is on the row), not the person who drives it. Rows with the same email and unit are grouped as one resident, so they must carry the same name. If two leaseholders in one unit each want their own login, give each their own email and their own rows.' },
  { lead: 'Residents without a vehicle are not included in this file.',
    text: "They can sign up themselves using the property's QR code." },
  { lead: 'Every row needs: unit, a name, email, plate, plate state.',
    text: 'Phone is optional.' },
  { lead: 'One name is enough.',
    text: 'You need either first name or last name — not both. If you only have one name, put it in last name and leave first name blank. We store what you give us and show a dash where there is nothing, and the resident can fill in the rest themselves once they have a login. A row with neither name is the only one we send back.' },
  { lead: 'Email is required on every row.',
    text: "It is how the resident later sets up their own login. A row without an email cannot be loaded. If you don't hold an email for a unit, get one before including it." },
  { lead: 'Plate state is required and we do not guess it.',
    text: 'Write the two-letter state code (TX, not Texas). US states and DC are accepted.' },
  { lead: 'Write the plate exactly as it appears. Spaces and dashes are ignored.',
    text: 'ABC-1234 and ABC 1234 are both read as ABC1234. At least five letters or numbers. Temporary paper tags are fine. Specialty, motorcycle and out-of-state plates are fine.' },
  { lead: 'Units must be written plainly.',
    text: '1150, not Apt 1150 or Unit 1150 — a unit with "Apt" or "Unit" written in front of it will not match what your managers search for. #1150, B-1, Trlr 129 and Traila 80 are all fine. If your spreadsheet shows ‘1150 with a leading quote that is fine too — we remove it.' },
  { lead: 'Only approved residents.',
    text: 'Leave out anyone still pending approval in your current system.' },
  { lead: 'Make, model and color',
    text: "are for recognizing the car. We don't check spelling." },
  { lead: 'Parking tag number',
    text: 'is optional, and only used if your property has parking tags switched on.' },
  { lead: 'Save the file as CSV (UTF-8).',
    text: 'One property per file, up to 1,000 rows. The first row must be the header exactly as in the template.' },
  { lead: 'Coming from another system or a spreadsheet?',
    text: 'Export your approved residents and their vehicles, then arrange them into the template columns. Entering by hand? Type straight into the template, one row per vehicle. ShieldMyLot does not map, convert or prepare files — accuracy stays with you.' },
  { lead: 'Corporate / furnished-rental units.',
    text: 'Where the email on file belongs to the leasing company rather than the occupant (for example a hellolanding.com address), the login-setup email goes to that company, not the person in the unit. That is expected; just be aware of it.' },
  { lead: 'What happens next.',
    text: 'We check the file and return a list of errors by row number. Row numbers in the error list match the row numbers in your spreadsheet. Nothing loads until it is clean. You fix your file and upload again.' },
]

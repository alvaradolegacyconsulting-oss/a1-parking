// Phase A — the bulk-onboarding validator's pure half.
//
// 🔴 NOTHING HERE NORMALIZES A PLATE. The comparison key comes from
// public.normalize_plate() via bulk_validate_rows, and is handed in as
// plateNorm. vehicles_plate_norm_uniq is an expression index over that
// function, and predicting that index is this validator's entire job —
// a second implementation of the key would predict the wrong thing the
// moment either side moved.
//
// Row numbers are the customer's: header is row 1, so the first data
// row is row 2. An error list whose numbers do not match the
// spreadsheet is an error list nobody can act on.

import { BULK_CSV_COLUMNS } from './bulk-onboarding'
import { guardEmail } from './email-guard'
import { normalizeUnit } from './plate'
import { isKnownPlateState, PLATE_STATES } from './us-states'

export interface BulkRowInput {
  /** 0-based index into the data rows. The customer sees index + 2. */
  index: number
  unit: string
  first_name: string
  last_name: string
  email: string
  phone: string
  plate: string
  plate_state: string
  make: string
  model: string
  color: string
  tag_number: string
  /** From public.normalize_plate(), via the RPC. Never computed here. */
  plateNorm: string
}

export interface BulkError {
  /** The spreadsheet row number: header = 1, first data row = 2. */
  row: number
  column: string
  code: string
  message: string
}

/**
 * 🔴 UNIT PREFIX NOISE — the one check that was narrowed after being
 * measured, and the reason is worth keeping next to the regex.
 *
 * The spec first said a unit must already equal normalizeUnit()'s
 * output. Against the 423 resident units in production that rejects 90
 * of them (21%), including B-1, Trlr 129, Traila 80 and #197 — values
 * the product stores and matches perfectly well, because normalizeUnit
 * is a COMPARISON KEY and not a storage format (app/lib/plate.ts says
 * so explicitly). The template must not be stricter than the product.
 *
 * What actually breaks is a leading noise word. normalizeUnit('#197')
 * is '197' and matches a manager typing 197, because '#' is stripped
 * by the key anyway. normalizeUnit('Apt 1150') is 'APT1150' and
 * matches nothing a manager will ever type. So the rule is: reject a
 * unit when removing a leading noise word would CHANGE its comparison
 * key. That rejects 37 of 423 (9%), and for all 37 the key really does
 * break.
 *
 * 'Trlr', 'Traila' and 'Unidad' are deliberately NOT noise: A1 serves
 * mobile-home parks and those read as real designations, not prefixes.
 */
const UNIT_NOISE =
  /^\s*(apts?|apt\.|appt\.?|apartments?|apartamentos?|units?|ste\.?|suites?|no\.?|num\.?)\s*[\s.#-]*\s*(?=[A-Za-z0-9])/i

const MAX_NAME = 80
const MAX_DESC = 60
const MAX_TAG = 40
const MIN_PLATE = 5

/** The four columns a row cannot be missing beyond the obvious ones. */
const REQUIRED: (keyof BulkRowInput)[] = ['unit', 'first_name', 'last_name', 'email', 'plate', 'plate_state']

export function validateBulkRows(rows: BulkRowInput[]): BulkError[] {
  const errors: BulkError[] = []
  const add = (r: BulkRowInput, column: string, code: string, message: string) =>
    errors.push({ row: r.index + 2, column, code, message })

  // ── per-row, field level ──────────────────────────────────────────
  for (const r of rows) {
    for (const f of REQUIRED) {
      if (String(r[f] ?? '').trim() === '') {
        add(r, f, 'required', `${label(f)} is required.`)
      }
    }

    const email = r.email.trim()
    if (email) {
      const guarded = guardEmail(email)
      if (!guarded.ok) add(r, 'email', 'email_rejected', guarded.message)
      else if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
        add(r, 'email', 'email_shape', `"${email}" does not look like an email address.`)
      }
    }

    // Unit: one leading apostrophe is a spreadsheet artefact and is
    // removed; anything else is the customer's to fix.
    const unitRaw = r.unit.trim().replace(/^'/, '')
    if (unitRaw) {
      if (normalizeUnit(unitRaw) === '') {
        add(r, 'unit', 'unit_empty', `"${r.unit}" has no letters or numbers in it.`)
      } else if (UNIT_NOISE.test(unitRaw) && normalizeUnit(unitRaw) !== normalizeUnit(unitRaw.replace(UNIT_NOISE, ''))) {
        const plain = unitRaw.replace(UNIT_NOISE, '').replace(/\s+/g, ' ').trim()
        // Name the word actually found, not a representative one. Told
        // that a unit beginning "Suite" is wrong because of "Apt", a
        // customer reasonably concludes the rule does not apply to them.
        const found = (UNIT_NOISE.exec(unitRaw)?.[1] ?? '').trim().replace(/[.\s]+$/, '')
        add(r, 'unit', 'unit_prefix', `Write the unit plainly: "${plain}", not "${unitRaw}". A unit with "${found}" written in front of it will not match what your managers search for.`)
      }
    }

    // 🔴 Length is measured on the DATABASE's normalized form, so what
    // this accepts is exactly what the plate column will hold.
    if (r.plate.trim() && r.plateNorm.length < MIN_PLATE) {
      add(r, 'plate', 'plate_too_short', `"${r.plate}" is only ${r.plateNorm.length} letters or numbers. A plate needs at least ${MIN_PLATE}. Spaces and dashes do not count.`)
    }

    const st = r.plate_state.trim()
    if (st && !isKnownPlateState(st)) {
      add(r, 'plate_state', 'plate_state_unknown',
        st.length > 2
          // The state name spelled out is the common case, so name the
          // code for it rather than giving a generic example that
          // repeats the word back at them.
          ? `Write the two-letter code, not the state name: ${codeFor(st) ?? 'for example TX'}, not "${st}".`
          : `"${st}" is not a state code we recognize. Use one of the ${PLATE_STATES.length} US state or DC codes.`)
    }

    for (const [f, cap] of [['first_name', MAX_NAME], ['last_name', MAX_NAME],
                            ['make', MAX_DESC], ['model', MAX_DESC], ['color', MAX_DESC],
                            ['tag_number', MAX_TAG]] as const) {
      const v = String(r[f] ?? '').trim()
      if (v.length > cap) add(r, f, 'too_long', `${label(f)} is longer than ${cap} characters.`)
    }
  }

  // ── across the file ───────────────────────────────────────────────
  // Duplicate plate, keyed on the DATABASE's normalized form — so
  // 'ABC 1234' and 'ABC-1234' in two rows are caught as one plate,
  // which is what the index will say when the loader runs.
  // 🔴 EVERY row in a duplicate group is flagged, not just the later
  // ones. Neither row is more wrong than the other, and the error file
  // is the customer's work list — if only the second occurrence were
  // listed, someone scanning it sees one row and may delete the wrong
  // car. Each message names the others.
  const plateRows = new Map<string, BulkRowInput[]>()
  for (const r of rows) {
    if (!r.plateNorm) continue
    const g = plateRows.get(r.plateNorm)
    if (g) g.push(r); else plateRows.set(r.plateNorm, [r])
  }
  for (const group of plateRows.values()) {
    if (group.length < 2) continue
    for (const r of group) {
      const others = group.filter(o => o !== r).map(o => o.index + 2)
      add(r, 'plate', 'duplicate_plate',
        `This plate is on ${others.length === 1 ? 'row' : 'rows'} ${others.join(', ')} as well. A plate can only be listed once — decide which row is right and remove the other${others.length === 1 ? '' : 's'}.`)
    }
  }

  // Rows sharing (email, unit) are ONE resident with several vehicles,
  // so they must carry the same name. Two DIFFERENT emails in one unit
  // are two residents and are fine — Alden Park 3302 and 6113 are real
  // households, and rejecting them was the first draft's mistake.
  const household = new Map<string, { row: number; name: string }>()
  for (const r of rows) {
    const email = r.email.trim().toLowerCase()
    const unit = normalizeUnit(r.unit.trim().replace(/^'/, ''))
    if (!email || !unit) continue
    const key = `${email}\u0000${unit}`
    const name = `${r.first_name.trim()} ${r.last_name.trim()}`.replace(/\s+/g, ' ').toLowerCase()
    const prev = household.get(key)
    if (!prev) household.set(key, { row: r.index + 2, name })
    else if (prev.name !== name) {
      add(r, 'first_name', 'name_conflict',
        `Row ${prev.row} has the same email and unit under a different name. Rows sharing an email and unit are one resident with more than one vehicle, so the name must match. If these are two people, give each their own email address.`)
    }
  }

  // Deterministic order, so the same file always produces the same
  // error file and a customer comparing two runs sees only real changes.
  return errors.sort((a, b) =>
    a.row - b.row ||
    BULK_CSV_COLUMNS.indexOf(a.column as never) - BULK_CSV_COLUMNS.indexOf(b.column as never) ||
    a.code.localeCompare(b.code))
}

/** The database half, from bulk_validate_rows. */
export interface BulkDbFlags {
  row_index: number
  plate_norm: string
  plate_active_here: boolean
  plate_active_other: boolean
  other_property: string | null
  plate_prohibited: boolean
  resident_exists: boolean
  resident_active: boolean
}

export function dbFlagErrors(rows: BulkRowInput[], flags: BulkDbFlags[]): BulkError[] {
  const byIndex = new Map(flags.map(f => [f.row_index, f]))
  const errors: BulkError[] = []
  for (const r of rows) {
    const f = byIndex.get(r.index)
    // 🔴 Absence is not "clean". A row the database did not answer for
    // is a row we cannot clear, and saying nothing would load it.
    if (!f) {
      errors.push({ row: r.index + 2, column: 'plate', code: 'not_checked',
        message: 'We could not check this row against your existing records. Please upload the file again.' })
      continue
    }
    if (f.plate_prohibited) {
      // The reason is deliberately not quoted: a prohibition reason is
      // an internal note and is never shown outside manager and CA
      // surfaces — and this file came from the CA, so naming the
      // prohibition is enough.
      errors.push({ row: r.index + 2, column: 'plate', code: 'plate_prohibited',
        message: `This plate is on the prohibited list for this property and cannot be registered. Remove the row, or clear the prohibition first.` })
    }
    if (f.plate_active_here) {
      errors.push({ row: r.index + 2, column: 'plate', code: 'plate_already_active',
        message: 'This plate is already registered and active at this property.' })
    }
    if (f.plate_active_other) {
      errors.push({ row: r.index + 2, column: 'plate', code: 'plate_active_elsewhere',
        message: `This plate is already registered and active at ${f.other_property ?? 'another of your properties'}. A plate can only be active at one property.` })
    }
    if (f.resident_exists) {
      errors.push({ row: r.index + 2, column: 'email', code: f.resident_active ? 'resident_exists' : 'resident_deactivated',
        message: f.resident_active
          ? 'A resident with this email is already on file at this property. Remove the row — this upload adds residents, it does not update them.'
          : 'A resident with this email was on file at this property and is deactivated. Remove the row and reactivate them from the residents list instead.' })
    }
  }
  return errors
}

/** Spelled-out state name → its code, so the error can name the fix. */
const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY',
}
function codeFor(v: string): string | null {
  return STATE_NAMES[v.trim().toLowerCase().replace(/\s+/g, ' ')] ?? null
}

function label(f: string): string {
  return ({
    unit: 'Unit', first_name: 'First name', last_name: 'Last name', email: 'Email',
    phone: 'Phone', plate: 'Plate', plate_state: 'Plate state', make: 'Make',
    model: 'Model', color: 'Color', tag_number: 'Parking tag number',
  } as Record<string, string>)[f] ?? f
}

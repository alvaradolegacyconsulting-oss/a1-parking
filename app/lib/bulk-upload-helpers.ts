// B113 — shared CSV parsing + validation helpers for bulk upload.
//
// Imported by both:
//   • Client: /company_admin/bulk-upload/page.tsx (preview + row-level
//     error UI before submit)
//   • Server: /api/billing/bulk-invite/route.ts (re-validates on
//     submit — client validation is UX only; server is authoritative)
//
// Pure functions (no DB / SDK dependencies). Tests can exercise these
// without spinning up Supabase / Next runtime.
//
// CSV templates are exported as strings; client builds the Blob
// (avoids server route for static template download).

export type EntityType = 'driver' | 'resident'

// ── Validated row types (post-validation shape returned to caller) ───
export interface DriverRow {
  email: string
  name: string
  phone: string | null
  assigned_properties: string[]
}

export interface ResidentRow {
  email: string
  name: string
  property: string
  unit: string
  vehicle_plate: string | null
  vehicle_state: string | null
  vehicle_make: string | null
  vehicle_model: string | null
  vehicle_color: string | null
}

export interface RowError {
  row_index: number   // 0-based — matches array index in CSV (after header)
  field: string
  message: string
}

export interface ValidatedRows<T> {
  ok: boolean
  rows: T[]
  errors: RowError[]
}

// ── Per-tier per-upload cap (P5.4 — 500 max) ─────────────────────────
export const MAX_UPLOAD_ROWS = 500

// ── Email regex matches the same shape used elsewhere in the codebase
// (signup form, login form, etc.). Permissive — Stripe / Supabase
// will reject truly malformed emails at write time.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ── Mojibake detection ───────────────────────────────────────────────
// Excel exports as Windows-1252 / Latin-1 sometimes; if the user
// double-encodes UTF-8 in such a tool, common artifacts include the
// replacement char (�) and "Ã" sequences (Latin-1 of UTF-8
// continuation bytes — e.g., "Ã©" instead of "é"). Detected client-
// side so the user re-saves as UTF-8 before submit. v1 covers the
// most-frequent patterns; Windows-1252 fallback deferred to fast-
// follow per pre-flight P5.6.
export function detectMojibake(s: string): boolean {
  if (!s) return false
  if (/�/.test(s)) return true
  // Common Latin-1-decoded-as-UTF-8 sequences. UTF-8 multi-byte
  // sequences start with leading bytes 0xC2 or 0xC3 (which decode to
  // "Â" or "Ã" in Latin-1), followed by continuation bytes 0x80-0xBF
  // (which decode to Latin-1 supplement chars U+0080-U+00BF).
  if (/[ÂÃ][-¿]/.test(s)) return true
  return false
}

// ── CSV templates (B113 commit 1 spec — per-entity, UTF-8 header) ────
export const DRIVER_CSV_TEMPLATE = `# Encoding: UTF-8 — save as UTF-8 from Excel/Sheets/Numbers before upload.
# Required columns: email, name
# Optional columns: phone, assigned_properties (comma-separated list of property names)
email,name,phone,assigned_properties
driver1@example.com,Jane Doe,512-555-0001,"Main Lot,Side Lot"
driver2@example.com,John Smith,,Main Lot
`

export const RESIDENT_CSV_TEMPLATE = `# Encoding: UTF-8 — save as UTF-8 from Excel/Sheets/Numbers before upload.
# Required columns: email, name, property, unit
# Optional columns: vehicle_plate, vehicle_state, vehicle_make, vehicle_model, vehicle_color
# If vehicle_plate is set, a companion vehicle row is created for the resident.
email,name,property,unit,vehicle_plate,vehicle_state,vehicle_make,vehicle_model,vehicle_color
resident1@example.com,Alice Resident,Riverside Apartments,A-101,ABC1234,TX,Honda,Civic,Silver
resident2@example.com,Bob Resident,Riverside Apartments,A-102,,,,,
`

export function templateFor(entity: EntityType): string {
  return entity === 'driver' ? DRIVER_CSV_TEMPLATE : RESIDENT_CSV_TEMPLATE
}

// ── Row validation ───────────────────────────────────────────────────
// rawRows comes from Papa.parse (or equivalent) with header:true. Each
// row is an arbitrary object whose keys correspond to CSV column
// headers. Validation:
//   • Required fields present + non-empty
//   • Email matches EMAIL_RE
//   • Name + property fields don't contain mojibake (defensive — if
//     the CSV was saved in wrong encoding, surface BEFORE submit)
//   • Phone optional but trimmed
//   • assigned_properties split on comma (drivers)
//   • Vehicle fields optional but tied together (if vehicle_plate
//     populated, name/state/etc. populate too — but this isn't
//     enforced, just normalized to NULL when missing)

export function validateDriverRows(rawRows: Array<Record<string, unknown>>): ValidatedRows<DriverRow> {
  const errors: RowError[] = []
  const rows: DriverRow[] = []

  rawRows.forEach((raw, i) => {
    const email = String(raw.email ?? '').trim().toLowerCase()
    const name = String(raw.name ?? '').trim()
    const phone = raw.phone ? String(raw.phone).trim() : null
    const propsRaw = raw.assigned_properties ? String(raw.assigned_properties).trim() : ''
    const assigned_properties = propsRaw
      ? propsRaw.split(',').map(s => s.trim()).filter(Boolean)
      : []

    if (!email) errors.push({ row_index: i, field: 'email', message: 'required' })
    else if (!EMAIL_RE.test(email)) errors.push({ row_index: i, field: 'email', message: 'invalid email format' })

    if (!name) errors.push({ row_index: i, field: 'name', message: 'required' })
    else if (detectMojibake(name)) errors.push({ row_index: i, field: 'name', message: 'encoding issue (mojibake) — save CSV as UTF-8' })

    rows.push({ email, name, phone, assigned_properties })
  })

  return { ok: errors.length === 0, rows, errors }
}

export function validateResidentRows(rawRows: Array<Record<string, unknown>>): ValidatedRows<ResidentRow> {
  const errors: RowError[] = []
  const rows: ResidentRow[] = []

  rawRows.forEach((raw, i) => {
    const email = String(raw.email ?? '').trim().toLowerCase()
    const name = String(raw.name ?? '').trim()
    const property = String(raw.property ?? '').trim()
    const unit = String(raw.unit ?? '').trim()
    const vehicle_plate = raw.vehicle_plate ? String(raw.vehicle_plate).trim().toUpperCase() : null
    const vehicle_state = raw.vehicle_state ? String(raw.vehicle_state).trim().toUpperCase() : null
    const vehicle_make = raw.vehicle_make ? String(raw.vehicle_make).trim() : null
    const vehicle_model = raw.vehicle_model ? String(raw.vehicle_model).trim() : null
    const vehicle_color = raw.vehicle_color ? String(raw.vehicle_color).trim() : null

    if (!email) errors.push({ row_index: i, field: 'email', message: 'required' })
    else if (!EMAIL_RE.test(email)) errors.push({ row_index: i, field: 'email', message: 'invalid email format' })

    if (!name) errors.push({ row_index: i, field: 'name', message: 'required' })
    else if (detectMojibake(name)) errors.push({ row_index: i, field: 'name', message: 'encoding issue (mojibake) — save CSV as UTF-8' })

    if (!property) errors.push({ row_index: i, field: 'property', message: 'required' })
    else if (detectMojibake(property)) errors.push({ row_index: i, field: 'property', message: 'encoding issue (mojibake)' })

    if (!unit) errors.push({ row_index: i, field: 'unit', message: 'required' })

    rows.push({ email, name, property, unit, vehicle_plate, vehicle_state, vehicle_make, vehicle_model, vehicle_color })
  })

  return { ok: errors.length === 0, rows, errors }
}

// ── Dispatch entry point used by the API route ───────────────────────
export function validateRows(
  entity: EntityType,
  rawRows: Array<Record<string, unknown>>,
): ValidatedRows<DriverRow> | ValidatedRows<ResidentRow> {
  return entity === 'driver' ? validateDriverRows(rawRows) : validateResidentRows(rawRows)
}

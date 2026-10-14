import { NextRequest, NextResponse } from 'next/server'
import { authorizeBulkUpload, readBulkObject } from '../../../lib/bulk-onboarding-auth'
import { BULK_CSV_COLUMNS, parseBulkCsv } from '../../../lib/bulk-onboarding'
import {
  validateBulkRows, dbFlagErrors,
  type BulkRowInput, type BulkDbFlags, type BulkError,
} from '../../../lib/bulk-validator'

// ════════════════════════════════════════════════════════════════════
// Phase A — preview: validate the uploaded file and return the errors
// ════════════════════════════════════════════════════════════════════
// Read-only. Nothing is written, no batch is created, nothing is
// loaded. The CA uploads, previews until the file is clean, then
// attests and submits.
//
// Same authorization as submit, from the same module, because a
// preview that clears a file the submission would refuse sends the
// customer round a loop with no way out.
//
// 🔴 THE PLATE KEY COMES FROM THE DATABASE. bulk_validate_rows returns
// public.normalize_plate() for every row, and the length check, the
// in-file duplicate check and the conflict checks all use that value.
// vehicles_plate_norm_uniq is an expression index over that function,
// and predicting what it will do to the load is this endpoint's job —
// so a TypeScript copy of the key would be predicting the wrong thing.

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  let body: { object_path?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad_request', message: 'The request could not be read.' }, { status: 400 }) }

  const auth = await authorizeBulkUpload(body.object_path)
  if (!auth.ok) return NextResponse.json({ error: auth.code, message: auth.message }, { status: auth.status })

  const read = await readBulkObject(auth.db, auth.objectPath)
  if (!read.ok) return NextResponse.json({ error: read.code, message: read.message }, { status: read.status })

  // Structural: our header, within the row cap, parseable.
  const parsed = parseBulkCsv(read.text)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.code, message: parsed.message },
      { status: parsed.code === 'too_many_rows' ? 413 : 400 })
  }

  const col = (r: string[], name: typeof BULK_CSV_COLUMNS[number]) =>
    (r[BULK_CSV_COLUMNS.indexOf(name)] ?? '').trim()

  // ── the database half, one set-based call for the whole file ──────
  const rpc = await auth.db.rpc('bulk_validate_rows', {
    p_property_id: auth.property.id,
    p_rows: parsed.dataRows.map((r, i) => ({ i, email: col(r, 'email'), plate: col(r, 'plate') })),
  })
  if (rpc.error) {
    // The RPC's own authority gate. It should be unreachable here —
    // authorizeBulkUpload already passed the same checks — so if it
    // fires, the two have drifted and that is a bug, not a user error.
    if (rpc.error.message?.includes('property_not_in_scope')) {
      console.error(`[bulk-onboarding/preview] 🔴 authorizeBulkUpload passed but bulk_validate_rows refused property ${auth.property.id} for ${auth.email} — the two gates have drifted`)
      return NextResponse.json({ error: 'property_not_in_scope', message: 'That property is not one you can upload for.' }, { status: 403 })
    }
    console.error('[bulk-onboarding/preview] bulk_validate_rows:', rpc.error)
    return NextResponse.json({ error: 'preview_failed', message: 'We could not check this file against your existing records. Please try again.' }, { status: 500 })
  }
  const flags = (rpc.data ?? []) as BulkDbFlags[]
  const normByIndex = new Map(flags.map(f => [f.row_index, f.plate_norm]))

  const rows: BulkRowInput[] = parsed.dataRows.map((r, i) => ({
    index: i,
    unit: col(r, 'unit'),
    first_name: col(r, 'first_name'),
    last_name: col(r, 'last_name'),
    email: col(r, 'email'),
    phone: col(r, 'phone'),
    plate: col(r, 'plate'),
    plate_state: col(r, 'plate_state'),
    make: col(r, 'make'),
    model: col(r, 'model'),
    color: col(r, 'color'),
    tag_number: col(r, 'tag_number'),
    plateNorm: normByIndex.get(i) ?? '',
  }))

  const errors: BulkError[] = [...validateBulkRows(rows), ...dbFlagErrors(rows, flags)]
    .sort((a, b) => a.row - b.row || a.column.localeCompare(b.column) || a.code.localeCompare(b.code))

  // 🔴 "Clean" means every row was checked AND nothing was found.
  // Absence of errors is not the same as having looked — a file whose
  // database half came back short is reported as not checked by
  // dbFlagErrors rather than passing quietly.
  const rowsChecked = new Set(flags.map(f => f.row_index)).size

  return NextResponse.json({
    ok: true,
    property: { id: auth.property.id, name: auth.property.name },
    data_rows: parsed.dataRows.length,
    rows_checked: rowsChecked,
    resident_count: parsed.residentCount,
    vehicle_count: parsed.vehicleCount,
    clean: errors.length === 0 && rowsChecked === parsed.dataRows.length,
    error_count: errors.length,
    // Capped for the response; the CSV error file the CA downloads is
    // built from the same list and is not capped.
    errors: errors.slice(0, 500),
    errors_truncated: errors.length > 500,
  })
}

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { authorizeBulkUpload, readBulkObject } from '../../../lib/bulk-onboarding-auth'
import { BULK_BUCKET, BULK_CSV_COLUMNS, bulkBatchPath, parseBulkCsv } from '../../../lib/bulk-onboarding'
import {
  validateBulkRows, dbFlagErrors,
  type BulkRowInput, type BulkDbFlags,
} from '../../../lib/bulk-validator'

// ════════════════════════════════════════════════════════════════════
// Phase A — bulk-onboarding submission
// ════════════════════════════════════════════════════════════════════
// The CA uploads the CSV straight to the bulk-onboarding bucket (RLS
// lets them write only {their property id}/{uuid}.csv), then calls this
// route to turn it into an import_batches row for Jose to approve.
//
// Authorization is authorizeBulkUpload(), shared with preview — see
// that module for what is derived rather than trusted. status is
// forced to 'submitted' here and never read from the payload.
//
// 🔴 A DIRTY FILE IS NOT SUBMITTABLE. The same validation the preview
// runs runs again here, because preview is a courtesy and this is the
// gate. Otherwise a CA who skipped the preview puts a file in front of
// Jose that cannot load, and the failure arrives in the loader —
// halfway through a transaction, long after anyone was looking.
//
// 🔴 THE HASHED FILE MUST BE THE LOADED FILE. The bytes are hashed,
// copied to batches/{batch_id}.csv, and the copy is re-downloaded and
// re-hashed before the batch points at it. storage_path therefore names
// the location of the hashed bytes at every instant: the CA's upload
// first, the immutable copy once it is proven identical.

export const runtime = 'nodejs'          // crypto + Buffer
export const maxDuration = 60

const BAD = (status: number, code: string, message: string, extra: object = {}) =>
  NextResponse.json({ error: code, message, ...extra }, { status })

// Raw Postgres and storage errors never reach the UI; they are logged
// with the batch context and the caller gets a stable code.
const oops = (where: string, detail: unknown) => {
  console.error(`[bulk-onboarding/submit] ${where}:`, detail)
  return BAD(500, 'submit_failed', 'Something went wrong saving your submission. Nothing was loaded. Please try again, and contact support if it happens twice.')
}

export async function POST(req: NextRequest) {
  let body: { object_path?: unknown; source_filename?: unknown; attested_name?: unknown; attested_title?: unknown }
  try { body = await req.json() } catch { return BAD(400, 'bad_request', 'The request could not be read.') }

  const auth = await authorizeBulkUpload(body.object_path)
  if (!auth.ok) return BAD(auth.status, auth.code, auth.message)
  const { db, property, company, objectPath } = auth

  const attestedName = typeof body.attested_name === 'string' ? body.attested_name.trim() : ''
  const attestedTitle = typeof body.attested_title === 'string' ? body.attested_title.trim() : ''
  if (!attestedName || !attestedTitle) {
    return BAD(400, 'attestation_incomplete', 'Please enter your name and title to confirm the upload.')
  }
  // Cosmetic only — shown on the review screen. The identity of the
  // file is its hash, not its name.
  const sourceFilename = (typeof body.source_filename === 'string' ? body.source_filename : 'upload.csv')
    .replace(/[\r\n\t]/g, ' ').trim().slice(0, 200) || 'upload.csv'

  // ── the bytes, with both caps enforced here ───────────────────────
  const read = await readBulkObject(db, objectPath)
  if (!read.ok) return BAD(read.status, read.code, read.message)

  const parsed = parseBulkCsv(read.text)
  if (!parsed.ok) return BAD(parsed.code === 'too_many_rows' ? 413 : 400, parsed.code, parsed.message)

  // ── the same validation the preview ran ───────────────────────────
  const col = (r: string[], name: typeof BULK_CSV_COLUMNS[number]) =>
    (r[BULK_CSV_COLUMNS.indexOf(name)] ?? '').trim()
  // 🔴 asCaller, NOT db. See the identical note in preview/route.ts:
  // bulk_validate_rows resolves the caller from the JWT email claim, so
  // a service_role call is refused by its own authority gate. Submitted
  // this way from the day it shipped, which meant every submission —
  // clean or dirty — came back as a 500 submit_failed.
  const rpc = await auth.asCaller.rpc('bulk_validate_rows', {
    p_property_id: property.id,
    p_rows: parsed.dataRows.map((r, i) => ({ i, email: col(r, 'email'), plate: col(r, 'plate') })),
  })
  if (rpc.error) return oops('bulk_validate_rows', rpc.error)
  const flags = (rpc.data ?? []) as BulkDbFlags[]
  const normByIndex = new Map(flags.map(f => [f.row_index, f.plate_norm]))
  const rows: BulkRowInput[] = parsed.dataRows.map((r, i) => ({
    index: i,
    unit: col(r, 'unit'), first_name: col(r, 'first_name'), last_name: col(r, 'last_name'),
    email: col(r, 'email'), phone: col(r, 'phone'), plate: col(r, 'plate'),
    plate_state: col(r, 'plate_state'), make: col(r, 'make'), model: col(r, 'model'),
    color: col(r, 'color'), tag_number: col(r, 'tag_number'),
    plateNorm: normByIndex.get(i) ?? '',
  }))
  const errors = [...validateBulkRows(rows), ...dbFlagErrors(rows, flags)]
  if (errors.length > 0) {
    return BAD(422, 'file_has_errors',
      `This file still has ${errors.length} ${errors.length === 1 ? 'error' : 'errors'}. Fix them and upload again — the preview lists them by row number.`,
      { error_count: errors.length, first_errors: errors.slice(0, 10) })
  }

  // ── the hash ──────────────────────────────────────────────────────
  // Over the BYTES, not the decoded text: the hash identifies the file
  // the customer sent, byte for byte, so the loader can prove it is
  // loading that same file and not a re-encoded copy of it.
  const sha256 = crypto.createHash('sha256').update(read.bytes).digest('hex')

  // ── the batch row, status forced ──────────────────────────────────
  // storage_path is the CA's upload for now, which is where the hashed
  // bytes are at this instant. It moves to the immutable copy below,
  // once that copy is proven identical.
  const ins = await db.from('import_batches').insert({
    company_id: company.id,
    property_id: property.id,
    source_filename: sourceFilename,
    storage_path: objectPath,
    file_sha256: sha256,
    attested_by_user_id: auth.userId,
    attested_name: attestedName,
    attested_title: attestedTitle,
    status: 'submitted',
    resident_count: parsed.residentCount,
    vehicle_count: parsed.vehicleCount,
  }).select('id').single()

  if (ins.error) {
    // The partial unique index on (property_id, file_sha256) for live
    // batches. Same bytes, same property, already waiting or loaded.
    if (ins.error.code === '23505') {
      return BAD(409, 'already_submitted', 'This exact file has already been submitted for this property and is waiting for review. If you meant to replace it, change the file and upload again.')
    }
    return oops('import_batches insert', ins.error)
  }
  const batchId = ins.data.id as number

  // ── the immutable copy, verified ──────────────────────────────────
  // batches/ is outside every CA INSERT policy (the policy is anchored
  // on '^[0-9]+/', and 'batches' is not digits), so this copy cannot be
  // rewritten from a browser.
  const immutable = bulkBatchPath(batchId)
  const undo = async (where: string, detail: unknown) => {
    // No residents or vehicles reference this batch yet, so the FK's
    // ON DELETE RESTRICT does not apply and the row can go. A batch
    // row pointing at a file we could not secure is worse than none.
    const del = await db.from('import_batches').delete().eq('id', batchId).select('id')
    if (del.error || (del.data ?? []).length !== 1) {
      console.error(`[bulk-onboarding/submit] 🔴 batch ${batchId} could not be rolled back after ${where}:`, del.error ?? del.data)
    }
    await db.storage.from(BULK_BUCKET).remove([immutable]).catch(() => {})
    return oops(where, detail)
  }

  const copy = await db.storage.from(BULK_BUCKET)
    .upload(immutable, read.bytes, { contentType: 'text/csv', upsert: false })
  if (copy.error) return undo('immutable copy', copy.error)

  const back = await db.storage.from(BULK_BUCKET).download(immutable)
  if (back.error || !back.data) return undo('immutable copy read-back', back.error)
  const copiedSha = crypto.createHash('sha256')
    .update(Buffer.from(await back.data.arrayBuffer())).digest('hex')
  if (copiedSha !== sha256) return undo('immutable copy hash mismatch', `wrote ${sha256}, read back ${copiedSha}`)

  const point = await db.from('import_batches')
    .update({ storage_path: immutable }).eq('id', batchId).select('id, storage_path').single()
  if (point.error || point.data?.storage_path !== immutable) {
    return undo('storage_path repoint', point.error ?? point.data)
  }

  // The customer's upload has served its purpose and the immutable copy
  // is proven identical. Removing it keeps one copy of resident PII
  // rather than two; the CA can neither read nor delete it themselves.
  // Non-fatal: a stray original is inert, and the storage cleanup cron
  // sweeps it.
  const rm = await db.storage.from(BULK_BUCKET).remove([objectPath])
  if (rm.error) console.error(`[bulk-onboarding/submit] original ${objectPath} not removed (batch ${batchId}):`, rm.error)

  return NextResponse.json({
    ok: true,
    batch_id: batchId,
    status: 'submitted',
    property: { id: property.id, name: property.name },
    resident_count: parsed.residentCount,
    vehicle_count: parsed.vehicleCount,
    file_sha256: sha256,
  })
}

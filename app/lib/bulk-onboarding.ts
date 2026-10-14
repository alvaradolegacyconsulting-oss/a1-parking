// Phase A — the one place the bulk-onboarding file contract lives.
//
// The header, the caps and the object-path shape are each referenced
// from four places: the customer template, the submission route, the
// validator, and the CA page. Four copies of a header string is three
// chances for a file that validates to be rejected at submission, so
// they all import these.
//
// 🔴 docs/bulk-onboarding/template.csv must carry BULK_CSV_HEADER
// verbatim. That is asserted by npm run verify:bulkbucket, because a
// template whose header no longer matches the route hands every
// customer a file that cannot be submitted.

export const BULK_BUCKET = 'bulk-onboarding'

export const BULK_CSV_COLUMNS = [
  'unit', 'first_name', 'last_name', 'email', 'phone',
  'plate', 'plate_state', 'make', 'model', 'color', 'tag_number',
] as const

export const BULK_CSV_HEADER = BULK_CSV_COLUMNS.join(',')

/** Data rows, excluding the header. Approved 2026-10-14. */
export const MAX_BULK_ROWS = 1000

/** 2 MB. Also the bucket's file_size_limit — the route must not rely on it. */
export const MAX_BULK_BYTES = 2 * 1024 * 1024

/**
 * {property_id}/{uuid}.csv — what a company_admin may upload.
 *
 * 🔴 Byte-identical to the regex in bulk_csv_ca_insert's WITH CHECK
 * (migrations/20261015_bulk_onboarding_bucket.sql §3a). The
 * storage policy is the enforcement; this is the route refusing to
 * take a path the policy would not have accepted, so a mismatch
 * between them is a bug in one of the two.
 */
export const BULK_OBJECT_PATH =
  /^([0-9]+)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$/

/** Where the server's immutable per-batch copy lives. Outside what any CA policy can write. */
export const bulkBatchPath = (batchId: number | string) => `batches/${batchId}.csv`

export type BulkParseResult =
  | { ok: true; dataRows: string[][]; residentCount: number; vehicleCount: number }
  | { ok: false; code: string; message: string }

/**
 * Structural parse only — is this a CSV with our header, within the
 * caps, and how many residents and vehicles does it describe?
 *
 * This is NOT the validator. The ten field-level checks (plate shape,
 * unit shape, duplicate plates, prohibitions, conflicting identity)
 * run at the preview step and are a separate piece. The route needs
 * exactly two numbers for import_batches, and needs to refuse a file
 * that is not the right file at all.
 *
 * Quoted fields are handled, because Excel quotes any value containing
 * a comma and a resident named "Smith, Jr." would otherwise silently
 * shift every column after it.
 */
export function parseBulkCsv(text: string): BulkParseResult {
  // Excel writes a UTF-8 BOM. Left in place it becomes part of the
  // first header name, and the header check fails on a file that is
  // correct.
  const body = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = body.split('\n')
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length === 0) return { ok: false, code: 'empty', message: 'The file is empty.' }

  const header = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase())
  if (header.join(',') !== BULK_CSV_HEADER) {
    return {
      ok: false, code: 'header_mismatch',
      message: `The first row must be the header from the template, exactly. Expected: ${BULK_CSV_HEADER}`,
    }
  }

  const dataRows = lines.slice(1).filter(l => l.trim() !== '').map(splitCsvLine)
  if (dataRows.length === 0) {
    return { ok: false, code: 'no_data_rows', message: 'The file has a header but no data rows.' }
  }
  if (dataRows.length > MAX_BULK_ROWS) {
    return {
      ok: false, code: 'too_many_rows',
      message: `The file has ${dataRows.length} data rows. One file may hold up to ${MAX_BULK_ROWS}. Split it by property or by building.`,
    }
  }

  // One row per vehicle; rows sharing (email, unit) are one resident.
  // Same grouping key the validator and the loader use — if these three
  // ever disagree, the counts Jose approves are not the counts loaded.
  const emailIdx = BULK_CSV_COLUMNS.indexOf('email')
  const unitIdx = BULK_CSV_COLUMNS.indexOf('unit')
  const households = new Set<string>()
  for (const r of dataRows) {
    const email = (r[emailIdx] ?? '').trim().toLowerCase()
    const unit = (r[unitIdx] ?? '').trim().replace(/^'/, '')
    households.add(`${email}\u0000${unit}`)
  }

  return { ok: true, dataRows, residentCount: households.size, vehicleCount: dataRows.length }
}

/** RFC-4180-ish: quoted fields, "" as an escaped quote. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false }
      else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

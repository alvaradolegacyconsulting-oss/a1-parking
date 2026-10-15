import { NextResponse, type NextRequest } from 'next/server'
import { authorizeImportOperator, reviewImportBatch } from '../../../../lib/import-batch-review'
import { parseBulkCsv, BULK_CSV_COLUMNS } from '../../../../lib/bulk-onboarding'
import { readBulkObject } from '../../../../lib/bulk-onboarding-auth'

// ════════════════════════════════════════════════════════════════════
// Load — re-validation point 3 of 3, and the only one that writes
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16. Separate from Approve and never chained to it:
// approving 358 rows and writing 586 records are different decisions,
// and only this one creates anything.
//
// 🔴 THE TRANSACTION IS THE RPC'S, NOT THIS ROUTE'S. A route cannot
// wrap three PostgREST calls in a transaction, and "a failed load
// leaves the batch approved and retryable" is only true if a failed
// attempt left nothing behind. So this route does everything that
// cannot be done in SQL — read the object, hash it, parse it,
// re-validate — and hands the rows to load_import_batch, which does
// the writes and the status change as one unit.
//
// 🔴 THREE OUTCOMES, AND THEY ARE NOT INTERCHANGEABLE:
//
//   blocked    property inactive / company suspended / flag off.
//              The file is still perfectly clean against the
//              property's records, so this produces no validation
//              error at all — which is exactly why it cannot be
//              folded into "transient". A Retry here would SUCCEED
//              and load 228 residents into a property nobody can see.
//              Refusal with the reason, and no Retry offered.
//
//   stale      re-validation found rows that no longer fit. Retrying
//              fails identically forever; the file has to go back.
//              Return is offered, with the row numbers attached.
//
//   transient  a database or network failure with no validation
//              errors. The batch is still approved, nothing was
//              written, and Retry is the right button.
//
// The response names which one it was, because the UI's job is to
// offer the action that can actually resolve it.

export async function POST(req: NextRequest) {
  const auth = await authorizeImportOperator()
  if (!auth.ok) return NextResponse.json({ error: auth.code, message: auth.message }, { status: auth.status })

  let body: { batch_id?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'bad_request', message: 'The request could not be read.' }, { status: 400 })
  }
  const batchId = Number(body.batch_id)

  // ── re-validation, through the same function the screen used ──────
  const review = await reviewImportBatch(auth, batchId)
  if (!review.ok) return NextResponse.json({ error: review.code, message: review.message }, { status: review.status })

  // ══════════════════════════════════════════════════════════════════
  // 🔴 STATUS FIRST, BEFORE BLOCK AND BEFORE VALIDATION.
  // Found 2026-10-16 by the loader gate. A second load of batch 8 was
  // correctly refused and reported "1074 rows need fixing, return it to
  // the company" — because the batch's OWN just-loaded 358 vehicles and
  // 228 residents are what made its file look stale. The operator would
  // have been offered Return for a batch that was already loaded.
  //
  // The general rule: the cheap unambiguous question comes before the
  // expensive interpretable one. "Is this action applicable to this
  // batch at all" cannot be answered by looking at records the action
  // itself created.
  // ══════════════════════════════════════════════════════════════════
  if (String(review.batch.status) !== 'approved') {
    return NextResponse.json({
      error: 'wrong_status', outcome: 'blocked',
      message: String(review.batch.status) === 'loaded'
        ? 'This batch is already loaded. Loading it again would insert every record twice.'
        : `This batch is ${review.batch.status}. Only an approved batch can be loaded.`,
      status: review.batch.status, retryable: false,
    }, { status: 409 })
  }

  if (review.block.blocked) {
    return NextResponse.json({
      error: 'blocked', outcome: 'blocked',
      message: 'This batch cannot be loaded right now. Nothing was loaded and the batch is unchanged.',
      reasons: review.block.reasons,
      // 🔴 Stated in the payload so the UI cannot decide otherwise: a
      // retry would work and would be wrong.
      retryable: false,
    }, { status: 409 })
  }
  if (!review.validation.ran) {
    return NextResponse.json({
      error: 'not_validated', outcome: 'blocked',
      message: review.validation.why, retryable: false,
    }, { status: 409 })
  }
  if (!review.validation.clean) {
    return NextResponse.json({
      error: 'file_has_errors', outcome: 'stale',
      message: `This file no longer matches the records at ${review.property.name} — ${review.validation.error_count} ${review.validation.error_count === 1 ? 'row needs' : 'rows need'} fixing. Nothing was loaded. Return it to the company so they get the row numbers.`,
      error_count: review.validation.error_count,
      errors: review.validation.errors.slice(0, 50),
      retryable: false, offer_return: true,
    }, { status: 409 })
  }
  // ── the rows, from the bytes this request just hashed ─────────────
  // Re-read rather than threaded out of reviewImportBatch, because the
  // rows handed to the RPC must be the ones whose hash was checked in
  // the same request — not a parse from an earlier one.
  const read = await readBulkObject(auth.db, String(review.batch.storage_path))
  if (!read.ok) {
    return NextResponse.json({
      error: 'file_unreadable', outcome: 'transient',
      message: 'The stored file could not be read. Nothing was loaded and the batch is still approved.',
      retryable: true,
    }, { status: 503 })
  }
  const parsed = parseBulkCsv(read.text)
  if (!parsed.ok) {
    return NextResponse.json({
      error: parsed.code, outcome: 'blocked',
      message: `The stored file no longer parses (${parsed.message}). Nothing was loaded.`,
      retryable: false,
    }, { status: 409 })
  }
  const col = (r: string[], name: typeof BULK_CSV_COLUMNS[number]) =>
    (r[BULK_CSV_COLUMNS.indexOf(name)] ?? '').trim()
  const rpcRows = parsed.dataRows.map(r => ({
    unit: col(r, 'unit'), first_name: col(r, 'first_name'), last_name: col(r, 'last_name'),
    email: col(r, 'email'), phone: col(r, 'phone'), plate: col(r, 'plate'),
    plate_state: col(r, 'plate_state'), make: col(r, 'make'), model: col(r, 'model'),
    color: col(r, 'color'),
    // 🔴 tag_number is deliberately NOT sent. The loader does not write
    // parking tags and a file carrying them is refused by the
    // re-validation above, so there is nothing to pass and nothing to
    // be quietly dropped by passing it.
  }))

  const rpc = await auth.asCaller.rpc('load_import_batch', {
    p_batch_id: batchId,
    p_file_sha256: review.file.sha256,
    p_rows: rpcRows,
  })
  if (rpc.error) {
    console.error('[import-batch/load] rpc:', rpc.error)
    return NextResponse.json({
      error: 'load_failed', outcome: 'transient',
      message: 'Something went wrong loading that batch. Nothing was loaded and the batch is still approved.',
      retryable: true,
    }, { status: 500 })
  }
  const out = (rpc.data ?? {}) as Record<string, unknown>
  if (out.ok !== true) {
    // 🔴 A CONFLICT IS NOT TRANSIENT. The RPC distinguishes them, and
    // offering a Retry on a unique violation is a button that fails
    // identically every time it is pressed.
    const code = String(out.error ?? 'load_refused')
    const transient = code === 'load_failed'
    return NextResponse.json({
      error: code,
      outcome: transient ? 'transient' : code === 'conflict' ? 'stale' : 'blocked',
      message: String(out.hint ?? out.detail ?? 'That load was refused. Nothing was loaded.'),
      sqlstate: out.sqlstate ?? null,
      retryable: transient,
      offer_return: code === 'conflict',
    }, { status: 409 })
  }

  return NextResponse.json({
    ok: true, batch_id: batchId, status: 'loaded',
    residents: out.residents, vehicles: out.vehicles, roles: out.roles,
    property: review.property.name,
  })
}

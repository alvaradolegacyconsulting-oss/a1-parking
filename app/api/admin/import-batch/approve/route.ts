import { NextResponse, type NextRequest } from 'next/server'
import { authorizeImportOperator, reviewImportBatch } from '../../../../lib/import-batch-review'

// ════════════════════════════════════════════════════════════════════
// Approve — re-validation point 2 of 3
// ════════════════════════════════════════════════════════════════════
// 🔴 RE-VALIDATES AGAIN RATHER THAN TRUSTING THE REVIEW SCREEN. The
// screen's verdict was computed when it was opened, and a manager can
// add a vehicle in the seconds between reading it and clicking. So the
// check runs here too, through the SAME function the screen used, and
// the RPC is only reached if it comes back clean.
//
// The hash goes to the RPC as well, so the approval is of bytes this
// request just read and hashed — not of whatever the row happens to
// point at by the time the UPDATE lands.

export async function POST(req: NextRequest) {
  const auth = await authorizeImportOperator()
  if (!auth.ok) return NextResponse.json({ error: auth.code, message: auth.message }, { status: auth.status })

  let body: { batch_id?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'bad_request', message: 'The request could not be read.' }, { status: 400 })
  }
  const batchId = Number(body.batch_id)

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
  if (String(review.batch.status) !== 'submitted') {
    return NextResponse.json({
      error: 'wrong_status',
      message: String(review.batch.status) === 'loaded'
        ? 'This batch is already loaded. There is nothing left to approve.'
        : `This batch is ${review.batch.status}. Only a submitted batch can be approved.`,
      status: review.batch.status,
    }, { status: 409 })
  }

  if (review.block.blocked) {
    return NextResponse.json({
      error: 'blocked', message: 'This batch cannot be loaded right now, so approving it would not help.',
      reasons: review.block.reasons,
    }, { status: 409 })
  }
  if (!review.validation.ran) {
    return NextResponse.json({
      error: 'not_validated', message: review.validation.why,
    }, { status: 409 })
  }
  if (!review.validation.clean) {
    return NextResponse.json({
      error: 'file_has_errors',
      message: `This file no longer matches the records at ${review.property.name} — ${review.validation.error_count} ${review.validation.error_count === 1 ? 'row needs' : 'rows need'} fixing. Return it to the company instead.`,
      error_count: review.validation.error_count,
      errors: review.validation.errors.slice(0, 50),
    }, { status: 409 })
  }
  const rpc = await auth.asCaller.rpc('approve_import_batch', {
    p_batch_id: batchId,
    p_file_sha256: review.file.sha256,
  })
  if (rpc.error) {
    console.error('[import-batch/approve] rpc:', rpc.error)
    return NextResponse.json({ error: 'approve_failed', message: 'Something went wrong approving that batch. Nothing was changed.' }, { status: 500 })
  }
  const out = (rpc.data ?? {}) as Record<string, unknown>
  if (out.ok !== true) {
    // The RPC's own refusals: not_operator, no_caller_identity,
    // wrong_status, sha_mismatch. Surfaced as-is — each one tells the
    // operator something different and actionable.
    return NextResponse.json({
      error: String(out.error ?? 'approve_refused'),
      message: String(out.detail ?? 'That approval was refused.'),
      status: out.status ?? null,
    }, { status: 409 })
  }

  return NextResponse.json({ ok: true, batch_id: batchId, status: 'approved', file_sha256: review.file.sha256 })
}

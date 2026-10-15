import { NextResponse, type NextRequest } from 'next/server'
import { authorizeImportOperator, reviewImportBatch, blockRefusesAction } from '../../../../lib/import-batch-review'

// ════════════════════════════════════════════════════════════════════
// Reject — for a file that validates fine but should not be loaded
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-15. The companion to Return, and deliberately not the
// same action:
//
//   Return  the file was fine and the property moved under it.
//           Reason GENERATED from the row numbers, which are attached.
//   Reject  the file validates and still should not be loaded —
//           wrong property, not what was agreed, a count nobody
//           expected. Reason TYPED by the operator, no rows attached,
//           because there are none.
//
// 🔴 THE REASON IS THE WHOLE MESSAGE. A Return hands the company a list
// they can work through. A Reject hands them one sentence, and it is the
// only thing they are told about a file they spent time preparing. So
// it is required, it is theirs to write, and the RPC refuses one too
// short to carry a thought.
//
// 🔴 AND IT IS HIDDEN WHEN BLOCKED, like Return. Rejecting a batch whose
// company has bulk onboarding switched off tells them to send a
// different file and leaves them unable to send one.

export async function POST(req: NextRequest) {
  const auth = await authorizeImportOperator()
  if (!auth.ok) return NextResponse.json({ error: auth.code, message: auth.message }, { status: auth.status })

  let body: { batch_id?: unknown; reason?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'bad_request', message: 'The request could not be read.' }, { status: 400 })
  }
  const batchId = Number(body.batch_id)
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''

  // Checked here as well as in the RPC so the operator gets the message
  // before the round trip, and so an empty textarea cannot look like a
  // server problem.
  if (reason.length < 10) {
    return NextResponse.json({
      error: 'reason_required',
      message: 'Say what is wrong with the file. This sentence is the only thing the company is told about it.',
    }, { status: 400 })
  }

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
  if (!['submitted', 'approved'].includes(String(review.batch.status))) {
    return NextResponse.json({
      error: 'wrong_status',
      message: String(review.batch.status) === 'loaded'
        ? 'This batch is already loaded. A loaded batch is rolled back, not rejected.'
        : `This batch is ${review.batch.status}. Only a submitted or approved batch can be rejected.`,
      status: review.batch.status,
    }, { status: 409 })
  }

  // 🔴 ONLY THE HARD BLOCK, NOT loadBlocked. A metered tenant cannot
  // be LOADED, and sending the batch back is precisely the right
  // answer for them — "we cannot bulk-load you, your plan bills per
  // permit". Blocking this too would leave the batch stuck with no
  // move anyone could make.
  if (blockRefusesAction('reject', review.block)) {
    return NextResponse.json({
      error: 'blocked',
      message: 'This batch cannot be rejected right now — the company would not be able to send a replacement. Resolve the reasons below first.',
      reasons: review.block.reasons,
    }, { status: 409 })
  }
  if (!['submitted', 'approved'].includes(String(review.batch.status))) {
    return NextResponse.json({
      error: 'wrong_status',
      message: `This batch is ${review.batch.status}. Only a submitted or approved batch can be rejected.`,
    }, { status: 409 })
  }
  // 🔴 A FILE WITH ERRORS GOES BACK AS A RETURN, NOT A REJECT. Return
  // attaches the row numbers the company needs; rejecting it instead
  // would withhold them and leave the operator typing by hand what the
  // server already measured.
  if (review.validation.ran && !review.validation.clean) {
    return NextResponse.json({
      error: 'use_return',
      message: `This file has ${review.validation.error_count} ${review.validation.error_count === 1 ? 'row' : 'rows'} that no longer fit the records at ${review.property.name}. Use "Return to company" so they get the row numbers.`,
      error_count: review.validation.error_count,
    }, { status: 409 })
  }

  const rpc = await auth.asCaller.rpc('reject_import_batch', {
    p_batch_id: batchId,
    p_reason: reason,
  })
  if (rpc.error) {
    console.error('[import-batch/reject] rpc:', rpc.error)
    return NextResponse.json({ error: 'reject_failed', message: 'Something went wrong rejecting that batch. Nothing was changed.' }, { status: 500 })
  }
  const out = (rpc.data ?? {}) as Record<string, unknown>
  if (out.ok !== true) {
    return NextResponse.json({
      error: String(out.error ?? 'reject_refused'),
      message: String(out.detail ?? 'That rejection was refused.'),
    }, { status: 409 })
  }

  return NextResponse.json({
    ok: true, batch_id: batchId, status: 'rejected',
    from_status: out.from_status ?? null, error_count: 0, reason,
  })
}

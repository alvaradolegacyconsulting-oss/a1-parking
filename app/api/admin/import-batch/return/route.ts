import { NextResponse, type NextRequest } from 'next/server'
import {
  authorizeImportOperator, reviewImportBatch, buildReturnReason,
  MAX_STORED_REJECT_ERRORS,
} from '../../../../lib/import-batch-review'

// ════════════════════════════════════════════════════════════════════
// Return to company — the stale outcome, and the review reject
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-15: one click. Sets rejected with an auto-generated
// reason and attaches the fresh row-numbered errors. No new status —
// rejected is what drops the batch out of the live duplicate index,
// which is what makes the fixed file resubmittable.
//
// 🔴 THE ERRORS ARE RE-COMPUTED HERE, NOT TAKEN FROM THE REQUEST. A
// client-supplied error list would be a list the operator's browser
// decided to send, attached to a company's record as if the server had
// found it. The row numbers the CA is told to fix have to be ones this
// request measured.
//
// 🔴 AND A CLEAN BATCH CANNOT BE RETURNED. Return exists to send back a
// file that does not match the records, and its whole payload is the
// row numbers. A clean file has none, so there would be nothing to
// attach and nothing for the CA to fix — they would resubmit the same
// bytes and be refused as a duplicate. If a clean batch needs
// rejecting for some other reason, that is a different action with a
// typed reason, and it does not exist yet.

export async function POST(req: NextRequest) {
  const auth = await authorizeImportOperator()
  if (!auth.ok) return NextResponse.json({ error: auth.code, message: auth.message }, { status: auth.status })

  let body: { batch_id?: unknown; trigger?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'bad_request', message: 'The request could not be read.' }, { status: 400 })
  }
  const batchId = Number(body.batch_id)
  const trigger = body.trigger === 'load' ? 'load' as const : 'review' as const

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
        ? 'This batch is already loaded. A loaded batch is rolled back, not returned.'
        : `This batch is ${review.batch.status}. Only a submitted or approved batch can be returned.`,
      status: review.batch.status,
    }, { status: 409 })
  }

  // 🔴 BLOCKED MEANS NO RETURN, per the ruling, and the reason matters.
  // If bulk onboarding is switched off for the company, returning the
  // batch sends it to a company that cannot resubmit — the CA would see
  // a list of rows to fix and no way to send the fixed file. If the
  // property is inactive, there is nothing for them to fix toward. In
  // both cases the batch stays where it is and the operator resolves
  // the reason first.
  if (review.block.blocked) {
    return NextResponse.json({
      error: 'blocked',
      message: 'This batch cannot be returned right now — the company would not be able to resubmit. Resolve the reasons below first.',
      reasons: review.block.reasons,
    }, { status: 409 })
  }

  if (!review.validation.ran) {
    return NextResponse.json({
      error: 'not_validated',
      message: `${review.validation.why} Returning a batch attaches the rows the company must fix, and there are none to attach.`,
    }, { status: 409 })
  }
  if (review.validation.clean) {
    return NextResponse.json({
      error: 'nothing_to_return',
      message: `This file still matches the records at ${review.property.name}. There are no rows to send back, and resubmitting the same bytes would be refused as a duplicate.`,
    }, { status: 409 })
  }
  const all = review.validation.errors
  const stored = all.slice(0, MAX_STORED_REJECT_ERRORS)
  let reason = buildReturnReason(review, trigger)
  // 🔴 If the list was capped, SAY SO in the reason. A truncated error
  // file that does not announce itself sends the CA to fix some of
  // their rows and resubmit into the same rejection.
  if (stored.length < all.length) {
    reason += ` (${all.length} rows in total; the first ${stored.length} are attached. Fix those, upload again, and the next check will list the rest.)`
  }

  const rpc = await auth.asCaller.rpc('return_import_batch_to_company', {
    p_batch_id: batchId,
    p_reason: reason,
    p_errors: stored,
    p_error_count: all.length,
  })
  if (rpc.error) {
    console.error('[import-batch/return] rpc:', rpc.error)
    return NextResponse.json({ error: 'return_failed', message: 'Something went wrong returning that batch. Nothing was changed.' }, { status: 500 })
  }
  const out = (rpc.data ?? {}) as Record<string, unknown>
  if (out.ok !== true) {
    return NextResponse.json({
      error: String(out.error ?? 'return_refused'),
      message: String(out.detail ?? 'That return was refused.'),
    }, { status: 409 })
  }

  return NextResponse.json({
    ok: true, batch_id: batchId, status: 'rejected',
    from_status: out.from_status ?? null,
    error_count: all.length, errors_attached: stored.length, reason,
  })
}

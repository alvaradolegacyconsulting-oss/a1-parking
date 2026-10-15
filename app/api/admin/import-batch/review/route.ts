import { NextResponse, type NextRequest } from 'next/server'
import { authorizeImportOperator, reviewImportBatch } from '../../../../lib/import-batch-review'

// ════════════════════════════════════════════════════════════════════
// The review screen's verdict — re-validation point 1 of 3
// ════════════════════════════════════════════════════════════════════
// 🔴 THE LIVE RESULT, SHOWN BEFORE THE OPERATOR APPROVES. The
// submit-time verdict is evidence about the file and may be days old;
// the operator is deciding whether it will LOAD, which is a question
// about the property right now. Showing the stored verdict on this
// screen would be worse than showing none, because it is exactly the
// thing the operator would rely on.

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

  return NextResponse.json({
    ok: true,
    batch: review.batch,
    property: review.property,
    company: review.company,
    file: review.file,
    parsed: review.parsed,
    validation: review.validation.ran
      ? {
          ran: true, clean: review.validation.clean, error_count: review.validation.error_count,
          // Capped for the response. The Return action attaches the
          // full list to the row, so the CA is never shown a subset
          // the operator could not see.
          errors: review.validation.errors.slice(0, 500),
          errors_truncated: review.validation.error_count > 500,
        }
      : { ran: false, why: review.validation.why },
    block: review.block,
    can_approve: review.canApprove,
    can_load: review.canLoad,
  })
}

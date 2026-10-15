import { NextResponse, type NextRequest } from 'next/server'
import { authorizeImportOperator } from '../../../../lib/import-batch-review'

// ════════════════════════════════════════════════════════════════════
// Rollback — the same-day undo
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16: same-day, all-or-nothing, refuses if anyone in the
// batch has claimed, refuses if anything references the rows it would
// remove, no partial rollback and no auth-user deletion.
//
// 🔴 IT DOES NOT RE-VALIDATE, AND THAT IS NOT AN OMISSION. The other
// three actions ask "would this file still load", which is a question
// about the file. Rollback asks "can these rows be removed", which is a
// question about the rows. Reading and re-parsing the CSV here would
// make an undo depend on a file whose validity has no bearing on it —
// and a file that had since become unparseable would block an undo for
// a reason unrelated to the undo.
//
// So: the operator gate, the status, and then the RPC, which owns every
// refusal because every one of them needs to be decided in the same
// transaction as the deletes.
//
// 🔴 THE REFUSALS ARE PASSED THROUGH WHOLE. "3 residents have logins"
// is not something anyone can act on; the email and unit of each one
// is. Same for dependents: the table and the row count, not a count.

export async function POST(req: NextRequest) {
  const auth = await authorizeImportOperator()
  if (!auth.ok) return NextResponse.json({ error: auth.code, message: auth.message }, { status: auth.status })

  let body: { batch_id?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'bad_request', message: 'The request could not be read.' }, { status: 400 })
  }
  const batchId = Number(body.batch_id)
  if (!Number.isSafeInteger(batchId) || batchId <= 0) {
    return NextResponse.json({ error: 'bad_batch_id', message: 'That batch could not be identified.' }, { status: 400 })
  }

  // Status first, for the same reason the other three now do it: the
  // cheap unambiguous question before anything interpretable.
  const { data: batch, error: bErr } = await auth.db
    .from('import_batches').select('id, status, loaded_at, property_id').eq('id', batchId).maybeSingle()
  if (bErr) {
    console.error('[import-batch/rollback] batch read:', bErr)
    return NextResponse.json({ error: 'rollback_failed', message: 'Something went wrong reading that batch.' }, { status: 500 })
  }
  if (!batch) return NextResponse.json({ error: 'no_such_batch', message: 'That batch does not exist.' }, { status: 404 })
  if (String(batch.status) !== 'loaded') {
    return NextResponse.json({
      error: 'wrong_status',
      message: String(batch.status) === 'rolled_back'
        ? 'This batch has already been rolled back.'
        : `This batch is ${batch.status}. Only a loaded batch can be rolled back.`,
      status: batch.status,
    }, { status: 409 })
  }

  const rpc = await auth.asCaller.rpc('rollback_import_batch', { p_batch_id: batchId })
  if (rpc.error) {
    console.error('[import-batch/rollback] rpc:', rpc.error)
    return NextResponse.json({
      error: 'rollback_failed',
      message: 'Something went wrong rolling that batch back. Nothing was removed and the batch is still loaded.',
    }, { status: 500 })
  }
  const out = (rpc.data ?? {}) as Record<string, unknown>
  if (out.ok !== true) {
    const code = String(out.error ?? 'rollback_refused')
    return NextResponse.json({
      error: code,
      message: String(out.detail ?? 'That rollback was refused. Nothing was removed.'),
      // Whole, not summarised — see the note above.
      claimed: out.claimed ?? null,
      claimed_count: out.claimed_count ?? null,
      blockers: out.blockers ?? null,
      loaded_on: out.loaded_on ?? null,
      today: out.today ?? null,
      retryable: code === 'rollback_failed',
    }, { status: 409 })
  }

  return NextResponse.json({
    ok: true, batch_id: batchId, status: 'rolled_back',
    residents: out.residents, vehicles: out.vehicles, roles: out.roles,
  })
}

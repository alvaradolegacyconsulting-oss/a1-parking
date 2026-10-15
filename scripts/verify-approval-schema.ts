// ════════════════════════════════════════════════════════════════════
// GATE — the approval-queue schema, exercised rather than read
// ════════════════════════════════════════════════════════════════════
// Execution half of wip-20261015_approval_queue_schema.sql. The SQL
// verification proves the definitions are the ones intended; a
// structural gate cannot see whether a CHECK actually fires, which is
// the whole reason for the pairing.
//
// 🔴 IT RUNS AS service_role BECAUSE THE TABLE FORCES RLS AND HAS NO
// INSERT POLICY. From the SQL editor a probe INSERT would depend on
// whether that role carries BYPASSRLS, and a refused write would read
// as a broken constraint. service_role demonstrably can write here —
// batch 8 exists — so the constraint under test is the only thing that
// can refuse the probe.
//
// 🔴 FRESH PROBE ROWS, NEVER AN EXISTING BATCH. Every row this gate
// touches it inserted, with a random file_sha256 so it cannot collide
// with a real submission's bytes, and it deletes them with RETURNING so
// "cleaned up" is measured rather than assumed. Batch 8 is read for its
// property id and never written.
//
// 🔴 AND IT DISCRIMINATES ON THE CONSTRAINT NAME, NOT THE SQLSTATE.
// 23514 is every CHECK on the table and 23505 is every unique index, so
// "it raised 23514" does not say which rule bit. Each gate asserts the
// name.
//
// Usage: npm run verify:approvalschema

import { createClient, type PostgrestError } from '@supabase/supabase-js'
import fs from 'fs'
import crypto from 'crypto'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const db = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

const probeIds: number[] = []
let cleaned = false
async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') console.error(`\n🔴 cleanup (${why})`)
  if (probeIds.length) {
    // RETURNING, so a silently-filtered delete cannot read as success.
    const r = await db.from('import_batches').delete().in('id', probeIds).select('id')
    const got = (r.data ?? []).length
    if (r.error || got !== probeIds.length) {
      console.error(`   🔴 probe rows: removed ${got}/${probeIds.length}${r.error ? ` — ${r.error.message}` : ''}`); fails++
    } else console.log(`   ↩ removed ${got} probe batch row(s)`)
  }
}
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => { if (dying) return; dying = true
    cleanup(sig).then(() => process.exit(2)).catch(() => process.exit(2)) })
}
process.on('uncaughtException', e => {
  console.error('🔴 uncaught:', (e as Error).message)
  cleanup('uncaughtException').then(() => process.exit(2)).catch(() => process.exit(2))
})

/** The error's constraint name if PostgREST surfaced one, else its text. */
const who = (e: PostgrestError | null) =>
  e ? `${e.code} ${(e.message || '').slice(0, 160)}${e.details ? ` | ${String(e.details).slice(0, 100)}` : ''}` : 'no error'
const names = (e: PostgrestError | null, constraint: string) =>
  !!e && `${e.message} ${e.details ?? ''} ${e.hint ?? ''}`.includes(constraint)

const main = async () => {
  // ── the subject ─────────────────────────────────────────────────
  const { data: companies } = await db.from('companies').select('id,name,company_env').eq('company_env', 'demo')
  const demo = (companies ?? [])[0]
  if (!demo) { console.error("🔴 no company with company_env='demo'. Refusing: probe rows go on a demo property."); process.exit(2) }
  const { data: props } = await db.from('properties').select('id,name').eq('company', demo.name).order('id')
  const prop = (props ?? [])[0]
  if (!prop) { console.error(`🔴 ${demo.name} has no property`); process.exit(2) }
  console.log(`probes on ${demo.name} / ${prop.name} (property ${prop.id})\n`)

  const base = (sha: string) => ({
    company_id: demo.id, property_id: prop.id,
    source_filename: 'zz-probe.csv', storage_path: `${prop.id}/zz-probe.csv`,
    file_sha256: sha,
    attested_by_user_id: crypto.randomUUID(),
    attested_name: 'Probe', attested_title: 'Probe',
    resident_count: 1, vehicle_count: 1,
    status: 'submitted' as string,
  })
  const sha = () => crypto.createHash('sha256').update(`zz-${crypto.randomUUID()}`).digest('hex')
  const insert = async (row: Record<string, unknown>) => {
    const r = await db.from('import_batches').insert(row).select('id').maybeSingle()
    if (r.data?.id) probeIds.push(r.data.id as number)
    return r
  }

  try {
    // ── 🔴 THE MIGRATION IS APPLIED, OR THIS GATE REFUSES ──────────
    // Not "skip if absent": a gate that quietly passes against the old
    // schema is worse than one that fails, because the next person
    // reads green and ships the queue onto a table that cannot hold an
    // approved batch.
    const shaA = sha()
    const probeA = await insert(base(shaA))
    if (probeA.error) {
      console.error(`🔴 could not insert a probe batch at all: ${who(probeA.error)}`)
      await cleanup('end'); process.exit(2)
    }
    const idA = probeA.data!.id as number
    const approve = await db.from('import_batches')
      .update({ status: 'approved', approved_by: crypto.randomUUID(), approved_at: new Date().toISOString() })
      .eq('id', idA).select('id,status').maybeSingle()
    if (approve.error && names(approve.error, 'import_batches_status_allowed')) {
      console.error("🔴 the migration is NOT applied: 'approved' is not in the status allowlist.")
      console.error('   Apply docs/backlog/wip-20261015_approval_queue_schema.sql first. Refusing to report on the old schema.')
      await cleanup('end'); process.exit(2)
    }
    console.log('── part 1: the state between Approve and Load ──')
    chk("🔴 a batch can be set to 'approved'", !approve.error && approve.data?.status === 'approved', who(approve.error))

    // ── part 3: an approval names who and when ─────────────────────
    console.log('\n── part 3: an approval must name who and when ──')
    const shaB = sha()
    const probeB = await insert(base(shaB))
    const bare = await db.from('import_batches').update({ status: 'approved' })
      .eq('id', probeB.data!.id as number).select('id')
    chk('🔴 approving WITHOUT approved_by is refused by import_batches_approval_complete',
      names(bare.error, 'import_batches_approval_complete'),
      who(bare.error) + '\n       (the constraint NAME, not just 23514 — every CHECK on this table raises 23514)')
    const halfWay = await db.from('import_batches')
      .update({ status: 'approved', approved_by: crypto.randomUUID() })
      .eq('id', probeB.data!.id as number).select('id')
    chk('   ...and so is who-without-when',
      names(halfWay.error, 'import_batches_approval_complete'), who(halfWay.error))

    // ── 🔴 part 2: THE DOUBLE-LOAD HOLE ────────────────────────────
    // Row A is 'approved'. A second row with the same bytes on the same
    // property must be refused. Before the migration it would have been
    // ACCEPTED, and loading both would insert every resident twice.
    console.log('\n── 🔴 part 2: an approved batch still blocks a resubmission of the same bytes ──')
    const dup = await insert({ ...base(shaA) })
    chk('🔴 the same (property, sha256) is refused while a batch is approved',
      names(dup.error, 'import_batches_one_live_per_file'),
      who(dup.error) + '\n       this is the silent one: without it the CA resubmits, both rows load, and 228 residents are inserted twice with nothing erroring')

    // 🔴 THE NEGATIVE CONTROL. "Refused" is only correct if it is not
    // refusing everything: a REJECTED file must be fixable and
    // resubmittable, which is the whole premise of "Return to company".
    const toRejected = await db.from('import_batches')
      .update({ status: 'rejected', reject_reason: 'probe: making the file resubmittable' })
      .eq('id', idA).select('id,status').maybeSingle()
    chk('   (control) the probe can be moved to rejected', !toRejected.error, who(toRejected.error))
    const afterReject = await insert({ ...base(shaA) })
    chk('🔴 ...and once rejected, the SAME bytes can be resubmitted',
      !afterReject.error,
      afterReject.error ? who(afterReject.error) + ' — a returned batch the CA cannot resubmit is a dead end' : 'a fixed file is not blocked by the batch it replaces')

    // ── part 4: approved_by is a uuid ──────────────────────────────
    console.log('\n── part 4: approved_by is the approver\'s user id ──')
    const notUuid = await db.from('import_batches')
      .update({ status: 'approved', approved_by: 'jose@example.com', approved_at: new Date().toISOString() })
      .eq('id', probeB.data!.id as number).select('id')
    chk('🔴 an email in approved_by is refused by the type, not silently stored',
      !!notUuid.error && (notUuid.error.code === '22P02' || /invalid input syntax for type uuid/i.test(notUuid.error.message)),
      who(notUuid.error) + '\n       before part 4 this column was TEXT and would have accepted it, making the operator half of a 586-record provenance a mailbox that may later belong to someone else')
    const realUuid = crypto.randomUUID()
    const okUuid = await db.from('import_batches')
      .update({ status: 'approved', approved_by: realUuid, approved_at: new Date().toISOString() })
      .eq('id', probeB.data!.id as number).select('approved_by').maybeSingle()
    chk('   ...and a uuid is stored as given',
      !okUuid.error && String(okUuid.data?.approved_by) === realUuid, who(okUuid.error))

    // ── part 5: the returned error list ────────────────────────────
    console.log('\n── part 5: where the returned error list lives ──')
    const errs = [
      { row: 7, column: 'unit', code: 'unit_prefix', message: 'Write the unit plainly.' },
      { row: 11, column: 'plate', code: 'plate_taken', message: 'That plate is already active here.' },
    ]
    const shaC = sha()
    const probeC = await insert(base(shaC))
    const idC = probeC.data!.id as number
    const good = await db.from('import_batches')
      .update({ status: 'rejected', reject_reason: 'probe', reject_errors: errs, reject_error_count: 2 })
      .eq('id', idC).select('reject_errors,reject_error_count').maybeSingle()
    chk('a complete error list is stored with its count',
      !good.error && (good.data?.reject_errors as unknown[])?.length === 2 && good.data?.reject_error_count === 2,
      who(good.error))
    const truncated = await db.from('import_batches')
      .update({ reject_errors: errs, reject_error_count: 40 })
      .eq('id', idC).select('id')
    chk('a CAPPED list is allowed when the count says so',
      !truncated.error,
      who(truncated.error) + ' — 2 stored of 40 found; the CA must be able to tell a truncated file from a complete one')
    const lying = await db.from('import_batches')
      .update({ reject_errors: errs, reject_error_count: 1 })
      .eq('id', idC).select('id')
    chk('🔴 a count SMALLER than the stored list is refused',
      names(lying.error, 'import_batches_reject_errors_shape'),
      who(lying.error) + ' — the count is the authority; it cannot understate what is attached')
    const countNoList = await db.from('import_batches')
      .update({ reject_errors: null, reject_error_count: 9 })
      .eq('id', idC).select('id')
    chk('🔴 a count with NO list is refused — a claim with no evidence',
      names(countNoList.error, 'import_batches_reject_errors_shape'), who(countNoList.error))
    const neither = await db.from('import_batches')
      .update({ reject_errors: null, reject_error_count: null })
      .eq('id', idC).select('id')
    chk('   ...and both absent is fine (most batches are never returned)',
      !neither.error, who(neither.error))

    // ── the allowlist is exhaustive ────────────────────────────────
    console.log('\n── the allowlist is exhaustive ──')
    const bogus = await db.from('import_batches').update({ status: 'approved_pending_review' })
      .eq('id', idC).select('id')
    chk('🔴 an invented status is refused — an unknown state must fail closed',
      names(bogus.error, 'import_batches_status_allowed'), who(bogus.error))

    // A rejection still needs a reason — unchanged by this migration,
    // and the thing "Return to company" relies on.
    const shaD = sha()
    const probeD = await insert(base(shaD))
    const noReason = await db.from('import_batches').update({ status: 'rejected' })
      .eq('id', probeD.data!.id as number).select('id')
    chk('a rejection with no reason is still refused',
      names(noReason.error, 'import_batches_reject_has_reason'),
      who(noReason.error) + ' — "Return to company" auto-generates one, and this is why it must')

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })

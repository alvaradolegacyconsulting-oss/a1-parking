import 'server-only'
import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseServerClient } from './server-auth'
import { createSupabaseServiceClient } from './supabase-admin'
import { readBulkObject } from './bulk-onboarding-auth'
import { parseBulkCsv, BULK_CSV_COLUMNS } from './bulk-onboarding'
import {
  validateBulkRows, dbFlagErrors,
  type BulkRowInput, type BulkDbFlags, type BulkError,
} from './bulk-validator'

// ════════════════════════════════════════════════════════════════════
// import-batch-review — one re-validation, used at all three points
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-15: re-validate when the operator opens a batch, at
// approve, and at load.
//
// 🔴 ONE FUNCTION FOR ALL THREE, NOT THREE COPIES. The review screen
// that says a batch is loadable and the approve call that acts on it
// must agree, or the operator approves what the screen told them and
// the approval is refused for a reason nobody showed them. That is the
// same failure the preview/submit split was built to avoid, and the
// same discipline: if two surfaces must agree, they call one function.
//
// ── 🔴 WHY RE-VALIDATION IS NEEDED AT ALL, PRECISELY ────────────────
// The validator has two halves and only one of them can go stale:
//
//   field checks (validateBulkRows) — unit shape, state codes,
//     duplicates WITHIN the file. Reads only the file's own bytes,
//     which are immutable and hashed. CANNOT change after submission.
//
//   record collisions (bulk_validate_rows, then dbFlagErrors over its
//     flags) — plate already active here, active at a sibling property,
//     prohibited, email already on file. Live reads of the property.
//     CAN change, and approval may be days after submission.
//
// So "the file was clean at submit" stays true about the FILE forever
// and can stop being true about the PROPERTY. Both halves are re-run
// here anyway: the field half costs nothing and re-running it is how a
// corrupted stored copy would surface.
//
// ── 🔴 AND WHY THIS LIVES IN A ROUTE RATHER THAN THE RPC ────────────
// dbFlagErrors is TypeScript and the file is in storage, where no SQL
// function can read it. So the RPCs cannot re-validate and do not
// pretend to: approve_import_batch enforces the file HASH the operator
// was shown, and the trust boundary for "was it re-validated" is the
// operator's own session. Stated, not implied.
//
// ── 🔴 ABSENCE IS NOT A CLEAN VERDICT ───────────────────────────────
// If the file cannot be downloaded, cannot be parsed, or the database
// half errors, validation comes back `{ ran: false, why }` and both
// canApprove and canLoad are false. A verdict that defaults to clean
// when it could not check is the single worst output this module could
// produce, because "clean" is exactly what the operator is looking for.
// ════════════════════════════════════════════════════════════════════

export interface ImportOperatorOk {
  ok: true
  email: string
  userId: string
  /** service_role — storage and cross-tenant reads. */
  db: SupabaseClient
  /**
   * 🔴 The operator's own session, for bulk_validate_rows.
   * That RPC gates on may_bulk_validate_at(), which resolves the caller
   * from the JWT's email claim. A service_role JWT has none, so a
   * service-role call is refused by the RPC's own gate — measured
   * 2026-10-15, and the same trap that made preview and submit answer
   * 403 to every CA from the day they shipped.
   */
  asCaller: SupabaseClient
}
export interface ImportOperatorErr { ok: false; status: number; code: string; message: string }
export type ImportOperator = ImportOperatorOk | ImportOperatorErr

const no = (status: number, code: string, message: string): ImportOperatorErr =>
  ({ ok: false, status, code, message })

/**
 * An ACTIVE super-admin, or a refusal.
 *
 * 🔴 NOT requireAdmin() FROM server-auth. That helper reads
 * user_roles.role and never looks at is_active, so a deactivated admin
 * still reads as an admin — the same gap step 3 closed in the SQL
 * identity helpers, still open in the TypeScript one. It is used by
 * three unrelated routes and fixing it there is its own decision, so
 * this module does its own read rather than inheriting the gap.
 */
export async function authorizeImportOperator(): Promise<ImportOperator> {
  const sb = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser()
  if (authErr || !user?.email || !user.id) return no(401, 'unauthenticated', 'Please sign in again.')

  const db = createSupabaseServiceClient()
  // No .single(): a second role row would throw rather than decide.
  const want = user.email.trim().toLowerCase()
  const { data: rows, error: roleErr } = await db
    .from('user_roles').select('email, role, is_active')
  if (roleErr) {
    console.error('[import-batch] user_roles read:', roleErr)
    return no(500, 'review_failed', 'Something went wrong. Please try again.')
  }
  const mine = (rows ?? []).filter(r =>
    (r.email ?? '').trim().toLowerCase() === want && r.is_active === true)
  if (!mine.some(r => r.role === 'admin')) {
    return no(403, 'not_operator', 'Only an operator can review import batches.')
  }
  return { ok: true, email: user.email, userId: user.id, db, asCaller: sb }
}

/** Why a batch cannot be loaded right now, regardless of its contents. */
export interface BatchBlock {
  blocked: boolean
  /** Operator-facing, each one actionable or at least explanatory. */
  reasons: string[]
}

export type BatchValidation =
  | { ran: true; clean: boolean; error_count: number; errors: BulkError[] }
  | { ran: false; why: string }

export interface BatchReviewOk {
  ok: true
  batch: Record<string, unknown>
  property: { id: number; name: string; is_active: boolean }
  company: { id: number; name: string; is_active: boolean; account_state: string | null; bulk_onboarding_enabled: boolean }
  file: { bytes: number; sha256: string; matches: boolean }
  parsed: { data_rows: number; resident_count: number; vehicle_count: number } | null
  validation: BatchValidation
  block: BatchBlock
  /** Both require a run validation that is clean, a matching hash, and no block. */
  canApprove: boolean
  canLoad: boolean
}
export type BatchReview = BatchReviewOk | ImportOperatorErr

/**
 * Re-validate one batch against current state.
 *
 * `auth` is passed in so a caller that already authorized does not do
 * it twice — and so approve/return cannot accidentally review as a
 * different identity than the one they then act as.
 */
export async function reviewImportBatch(
  auth: ImportOperatorOk, batchId: number,
): Promise<BatchReview> {
  const { db, asCaller } = auth

  if (!Number.isSafeInteger(batchId) || batchId <= 0) {
    return no(400, 'bad_batch_id', 'That batch could not be identified.')
  }

  const { data: batch, error: bErr } = await db
    .from('import_batches').select('*').eq('id', batchId).maybeSingle()
  if (bErr) {
    console.error('[import-batch] batch read:', bErr)
    return no(500, 'review_failed', 'Something went wrong loading that batch.')
  }
  if (!batch) return no(404, 'no_such_batch', 'That batch does not exist.')

  const [{ data: property }, { data: company }] = await Promise.all([
    db.from('properties').select('id, name, is_active').eq('id', batch.property_id).maybeSingle(),
    db.from('companies').select('id, name, is_active, account_state, bulk_onboarding_enabled')
      .eq('id', batch.company_id).maybeSingle(),
  ])
  // 🔴 ON DELETE RESTRICT on both FKs means neither can be missing. If
  // one is, something is wrong that no operator action should proceed
  // through — so it is a refusal, not a block with a reason.
  if (!property || !company) {
    console.error(`[import-batch] batch ${batchId} references property ${batch.property_id} / company ${batch.company_id}, one of which did not resolve`)
    return no(500, 'review_failed', 'That batch points at a property or company that could not be read. Do not act on it; this needs looking at.')
  }

  // ── 🔴 the block, computed separately from the contents ───────────
  // Ruled 2026-10-15: these are a REASON, not a status. The batch stays
  // where it is and the queue says why it cannot be loaded right now.
  // None of them produces a validation error — the file is still
  // perfectly clean against the property's records — so folding them
  // into "transient" would offer a Retry that succeeds and loads
  // residents into a property nobody can see.
  const reasons: string[] = []
  if (property.is_active !== true) {
    reasons.push(`${property.name} is not active. Loading residents into an inactive property would create records nobody can see.`)
  }
  if (company.is_active !== true) {
    reasons.push(`${company.name} is not active.`)
  }
  if (['suspended', 'cancelled'].includes(String(company.account_state ?? ''))) {
    reasons.push(`${company.name}'s account is ${company.account_state}.`)
  }
  if (company.bulk_onboarding_enabled !== true) {
    reasons.push(`Bulk onboarding is switched off for ${company.name}. Returning the batch would send it to a company that cannot resubmit.`)
  }
  const block: BatchBlock = { blocked: reasons.length > 0, reasons }

  // ── the file, re-read and re-hashed ──────────────────────────────
  const read = await readBulkObject(db, String(batch.storage_path))
  if (!read.ok) {
    return {
      ok: true, batch, property: property as BatchReviewOk['property'],
      company: company as BatchReviewOk['company'],
      file: { bytes: 0, sha256: '', matches: false },
      parsed: null,
      validation: { ran: false, why: `The stored file could not be read (${read.code}). Nothing can be concluded about it.` },
      block, canApprove: false, canLoad: false,
    }
  }
  const sha256 = crypto.createHash('sha256').update(read.bytes).digest('hex')
  const matches = sha256 === String(batch.file_sha256)
  const file = { bytes: read.bytes.length, sha256, matches }

  const base = {
    ok: true as const, batch,
    property: property as BatchReviewOk['property'],
    company: company as BatchReviewOk['company'],
    file, block,
  }

  // 🔴 A HASH MISMATCH IS NOT A VALIDATION RESULT. The bytes under the
  // batch are not the bytes that were attested to, which means the
  // attestation covers a different file. No amount of validating the
  // file that is there now makes that acceptable.
  if (!matches) {
    return {
      ...base, parsed: null,
      validation: { ran: false, why: `The stored file no longer hashes to what was submitted (${sha256.slice(0, 12)}… vs ${String(batch.file_sha256).slice(0, 12)}…). The attestation on this batch covers a different file.` },
      canApprove: false, canLoad: false,
    }
  }

  const parsedCsv = parseBulkCsv(read.text)
  if (!parsedCsv.ok) {
    // The file parsed at submit — submit refuses one that does not — so
    // this means the stored copy is damaged, not that the CA sent
    // something bad.
    return {
      ...base, parsed: null,
      validation: { ran: false, why: `The stored file no longer parses (${parsedCsv.code}: ${parsedCsv.message}). It parsed when it was submitted, so the stored copy is damaged.` },
      canApprove: false, canLoad: false,
    }
  }
  const parsed = {
    data_rows: parsedCsv.dataRows.length,
    resident_count: parsedCsv.residentCount,
    vehicle_count: parsedCsv.vehicleCount,
  }

  // ── the database half, as the caller ─────────────────────────────
  const col = (r: string[], name: typeof BULK_CSV_COLUMNS[number]) =>
    (r[BULK_CSV_COLUMNS.indexOf(name)] ?? '').trim()
  const rpc = await asCaller.rpc('bulk_validate_rows', {
    p_property_id: property.id,
    p_rows: parsedCsv.dataRows.map((r, i) => ({ i, email: col(r, 'email'), plate: col(r, 'plate') })),
  })
  if (rpc.error) {
    return {
      ...base, parsed,
      validation: { ran: false, why: `The record checks could not be run (${rpc.error.message}). Nothing can be concluded about whether this file would still load.` },
      canApprove: false, canLoad: false,
    }
  }
  const flags = (rpc.data ?? []) as BulkDbFlags[]
  if (flags.length !== parsedCsv.dataRows.length) {
    return {
      ...base, parsed,
      validation: { ran: false, why: `The record checks returned ${flags.length} of ${parsedCsv.dataRows.length} rows. A partial check is not a verdict.` },
      canApprove: false, canLoad: false,
    }
  }
  const normByIndex = new Map(flags.map(f => [f.row_index, f.plate_norm]))
  const rows: BulkRowInput[] = parsedCsv.dataRows.map((r, i) => ({
    index: i,
    unit: col(r, 'unit'), first_name: col(r, 'first_name'), last_name: col(r, 'last_name'),
    email: col(r, 'email'), phone: col(r, 'phone'), plate: col(r, 'plate'),
    plate_state: col(r, 'plate_state'), make: col(r, 'make'), model: col(r, 'model'),
    color: col(r, 'color'), tag_number: col(r, 'tag_number'),
    plateNorm: normByIndex.get(i) ?? '',
  }))
  const errors = [...validateBulkRows(rows), ...dbFlagErrors(rows, flags)]
  const validation: BatchValidation = {
    ran: true, clean: errors.length === 0, error_count: errors.length, errors,
  }

  const sound = validation.clean && matches && !block.blocked
  return {
    ...base, parsed, validation,
    canApprove: sound && batch.status === 'submitted',
    canLoad: sound && batch.status === 'approved',
  }
}

/**
 * The reason text a Return writes, generated from the live verdict.
 *
 * 🔴 Generated rather than typed, because the ruling makes Return one
 * click: there is no box for the operator to fill, so the reason has to
 * carry enough for the CA to act without one. It names the count, says
 * the file was fine when sent, and points at the attached rows — the CA
 * needs to know this is not a judgement about them.
 */
export function buildReturnReason(
  review: BatchReviewOk, trigger: 'review' | 'load',
): string {
  const n = review.validation.ran ? review.validation.error_count : 0
  const when = trigger === 'load'
    ? 'When we went to load this file, '
    : 'On review, '
  const plural = n === 1 ? '1 row' : `${n} rows`
  return (
    `${when}${plural} no longer ${n === 1 ? 'matches' : 'match'} the current records at ` +
    `${review.property.name}. This file was clean when you sent it — residents or vehicles ` +
    `have been added at the property since then, so some rows now duplicate what is ` +
    `already on file. The affected row numbers are attached. Fix those rows and upload again; ` +
    `the rest of the file is fine.`
  )
}

/** Cap on the stored error list, with the true count kept separately. */
export const MAX_STORED_REJECT_ERRORS = 2000

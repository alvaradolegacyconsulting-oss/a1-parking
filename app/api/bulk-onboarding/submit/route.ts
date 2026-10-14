import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import {
  BULK_BUCKET, BULK_OBJECT_PATH, MAX_BULK_BYTES, MAX_BULK_ROWS,
  bulkBatchPath, parseBulkCsv,
} from '../../../lib/bulk-onboarding'

// ════════════════════════════════════════════════════════════════════
// Phase A — bulk-onboarding submission
// ════════════════════════════════════════════════════════════════════
// The CA uploads the CSV straight to the bulk-onboarding bucket (RLS
// lets them write only {their property id}/{uuid}.csv), then calls this
// route to turn it into an import_batches row for Jose to approve.
//
// AUTHORIZE SERVER-SIDE; NEVER TRUST THE RENDER. Nothing the client
// sends is used to decide whether the caller may do this:
//
//   identity    getUser(), never getSession — getSession returns
//               whatever is in the cookie without verifying it
//   role        read from user_roles by the authenticated email, and
//               is_active is checked here because requireAuthenticated
//               and get_my_role() both skip it
//   company     derived from that role row, never from the payload
//   the flag    companies.bulk_onboarding_enabled read here, not
//               inferred from the fact that the upload succeeded
//   property    derived from the OBJECT PATH, then checked against the
//               company in the database
//   status      forced to 'submitted'
//
// 🔴 THE PROPERTY COMES FROM THE PATH, AND THE PATH IS STILL A CLAIM.
// Putting the property id in the object path means there is no second
// property identity in the payload that could disagree with it — but
// the path is client-chosen, so the id is then looked up and its
// company compared. The storage policy already refused any other
// property; this route refuses it again rather than inferring that a
// successful upload proves anything.
//
// 🔴 THE HASHED FILE MUST BE THE LOADED FILE. The bytes are hashed,
// copied to batches/{batch_id}.csv, and the copy is re-downloaded and
// re-hashed before the batch points at it. storage_path therefore names
// the location of the hashed bytes at every instant: the CA's upload
// first, the immutable copy once it is proven identical.
//
// Caps are enforced HERE, not borrowed from the bucket. The bucket's
// 2 MB limit and MIME list are a convenience filter — proven this
// morning when a MIME refusal was nearly read as RLS working.

export const runtime = 'nodejs'          // crypto + Buffer
export const maxDuration = 60

const BAD = (status: number, code: string, message: string) =>
  NextResponse.json({ error: code, message }, { status })

// Raw Postgres and storage errors never reach the UI; they are logged
// with the batch context and the caller gets a stable code.
const oops = (where: string, detail: unknown) => {
  console.error(`[bulk-onboarding/submit] ${where}:`, detail)
  return BAD(500, 'submit_failed', 'Something went wrong saving your submission. Nothing was loaded. Please try again, and contact support if it happens twice.')
}

interface Body {
  object_path?: unknown
  source_filename?: unknown
  attested_name?: unknown
  attested_title?: unknown
}

export async function POST(req: NextRequest) {
  // ── 1. identity ───────────────────────────────────────────────────
  const sb = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser()
  if (authErr || !user?.email || !user.id) return BAD(401, 'unauthenticated', 'Please sign in again.')

  const db = createSupabaseServiceClient()

  // ── 2. role + company, from the database ──────────────────────────
  // No .single(): a second role row would make .single() throw rather
  // than decide, and an inactive row must not count. Matching is done
  // in Node on lower(trim(...)) so there is no ILIKE pattern side and
  // no whitespace-sensitive equality — the drift class that has bitten
  // this codebase more than once.
  const want = user.email.trim().toLowerCase()
  const { data: roleRows, error: roleErr } = await db
    .from('user_roles').select('email, role, company, is_active')
  if (roleErr) return oops('user_roles read', roleErr)
  const mine = (roleRows ?? []).filter(r =>
    (r.email ?? '').trim().toLowerCase() === want && r.is_active === true)
  if (mine.length === 0) return BAD(403, 'no_active_role', 'Your account does not have an active role. Please contact support.')
  if (!mine.some(r => r.role === 'company_admin')) {
    return BAD(403, 'not_company_admin', 'Only a company administrator can submit a resident upload.')
  }
  const companyName = (mine.find(r => r.role === 'company_admin')?.company ?? '').trim()
  if (!companyName) return BAD(403, 'no_company', 'Your administrator account is not linked to a company. Please contact support.')

  const { data: companies, error: coErr } = await db
    .from('companies').select('id, name, is_active, account_state, bulk_onboarding_enabled')
  if (coErr) return oops('companies read', coErr)
  const company = (companies ?? []).find(c =>
    (c.name ?? '').trim().toLowerCase() === companyName.toLowerCase())
  if (!company) return oops('company resolve', `role company ${JSON.stringify(companyName)} matches no companies row`)

  // ── 3. the gates, each read here rather than assumed ──────────────
  if (company.is_active !== true || ['suspended', 'cancelled'].includes(company.account_state ?? '')) {
    return BAD(403, 'account_not_active', 'Your account is not active. Please contact support.')
  }
  if (company.bulk_onboarding_enabled !== true) {
    // Stated as a fact, not as a permission the platform is granting.
    return BAD(403, 'bulk_onboarding_not_enabled', 'Bulk resident upload is not switched on for your account. Contact support to have it enabled.')
  }

  // ── 4. the payload ────────────────────────────────────────────────
  let body: Body
  try { body = await req.json() } catch { return BAD(400, 'bad_request', 'The request could not be read.') }

  const objectPath = typeof body.object_path === 'string' ? body.object_path : ''
  const m = BULK_OBJECT_PATH.exec(objectPath)
  if (!m) return BAD(400, 'bad_object_path', 'That upload could not be identified. Please upload the file again.')
  const propertyId = Number(m[1])
  if (!Number.isSafeInteger(propertyId)) return BAD(400, 'bad_object_path', 'That upload could not be identified. Please upload the file again.')

  const attestedName = typeof body.attested_name === 'string' ? body.attested_name.trim() : ''
  const attestedTitle = typeof body.attested_title === 'string' ? body.attested_title.trim() : ''
  if (!attestedName || !attestedTitle) {
    return BAD(400, 'attestation_incomplete', 'Please enter your name and title to confirm the upload.')
  }
  // Cosmetic only — shown on the review screen. The identity of the
  // file is its hash, not its name.
  const sourceFilename = (typeof body.source_filename === 'string' ? body.source_filename : 'upload.csv')
    .replace(/[\r\n\t]/g, ' ').trim().slice(0, 200) || 'upload.csv'

  // ── 5. the property, checked against the company ──────────────────
  const { data: prop, error: propErr } = await db
    .from('properties').select('id, name, company, is_active').eq('id', propertyId).maybeSingle()
  if (propErr) return oops('properties read', propErr)
  // One message for "no such property" and "not yours": a CA must not
  // be able to probe which property ids exist outside their company.
  const propOk = prop
    && prop.is_active === true
    && (prop.company ?? '').trim().toLowerCase() === companyName.toLowerCase()
  if (!propOk) return BAD(403, 'property_not_in_scope', 'That property is not one you can upload for. Please choose a property from the list and try again.')

  // ── 6. the bytes ──────────────────────────────────────────────────
  const dl = await db.storage.from(BULK_BUCKET).download(objectPath)
  if (dl.error || !dl.data) {
    return BAD(404, 'upload_not_found', 'We could not find that upload. Please upload the file again.')
  }
  const bytes = Buffer.from(await dl.data.arrayBuffer())

  // Byte ceiling BEFORE anything reads the content.
  if (bytes.byteLength > MAX_BULK_BYTES) {
    return BAD(413, 'file_too_large', `That file is ${(bytes.byteLength / 1048576).toFixed(1)} MB. The limit is 2 MB — a ${MAX_BULK_ROWS}-row file of this shape is well under it, so a file this size is usually the wrong file.`)
  }
  if (bytes.byteLength === 0) return BAD(400, 'empty_file', 'That file is empty.')

  // Strict UTF-8: a file saved as ANSI or UTF-16 must be rejected, not
  // silently turned into replacement characters inside resident names.
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch {
    return BAD(400, 'not_utf8', 'That file is not saved as UTF-8. In Excel, use "CSV UTF-8 (Comma delimited)" and upload again.')
  }

  // Row cap and header, both before hashing.
  const parsed = parseBulkCsv(text)
  if (!parsed.ok) {
    return BAD(parsed.code === 'too_many_rows' ? 413 : 400, parsed.code, parsed.message)
  }

  // ── 7. the hash ───────────────────────────────────────────────────
  // Over the BYTES, not the decoded text: the hash has to identify the
  // file the customer sent, byte for byte, so that the loader can prove
  // it is loading that same file and not a re-encoded copy of it.
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')

  // ── 8. the batch row, status forced ───────────────────────────────
  // storage_path is the CA's upload for now, which is where the hashed
  // bytes are at this instant. It moves to the immutable copy below,
  // once that copy is proven identical.
  const ins = await db.from('import_batches').insert({
    company_id: company.id,
    property_id: propertyId,
    source_filename: sourceFilename,
    storage_path: objectPath,
    file_sha256: sha256,
    attested_by_user_id: user.id,
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

  // ── 9. the immutable copy, verified ───────────────────────────────
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
    .upload(immutable, bytes, { contentType: 'text/csv', upsert: false })
  if (copy.error) return undo('immutable copy', copy.error)

  const back = await db.storage.from(BULK_BUCKET).download(immutable)
  if (back.error || !back.data) return undo('immutable copy read-back', back.error)
  const copiedSha = crypto.createHash('sha256')
    .update(Buffer.from(await back.data.arrayBuffer())).digest('hex')
  if (copiedSha !== sha256) {
    return undo('immutable copy hash mismatch', `wrote ${sha256}, read back ${copiedSha}`)
  }

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
    resident_count: parsed.residentCount,
    vehicle_count: parsed.vehicleCount,
    file_sha256: sha256,
  })
}

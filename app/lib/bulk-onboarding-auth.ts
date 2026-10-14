import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseServerClient } from './server-auth'
import { createSupabaseServiceClient } from './supabase-admin'
import { BULK_BUCKET, BULK_OBJECT_PATH, MAX_BULK_BYTES } from './bulk-onboarding'

// The authorization both bulk-onboarding routes share.
//
// 🔴 ONE COPY, BECAUSE PREVIEW AND SUBMIT MUST AGREE. A preview that
// clears a file the submission would refuse — or the reverse — is worse
// than either refusing: the customer fixes what the preview told them
// to, resubmits, and is refused again for a reason nobody showed them.
// Two inline copies of a nine-step gate is how that happens.
//
// AUTHORIZE SERVER-SIDE; NEVER TRUST THE RENDER:
//
//   identity    getUser(), never getSession — getSession returns
//               whatever is in the cookie without verifying it
//   role        read from user_roles by the authenticated email, with
//               is_active enforced here because requireAuthenticated
//               and get_my_role() both skip it, so a deactivated CA row
//               still reads as company_admin
//   company     derived from that role row, never from the payload
//   the flag    companies.bulk_onboarding_enabled read here, not
//               inferred from the upload having succeeded
//   property    derived from the OBJECT PATH, then looked up and its
//               company compared — the path is client-chosen, so it is
//               a claim, not a fact
//
// Company names are compared with equality on lower(trim(...)) in Node
// rather than ILIKE: there is no pattern side to escape, and trim()
// covers the trailing-whitespace class.

export interface BulkCompanyOk {
  ok: true
  email: string
  userId: string
  company: { id: number; name: string }
  db: SupabaseClient
}
export interface BulkAuthOk extends BulkCompanyOk {
  property: { id: number; name: string }
  objectPath: string
}
export interface BulkAuthErr { ok: false; status: number; code: string; message: string }
export type BulkAuth = BulkAuthOk | BulkAuthErr
export type BulkCompany = BulkCompanyOk | BulkAuthErr

const no = (status: number, code: string, message: string): BulkAuthErr => ({ ok: false, status, code, message })

/**
 * Everything up to and including the flag — no object path involved.
 *
 * Split out so the page's context endpoint runs the IDENTICAL gate
 * rather than a lookalike. A context call that says "enabled" where
 * the upload would refuse is how a customer ends up staring at a form
 * that cannot submit.
 */
export async function authorizeBulkCompany(): Promise<BulkCompany> {
  const sb = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser()
  if (authErr || !user?.email || !user.id) return no(401, 'unauthenticated', 'Please sign in again.')

  const db = createSupabaseServiceClient()

  // No .single(): a second role row would make it throw rather than
  // decide, and an inactive row must not count.
  const want = user.email.trim().toLowerCase()
  const { data: roleRows, error: roleErr } = await db
    .from('user_roles').select('email, role, company, is_active')
  if (roleErr) {
    console.error('[bulk-onboarding] user_roles read:', roleErr)
    return no(500, 'submit_failed', 'Something went wrong. Please try again.')
  }
  const mine = (roleRows ?? []).filter(r =>
    (r.email ?? '').trim().toLowerCase() === want && r.is_active === true)
  if (mine.length === 0) return no(403, 'no_active_role', 'Your account does not have an active role. Please contact support.')
  const caRow = mine.find(r => r.role === 'company_admin')
  if (!caRow) return no(403, 'not_company_admin', 'Only a company administrator can upload residents.')
  const companyName = (caRow.company ?? '').trim()
  if (!companyName) return no(403, 'no_company', 'Your administrator account is not linked to a company. Please contact support.')

  const { data: companies, error: coErr } = await db
    .from('companies').select('id, name, is_active, account_state, bulk_onboarding_enabled')
  if (coErr) {
    console.error('[bulk-onboarding] companies read:', coErr)
    return no(500, 'submit_failed', 'Something went wrong. Please try again.')
  }
  const company = (companies ?? []).find(c =>
    (c.name ?? '').trim().toLowerCase() === companyName.toLowerCase())
  if (!company) {
    console.error(`[bulk-onboarding] role company ${JSON.stringify(companyName)} matches no companies row`)
    return no(500, 'submit_failed', 'Something went wrong. Please try again.')
  }
  if (company.is_active !== true || ['suspended', 'cancelled'].includes(company.account_state ?? '')) {
    return no(403, 'account_not_active', 'Your account is not active. Please contact support.')
  }
  if (company.bulk_onboarding_enabled !== true) {
    // A fact about the account, not a permission the platform is granting.
    return no(403, 'bulk_onboarding_not_enabled', 'Bulk resident upload is not switched on for your account. Contact support to have it enabled.')
  }

  return { ok: true, email: user.email, userId: user.id,
           company: { id: company.id as number, name: company.name as string }, db }
}

/**
 * The same gate, plus the property derived from the object path.
 *
 * 🔴 THE PATH IS A CLAIM. Putting the property id in it means there is
 * no second property identity in the payload that could disagree — but
 * it is still client-chosen, so the id is looked up and its company
 * compared. A successful upload is not taken as proof of anything.
 */
export async function authorizeBulkUpload(objectPathRaw: unknown): Promise<BulkAuth> {
  const auth = await authorizeBulkCompany()
  if (!auth.ok) return auth
  const { db, company } = auth
  const companyName = company.name.trim()

  const objectPath = typeof objectPathRaw === 'string' ? objectPathRaw : ''
  const m = BULK_OBJECT_PATH.exec(objectPath)
  if (!m) return no(400, 'bad_object_path', 'That upload could not be identified. Please upload the file again.')
  const propertyId = Number(m[1])
  if (!Number.isSafeInteger(propertyId)) return no(400, 'bad_object_path', 'That upload could not be identified. Please upload the file again.')

  const { data: prop, error: propErr } = await db
    .from('properties').select('id, name, company, is_active').eq('id', propertyId).maybeSingle()
  if (propErr) {
    console.error('[bulk-onboarding] properties read:', propErr)
    return no(500, 'submit_failed', 'Something went wrong. Please try again.')
  }
  // One message for "no such property" and "not yours", so a CA cannot
  // probe which property ids exist outside their company.
  const ok = prop && prop.is_active === true
    && (prop.company ?? '').trim().toLowerCase() === companyName.toLowerCase()
  if (!ok) return no(403, 'property_not_in_scope', 'That property is not one you can upload for. Please choose a property from the list and try again.')

  return {
    ...auth,
    property: { id: prop!.id as number, name: prop!.name as string },
    objectPath,
  }
}

export type BulkBytes =
  | { ok: true; bytes: Buffer; text: string }
  | BulkAuthErr

/**
 * Fetch and decode the uploaded object.
 *
 * The caps are enforced HERE, not borrowed from the bucket's 2 MB
 * limit and MIME list — those are a convenience filter, as the storage
 * hotfix proved when a MIME refusal was nearly read as RLS working.
 */
export async function readBulkObject(db: SupabaseClient, objectPath: string): Promise<BulkBytes> {
  const dl = await db.storage.from(BULK_BUCKET).download(objectPath)
  if (dl.error || !dl.data) return no(404, 'upload_not_found', 'We could not find that upload. Please upload the file again.')
  const bytes = Buffer.from(await dl.data.arrayBuffer())

  if (bytes.byteLength === 0) return no(400, 'empty_file', 'That file is empty.')
  if (bytes.byteLength > MAX_BULK_BYTES) {
    return no(413, 'file_too_large', `That file is ${(bytes.byteLength / 1048576).toFixed(1)} MB. The limit is 2 MB — a 1,000-row file of this shape is well under it, so a file this size is usually the wrong file.`)
  }

  // Strict UTF-8: a file saved as ANSI or UTF-16 is rejected, not
  // silently turned into replacement characters inside resident names.
  try {
    return { ok: true, bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return no(400, 'not_utf8', 'That file is not saved as UTF-8. In Excel, use "CSV UTF-8 (Comma delimited)" and upload again.')
  }
}

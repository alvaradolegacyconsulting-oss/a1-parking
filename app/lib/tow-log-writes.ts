// ════════════════════════════════════════════════════════════════════
// Tow Log write layer — Commit 5.
//
// The ONLY place the tow-log RPCs are called from. Surfaces (mobile
// create screen now, desktop tab in Commit 6) own their UI; this file
// owns the call shapes, the upload sequence and the error vocabulary.
// Same split as manager-crm-writes.ts: atomic writes, NO setters, NO
// alerts, NO refetch.
//
// ── 🔴 SIGNATURE PINNING — READ BEFORE EDITING A CALL ────────────────
// record_vehicle_removal currently has FIFTEEN parameters:
//   p_property, p_plate, p_reason_code, p_towed_at,
//   p_authorized_by_email, p_tow_operator_id, p_plate_state, p_make,
//   p_model, p_color, p_reason_notes, p_space_id,
//   p_authorized_by_name, p_removal_type, p_notes
// Current definition: migrations/20260910_record_vehicle_removal_plate_
// normalize_fix.sql. The signature was established by
// migrations/20260909_tow_log_vehicle_removals_notes_column.sql, which
// DROPPED the earlier 14-arg form.
//
// That signature has ALREADY CHANGED ONCE, and on 2026-09-10 both forms
// were briefly live at the same time — PostgREST answered
// `PGRST203 Could not choose the best candidate function` for every call
// that omitted p_notes. If calls from this file start failing with
// PGRST203 or "function not found", check the CATALOG first:
//
//   SELECT oid, pg_get_function_identity_arguments(oid), pronargs
//     FROM pg_proc
//    WHERE pronamespace = 'public'::regnamespace
//      AND proname = 'record_vehicle_removal';
//   -- expect exactly ONE row, pronargs = 15
//
// A future signature change MUST update this file in the same arc.
// PostgREST resolves by named arguments, so an added parameter with a
// DEFAULT is silent here until it isn't.
//
// ── 🔴 TIER GATE IS NARROWER HERE THAN IN THE DATABASE ──────────────
// The RPCs gate on my_tier_pm_capable(), which returns TRUE for
// legacy, pm_only AND pm_starter (20260903_track_gating_helper.sql:194).
// The CLIENT renders the tow log for pm_starter and pm_only ONLY —
// see REMOVAL_UI_TIERS below.
//
// The divergence is DELIBERATE, not drift. A1 is `legacy` and already
// produces tow tickets through enforcement; showing them a second
// surface that logs the same event would duplicate their workflow. The
// capability stays available in the database so turning it on for a
// legacy customer is a one-line UI change and no migration.
//
// DO NOT "fix" the mismatch in either direction without that decision
// being revisited. The same note is carried in the tier branch of
// my_tier_pm_capable(); they must be changed together or not at all.
//
// ── BOUNDARY (DECISION_tow_log_is_a_log_sept9_2026) ─────────────────
// This is a LOG, not enforcement tooling. Nothing here may grow storage
// location, fees, a resident- or owner-facing view, or language framing
// a record as evidence or compliance. The boundary erodes one
// reasonable-looking field at a time.
//   · `notes` is INTERNAL, manager-only. Never rendered to a resident
//     or vehicle owner.
//   · `reason_notes` explains WHY the removal happened and is required
//     when reason_code = 'other'.
// ════════════════════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js'
import { TOW_REASONS, OTHER_NOTE_MIN_LENGTH, type TowReason } from './tow-reasons'
import { normalizePlate } from './plate'

// ════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════

// Bucket from 20260907_tow_log_storage_bucket.sql. Private, 15 MB
// ceiling enforced BY THE BUCKET (not a UI label), and it accepts only
// image/jpeg, image/png, image/webp, application/pdf.
export const TOW_LOG_BUCKET = 'vehicle-removal-photos'

// Tiers that RENDER the tow log. Narrower than the RPC gate on purpose
// — see the header. Changing this is a product decision, not a cleanup.
export const REMOVAL_UI_TIERS: ReadonlySet<string> = new Set(['pm_starter', 'pm_only'])

export function tierCanSeeTowLog(tier: string | null | undefined): boolean {
  return !!tier && REMOVAL_UI_TIERS.has(tier)
}

// removal_type values accepted by the RPC and by the vehicle_removals
// CHECK constraint (20260909_tow_log_vehicle_removals.sql:247).
export const REMOVAL_TYPES = ['tow', 'boot', 'relocation'] as const
export type RemovalType = typeof REMOVAL_TYPES[number]

// media kind values accepted by attach_removal_media.
export const MEDIA_KINDS = ['photo', 'ticket', 'receipt'] as const
export type MediaKind = typeof MEDIA_KINDS[number]

// ── Reason vocabulary ───────────────────────────────────────────────
// 🔴 REUSED, NOT REDEFINED. app/lib/tow-reasons.ts already documents a
// deliberate two-vocabulary split (violations.violation_type vs
// violations.decline_reason) and the reporting cost it carries: a query
// that touches one column undercounts. A THIRD list keyed to
// vehicle_removals.reason_code would repeat that cost, and the reason
// list is a compliance posture — "adding a non-standard reason is a
// legal-counsel question, not a product feature."
//
// So this is a FILTER over the canonical list, never a copy.
// EXCLUDED_REMOVAL_REASONS is empty today: every code in TOW_REASONS is
// reachable for a PM-initiated removal (a PM tows for fire lane,
// handicap, reserved, abandoned, no permit, expired pass, all of it).
// ⚠ A narrower PM subset was specified for this screen; narrowing it is
// one line here once the exclusion list is decided. Do NOT narrow by
// inventing a new array.
export const EXCLUDED_REMOVAL_REASONS: ReadonlySet<string> = new Set([])

export const REMOVAL_REASONS: ReadonlyArray<TowReason> =
  TOW_REASONS.filter(r => !EXCLUDED_REMOVAL_REASONS.has(r.code))

export { OTHER_NOTE_MIN_LENGTH }

// ════════════════════════════════════════════════════════════════════
// Result shapes
// ════════════════════════════════════════════════════════════════════

export type WriteFailure = {
  ok: false
  // Machine code. Either the RPC's own `{error: '...'}` value, or a
  // transport-level code we synthesize. Log this; never render it.
  code: string
  // Plain language, safe to put in front of a manager on a phone.
  message: string
  // Extra fields the RPC returned alongside the error (e.g.
  // expected_prefix on path_mismatch). Console only.
  detail?: Record<string, unknown>
}

export type RecordRemovalSuccess = { ok: true; id: number }
export type TowOperatorSuccess   = { ok: true; id: number; created: boolean }
export type AttachMediaSuccess   = { ok: true; id: number }

export type TowOperator = {
  id: number
  name: string
  phone: string | null
  tdlr_license_number: string | null
  is_active: boolean
}

// ════════════════════════════════════════════════════════════════════
// Error vocabulary
//
// Every code below is engineer-facing. A raw code on a customer surface
// is the defect, not the error it describes — same lesson as the Sept 4
// property-cap copy. Callers render `message` and console.error `code`.
// ════════════════════════════════════════════════════════════════════

const FRIENDLY: Record<string, string> = {
  // auth / role / tier
  unauthenticated:      'Your session has expired. Sign in again and retry.',
  no_role_assigned:     'Your account has no role assigned yet. Ask your administrator to finish setting it up.',
  role_not_authorized:  'Your role cannot record vehicle removals.',
  tier_not_permitted:   'Recording vehicle removals is not included in your current plan.',
  no_company_context:   'We could not tell which company your account belongs to. Ask your administrator to check your access.',

  // property scope
  property_required:                    'Pick a property before saving.',
  property_not_found:                   'That property was not found. Refresh and try again.',
  property_not_authorized_for_manager:  'You are not assigned to that property.',

  // the record itself
  plate_required:               'Enter a license plate with at least one letter or number.',
  reason_code_required:         'Pick a reason for the removal.',
  reason_notes_required:        `When the reason is Other, describe it in at least ${OTHER_NOTE_MIN_LENGTH} characters.`,
  towed_at_required:            'Enter when the vehicle was removed.',
  towed_at_future:              'The removal time is in the future. Check the date and time.',
  authorized_by_email_required: 'Enter who authorized the removal.',
  invalid_removal_type:         'Pick whether this was a tow, a boot, or a relocation.',

  // tow operator
  tow_operator_id_required:  'Pick who removed the vehicle.',
  tow_operator_not_found:    'That tow operator no longer exists. Pick another or add a new one.',
  tow_operator_inactive:     'That tow operator has been deactivated. Pick another or add a new one.',
  tow_operator_out_of_scope: 'That tow operator belongs to another company.',
  invalid_name:              'That operator name contains characters we cannot store. Remove %, _ and \\ and try again.',
  name_required:             'Enter the tow operator name.',

  // media
  removal_id_required:          'We lost track of which record these photos belong to. Reload and attach them again.',
  storage_path_required:        'The upload did not return a file location. Try attaching the photo again.',
  invalid_kind:                 'That attachment type is not supported.',
  removal_not_found:            'That removal record no longer exists.',
  removal_property_id_missing:  'That removal record is missing its property. Contact support before attaching photos.',
  out_of_scope:                 'That record belongs to a property you are not assigned to.',
  path_mismatch:                'The photo could not be linked to this record. It is saved but not attached — contact support.',

  // transport
  network_error:      'We could not reach the server. Check your connection and try again.',
  unexpected_error:   'Something went wrong saving this record. Nothing was saved — try again.',
  upload_failed:      'The photo could not be uploaded. The removal record was saved without it.',
  image_unsupported:  'That image format could not be read. Take the photo again with the camera.',
}

export function friendlyRemovalError(code: string): string {
  return FRIENDLY[code] ?? FRIENDLY.unexpected_error
}

// ── Response normalizer ─────────────────────────────────────────────
// The RPCs speak TWO shapes and a caller must handle both:
//   1. `{error: 'code'}` RETURNED as data — role, scope, validation.
//   2. A RAISED exception — tier_not_permitted (sqlstate 42501, message
//      is exactly 'tier_not_permitted'), and the grant-layer 42501 an
//      anon caller gets ('permission denied for function ...').
// sqlstate 42501 is shared across those causes, so we discriminate on
// message text, never on the code alone.
function normalizeRpcResult<T>(
  data: any,
  error: any,
  logTag: string,
  onOk: (data: any) => T,
): T | WriteFailure {
  if (error) {
    const raw = String(error.message ?? '')
    console.error(`[tow-log] ${logTag} raised`, { code: error.code, message: raw, details: error.details })
    if (raw.includes('tier_not_permitted')) {
      return { ok: false, code: 'tier_not_permitted', message: friendlyRemovalError('tier_not_permitted') }
    }
    if (raw.includes('permission denied for function')) {
      return { ok: false, code: 'unauthenticated', message: friendlyRemovalError('unauthenticated') }
    }
    if (error.code === 'PGRST203') {
      // The Sept 10 failure mode. Distinct message so it is diagnosable
      // from a screenshot instead of looking like a generic outage.
      console.error('[tow-log] PGRST203 — more than one record_vehicle_removal signature is live. See the SIGNATURE PINNING note at the top of app/lib/tow-log-writes.ts.')
      return { ok: false, code: 'signature_ambiguous', message: friendlyRemovalError('unexpected_error') }
    }
    return { ok: false, code: error.code ?? 'network_error', message: friendlyRemovalError('network_error') }
  }

  if (data && typeof data === 'object' && 'error' in data) {
    const code = String((data as any).error)
    const { error: _drop, ...detail } = data as Record<string, unknown>
    console.error(`[tow-log] ${logTag} rejected`, { code, ...detail })
    return {
      ok: false,
      code,
      message: friendlyRemovalError(code),
      detail: Object.keys(detail).length > 0 ? detail : undefined,
    }
  }

  return onOk(data)
}

// ════════════════════════════════════════════════════════════════════
// Tow operators
// ════════════════════════════════════════════════════════════════════

// RLS-scoped SELECT — manager sees their own company's operators
// (manager_own_tow_operators policy). Active only; the picker never
// offers a deactivated operator, and the RPC would refuse it anyway
// with tow_operator_inactive.
export async function listTowOperators(supabase: SupabaseClient): Promise<TowOperator[]> {
  const { data, error } = await supabase
    .from('tow_operators')
    .select('id, name, phone, tdlr_license_number, is_active')
    .eq('is_active', true)
    .order('name')
  if (error) {
    console.error('[tow-log] listTowOperators failed', error)
    return []
  }
  return (data ?? []) as TowOperator[]
}

// find-or-create. A repeated name returns the EXISTING id with
// created:false (proven by E2 of the Commit 2 execution verification),
// so the surface must say "using your saved <name>" rather than letting
// the manager believe a second operator was added.
export async function createTowOperator(
  supabase: SupabaseClient,
  input: { name: string; phone?: string | null; tdlr?: string | null; notes?: string | null },
): Promise<TowOperatorSuccess | WriteFailure> {
  const name = input.name.trim()
  if (!name) {
    return { ok: false, code: 'name_required', message: friendlyRemovalError('name_required') }
  }
  const { data, error } = await supabase.rpc('create_tow_operator', {
    p_name:  name,
    p_phone: input.phone?.trim() || null,
    p_tdlr:  input.tdlr?.trim()  || null,
    p_notes: input.notes?.trim() || null,
  })
  return normalizeRpcResult(data, error, 'create_tow_operator', d => ({
    ok: true as const,
    id: Number(d.id),
    created: d.created === true,
  }))
}

// ════════════════════════════════════════════════════════════════════
// The removal record
// ════════════════════════════════════════════════════════════════════

export type RecordRemovalInput = {
  property: string
  plate: string
  reasonCode: string
  towedAt: Date
  authorizedByEmail: string
  towOperatorId: number
  removalType?: RemovalType
  plateState?: string | null
  make?: string | null
  model?: string | null
  color?: string | null
  reasonNotes?: string | null
  spaceId?: number | null
  authorizedByName?: string | null
  notes?: string | null
}

// Client-side pre-checks that mirror the RPC's own validation. These
// exist to give a faster, kinder answer — NOT to replace the server
// gate. Every one of them is enforced again in the database.
export function validateRemovalInput(input: RecordRemovalInput): WriteFailure | null {
  const fail = (code: string): WriteFailure => ({ ok: false, code, message: friendlyRemovalError(code) })
  if (!input.property?.trim())                     return fail('property_required')
  if (!normalizePlate(input.plate))                return fail('plate_required')
  if (!input.reasonCode?.trim())                   return fail('reason_code_required')
  if (input.reasonCode === 'other' &&
      (input.reasonNotes ?? '').trim().length < OTHER_NOTE_MIN_LENGTH) return fail('reason_notes_required')
  if (!input.towedAt || Number.isNaN(input.towedAt.getTime())) return fail('towed_at_required')
  // The RPC allows 5 minutes of clock skew; mirror that exactly so the
  // client never rejects something the server would have accepted.
  if (input.towedAt.getTime() > Date.now() + 5 * 60 * 1000) return fail('towed_at_future')
  if (!input.authorizedByEmail?.trim())            return fail('authorized_by_email_required')
  if (!input.towOperatorId)                        return fail('tow_operator_id_required')
  if (input.removalType && !REMOVAL_TYPES.includes(input.removalType)) return fail('invalid_removal_type')
  return null
}

export async function recordVehicleRemoval(
  supabase: SupabaseClient,
  input: RecordRemovalInput,
): Promise<RecordRemovalSuccess | WriteFailure> {
  const preflight = validateRemovalInput(input)
  if (preflight) return preflight

  // 🔴 FIFTEEN named parameters — see SIGNATURE PINNING at the top.
  // Every optional one is passed EXPLICITLY as null rather than
  // omitted: PostgREST resolves overloads by the set of argument names,
  // so always sending the full set keeps resolution unambiguous even if
  // a differently-shaped signature reappears.
  const { data, error } = await supabase.rpc('record_vehicle_removal', {
    p_property:             input.property.trim(),
    // The RPC normalizes the plate itself as of 2026-09-10 and inserts
    // the normalized value. Normalizing here too keeps what the manager
    // sees identical to what gets stored.
    p_plate:                normalizePlate(input.plate),
    p_reason_code:          input.reasonCode.trim(),
    p_towed_at:             input.towedAt.toISOString(),
    p_authorized_by_email:  input.authorizedByEmail.trim(),
    p_tow_operator_id:      input.towOperatorId,
    p_plate_state:          input.plateState?.trim()       || null,
    p_make:                 input.make?.trim()             || null,
    p_model:                input.model?.trim()            || null,
    p_color:                input.color?.trim()            || null,
    p_reason_notes:         input.reasonNotes?.trim()      || null,
    p_space_id:             input.spaceId ?? null,
    p_authorized_by_name:   input.authorizedByName?.trim() || null,
    p_removal_type:         input.removalType ?? 'tow',
    p_notes:                input.notes?.trim()            || null,
  })

  return normalizeRpcResult(data, error, 'record_vehicle_removal', d => ({
    ok: true as const,
    id: Number(d.id),
  }))
}

// ════════════════════════════════════════════════════════════════════
// Media
// ════════════════════════════════════════════════════════════════════

// Long edge and quality tuned for a lead on weak LTE at 11pm. A 4032px
// iPhone photo lands around 300-500 KB here instead of 6-8 MB. The
// bucket's 15 MB ceiling should only ever be reached by a PDF.
const MAX_LONG_EDGE = 1600
const JPEG_QUALITY  = 0.8
// Below this, re-encoding buys nothing worth the CPU on an old phone.
const SKIP_DOWNSCALE_BELOW_BYTES = 400 * 1024

// Canvas re-encode. Also normalizes format: the bucket accepts only
// jpeg/png/webp/pdf, and an iPhone HEIC that Safari can decode comes
// back out of here as JPEG. If the browser cannot decode it at all we
// return null and the caller reports image_unsupported rather than
// uploading something the bucket will reject with a raw storage error.
export async function downscaleImage(file: File): Promise<File | null> {
  if (typeof document === 'undefined') return file
  if (!file.type.startsWith('image/')) return file          // PDFs pass through
  if (file.size < SKIP_DOWNSCALE_BELOW_BYTES && file.type === 'image/jpeg') return file

  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement | null>(resolve => {
      const el = new Image()
      el.onload  = () => resolve(el)
      el.onerror = () => resolve(null)
      el.src = url
    })
    if (!img || !img.width || !img.height) return null

    const scale = Math.min(1, MAX_LONG_EDGE / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width  = Math.round(img.width  * scale)
    canvas.height = Math.round(img.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(b => resolve(b), 'image/jpeg', JPEG_QUALITY))
    if (!blob) return null

    const base = file.name.replace(/\.[^.]+$/, '')
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg' })
  } catch (e) {
    console.error('[tow-log] downscaleImage failed', e)
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function attachRemovalMedia(
  supabase: SupabaseClient,
  input: { removalId: number; storagePath: string; kind: MediaKind },
): Promise<AttachMediaSuccess | WriteFailure> {
  const { data, error } = await supabase.rpc('attach_removal_media', {
    p_removal_id:   input.removalId,
    p_storage_path: input.storagePath,
    p_kind:         input.kind,
  })
  return normalizeRpcResult(data, error, 'attach_removal_media', d => ({
    ok: true as const,
    id: Number(d.id),
  }))
}

export type MediaUploadOutcome = {
  attached: number
  failures: { fileName: string; code: string; message: string }[]
}

// ── 🔴 ORDER IS LOAD-BEARING: row → upload → attach ─────────────────
// The removal row must exist first, because its id is half the storage
// path AND attach_removal_media validates that prefix. An orphaned file
// sitting under a known removal id is recoverable by hand; a removal
// row that failed to save with photos already uploaded under an id that
// does not exist is not.
//
// A media failure NEVER fails the removal. The record is the thing that
// matters; photos are supporting material. Callers report the partial
// outcome and leave the record standing.
export async function uploadRemovalMedia(
  supabase: SupabaseClient,
  input: {
    propertyId: number
    removalId: number
    files: File[]
    kind?: MediaKind
    onProgress?: (done: number, total: number) => void
  },
): Promise<MediaUploadOutcome> {
  const kind = input.kind ?? 'photo'
  const outcome: MediaUploadOutcome = { attached: 0, failures: [] }
  const stamp = Date.now()

  for (let i = 0; i < input.files.length; i++) {
    const original = input.files[i]
    input.onProgress?.(i, input.files.length)

    const prepared = await downscaleImage(original)
    if (!prepared) {
      outcome.failures.push({ fileName: original.name, code: 'image_unsupported', message: friendlyRemovalError('image_unsupported') })
      continue
    }

    const ext  = (prepared.name.split('.').pop() || 'jpg').toLowerCase()
    // Exactly the prefix attach_removal_media recomputes and checks:
    //   <property_id>/<removal_id>/
    const path = `${input.propertyId}/${input.removalId}/${stamp}-${i + 1}.${ext}`

    const { error: upErr } = await supabase.storage
      .from(TOW_LOG_BUCKET)
      .upload(path, prepared, { contentType: prepared.type, upsert: false })
    if (upErr) {
      console.error('[tow-log] storage upload failed', { path, message: upErr.message })
      outcome.failures.push({ fileName: original.name, code: 'upload_failed', message: friendlyRemovalError('upload_failed') })
      continue
    }

    const attached = await attachRemovalMedia(supabase, { removalId: input.removalId, storagePath: path, kind })
    if (!attached.ok) {
      // path_mismatch means the file IS uploaded but unreferenced. The
      // RPC hands back expected_prefix — console only; a storage prefix
      // is not something to show a manager on a phone.
      if (attached.code === 'path_mismatch') {
        console.error('[tow-log] path_mismatch — file uploaded but not attached', {
          path, expected_prefix: attached.detail?.expected_prefix,
        })
      }
      outcome.failures.push({ fileName: original.name, code: attached.code, message: attached.message })
      continue
    }
    outcome.attached++
  }

  input.onProgress?.(input.files.length, input.files.length)
  return outcome
}

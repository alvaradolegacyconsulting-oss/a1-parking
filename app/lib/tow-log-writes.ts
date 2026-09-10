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
// 🔴 THERE IS NO PM SUBSET, AND THERE SHOULD NOT BE ONE.
// A property manager authorizes a removal for a fire lane, a handicap
// space, a reserved space, an abandoned vehicle, no permit, an expired
// pass — every code in TOW_REASONS applies. Excluding any of them does
// not shorten the list for the manager who needs the excluded one; it
// makes them pick something false, and a wrong reason on a record that
// may end up in a defense file is worse than a longer list.
//
// The vocabulary is SHARED with the enforcement side deliberately.
// app/lib/tow-reasons.ts documents a two-vocabulary split
// (violations.violation_type vs violations.decline_reason) and the
// reporting cost it carries: a query touching one column undercounts.
// A THIRD list keyed to vehicle_removals.reason_code would repeat that
// cost for no gain — and the list is a compliance posture, since
// "adding a non-standard reason is a legal-counsel question, not a
// product feature."
//
// So: same seventeen codes, re-ORDERED for a thumb.
//
// ⚠ ORDERING NOTE — tow-reasons.ts says rendering surfaces iterate the
// array as-is, "no client sort," so that file IS the order. That rule
// exists so the enforcement pickers can't drift apart from each other.
// This surface re-orders ON PURPOSE and does NOT redefine the
// vocabulary: on a phone a native <select> renders as a scroll wheel,
// so order is most of the ergonomics, and alphabetical puts "Abandoned
// Vehicle" above "Fire Lane" for no reason a manager cares about at
// 11pm. If the enforcement pickers ever want the same treatment, this
// helper is the thing to lift — not a second array of codes.
const REMOVAL_REASON_PRIORITY: readonly string[] = [
  'fire_lane',
  'handicap_zone',
  'reserved_parking',
  'no_parking_permit',
  'blocking_access',
  'expired_visitor_pass',
]

// Priority codes first, everything else in the canonical order, `other`
// pinned last. Built by PARTITIONING the source array rather than
// listing members, so a code added to TOW_REASONS tomorrow still
// appears here without anyone remembering to add it.
function orderForPicker(all: ReadonlyArray<TowReason>): ReadonlyArray<TowReason> {
  const byCode = new Map(all.map(r => [r.code, r]))
  const head = REMOVAL_REASON_PRIORITY
    .map(code => byCode.get(code))
    .filter((r): r is TowReason => !!r && r.code !== 'other')
  const headCodes = new Set(head.map(r => r.code))
  const tail = all.filter(r => !headCodes.has(r.code) && r.code !== 'other')
  const other = all.filter(r => r.code === 'other')
  return [...head, ...tail, ...other]
}

export const REMOVAL_REASONS: ReadonlyArray<TowReason> = orderForPicker(TOW_REASONS)

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
  // void_vehicle_removal returns 'not_found', attach_removal_media
  // returns 'removal_not_found'. Both map to the same sentence; the
  // vocabularies differ and this file is where that is absorbed.
  not_found:                    'That removal record no longer exists.',
  already_voided:               'That record has already been voided.',
  reason_required:              'Enter why this record is being voided.',
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


// ════════════════════════════════════════════════════════════════════
// Void
// ════════════════════════════════════════════════════════════════════

// TERMINAL. There is no un-void RPC and there should not be one — the
// correction path for a wrong record is a new record. The voided row
// stays in every list, marked; hiding it is how a log stops being a log.
export async function voidVehicleRemoval(
  supabase: SupabaseClient,
  input: { removalId: number; reason: string },
): Promise<{ ok: true; removal: VehicleRemoval } | WriteFailure> {
  // The RPC returns reason_required on empty. Checked here too so an
  // obviously-empty reason never costs a round trip.
  if (!input.reason?.trim()) {
    return { ok: false, code: 'reason_required', message: friendlyRemovalError('reason_required') }
  }
  const { data, error } = await supabase.rpc('void_vehicle_removal', {
    p_removal_id:  input.removalId,
    p_void_reason: input.reason.trim(),
  })
  return normalizeRpcResult(data, error, 'void_vehicle_removal', d => ({
    ok: true as const,
    removal: d.removal as VehicleRemoval,
  }))
}

// ════════════════════════════════════════════════════════════════════
// Reads
//
// 🔴 NO CLIENT-SIDE COMPANY OR PROPERTY FILTER. RLS on vehicle_removals
// already scopes a manager to assigned properties and a company_admin to
// their company. Re-filtering here would (a) duplicate the boundary in a
// second place where it can drift, and (b) make an RLS regression
// invisible — the client filter would keep hiding rows the database had
// started leaking. The read returns what the caller is allowed to see.
//
// RLS denials arrive as `{data: [], error: null}` — an empty list, not
// an error. Callers must not report "something went wrong" for zero rows.
// ════════════════════════════════════════════════════════════════════

export type VehicleRemoval = {
  id: number
  company: string
  property: string
  property_id: number | null
  removal_type: string
  plate: string
  plate_state: string | null
  make: string | null
  model: string | null
  color: string | null
  linked_vehicle_id: number | null
  reason_code: string
  reason_notes: string | null
  space_id: number | null
  towed_at: string
  authorized_by_email: string
  authorized_by_name: string | null
  tow_operator_id: number | null
  operator_name: string
  operator_phone: string | null
  created_at: string
  recorded_by_email: string
  // INTERNAL manager-only narrative — added by
  // 20260909_tow_log_vehicle_removals_notes_column.sql. Distinct from
  // reason_notes, and NEVER surfaced to a resident or vehicle owner.
  notes: string | null
  voided_at: string | null
  voided_by_email: string | null
  void_reason: string | null
}

export type RemovalMedia = {
  id: number
  removal_id: number
  storage_path: string
  kind: string
  created_at: string
  created_by_email: string
}

const REMOVAL_COLUMNS =
  'id, company, property, property_id, removal_type, plate, plate_state, make, model, color, ' +
  'linked_vehicle_id, reason_code, reason_notes, space_id, towed_at, authorized_by_email, ' +
  'authorized_by_name, tow_operator_id, operator_name, operator_phone, created_at, ' +
  'recorded_by_email, notes, voided_at, voided_by_email, void_reason'

export type RemovalPage = { rows: VehicleRemoval[]; total: number }

// ════════════════════════════════════════════════════════════════════
// Filters
//
// 🔴 ALL FILTERING IS SERVER-SIDE — .gte/.eq in the query, never a
// client-side filter over a full fetch. The latter works at ten rows
// and quietly stops working later, and by then it is a page that
// downloads a company's whole tow history to hide most of it.
//
// RLS scopes WHICH rows exist for this caller; filters narrow WITHIN
// that. Nothing here re-implements scoping.
// ════════════════════════════════════════════════════════════════════

export type RangeKey = 'this_month' | 'last_30' | 'last_90' | 'this_year' | 'all'

export const RANGE_PRESETS: ReadonlyArray<{ key: RangeKey; label: string }> = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_30',    label: 'Last 30 days' },
  { key: 'last_90',    label: 'Last 90 days' },
  { key: 'this_year',  label: 'This year' },
  { key: 'all',        label: 'All' },
]

export const DEFAULT_RANGE: RangeKey = 'this_month'

// ── Month/year boundaries in PROPERTY time, not UTC ─────────────────
// 🔴 A tow at 11:40pm on 30 September in Central is 1 October in UTC.
// Computing "this month" from UTC boundaries would drop that record out
// of September — for the manager who logged it, on the day they logged
// it. Same class as the Aug 3 incident where one tow read five hours
// apart on two surfaces (see app/lib/format-time.ts header).
//
// Done without a timezone library: format the instant in the target
// zone, read the wall clock back as if it were UTC, and the difference
// is that zone's offset AT THAT INSTANT — so DST is handled by
// construction rather than by a hardcoded -05:00/-06:00.
const PROPERTY_TZ = 'America/Chicago'

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value; return acc
  }, {})
  const wallAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  )
  return at.getTime() - wallAsUtc
}

// The real instant of a wall-clock moment in PROPERTY_TZ. Two-pass: the
// offset is evaluated near the target, so a boundary that lands on a DST
// changeover resolves against the offset in force there.
function zonedInstant(y: number, m: number, d: number): Date {
  const wallAsUtc = Date.UTC(y, m, d, 0, 0, 0)
  const firstPass = new Date(wallAsUtc + zoneOffsetMs(new Date(wallAsUtc), PROPERTY_TZ))
  return new Date(wallAsUtc + zoneOffsetMs(firstPass, PROPERTY_TZ))
}

function propertyNow(): { year: number; monthIndex: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PROPERTY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value; return acc
  }, {})
  return { year: Number(parts.year), monthIndex: Number(parts.month) - 1, day: Number(parts.day) }
}

// Inclusive lower bound for the range, or null for "all".
export function rangeSince(range: RangeKey): Date | null {
  const now = propertyNow()
  switch (range) {
    case 'all':        return null
    case 'this_month': return zonedInstant(now.year, now.monthIndex, 1)
    case 'this_year':  return zonedInstant(now.year, 0, 1)
    case 'last_30':    return new Date(Date.now() - 30 * 86400_000)
    case 'last_90':    return new Date(Date.now() - 90 * 86400_000)
  }
}

// Named window for the count line. "4 removals in September" — a bare
// list of four rows implies four TOTAL; naming the window makes the
// number a filtered fact instead of a total.
export function rangeLabel(range: RangeKey): string {
  const now = propertyNow()
  switch (range) {
    case 'all':        return 'in total'
    case 'this_year':  return `in ${now.year}`
    case 'last_30':    return 'in the last 30 days'
    case 'last_90':    return 'in the last 90 days'
    case 'this_month': {
      const monthName = new Intl.DateTimeFormat('en-US', { timeZone: PROPERTY_TZ, month: 'long' }).format(new Date())
      return `in ${monthName}`
    }
  }
}

export type RemovalFilters = {
  range: RangeKey
  recordedBy: string | null
  reasonCode: string | null
  // number = a tow_operators.id; 'none' = rows whose tow_operator_id is
  // NULL (see the operator-filter note below); null = no filter.
  operatorId: number | 'none' | null
  property: string | null
  includeVoided: boolean
}

export const DEFAULT_FILTERS: RemovalFilters = {
  range: DEFAULT_RANGE,
  recordedBy: null,
  reasonCode: null,
  operatorId: null,
  property: null,
  // Voided rows are SHOWN by default. A voided entry hidden by default
  // is how a record stops being a record.
  includeVoided: true,
}

export function filtersAreDefault(f: RemovalFilters): boolean {
  return f.range === DEFAULT_FILTERS.range
    && f.recordedBy === null && f.reasonCode === null
    && f.operatorId === null && f.property === null
    && f.includeVoided === DEFAULT_FILTERS.includeVoided
}

export async function listVehicleRemovals(
  supabase: SupabaseClient,
  opts: { page: number; pageSize: number; filters: RemovalFilters },
): Promise<RemovalPage> {
  const { filters } = opts
  const from = opts.page * opts.pageSize
  const to   = from + opts.pageSize - 1

  let q = supabase
    .from('vehicle_removals')
    .select(REMOVAL_COLUMNS, { count: 'exact' })
    // Physical-event time, not entry time. A backdated record belongs
    // where the tow happened in the timeline, not where it was typed —
    // and the date filter uses the same column for the same reason.
    .order('towed_at', { ascending: false })
    .range(from, to)

  const since = rangeSince(filters.range)
  if (since)                    q = q.gte('towed_at', since.toISOString())
  if (filters.recordedBy)       q = q.eq('recorded_by_email', filters.recordedBy)
  if (filters.reasonCode)       q = q.eq('reason_code', filters.reasonCode)
  if (filters.property)         q = q.eq('property', filters.property)
  if (!filters.includeVoided)   q = q.is('voided_at', null)

  // 🔴 OPERATOR FILTERS ON tow_operator_id, NEVER operator_name.
  // operator_name is a SNAPSHOT taken at write time. If an operator is
  // renamed — rebranding, or fixing a typo — historical rows keep the
  // old string, so filtering by name would return only the rows written
  // under whichever spelling the dropdown happens to offer and silently
  // split one operator's history in two.
  //
  // CONSEQUENCE, AND IT IS CORRECT: a filtered list can show rows whose
  // displayed operator_name differs from the filter's label. The label
  // is the operator's name NOW; the row is the name they had THEN. That
  // is the snapshot doing its job. Do not "fix" this by switching the
  // filter to the name.
  if (filters.operatorId === 'none') {
    // tow_operator_id is ON DELETE SET NULL, so a row can carry the
    // operator_name/phone snapshots with no id. Shouldn't happen — the
    // discipline is deactivate, never delete — but a record nobody can
    // filter to is a record nobody finds.
    q = q.is('tow_operator_id', null)
  } else if (typeof filters.operatorId === 'number') {
    q = q.eq('tow_operator_id', filters.operatorId)
  }

  const { data, error, count } = await q
  if (error) {
    console.error('[tow-log] listVehicleRemovals failed', error)
    return { rows: [], total: 0 }
  }
  return { rows: (data ?? []) as unknown as VehicleRemoval[], total: count ?? 0 }
}

// ════════════════════════════════════════════════════════════════════
// Filter option lists
//
// Every list below is built from ROWS THE CALLER CAN SEE — never a
// hardcoded roster, and never an entity that has recorded nothing. An
// option that always returns zero rows is worse than no option.
//
// ⚠ PostgREST has no DISTINCT. These fetch a single column and dedupe
// client-side, bounded by OPTION_SCAN_LIMIT. That is a scan of one
// narrow column, not of the table — but it is still a bound, and past
// it an option could go missing from the dropdown while its rows stay
// in the log. If this table ever gets big enough for that, the fix is a
// DEFINER RPC returning the distinct sets, not a bigger limit.
// ════════════════════════════════════════════════════════════════════

const OPTION_SCAN_LIMIT = 1000

export async function listRecordedByOptions(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase
    .from('vehicle_removals').select('recorded_by_email').limit(OPTION_SCAN_LIMIT)
  if (error) { console.error('[tow-log] listRecordedByOptions failed', error); return [] }
  return Array.from(new Set((data ?? []).map(r => r.recorded_by_email as string).filter(Boolean))).sort()
}

export async function listPropertyOptions(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase
    .from('vehicle_removals').select('property').limit(OPTION_SCAN_LIMIT)
  if (error) { console.error('[tow-log] listPropertyOptions failed', error); return [] }
  return Array.from(new Set((data ?? []).map(r => r.property as string).filter(Boolean))).sort()
}

export type OperatorOption = { id: number | 'none'; label: string }

// Operators that APPEAR IN THE LOG, labelled with their CURRENT name.
// Inactive operators are included when they have rows: deactivation
// removes an operator from the create picker, not from history.
export async function listOperatorOptions(supabase: SupabaseClient): Promise<OperatorOption[]> {
  const { data, error } = await supabase
    .from('vehicle_removals').select('tow_operator_id').limit(OPTION_SCAN_LIMIT)
  if (error) { console.error('[tow-log] listOperatorOptions failed', error); return [] }

  const rows = data ?? []
  const ids = Array.from(new Set(rows.map(r => r.tow_operator_id as number | null).filter((v): v is number => typeof v === 'number')))
  const hasNullId = rows.some(r => r.tow_operator_id === null)

  let options: OperatorOption[] = []
  if (ids.length > 0) {
    // Current names, not the snapshots — see the filter note above.
    const { data: ops, error: opErr } = await supabase
      .from('tow_operators').select('id, name').in('id', ids)
    if (opErr) console.error('[tow-log] operator name lookup failed', opErr)
    options = (ops ?? []).map(o => ({ id: Number(o.id), label: String(o.name) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }
  if (hasNullId) options.push({ id: 'none', label: 'Operator removed' })
  return options
}

// ⚠ INDEX NOTE. vehicle_removals_plate_lookup is on
// (lower(trim(company)), normalize_plate(plate)) — an EXPRESSION index.
// PostgREST cannot express `normalize_plate(plate) = $1` in a filter, so
// this is plain equality on the stored column instead.
//
// The RESULTS are correct: since 2026-09-10 record_vehicle_removal
// normalizes the plate itself and inserts the normalized value, and the
// table trigger is the floor beneath it, so every stored plate is
// already alphanumeric-uppercase. Equality against normalizePlate(input)
// therefore matches exactly what the expression index would have.
//
// What is NOT guaranteed is that the planner uses that index for this
// filter. At current volumes it is a small property-scoped scan. If it
// ever matters, the fix is a DEFINER lookup RPC (which can use the
// expression) or a plain index on (company, plate) — not a client-side
// workaround.
export async function lookupRemovalsByPlate(
  supabase: SupabaseClient,
  plate: string,
): Promise<VehicleRemoval[]> {
  const normalized = normalizePlate(plate)
  if (!normalized) return []
  const { data, error } = await supabase
    .from('vehicle_removals')
    .select(REMOVAL_COLUMNS)
    .eq('plate', normalized)
    .order('towed_at', { ascending: false })
  if (error) {
    console.error('[tow-log] lookupRemovalsByPlate failed', error)
    return []
  }
  return (data ?? []) as unknown as VehicleRemoval[]
}

// Soft-deleted attachments are excluded — removed_at on THIS table means
// the attachment was withdrawn, not that the tow was undone. The two
// meanings live on different tables and must not be conflated.
export async function listRemovalMedia(
  supabase: SupabaseClient,
  removalId: number,
): Promise<RemovalMedia[]> {
  const { data, error } = await supabase
    .from('vehicle_removal_media')
    .select('id, removal_id, storage_path, kind, created_at, created_by_email')
    .eq('removal_id', removalId)
    .is('removed_at', null)
    .order('created_at')
  if (error) {
    console.error('[tow-log] listRemovalMedia failed', error)
    return []
  }
  return (data ?? []) as RemovalMedia[]
}

// ── Signed URLs ─────────────────────────────────────────────────────
// The bucket is PRIVATE and vehicle_removal_media stores a PATH, never a
// URL — deliberately, so the storage scheme can change without a column
// migration. Turning a path into something a browser can render goes
// through /api/tow-log/media-url, which signs with the CALLER'S session
// so the storage policies are the access control that actually runs.
export async function signMediaUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {}
  try {
    const res = await fetch('/api/tow-log/media-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    })
    if (!res.ok) {
      console.error('[tow-log] signMediaUrls failed', res.status, await res.text())
      return {}
    }
    const body = await res.json()
    return (body?.urls ?? {}) as Record<string, string>
  } catch (e) {
    console.error('[tow-log] signMediaUrls threw', e)
    return {}
  }
}

// Tow-reason canonical list — A1-finalized, Chapter-2308-aligned, curated.
//
// ORIGIN (Jose 2026-06-22, A1 sign-off)
//   Pre-standardization state: 8 freetext options hardcoded inline in TWO
//   files (app/driver/page.tsx + app/company_admin/page.tsx), no DB
//   constraint, identical-by-discipline-not-by-architecture. Standardization
//   extracts to this shared file (anti-drift), expands to 13 + Other, and
//   stores STABLE CODES while rendering FRIENDLY LABELS. Old freetext rows
//   keep their labels via the displayTowReason() fallback (returns input
//   verbatim when no code matches).
//
// CURATED. NOT EDITABLE. NOT EXTENSIBLE PER COMPANY.
//   Adding a non-standard reason is a legal-counsel question, not a product
//   feature. The list is hardcoded to Chapter 2308 alignment on purpose;
//   no admin UI to add reasons, no per-company customization. This is a
//   COMPLIANCE POSTURE, firmer than a deferral.
//
// STORAGE
//   Column: violations.violation_type (TEXT, freetext, NO CHECK constraint).
//   New rows store the CODE (e.g. 'fire_lane'); old rows continue to hold
//   their freetext labels (e.g. 'Fire Lane'). displayTowReason() resolves
//   codes to labels and falls back to the raw value for old rows. No
//   migration, no backfill — confirmed with Jose.
//
// ────────────────────────────────────────────────────────────────────
// DELIBERATE TWO-VOCABULARY SPLIT (Option A, Jose 2026-06-22)
// ────────────────────────────────────────────────────────────────────
//   This file's 14 codes are for `violations.violation_type` (the parking
//   infraction — every ticket carries one). A SECOND, NARROWER vocabulary
//   lives at app/components/DeclineReasonModal.tsx — 6 codes used for
//   `violations.decline_reason` (the B71 authorized-plate-override context;
//   present only on tickets written against an authorized plate).
//
//   The two lists OVERLAP semantically (modal's `reserved_space` ↔ this
//   list's `reserved_parking`; modal's `handicap_violation` ↔ this list's
//   `handicap_zone`; modal's `blocked_access` ↔ this list's
//   `blocking_access`). They are NOT one vocabulary forced to coexist —
//   they live in DIFFERENT COLUMNS answering DIFFERENT QUESTIONS on the
//   same row. Unifying them would require migrating the existing
//   decline_reason CHECK constraint + backfilling old rows, both of which
//   are explicitly forbidden by the no-migration / no-backfill locks.
//
//   REPORTING NOTE: an "all wrong-space-type violations" query MUST check
//   BOTH columns (violation_type = 'wrong_space' OR decline_reason =
//   'reserved_space'). The two columns are independent dimensions of the
//   same incident; queries that touch only one will undercount.
//
//   Do NOT delete the cross-reference comment in DeclineReasonModal that
//   points back here.

export interface TowReason {
  code: string
  label: string
}

export const TOW_REASONS: ReadonlyArray<TowReason> = [
  { code: 'no_parking_permit',      label: 'No Parking Permit' },
  { code: 'not_registered_visitor', label: 'Not Registered (Visitor)' },
  { code: 'expired_visitor_pass',   label: 'Expired Visitor Pass' },
  { code: 'wrong_space',            label: 'Wrong Space / Unauthorized Space' },
  { code: 'reserved_parking',       label: 'Reserved Parking' },
  { code: 'no_parking_zone',        label: 'No Parking Zone' },
  { code: 'fire_lane',              label: 'Fire Lane' },
  { code: 'handicap_zone',          label: 'Handicap Zone' },
  { code: 'blocking_access',        label: 'Blocking (Driveway / Gate / Access)' },
  { code: 'double_parked',          label: 'Double Parked' },
  { code: 'abandoned_vehicle',      label: 'Abandoned Vehicle' },
  { code: 'inoperable_vehicle',     label: 'Inoperable Vehicle' },
  { code: 'compact_cars_only',      label: 'Compact Cars Only' },
  { code: 'other',                  label: 'Other (reason required, min 10 chars)' },
] as const

export type TowReasonCode = typeof TOW_REASONS[number]['code']

export const OTHER_NOTE_MIN_LENGTH = 10

// B71 carry-forward — codes that do NOT apply when overriding an
// authorized plate (the plate IS authorized at scan time, so these would
// contradict that premise). The driver/CA dropdown filters these out when
// `pendingDecline` is set (the user clicked Issue-Violation on an
// authorized result and routed through the B71 decline modal first).
//
// Pre-standardization: the inline list hard-coded `!pendingDecline && ...`
// on "No Parking Permit" + "Expired Visitor Pass". Standardization adds
// `not_registered_visitor` to the set (it's the new code for "this plate
// isn't a registered visitor pass" — same premise contradiction).
export const RESTRICTED_ON_OVERRIDE: ReadonlySet<TowReasonCode> = new Set([
  'no_parking_permit',
  'not_registered_visitor',
  'expired_visitor_pass',
])

// Display helper — renders BOTH new codes (lookup → label) AND legacy
// freetext rows (returns the raw value when no code matches, so an old
// row with violation_type='Fire Lane' still renders as 'Fire Lane').
//
// This is the no-migration enabler: old rows never need to be backfilled
// because the display path tolerates both shapes uniformly.
//
// CALL SITES — every render of violation_type MUST go through this helper.
// 22 sites in the initial standardization sweep. Future code adding a new
// surface that displays violation_type should call this helper too.
export function displayTowReason(value: string | null | undefined): string {
  if (!value) return '—'
  return TOW_REASONS.find(r => r.code === value)?.label ?? value
}

// ════════════════════════════════════════════════════════════════════
// Tow Log CSV export — two variants, and the difference is the point.
//
// ── ⚠ THIS IS ERGONOMICS, NOT A CONTROL ────────────────────────────
// Read this before relying on anything below.
//
// The motivating request is a tow operator asking for everything they
// have done at a property. The file that answers it naturally contains
// things a vendor has no reason to receive:
//
//   notes                — INTERNAL manager narrative. "Resident was
//                          upset, said call them Monday" is not for the
//                          operator.
//   reason_notes         — free text a manager wrote about this
//                          incident; same class.
//   authorized_by_email  — staff addresses. Not secret, but no reason
//   recorded_by_email      to hand a vendor a roster of who works
//   voided_by_email        there.
//   void_reason          — why a record was withdrawn; internal.
//
// 🔴 THE CONTROL IS THE PROPERTY MANAGER, NOT THIS CODE. They reformat
// the file before sending it anywhere — nobody forwards a raw CSV to a
// vendor. Nothing here prevents a manager exporting the full variant
// and emailing it as-is, and nothing here is positioned to.
//
// What the two variants buy is that the manager STARTS FROM A CLEAN
// FILE INSTEAD OF DELETING COLUMNS. That is the whole benefit. It is
// convenience, and it is worth having, and it is not enforcement.
//
//   SHAREABLE (default) — the vehicle, when, why, who removed it, and
//                         whether it still stands.
//   FULL                — the property's own records, an owner report,
//                         an attorney. Everything.
//
// Two buttons rather than one export with a checkbox, so the choice is
// made at the point of clicking rather than left at a default somebody
// notices after emailing it. Also ergonomics.
//
// ── THE TYPE PROTECTS A DEFAULT, NOT A BOUNDARY ─────────────────────
// Same mechanism as residents-export.ts: the shareable row-builder sees
// an Omit<> view, so reading `notes` inside it FAILS TO COMPILE. That
// is genuinely useful — it stops the two variants quietly drifting into
// each other, and it answers "is the notes column absent or just empty"
// structurally rather than by opening the file.
//
// 🔴 But a compile error here is NOT a security guarantee. It constrains
// what THIS builder emits. It says nothing about where the resulting
// file goes, who opens it, or what the full variant contains. Do not
// cite it as a data-handling control, and do not build anything on top
// of it that assumes internal fields cannot leave the system.
//
// If a future export needs an internal column, it lands as its own
// variant with its own label — not by widening the shareable one.
//
// ── BOUNDARY (DECISION_tow_log_is_a_log_sept9_2026) ─────────────────
// No resident-facing export. An export mechanism is exactly where "can
// the resident get a copy" gets proposed, and the answer is no.
// ════════════════════════════════════════════════════════════════════

import { serializeCsv, downloadCsv } from './residents-export'
import { displayTowReason } from './tow-reasons'
import { formatTimestamp } from './format-time'
import { rangeLabel, type RemovalFilters, type VehicleRemoval } from './tow-log-writes'

export type ExportVariant = 'shareable' | 'full'

// 🔴 Fields that must never appear in the shareable file. Adding one
// here removes it from the shareable builder's view at compile time.
export type InternalRemovalField =
  | 'notes'
  | 'reason_notes'
  | 'authorized_by_email'
  | 'authorized_by_name'
  | 'recorded_by_email'
  | 'voided_by_email'
  | 'void_reason'

export type ShareableRemoval = Omit<VehicleRemoval, InternalRemovalField>

export const SHAREABLE_HEADERS = [
  'Plate', 'State', 'Make', 'Model', 'Color',
  'Removed', 'Type', 'Reason', 'Operator', 'Property', 'Status',
] as const

export const FULL_HEADERS = [
  ...SHAREABLE_HEADERS,
  'Reason Detail', 'Internal Notes',
  'Authorized By', 'Authorized By (name)', 'Recorded By', 'Recorded At',
  'Voided At', 'Voided By', 'Void Reason',
] as const

// Timestamps go through the SAME helper the detail panel uses, so the
// file and the screen can never disagree — and it renders in property
// time with the zone named ("9/9/2026, 11:40:00 PM CDT"). A CSV opened
// in Excel showing UTC is wrong by five hours for every reader, and
// nobody notices until it matters.
const ts = (value: string | null) => (value ? formatTimestamp(value) : '')

// Voided rows are INCLUDED, carrying their status. Dropping them would
// make the file disagree with the count on screen, and "voided" is
// information the reader needs — a vendor reconciling their invoice
// against this file especially.
const statusOf = (r: { voided_at: string | null }) => (r.voided_at ? 'Voided' : 'Recorded')

// The shareable builder's parameter type is the NARROWED view. `r.notes`
// inside this function does not compile.
export function buildShareableRows(rows: ShareableRemoval[]): string[][] {
  return rows.map(r => [
    r.plate,
    r.plate_state ?? '',
    r.make ?? '',
    r.model ?? '',
    r.color ?? '',
    ts(r.towed_at),
    r.removal_type,
    displayTowReason(r.reason_code),
    r.operator_name,
    r.property,
    statusOf(r),
  ])
}

export function buildFullRows(rows: VehicleRemoval[]): string[][] {
  return rows.map(r => [
    ...buildShareableRows([r as ShareableRemoval])[0],
    r.reason_notes ?? '',
    r.notes ?? '',
    r.authorized_by_email,
    r.authorized_by_name ?? '',
    r.recorded_by_email,
    ts(r.created_at),
    ts(r.voided_at),
    r.voided_by_email ?? '',
    r.void_reason ?? '',
  ])
}

export function buildTowLogCsv(rows: VehicleRemoval[], variant: ExportVariant): string {
  return variant === 'shareable'
    ? serializeCsv(SHAREABLE_HEADERS, buildShareableRows(rows))
    : serializeCsv(FULL_HEADERS, buildFullRows(rows))
}

// A file called export.csv in a downloads folder is unidentifiable a
// week later. The name carries the property, the window and the
// variant, so the reader knows what they are holding without opening it
// — and so an internal file is recognisable as one before it is
// forwarded.
export function buildTowLogExportFilename(
  propertyLabel: string,
  filters: RemovalFilters,
  variant: ExportVariant,
): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'all'
  const window = slug(rangeLabel(filters.range).replace(/^in /, ''))
  return `tow-log_${slug(propertyLabel)}_${window}_${variant}.csv`
}

export { downloadCsv }

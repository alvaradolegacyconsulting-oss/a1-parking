// ════════════════════════════════════════════════════════════════════
// Tow Log CSV export — two variants, and the difference is the point.
//
// ── 🔴 AN EXPORT LEAVES THE SYSTEM ──────────────────────────────────
// The motivating request is a tow operator asking for everything they
// have done at a property. Reasonable — and the obvious file that
// answers it contains things that must not go to a vendor:
//
//   notes                — INTERNAL manager narrative, explicitly
//                          designed never to leave the property.
//                          "Resident was upset, said call them Monday"
//                          is not for the operator.
//   reason_notes         — free text a manager wrote about this
//                          incident; same class.
//   authorized_by_email  — staff addresses. Not secret, but there is
//   recorded_by_email      no reason to hand a vendor a roster of who
//   voided_by_email        works there.
//
// So there are TWO exports and the caller picks at the point of
// clicking — never one export with a checkbox somebody leaves at the
// wrong default and notices after emailing it.
//
//   SHAREABLE (default) — safe to send anyone. The vehicle, when, why,
//                         who removed it, and whether it still stands.
//   FULL                — the property's own records, an owner report,
//                         an attorney. Everything.
//
// ── THE EXCLUSION IS ENFORCED BY THE TYPE, NOT BY THE COMMENT ───────
// Same discipline as residents-export.ts: the shareable row-builder
// sees a Pick<> view of the row, so reading `notes` inside it FAILS TO
// COMPILE. Comment drift alone cannot open the door, and the
// verification "confirm the notes column is absent, not empty" is
// answered structurally rather than by inspection.
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

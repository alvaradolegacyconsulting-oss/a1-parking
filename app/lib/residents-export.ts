// Resident + vehicle CSV export helpers.
//
// Ships 2026-07-29 as Miriam's ask (manager, Green Acres). Written so
// the same flatten + serialize can drive a CA-portfolio export by
// feeding a different residents array — property scope is the caller's
// concern; these helpers just transform whatever's passed in.
//
// Rules of use (per Mateo greenlit spec):
//   • Row shape: one row per vehicle. A resident with N vehicles → N
//     rows with resident columns repeated. A resident with 0 vehicles
//     → one row with vehicle columns blank ("who hasn't registered a
//     car" is a real question).
//   • Column order: identity first, then vehicle. Human-readable
//     headers ("Resident Name", not "resident_email").
//   • Dates: MM/DD/YYYY. Excel mangles ISO into text.
//   • Filename: "{Property} - Residents - YYYY-MM-DD.csv".
//   • CSV escaping: every field quoted, internal " doubled to "". Names
//     with commas or apostrophes ("O'Brien, Jr.") don't break columns.
//   • CRLF line terminator + UTF-8 BOM: Excel opens as UTF-8 without
//     the mojibake prompt.
//   • Row counts returned separately so the caller can toast a
//     "24 residents, 25 vehicles exported" confirmation.

import type { CrmResident } from './pm-crm'
import { residentDisplayStatus } from './pm-crm'

// 🔴 CRM-INTERNAL FIELDS ARE EXCLUDED FROM EXPORT AT THE TYPE LEVEL.
//
// deactivation_reason / deactivation_note / deactivated_by /
// deactivated_at are on CrmResident (populated 2026-08-05) but MUST
// NOT appear in the CSV. A leasing_agent can download this export;
// deactivation_note contains free-text a manager wrote for internal
// reasoning, not a message meant for a spreadsheet handed to third
// parties. Same data-minimization rule as B225 (driver_email removal).
// See COMMENT ON residents.deactivation_note in
// 20260805_deactivation_reason_columns.sql.
//
// The comment above documents WHY. The type below ENFORCES. Reading
// `r.deactivation_note` inside flattenResidentsForExport fails to
// COMPILE — Pick<CrmResident, ExportableResidentField> narrows the
// row-builder's view so a future refactor that spreads or iterates
// the resident object can't accidentally leak the field. Extending
// the exclusion list means adding a code here; comment drift alone
// cannot open the door.
//
// If a future export needs a deactivation column, land it as a
// SEPARATE "audit" export with its own permissions gate — not by
// widening this identity-track export.
export type NonExportableResidentField =
  | 'deactivation_reason'
  | 'deactivation_note'
  | 'deactivated_by'
  | 'deactivated_at'

export type ExportableResidentField = Exclude<keyof CrmResident, NonExportableResidentField>

// The row-builder view. A field access outside this key set will not
// compile. CSV_HEADERS is an explicit literal (human strings like
// 'Resident Name', not derived from keys), so the leak surface is the
// identity[] array below, and this type gates it.
export type ExportableResident = Pick<CrmResident, ExportableResidentField>

export const CSV_HEADERS = [
  'Resident Name', 'Unit', 'Email', 'Phone', 'Status', 'Registered',
  'Assigned Space', 'Plate', 'State', 'Make', 'Model', 'Year', 'Color', 'Vehicle Status',
  // 2026-08-19 Commit 5 — designated-vehicle column. Appended at END
  // to avoid disturbing existing position-based consumers. Mateo Aug 19:
  // "Header wording: 'Designated Vehicle'. Consistent with the UI label
  // so nobody reads it as an enforcement field."
  //
  // 🔴 One entry per assigned space, semicolon-joined ("R-1: TWICE;
  // CP-2: TEST123 (inactive)"). Rendered from CrmResidentSpace.
  // designated_state (populated in buildCrmResidents) so stale
  // designations surface honestly rather than exporting blank — blank
  // would read as "no designation" and reproduce the Aug 19 Defect 2
  // false-negative class inside a documented consumer's file.
  //
  // Format rules:
  //   valid            → "Space L: PLATE"
  //   stale-inactive   → "Space L: PLATE (inactive)"
  //   stale-untied     → "Space L: PLATE (owner not tied)"
  //   unresolvable     → "Space L: #ID (unresolvable)"
  //   null / no space  → skipped (cell shows only present designations)
  //   no assigned space AND resident has 0 designations → cell blank
  'Designated Vehicle',
] as const

export interface FlattenResult {
  rows: string[][]
  residentCount: number
  vehicleCount: number
}

export function flattenResidentsForExport(residents: ExportableResident[]): FlattenResult {
  const rows: string[][] = []
  let vehicleCount = 0
  for (const r of residents) {
    // r is typed Pick<CrmResident, ExportableResidentField>. Accessing
    // r.deactivation_note (or any other non-exportable field) here
    // fails to compile — the leak fix is enforced by the type, not by
    // the comment above CSV_HEADERS.
    const identity: string[] = [
      r.name || '',
      r.unit || '',
      r.email || '',
      r.phone || '',
      residentDisplayStatusLabel(r),
      formatDateMDY(r.created_at),
      (r.assignedSpaces || []).map(s => s.label).filter(Boolean).join(', '),
    ]
    // 2026-08-19 Commit 5 — designated-vehicle cell. Rendered PER
    // resident (not per vehicle) since designations are space-scoped,
    // not vehicle-scoped. Repeated identically across every vehicle
    // row for this resident (same shape as `identity` above).
    const designatedCell = formatDesignatedVehicleCell(r.assignedSpaces || [])
    const vehicles = r.vehicles || []
    if (vehicles.length === 0) {
      rows.push([...identity, '', '', '', '', '', '', '', designatedCell])
    } else {
      for (const v of vehicles) {
        vehicleCount++
        rows.push([
          ...identity,
          v.plate || '',
          v.state || '',
          v.make || '',
          v.model || '',
          v.year != null ? String(v.year) : '',
          v.color || '',
          vehicleStatusLabel(v),
          designatedCell,
        ])
      }
    }
  }
  return { rows, residentCount: residents.length, vehicleCount }
}

// 2026-08-19 Commit 5 — build the "Designated Vehicle" cell for one
// resident by walking their assigned spaces. Each space contributes
// zero or one entry; entries are joined with "; ".
//
// Reads directly from CrmResidentSpace.designated_vehicle_plate +
// designated_state (both populated by buildCrmResidents from the id
// via vehicleById lookup). NEVER routes through picker scope — same
// discipline as the modal's Aug 19 Defect 2 fix. Stale states surface
// with an explicit suffix so blank cells NEVER conflate with "set but
// stale".
// One-shot debug flag so a Test Legacy export dumps the first
// non-empty assignedSpaces set to the browser console. Diagnostic
// for Finding C (Mateo Aug 19: column blank on rows with valid
// designations). Remove once the miss is isolated and fixed. Fires
// AT MOST ONCE per module load.
let __designationDebugFired = false

function formatDesignatedVehicleCell(
  spaces: Array<{
    id?: number | string
    label: string
    designated_vehicle_id?: number | null
    designated_vehicle_plate?: string | null
    designated_state?: 'valid' | 'stale-inactive' | 'stale-untied' | 'unresolvable' | null
  }>,
): string {
  const entries: string[] = []
  for (const s of spaces) {
    // 🔴 Finding C diagnostic: dump the shape of the first assignedSpace
    // encountered per export invocation so we can see exactly what
    // fields survived the buildCrmResidents → Phase 1 → Phase 2 →
    // filterCrmRows chain. Console-only; no CSV impact.
    if (!__designationDebugFired && spaces.length > 0) {
      __designationDebugFired = true
      try {
        // eslint-disable-next-line no-console
        console.log('[FindingC-debug] first assignedSpaces sample:', {
          spaceCount: spaces.length,
          firstSpaceKeys: Object.keys(spaces[0] ?? {}),
          firstSpace: spaces[0],
          spacesWithDesignation: spaces.filter(x => x.designated_vehicle_id != null).length,
        })
      } catch { /* ignore */ }
    }
    if (s.designated_vehicle_id == null) continue
    const label = s.label || `Space #${s.designated_vehicle_id}`
    const plate = s.designated_vehicle_plate || `#${s.designated_vehicle_id}`
    let suffix = ''
    switch (s.designated_state) {
      case 'valid':          suffix = ''; break
      case 'stale-inactive': suffix = ' (inactive)'; break
      case 'stale-untied':   suffix = ' (owner not tied)'; break
      case 'unresolvable':   suffix = ' (unresolvable)'; break
      default:               suffix = ''; break
    }
    // Prefer plate; unresolvable falls back to #ID which already shows
    // in `plate` above.
    entries.push(`${label}: ${plate}${suffix}`)
  }
  return entries.join('; ')
}

export function serializeCsv(headers: readonly string[], rows: string[][]): string {
  const escape = (s: string) => `"${String(s ?? '').replace(/"/g, '""')}"`
  const lines = [headers.map(escape).join(',')]
  for (const row of rows) lines.push(row.map(escape).join(','))
  // CRLF for Excel + UTF-8 BOM prefix (added at download-time, not here)
  return lines.join('\r\n') + '\r\n'
}

export function downloadCsv(filename: string, csv: string): void {
  // UTF-8 BOM prefix so Excel opens as UTF-8 (avoids mojibake on names
  // with accented characters — common in TX resident rosters).
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function buildExportFilename(propertyName: string): string {
  const today = new Date()
  const yyyy = today.getFullYear()
  const mm = String(today.getMonth() + 1).padStart(2, '0')
  const dd = String(today.getDate()).padStart(2, '0')
  // Property name kept human-readable; filesystem-invalid chars replaced.
  const safeName = (propertyName || 'All Properties').replace(/[\\/:*?"<>|]/g, '-')
  return `${safeName} - Residents - ${yyyy}-${mm}-${dd}.csv`
}

// ── Internal label helpers ──────────────────────────────────────────

function formatDateMDY(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}/${dd}/${d.getFullYear()}`
}

function residentDisplayStatusLabel(r: Pick<CrmResident, 'status' | 'is_active'>): string {
  switch (residentDisplayStatus(r)) {
    case 'pending':     return 'Pending Approval'
    case 'declined':    return 'Declined'
    case 'deactivated': return 'Deactivated'
    case 'active':      return 'Active'
  }
}

function vehicleStatusLabel(v: { status?: string | null; is_active?: boolean }): string {
  if (v.is_active === false && v.status !== 'pending' && v.status !== 'declined') return 'Deactivated'
  const s = (v.status || '').toLowerCase()
  if (s === 'active' || s === 'approved') return 'Approved'
  if (s === 'pending')      return 'Pending Approval'
  if (s === 'declined')     return 'Declined'
  if (s === 'under_review') return 'Under Review'
  return v.status || ''
}

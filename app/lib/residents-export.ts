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

export const CSV_HEADERS = [
  'Resident Name', 'Unit', 'Email', 'Phone', 'Status', 'Registered',
  'Assigned Space', 'Plate', 'State', 'Make', 'Model', 'Year', 'Color', 'Vehicle Status',
] as const

export interface FlattenResult {
  rows: string[][]
  residentCount: number
  vehicleCount: number
}

export function flattenResidentsForExport(residents: CrmResident[]): FlattenResult {
  const rows: string[][] = []
  let vehicleCount = 0
  for (const r of residents) {
    const identity: string[] = [
      r.name || '',
      r.unit || '',
      r.email || '',
      r.phone || '',
      residentDisplayStatusLabel(r),
      formatDateMDY(r.created_at),
      (r.assignedSpaces || []).map(s => s.label).filter(Boolean).join(', '),
    ]
    const vehicles = r.vehicles || []
    if (vehicles.length === 0) {
      rows.push([...identity, '', '', '', '', '', '', ''])
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
        ])
      }
    }
  }
  return { rows, residentCount: residents.length, vehicleCount }
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

function residentDisplayStatusLabel(r: CrmResident): string {
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

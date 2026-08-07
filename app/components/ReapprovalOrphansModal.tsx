'use client'
//
// 2026-08-07 — Reapproval orphans modal.
//
// Intercepts a manager's Approve Resident click when the resident has
// plates on file that aren't currently authorized (deactivated, declined,
// expired — anything is_active=false EXCEPT pending). This is the item
// that would have prevented Natalie Lopez 690's Green Acres incident:
// Amanda approved the re-registered row Aug 3, two previously-trimmed
// plates stayed dead for 5 days, no signal.
//
// Copy states facts. Nothing is forced.
//   - Restore selected + Approve — flips checked plates back to active
//     via approveVehiclesBatch (one sync per batch), then approves the
//     resident.
//   - Approve without restoring — approves the resident, leaves the
//     plates dead. First-class option, not a hidden escape.
//   - Cancel — does nothing.
//
// Per-plate checkboxes default checked (common case is a returning
// resident whose plates should come back). Manager unchecks any plate
// that shouldn't be restored (e.g., sold car with reason=vehicle_sold).
//
// Reason where deactivation_reason is populated, via reasonLabel('vehicle', ...).
// This is the first surface where that data pays off across records.

import { useState } from 'react'
import { reasonLabel } from '../lib/deactivation-reasons'
import { formatDateLong } from '../lib/format-time'

export interface OrphanPlate {
  id:                   string | number
  plate:                string
  ymm?:                 string | null      // "2021 Toyota Corolla"
  status?:              string | null
  deactivation_reason?: string | null
  deactivation_note?:   string | null
  deactivated_at?:      string | null
}

export interface ReapprovalOrphansConfirmArgs {
  choice:              'restore' | 'approve_without_restore'
  restorePlateIds:     Array<string | number>   // only meaningful when choice='restore'
  shownPlateIds:       Array<string | number>   // all plates surfaced (for audit)
  skippedPlateIds:     Array<string | number>   // shown but NOT selected for restore (audit)
}

interface Props {
  residentName:  string
  residentEmail: string
  residentUnit:  string
  orphans:       OrphanPlate[]
  isBusy?:       boolean
  onCancel:      () => void
  onConfirm:     (args: ReapprovalOrphansConfirmArgs) => void
}

export default function ReapprovalOrphansModal({
  residentName,
  residentEmail,
  residentUnit,
  orphans,
  isBusy = false,
  onCancel,
  onConfirm,
}: Props) {
  // Default all checked — common case is returning resident.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () => new Set(orphans.map(o => String(o.id)))
  )

  const toggle = (id: string | number) => {
    if (isBusy) return
    setCheckedIds(prev => {
      const next = new Set(prev)
      const key = String(id)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const shownIds = orphans.map(o => o.id)
  const restoreIds = orphans.filter(o => checkedIds.has(String(o.id))).map(o => o.id)
  const skippedIds = orphans.filter(o => !checkedIds.has(String(o.id))).map(o => o.id)
  const restoreCount = restoreIds.length

  const handleRestore = () => {
    if (isBusy) return
    onConfirm({
      choice:          'restore',
      restorePlateIds: restoreIds,
      shownPlateIds:   shownIds,
      skippedPlateIds: skippedIds,
    })
  }
  const handleApproveOnly = () => {
    if (isBusy) return
    onConfirm({
      choice:          'approve_without_restore',
      restorePlateIds: [],
      shownPlateIds:   shownIds,
      skippedPlateIds: shownIds,
    })
  }

  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999,
      display:'flex', alignItems:'center', justifyContent:'center', padding:'20px'
    }}>
      <div style={{
        background:'#161b26', border:'1px solid #C9A227', borderRadius:'14px',
        padding:'22px', maxWidth:'520px', width:'100%', maxHeight:'90vh', overflowY:'auto'
      }}>
        <p style={{
          color:'#C9A227', fontSize:'11px', textTransform:'uppercase',
          letterSpacing:'0.08em', margin:'0 0 8px', fontWeight:'bold'
        }}>
          Before you approve
        </p>
        <p style={{ color:'white', fontSize:'15px', margin:'0 0 4px', fontWeight:'bold' }}>
          {residentName || residentEmail}
        </p>
        <p style={{ color:'#888', fontSize:'12px', margin:'0 0 14px' }}>
          Unit {residentUnit || '—'} · {residentEmail}
        </p>

        <p style={{ color:'#aaa', fontSize:'12.5px', margin:'0 0 12px', lineHeight:'1.5' }}>
          This resident has <b style={{ color:'#C9A227' }}>{orphans.length}</b> {orphans.length === 1 ? 'plate' : 'plates'} on file that {orphans.length === 1 ? "isn't" : "aren't"} currently authorized.
          Check the ones to restore, or approve the resident without them.
        </p>

        <div style={{
          background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px',
          padding:'10px 12px', marginBottom:'14px', maxHeight:'320px', overflowY:'auto',
        }}>
          {orphans.map(o => {
            const reasonText = o.deactivation_reason
              ? (reasonLabel('vehicle', o.deactivation_reason) ?? `code: ${o.deactivation_reason}`)
              : null
            const deactivatedAt = o.deactivated_at ? formatDateLong(o.deactivated_at) : null
            const key = String(o.id)
            const isChecked = checkedIds.has(key)
            return (
              <label key={key} style={{
                display:'block', padding:'10px 4px',
                borderBottom:'1px solid #1e2535',
                cursor: isBusy ? 'not-allowed' : 'pointer',
                opacity: isBusy ? 0.6 : 1,
              }}>
                <div style={{ display:'flex', alignItems:'flex-start', gap:'10px' }}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggle(o.id)}
                    disabled={isBusy}
                    style={{ marginTop:'3px' }}
                  />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{
                      color:'white', fontSize:'14px', fontFamily:'Courier New, monospace',
                      fontWeight:'bold',
                    }}>
                      {o.plate}
                    </div>
                    {o.ymm && (
                      <div style={{ color:'#aaa', fontSize:'11.5px', marginTop:'2px' }}>{o.ymm}</div>
                    )}
                    <div style={{ color:'#666', fontSize:'11px', marginTop:'3px', lineHeight:'1.4' }}>
                      {reasonText ?? <span style={{ fontStyle:'italic' }}>No reason recorded</span>}
                      {deactivatedAt && (
                        <span style={{ color:'#555' }}> · {deactivatedAt}</span>
                      )}
                      {o.status && !reasonText && (
                        <span style={{ color:'#555' }}> · status: {o.status}</span>
                      )}
                    </div>
                    {o.deactivation_note && (
                      <div style={{
                        color:'#888', fontSize:'11px', marginTop:'4px',
                        fontStyle:'italic', lineHeight:'1.4',
                      }}>&ldquo;{o.deactivation_note}&rdquo;</div>
                    )}
                  </div>
                </div>
              </label>
            )
          })}
        </div>

        <div style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
          <button
            onClick={handleRestore}
            disabled={isBusy || restoreCount === 0}
            title={restoreCount === 0 ? 'Check at least one plate to restore, or use "Approve without restoring" below.' : undefined}
            style={{
              padding:'11px', background: (isBusy || restoreCount === 0) ? '#555' : '#C9A227',
              color: (isBusy || restoreCount === 0) ? '#888' : '#0f1117',
              border:'none', borderRadius:'6px',
              cursor: (isBusy || restoreCount === 0) ? 'not-allowed' : 'pointer',
              fontSize:'13px', fontWeight:'bold',
            }}>
            {isBusy
              ? 'Working…'
              : restoreCount === 0
                ? 'Restore selected + Approve'
                : `Restore ${restoreCount} + Approve resident`}
          </button>
          <button
            onClick={handleApproveOnly}
            disabled={isBusy}
            style={{
              padding:'10px', background:'#1e2535', color:'#aaa',
              border:'1px solid #3a4055', borderRadius:'6px',
              cursor: isBusy ? 'not-allowed' : 'pointer', fontSize:'12px', fontWeight:'bold'
            }}>
            Approve without restoring
          </button>
          <button
            onClick={onCancel}
            disabled={isBusy}
            style={{
              padding:'8px', background:'transparent', color:'#666',
              border:'1px solid #2a2f3d', borderRadius:'6px',
              cursor: isBusy ? 'not-allowed' : 'pointer', fontSize:'11px',
            }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

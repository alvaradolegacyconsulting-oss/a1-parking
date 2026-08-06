'use client'
//
// Task 3 Commit 3 (2026-08-06) — Deactivate-vehicle modal.
// Sibling of DeactivateResidentModal, NOT a generalization. The
// resident modal carries co-resident household-batching logic that
// has no vehicle analogue; forcing one component to serve both
// would produce a worse version of each.
//
// Replaces the native window.confirm() at manager/page.tsx:1803 —
// the only place a manager could deactivate a vehicle before this
// commit. There's no place in a native confirm to collect a
// structured reason + note, which is why this modal exists.
//
// Reason applies to a SINGLE vehicle — no batching. One vehicle at
// a time, one reason.
//
// UI-side validation is fast-fail; the deactivate_vehicle DEFINER
// RPC re-validates for real (reason presence, note-required-on-
// other, system-code rejection). See manager-crm-writes.ts
// deactivateVehicleWrite + migrations/20260806_deactivate_vehicle_rpc.

import { useState } from 'react'
import {
  VEHICLE_DEACTIVATION_REASONS,
  reasonRequiresNote,
  DEACTIVATION_NOTE_MAX_LENGTH,
} from '../lib/deactivation-reasons'

export interface DeactivateVehicleConfirmArgs {
  reason: string
  note:   string | null
}

interface Props {
  vehiclePlate:     string    // "ABC-1234" — for display
  vehicleYmm?:      string    // "2023 Toyota Camry" — optional context
  residentName?:    string    // owning resident, for context
  residentUnit?:    string    // unit, for context
  isBusy?:          boolean   // disable buttons while write in flight
  onCancel:         () => void
  onConfirm:        (args: DeactivateVehicleConfirmArgs) => void
}

export default function DeactivateVehicleModal({
  vehiclePlate,
  vehicleYmm,
  residentName,
  residentUnit,
  isBusy = false,
  onCancel,
  onConfirm,
}: Props) {
  const [reason, setReason] = useState<string>('')
  const [note, setNote] = useState<string>('')

  const noteRequired   = reasonRequiresNote(reason)
  const noteTrimmed    = note.trim()
  const noteMissing    = noteRequired && noteTrimmed.length === 0
  const reasonSelected = reason.length > 0
  const canSubmit      = reasonSelected && !noteMissing && !isBusy

  const handleConfirm = () => {
    if (!canSubmit) return
    onConfirm({
      reason,
      note: noteTrimmed.length > 0 ? noteTrimmed.slice(0, DEACTIVATION_NOTE_MAX_LENGTH) : null,
    })
  }

  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999,
      display:'flex', alignItems:'center', justifyContent:'center', padding:'20px'
    }}>
      <div style={{
        background:'#161b26', border:'1px solid #f59e0b', borderRadius:'14px',
        padding:'22px', maxWidth:'460px', width:'100%', maxHeight:'90vh', overflowY:'auto'
      }}>
        <p style={{
          color:'#f59e0b', fontSize:'11px', textTransform:'uppercase',
          letterSpacing:'0.08em', margin:'0 0 8px', fontWeight:'bold'
        }}>
          Deactivate vehicle
        </p>
        <p style={{
          color:'white', fontSize:'16px', margin:'0 0 4px', fontWeight:'bold',
          fontFamily:'Courier New, monospace',
        }}>
          {vehiclePlate}
        </p>
        {vehicleYmm && (
          <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 6px' }}>{vehicleYmm}</p>
        )}
        {(residentName || residentUnit) && (
          <p style={{ color:'#888', fontSize:'12px', margin:'0 0 14px' }}>
            {residentName || 'Unassigned'}{residentUnit ? ` · Unit ${residentUnit}` : ''}
          </p>
        )}

        <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 12px', lineHeight:'1.5' }}>
          Deactivating this vehicle will drop it from authorization — driver plate lookups
          will return &ldquo;not authorized.&rdquo; The record is kept for audit. You can
          reactivate later; that routes through the approval flow.
        </p>

        {/* Reason (required) */}
        <div style={{ marginBottom:'12px' }}>
          <label style={{
            display:'block', color:'#aaa', fontSize:'11px',
            textTransform:'uppercase', letterSpacing:'0.05em',
            marginBottom:'6px', fontWeight:'bold'
          }}>
            Reason <span style={{ color:'#f59e0b' }}>(required)</span>
          </label>
          <select
            value={reason}
            onChange={e => setReason(e.target.value)}
            disabled={isBusy}
            style={{
              width:'100%', padding:'8px 10px',
              background:'#0f1117', color:'white',
              border:`1px solid ${reasonSelected ? '#3a4055' : '#a16207'}`,
              borderRadius:'6px', fontSize:'13px',
              fontFamily:'inherit',
              cursor: isBusy ? 'not-allowed' : 'pointer',
            }}
          >
            <option value="" disabled>— Select a reason —</option>
            {VEHICLE_DEACTIVATION_REASONS.map(r => (
              <option key={r.code} value={r.code}>{r.label}</option>
            ))}
          </select>
        </div>

        {/* Note (optional; required on 'other') */}
        <div style={{ marginBottom:'14px' }}>
          <label style={{
            display:'block', color:'#aaa', fontSize:'11px',
            textTransform:'uppercase', letterSpacing:'0.05em',
            marginBottom:'6px', fontWeight:'bold'
          }}>
            Note {noteRequired ? <span style={{ color:'#f59e0b' }}>(required)</span> : <span style={{ color:'#666' }}>(optional)</span>}
          </label>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            disabled={isBusy}
            maxLength={DEACTIVATION_NOTE_MAX_LENGTH}
            rows={2}
            placeholder={noteRequired ? 'A note is required when the reason is "Other".' : 'Optional internal note.'}
            style={{
              width:'100%', padding:'8px 10px',
              background:'#0f1117', color:'white',
              border:`1px solid ${noteMissing ? '#a16207' : '#3a4055'}`,
              borderRadius:'6px', fontSize:'13px',
              fontFamily:'inherit',
              resize:'vertical', boxSizing:'border-box',
            }}
          />
          <p style={{ color:'#555', fontSize:'10px', margin:'4px 0 0', textAlign:'right' }}>
            {noteTrimmed.length} / {DEACTIVATION_NOTE_MAX_LENGTH}
          </p>
          <p style={{ color:'#666', fontSize:'10px', margin:'2px 0 0', fontStyle:'italic' }}>
            Internal — not shown to the resident.
          </p>
        </div>

        <div style={{ display:'flex', gap:'8px' }}>
          <button
            onClick={onCancel}
            disabled={isBusy}
            style={{
              flex:1, padding:'10px', background:'#1e2535', color:'#aaa',
              border:'1px solid #3a4055', borderRadius:'6px',
              cursor: isBusy ? 'not-allowed' : 'pointer', fontSize:'12px', fontWeight:'bold'
            }}>
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canSubmit}
            style={{
              flex:1, padding:'10px',
              background: !canSubmit ? '#555' : '#f59e0b',
              color:      !canSubmit ? '#888' : '#0f1117',
              border:'none', borderRadius:'6px',
              cursor:     !canSubmit ? 'not-allowed' : 'pointer',
              fontSize:'12px', fontWeight:'bold'
            }}>
            {isBusy
              ? 'Deactivating…'
              : !reasonSelected
                ? 'Select a reason'
                : noteMissing
                  ? 'Add a note'
                  : 'Deactivate vehicle'}
          </button>
        </div>
      </div>
    </div>
  )
}

'use client'
// Tow Ticket Regenerate — Layer 2 driver-side modal.
//
// Calls the regenerate_tow_ticket DEFINER RPC (shipped Layer 1,
// migration 20260626_tow_ticket_regenerate_layer_1.sql).
//
// 🔒 LOCKED INVARIANTS
//   - Driver regenerate ONLY (no standalone-void). This modal only
//     calls regenerate_tow_ticket; no path to void_violation.
//   - Permission-gated visibility is the CALLER'S responsibility
//     (render the "Regenerate" button only when
//     driver.can_regenerate_tow_ticket === true AND the target is
//     stamped AND not voided). This modal trusts the RPC as the
//     real server-side gate — render-gate is UX only.
//   - Reason is REQUIRED; 'other' requires a note ≥5 chars (matches
//     the RPC's pre-validation).
//   - Destructive action is EXPLICIT — driver sees old facility +
//     new facility + new fee BEFORE confirming, with the
//     "voids the current tow ticket" copy block.
//
// REASON TAXONOMY mirrors the Layer 1 CHECK constraint exactly. Keep
// in sync with violations_regenerate_reason_valid in the migration.

import { useMemo, useState } from 'react'
import { supabase } from '../supabase'

export type RegenerateReason =
  | 'facility_closed'
  | 'wrong_facility'
  | 'facility_changed'
  | 'vehicle_not_accepted'
  | 'other'

export const REGENERATE_REASON_LABELS: Record<RegenerateReason, string> = {
  facility_closed:      'Facility closed / unavailable',
  wrong_facility:       'Wrong facility',
  facility_changed:     'Facility changed',
  vehicle_not_accepted: 'Vehicle not accepted',
  other:                'Other (note required)',
}

const REASON_ORDER: RegenerateReason[] = [
  'facility_closed',
  'wrong_facility',
  'facility_changed',
  'vehicle_not_accepted',
  'other',
]

export interface StorageFacility {
  id: number | string
  name: string
  address?: string | null
}

export interface RegenerateTarget {
  id: number
  plate?: string | null
  tow_storage_name?: string | null
  tow_fee?: number | string | null
  // Mileage + VIN persistence (migration 20260629). Both optional;
  // pre-filled in the modal from the original row so the driver can
  // keep-or-change. VIN specifically supports the dark-lot scenario:
  // driver stamped without reading the VIN, facility later reports
  // it, driver regenerates to add it.
  tow_mileage_fee?: number | string | null
  vehicle_vin?: string | null
}

export interface RegenerateSuccessPayload {
  new_violation_id: number
  violation: Record<string, unknown>
  original_id: number
}

interface Props {
  target:            RegenerateTarget
  storageFacilities: StorageFacility[]
  onCancel:          () => void
  onSuccess:         (payload: RegenerateSuccessPayload) => void
}

export default function RegenerateTicketModal({
  target,
  storageFacilities,
  onCancel,
  onSuccess,
}: Props) {
  const [reason,        setReason]        = useState<RegenerateReason | ''>('')
  const [reasonNote,    setReasonNote]    = useState<string>('')
  const [newStorageId,  setNewStorageId]  = useState<string>('')
  const [newTowFee,     setNewTowFee]     = useState<string>('')
  // Mileage + VIN: pre-filled from the ORIGINAL row's values so the
  // driver can keep-or-change. Both optional; neither gates canConfirm.
  // VIN pre-fill supports the dark-lot scenario: regenerate to ADD the
  // VIN once readable at the facility (original may have been NULL).
  const [newMileageFee, setNewMileageFee] = useState<string>(target.tow_mileage_fee != null ? String(target.tow_mileage_fee) : '')
  const [newVin,        setNewVin]        = useState<string>(target.vehicle_vin ?? '')
  const [busy,          setBusy]          = useState<boolean>(false)
  const [error,         setError]         = useState<string>('')

  const newStorage  = useMemo(() => storageFacilities.find(s => String(s.id) === newStorageId), [storageFacilities, newStorageId])
  const newFeeNum   = parseFloat(newTowFee || '0')
  const oldFacility = target.tow_storage_name || '—'
  const oldFeeNum   = Number(target.tow_fee || 0)

  const noteRequired = reason === 'other'
  const noteValid    = !noteRequired || (reasonNote.trim().length >= 5)
  const canConfirm   = !busy
    && reason !== ''
    && noteValid
    && !!newStorageId
    && newFeeNum > 0

  async function handleConfirm() {
    if (!canConfirm || !reason) return
    setBusy(true)
    setError('')
    // Mileage + VIN: send NULL when blank (the RPC's COALESCE
    // semantic would keep prior value on NULL, but for a fresh
    // regenerate the new row's column starts NULL — driver leaving
    // blank means "no charge / no VIN on the new ticket").
    const newMileageNum   = parseFloat(newMileageFee || '0')
    const newMileageToSend = newMileageFee.trim().length > 0 ? newMileageNum : null
    const newVinTrimmed    = newVin.trim()
    const newVinToSend     = newVinTrimmed.length > 0 ? newVinTrimmed : null

    const { data, error: rpcErr } = await supabase.rpc('regenerate_tow_ticket', {
      p_original_violation_id:   target.id,
      p_new_storage_facility_id: Number(newStorageId),
      p_new_tow_fee:             newFeeNum,
      p_reason:                  reason,
      p_reason_note:             noteRequired ? reasonNote.trim() : null,
      p_new_mileage_fee:         newMileageToSend,
      p_new_vin:                 newVinToSend,
    })
    setBusy(false)
    if (rpcErr) {
      setError('Could not regenerate ticket: ' + rpcErr.message)
      return
    }
    const result = data as { ok?: boolean; error?: string; hint?: string; new_violation_id?: number; violation?: Record<string, unknown> }
    if (result?.error) {
      const messages: Record<string, string> = {
        unauthenticated:               'Your session has expired. Please log in again.',
        no_role_assigned:              'Your account has no role assigned. Contact your company admin.',
        no_company_assigned:           'Your account has no company assigned. Contact your company admin.',
        role_not_authorized:           "You don't have permission to regenerate tickets.",
        regenerate_not_permitted:      "You don't have permission to regenerate — contact your company admin.",
        invalid_reason:                result.hint || 'Please select a regenerate reason.',
        reason_note_required:          'Please describe the issue (at least 5 characters).',
        violation_not_found:           'This ticket was not found. It may have been removed.',
        not_confirmed:                 "This violation hasn't been confirmed yet and can't be regenerated.",
        already_voided:                'This ticket has already been voided. Refresh the list.',
        not_stamped:                   "This ticket hasn't been stamped yet. Use Generate Tow Ticket first.",
        violation_out_of_scope:        'This ticket is not at one of your assigned properties.',
        storage_facility_not_found:    'That storage facility was not found.',
        storage_facility_out_of_scope: "That storage facility isn't available for your company.",
      }
      setError(messages[result.error] || `Error: ${result.error}`)
      return
    }
    if (result?.ok && result.new_violation_id && result.violation) {
      onSuccess({
        new_violation_id: result.new_violation_id,
        violation:        result.violation,
        original_id:      target.id,
      })
      return
    }
    setError('Unexpected response from regenerate. Please refresh and try again.')
  }

  // Display strings for the destructive-action band
  const newFacilityName = newStorage?.name || '(select a facility)'
  const newFeeDisplay   = newFeeNum > 0 ? `$${newFeeNum.toFixed(2)}` : '(set the new fee)'

  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999,
      display:'flex', alignItems:'center', justifyContent:'center', padding:'20px',
      overflowY:'auto',
    }}>
      <div style={{
        background:'#161b26', border:'1px solid #f59e0b', borderRadius:'14px',
        padding:'22px', maxWidth:'480px', width:'100%', maxHeight:'90vh',
        overflowY:'auto', boxSizing:'border-box',
      }}>
        {/* Header */}
        <p style={{ color:'#f59e0b', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px', fontWeight:'bold' }}>
          ⚠ Regenerate tow ticket
        </p>
        <p style={{ color:'white', fontSize:'15px', margin:'0 0 4px', fontWeight:'bold' }}>
          Plate {target.plate || '—'}
        </p>
        <p style={{ color:'#888', fontSize:'12px', margin:'0 0 16px' }}>
          Current ticket: <span style={{ color:'#aaa' }}>{oldFacility}</span>
          {oldFeeNum > 0 && <span style={{ color:'#aaa' }}> · ${oldFeeNum.toFixed(2)}</span>}
        </p>

        {/* ── 1. Reason ── */}
        <div style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', marginBottom:'12px' }}>
          <p style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 10px', fontWeight:'bold' }}>
            1. Reason (required)
          </p>
          {REASON_ORDER.map(r => (
            <label key={r} style={{
              display:'flex', alignItems:'center', gap:'8px',
              padding:'6px 0', cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.6 : 1,
            }}>
              <input
                type="radio"
                name="regen-reason"
                value={r}
                checked={reason === r}
                onChange={() => setReason(r)}
                disabled={busy}
              />
              <span style={{ color:'white', fontSize:'13px' }}>{REGENERATE_REASON_LABELS[r]}</span>
            </label>
          ))}
          {noteRequired && (
            <textarea
              value={reasonNote}
              onChange={e => setReasonNote(e.target.value)}
              placeholder="Describe the issue (at least 5 characters)"
              disabled={busy}
              rows={3}
              style={{
                width:'100%', marginTop:'8px', padding:'8px 10px',
                background:'#1e2535', border:`1px solid ${noteValid ? '#3a4055' : '#b71c1c'}`,
                borderRadius:'6px', color:'white', fontSize:'12px',
                boxSizing:'border-box', resize:'vertical', fontFamily:'inherit',
              }}
            />
          )}
          {noteRequired && !noteValid && reasonNote.length > 0 && (
            <p style={{ color:'#f44336', fontSize:'11px', margin:'4px 0 0' }}>
              Note must be at least 5 characters.
            </p>
          )}
        </div>

        {/* ── 2. New ticket details ── */}
        <div style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', marginBottom:'12px' }}>
          <p style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 10px', fontWeight:'bold' }}>
            2. New ticket details
          </p>
          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.05em', display:'block', marginBottom:'4px' }}>
            Storage facility
          </label>
          <select
            value={newStorageId}
            onChange={e => setNewStorageId(e.target.value)}
            disabled={busy}
            style={{
              display:'block', width:'100%', padding:'9px 10px',
              background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px',
              color:'white', fontSize:'13px', marginBottom:'10px',
              boxSizing:'border-box', fontFamily:'inherit',
            }}>
            <option value="">Select a facility…</option>
            {storageFacilities.map(s => (
              <option key={String(s.id)} value={String(s.id)} style={{ background:'#1e2535' }}>
                {s.name}{s.address ? ` — ${s.address}` : ''}
              </option>
            ))}
          </select>
          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.05em', display:'block', marginBottom:'4px' }}>
            New tow fee
          </label>
          <div style={{ display:'flex', alignItems:'center', gap:'6px', marginBottom:'10px' }}>
            <span style={{ color:'#888', fontSize:'14px', fontWeight:'bold' }}>$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={newTowFee}
              onChange={e => setNewTowFee(e.target.value)}
              disabled={busy}
              placeholder="0.00"
              style={{
                flex:1, padding:'9px 10px',
                background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px',
                color:'white', fontSize:'13px', boxSizing:'border-box', fontFamily:'inherit',
              }}
            />
          </div>
          {/* Mileage Fee — pre-filled from original row; optional;
              doesn't gate canConfirm. Blank → null persisted on the
              new row (intentional "no mileage charge"). */}
          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.05em', display:'block', marginBottom:'4px' }}>
            New mileage fee <span style={{ color:'#555', textTransform:'none', letterSpacing:0 }}>(optional)</span>
          </label>
          <div style={{ display:'flex', alignItems:'center', gap:'6px', marginBottom:'10px' }}>
            <span style={{ color:'#888', fontSize:'14px', fontWeight:'bold' }}>$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={newMileageFee}
              onChange={e => setNewMileageFee(e.target.value)}
              disabled={busy}
              placeholder="0.00"
              style={{
                flex:1, padding:'9px 10px',
                background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px',
                color:'white', fontSize:'13px', boxSizing:'border-box', fontFamily:'inherit',
              }}
            />
          </div>
          {/* VIN — pre-filled from original (often NULL pre-stamp;
              dark-lot scenario). Optional; doesn't gate canConfirm.
              No length/format validation here — Texas-plate VINs vary
              and the field is operator-typed. */}
          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.05em', display:'block', marginBottom:'4px' }}>
            VIN <span style={{ color:'#555', textTransform:'none', letterSpacing:0 }}>(optional)</span>
          </label>
          <input
            type="text"
            value={newVin}
            onChange={e => setNewVin(e.target.value)}
            disabled={busy}
            placeholder="17-character VIN"
            style={{
              width:'100%', padding:'9px 10px',
              background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px',
              color:'white', fontSize:'13px', boxSizing:'border-box', fontFamily:'inherit',
            }}
          />
        </div>

        {/* ── 3. Confirm (destructive-action band) ── */}
        <div style={{
          background:'#1a1400', border:'1px solid #a16207', borderRadius:'8px',
          padding:'12px 14px', marginBottom:'12px',
        }}>
          <p style={{ color:'#fbbf24', fontSize:'12px', margin:'0 0 6px', fontWeight:'bold' }}>
            ⚠ This voids the current tow ticket and creates a new one.
          </p>
          <p style={{ color:'#fde68a', fontSize:'11px', margin:'0', lineHeight:'1.55' }}>
            The current ticket for <strong>{oldFacility}</strong> will be permanently voided.
            A new ticket will be issued for <strong>{newFacilityName}</strong> with fee <strong>{newFeeDisplay}</strong>
            {newMileageFee.trim().length > 0 && <>{' '}+ mileage <strong>${parseFloat(newMileageFee).toFixed(2)}</strong></>}
            {newVin.trim().length > 0 && <>, VIN <strong style={{ fontFamily:'Courier New' }}>{newVin.trim()}</strong></>}
            . The old ticket cannot be reused or reactivated.
          </p>
          {noteRequired && reasonNote.trim().length > 0 && (
            <p style={{ color:'#fde68a', fontSize:'11px', margin:'8px 0 0', fontStyle:'italic' }}>
              Note: {reasonNote.trim()}
            </p>
          )}
        </div>

        {/* Error display */}
        {error && (
          <div style={{
            background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px',
            padding:'8px 10px', marginBottom:'10px',
          }}>
            <p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{error}</p>
          </div>
        )}

        {/* Buttons */}
        <div style={{ display:'flex', gap:'8px' }}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              flex:1, padding:'10px',
              background:'#1e2535', color:'#aaa',
              border:'1px solid #3a4055', borderRadius:'6px',
              cursor: busy ? 'not-allowed' : 'pointer',
              fontSize:'12px', fontWeight:'bold', fontFamily:'Arial',
            }}>
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            style={{
              flex:2, padding:'10px',
              background: canConfirm ? '#f59e0b' : '#555',
              color: canConfirm ? '#0f1117' : '#888',
              border:'none', borderRadius:'6px',
              cursor: canConfirm ? 'pointer' : 'not-allowed',
              fontSize:'12px', fontWeight:'bold', fontFamily:'Arial',
            }}>
            {busy ? 'Regenerating…' : 'Confirm regenerate'}
          </button>
        </div>
      </div>
    </div>
  )
}

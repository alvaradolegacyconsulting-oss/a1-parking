'use client'
// B71: shared decline-and-proceed interstitial. Renders only when a
// driver/CA-portal user clicks "Issue Violation" against an AUTHORIZED
// plate (active resident or active visitor pass). Captures structured
// reason + optional note; the parent flow then opens the existing
// violation form with these fields locked and persists them on the
// violations row as decline_reason / decline_reason_note alongside
// was_authorized_at_time=true.
//
// Reason values are the CHECK-constraint enum from
// migrations/20260522_b70_b71_polish_pass.sql. Keep this list in sync
// with the SQL CHECK if you ever add a value (e.g., `abandoned` if
// Jose's "route through other with note" guidance changes).

import { useState } from 'react'

export type DeclineReason =
  | 'fire_lane'
  | 'handicap_violation'
  | 'blocked_access'
  | 'reserved_space'
  | 'double_parked'
  | 'other'

export const DECLINE_REASON_LABELS: Record<DeclineReason, string> = {
  fire_lane:          'Parked in fire lane',
  handicap_violation: 'Handicap space without permit',
  blocked_access:     'Blocking access (driveway, dumpster, gate, etc.)',
  reserved_space:     'Parked in reserved/assigned space not theirs',
  double_parked:      'Double-parked or blocking another vehicle',
  other:              'Other (specify below — e.g., abandoned vehicle, unsafe parking, other location/manner issue)',
}

const OTHER_NOTE_MIN_LENGTH = 10

interface Props {
  plate: string
  authorizedAs: 'resident' | 'visitor'
  /** Description fragment shown in the banner ("active resident at Unit 12B", "active visitor pass visiting Unit 7"). Caller composes from scan result. */
  authorizedDetail?: string
  onCancel: () => void
  onConfirm: (reason: DeclineReason, note: string | null) => void
}

export default function DeclineReasonModal({ plate, authorizedAs, authorizedDetail, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState<DeclineReason | ''>('')
  const [note, setNote] = useState('')

  const needsNote = reason === 'other'
  const noteOk = !needsNote || note.trim().length >= OTHER_NOTE_MIN_LENGTH
  const canConfirm = reason !== '' && noteOk

  function confirm() {
    // canConfirm = (reason !== '' && noteOk), so the cast is safe.
    if (!canConfirm) return
    onConfirm(reason as DeclineReason, note.trim().length > 0 ? note.trim() : null)
  }

  const authorizedLabel = authorizedAs === 'resident' ? 'active resident' : 'active visitor pass'

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
      <div style={{ background:'#161b26', border:'1px solid #C9A227', borderRadius:'14px', padding:'24px', maxWidth:'500px', width:'100%', maxHeight:'90vh', overflowY:'auto' }}>

        <p style={{ color:'#C9A227', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px', fontWeight:'bold' }}>Authorized plate override</p>
        <h2 style={{ color:'white', fontSize:'18px', fontWeight:'bold', margin:'0 0 12px' }}>
          Issue a violation against an authorized vehicle?
        </h2>

        <div style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px 14px', marginBottom:'16px' }}>
          <p style={{ color:'#888', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 4px' }}>Plate</p>
          <p style={{ color:'#86efac', fontFamily:'Courier New', fontSize:'16px', fontWeight:'bold', margin:'0 0 6px' }}>{plate}</p>
          <p style={{ color:'#aaa', fontSize:'12px', margin:'0', lineHeight:'1.5' }}>
            This plate is an <strong style={{ color:'#86efac' }}>{authorizedLabel}</strong>{authorizedDetail ? ` ${authorizedDetail}` : ''}. Authorized vehicles can still be parked illegally (fire lane, handicap, blocked access, etc.). Select the reason for overriding to log a location/manner violation.
          </p>
        </div>

        <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', display:'block', marginBottom:'6px', fontWeight:'bold' }}>Reason *</label>
        <select
          value={reason}
          onChange={e => setReason(e.target.value as DeclineReason | '')}
          style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'10px 12px', color:'white', width:'100%', fontSize:'13px', marginBottom:'14px', fontFamily:'Arial', outline:'none' }}>
          <option value=''>Select a reason...</option>
          {(Object.keys(DECLINE_REASON_LABELS) as DeclineReason[]).map(key => (
            <option key={key} value={key}>{DECLINE_REASON_LABELS[key]}</option>
          ))}
        </select>

        {needsNote && (
          <>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', display:'block', marginBottom:'6px', fontWeight:'bold' }}>
              Note * <span style={{ color:'#666', textTransform:'none', letterSpacing:'normal', fontSize:'10px', fontWeight:'normal' }}>(minimum {OTHER_NOTE_MIN_LENGTH} characters)</span>
            </label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Describe the violation — e.g., 'abandoned vehicle, has not moved in 3 weeks, flat tire' or 'parked diagonally across two reserved spots'"
              rows={3}
              style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'10px 12px', color:'white', width:'100%', fontSize:'13px', marginBottom:'4px', fontFamily:'Arial', outline:'none', boxSizing:'border-box', resize:'vertical', lineHeight:'1.5' }}
            />
            <p style={{ color: noteOk ? '#555' : '#f59e0b', fontSize:'11px', margin:'0 0 14px' }}>
              {note.trim().length}/{OTHER_NOTE_MIN_LENGTH} characters{noteOk ? ' — OK' : ''}
            </p>
          </>
        )}

        <div style={{ display:'flex', gap:'10px', marginTop:'8px' }}>
          <button
            onClick={onCancel}
            style={{ flex:1, padding:'12px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontSize:'13px', fontWeight:'bold', fontFamily:'Arial' }}>
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={!canConfirm}
            style={{ flex:1, padding:'12px', background: canConfirm ? '#991b1b' : '#555', color: canConfirm ? 'white' : '#888', border:'none', borderRadius:'8px', cursor: canConfirm ? 'pointer' : 'not-allowed', fontSize:'13px', fontWeight:'bold', fontFamily:'Arial' }}>
            Continue to violation form
          </button>
        </div>
      </div>
    </div>
  )
}

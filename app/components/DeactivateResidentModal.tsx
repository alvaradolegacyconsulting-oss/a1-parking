'use client'
//
// Spaces v1.1 — Deactivate-resident modal (replaces the old confirm() at
// manager/page.tsx deactivateResident entry).
//
// Per the cost-probe Q-E spec: when deactivating a resident, show
// co-residents at the same unit with checkboxes so the manager can
// deactivate them together in one action ("the whole household is
// moving out").
//
// DEFAULT UNCHECKED — deactivate-target-only is the safe default per
// Jose's spec. Manager has to deliberately check co-residents to include
// them. No accidental cascade.
//
// CO-RESIDENT DATA: caller passes the already-loaded co-resident list
// (manager has it via fetchResidentsAtUnit which is a property-tab helper).
// This component doesn't fetch — it just renders + collects checkbox
// state. The caller's onConfirm callback receives {reason, note,
// alsoEmails}; the caller does the actual deactivations.
//
// INTERACTION WITH THE V1.1 TRIGGER: each individual deactivate call
// fires the residents_deactivate_free_spaces trigger separately. If
// A + B are both tied to the same space C-1 and the manager deactivates
// both via this modal, the first call removes A's tie (space stays
// 'assigned' to B); the second call removes B's tie (space frees to
// 'available'). The trigger handles the lifecycle; this modal only
// orchestrates the sequence of deactivations.
//
// ── 2026-08-05 Task 3 Commit 2 additions ─────────────────────────────
//
// Required deactivation reason dropdown + optional note textarea (note
// required when reason='other'). Reason applies to the WHOLE batch —
// target + all opted-in co-residents — because they're being
// deactivated as a unit (the household moves out for the same reason
// as the target). Modal copy states this explicitly.
//
// Batch runs stop-on-first-fail (Mateo Aug 5 lock). Modal copy states
// that "if one deactivation fails, remaining residents in the batch
// are not attempted" so the manager isn't surprised by partial state.

import { useState } from 'react'
import {
  RESIDENT_DEACTIVATION_REASONS,
  reasonRequiresNote,
  DEACTIVATION_NOTE_MAX_LENGTH,
} from '../lib/deactivation-reasons'

export interface CoResident {
  email: string
  name: string
  // unit + property are implicit (all co-residents share unit by definition)
}

export interface DeactivateResidentConfirmArgs {
  reason:     string
  note:       string | null
  alsoEmails: string[]
}

interface Props {
  targetResidentName: string             // "Sarah Chen"
  targetResidentEmail: string            // for display only
  targetResidentUnit: string             // "207" — for context line
  coResidents: CoResident[]              // pre-loaded; filtered to exclude target; active only
  isBusy?: boolean                       // disable buttons while deactivations in flight
  onCancel: () => void
  onConfirm: (args: DeactivateResidentConfirmArgs) => void
}

export default function DeactivateResidentModal({
  targetResidentName,
  targetResidentEmail,
  targetResidentUnit,
  coResidents,
  isBusy = false,
  onCancel,
  onConfirm,
}: Props) {
  const [checkedEmails, setCheckedEmails] = useState<Set<string>>(new Set())
  const [reason, setReason] = useState<string>('')
  const [note, setNote] = useState<string>('')

  const toggleEmail = (email: string) => {
    if (isBusy) return
    setCheckedEmails(prev => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })
  }

  const checkedCount   = checkedEmails.size
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
      alsoEmails: Array.from(checkedEmails),
    })
  }

  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999,
      display:'flex', alignItems:'center', justifyContent:'center', padding:'20px'
    }}>
      <div style={{
        background:'#161b26', border:'1px solid #f59e0b', borderRadius:'14px',
        padding:'22px', maxWidth:'480px', width:'100%', maxHeight:'90vh', overflowY:'auto'
      }}>
        <p style={{
          color:'#f59e0b', fontSize:'11px', textTransform:'uppercase',
          letterSpacing:'0.08em', margin:'0 0 8px', fontWeight:'bold'
        }}>
          Deactivate resident
        </p>
        <p style={{ color:'white', fontSize:'15px', margin:'0 0 4px', fontWeight:'bold' }}>
          {targetResidentName || targetResidentEmail}
        </p>
        <p style={{ color:'#888', fontSize:'12px', margin:'0 0 14px' }}>
          Unit {targetResidentUnit || '—'} · {targetResidentEmail}
        </p>

        <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 12px', lineHeight:'1.5' }}>
          Deactivating this resident will drop their vehicles from authorization
          and free any spaces tied solely to them. Their assignment history is preserved.
        </p>

        {/* Reason dropdown (required) */}
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
            {RESIDENT_DEACTIVATION_REASONS.map(r => (
              <option key={r.code} value={r.code}>{r.label}</option>
            ))}
          </select>
        </div>

        {/* Note (optional, required when reason='other') */}
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

        {coResidents.length > 0 && (
          <div style={{
            background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px',
            padding:'12px', marginBottom:'14px'
          }}>
            <p style={{
              color:'#888', fontSize:'11px', textTransform:'uppercase',
              letterSpacing:'0.05em', margin:'0 0 8px'
            }}>
              Other active residents at Unit {targetResidentUnit}
            </p>
            <p style={{ color:'#666', fontSize:'11px', margin:'0 0 10px', lineHeight:'1.5' }}>
              Check any that are also moving out — they&apos;ll be deactivated together
              with the same reason. Default is target only.
            </p>
            {coResidents.map(co => (
              <label key={co.email} style={{
                display:'flex', alignItems:'center', gap:'8px',
                padding:'6px 0', cursor: isBusy ? 'not-allowed' : 'pointer',
                opacity: isBusy ? 0.6 : 1,
              }}>
                <input
                  type="checkbox"
                  checked={checkedEmails.has(co.email)}
                  onChange={() => toggleEmail(co.email)}
                  disabled={isBusy}
                />
                <span style={{ color:'white', fontSize:'13px' }}>
                  {co.name || co.email}
                </span>
                {co.name && (
                  <span style={{ color:'#666', fontSize:'11px' }}>{co.email}</span>
                )}
              </label>
            ))}
            {checkedCount > 0 && (
              <p style={{ color:'#666', fontSize:'10px', margin:'8px 0 0', fontStyle:'italic', lineHeight:'1.4' }}>
                If one deactivation fails mid-batch, remaining residents are not attempted.
                You&apos;ll see which were already committed.
              </p>
            )}
          </div>
        )}

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
                  : checkedCount === 0
                    ? 'Deactivate'
                    : `Deactivate ${checkedCount + 1}`}
          </button>
        </div>
      </div>
    </div>
  )
}

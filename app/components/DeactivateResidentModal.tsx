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
// state. The caller's onConfirm callback receives the list of emails
// the manager checked; the caller does the actual deactivations.
//
// INTERACTION WITH THE V1.1 TRIGGER: each individual deactivate call
// fires the residents_deactivate_free_spaces trigger separately. If
// A + B are both tied to the same space C-1 and the manager deactivates
// both via this modal, the first call removes A's tie (space stays
// 'assigned' to B); the second call removes B's tie (space frees to
// 'available'). The trigger handles the lifecycle; this modal only
// orchestrates the sequence of deactivations.

import { useState } from 'react'

export interface CoResident {
  email: string
  name: string
  // unit + property are implicit (all co-residents share unit by definition)
}

interface Props {
  targetResidentName: string             // "Sarah Chen"
  targetResidentEmail: string            // for display only
  targetResidentUnit: string             // "207" — for context line
  coResidents: CoResident[]              // pre-loaded; filtered to exclude target; active only
  isBusy?: boolean                       // disable buttons while deactivations in flight
  onCancel: () => void
  onConfirm: (alsoDeactivateEmails: string[]) => void  // empty array = target only
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
  // Default-unchecked (safe default — manager must opt IN to cascade)
  const [checkedEmails, setCheckedEmails] = useState<Set<string>>(new Set())

  const toggleEmail = (email: string) => {
    if (isBusy) return
    setCheckedEmails(prev => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })
  }

  const checkedCount = checkedEmails.size

  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999,
      display:'flex', alignItems:'center', justifyContent:'center', padding:'20px'
    }}>
      <div style={{
        background:'#161b26', border:'1px solid #f59e0b', borderRadius:'14px',
        padding:'22px', maxWidth:'440px', width:'100%'
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
              Check any that are also moving out — they&apos;ll be deactivated together.
              Default is target only.
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
            onClick={() => onConfirm(Array.from(checkedEmails))}
            disabled={isBusy}
            style={{
              flex:1, padding:'10px',
              background: isBusy ? '#555' : '#f59e0b',
              color: isBusy ? '#888' : '#0f1117',
              border:'none', borderRadius:'6px',
              cursor: isBusy ? 'not-allowed' : 'pointer',
              fontSize:'12px', fontWeight:'bold'
            }}>
            {isBusy
              ? 'Deactivating…'
              : checkedCount === 0
                ? 'Deactivate'
                : `Deactivate ${checkedCount + 1}`}
          </button>
        </div>
      </div>
    </div>
  )
}

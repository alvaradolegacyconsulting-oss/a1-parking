'use client'
import React, { useState } from 'react'
import { supabase } from '../supabase'

// B175 — Violation void dialog.
//
// Sibling to MediaRemovalDialog (NOT a wrapper — its props are media-
// specific). Same UX (reason dropdown + "Other" min-5-char free-text +
// defense-in-depth empty-userEmail guard + alert-on-error) but writes
// through the SECURITY DEFINER void_violation RPC, not a direct table
// UPDATE. The RPC handles role gate + scope gate + draft/already-voided
// refusals + atomic VIOLATION_VOIDED audit log + RETURNing the updated
// row.
//
// Authority: admin + company_admin + manager only. The RPC will refuse
// any other role with {error: 'role_not_authorized'} but callers should
// gate the button render before this dialog opens — never show "Void"
// to a driver/leasing_agent/resident.
//
// Terminal: there is no un-void in v1. An erroneously-voided real
// violation is corrected by re-issuing a new violation row.

// Authority roles allowed to void. The caller gates the button render
// on this set; the void_violation RPC re-validates server-side. Kept
// as an exported type for callers to type their own role state.
export type VoiderRole = 'admin' | 'company_admin' | 'manager'

type Props = {
  open: boolean
  violationId: number
  // Summary fields for the dialog header (so the user sees what
  // they're voiding before confirming). Source from the row being
  // voided.
  plate: string
  property: string | null
  violationType?: string | null
  // The caller's email — used for the defense-in-depth empty-identity
  // guard (mirrors MediaRemovalDialog). The RPC writes voided_by_email
  // from auth.jwt() ->> 'email' server-side; this prop is for the
  // client-side refusal-when-blank, not for the audit-trail value.
  userEmail: string
  onCancel: () => void
  onVoided: (updatedRow: Record<string, unknown>) => void
}

const REASON_OPTIONS = [
  'Wrong plate',
  'Wrong vehicle',
  'Issued in error',
  'Duplicate',
  'Resolved with resident',
  'Other',
] as const
type Reason = typeof REASON_OPTIONS[number]

export default function ViolationVoidDialog({
  open, violationId, plate, property, violationType,
  userEmail, onCancel, onVoided,
}: Props) {
  const [reason, setReason] = useState<Reason | ''>('')
  const [otherText, setOtherText] = useState('')
  const [busy, setBusy] = useState(false)

  if (!open) return null

  const trimmedOther = otherText.trim()
  const otherValid = reason !== 'Other' || trimmedOther.length >= 5
  const canVoid = reason !== '' && otherValid && !busy

  async function handleVoid() {
    if (!canVoid) return
    // Defense-in-depth: refuse to write a blank audit trail (mirrors
    // MediaRemovalDialog). The parent should always have userEmail
    // populated by the time this dialog renders, but a race or auth
    // glitch could land us here with an empty string. Silent forensic-
    // trail data loss is worse than a user-visible refusal.
    if (!userEmail || userEmail.trim() === '') {
      alert('Cannot void: user identity not loaded. Please refresh and try again.')
      return
    }
    setBusy(true)
    const finalReason = reason === 'Other' ? trimmedOther : (reason as string)

    const { data, error } = await supabase.rpc('void_violation', {
      p_violation_id: violationId,
      p_void_reason: finalReason,
    })

    setBusy(false)

    if (error) {
      alert(`Void failed: ${error.message}`)
      return
    }
    // RPC returns either {ok: true, violation: {...}} or {error: '...'}.
    // The RPC's discriminator IS the load-bearing success signal (per
    // [[feedback-delete-smoke-must-use-returning]] — no silent no-op
    // on a write under RLS). Treat anything without ok=true as failure.
    const result = data as { ok?: boolean; violation?: Record<string, unknown>; error?: string }
    if (!result?.ok || !result.violation) {
      const code = result?.error || 'unknown_error'
      const human =
        code === 'role_not_authorized' ? 'Your role cannot void violations.'
        : code === 'out_of_scope'      ? "You don't have access to this violation."
        : code === 'not_confirmed'     ? 'Cannot void a draft. Discard it instead.'
        : code === 'already_voided'    ? 'This violation has already been voided.'
        : code === 'reason_required'   ? 'A reason is required.'
        : code === 'not_found'         ? 'Violation not found.'
        : code === 'unauthenticated'   ? 'Session expired. Please log in again.'
        : `Void refused: ${code}`
      alert(human)
      return
    }
    onVoided(result.violation)
  }

  return (
    <div style={overlayStyle}>
      <div style={cardStyle}>
        <p style={titleStyle}>
          🚫 Void this violation?
        </p>
        <p style={subTitleStyle}>
          This is <strong>permanent</strong> — voided violations cannot be un-voided.
          If you voided in error, re-issue the violation as a new ticket.
        </p>

        {/* What's being voided — operator confirmation */}
        <div style={summaryBoxStyle}>
          <div style={summaryRow}>
            <span style={summaryLabel}>Plate</span>
            <span style={{ ...summaryValue, fontFamily: 'Courier New', fontSize: 14, fontWeight: 'bold' }}>
              {plate}
            </span>
          </div>
          <div style={summaryRow}>
            <span style={summaryLabel}>Property</span>
            <span style={summaryValue}>{property || '—'}</span>
          </div>
          {violationType ? (
            <div style={summaryRow}>
              <span style={summaryLabel}>Type</span>
              <span style={summaryValue}>{violationType}</span>
            </div>
          ) : null}
        </div>

        <label style={fieldLabelStyle}>Reason</label>
        <select value={reason} onChange={e => setReason(e.target.value as Reason | '')}
          disabled={busy}
          style={selectStyle}>
          <option value="">-- Select a reason --</option>
          {REASON_OPTIONS.map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>

        {reason === 'Other' && (
          <>
            <label style={fieldLabelStyle}>Please specify (min 5 characters)</label>
            <textarea value={otherText} onChange={e => setOtherText(e.target.value)}
              disabled={busy}
              placeholder="Briefly describe why you are voiding"
              rows={3}
              style={textareaStyle} />
            <p style={{
              color: trimmedOther.length >= 5 ? '#4caf50' : '#888',
              fontSize: 11, margin: '0 0 10px',
            }}>
              {trimmedOther.length}/5 characters
            </p>
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={onCancel} disabled={busy} style={cancelBtnStyle(busy)}>
            Cancel
          </button>
          <button onClick={handleVoid} disabled={!canVoid} style={voidBtnStyle(canVoid)}>
            {busy ? 'Voiding…' : 'Void violation'}
          </button>
        </div>

        <p style={{ color: '#777', fontSize: 10, margin: '14px 0 0', textAlign: 'center', lineHeight: 1.4 }}>
          Voiding is audit-logged with your identity, role, and reason.
          The public tow-ticket link, if any, will immediately stop rendering this ticket.
        </p>
      </div>
    </div>
  )
}

// ─── Styles ────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000, padding: 16,
}

const cardStyle: React.CSSProperties = {
  background: '#0f1117', border: '1px solid #b71c1c', borderRadius: 10,
  padding: 20, maxWidth: 460, width: '100%', boxSizing: 'border-box',
  fontFamily: 'Arial, sans-serif',
}

const titleStyle: React.CSSProperties = {
  color: '#f44336', fontWeight: 'bold', fontSize: 16, margin: '0 0 8px',
}

const subTitleStyle: React.CSSProperties = {
  color: '#aaa', fontSize: 12, lineHeight: 1.5, margin: '0 0 14px',
}

const summaryBoxStyle: React.CSSProperties = {
  background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8,
  padding: '10px 12px', marginBottom: 14,
}

const summaryRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between',
  padding: '4px 0', borderBottom: '1px solid #2a2f3d',
}

const summaryLabel: React.CSSProperties = {
  color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em',
}

const summaryValue: React.CSSProperties = {
  color: '#fff', fontSize: 13,
}

const fieldLabelStyle: React.CSSProperties = {
  display: 'block', color: '#aaa', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px',
}

const selectStyle: React.CSSProperties = {
  display: 'block', width: '100%', padding: 10,
  background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8,
  color: 'white', fontSize: 13, boxSizing: 'border-box', outline: 'none',
  fontFamily: 'Arial', marginBottom: 10,
}

const textareaStyle: React.CSSProperties = {
  display: 'block', width: '100%', padding: 10,
  background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8,
  color: 'white', fontSize: 13, boxSizing: 'border-box', outline: 'none',
  fontFamily: 'Arial', marginBottom: 4, resize: 'vertical',
}

const cancelBtnStyle = (busy: boolean): React.CSSProperties => ({
  flex: 1, padding: 12, background: '#1e2535', color: '#aaa',
  fontSize: 13, fontWeight: 'bold', border: '1px solid #3a4055',
  borderRadius: 8, cursor: busy ? 'not-allowed' : 'pointer',
  opacity: busy ? 0.5 : 1, fontFamily: 'Arial',
})

const voidBtnStyle = (canVoid: boolean): React.CSSProperties => ({
  flex: 1, padding: 12, background: canVoid ? '#b71c1c' : '#555',
  color: canVoid ? 'white' : '#888', fontSize: 13, fontWeight: 'bold',
  border: 'none', borderRadius: 8, cursor: canVoid ? 'pointer' : 'not-allowed',
  fontFamily: 'Arial',
})

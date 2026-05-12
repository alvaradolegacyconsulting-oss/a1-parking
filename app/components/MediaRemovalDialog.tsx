'use client'
import React, { useState } from 'react'
import { supabase } from '../supabase'

// B13/B18 Commit C1 — reusable soft-delete dialog.
// Handles both photos and videos via mediaType prop. Writes removed_at
// + removed_by_email + removed_by_role + removal_reason to the
// underlying table, then writes an audit log row. RLS policies on
// violation_photos / violation_videos enforce the actual permission
// boundary; this component is the UI affordance.
//
// Role-to-audit-action mapping is encapsulated here so callers just
// pass userRole='admin' and get SUPER_ADMIN_REMOVE_VIOLATION_PHOTO
// in the audit log without knowing about the convention. Future
// support_admin role would map here too.

export type MediaType = 'photo' | 'video'
export type RemoverRole = 'driver' | 'manager' | 'company_admin' | 'admin'

type Props = {
  open: boolean
  mediaType: MediaType
  mediaUrl: string
  thumbnailUrl?: string | null
  violationId: number
  mediaId: number
  userRole: RemoverRole
  userEmail: string
  onCancel: () => void
  onRemoved: () => void
}

const REASON_OPTIONS = [
  'Wrong vehicle',
  'Wrong photo attached',
  'Offensive content',
  'Other',
] as const
type Reason = typeof REASON_OPTIONS[number]

function actionFor(userRole: RemoverRole, mediaType: MediaType): string {
  const rolePrefix = userRole === 'admin' ? 'SUPER_ADMIN' : userRole.toUpperCase()
  return `${rolePrefix}_REMOVE_VIOLATION_${mediaType.toUpperCase()}`
}

export default function MediaRemovalDialog({
  open, mediaType, mediaUrl, thumbnailUrl, violationId, mediaId,
  userRole, userEmail, onCancel, onRemoved,
}: Props) {
  const [reason, setReason] = useState<Reason | ''>('')
  const [otherText, setOtherText] = useState('')
  const [busy, setBusy] = useState(false)

  if (!open) return null

  const reasonLabelForVideo = mediaType === 'video'
    ? REASON_OPTIONS.map(r => r === 'Wrong photo attached' ? 'Wrong video attached' : r)
    : (REASON_OPTIONS as readonly string[])

  const trimmedOther = otherText.trim()
  const otherValid = reason !== 'Other' || trimmedOther.length >= 5
  const canRemove = reason !== '' && otherValid && !busy

  async function handleRemove() {
    if (!canRemove) return
    // Defense-in-depth: refuse to write a blank audit trail. The parent
    // should always have userEmail populated by the time this dialog
    // renders, but a race or auth glitch could land us here with an
    // empty string. Silent forensic-trail data loss is worse than a
    // user-visible refusal.
    if (!userEmail || userEmail.trim() === '') {
      alert('Cannot remove: user identity not loaded. Please refresh and try again.')
      return
    }
    setBusy(true)
    const finalReason = reason === 'Other' ? trimmedOther : (reason as string)
    const tableName = mediaType === 'photo' ? 'violation_photos' : 'violation_videos'

    const { error: updErr } = await supabase.from(tableName)
      .update({
        removed_at: new Date().toISOString(),
        removed_by_email: userEmail,
        removed_by_role: userRole,
        removal_reason: finalReason,
      })
      .eq('id', mediaId)

    if (updErr) {
      setBusy(false)
      alert(`Remove failed: ${updErr.message}`)
      return
    }

    const { error: auditErr } = await supabase.from('audit_logs').insert([{
      user_email: userEmail,
      action: actionFor(userRole, mediaType),
      table_name: tableName,
      record_id: String(mediaId),
      new_values: {
        violation_id: violationId,
        media_url: mediaUrl,
        removed_by_role: userRole,
        removal_reason: finalReason,
      },
      created_at: new Date().toISOString(),
    }])
    if (auditErr) console.error('[MediaRemovalDialog audit_logs insert] failed:', auditErr.message)

    setBusy(false)
    setReason('')
    setOtherText('')
    onRemoved()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, padding: '20px' }}>
      <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '12px', padding: '20px', maxWidth: '420px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <p style={{ color: '#C9A227', fontWeight: 'bold', fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>
          Remove this {mediaType}?
        </p>
        <p style={{ color: '#888', fontSize: '11px', margin: '0 0 14px', lineHeight: '1.5' }}>
          This is soft-deleted and audit-logged. A manager can recover this if needed.
        </p>

        {mediaType === 'photo' && (thumbnailUrl || mediaUrl) && (
          <div style={{ marginBottom: '14px', textAlign: 'center' }}>
            <img src={thumbnailUrl || mediaUrl} alt="media to remove"
              style={{ maxWidth: '100%', maxHeight: '180px', objectFit: 'contain', borderRadius: '8px', border: '1px solid #2a2f3d' }} />
          </div>
        )}
        {mediaType === 'video' && (
          <div style={{ marginBottom: '14px', background: '#1e2535', border: '1px solid #3a4055', borderRadius: '6px', padding: '10px 12px' }}>
            <p style={{ color: '#aaa', fontSize: '12px', margin: '0', wordBreak: 'break-all' }}>
              🎥 {mediaUrl}
            </p>
          </div>
        )}

        <label style={{ display: 'block', color: '#aaa', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px' }}>
          Reason
        </label>
        <select value={reason} onChange={e => setReason(e.target.value as Reason | '')}
          disabled={busy}
          style={{ display: 'block', width: '100%', padding: '10px', background: '#1e2535', border: '1px solid #3a4055', borderRadius: '8px', color: 'white', fontSize: '13px', boxSizing: 'border-box', outline: 'none', fontFamily: 'Arial', marginBottom: '10px' }}>
          <option value="">-- Select a reason --</option>
          {REASON_OPTIONS.map((opt, i) => (
            <option key={opt} value={opt}>{reasonLabelForVideo[i]}</option>
          ))}
        </select>

        {reason === 'Other' && (
          <>
            <label style={{ display: 'block', color: '#aaa', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px' }}>
              Please specify (min 5 characters)
            </label>
            <textarea value={otherText} onChange={e => setOtherText(e.target.value)}
              disabled={busy}
              placeholder="Briefly describe the reason"
              rows={3}
              style={{ display: 'block', width: '100%', padding: '10px', background: '#1e2535', border: '1px solid #3a4055', borderRadius: '8px', color: 'white', fontSize: '13px', boxSizing: 'border-box', outline: 'none', fontFamily: 'Arial', marginBottom: '4px', resize: 'vertical' }} />
            <p style={{ color: trimmedOther.length >= 5 ? '#4caf50' : '#888', fontSize: '11px', margin: '0 0 10px' }}>
              {trimmedOther.length}/5 characters
            </p>
          </>
        )}

        <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
          <button onClick={onCancel} disabled={busy}
            style={{ flex: 1, padding: '12px', background: '#1e2535', color: '#aaa', fontSize: '13px', fontWeight: 'bold', border: '1px solid #3a4055', borderRadius: '8px', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1, fontFamily: 'Arial' }}>
            Cancel
          </button>
          <button onClick={handleRemove} disabled={!canRemove}
            style={{ flex: 1, padding: '12px', background: canRemove ? '#b71c1c' : '#555', color: canRemove ? 'white' : '#888', fontSize: '13px', fontWeight: 'bold', border: 'none', borderRadius: '8px', cursor: canRemove ? 'pointer' : 'not-allowed', fontFamily: 'Arial' }}>
            {busy ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  )
}

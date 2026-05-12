'use client'
import React from 'react'

// B18 Commit B — review-before-confirm screen.
// Photo X (soft-delete) buttons are intentionally NOT in this commit;
// they wire up in Commit C alongside the post-confirmation edit UIs
// for manager / CA / admin (which share the same removal dialog and
// require UPDATE policies on violation_photos that ship with C).
// For Commit B, a driver who needs to remove a photo clicks Edit
// (which discards the unconfirmed row entirely; CASCADE deletes the
// photo rows; storage objects orphan until a Phase 2 cleanup cron).

export type ReviewViolation = {
  id: number
  plate: string | null
  violation_type: string | null
  property: string | null
  location: string | null
  notes: string | null
  photos: string[]
  video_url: string | null
  driver_name: string | null
  created_at: string | null
}

type Props = {
  violation: ReviewViolation
  videoFileName?: string | null
  videoDuration?: number | null
  busy?: boolean
  onEdit: () => void
  onConfirm: () => void
}

const card: React.CSSProperties = {
  background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '10px',
  padding: '14px', marginBottom: '12px',
}
const fieldLabel: React.CSSProperties = {
  color: '#555', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em',
  margin: '0 0 4px',
}
const fieldVal: React.CSSProperties = {
  color: 'white', fontSize: '13px', margin: '0', lineHeight: '1.5',
}

export default function ViolationReviewScreen({
  violation,
  videoFileName,
  videoDuration,
  busy = false,
  onEdit,
  onConfirm,
}: Props) {
  return (
    <div style={{ background: '#0f1117', padding: '16px 0' }}>
      <div style={{ marginBottom: '14px', textAlign: 'center' }}>
        <p style={{ color: '#C9A227', fontWeight: 'bold', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 4px' }}>
          Review Submission
        </p>
        <p style={{ color: '#888', fontSize: '11px', margin: '0', lineHeight: '1.5' }}>
          Check the details below. Click Confirm &amp; Submit to lock this violation, or Edit to make changes.
        </p>
      </div>

      <div style={card}>
        <p style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>License Plate</p>
        <p style={{ color: '#C9A227', fontFamily: 'Courier New', fontSize: '24px', fontWeight: 'bold', letterSpacing: '0.12em', margin: '0', textAlign: 'center' }}>
          {violation.plate || '—'}
        </p>
      </div>

      <div style={{ ...card, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <div>
          <p style={fieldLabel}>Type</p>
          <p style={fieldVal}>{violation.violation_type || '—'}</p>
        </div>
        <div>
          <p style={fieldLabel}>Property</p>
          <p style={fieldVal}>{violation.property || '—'}</p>
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <p style={fieldLabel}>Location</p>
          <p style={fieldVal}>{violation.location || '—'}</p>
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <p style={fieldLabel}>Notes</p>
          <p style={fieldVal}>{violation.notes || '—'}</p>
        </div>
      </div>

      {violation.photos.length > 0 && (
        <div style={card}>
          <p style={fieldLabel}>Photos ({violation.photos.length})</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
            {violation.photos.map((url, i) => (
              <img key={i} src={url} alt={`evidence ${i + 1}`}
                style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: '6px', border: '1px solid #2a2f3d', cursor: 'zoom-in' }}
                onClick={() => window.open(url, '_blank')}
                onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
            ))}
          </div>
        </div>
      )}

      {videoFileName && (
        <div style={card}>
          <p style={fieldLabel}>Video</p>
          <p style={fieldVal}>
            🎥 {videoFileName}{videoDuration != null ? ` (${videoDuration}s)` : ''}
            {violation.video_url ? '' : <span style={{ color: '#f59e0b' }}> — upload failed; violation will save without video</span>}
          </p>
        </div>
      )}

      <div style={{ ...card, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <div>
          <p style={fieldLabel}>Submitted By</p>
          <p style={fieldVal}>{violation.driver_name || '—'}</p>
        </div>
        <div>
          <p style={fieldLabel}>Timestamp</p>
          <p style={fieldVal}>{violation.created_at ? new Date(violation.created_at).toLocaleString() : '—'}</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
        <button
          onClick={onEdit}
          disabled={busy}
          style={{
            flex: 1, padding: '14px',
            background: '#1e2535', color: '#aaa',
            fontSize: '14px', fontWeight: 'bold',
            border: '1px solid #3a4055', borderRadius: '10px',
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.5 : 1,
            fontFamily: 'Arial',
          }}>
          ← Edit
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          style={{
            flex: 2, padding: '14px',
            background: busy ? '#555' : '#C9A227',
            color: busy ? '#888' : '#0f1117',
            fontSize: '15px', fontWeight: 'bold',
            border: 'none', borderRadius: '10px',
            cursor: busy ? 'not-allowed' : 'pointer',
            fontFamily: 'Arial',
          }}>
          {busy ? 'Confirming…' : 'Confirm & Submit'}
        </button>
      </div>
    </div>
  )
}

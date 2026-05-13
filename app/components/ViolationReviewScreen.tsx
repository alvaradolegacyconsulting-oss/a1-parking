'use client'
import React, { useState } from 'react'
import MediaRemovalDialog, { RemoverRole } from './MediaRemovalDialog'

// B18 Commit B — review-before-confirm screen.
// B13/B18 Commit C1 — extended with per-photo + video soft-delete
// X buttons (Option B: drivers can fix a wrong photo without nuking
// the whole submission). X buttons render only when userRole +
// userEmail + onMediaRemoved are all provided. If any is missing,
// the screen renders read-only as before.
//
// X click opens MediaRemovalDialog which writes removed_at / role /
// reason via UPDATE. RLS enforces who's allowed (driver:
// preconfirmation-only via v.is_confirmed=false bound; CA: any time
// within company). On successful soft-delete, onMediaRemoved fires;
// parent re-queries the violation with photo_rows + video_rows
// embedded and calls setReviewViolation with the fresh state.

export type ReviewViolation = {
  id: number
  plate: string | null
  violation_type: string | null
  property: string | null
  location: string | null
  notes: string | null
  photos: string[]
  // C1: parallel ID array. photos[i] pairs with photo_ids[i].
  // Optional so legacy callers that haven't migrated still render
  // (photos appear, X buttons stay hidden — read-only mode).
  photo_ids?: number[]
  video_url: string | null
  // C1: video_id pairs with video_url. Same back-compat semantics.
  video_id?: number | null
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
  // B38: explicit discard. Same DELETE as onEdit but parent is expected
  // to clear form state and close the form, not return to the form for
  // re-submission. Optional — when omitted, no third button renders.
  onDiscard?: () => void
  // C1: when all three are present, per-media X buttons render.
  userRole?: RemoverRole
  userEmail?: string
  onMediaRemoved?: () => void
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
  onDiscard,
  userRole,
  userEmail,
  onMediaRemoved,
}: Props) {
  const [removalTarget, setRemovalTarget] = useState<null | {
    mediaType: 'photo' | 'video'
    mediaId: number
    mediaUrl: string
    thumbnailUrl?: string
  }>(null)

  const canRemove = !!(userRole && userEmail && onMediaRemoved)

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
            {violation.photos.map((url, i) => {
              const photoId = violation.photo_ids?.[i]
              const showX = canRemove && photoId !== undefined
              return (
                <span key={i} style={{ position: 'relative', display: 'block' }}>
                  <img src={url} alt={`evidence ${i + 1}`}
                    style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: '6px', border: '1px solid #2a2f3d', cursor: 'zoom-in', display: 'block' }}
                    onClick={() => window.open(url, '_blank')}
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  {showX && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setRemovalTarget({ mediaType: 'photo', mediaId: photoId, mediaUrl: url, thumbnailUrl: url }) }}
                      aria-label={`Remove photo ${i + 1}`}
                      style={{ position: 'absolute', top: '4px', right: '4px', width: '22px', height: '22px', background: 'rgba(15,17,23,0.85)', border: '1px solid #3a4055', borderRadius: '50%', color: '#f44336', cursor: 'pointer', fontSize: '12px', padding: '0', lineHeight: '1', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      ✕
                    </button>
                  )}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {(videoFileName || violation.video_url) && (
        <div style={card}>
          <p style={fieldLabel}>Video</p>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <p style={{ ...fieldVal, flex: 1, wordBreak: 'break-word' }}>
              🎥 {videoFileName || violation.video_url}{videoDuration != null ? ` (${videoDuration}s)` : ''}
              {videoFileName && !violation.video_url
                ? <span style={{ color: '#f59e0b' }}> — upload failed; violation will save without video</span>
                : ''}
            </p>
            {canRemove && violation.video_id != null && violation.video_url && (
              <button
                onClick={() => setRemovalTarget({ mediaType: 'video', mediaId: violation.video_id!, mediaUrl: violation.video_url! })}
                aria-label="Remove video"
                style={{ background: 'none', border: 'none', color: '#f44336', cursor: 'pointer', fontSize: '14px', padding: '0 4px', lineHeight: '1' }}>
                ✕
              </button>
            )}
          </div>
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
        {onDiscard && (
          <button
            onClick={onDiscard}
            disabled={busy}
            style={{
              flex: 1, padding: '14px',
              background: '#1a0808', color: '#f44336',
              fontSize: '14px', fontWeight: 'bold',
              border: '1px solid #b71c1c', borderRadius: '10px',
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.5 : 1,
              fontFamily: 'Arial',
            }}>
            Discard
          </button>
        )}
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

      {removalTarget && canRemove && (
        <MediaRemovalDialog
          open={true}
          mediaType={removalTarget.mediaType}
          mediaUrl={removalTarget.mediaUrl}
          thumbnailUrl={removalTarget.thumbnailUrl}
          violationId={violation.id}
          mediaId={removalTarget.mediaId}
          userRole={userRole!}
          userEmail={userEmail!}
          onCancel={() => setRemovalTarget(null)}
          onRemoved={() => {
            setRemovalTarget(null)
            onMediaRemoved!()
          }}
        />
      )}
    </div>
  )
}

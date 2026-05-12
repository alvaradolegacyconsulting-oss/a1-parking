'use client'
import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import MediaRemovalDialog, { RemoverRole } from './MediaRemovalDialog'

// B13/B18 Commit C2 — post-confirmation edit modal.
// Reused by manager + CA portals. Opens with a known violationId,
// re-queries the violation on open + after each removal so the photo
// grid + video chip always reflect current active media.
//
// Photo/video removal only — NO field edits in scope. Metadata is
// strictly read-only display.
//
// X click on a photo / video opens MediaRemovalDialog (sibling
// overlay at higher zIndex). On its onRemoved callback, this modal
// re-queries the violation and re-renders without the removed media.
//
// Role-agnostic: callers pass userRole=manager | company_admin |
// admin. MediaRemovalDialog encapsulates the role→audit-action
// mapping. RLS enforces who's actually allowed to write.

type EditableRole = Extract<RemoverRole, 'manager' | 'company_admin' | 'admin'>

type ModalViolation = {
  id: number
  plate: string | null
  violation_type: string | null
  property: string | null
  location: string | null
  notes: string | null
  driver_name: string | null
  vehicle_color: string | null
  vehicle_make: string | null
  vehicle_model: string | null
  created_at: string | null
  photos: Array<{ id: number; url: string }>
  video: { id: number; url: string } | null
}

type Props = {
  open: boolean
  violationId: number | null
  userRole: EditableRole
  userEmail: string
  onClose: () => void
}

const card: React.CSSProperties = {
  background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: '8px',
  padding: '12px', marginBottom: '12px',
}
const fieldLabel: React.CSSProperties = {
  color: '#555', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em',
  margin: '0 0 2px',
}
const fieldVal: React.CSSProperties = {
  color: 'white', fontSize: '12px', margin: 0, lineHeight: '1.5',
}

export default function PostConfirmationEditModal({
  open, violationId, userRole, userEmail, onClose,
}: Props) {
  const [loading, setLoading] = useState(true)
  const [violation, setViolation] = useState<ModalViolation | null>(null)
  const [removalTarget, setRemovalTarget] = useState<null | {
    mediaType: 'photo' | 'video'
    mediaId: number
    mediaUrl: string
  }>(null)

  useEffect(() => {
    if (open && violationId != null) {
      void load(violationId)
    } else {
      setViolation(null)
      setRemovalTarget(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, violationId])

  async function load(id: number) {
    setLoading(true)
    const { data, error } = await supabase.from('violations')
      .select('id, plate, violation_type, property, location, notes, driver_name, vehicle_color, vehicle_make, vehicle_model, created_at, photo_rows:violation_photos(id, photo_url, removed_at), video_rows:violation_videos(id, video_url, removed_at)')
      .eq('id', id)
      .single()
    setLoading(false)
    if (error || !data) {
      console.error('[PostConfirmationEditModal load] failed:', error?.message)
      setViolation(null)
      return
    }
    const activePhotos = ((data.photo_rows as { id: number; photo_url: string; removed_at: string | null }[] | null) || [])
      .filter(p => !p.removed_at)
    const activeVideos = ((data.video_rows as { id: number; video_url: string; removed_at: string | null }[] | null) || [])
      .filter(v => !v.removed_at)
    setViolation({
      id: data.id,
      plate: data.plate,
      violation_type: data.violation_type,
      property: data.property,
      location: data.location,
      notes: data.notes,
      driver_name: data.driver_name,
      vehicle_color: data.vehicle_color,
      vehicle_make: data.vehicle_make,
      vehicle_model: data.vehicle_model,
      created_at: data.created_at,
      photos: activePhotos.map(p => ({ id: p.id, url: p.photo_url })),
      video: activeVideos[0]
        ? { id: activeVideos[0].id, url: activeVideos[0].video_url }
        : null,
    })
  }

  if (!open) return null

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '16px' }}>
      <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '12px', padding: '20px', maxWidth: '520px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <p style={{ color: '#C9A227', fontWeight: 'bold', fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>
            Manage Media
          </p>
          <button onClick={onClose} aria-label="Close"
            style={{ background: 'none', border: 'none', color: '#aaa', fontSize: '18px', cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}>
            ✕
          </button>
        </div>

        {loading && (
          <p style={{ color: '#888', textAlign: 'center', padding: '40px 0', fontSize: '13px', margin: 0 }}>Loading…</p>
        )}

        {!loading && !violation && (
          <p style={{ color: '#f44336', textAlign: 'center', padding: '20px 0', fontSize: '13px', margin: 0 }}>
            Could not load violation. Close and try again.
          </p>
        )}

        {!loading && violation && (
          <>
            <div style={card}>
              <p style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>License Plate</p>
              <p style={{ color: '#C9A227', fontFamily: 'Courier New', fontSize: '20px', fontWeight: 'bold', letterSpacing: '0.12em', margin: '0 0 12px' }}>
                {violation.plate || '—'}
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
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
                {violation.notes && (
                  <div style={{ gridColumn: 'span 2' }}>
                    <p style={fieldLabel}>Notes</p>
                    <p style={fieldVal}>{violation.notes}</p>
                  </div>
                )}
                {(violation.vehicle_color || violation.vehicle_make || violation.vehicle_model) && (
                  <div style={{ gridColumn: 'span 2' }}>
                    <p style={fieldLabel}>Vehicle</p>
                    <p style={fieldVal}>🚗 {[violation.vehicle_color, violation.vehicle_make, violation.vehicle_model].filter(Boolean).join(' ')}</p>
                  </div>
                )}
                <div>
                  <p style={fieldLabel}>Submitted By</p>
                  <p style={fieldVal}>{violation.driver_name || '—'}</p>
                </div>
                <div>
                  <p style={fieldLabel}>Timestamp</p>
                  <p style={fieldVal}>{violation.created_at ? new Date(violation.created_at).toLocaleString() : '—'}</p>
                </div>
              </div>
            </div>

            <p style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px' }}>
              Photos {violation.photos.length > 0 ? `(${violation.photos.length})` : ''}
            </p>
            {violation.photos.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', marginBottom: '12px' }}>
                {violation.photos.map((p) => (
                  <span key={p.id} style={{ position: 'relative', display: 'block' }}>
                    <img src={p.url} alt={`evidence ${p.id}`}
                      style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: '6px', border: '1px solid #2a2f3d', cursor: 'zoom-in', display: 'block' }}
                      onClick={() => window.open(p.url, '_blank')}
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    <button
                      onClick={(e) => { e.stopPropagation(); setRemovalTarget({ mediaType: 'photo', mediaId: p.id, mediaUrl: p.url }) }}
                      aria-label="Remove photo"
                      style={{ position: 'absolute', top: '4px', right: '4px', width: '22px', height: '22px', background: 'rgba(15,17,23,0.85)', border: '1px solid #3a4055', borderRadius: '50%', color: '#f44336', cursor: 'pointer', fontSize: '12px', padding: 0, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p style={{ color: '#555', fontSize: '11px', textAlign: 'center', padding: '14px', fontStyle: 'italic', background: '#0f1117', border: '1px dashed #2a2f3d', borderRadius: '8px', margin: '0 0 12px' }}>
                No active photos.
              </p>
            )}

            <p style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px' }}>Video</p>
            {violation.video ? (
              <div style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <p style={{ color: 'white', fontSize: '12px', margin: 0, flex: 1, wordBreak: 'break-word' }}>
                  🎥 <a href={violation.video.url} target="_blank" rel="noopener noreferrer" style={{ color: '#C9A227', textDecoration: 'underline' }}>Play video</a>
                </p>
                <button
                  onClick={() => setRemovalTarget({ mediaType: 'video', mediaId: violation.video!.id, mediaUrl: violation.video!.url })}
                  aria-label="Remove video"
                  style={{ background: 'none', border: 'none', color: '#f44336', cursor: 'pointer', fontSize: '14px', padding: '0 4px', lineHeight: 1 }}>
                  ✕
                </button>
              </div>
            ) : (
              <p style={{ color: '#555', fontSize: '11px', textAlign: 'center', padding: '14px', fontStyle: 'italic', background: '#0f1117', border: '1px dashed #2a2f3d', borderRadius: '8px', margin: '0 0 12px' }}>
                No active video.
              </p>
            )}

            <button onClick={onClose}
              style={{ width: '100%', padding: '12px', background: '#1e2535', color: '#aaa', fontSize: '13px', fontWeight: 'bold', border: '1px solid #3a4055', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
              Close
            </button>
          </>
        )}

        {removalTarget && violation && (
          <MediaRemovalDialog
            open={true}
            mediaType={removalTarget.mediaType}
            mediaUrl={removalTarget.mediaUrl}
            thumbnailUrl={removalTarget.mediaType === 'photo' ? removalTarget.mediaUrl : null}
            violationId={violation.id}
            mediaId={removalTarget.mediaId}
            userRole={userRole}
            userEmail={userEmail}
            onCancel={() => setRemovalTarget(null)}
            onRemoved={() => {
              const target = removalTarget
              setRemovalTarget(null)
              // Refetch the parent modal's violation so the grid drops the removed media.
              void load(violation.id)
              // Reference target to satisfy lint without altering behavior.
              void target
            }}
          />
        )}
      </div>
    </div>
  )
}

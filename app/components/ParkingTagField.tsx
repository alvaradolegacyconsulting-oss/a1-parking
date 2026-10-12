'use client'

// ════════════════════════════════════════════════════════════════════
// ParkingTagField — assign / change / void a physical parking tag
// ════════════════════════════════════════════════════════════════════
//
// One component, three mounts: manager and CA can set and void; a
// resident sees their own tag number read-only (ruled). Written once
// because the refusals are the interesting part and would drift if
// written three times.
//
// 🔴 EVERY WRITE GOES THROUGH set_vehicle_tag / void_vehicle_tag.
// vehicle_parking_tags has no write policy and authenticated holds no
// write grant, so a direct insert simply fails — but the reason to
// route through the RPCs is that they own the rules: the property
// switch, the one-live-tag-per-property invariant, voiding the previous
// row on reissue, and the audit.
//
// 🔴 NO RAW ERRORS. Every refusal code maps to a sentence a property
// manager can act on. The RPCs return jsonb and raise for nothing, so
// there is never a Postgres string to leak — see the raw-DB-errors
// sweep this is the shape for.
//
// Never the word "permit": that is the billing meter. "Parking tag".

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase'

interface TagRow {
  id: number
  tag_number: string
  assigned_at: string
  assigned_by: string
  voided_at: string | null
  voided_by: string | null
  voided_reason: string | null
  voided_note: string | null
}

const VOID_REASONS: { code: string; label: string }[] = [
  { code: 'collected_at_moveout', label: 'Collected at move-out' },
  { code: 'lost_or_stolen',       label: 'Lost or stolen' },
  { code: 'damaged_replaced',     label: 'Damaged — replaced' },
  { code: 'issued_in_error',      label: 'Issued in error' },
  { code: 'other',                label: 'Other — note required' },
]

const fmt = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function ParkingTagField({
  vehicleId, plate, propertyName, tagsEnabled, canManage,
}: {
  vehicleId: number
  plate: string
  propertyName: string
  tagsEnabled: boolean
  /** manager / leasing agent / CA true; resident false (read-only) */
  canManage: boolean
}) {
  // 🔴 Results are STAMPED with the vehicle they belong to and rendered
  // only when fresh. The prohibition panel shipped without this and
  // showed one property's list on every property.
  const [rows, setRows] = useState<{ forVehicle: number; data: TagRow[]; failed: boolean } | null>(null)
  const [entry, setEntry] = useState('')
  const [busy, setBusy] = useState(false)
  const [showVoid, setShowVoid] = useState(false)
  const [voidReason, setVoidReason] = useState('collected_at_moveout')
  const [voidNote, setVoidNote] = useState('')
  const [msg, setMsg] = useState<{ forVehicle: number; kind: 'ok' | 'error'; text: string } | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  const say = (kind: 'ok' | 'error', text: string) => setMsg({ forVehicle: vehicleId, kind, text })

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('vehicle_parking_tags')
      .select('id, tag_number, assigned_at, assigned_by, voided_at, voided_by, voided_reason, voided_note')
      .eq('vehicle_id', vehicleId)
      .order('assigned_at', { ascending: false })
    // 🔴 A failed read is NOT "no tag". RLS denial returns
    // {data:[],error:null} — a filter, not an error — so only a real
    // error marks this failed, and the render distinguishes the two.
    setRows({ forVehicle: vehicleId, data: (data ?? []) as TagRow[], failed: !!error })
  }, [vehicleId])

  useEffect(() => { void load() }, [load])

  const fresh = rows && rows.forVehicle === vehicleId ? rows : null
  const freshMsg = msg && msg.forVehicle === vehicleId ? msg : null
  const live = fresh?.data.find(r => !r.voided_at) ?? null
  const history = fresh?.data.filter(r => r.voided_at) ?? []

  // Plain sentences, keyed on the RPC's codes.
  function explain(r: Record<string, unknown>): string {
    switch (r.error) {
      case 'parking_tags_not_enabled':
        return `Parking tags are not switched on for ${propertyName}. A company admin can turn them on under Physical passes in the property's settings.`
      case 'tag_already_assigned':
        return `Tag ${r.tag_number} is already assigned to ${r.held_by_plate}${r.held_by_unit ? `, unit ${r.held_by_unit}` : ''} at this property. Void that one first, or use a different number.`
      case 'vehicle_not_active':
        return 'This vehicle is not active, so it cannot hold a parking tag. Approve or reactivate it first.'
      case 'not_permitted':
        return 'You do not have permission to change parking tags at this property.'
      case 'reason_required':
        return 'Choose a reason for voiding the tag.'
      case 'vehicle_not_found':
        return 'That vehicle could not be found. Refresh and try again.'
      case 'property_not_resolved':
        return 'This vehicle is not linked to a property we can match. Tell us — this one needs looking at.'
      case 'not_signed_in':
        return 'Your session has expired. Sign in again.'
      default:
        return 'That change could not be saved. Try again, and tell us if it keeps happening.'
    }
  }

  async function assign() {
    if (busy) return
    setBusy(true); setMsg(null)
    const { data, error } = await supabase.rpc('set_vehicle_tag', {
      p_vehicle_id: vehicleId, p_tag: entry.trim(),
    })
    setBusy(false)
    if (error) { say('error', 'That change could not be saved. Try again, and tell us if it keeps happening.'); return }
    const r = (data ?? {}) as Record<string, unknown>
    if (r.ok !== true) { say('error', explain(r)); return }
    setEntry('')
    await load()
    say('ok',
      r.action === 'cleared'      ? `Tag ${r.previous_tag_number} cleared from ${plate}.`
      : r.action === 'already_no_tag' ? `${plate} has no parking tag.`
      : r.action === 'unchanged'  ? `${plate} already holds tag ${r.tag_number}.`
      : r.action === 'reissued'   ? `Tag ${r.tag_number} issued to ${plate}. Tag ${r.previous_tag_number} was voided.`
      : `Tag ${r.tag_number} issued to ${plate}.`)
  }

  async function doVoid() {
    if (busy) return
    if (voidReason === 'other' && !voidNote.trim()) { say('error', 'Add a note explaining the reason.'); return }
    setBusy(true); setMsg(null)
    const { data, error } = await supabase.rpc('void_vehicle_tag', {
      p_vehicle_id: vehicleId,
      p_reason:     voidReason,
      p_note:       voidNote.trim() || null,
    })
    setBusy(false)
    if (error) { say('error', 'That change could not be saved. Try again, and tell us if it keeps happening.'); return }
    const r = (data ?? {}) as Record<string, unknown>
    if (r.ok !== true) { say('error', explain(r)); return }
    setShowVoid(false); setVoidNote('')
    await load()
    say('ok', r.action === 'already_no_tag'
      ? `${plate} has no parking tag to void.`
      : `Tag ${r.tag_number} voided. The number can be issued again.`)
  }

  // ── read-only (resident) ────────────────────────────────────────────
  if (!canManage) {
    if (!tagsEnabled) return null          // nothing to say about a lot that does not use tags
    if (fresh?.failed) {
      return (
        <p style={{ color: '#fbbf24', fontSize: '12px', margin: '6px 0 0' }}>
          Could not load your parking tag just now.
        </p>
      )
    }
    return (
      <div style={{ marginTop: '8px' }}>
        <span style={{ color: '#888', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Parking tag</span>
        <p style={{ color: live ? '#C9A227' : '#888', fontFamily: 'Courier New', fontSize: '15px', fontWeight: 'bold', margin: '2px 0 0' }}>
          {live ? live.tag_number : 'None issued'}
        </p>
      </div>
    )
  }

  // ── manager / CA ────────────────────────────────────────────────────
  return (
    <div style={{ background: '#11151f', border: '1px solid #2a2f3d', borderRadius: '8px', padding: '12px', marginTop: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
        <span style={{ color: '#888', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Parking tag #</span>
        {live && (
          <span style={{ color: '#C9A227', fontFamily: 'Courier New', fontSize: '14px', fontWeight: 'bold' }}>{live.tag_number}</span>
        )}
      </div>

      {!tagsEnabled ? (
        // Say WHY the field is inert, and who can change it. A disabled
        // control with no explanation is the thing residents and
        // managers both report as "it's broken".
        <p style={{ color: '#888', fontSize: '12px', margin: '8px 0 0', lineHeight: '1.5' }}>
          Parking tags are not switched on for {propertyName}. A company admin can turn them on under Physical passes.
        </p>
      ) : fresh?.failed ? (
        <p style={{ color: '#fbbf24', fontSize: '12px', margin: '8px 0 0', lineHeight: '1.5' }}>
          Could not load the tag for this vehicle. Refresh before changing anything.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
            <input
              value={entry}
              onChange={e => setEntry(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === 'Enter' && !busy && entry.trim()) void assign() }}
              placeholder={live ? 'new number' : 'e.g. A1024'}
              maxLength={20}
              style={{ flex: 1, padding: '8px 10px', background: '#1e2535', border: '1px solid #3a4055', borderRadius: '6px', color: 'white', fontFamily: 'Courier New', fontSize: '13px', textTransform: 'uppercase', outline: 'none' }}
            />
            <button
              onClick={() => void assign()}
              disabled={busy || !entry.trim()}
              style={{ padding: '8px 12px', background: (busy || !entry.trim()) ? '#2a2f3d' : '#C9A227', color: (busy || !entry.trim()) ? '#555' : '#0f1117', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold', cursor: (busy || !entry.trim()) ? 'not-allowed' : 'pointer' }}>
              {busy ? '…' : live ? 'Replace' : 'Assign'}
            </button>
            {live && (
              <button
                onClick={() => setShowVoid(v => !v)}
                disabled={busy}
                style={{ padding: '8px 12px', background: 'transparent', color: '#f87171', border: '1px solid #7a2222', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold', cursor: busy ? 'not-allowed' : 'pointer' }}>
                Void
              </button>
            )}
          </div>

          {showVoid && (
            <div style={{ marginTop: '10px', padding: '10px', background: '#1a1012', border: '1px solid #7a2222', borderRadius: '6px' }}>
              <p style={{ color: '#f87171', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px', fontWeight: 'bold' }}>
                Void tag {live?.tag_number}
              </p>
              <p style={{ color: '#aaa', fontSize: '11.5px', margin: '0 0 8px', lineHeight: '1.5' }}>
                The record is kept, so a lookup can still tell this tag from one that was never issued. The number becomes available again.
              </p>
              <select
                value={voidReason}
                onChange={e => setVoidReason(e.target.value)}
                style={{ width: '100%', padding: '8px', background: '#1e2535', border: '1px solid #3a4055', borderRadius: '6px', color: 'white', fontSize: '12px', marginBottom: '6px' }}>
                {VOID_REASONS.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
              </select>
              <input
                value={voidNote}
                onChange={e => setVoidNote(e.target.value)}
                placeholder={voidReason === 'other' ? 'Note (required)' : 'Note (optional)'}
                style={{ width: '100%', padding: '8px', background: '#1e2535', border: '1px solid #3a4055', borderRadius: '6px', color: 'white', fontSize: '12px', boxSizing: 'border-box' }}
              />
              <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                <button onClick={() => void doVoid()} disabled={busy}
                  style={{ padding: '8px 12px', background: '#7a2222', color: 'white', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold', cursor: busy ? 'not-allowed' : 'pointer' }}>
                  {busy ? '…' : 'Void tag'}
                </button>
                <button onClick={() => { setShowVoid(false); setVoidNote('') }} disabled={busy}
                  style={{ padding: '8px 12px', background: 'transparent', color: '#888', border: '1px solid #3a4055', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!live && (
            <p style={{ color: '#666', fontSize: '11.5px', margin: '6px 0 0' }}>
              No tag issued. Leave the box empty and press Replace to clear a tag instead.
            </p>
          )}

          {history.length > 0 && (
            <div style={{ marginTop: '10px', borderTop: '1px solid #222836', paddingTop: '8px' }}>
              <button onClick={() => setShowHistory(h => !h)}
                style={{ background: 'transparent', border: 'none', color: '#888', fontSize: '11px', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
                {showHistory ? 'Hide' : 'Show'} tag history ({history.length})
              </button>
              {showHistory && history.map(h => (
                <div key={h.id} style={{ marginTop: '6px', fontSize: '11.5px', color: '#888', lineHeight: '1.5' }}>
                  <span style={{ fontFamily: 'Courier New', color: '#aaa' }}>{h.tag_number}</span>
                  {' · issued '}{fmt(h.assigned_at)}
                  {' · voided '}{fmt(h.voided_at)}
                  {h.voided_reason && <> · {VOID_REASONS.find(r => r.code === h.voided_reason)?.label ?? h.voided_reason}</>}
                  {h.voided_note && <> — “{h.voided_note}”</>}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {freshMsg && (
        <p style={{ color: freshMsg.kind === 'ok' ? '#4caf50' : '#f44336', fontSize: '12px', margin: '10px 0 0', lineHeight: '1.5' }}>
          {freshMsg.text}
        </p>
      )}
    </div>
  )
}

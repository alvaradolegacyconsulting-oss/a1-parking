'use client'
//
// Spaces v1.1 commit 6 — SpaceDetailModal
//
// Space-anchored detail view for manager + CA portals. Opens from a "View"
// affordance on the spaces list row; shows the 1-2 tied residents (or 0)
// with their approved vehicles grouped underneath, plus the 3 mutation
// actions (add resident / per-resident remove / free entire space).
//
// REUSE: this is mostly read-and-arrange. The data comes from existing
// helpers (fetchSpaceResidents, fetchSpaceVehicles) and the mutations
// from existing RPCs (assign_space, free_space — extended in commit 1).
// SearchableResidentPicker is the existing commit-2 component.
//
// LOCKED DECISIONS (Jose 2026-06-22):
//   1. NO primary/roommate hierarchy — both residents render as equals.
//   2. Modal, not inline — keeps the spaces list scannable.
//   3. Manager + CA both — same component, mounted from both portals.
//
// 🔒 INVARIANT (restated in copy above the actions):
//   Removing a tie doesn't deactivate the resident or any vehicle.
//   Vehicle authorization comes from the resident's record, not from
//   this space tie. Space ties are reference data; authorization derives
//   from the vehicle.
//
// ONMUTATE GUARD: every successful mutation (add / per-remove / free-all)
// calls props.onMutate so the parent refetches its list — the parent's
// `s.residents` array is the source of truth for cap-aware buttons and
// would otherwise go stale until the next manual refetch.

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import {
  type Space,
  type ResidentOption,
  type VehicleSummary,
  fetchSpaceResidents,
  fetchSpaceVehicles,
  TYPE_LABELS,
} from '../lib/spaces'
import SearchableResidentPicker, { type SearchableResidentPickerResult } from './SearchableResidentPicker'

interface Props {
  space:    Space
  property: string
  onClose:  () => void
  // Caller refetches its spaces list / dashboard after any successful mutation
  // so the parent's `s.residents` cap-aware render state stays in sync.
  // Called after add / per-resident remove / free entire space.
  onMutate: () => void | Promise<void>
}

export default function SpaceDetailModal({ space, property, onClose, onMutate }: Props) {
  const [residents,      setResidents]      = useState<ResidentOption[]>(space.residents ?? [])
  const [vehiclesByEmail, setVehiclesByEmail] = useState<Map<string, VehicleSummary[]>>(new Map())
  const [loading,        setLoading]        = useState(true)
  const [error,          setError]          = useState('')
  // UI sub-state
  const [showAdd,        setShowAdd]        = useState(false)
  const [pendingAddEmail, setPendingAddEmail] = useState('')
  const [pendingRemoveEmail, setPendingRemoveEmail] = useState<string | null>(null)
  const [confirmFreeAll, setConfirmFreeAll] = useState(false)
  const [busy,           setBusy]           = useState(false)

  // Fetch fresh residents + vehicles whenever the modal opens or the
  // residents set changes (post-mutation reload). Doing it inside the
  // modal keeps the parent's loose coupling — caller only has to pass
  // the Space object and onMutate handler.
  async function reload() {
    setLoading(true)
    setError('')
    try {
      const freshResidents = await fetchSpaceResidents(supabase, space.id, property)
      setResidents(freshResidents)
      const veh = await fetchSpaceVehicles(supabase, property, freshResidents.map(r => r.email))
      setVehiclesByEmail(veh)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load space detail')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space.id, property])

  // --- Mutation handlers ---

  async function handleAdd() {
    if (!pendingAddEmail) return
    setBusy(true); setError('')
    try {
      const { error: rpcErr } = await supabase.rpc('assign_space', {
        p_space_id:       space.id,
        p_resident_email: pendingAddEmail,
      })
      if (rpcErr) { setError(rpcErr.message); return }
      setPendingAddEmail('')
      setShowAdd(false)
      await reload()
      await onMutate()
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(email: string) {
    setBusy(true); setError('')
    try {
      const { error: rpcErr } = await supabase.rpc('free_space', {
        p_space_id:       space.id,
        p_reason:         'manual_free',
        p_resident_email: email,
      })
      if (rpcErr) { setError(rpcErr.message); return }
      setPendingRemoveEmail(null)
      await reload()
      await onMutate()
    } finally {
      setBusy(false)
    }
  }

  async function handleFreeAll() {
    setBusy(true); setError('')
    try {
      const { error: rpcErr } = await supabase.rpc('free_space', {
        p_space_id:       space.id,
        p_reason:         'manual_free',
        p_resident_email: null,
      })
      if (rpcErr) { setError(rpcErr.message); return }
      setConfirmFreeAll(false)
      await reload()
      await onMutate()
    } finally {
      setBusy(false)
    }
  }

  // --- Render ---

  const occupancy = residents.length
  const cap       = 2
  const status    = !space.is_active ? 'decommissioned' : (occupancy === 0 ? 'available' : 'assigned')
  const statusColor = status === 'available' ? '#4caf50' : status === 'assigned' ? '#3b82f6' : '#888'
  const statusBg    = status === 'available' ? '#0a3a1e' : status === 'assigned' ? '#0a1e3a' : '#1a1a1a'

  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999,
      display:'flex', alignItems:'center', justifyContent:'center', padding:'20px',
      overflowY:'auto',
    }}>
      <div style={{
        background:'#161b26', border:'1px solid #3b82f6', borderRadius:'14px',
        padding:'22px', maxWidth:'560px', width:'100%', maxHeight:'90vh',
        overflowY:'auto',
      }}>
        {/* Header */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'14px' }}>
          <div>
            <p style={{ color:'#3b82f6', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 4px', fontWeight:'bold' }}>Space detail</p>
            <p style={{ color:'white', fontSize:'18px', margin:'0 0 4px', fontWeight:'bold' }}>
              <span style={{ fontFamily:'Courier New', color:'#C9A227' }}>{space.label}</span>
              <span style={{ color:'#666', fontSize:'13px', fontWeight:'normal', marginLeft:'8px' }}>· {TYPE_LABELS[space.type] ?? space.type}</span>
            </p>
            {space.description && (
              <p style={{ color:'#888', fontSize:'12px', fontStyle:'italic', margin:'2px 0 0' }}>{space.description}</p>
            )}
          </div>
          <button onClick={onClose} disabled={busy}
            style={{ background:'transparent', color:'#888', border:'none', fontSize:'22px', cursor: busy ? 'not-allowed' : 'pointer', padding:'0 4px', lineHeight:1 }}
            aria-label="Close">×</button>
        </div>

        {/* Status + occupancy line */}
        <div style={{ display:'flex', gap:'8px', alignItems:'center', marginBottom:'16px' }}>
          <span style={{ fontSize:'10px', fontWeight:'bold', padding:'3px 8px', borderRadius:'10px', background: statusBg, color: statusColor, textTransform:'capitalize' }}>{status}</span>
          <span style={{ color:'#aaa', fontSize:'12px' }}>{occupancy} of {cap} residents tied</span>
          {space.is_bundled && (
            <span style={{ fontSize:'10px', padding:'3px 8px', borderRadius:'10px', background:'#1e2535', color:'#666' }}>Bundled with rent</span>
          )}
        </div>

        {/* 🔒 INVARIANT copy (above the actions per Jose lock 2026-06-22) */}
        <div style={{ padding:'10px 12px', background:'#0a1628', border:'1px solid #1e3a5f', borderRadius:'8px', marginBottom:'14px' }}>
          <p style={{ color:'#7ab1ff', fontSize:'11px', margin:0, lineHeight:'1.55' }}>
            <strong>Heads-up:</strong> Removing a tie here doesn&apos;t deactivate the resident or any vehicle.
            Vehicle authorization comes from the resident&apos;s record, not from this space tie.
          </p>
        </div>

        {/* Loading / error */}
        {loading && (
          <p style={{ color:'#888', fontSize:'12px', padding:'20px 0', textAlign:'center' }}>Loading…</p>
        )}
        {error && (
          <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}>
            <p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{error}</p>
          </div>
        )}

        {/* Tied residents + their vehicles */}
        {!loading && (
          <>
            {residents.length === 0 ? (
              <div style={{ padding:'18px 12px', background:'#0f1117', border:'1px dashed #2a2f3d', borderRadius:'8px', textAlign:'center', marginBottom:'14px' }}>
                <p style={{ color:'#888', fontSize:'13px', margin:0 }}>No residents tied to this space.</p>
                <p style={{ color:'#666', fontSize:'11px', margin:'4px 0 0' }}>Use <strong>Add resident</strong> below to tie one.</p>
              </div>
            ) : (
              <div style={{ marginBottom:'14px' }}>
                <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.05em', margin:'0 0 8px' }}>Tied residents ({residents.length})</p>
                {residents.map(r => {
                  const plates = vehiclesByEmail.get(r.email) ?? []
                  return (
                    <div key={r.email} style={{ padding:'12px', background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', marginBottom:'8px' }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:'10px' }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:0 }}>
                            {r.name || r.email}
                            {!r.is_active && (
                              <span style={{ marginLeft:'6px', fontSize:'10px', padding:'1px 6px', borderRadius:'8px', background:'#3a1a1a', color:'#f44336', fontWeight:'normal' }}>inactive</span>
                            )}
                          </p>
                          <p style={{ color:'#888', fontSize:'11px', margin:'2px 0 0' }}>
                            Unit {r.unit || '—'} · <span style={{ color:'#666' }}>{r.email}</span>
                          </p>
                        </div>
                        {pendingRemoveEmail === r.email ? (
                          <div style={{ display:'flex', gap:'4px' }}>
                            <button onClick={() => setPendingRemoveEmail(null)} disabled={busy}
                              style={{ padding:'4px 8px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'5px', cursor: busy ? 'not-allowed' : 'pointer', fontSize:'11px', fontWeight:'bold' }}>Cancel</button>
                            <button onClick={() => handleRemove(r.email)} disabled={busy}
                              style={{ padding:'4px 8px', background:'#f59e0b', color:'#0f1117', border:'none', borderRadius:'5px', cursor: busy ? 'not-allowed' : 'pointer', fontSize:'11px', fontWeight:'bold' }}>
                              {busy ? '…' : 'Confirm remove'}
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => setPendingRemoveEmail(r.email)} disabled={busy || !space.is_active}
                            style={{ padding:'4px 10px', background:'#1e2535', color:'#f59e0b', border:'1px solid #f59e0b', borderRadius:'5px', cursor: (busy || !space.is_active) ? 'not-allowed' : 'pointer', fontSize:'11px', fontWeight:'bold', whiteSpace:'nowrap' }}>Remove</button>
                        )}
                      </div>
                      {/* Per-resident vehicles */}
                      <div style={{ marginTop:'8px', paddingTop:'8px', borderTop:'1px solid #2a2f3d' }}>
                        {plates.length === 0 ? (
                          <p style={{ color:'#666', fontSize:'11px', margin:0, fontStyle:'italic' }}>No active vehicles registered</p>
                        ) : (
                          <>
                            <p style={{ color:'#666', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.05em', margin:'0 0 4px' }}>Approved vehicles ({plates.length})</p>
                            {plates.map(v => (
                              <p key={v.plate} style={{ color:'#aaa', fontSize:'12px', margin:'2px 0' }}>
                                <span style={{ fontFamily:'Courier New', color:'white', fontWeight:'bold' }}>{v.plate}</span>
                                {[v.year, v.color, v.make, v.model].filter(Boolean).length > 0 && (
                                  <span style={{ color:'#666', marginLeft:'8px' }}>
                                    {[v.year, v.color, v.make, v.model].filter(Boolean).join(' ')}
                                  </span>
                                )}
                              </p>
                            ))}
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Add resident affordance — cap-aware */}
            {space.is_active && (
              <div style={{ marginBottom:'14px' }}>
                {showAdd ? (
                  <div style={{ padding:'12px', background:'#0a1628', border:'1px solid #1e3a5f', borderRadius:'8px' }}>
                    <p style={{ color:'#7ab1ff', fontSize:'11px', margin:'0 0 8px', textTransform:'uppercase', letterSpacing:'0.05em' }}>Add resident</p>
                    <SearchableResidentPicker
                      property={property}
                      excludeEmails={residents.map(r => r.email)}
                      onSelect={(r: SearchableResidentPickerResult) => setPendingAddEmail(r.email)}
                      placeholder="Search name, unit, or plate…"
                      autoFocus
                    />
                    {pendingAddEmail && (
                      <p style={{ color:'#4caf50', fontSize:'11px', margin:'8px 0 0' }}>
                        Selected: <strong>{pendingAddEmail}</strong>
                      </p>
                    )}
                    <div style={{ display:'flex', gap:'8px', marginTop:'10px' }}>
                      <button onClick={() => { setShowAdd(false); setPendingAddEmail('') }} disabled={busy}
                        style={{ flex:1, padding:'8px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor: busy ? 'not-allowed' : 'pointer', fontSize:'12px', fontWeight:'bold' }}>Cancel</button>
                      <button onClick={handleAdd} disabled={busy || !pendingAddEmail}
                        style={{ flex:1, padding:'8px', background: (pendingAddEmail && !busy) ? '#3b82f6' : '#555', color:'white', border:'none', borderRadius:'6px', cursor: (pendingAddEmail && !busy) ? 'pointer' : 'not-allowed', fontSize:'12px', fontWeight:'bold' }}>
                        {busy ? '…' : 'Add'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowAdd(true)}
                    disabled={residents.length >= cap || busy}
                    title={residents.length >= cap ? `At ${cap}-resident cap — remove one to add another` : undefined}
                    style={{
                      width:'100%', padding:'10px',
                      background: residents.length >= cap ? '#1a1a1a' : '#0a1e3a',
                      color: residents.length >= cap ? '#555' : '#3b82f6',
                      border: `1px solid ${residents.length >= cap ? '#2a2f3d' : '#3b82f6'}`,
                      borderRadius:'6px',
                      cursor: (residents.length >= cap || busy) ? 'not-allowed' : 'pointer',
                      fontSize:'12px', fontWeight:'bold',
                    }}>
                    {residents.length >= cap ? `At ${cap}-resident cap` : '+ Add resident'}
                  </button>
                )}
              </div>
            )}

            {/* Free entire space affordance — only when occupied + active */}
            {space.is_active && residents.length > 0 && (
              <div>
                {confirmFreeAll ? (
                  <div style={{ padding:'10px 12px', background:'#1a1400', border:'1px solid #a16207', borderRadius:'8px' }}>
                    <p style={{ color:'#fbbf24', fontSize:'12px', margin:'0 0 8px' }}>
                      Remove all {residents.length} residents from this space? Space returns to available; resident records + vehicles untouched.
                    </p>
                    <div style={{ display:'flex', gap:'8px' }}>
                      <button onClick={() => setConfirmFreeAll(false)} disabled={busy}
                        style={{ flex:1, padding:'8px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor: busy ? 'not-allowed' : 'pointer', fontSize:'12px', fontWeight:'bold' }}>Cancel</button>
                      <button onClick={handleFreeAll} disabled={busy}
                        style={{ flex:1, padding:'8px', background:'#f59e0b', color:'#0f1117', border:'none', borderRadius:'6px', cursor: busy ? 'not-allowed' : 'pointer', fontSize:'12px', fontWeight:'bold' }}>
                        {busy ? '…' : 'Confirm free entire space'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setConfirmFreeAll(true)} disabled={busy}
                    style={{ width:'100%', padding:'9px', background:'transparent', color:'#f59e0b', border:'1px dashed #a16207', borderRadius:'6px', cursor: busy ? 'not-allowed' : 'pointer', fontSize:'11px', fontWeight:'bold' }}>
                    Free entire space ({residents.length} {residents.length === 1 ? 'resident' : 'residents'})
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

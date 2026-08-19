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
  setSpaceDesignatedVehicle,
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
  // 2026-08-19 designated-vehicle arc Commit 3 — display + optional edit
  // of spaces.designated_vehicle_id. Default false (opt-in) so callsites
  // that haven't wired the picker yet (CA in Commit 3) keep old behavior.
  //   showDesignation:      render the section at all
  //   canEditDesignation:   render the picker + clear button (else read-only chip)
  showDesignation?: boolean
  canEditDesignation?: boolean
  // Address for the "Don't see the vehicle? Register it first" affordance.
  // Optional — the affordance falls back to a plain text hint if omitted.
  onOpenAddVehicle?: (residentEmail: string) => void
}

export default function SpaceDetailModal({
  space, property, onClose, onMutate,
  showDesignation = false,
  canEditDesignation = false,
  onOpenAddVehicle,
}: Props) {
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
  // 2026-08-19 designated-vehicle Commit 3 — picker local state.
  // designatedId reflects the CURRENT persisted state (mirrors space.
  // designated_vehicle_id, refreshed post-reload). pendingDesignationId
  // is the picker's uncommitted selection, applied on Save.
  const [designatedId, setDesignatedId] = useState<number | null>(space.designated_vehicle_id ?? null)
  const [pendingDesignationId, setPendingDesignationId] = useState<number | null>(space.designated_vehicle_id ?? null)

  // 🔴 2026-08-19 Commit 3 fix (Mateo Aug 19 Defect 2) — direct fetch of
  // the currently-designated vehicle, INDEPENDENT of the picker's
  // tied-resident scope. The Aug 19 defect was: the modal resolved the
  // current designation by looking it up in the tied-residents' active-
  // vehicles list, and rendered "No designated vehicle" whenever the
  // designated vehicle wasn't in that list (deactivated, or owned by
  // an untied resident). That's a report-that-says-something-other-
  // than-what-happened bug (Aug 9 class) — it concealed Defect 1's
  // stale pointer on G-1 completely.
  //
  // Fix: fetch the designated vehicle by ID directly, and use its
  // actual state to render honestly. The picker options (below) stay
  // scoped to what's valid to designate to; the DISPLAY reflects what
  // the column actually says.
  interface DesignatedVehicleInfo {
    id:            number
    plate:         string
    ymm:           string
    ownerEmail:    string
    is_active:     boolean
    status:        string
  }
  const [designatedInfo, setDesignatedInfo] = useState<DesignatedVehicleInfo | null>(null)
  // 🔴 Finding B (Mateo Aug 19) — distinguish "fetch never ran /
  // in-flight" from "fetch returned no rows". The unresolvable amber
  // state may ONLY be claimed after a successful fetch returning
  // nothing. Prior code conflated null-because-loading with
  // null-because-not-found, causing amber to fire on the healthy
  // valid case in the post-save race window. Same class as Defect 2
  // (fallback conflating states), one level up.
  //
  //   'idle'    — no designation to fetch (designated_vehicle_id was null)
  //   'loading' — fetch in flight; render must NOT claim any verdict
  //   'loaded'  — fetch settled; designatedInfo reflects actual state
  const [designatedFetchStatus, setDesignatedFetchStatus] =
    useState<'idle' | 'loading' | 'loaded'>('idle')

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

      // Direct fetch of the designated vehicle (independent of the
      // tied-resident scope — see designatedInfo header for rationale).
      // Finding B fix: track fetch status so the render can distinguish
      // "loading" from "loaded-and-no-rows". Only the latter justifies
      // the unresolvable amber verdict.
      if (space.designated_vehicle_id != null) {
        setDesignatedFetchStatus('loading')
        setDesignatedInfo(null)   // clear stale info during fetch
        const { data: dv, error: dvErr } = await supabase
          .from('vehicles')
          .select('id, plate, year, color, make, model, resident_email, is_active, status')
          .eq('id', space.designated_vehicle_id)
          .maybeSingle()
        if (dvErr) {
          // 🔴 Fetch ERROR is not a data verdict — it's a system fault.
          // Log distinctly (Aug 19 rule) rather than silently absorbing
          // into the unresolvable amber branch. Keep status as 'loading'
          // so the render shows a resolving state rather than claiming
          // "no such vehicle" for what is actually a transient fault.
          console.error('[SpaceDetailModal] designated-vehicle fetch failed', {
            spaceId: space.id, vehicleId: space.designated_vehicle_id, error: dvErr.message,
          })
          setError(`Failed to load designated vehicle: ${dvErr.message}`)
          setDesignatedInfo(null)
          setDesignatedFetchStatus('loading')  // stay loading — visible retry via reopen
        } else if (dv && typeof dv.id === 'number') {
          setDesignatedInfo({
            id:         dv.id,
            plate:      dv.plate ?? '',
            ymm:        [dv.year, dv.color, dv.make, dv.model].filter(Boolean).join(' '),
            ownerEmail: (dv.resident_email ?? '').toLowerCase(),
            is_active:  dv.is_active === true,
            status:     dv.status ?? 'unknown',
          })
          setDesignatedFetchStatus('loaded')
        } else {
          // Fetch succeeded with no rows — FK target missing or RLS
          // hid the row. That IS the unresolvable verdict.
          setDesignatedInfo(null)
          setDesignatedFetchStatus('loaded')
        }
      } else {
        setDesignatedInfo(null)
        setDesignatedFetchStatus('idle')
      }
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

  // Sync designation state with the prop when the parent refetches
  // (post-mutate). Parent's fetchSpacesList batch-resolves designated
  // plate; we mirror the id here so the picker's persisted-vs-pending
  // comparison stays honest across refetches.
  useEffect(() => {
    setDesignatedId(space.designated_vehicle_id ?? null)
    setPendingDesignationId(space.designated_vehicle_id ?? null)
  }, [space.id, space.designated_vehicle_id])

  // 2026-08-19 Commit 3 — save picker selection via the DEFINER RPC.
  // NULL vehicleId clears. On success, refresh local state + parent.
  // On error, surface the RPC hint (or message) legibly rather than
  // swallow.
  async function handleSaveDesignation(nextVehicleId: number | null) {
    setBusy(true); setError('')
    try {
      const res = await setSpaceDesignatedVehicle(supabase, space.id, nextVehicleId)
      if (!res.ok) {
        setError(res.hint ?? res.error ?? 'Could not save designation.')
        return
      }
      setDesignatedId(nextVehicleId)
      setPendingDesignationId(nextVehicleId)
      await onMutate()   // parent refetches; will bring back the resolved plate
    } finally {
      setBusy(false)
    }
  }

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

        {/* 2026-08-19 designated-vehicle Commit 3 — Designated vehicle
            section. Rendered when showDesignation is set by the parent.
            Read-only (chip only) unless canEditDesignation is also true.
            Placement ABOVE the tied-residents list because a manager
            opening the modal to "assign the F-150 to R-1" should see
            the designation control immediately, not after scrolling
            past a residents list.

            Empty state renders "No designated vehicle" — NEVER blank,
            NEVER a dash. Mateo Aug 19 reporting-honesty rule: blank
            is ambiguous between "none set" and "failed to load"; the
            empty text distinguishes them. */}
        {showDesignation && !loading && (() => {
          // Flatten vehiclesByEmail into picker options, one per (owner,
          // vehicle). Reads via space_residents (vehiclesByEmail is
          // built from that set); never touches assigned_to_resident_email.
          const pickerOptions: Array<{ id: number; plate: string; ymm: string; ownerName: string; ownerEmail: string }> = []
          for (const r of residents) {
            const plates = vehiclesByEmail.get(r.email) ?? []
            for (const v of plates) {
              pickerOptions.push({
                id:         v.id,
                plate:      v.plate,
                ymm:        [v.year, v.color, v.make, v.model].filter(Boolean).join(' '),
                ownerName:  r.name || r.email,
                ownerEmail: r.email,
              })
            }
          }
          const hasAnyOptions = pickerOptions.length > 0
          const dirty = pendingDesignationId !== designatedId
          // R-1 case: the manager wanted an F-150 not registered to
          // the resident. Show the "not registered" affordance ALWAYS,
          // not only when the list is empty — the R-1 failure was a
          // 4-vehicle list without the intended target.
          const showRegisterAffordance = canEditDesignation

          // 🔴 Mateo Aug 19 Defect 2 fix — display state derives from
          // the column (via designatedInfo direct fetch), NOT from the
          // picker options. Four honest states:
          //
          //   1. Unset                    → "No designated vehicle"
          //   2. Set + resolved + valid   → normal display (plate + ymm + owner)
          //   3. Set + resolved + stale   → warning (inactive / declined / owner untied)
          //                                 + Remove available
          //   4. Set + not resolvable     → "designation not resolvable in your scope"
          //                                 + Remove available
          //
          // Prior behavior collapsed states 3 and 4 into state 1 by
          // relying on `pickerOptions.find(o => o.id === designatedId)`
          // as the "is it set?" test — which returned null for any
          // designation not in the currently-scoped tied-residents'
          // active-vehicles list. That concealed both Defect 1 (G-1
          // pointing at a deactivated vehicle) and Defect 2 (CP-1
          // pointing at a valid vehicle whose owner scope didn't match).
          // 🔴 Finding B fix (Mateo Aug 19): fetch-status gate.
          // 'unresolvable' may ONLY be claimed when the direct fetch
          // completed successfully with zero rows. 'loading' is a
          // system state, not a data verdict.
          let displayState:
            | { kind: 'unset' }
            | { kind: 'loading' }
            | { kind: 'valid';        plate: string; ymm: string; ownerName: string }
            | { kind: 'stale-inactive'; plate: string; status: string }
            | { kind: 'stale-untied'; plate: string; ownerEmail: string }
            | { kind: 'unresolvable'; id: number }
          if (designatedId == null) {
            displayState = { kind: 'unset' }
          } else if (designatedFetchStatus === 'loading') {
            // Fetch in flight (initial open or post-save reload).
            // Render a neutral loading state; do NOT claim a data
            // verdict. Prevents the amber "unresolvable" false
            // positive Mateo caught on E-1 immediately after save.
            displayState = { kind: 'loading' }
          } else if (designatedInfo == null) {
            // designatedFetchStatus === 'loaded' AND null → FK target
            // truly missing or RLS-hidden. Legitimate unresolvable.
            displayState = { kind: 'unresolvable', id: designatedId }
          } else if (!designatedInfo.is_active || designatedInfo.status !== 'active') {
            displayState = { kind: 'stale-inactive', plate: designatedInfo.plate, status: designatedInfo.status }
          } else {
            const owner = residents.find(r => r.email === designatedInfo.ownerEmail)
            if (!owner) {
              displayState = { kind: 'stale-untied', plate: designatedInfo.plate, ownerEmail: designatedInfo.ownerEmail }
            } else {
              displayState = {
                kind:      'valid',
                plate:     designatedInfo.plate,
                ymm:       designatedInfo.ymm,
                ownerName: owner.name || owner.email,
              }
            }
          }
          const isStale = displayState.kind === 'stale-inactive' || displayState.kind === 'stale-untied' || displayState.kind === 'unresolvable'
          const isLoading = displayState.kind === 'loading'

          return (
            <div style={{
              padding:'12px', background:'#101828',
              border:`1px solid ${isStale ? '#a16207' : isLoading ? '#3a4055' : '#2a3550'}`,
              borderRadius:'8px', marginBottom:'14px',
            }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:'8px' }}>
                <p style={{ color:'#C9A227', fontSize:'11px', margin:0, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:'bold' }}>
                  Designated vehicle
                </p>
                {displayState.kind === 'unset'
                  ? <span style={{ color:'#888', fontSize:'11px' }}>No designated vehicle</span>
                  : isLoading
                    ? <span style={{ color:'#888', fontSize:'11px' }}>resolving…</span>
                    : isStale
                      ? <span style={{ color:'#fbbf24', fontSize:'11px' }}>needs attention</span>
                      : <span style={{ color:'#aaa', fontSize:'11px' }}>currently set</span>}
              </div>

              {/* Loading state — Finding B (Mateo Aug 19). Show neutral
                  "Resolving…" during the direct fetch; never claim a
                  data verdict while in flight. */}
              {displayState.kind === 'loading' && (
                <p style={{ color:'#888', fontSize:'13px', margin:'0 0 8px', fontStyle:'italic' }}>
                  Resolving current designation…
                </p>
              )}

              {/* Current designation display — reads from designatedInfo
                  (source of truth), NEVER from pickerOptions */}
              {displayState.kind === 'valid' && (
                <p style={{ color:'#eee', fontSize:'13px', margin:'0 0 8px' }}>
                  <span style={{ fontFamily:'Courier New', color:'white', fontWeight:'bold' }}>{displayState.plate}</span>
                  {displayState.ymm && <span style={{ color:'#888', marginLeft:'8px' }}>{displayState.ymm}</span>}
                  <span style={{ color:'#666', marginLeft:'8px', fontSize:'11px' }}>· {displayState.ownerName}</span>
                </p>
              )}
              {displayState.kind === 'stale-inactive' && (
                <p style={{ color:'#fbbf24', fontSize:'13px', margin:'0 0 8px' }}>
                  Designated vehicle{' '}
                  <span style={{ fontFamily:'Courier New', color:'white', fontWeight:'bold' }}>{displayState.plate}</span>
                  {' '}is no longer active
                  <span style={{ color:'#888' }}> ({displayState.status})</span>.
                  {canEditDesignation && ' Use Remove below to clear it.'}
                </p>
              )}
              {displayState.kind === 'stale-untied' && (
                <p style={{ color:'#fbbf24', fontSize:'13px', margin:'0 0 8px' }}>
                  Designated vehicle{' '}
                  <span style={{ fontFamily:'Courier New', color:'white', fontWeight:'bold' }}>{displayState.plate}</span>
                  {' '}— owner <span style={{ color:'#888' }}>{displayState.ownerEmail}</span> is no longer tied to this space.
                  {canEditDesignation && ' Use Remove below to clear it, or Save a new selection.'}
                </p>
              )}
              {displayState.kind === 'unresolvable' && (
                <p style={{ color:'#fbbf24', fontSize:'13px', margin:'0 0 8px' }}>
                  Designated vehicle <span style={{ color:'#888' }}>#{displayState.id}</span> is not visible in your scope
                  — cannot resolve plate.
                  {canEditDesignation && ' Use Remove below to clear it.'}
                </p>
              )}

              {/* Reference-only caveat — Mateo Aug 19: match the price
                  pattern; must never imply enforcement */}
              <p style={{ color:'#7a8394', fontSize:'11px', margin:'0 0 10px', lineHeight:'1.5', fontStyle:'italic' }}>
                For your records. Does not affect enforcement — all of this resident&apos;s
                approved vehicles remain authorized at the property.
              </p>

              {/* Picker + Save + Clear (only when canEditDesignation) */}
              {canEditDesignation && (
                <>
                  {hasAnyOptions ? (
                    <select
                      value={pendingDesignationId ?? ''}
                      onChange={e => {
                        const v = e.target.value
                        setPendingDesignationId(v === '' ? null : Number(v))
                      }}
                      disabled={busy}
                      style={{
                        width:'100%', padding:'8px', background:'#0f1117',
                        color:'white', border:'1px solid #2a2f3d', borderRadius:'6px',
                        fontSize:'12px', fontFamily:'inherit',
                      }}
                    >
                      <option value="">— No designated vehicle (any approved vehicle) —</option>
                      {pickerOptions.map(o => (
                        <option key={o.id} value={o.id}>
                          {o.plate}{o.ymm ? ` · ${o.ymm}` : ''} · {o.ownerName}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p style={{ color:'#888', fontSize:'12px', margin:'0 0 8px' }}>
                      No approved vehicles for the tied residents.
                    </p>
                  )}

                  {/* Empty-list / R-1 affordance — ALWAYS visible when
                      editable, per Mateo Aug 19 acceptance criterion.
                      The R-1 failure was a 4-vehicle list without the
                      intended target, not an empty list. */}
                  {showRegisterAffordance && (
                    <p style={{ color:'#7a8394', fontSize:'11px', margin:'8px 0 0', lineHeight:'1.5' }}>
                      Don&apos;t see the vehicle? It needs to be registered to this resident first.
                      {onOpenAddVehicle && residents.length > 0 && (
                        <>
                          {' '}
                          {residents.map((r, i) => (
                            <span key={r.email}>
                              {i > 0 && ' · '}
                              <button
                                onClick={() => onOpenAddVehicle(r.email)}
                                disabled={busy}
                                style={{
                                  background:'transparent', border:'none', color:'#7ab1ff',
                                  textDecoration:'underline', cursor: busy ? 'not-allowed' : 'pointer',
                                  padding:0, fontSize:'inherit', fontFamily:'inherit',
                                }}
                              >
                                Add for {r.name || r.email}
                              </button>
                            </span>
                          ))}
                        </>
                      )}
                    </p>
                  )}

                  {/* Save + Clear buttons */}
                  <div style={{ display:'flex', gap:'8px', marginTop:'10px' }}>
                    <button
                      onClick={() => handleSaveDesignation(pendingDesignationId)}
                      disabled={busy || !dirty}
                      style={{
                        flex:1, padding:'8px',
                        background: (dirty && !busy) ? '#C9A227' : '#333',
                        color: (dirty && !busy) ? '#0f1117' : '#666',
                        border:'none', borderRadius:'6px',
                        cursor: (dirty && !busy) ? 'pointer' : 'not-allowed',
                        fontSize:'12px', fontWeight:'bold', fontFamily:'inherit',
                      }}
                    >
                      {busy ? 'Saving…' : (pendingDesignationId === null ? 'Clear designation' : 'Save designation')}
                    </button>
                    {designatedId !== null && (
                      <button
                        onClick={() => handleSaveDesignation(null)}
                        disabled={busy}
                        title="Clear current designation — any approved vehicle authorized"
                        style={{
                          padding:'8px 12px', background:'#1e2535', color:'#aaa',
                          border:'1px solid #3a4055', borderRadius:'6px',
                          cursor: busy ? 'not-allowed' : 'pointer',
                          fontSize:'12px', fontWeight:'bold', fontFamily:'inherit',
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })()}

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

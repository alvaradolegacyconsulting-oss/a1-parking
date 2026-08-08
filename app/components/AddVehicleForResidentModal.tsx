'use client'
//
// 2026-08-08 — Manager Add Vehicle for an existing resident.
//
// Closes the dead end: the `+ Add Resident` form takes exactly one
// vehicle, so a manager adding a second car for the same resident has
// had no move today. Green Acres has residents who will never open the
// resident portal; their manager is the one doing everything on their
// behalf. Also useful when the companion-vehicle proxy previously
// dropped a car (pre-e5369f8) and the plate needs to land now.
//
// Form fields lift from the legacy manager `addVehicle` at
// manager/page.tsx:2260 — plate + state + make/model/year/color. No
// permit_expiry (rarely used; the legacy form gate doesn't warrant it
// here). No unit field: attribution comes from resident.unit on the
// detail view, NEVER from a re-query. Same class as the
// resident_row_precedence lock — a duplicate-row resident
// (sayralalvarado@icloud.com had rows at 117 and Apt 117) must land
// under the view's unit, not a lookup that picks arbitrarily.
//
// State + write live in the parent (manager/page.tsx). This component
// is form + surface only — it takes a submit callback that returns
// { ok, friendlyMessage? }. On error: render the friendlyMessage
// inline (RED banner). On success: close. Plate collision surfaces
// through the enhanced assertPlateUniqueAtProperty which now names
// the owning resident + unit within the manager's per-property scope.
//

import { useState } from 'react'
import { normalizePlate } from '../lib/plate'

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
  'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
  'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
]

export interface AddVehiclePayload {
  plate:  string   // normalized
  state:  string
  make:   string | null
  model:  string | null
  year:   number | null
  color:  string | null
}

export interface AddVehicleSubmitResult {
  ok: boolean
  friendlyMessage?: string  // rendered inline on failure (red)
}

interface Props {
  residentName:   string
  residentEmail:  string
  residentUnit:   string
  propertyName:   string
  onCancel:       () => void
  onSubmit:       (payload: AddVehiclePayload) => Promise<AddVehicleSubmitResult>
}

export default function AddVehicleForResidentModal({
  residentName,
  residentEmail,
  residentUnit,
  propertyName,
  onCancel,
  onSubmit,
}: Props) {
  const [plate,  setPlate]  = useState('')
  const [state,  setState]  = useState('TX')
  const [make,   setMake]   = useState('')
  const [model,  setModel]  = useState('')
  const [year,   setYear]   = useState('')
  const [color,  setColor]  = useState('')
  const [busy,   setBusy]   = useState(false)
  const [errMsg, setErrMsg] = useState<string | null>(null)

  const normalizedPlate = normalizePlate(plate)
  const canSubmit = normalizedPlate.length > 0 && !busy

  async function handleSubmit() {
    if (!canSubmit) return
    setErrMsg(null)
    setBusy(true)
    try {
      const result = await onSubmit({
        plate:  normalizedPlate,
        state,
        make:   make.trim().length  > 0 ? make.trim()  : null,
        model:  model.trim().length > 0 ? model.trim() : null,
        year:   year.trim().length  > 0 && Number.isFinite(parseInt(year, 10)) ? parseInt(year, 10) : null,
        color:  color.trim().length > 0 ? color.trim() : null,
      })
      if (result.ok) {
        // Parent will close by unmounting the component; leave state as-is.
        return
      }
      setErrMsg(result.friendlyMessage ?? 'Could not add vehicle. Please try again.')
    } catch (e) {
      setErrMsg((e as Error).message || 'Unexpected error. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const inp: React.CSSProperties = {
    display: 'block', width: '100%', marginTop: '4px', marginBottom: '10px',
    padding: '9px 10px', background: '#1e2535', border: '1px solid #3a4055',
    borderRadius: '6px', color: 'white', fontSize: '13px',
    boxSizing: 'border-box', outline: 'none', fontFamily: 'Arial',
  }
  const lbl: React.CSSProperties = {
    color: '#aaa', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em',
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)', zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
    }}>
      <div style={{
        background: '#161b26', border: '1px solid #C9A227', borderRadius: '14px',
        padding: '22px', maxWidth: '480px', width: '100%', maxHeight: '90vh', overflowY: 'auto',
      }}>
        <p style={{
          color: '#C9A227', fontSize: '11px', textTransform: 'uppercase',
          letterSpacing: '0.08em', margin: '0 0 6px', fontWeight: 'bold',
        }}>
          Add vehicle for resident
        </p>
        <p style={{ color: 'white', fontSize: '15px', margin: '0 0 4px', fontWeight: 'bold' }}>
          {residentName || residentEmail}
        </p>
        <p style={{ color: '#888', fontSize: '12px', margin: '0 0 14px' }}>
          Unit {residentUnit || '—'} · {residentEmail} · {propertyName}
        </p>

        {errMsg && (
          <div role="alert" style={{
            background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: '8px',
            padding: '10px 14px', marginBottom: '14px',
          }}>
            <p style={{ color: '#f44336', fontSize: '12.5px', margin: 0, lineHeight: '1.5' }}>
              {errMsg}
            </p>
          </div>
        )}

        <label style={lbl}>License plate *</label>
        <input
          value={plate}
          onChange={e => setPlate(normalizePlate(e.target.value))}
          placeholder="ABC1234"
          style={{ ...inp, fontFamily: 'Courier New', fontSize: '16px', fontWeight: 'bold', textAlign: 'center', letterSpacing: '0.1em' }}
          disabled={busy}
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <label style={lbl}>State</label>
            <select value={state} onChange={e => setState(e.target.value)} style={inp} disabled={busy}>
              {US_STATES.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>Color</label>
            <input value={color} onChange={e => setColor(e.target.value)} placeholder="Black" style={inp} disabled={busy} />
          </div>
          <div>
            <label style={lbl}>Make</label>
            <input value={make} onChange={e => setMake(e.target.value)} placeholder="Toyota" style={inp} disabled={busy} />
          </div>
          <div>
            <label style={lbl}>Model</label>
            <input value={model} onChange={e => setModel(e.target.value)} placeholder="Camry" style={inp} disabled={busy} />
          </div>
          <div style={{ gridColumn: 'span 2' }}>
            <label style={lbl}>Year</label>
            <input value={year} onChange={e => setYear(e.target.value)} placeholder="2022" style={inp} disabled={busy} />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              padding: '11px',
              background: canSubmit ? '#C9A227' : '#555',
              color: canSubmit ? '#0f1117' : '#888',
              border: 'none', borderRadius: '6px',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
              fontSize: '13px', fontWeight: 'bold', fontFamily: 'Arial',
            }}
          >
            {busy ? 'Adding…' : 'Add vehicle'}
          </button>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: '8px', background: 'transparent', color: '#666',
              border: '1px solid #2a2f3d', borderRadius: '6px',
              cursor: busy ? 'not-allowed' : 'pointer', fontSize: '11px',
              fontFamily: 'Arial',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

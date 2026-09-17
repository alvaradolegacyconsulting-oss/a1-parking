// ════════════════════════════════════════════════════════════════════
// CA plate activity tab — one property, one plate, a 30-day window.
//
// Answers a question nothing else in this portal answers: "has this
// vehicle been here before, and was it cited?" Every other plate
// surface answers "is this vehicle authorized HERE, NOW."
//
// ── BOUNDARY ────────────────────────────────────────────────────────
// No resident identity. No self-registered-versus-invited (descoped
// 2026-09-17 — visitor_passes has no origin column and it cannot be
// backfilled). No cross-property view. No fees or tow costs: the RPC
// excludes them and E1 in the paired verification asserts the payload
// carries none, so this UI must not reintroduce them from somewhere
// else.
//
// ── THE GATES ARE NOT HERE ──────────────────────────────────────────
// CA-only and company scoping live in ca_plate_activity() itself. This
// component renders what it is given. Hiding the tab is not a control.
// ════════════════════════════════════════════════════════════════════
'use client'

import { useState } from 'react'
import { supabase } from '../supabase'
import { normalizePlate } from '../lib/plate'
import { displayTowReason } from '../lib/tow-reasons'
import { formatTimestamp } from '../lib/format-time'
import { fetchPlateActivity, type PlateActivity } from '../lib/ca-plate-activity'

const C = {
  panel: '#161b26', border: '#2a2f3d', gold: '#C9A227',
  text: '#e8e8e8', muted: '#888', faint: '#555', red: '#f44336', green: '#4caf50',
}

export default function CaPlateActivityTab({ properties }: { properties: { name: string }[] }) {
  // 🔴 NO DEFAULT PROPERTY. A preselected property produces a confident
  // wrong answer — the same defect as the visitor-pass picker on
  // 2026-09-14, where a visitor at Sugarberry got a Green Acres pass
  // because the first option was already chosen. Here the wrong answer
  // is "this plate has never been here", which is worse than no answer.
  // The one exception is a company with exactly one property: no
  // ambiguity to protect against.
  const [property, setProperty] = useState<string>(properties.length === 1 ? properties[0].name : '')
  const [plate, setPlate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PlateActivity | null>(null)

  const canSearch = !busy && property.length > 0 && normalizePlate(plate).length > 0

  async function run() {
    if (!canSearch) return
    setBusy(true); setError(null); setResult(null)
    const r = await fetchPlateActivity(supabase, { property, plate: normalizePlate(plate) })
    setBusy(false)
    if (!r.ok) { setError(r.message); return }
    setResult(r)
  }

  return (
    <div>
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: '10px', padding: '16px', marginBottom: '14px' }}>
        <p style={{ color: C.gold, fontWeight: 'bold', fontSize: '13px', margin: '0 0 4px' }}>Has this vehicle been here before?</p>
        <p style={{ color: C.muted, fontSize: '11px', margin: '0 0 14px', lineHeight: 1.6 }}>
          Visitor passes and violations for one plate at one of your properties, over the last 30 days.
        </p>

        <label style={label()}>Property</label>
        <select value={property} onChange={e => { setProperty(e.target.value); setResult(null); setError(null) }} style={input()}>
          {properties.length !== 1 && <option value="" disabled>Select property…</option>}
          {properties.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>

        <label style={label()}>Plate</label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <input
            value={plate}
            onChange={e => { setPlate(normalizePlate(e.target.value)); setResult(null); setError(null) }}
            onKeyDown={e => { if (e.key === 'Enter') run() }}
            placeholder="ABC1234"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            style={{ ...input(), flex: '1 1 200px', marginBottom: 0, fontFamily: 'Courier New, monospace', letterSpacing: '0.08em', fontWeight: 'bold' }}
          />
          <button onClick={run} disabled={!canSearch} style={btn(canSearch)}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </div>

        {!canSearch && !busy && (
          <div style={{ color: C.faint, fontSize: '11px', marginTop: '6px' }}>
            {property.length === 0 ? 'Pick a property, then enter a plate.' : 'Enter a plate with at least one letter or number.'}
          </div>
        )}

        {error && (
          <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: '8px', padding: '10px', color: C.text, fontSize: '12px', lineHeight: 1.6, marginTop: '10px' }}>
            {error}
          </div>
        )}
      </div>

      {result && (
        <div>
          {/* 🔴 THE WINDOW IS NAMED WHEREVER RESULTS APPEAR. A CA quoting
              "this plate has been here twice" needs to know that is twice
              in THIRTY DAYS, not ever. Without it, a number becomes a
              claim about all of history. */}
          <p style={{ color: C.muted, fontSize: '12px', margin: '0 0 12px', lineHeight: 1.6 }}>
            <strong style={{ color: C.text, fontFamily: 'Courier New, monospace', letterSpacing: '0.08em' }}>{result.plate}</strong>
            {' at '}<strong style={{ color: C.text }}>{result.property}</strong>
            {' — last '}{result.window_days}{' days'}
          </p>

          {result.pass_count === 0 && result.violation_count === 0 && (
            // Empty is an ANSWER, not an error — and it says the window
            // out loud so nobody reads it as "never".
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: '10px', padding: '16px', color: C.text, fontSize: '13px', lineHeight: 1.7 }}>
              No visitor passes and no violations for this plate at {result.property} in the last {result.window_days} days.
              <div style={{ color: C.faint, fontSize: '11px', marginTop: '6px' }}>
                This does not cover earlier than {result.window_days} days, other properties, or registered resident vehicles.
              </div>
            </div>
          )}

          {result.pass_count > 0 && (
            <div style={{ marginBottom: '14px' }}>
              <div style={label()}>
                {result.pass_count} visitor pass{result.pass_count === 1 ? '' : 'es'}
              </div>
              {result.passes.map(p => (
                <div key={p.id} style={row()}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                    <span style={{ color: C.text, fontSize: '13px' }}>{formatTimestamp(p.issued_at)}</span>
                    {p.is_live
                      ? <span style={{ color: C.green, fontSize: '11px', fontWeight: 'bold' }}>● Active now</span>
                      : <span style={{ color: C.faint, fontSize: '11px' }}>Expired</span>}
                  </div>
                  <div style={{ color: C.muted, fontSize: '11px', marginTop: '3px' }}>
                    {p.duration_hours != null ? `${p.duration_hours}-hour pass` : 'Pass'}
                    {p.visiting_unit ? ` · Unit ${p.visiting_unit}` : ''}
                    {p.expires_at ? ` · until ${formatTimestamp(p.expires_at)}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}

          {result.violation_count > 0 && (
            <div>
              <div style={label()}>
                {result.violation_count} violation{result.violation_count === 1 ? '' : 's'}
              </div>
              {result.violations.map(v => (
                <div key={v.id} style={row()}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                    <span style={{ color: C.text, fontSize: '13px', textDecoration: v.voided_at ? 'line-through' : 'none' }}>
                      {formatTimestamp(v.issued_at)}
                    </span>
                    {v.voided_at
                      ? <span style={{ color: C.red, fontSize: '11px', fontWeight: 'bold' }}>VOIDED</span>
                      : <span style={{ color: C.muted, fontSize: '11px' }}>{v.status || '—'}</span>}
                  </div>
                  <div style={{ color: C.muted, fontSize: '11px', marginTop: '3px' }}>
                    {displayTowReason(v.reason)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Only shown when there IS something, so the empty state above
              is not doubled up. */}
          {(result.pass_count > 0 || result.violation_count > 0) && (
            <p style={{ color: C.faint, fontSize: '11px', marginTop: '10px', lineHeight: 1.6 }}>
              Covers this property only, for the last {result.window_days} days. Registered resident vehicles are not visitor passes and do not appear here.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function label(): React.CSSProperties {
  return { display: 'block', color: C.muted, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px' }
}
function input(): React.CSSProperties {
  return {
    display: 'block', width: '100%', boxSizing: 'border-box', padding: '10px', marginBottom: '12px',
    background: '#1e2535', color: C.text, border: `1px solid #3a4055`, borderRadius: '8px', fontSize: '14px',
  }
}
function row(): React.CSSProperties {
  return { background: C.panel, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '10px 12px', marginBottom: '8px' }
}
function btn(enabled: boolean): React.CSSProperties {
  return {
    background: enabled ? C.gold : '#555', color: enabled ? '#0f1117' : '#888',
    border: 'none', borderRadius: '8px', padding: '10px 18px',
    fontSize: '13px', fontWeight: 'bold', cursor: enabled ? 'pointer' : 'not-allowed',
  }
}

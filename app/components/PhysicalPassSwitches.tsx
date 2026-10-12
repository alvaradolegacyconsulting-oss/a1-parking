'use client'

// ════════════════════════════════════════════════════════════════════
// Physical passes — the per-property feature switches (Piece 0)
// ════════════════════════════════════════════════════════════════════
//
// 🔴 set_property_feature_switch IS THE ONLY WRITE PATH, and this
// component must never write the columns directly. The properties guard
// trigger refuses a manager outright, and a CA's direct UPDATE would
// succeed while skipping the audit row that records the prior value —
// "turned tags on" and "re-saved tags already on" are different events
// and only the before/after pair tells them apart.
//
// That is also why this is NOT a field inside the CA's edit-property
// modal: that form spreads its whole state into one UPDATE, so a
// checkbox there would be written directly and silently unaudited.
//
// Managers see the state READ-ONLY (ruled). They need to know whether
// tags are in use at their property — the Plate Lookup tag field and
// the vehicle tag field both depend on it — but only a CA or
// super-admin may change it.

import { useState } from 'react'
import { supabase } from '../supabase'

type SwitchName = 'parking_tags' | 'printable_visitor_passes'

const SWITCHES: { name: SwitchName; label: string; help: string }[] = [
  {
    name: 'parking_tags',
    label: 'Parking tags',
    // Never "permit" — that word is the billing meter.
    help: 'Record a physical tag number against a vehicle, and check it on a plate lookup. The plate stays the source of truth; a tag corroborates it.',
  },
  {
    name: 'printable_visitor_passes',
    label: 'Printable visitor passes',
    help: 'Allow a visitor pass to be printed for the dashboard, with a code that links back to its live status.',
  },
]

export default function PhysicalPassSwitches({
  propertyId, propertyName, canEdit, parkingTags, printablePasses, onChanged,
}: {
  propertyId: number
  propertyName: string
  canEdit: boolean
  parkingTags: boolean
  printablePasses: boolean
  onChanged?: (name: SwitchName, enabled: boolean) => void
}) {
  const [state, setState] = useState<Record<SwitchName, boolean>>({
    parking_tags: !!parkingTags,
    printable_visitor_passes: !!printablePasses,
  })
  const [busy, setBusy] = useState<SwitchName | null>(null)
  // One message slot, stamped with the property it belongs to, so a
  // message can never be read against a different property after a
  // switch of context.
  const [msg, setMsg] = useState<{ forProperty: number; kind: 'ok' | 'error'; text: string } | null>(null)

  const say = (kind: 'ok' | 'error', text: string) =>
    setMsg({ forProperty: propertyId, kind, text })

  async function toggle(name: SwitchName, next: boolean) {
    if (!canEdit || busy) return
    setBusy(name); setMsg(null)
    const { data, error } = await supabase.rpc('set_property_feature_switch', {
      p_property: propertyName,
      p_switch:   name,
      p_enabled:  next,
    })
    setBusy(null)

    // 🔴 Plain language, never the driver's error string.
    if (error) {
      say('error', 'That change could not be saved. Try again, and tell us if it keeps happening.')
      return
    }
    const r = (data ?? {}) as Record<string, unknown>
    if (r.ok !== true) {
      say('error', r.error === 'not_permitted'
        ? 'Only a company admin can change this.'
        : r.error === 'property_not_found'
        ? 'That property could not be found.'
        : 'That change could not be saved. Try again, and tell us if it keeps happening.')
      return
    }

    setState(s => ({ ...s, [name]: next }))
    onChanged?.(name, next)
    const label = SWITCHES.find(s => s.name === name)!.label
    say('ok', r.changed === false
      // The RPC reports the prior value, so a no-op can say so instead
      // of claiming a change that did not happen.
      ? `${label} was already ${next ? 'on' : 'off'}.`
      : `${label} turned ${next ? 'on' : 'off'} for ${propertyName}.`)
  }

  const fresh = msg && msg.forProperty === propertyId ? msg : null

  return (
    <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '10px', padding: '16px', marginBottom: '12px' }}>
      <p style={{ color: 'white', fontWeight: 'bold', fontSize: '14px', margin: '0 0 4px' }}>Physical passes</p>
      <p style={{ color: '#888', fontSize: '12px', margin: '0 0 14px', lineHeight: '1.5' }}>
        {canEdit
          ? <>Off by default. These control what {propertyName} can record — they do not change anything already recorded.</>
          : <>Set by your company admin for {propertyName}. Shown here so you know what this property uses.</>}
      </p>

      {SWITCHES.map(sw => (
        <div key={sw.name} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '10px 0', borderTop: '1px solid #222836' }}>
          <input
            type="checkbox"
            id={`sw-${propertyId}-${sw.name}`}
            checked={state[sw.name]}
            disabled={!canEdit || busy === sw.name}
            onChange={e => toggle(sw.name, e.target.checked)}
            style={{ marginTop: '3px', width: '16px', height: '16px', cursor: canEdit ? 'pointer' : 'not-allowed', accentColor: '#C9A227' }}
          />
          <label htmlFor={`sw-${propertyId}-${sw.name}`} style={{ cursor: canEdit ? 'pointer' : 'default', flex: 1 }}>
            <span style={{ color: state[sw.name] ? '#C9A227' : '#ccc', fontSize: '13px', fontWeight: 'bold' }}>
              {sw.label}
              {busy === sw.name && <span style={{ color: '#888', fontWeight: 'normal' }}> · saving…</span>}
              {!canEdit && (
                <span style={{ color: '#666', fontWeight: 'normal', fontSize: '11px' }}>
                  {' · '}{state[sw.name] ? 'on' : 'off'}, read-only
                </span>
              )}
            </span>
            <span style={{ display: 'block', color: '#888', fontSize: '11.5px', marginTop: '3px', lineHeight: '1.5' }}>{sw.help}</span>
          </label>
        </div>
      ))}

      {fresh && (
        <p style={{ color: fresh.kind === 'ok' ? '#4caf50' : '#f44336', fontSize: '12px', margin: '12px 0 0', lineHeight: '1.5' }}>
          {fresh.text}
        </p>
      )}

      {/* 🔴 No "changed by / when" here, deliberately. The RPC audits it,
          but audit_logs RLS is OWN-ROWS-ONLY for company_admin and
          manager — each sees only rows whose user_email is theirs. So a
          change made by a DIFFERENT admin would render blank, which
          reads as "never changed" rather than "you cannot see this".
          That is the absence-as-failure-output trap. It needs a small
          DEFINER read RPC, filed with the company-scoped audit arc. */}
    </div>
  )
}

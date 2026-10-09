'use client'

// ════════════════════════════════════════════════════════════════════
// PlateProhibitionPanel — one component, two portals
// ════════════════════════════════════════════════════════════════════
//
// Mounted in the CA portal for EVERY tier and in the manager portal for
// a manager's own properties (ruled 2026-10-11). One component rather
// than two, because the three rules it has to get right are identical
// on both surfaces and would drift if written twice:
//
//   1. removal REQUIRES a reason
//   2. the confirm dialog shows the REVOCATION COUNTS before anything
//      is revoked
//   3. the full add/remove history is visible, not just what is active
//
// 🔴 This panel is the ONLY place the reason is shown. The triggers,
// the resident copy and the driver card all deliberately withhold it.
// Anyone adding a prohibition detail to another surface should read
// plate-prohibition-copy.ts first.
//
// Server-side authority is may_manage_prohibitions_at() inside each
// RPC; `canManage` here only decides what to render. A read-only
// viewer (leasing agent) still sees the history, which is the point of
// keeping it on the same component.

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase'

export interface ProhibitionRow {
  id: number
  plate: string
  reason: string
  note: string | null
  added_by: string
  added_at: string
  expires_at: string | null
  removed_at: string | null
  removed_by: string | null
  removed_reason: string | null
  removed_note: string | null
}

// Short list + note, the same two-field shape as the deactivation
// vocabulary. Free text alone invites "n/a".
const REMOVAL_REASONS = [
  'Resolved with the resident',
  'Added in error',
  'Vehicle no longer at the property',
  'Property management decision',
  'Other — note required',
] as const

const C = {
  card: '#161b26', border: '#2a2f3d', row: '#1e2535',
  text: 'white', muted: '#aaa', faint: '#555',
  gold: '#C9A227', red: '#f44336', redBg: '#3a1a1a', redLine: '#b71c1c',
}

/** ACTIVE = not removed AND not expired. Both, always. */
export function isProhibitionActive(r: ProhibitionRow, now = Date.now()): boolean {
  if (r.removed_at) return false
  if (r.expires_at && new Date(r.expires_at).getTime() <= now) return false
  return true
}

export default function PlateProhibitionPanel({
  property, canManage, isReadOnly = false,
}: {
  property: string
  canManage: boolean
  isReadOnly?: boolean
}) {
  const [rows, setRows] = useState<ProhibitionRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [plate, setPlate] = useState('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [expires, setExpires] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  // 🔴 An error is NOT "no prohibitions". Rendering an empty list on a
  // failed read would tell a manager this property has none, which is
  // the worst wrong answer this panel can give — so a failed read keeps
  // rows at null and shows the error, and the empty-state copy is only
  // reachable after a SUCCESSFUL read.
  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('property_plate_prohibitions')
      .select('id, plate, reason, note, added_by, added_at, expires_at, removed_at, removed_by, removed_reason, removed_note')
      .order('added_at', { ascending: false })
    return { data: (data ?? []) as ProhibitionRow[], error: error?.message ?? null }
  }, [])

  // The fetch lives in an async IIFE with a cancelled guard rather than
  // calling a setState-ing helper from the effect body — the latter
  // trips react-hooks/set-state-in-effect and causes cascading renders.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const r = await load()
      if (cancelled) return
      if (r.error) { setLoadError(r.error); setRows(null); return }
      setLoadError(null); setRows(r.data)
    })()
    return () => { cancelled = true }
  }, [load])

  // Manual refresh after a write. Safe to setState here — it is an event
  // handler path, not an effect body.
  const refresh = useCallback(async () => {
    const r = await load()
    if (r.error) { setLoadError(r.error); setRows(null); return }
    setLoadError(null); setRows(r.data)
  }, [load])

  async function add() {
    if (busy) return
    const p = plate.trim()
    if (!p) { setMsg({ kind: 'err', text: 'Enter a plate.' }); return }
    if (!reason.trim()) { setMsg({ kind: 'err', text: 'A reason is required. Managers and company admins see it; residents never do.' }); return }
    if (reason === 'Other — note required' && !note.trim()) {
      setMsg({ kind: 'err', text: 'Add a note explaining the reason.' }); return
    }
    setBusy(true)
    try {
      // ── The confirm dialog's counts come from the server, not a
      // client-side guess, and from the SAME predicate the executor
      // uses. A dialog that promises "2 vehicles" and revokes 3 is
      // worse than no dialog.
      const pv = await supabase.rpc('preview_plate_prohibition_impact', { p_property: property, p_plate: p })
      if (pv.error) { setMsg({ kind: 'err', text: `Couldn't check what this affects: ${pv.error.message}` }); return }
      const d = pv.data as { ok?: boolean; error?: string; vehicles?: number; visitor_passes?: number; guest_auths?: number; already_prohibited?: boolean }
      if (!d?.ok) { setMsg({ kind: 'err', text: d?.error === 'not_authorized' ? 'You can only manage prohibitions for your own properties.' : `Couldn't check what this affects: ${d?.error}` }); return }
      if (d.already_prohibited) { setMsg({ kind: 'err', text: `${p} is already on this property's list.` }); return }

      const parts: string[] = []
      if (d.vehicles)       parts.push(`${d.vehicles} registered vehicle${d.vehicles === 1 ? '' : 's'}`)
      if (d.visitor_passes) parts.push(`${d.visitor_passes} active visitor pass${d.visitor_passes === 1 ? '' : 'es'}`)
      if (d.guest_auths)    parts.push(`${d.guest_auths} guest authorization${d.guest_auths === 1 ? '' : 's'}`)
      const impact = parts.length
        ? `This will immediately deactivate ${parts.join(' and ')} for this plate.`
        : 'Nothing is currently registered under this plate here.'

      if (!window.confirm(
        `Add ${p} to the not-permitted list at ${property}?\n\n${impact}\n\n`
        + `Residents and visitors will be told the vehicle can't be registered here and to contact the office. They will not see your reason.\n\n`
        + `Lifting this later does NOT bring back anything it deactivates.`
      )) return

      const res = await supabase.rpc('add_plate_prohibition', {
        p_property: property, p_plate: p,
        p_reason: reason === 'Other — note required' ? note.trim() : reason,
        p_note: note.trim() || null,
        p_expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
      })
      if (res.error) { setMsg({ kind: 'err', text: res.error.message }); return }
      const r = res.data as { ok?: boolean; error?: string; revoked?: { vehicles?: number; visitor_passes?: number; guest_auths?: number } }
      if (!r?.ok) { setMsg({ kind: 'err', text: r?.error ?? 'Could not add the prohibition.' }); return }

      // Report what ACTUALLY happened, not what the preview predicted.
      const did: string[] = []
      if (r.revoked?.vehicles)       did.push(`${r.revoked.vehicles} vehicle${r.revoked.vehicles === 1 ? '' : 's'} deactivated`)
      if (r.revoked?.visitor_passes) did.push(`${r.revoked.visitor_passes} pass${r.revoked.visitor_passes === 1 ? '' : 'es'} revoked`)
      if (r.revoked?.guest_auths)    did.push(`${r.revoked.guest_auths} guest authorization${r.revoked.guest_auths === 1 ? '' : 's'} revoked`)
      setMsg({ kind: 'ok', text: `${p} added.${did.length ? ` ${did.join(', ')}.` : ''}` })
      setPlate(''); setReason(''); setNote(''); setExpires('')
      await refresh()
    } finally { setBusy(false) }
  }

  async function remove(row: ProhibitionRow) {
    if (busy) return
    // 🔴 The reason is collected BEFORE the call, because the RPC and
    // the table CHECK both refuse without one — prompting after a
    // refusal would make a required field look like an error.
    const picked = window.prompt(
      `Lift the prohibition on ${row.plate}?\n\n`
      + `A reason is required and stays in this property's history.\n\n`
      + REMOVAL_REASONS.map((r, i) => `${i + 1}. ${r}`).join('\n')
      + `\n\nType a number, or your own reason:`
    )
    if (picked === null) return
    const n = Number(picked.trim())
    let chosen = Number.isInteger(n) && n >= 1 && n <= REMOVAL_REASONS.length
      ? REMOVAL_REASONS[n - 1] as string
      : picked.trim()
    if (!chosen) { setMsg({ kind: 'err', text: 'A reason is required to lift a prohibition.' }); return }
    let rnote = ''
    if (chosen === 'Other — note required') {
      rnote = window.prompt('Explain the reason:')?.trim() ?? ''
      if (!rnote) { setMsg({ kind: 'err', text: 'A note is required when the reason is "Other".' }); return }
      chosen = rnote
    }
    if (!window.confirm(
      `Lift the prohibition on ${row.plate}?\n\nReason: ${chosen}\n\n`
      + `This does NOT restore anything it deactivated — the resident registers again through normal approval.`
    )) return

    setBusy(true)
    try {
      const res = await supabase.rpc('remove_plate_prohibition', { p_id: row.id, p_reason: chosen, p_note: rnote || null })
      if (res.error) { setMsg({ kind: 'err', text: res.error.message }); return }
      const r = res.data as { ok?: boolean; error?: string }
      if (!r?.ok) {
        setMsg({ kind: 'err', text: r?.error === 'removal_reason_required'
          ? 'A reason is required to lift a prohibition.'
          : r?.error === 'not_authorized' ? 'You can only manage prohibitions for your own properties.'
          : r?.error ?? 'Could not lift the prohibition.' })
        return
      }
      setMsg({ kind: 'ok', text: `${row.plate} lifted. Nothing it deactivated has been restored.` })
      await refresh()
    } finally { setBusy(false) }
  }

  const fmt = (s: string | null) => s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
  const active  = (rows ?? []).filter(r => isProhibitionActive(r))
  const history = (rows ?? []).filter(r => !isProhibitionActive(r))

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '18px 20px' }}>
      <p style={{ color: C.gold, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 'bold', margin: '0 0 6px' }}>
        Not permitted at this property
      </p>
      <p style={{ color: C.faint, fontSize: '12px', margin: '0 0 14px', lineHeight: 1.5 }}>
        Plates on this list can&apos;t be registered by a resident, given a visitor pass, added by your office, or authorized as a guest.
        They show as <strong style={{ color: C.red }}>Not permitted at this property</strong> in plate lookups.
        {' '}Residents and visitors are told to contact the office and <strong>never see your reason</strong>.
      </p>

      {loadError && (
        <p style={{ color: '#fca5a5', fontSize: '12px', margin: '0 0 12px' }}>
          Couldn&apos;t load the list — {loadError}. This is not the same as &ldquo;no prohibitions&rdquo;; refresh before relying on it.
        </p>
      )}

      {rows === null && !loadError && <p style={{ color: C.faint, fontSize: '12px' }}>Loading…</p>}

      {rows !== null && active.length === 0 && (
        <p style={{ color: C.faint, fontSize: '12px', margin: '0 0 14px' }}>No plates are prohibited at this property.</p>
      )}

      {active.map(r => (
        <div key={r.id} style={{ background: C.row, borderRadius: '6px', padding: '9px 11px', marginBottom: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
            <span style={{ color: C.text, fontFamily: 'Courier New', fontSize: '14px', fontWeight: 'bold', letterSpacing: '0.08em' }}>{r.plate}</span>
            {canManage && !isReadOnly && (
              <button onClick={() => remove(r)} disabled={busy}
                style={{ padding: '3px 10px', background: C.redBg, color: C.red, border: `1px solid ${C.redLine}`, borderRadius: '5px', cursor: busy ? 'wait' : 'pointer', fontSize: '11px', fontFamily: 'Arial' }}>
                Lift
              </button>
            )}
          </div>
          <div style={{ color: C.muted, fontSize: '11.5px', marginTop: '4px', lineHeight: 1.45 }}>
            {r.reason}{r.note ? ` — ${r.note}` : ''}
            <span style={{ color: C.faint }}>
              {' · '}added by {r.added_by} on {fmt(r.added_at)}
              {r.expires_at ? ` · expires ${fmt(r.expires_at)}` : ' · no end date'}
            </span>
          </div>
        </div>
      ))}

      {canManage && !isReadOnly && (
        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: '14px', paddingTop: '14px' }}>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
            <input value={plate} onChange={e => setPlate(e.target.value.toUpperCase())} placeholder="PLATE"
              style={{ flex: '1 1 120px', padding: '9px', background: '#0f1117', color: C.text, border: `1px solid ${C.border}`, borderRadius: '6px', fontFamily: 'Courier New', fontSize: '13px', letterSpacing: '0.08em' }} />
            <select value={reason} onChange={e => setReason(e.target.value)}
              style={{ flex: '1 1 180px', padding: '9px', background: '#0f1117', color: reason ? C.text : C.faint, border: `1px solid ${C.border}`, borderRadius: '6px', fontSize: '12px' }}>
              <option value="">Reason (required)…</option>
              <option>Trespass notice on file</option>
              <option>Repeated parking violations</option>
              <option>Not a resident or authorized guest</option>
              <option>Lease terminated</option>
              <option>Property management decision</option>
              <option>Other — note required</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional unless Other)"
              style={{ flex: '2 1 200px', padding: '9px', background: '#0f1117', color: C.text, border: `1px solid ${C.border}`, borderRadius: '6px', fontSize: '12px' }} />
            <input type="date" value={expires} onChange={e => setExpires(e.target.value)} title="Optional end date — leave blank for no end date"
              style={{ flex: '1 1 140px', padding: '9px', background: '#0f1117', color: expires ? C.text : C.faint, border: `1px solid ${C.border}`, borderRadius: '6px', fontSize: '12px' }} />
          </div>
          <button onClick={add} disabled={busy}
            style={{ padding: '9px 16px', background: busy ? '#2a2f3d' : C.gold, color: busy ? C.faint : '#0f1117', fontWeight: 'bold', fontSize: '12px', border: 'none', borderRadius: '6px', cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? 'Working…' : 'Add to list'}
          </button>
          <p style={{ color: C.faint, fontSize: '11px', margin: '8px 0 0' }}>
            Leave the date blank for no end date. An end date lets the prohibition lapse on its own; it stays in the history either way.
          </p>
        </div>
      )}

      {msg && (
        <p style={{ color: msg.kind === 'ok' ? '#86efac' : '#fca5a5', fontSize: '12px', margin: '10px 0 0' }}>{msg.text}</p>
      )}

      {history.length > 0 && (
        <div style={{ marginTop: '14px', borderTop: `1px solid ${C.border}`, paddingTop: '12px' }}>
          <button onClick={() => setShowHistory(h => !h)}
            style={{ background: 'transparent', border: 'none', color: C.muted, fontSize: '11.5px', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
            {showHistory ? '▾' : '▸'} History — {history.length} lifted or expired
          </button>
          {showHistory && history.map(r => (
            <div key={r.id} style={{ background: '#0f1117', borderRadius: '6px', padding: '8px 10px', marginTop: '6px' }}>
              <span style={{ color: C.muted, fontFamily: 'Courier New', fontSize: '13px', letterSpacing: '0.06em' }}>{r.plate}</span>
              <div style={{ color: C.faint, fontSize: '11px', marginTop: '3px', lineHeight: 1.5 }}>
                {r.reason} · added by {r.added_by} on {fmt(r.added_at)}
                <br />
                {r.removed_at
                  ? <>Lifted by {r.removed_by} on {fmt(r.removed_at)} — {r.removed_reason}{r.removed_note ? ` (${r.removed_note})` : ''}</>
                  : <>Expired {fmt(r.expires_at)}</>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

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
  propertyId, property, canManage, isReadOnly = false,
}: {
  // 🔴 2026-10-11 — propertyId is REQUIRED and is the fix for the
  // scoping bug found in UI testing: the list query had no property
  // filter, so it showed every row RLS allowed — all of a
  // multi-property manager's properties, and a company admin's whole
  // company — on whichever property happened to be selected.
  //
  // Enforcement was never affected: proven by execution in
  // verify:prohibitions, which now permanently asserts that a plate
  // prohibited at A is NOT prohibited at B, that a resident at B can
  // still register it, and that one at A cannot. The bug was display
  // only. AuthorizedPlatesManager beside this panel already took
  // propertyId for exactly this reason.
  propertyId: number
  property: string
  canManage: boolean
  isReadOnly?: boolean
}) {
  // 🔴 The result is STAMPED with the property it was loaded for, and
  // only rendered when that matches the property now selected.
  //
  // The first attempt cleared state synchronously at the top of the
  // effect, which trips react-hooks/set-state-in-effect and causes
  // cascading renders. Deriving freshness is also strictly safer: there
  // is no instant in which the previous property's list is on screen
  // under the new property's heading, which is exactly the confusion
  // that let the original scoping bug pass UI testing.
  const [loaded, setLoaded] = useState<{ forProperty: number; rows: ProhibitionRow[] | null; error: string | null }>(
    { forProperty: -1, rows: null, error: null }
  )
  const [plate, setPlate] = useState('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [expires, setExpires] = useState('')
  const [busy, setBusy] = useState(false)
  // Stamped with the property too, for the same reason as `loaded`:
  // "ZZABC added." left on screen after switching properties reads as
  // though it happened at the property now showing.
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; forProperty: number } | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  // Every message goes through here, so the property stamp cannot be
  // forgotten at one of the nine call sites. Stamping by hand at each
  // one is how eight get it and the ninth does not.
  const say = useCallback((kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text, forProperty: propertyId })
  }, [propertyId])

  // 🔴 An error is NOT "no prohibitions". Rendering an empty list on a
  // failed read would tell a manager this property has none, which is
  // the worst wrong answer this panel can give — so a failed read keeps
  // rows at null and shows the error, and the empty-state copy is only
  // reachable after a SUCCESSFUL read.
  const load = useCallback(async () => {
    // 🔴 .eq('property_id', ...) is the whole fix. Without it RLS alone
    // decided the list, and RLS is correctly WIDER than one property:
    // it returns every property the caller manages. Scoping is the
    // panel's job, not the policy's.
    const { data, error } = await supabase
      .from('property_plate_prohibitions')
      .select('id, plate, reason, note, added_by, added_at, expires_at, removed_at, removed_by, removed_reason, removed_note')
      .eq('property_id', propertyId)
      .order('added_at', { ascending: false })
    return { data: (data ?? []) as ProhibitionRow[], error: error?.message ?? null }
  }, [propertyId])

  // The fetch lives in an async IIFE with a cancelled guard rather than
  // calling a setState-ing helper from the effect body — the latter
  // trips react-hooks/set-state-in-effect and causes cascading renders.
  // load is keyed on propertyId, so switching property refetches. With
  // the old [] deps it would not have, which is the second half of the
  // same bug: even a filtered query would have kept showing the first
  // property's list.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const r = await load()
      if (cancelled) return
      setLoaded({ forProperty: propertyId, rows: r.error ? null : r.data, error: r.error })
    })()
    return () => { cancelled = true }
  }, [load, propertyId])

  // Manual refresh after a write. Safe to setState here — an event
  // handler path, not an effect body.
  const refresh = useCallback(async () => {
    const r = await load()
    setLoaded({ forProperty: propertyId, rows: r.error ? null : r.data, error: r.error })
  }, [load, propertyId])

  // A result for a DIFFERENT property is not a result. Until the stamp
  // matches, this renders as loading rather than as "none".
  const fresh     = loaded.forProperty === propertyId
  const rows      = fresh ? loaded.rows  : null
  const loadError = fresh ? loaded.error : null

  async function add() {
    if (busy) return
    const p = plate.trim()
    if (!p) { say('err', 'Enter a plate.'); return }
    if (!reason.trim()) { say('err', 'A reason is required. Managers and company admins see it; residents never do.'); return }
    if (reason === 'Other — note required' && !note.trim()) {
      say('err', 'Add a note explaining the reason.'); return
    }
    setBusy(true)
    try {
      // ── The confirm dialog's counts come from the server, not a
      // client-side guess, and from the SAME predicate the executor
      // uses. A dialog that promises "2 vehicles" and revokes 3 is
      // worse than no dialog.
      const pv = await supabase.rpc('preview_plate_prohibition_impact', { p_property: property, p_plate: p })
      if (pv.error) { say('err', `Couldn't check what this affects: ${pv.error.message}`); return }
      const d = pv.data as { ok?: boolean; error?: string; vehicles?: number; visitor_passes?: number; guest_auths?: number; already_prohibited?: boolean }
      if (!d?.ok) { say('err', d?.error === 'not_authorized' ? 'You can only manage prohibitions for your own properties.' : `Couldn't check what this affects: ${d?.error}`); return }
      if (d.already_prohibited) { say('err', `${p} is already on this property's list.`); return }

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
      if (res.error) { say('err', res.error.message); return }
      const r = res.data as { ok?: boolean; error?: string; revoked?: { vehicles?: number; visitor_passes?: number; guest_auths?: number } }
      if (!r?.ok) { say('err', r?.error ?? 'Could not add the prohibition.'); return }

      // Report what ACTUALLY happened, not what the preview predicted.
      const did: string[] = []
      if (r.revoked?.vehicles)       did.push(`${r.revoked.vehicles} vehicle${r.revoked.vehicles === 1 ? '' : 's'} deactivated`)
      if (r.revoked?.visitor_passes) did.push(`${r.revoked.visitor_passes} pass${r.revoked.visitor_passes === 1 ? '' : 'es'} revoked`)
      if (r.revoked?.guest_auths)    did.push(`${r.revoked.guest_auths} guest authorization${r.revoked.guest_auths === 1 ? '' : 's'} revoked`)
      say('ok', `${p} added.${did.length ? ` ${did.join(', ')}.` : ''}`)
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
    if (!chosen) { say('err', 'A reason is required to lift a prohibition.'); return }
    let rnote = ''
    if (chosen === 'Other — note required') {
      rnote = window.prompt('Explain the reason:')?.trim() ?? ''
      if (!rnote) { say('err', 'A note is required when the reason is "Other".'); return }
      chosen = rnote
    }
    if (!window.confirm(
      `Lift the prohibition on ${row.plate}?\n\nReason: ${chosen}\n\n`
      + `This does NOT restore anything it deactivated — the resident registers again through normal approval.`
    )) return

    setBusy(true)
    try {
      const res = await supabase.rpc('remove_plate_prohibition', { p_id: row.id, p_reason: chosen, p_note: rnote || null })
      if (res.error) { say('err', res.error.message); return }
      const r = res.data as { ok?: boolean; error?: string }
      if (!r?.ok) {
        say('err', r?.error === 'removal_reason_required'
          ? 'A reason is required to lift a prohibition.'
          : r?.error === 'not_authorized' ? 'You can only manage prohibitions for your own properties.'
          : r?.error ?? 'Could not lift the prohibition.')
        return
      }
      say('ok', `${row.plate} lifted. Nothing it deactivated has been restored.`)
      await refresh()
    } finally { setBusy(false) }
  }

  const fmt = (s: string | null) => s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
  const active  = (rows ?? []).filter(r => isProhibitionActive(r))
  const history = (rows ?? []).filter(r => !isProhibitionActive(r))

  return (
    <div style={{ background: C.card, border: `1px solid ${C.redLine}`, borderLeft: `3px solid ${C.red}`, borderRadius: '12px', padding: '18px 20px' }}>
      {/* 🔴 RED header, and it NAMES the property (Jose's ruling).
          Naming it removes the ambiguity that made the scoping bug
          invisible in testing: an unfiltered list under a generic
          heading looks exactly like a correct list. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', margin: '0 0 6px' }}>
        <p style={{ color: C.red, fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 'bold', margin: 0 }}>
          Not permitted plates
        </p>
        <span style={{ color: C.muted, fontSize: '12px' }}>{property}</span>
      </div>
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
        <p style={{ color: C.faint, fontSize: '12px', margin: '0 0 14px' }}>No plates are prohibited at {property}.</p>
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

      {msg && msg.forProperty === propertyId && (
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

'use client'
// ════════════════════════════════════════════════════════════════════
// Property cascade: plan → confirm → per-user progress → results
// ════════════════════════════════════════════════════════════════════
// The UI half of /api/admin/property-active. One component, so that
// when the CA path is routed through the cascade (Sweep #2 class 16)
// both portals show the same thing and not two drifting copies.
//
// 🔴 THE OPERATOR CONFIRMS A LIST, NOT A COUNT. The dialog this
// replaces said "this will suspend account access for: 31 residents",
// and that count came from the same filter that carried Finding B — so
// the number was wrong in exactly the cases that mattered. A list of
// names with a per-user action and a reason cannot be wrong in a way
// nobody sees.
//
// 🔴 PROGRESS IS REAL, NOT A SPINNER. The apply response is NDJSON and
// is read line by line, so each user appears as it completes. A
// 40-user property is processed sequentially and the operator watches
// it happen rather than guessing whether it hung.
//
// This component performs no authorization and no writes of its own —
// the route does both. It cannot be made safe by what it renders.

import { useCallback, useEffect, useRef, useState } from 'react'

const GOLD = '#C9A227'
const CARD = '#161b26'
const BORDER = '#2a2f3d'
const TEXT = '#e2e8f0'
const MUTED = '#888'
const RED = '#e06c6c'
const GREEN = '#6cc48e'
const AMBER = '#f0a020'

interface PlanUser { email: string; role: string; action: string; reason: string; has_login: boolean; other_active_properties: string[] }
interface Plan {
  property: { id: number; name: string; is_active: boolean }
  users: PlanUser[]
  counts: { revoke: number; restore: number; keep: number; skip: number }
  residents_to_change: number
  vehicles_to_change: number
  note: string
}
interface ResultLine { email: string; action: string; ok: boolean; detail: string }

type Phase =
  | { k: 'planning' }
  | { k: 'plan'; plan: Plan }
  | { k: 'applying'; done: number; total: number; lines: ResultLine[] }
  | { k: 'result'; ok: boolean; lines: ResultLine[]; retry: string[]; data: string; propertyFlipped: boolean; skippedVehicles: { plate: string; reason: string }[] }
  | { k: 'error'; message: string }

export default function PropertyCascadeDialog({
  property, active, onClose,
}: {
  property: { id: number; name: string }
  /** The TARGET state: false = deactivate, true = reactivate. */
  active: boolean
  /** `changed` is true if anything was written, so the caller knows
   *  whether to refresh and whether to fire its own post-steps. */
  onClose: (r: { changed: boolean; ok: boolean }) => void
}) {
  const [phase, setPhase] = useState<Phase>({ k: 'planning' })
  const changedRef = useRef(false)

  const post = useCallback(async (body: object) => {
    const res = await fetch('/api/admin/property-active', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return res
  }, [])

  // 🔴 One guard per fetch→setState pair: a slow plan landing after the
  // operator has already confirmed must not overwrite the apply phase.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await post({ property_id: property.id, active, mode: 'plan' })
        const j = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok || !j.ok) { setPhase({ k: 'error', message: j.message || 'Could not work out what this would change.' }); return }
        setPhase({ k: 'plan', plan: j as Plan })
      } catch {
        if (!cancelled) setPhase({ k: 'error', message: 'Could not reach the server.' })
      }
    })()
    return () => { cancelled = true }
  }, [property.id, active, post])

  async function apply(onlyEmails?: string[]) {
    const total = onlyEmails
      ? onlyEmails.length
      : (phase.k === 'plan' ? phase.plan.counts.revoke + phase.plan.counts.restore : 0)
    setPhase({ k: 'applying', done: 0, total, lines: [] })
    const lines: ResultLine[] = []
    let data = ''
    let propertyFlipped = false
    let ok = false
    let retry: string[] = []
    const skippedVehicles: { plate: string; reason: string }[] = []

    try {
      const res = await post({ property_id: property.id, active, mode: 'apply', ...(onlyEmails ? { only_emails: onlyEmails } : {}) })
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}))
        setPhase({ k: 'error', message: j.message || 'The cascade could not start.' })
        return
      }
      // NDJSON: one object per line, so progress is per user.
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n')
        buf = parts.pop() ?? ''
        for (const raw of parts) {
          if (!raw.trim()) continue
          let m: Record<string, unknown>
          try { m = JSON.parse(raw) } catch { continue }
          if (m.type === 'user') {
            changedRef.current = true
            lines.push({ email: String(m.email), action: String(m.action), ok: m.ok === true, detail: String(m.detail ?? '') })
            setPhase({ k: 'applying', done: Number(m.done ?? lines.length), total: Number(m.total ?? total), lines: [...lines] })
          } else if (m.type === 'data') {
            changedRef.current = true
            data = String(m.detail ?? '')
          } else if (m.type === 'vehicles_skipped') {
            for (const x of (m.skipped ?? []) as { plate: string; reason: string }[]) skippedVehicles.push(x)
          } else if (m.type === 'property') {
            changedRef.current = true
            propertyFlipped = m.ok === true
          } else if (m.type === 'done') {
            ok = m.ok === true
            retry = ((m.retry ?? []) as string[])
          }
        }
      }
      setPhase({ k: 'result', ok, lines, retry, data, propertyFlipped, skippedVehicles })
    } catch (e) {
      // The stream broke partway. Whatever already streamed is real and
      // is shown — a dropped connection does not undo completed users.
      setPhase({ k: 'result', ok: false, lines, retry: lines.filter(l => !l.ok).map(l => l.email), data: data || 'interrupted', propertyFlipped, skippedVehicles })
      console.error('[cascade] stream failed:', e)
    }
  }

  const verb = active ? 'Reactivate' : 'Deactivate'
  const close = () => onClose({ changed: changedRef.current, ok: phase.k === 'result' ? phase.ok : false })

  const row = (p: PlanUser) => {
    const colour = p.action === 'revoke' ? RED : p.action === 'restore' ? GREEN : p.action === 'keep' ? GOLD : MUTED
    return (
      <tr key={p.email} style={{ borderTop: `1px solid ${BORDER}` }}>
        <td style={{ padding: '6px 8px', color: colour, fontWeight: 700, whiteSpace: 'nowrap' }}>{p.action}</td>
        <td style={{ padding: '6px 8px', wordBreak: 'break-all' }}>{p.email}</td>
        <td style={{ padding: '6px 8px', color: MUTED }}>{p.role}</td>
        <td style={{ padding: '6px 8px', color: MUTED }}>{p.reason}</td>
      </tr>
    )
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: 16 }}>
      <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, maxWidth: 760, width: '100%', maxHeight: '88vh', overflowY: 'auto', padding: 20, color: TEXT, fontFamily: 'Arial, sans-serif' }}>
        <p style={{ color: GOLD, fontSize: 18, fontWeight: 800, margin: '0 0 4px' }}>{verb} &ldquo;{property.name}&rdquo;</p>

        {phase.k === 'planning' && <p style={{ color: MUTED, fontSize: 14 }}>Working out what this would change…</p>}

        {phase.k === 'error' && (
          <>
            <p style={{ color: RED, fontSize: 14, lineHeight: 1.6 }}>{phase.message}</p>
            <button onClick={close} style={btn()}>Close</button>
          </>
        )}

        {phase.k === 'plan' && (
          <>
            <p style={{ color: MUTED, fontSize: 13, margin: '0 0 12px', lineHeight: 1.6 }}>{phase.plan.note}</p>
            {phase.plan.users.length === 0 ? (
              <p style={{ fontSize: 14 }}>No managers or leasing agents are assigned to this property.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 12 }}>
                <thead><tr style={{ textAlign: 'left', color: MUTED }}>
                  <th style={{ padding: '6px 8px' }}>action</th><th style={{ padding: '6px 8px' }}>who</th>
                  <th style={{ padding: '6px 8px' }}>role</th><th style={{ padding: '6px 8px' }}>why</th>
                </tr></thead>
                <tbody>{phase.plan.users.map(row)}</tbody>
              </table>
            )}
            <p style={{ fontSize: 13, margin: '0 0 14px' }}>
              {active
                ? `${phase.plan.counts.restore} to restore · ${phase.plan.counts.skip} skipped`
                : `${phase.plan.counts.revoke} to revoke · ${phase.plan.counts.keep} kept · ${phase.plan.counts.skip} skipped · ${phase.plan.residents_to_change} residents · ${phase.plan.vehicles_to_change} vehicles`}
            </p>
            <button onClick={() => apply()} style={btn()}>{verb} it</button>
            <button onClick={close} style={{ ...btn(), background: 'transparent', color: MUTED, border: `1px solid ${BORDER}`, marginLeft: 8 }}>Cancel</button>
          </>
        )}

        {phase.k === 'applying' && (
          <>
            <p style={{ fontSize: 14, margin: '0 0 10px' }}>
              {phase.done} of {phase.total} {phase.total === 1 ? 'account' : 'accounts'}…
            </p>
            <div style={{ height: 6, background: '#0f1117', borderRadius: 3, overflow: 'hidden', marginBottom: 12 }}>
              <div style={{ height: '100%', width: `${phase.total ? (phase.done / phase.total) * 100 : 0}%`, background: GOLD, transition: 'width 0.2s' }} />
            </div>
            {phase.lines.map(l => (
              <p key={l.email} style={{ fontSize: 12, margin: '2px 0', color: l.ok ? TEXT : RED }}>
                {l.ok ? '✓' : '✗'} {l.email} — {l.detail}
              </p>
            ))}
            <p style={{ color: MUTED, fontSize: 12, marginTop: 10 }}>Leave this open until it finishes.</p>
          </>
        )}

        {phase.k === 'result' && (
          <>
            <p style={{ color: phase.ok ? GREEN : RED, fontSize: 15, fontWeight: 700, margin: '0 0 10px' }}>
              {phase.ok
                ? `${verb}d. All ${phase.lines.length} ${phase.lines.length === 1 ? 'account' : 'accounts'} completed.`
                : `${verb}d with problems. ${phase.lines.filter(l => !l.ok).length} of ${phase.lines.length} did not complete.`}
            </p>
            {phase.lines.map(l => (
              <p key={l.email} style={{ fontSize: 12, margin: '2px 0', color: l.ok ? TEXT : RED }}>
                {l.ok ? '✓' : '✗'} {l.email} — {l.detail}
              </p>
            ))}
            {phase.data && <p style={{ color: MUTED, fontSize: 12, marginTop: 10 }}>{phase.data}</p>}
            {!phase.propertyFlipped && (
              <p style={{ color: RED, fontSize: 12, marginTop: 6 }}>
                🔴 The property itself was not changed. Review it before relying on this.
              </p>
            )}
            {phase.skippedVehicles.length > 0 && (
              <div style={{ marginTop: 10, padding: 10, background: '#0f1117', border: `1px solid ${BORDER}`, borderRadius: 6 }}>
                <p style={{ color: AMBER, fontSize: 12, fontWeight: 700, margin: '0 0 6px' }}>
                  {phase.skippedVehicles.length} vehicle{phase.skippedVehicles.length === 1 ? '' : 's'} stayed deactivated:
                </p>
                {phase.skippedVehicles.map(v => (
                  <p key={v.plate} style={{ fontSize: 12, margin: '2px 0', color: MUTED }}>• {v.plate} — {v.reason}</p>
                ))}
                <p style={{ color: MUTED, fontSize: 11, margin: '6px 0 0' }}>Check these before enforcing at this property.</p>
              </div>
            )}
            {!phase.ok && phase.retry.length > 0 && (
              <button onClick={() => apply(phase.retry)} style={{ ...btn(), marginTop: 12 }}>
                Retry the {phase.retry.length} that failed
              </button>
            )}
            <button onClick={close} style={{ ...btn(), marginTop: 12, marginLeft: phase.ok ? 0 : 8, background: phase.ok ? GOLD : 'transparent', color: phase.ok ? '#1a1a1a' : MUTED, border: phase.ok ? 'none' : `1px solid ${BORDER}` }}>
              Close
            </button>
          </>
        )}
      </div>
    </div>
  )
}

const btn = (): React.CSSProperties => ({
  background: GOLD, color: '#1a1a1a', border: 'none', borderRadius: 6,
  padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
})

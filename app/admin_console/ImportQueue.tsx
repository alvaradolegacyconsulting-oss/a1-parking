'use client'
// ════════════════════════════════════════════════════════════════════
// The bulk-onboarding approval queue
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-15. Approve and Load are separate actions, both the
// operator's. A failed load leaves the batch approved and retryable.
//
// 🔴 THE LIST IS WHAT THE ROW CLAIMS; THE REVIEW PANEL IS WHAT IS TRUE
// NOW. Opening a batch re-runs the record checks against the property
// as it stands, because the submit-time verdict may be days old and the
// operator is deciding whether the file will LOAD — a question about
// the property, not about the file. The list does not re-validate: 358
// rows per batch through the database on every queue open would make
// the screen slow and tell the operator nothing they can act on until
// they pick one.
//
// 🔴 AND "CANNOT LOAD" IS A REASON, NOT A STATUS. A deactivated
// property, a suspended company, or the upload flag switched back off
// produce no validation error at all — the file is still clean against
// the property's records. So they cannot be folded into the stale or
// transient cases: the batch stays where it is, the panel states why,
// and neither Approve nor Return is offered, because neither helps.

import { useCallback, useEffect, useState } from 'react'

const GOLD = '#C9A227'

interface QueueRow {
  id: number
  company_name: string
  property_name: string
  status: string
  source_filename: string
  file_sha256: string
  resident_count: number
  vehicle_count: number
  attested_name: string
  attested_title: string
  attested_at: string
  created_at: string
  approved_at: string | null
  reject_reason: string | null
  reject_error_count: number | null
  block_hint: string | null
}

interface RowError { row: number; column?: string; code?: string; message: string }

interface Verdict {
  ok: true
  batch: Record<string, unknown>
  property: { id: number; name: string; is_active: boolean }
  company: { id: number; name: string; bulk_onboarding_enabled: boolean }
  file: { bytes: number; sha256: string; matches: boolean }
  parsed: { data_rows: number; resident_count: number; vehicle_count: number } | null
  validation:
    | { ran: true; clean: boolean; error_count: number; errors: RowError[]; errors_truncated: boolean }
    | { ran: false; why: string }
  block: { blocked: boolean; reasons: string[] }
  can_approve: boolean
  can_load: boolean
}

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  submitted:   { bg: '#1e2535', fg: GOLD,      label: 'Needs review' },
  approved:    { bg: '#0d1f0d', fg: '#4caf50', label: 'Approved — not loaded' },
  rejected:    { bg: '#3a1a1a', fg: '#f44336', label: 'Returned to company' },
  loaded:      { bg: '#0d1a2a', fg: '#64b5f6', label: 'Loaded' },
  rolled_back: { bg: '#2a1a0d', fg: '#ff9800', label: 'Rolled back' },
}

const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—'

export default function ImportQueue() {
  const [rows, setRows] = useState<QueueRow[] | null>(null)
  const [listErr, setListErr] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [reviewErr, setReviewErr] = useState('')
  const [acting, setActing] = useState<'approve' | 'return' | null>(null)
  const [actionMsg, setActionMsg] = useState<{ kind: 'ok' | 'err'; text: string; reasons?: string[] } | null>(null)

  const loadList = useCallback(async () => {
    setListErr('')
    try {
      const r = await fetch('/api/admin/import-batch/list')
      const j = await r.json()
      if (!r.ok) { setListErr(j.message || 'Could not load the queue.'); setRows([]); return }
      setRows(j.batches as QueueRow[])
    } catch {
      setListErr('Could not reach the server.'); setRows([])
    }
  }, [])

  useEffect(() => { void loadList() }, [loadList])

  const review = useCallback(async (id: number) => {
    setReviewing(true); setReviewErr(''); setVerdict(null); setActionMsg(null)
    try {
      const r = await fetch('/api/admin/import-batch/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: id }),
      })
      const j = await r.json()
      if (!r.ok) { setReviewErr(j.message || 'Could not review that batch.'); return }
      setVerdict(j as Verdict)
    } catch {
      setReviewErr('Could not reach the server.')
    } finally {
      setReviewing(false)
    }
  }, [])

  async function act(kind: 'approve' | 'return', id: number) {
    setActing(kind); setActionMsg(null)
    try {
      const r = await fetch(`/api/admin/import-batch/${kind}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: id, trigger: 'review' }),
      })
      const j = await r.json()
      if (!r.ok) {
        setActionMsg({ kind: 'err', text: j.message || 'That action was refused.', reasons: j.reasons })
      } else if (kind === 'approve') {
        setActionMsg({ kind: 'ok', text: `Batch ${id} approved. Loading it is a separate step.` })
      } else {
        setActionMsg({ kind: 'ok', text: `Batch ${id} returned to the company with ${j.error_count} row${j.error_count === 1 ? '' : 's'} to fix.` })
      }
      // 🔴 Re-read both the list and the verdict after any action, so
      // the screen shows what the server now holds rather than what the
      // button optimistically implied.
      await loadList()
      await review(id)
    } catch {
      setActionMsg({ kind: 'err', text: 'Could not reach the server. Nothing was changed.' })
    } finally {
      setActing(null)
    }
  }

  if (rows === null) {
    return <p style={{ color: '#666', fontSize: 13 }}>Loading the queue…</p>
  }

  const live = rows.filter(r => r.status === 'submitted' || r.status === 'approved')
  const done = rows.filter(r => !['submitted', 'approved'].includes(r.status))
  const shown = showDone ? [...live, ...done] : live

  return (
    <div>
      {listErr && (
        <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
          <p style={{ color: '#f44336', fontSize: 13, margin: 0 }}>{listErr}</p>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <p style={{ color: GOLD, fontWeight: 'bold', fontSize: 13, margin: '0 0 2px' }}>Bulk onboarding — batches</p>
          <p style={{ color: '#888', fontSize: 12, margin: 0 }}>
            {live.length === 0
              ? 'Nothing waiting.'
              : `${live.filter(r => r.status === 'submitted').length} to review, ${live.filter(r => r.status === 'approved').length} approved and not yet loaded.`}
          </p>
        </div>
        <button onClick={() => setShowDone(v => !v)}
          style={{ background: 'none', border: 'none', color: GOLD, fontSize: 12, textDecoration: 'underline', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
          {showDone ? 'Hide finished' : `Show finished (${done.length})`}
        </button>
      </div>

      {shown.length === 0 && (
        <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 10, padding: 28, textAlign: 'center' }}>
          <p style={{ color: '#555', fontSize: 13, margin: 0 }}>No batches.</p>
        </div>
      )}

      {shown.map(r => {
        const st = STATUS_STYLE[r.status] ?? { bg: '#1e2535', fg: '#888', label: r.status }
        const isOpen = open === r.id
        return (
          <div key={r.id} style={{ background: '#161b26', border: `1px solid ${isOpen ? GOLD : '#2a2f3d'}`, borderRadius: 10, padding: 14, marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ color: 'white', fontSize: 13.5, fontWeight: 'bold', margin: '0 0 3px' }}>
                  {r.property_name}
                  <span style={{ color: '#666', fontWeight: 'normal' }}> · {r.company_name}</span>
                </p>
                <p style={{ color: '#888', fontSize: 12, margin: '0 0 3px' }}>
                  {r.resident_count} residents · {r.vehicle_count} vehicles · batch {r.id}
                </p>
                <p style={{ color: '#555', fontSize: 11, margin: 0 }}>
                  {r.attested_name} ({r.attested_title}) · {when(r.attested_at)} · sha {String(r.file_sha256).slice(0, 10)}…
                </p>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <span style={{ background: st.bg, color: st.fg, padding: '3px 9px', borderRadius: 10, fontSize: 11, fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                  {st.label}
                </span>
                {/* A hint, not the verdict — the panel computes the
                    authoritative set when the batch is opened. */}
                {r.block_hint && (
                  <p style={{ color: '#ff9800', fontSize: 10.5, margin: '6px 0 0', maxWidth: 190 }}>
                    cannot load: {r.block_hint}
                  </p>
                )}
                <button
                  onClick={() => { const next = isOpen ? null : r.id; setOpen(next); setVerdict(null); setActionMsg(null); if (next) void review(next) }}
                  style={{ display: 'block', marginLeft: 'auto', marginTop: 8, background: 'none', border: `1px solid ${GOLD}`, color: GOLD, borderRadius: 6, padding: '5px 12px', fontSize: 11, fontWeight: 'bold', cursor: 'pointer', fontFamily: 'Arial' }}>
                  {isOpen ? 'Close' : 'Review'}
                </button>
              </div>
            </div>

            {r.status === 'rejected' && r.reject_reason && (
              <div style={{ background: '#1a1012', border: '1px solid #4a2020', borderRadius: 8, padding: '9px 12px', marginTop: 10 }}>
                <p style={{ color: '#888', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>
                  What the company was told{r.reject_error_count ? ` · ${r.reject_error_count} row${r.reject_error_count === 1 ? '' : 's'}` : ''}
                </p>
                <p style={{ color: '#ccc', fontSize: 12, lineHeight: 1.6, margin: 0 }}>{r.reject_reason}</p>
              </div>
            )}

            {isOpen && (
              <div style={{ borderTop: '1px solid #2a2f3d', marginTop: 12, paddingTop: 12 }}>
                {reviewing && <p style={{ color: '#888', fontSize: 12, margin: 0 }}>Re-checking this file against {r.property_name} as it stands now…</p>}
                {reviewErr && <p style={{ color: '#f44336', fontSize: 12, margin: 0 }}>{reviewErr}</p>}
                {verdict && <ReviewPanel v={verdict} id={r.id} acting={acting} actionMsg={actionMsg} onAct={act} />}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ReviewPanel({ v, id, acting, actionMsg, onAct }: {
  v: Verdict
  id: number
  acting: 'approve' | 'return' | null
  actionMsg: { kind: 'ok' | 'err'; text: string; reasons?: string[] } | null
  onAct: (k: 'approve' | 'return', id: number) => void
}) {
  const status = String(v.batch.status)
  // 🔴 Blocked hides Return as well as Approve. Returning a batch whose
  // company has bulk onboarding switched off hands the CA a list of
  // rows to fix and no way to send the fixed file back.
  const canReturn = !v.block.blocked && v.validation.ran && !v.validation.clean
    && ['submitted', 'approved'].includes(status)

  return (
    <div>
      {/* ── the file ─────────────────────────────────────────────── */}
      <Line label="File"
        value={`${String(v.batch.source_filename)} · ${v.file.bytes.toLocaleString()} bytes`} />
      {v.file.matches
        ? <Line label="Integrity" value={`sha256 matches what was attested (${v.file.sha256.slice(0, 16)}…)`} tone="ok" />
        : <Line label="Integrity" tone="bad"
            value={`🔴 The stored file does NOT hash to what was submitted. The attestation on this batch covers a different file. Do not act on it.`} />}
      {v.parsed && (
        <Line label="Contents"
          value={`${v.parsed.data_rows} rows · ${v.parsed.resident_count} residents · ${v.parsed.vehicle_count} vehicles`}
          tone={v.parsed.resident_count === Number(v.batch.resident_count) ? undefined : 'bad'} />
      )}

      {/* ── 🔴 cannot load: a reason, not a status ───────────────── */}
      {v.block.blocked && (
        <div style={{ background: '#2a1a0d', border: '1px solid #ff9800', borderRadius: 8, padding: '10px 13px', margin: '12px 0' }}>
          <p style={{ color: '#ff9800', fontSize: 12, fontWeight: 'bold', margin: '0 0 6px' }}>
            This batch cannot be loaded right now
          </p>
          {v.block.reasons.map((why, i) => (
            <p key={i} style={{ color: '#ffd9a0', fontSize: 12, lineHeight: 1.6, margin: '0 0 4px' }}>· {why}</p>
          ))}
          <p style={{ color: '#a98', fontSize: 11, lineHeight: 1.6, margin: '6px 0 0' }}>
            The batch stays as it is. Nothing to retry and nothing to send back — neither would help.
            Fix the reason above and review again.
          </p>
        </div>
      )}

      {/* ── the live verdict ─────────────────────────────────────── */}
      {!v.validation.ran ? (
        <div style={{ background: '#2a1a0d', border: '1px solid #ff9800', borderRadius: 8, padding: '10px 13px', margin: '12px 0' }}>
          <p style={{ color: '#ff9800', fontSize: 12, fontWeight: 'bold', margin: '0 0 4px' }}>The checks could not be run</p>
          <p style={{ color: '#ffd9a0', fontSize: 12, lineHeight: 1.6, margin: 0 }}>{v.validation.why}</p>
        </div>
      ) : v.validation.clean ? (
        <div style={{ background: '#0d1f0d', border: '1px solid #2e7d32', borderRadius: 8, padding: '10px 13px', margin: '12px 0' }}>
          <p style={{ color: '#4caf50', fontSize: 12, fontWeight: 'bold', margin: 0 }}>
            Checked just now against {v.property.name} — clean.
          </p>
          <p style={{ color: '#9c9', fontSize: 11, lineHeight: 1.6, margin: '4px 0 0' }}>
            Every row still fits the records at this property. This is a live result, not the
            verdict from when the file was submitted.
          </p>
        </div>
      ) : (
        <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 13px', margin: '12px 0' }}>
          <p style={{ color: '#f44336', fontSize: 12, fontWeight: 'bold', margin: '0 0 6px' }}>
            {v.validation.error_count} row{v.validation.error_count === 1 ? '' : 's'} no longer fit the records at {v.property.name}
          </p>
          <p style={{ color: '#d99', fontSize: 11, lineHeight: 1.6, margin: '0 0 8px' }}>
            This file was clean when it was submitted. Residents or vehicles have been added at the
            property since, so some rows now duplicate what is already on file.
          </p>
          <div style={{ maxHeight: 220, overflowY: 'auto', background: '#1a1012', borderRadius: 6, padding: '6px 10px' }}>
            {v.validation.errors.map((e, i) => (
              <p key={i} style={{ color: '#ccc', fontSize: 11.5, lineHeight: 1.55, margin: '0 0 3px' }}>
                <span style={{ color: GOLD, fontWeight: 'bold' }}>row {e.row}</span>
                {e.column ? <span style={{ color: '#777' }}> · {e.column}</span> : null}
                {' — '}{e.message}
              </p>
            ))}
          </div>
          {v.validation.errors_truncated && (
            <p style={{ color: '#a88', fontSize: 11, margin: '6px 0 0' }}>
              Showing the first {v.validation.errors.length} of {v.validation.error_count}.
            </p>
          )}
        </div>
      )}

      {actionMsg && (
        <div style={{
          background: actionMsg.kind === 'ok' ? '#0d1f0d' : '#3a1a1a',
          border: `1px solid ${actionMsg.kind === 'ok' ? '#2e7d32' : '#b71c1c'}`,
          borderRadius: 8, padding: '10px 13px', margin: '12px 0',
        }}>
          <p style={{ color: actionMsg.kind === 'ok' ? '#4caf50' : '#f44336', fontSize: 12, margin: 0, lineHeight: 1.6 }}>
            {actionMsg.text}
          </p>
          {actionMsg.reasons?.map((why, i) => (
            <p key={i} style={{ color: '#d99', fontSize: 11.5, lineHeight: 1.6, margin: '4px 0 0' }}>· {why}</p>
          ))}
        </div>
      )}

      {/* ── the actions ─────────────────────────────────────────── */}
      {/* 🔴 APPROVE AND LOAD ARE SEPARATE AND NEVER CHAINED. Approving
          358 rows and writing them are different decisions, and only
          the second one creates records. Load is not here yet. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
        {v.can_approve && (
          <button onClick={() => onAct('approve', id)} disabled={acting !== null}
            style={{ background: GOLD, color: '#0f1117', border: 'none', borderRadius: 6, padding: '8px 16px', fontSize: 12, fontWeight: 'bold', cursor: acting ? 'wait' : 'pointer', opacity: acting ? 0.6 : 1, fontFamily: 'Arial' }}>
            {acting === 'approve' ? 'Approving…' : 'Approve'}
          </button>
        )}
        {canReturn && (
          <button onClick={() => onAct('return', id)} disabled={acting !== null}
            style={{ background: 'none', color: '#f44336', border: '1px solid #b71c1c', borderRadius: 6, padding: '8px 16px', fontSize: 12, fontWeight: 'bold', cursor: acting ? 'wait' : 'pointer', opacity: acting ? 0.6 : 1, fontFamily: 'Arial' }}>
            {acting === 'return' ? 'Returning…' : 'Return to company'}
          </button>
        )}
        {status === 'approved' && (
          <span style={{ color: '#666', fontSize: 11.5, alignSelf: 'center', lineHeight: 1.5 }}>
            {v.can_load
              ? 'Ready to load. Loading is the next step and is not built yet.'
              : 'Approved. It cannot be loaded until the problems above are resolved.'}
          </span>
        )}
        {status === 'submitted' && !v.can_approve && !canReturn && (
          <span style={{ color: '#666', fontSize: 11.5, alignSelf: 'center', lineHeight: 1.5 }}>
            Nothing can be done with this batch until the problems above are resolved.
          </span>
        )}
      </div>
    </div>
  )
}

function Line({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '3px 0' }}>
      <span style={{ color: '#666', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', minWidth: 72, flexShrink: 0 }}>{label}</span>
      <span style={{ color: tone === 'bad' ? '#f44336' : tone === 'ok' ? '#6cc48e' : '#ccc', fontSize: 12, lineHeight: 1.6 }}>{value}</span>
    </div>
  )
}

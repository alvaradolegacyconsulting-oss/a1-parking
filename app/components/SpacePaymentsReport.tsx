'use client'
//
// Reserved-space payment tracking — Commit 4b UI (2026-08-31)
//
// Sub-panel for the manager + CA Spaces tab. Reads only — recording +
// voiding remain in SpaceDetailModal (this component's per-row action
// opens that modal for the space, reusing everything).
//
// ── DESIGN LOCKS (Mateo Aug 31 §4) ──────────────────────────────────
//
// Roster-first: the highest-value column is `assigned_residents` from
// current space_residents ties — the answer to "who should I bill for
// this space this period?" Independent of whether a payment has been
// recorded. The ledger half (recorded_total + status) is secondary.
//
// A property that bills through rent reads the roster + exports CSV.
// A property that takes payments at the desk uses both halves. Same
// view, same RPC, same component — nothing forks.
//
// ── STATE DISCIPLINE ────────────────────────────────────────────────
//
// Three distinct render states — loading, error, genuinely empty —
// never conflated. On a revenue view a failed fetch showing zeros
// reads as "nobody paid." Loading spinner / red error box with retry
// / dashed empty state / rows table — four distinct affordances.
//
// ── COPY DISCIPLINE ────────────────────────────────────────────────
//
// Statuses render via paymentStatusDisplay — 'no_payment_recorded'
// shows as "No payment recorded", NEVER "outstanding" or "unpaid".
// We don't assert who paid or didn't; we say what we recorded.
//
// ── CAPABILITY PROP (matches SpaceDetailModal pattern) ─────────────
//
// canOpenSpace: (spaceId, spaceLabel) => void
//   Parent hooks this to setTargetSpaceDetail(fullSpace). Handles the
//   Space-object lookup itself so this component doesn't have to
//   re-fetch. Optional — omit to hide per-row View affordance.

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import {
  type SpacePaymentsReportRow,
  fetchSpacePaymentsReport,
  paymentStatusDisplay,
} from '../lib/spaces'

interface Props {
  property: string
  onOpenSpace?: (spaceId: number, spaceLabel: string) => void
}

export default function SpacePaymentsReport({ property, onOpenSpace }: Props) {
  // Period defaults to current month, HTML5 month-input format.
  const [period, setPeriod] = useState<string>(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [rows, setRows] = useState<SpacePaymentsReportRow[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'loaded'>('idle')
  const [error, setError] = useState<string>('')

  // Fetch on property or period change. Cancellation guard against
  // stale-set on rapid changes.
  useEffect(() => {
    if (!property) { setStatus('idle'); return }
    let cancelled = false
    async function load() {
      setStatus('loading'); setError('')
      try {
        const r = await fetchSpacePaymentsReport(supabase, property, period)
        if (cancelled) return
        setRows(r)
        setStatus('loaded')
      } catch (e) {
        if (cancelled) return
        setError((e as Error).message || 'Unknown error')
        setStatus('error')
      }
    }
    load()
    return () => { cancelled = true }
  }, [property, period])

  // Totals — arithmetic on property's own data (Mateo Aug 31 §4 —
  // "no projected totals" was misapplied; totals here are honest).
  const totals = useMemo(() => {
    const expected  = rows.reduce((s, r) => s + Number(r.monthly_fee || 0),   0)
    const recorded  = rows.reduce((s, r) => s + Number(r.recorded_total || 0), 0)
    return { expected, recorded, difference: expected - recorded }
  }, [rows])

  // CSV export = the roster (Mateo Aug 31 §4). Space, fee, assigned
  // resident(s), unit, recorded, status. What a manager hands to
  // their rent system.
  function exportCsv() {
    const escape = (v: unknown): string => {
      const s = v == null ? '' : String(v)
      // Wrap in quotes if contains comma, newline, or quote; double
      // internal quotes.
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
      return s
    }
    const headers = [
      'Space',
      'Type',
      'Monthly fee (USD)',
      'Assigned residents',
      'Units',
      'Recorded total (USD)',
      'Status',
      'Vacant',
      'Decommissioned',
    ]
    const dataRows = rows.map(r => [
      r.space_label,
      r.space_type ?? '',
      r.monthly_fee.toFixed(2),
      r.assigned_residents.map(a => a.name || a.email || '').filter(Boolean).join('; '),
      r.assigned_residents.map(a => a.unit || '').filter(Boolean).join('; '),
      Number(r.recorded_total).toFixed(2),
      paymentStatusDisplay(r.status),
      r.is_vacant ? 'yes' : '',
      r.is_decommissioned ? 'yes' : '',
    ])
    const csv = [headers, ...dataRows].map(row => row.map(escape).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `space-payments-${property.replace(/[^a-z0-9]+/gi, '-')}-${period}.csv`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ padding:'14px', background:'#0a1628', border:'1px solid #1e3a5f', borderRadius:'8px', marginBottom:'14px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'10px', gap:'8px', flexWrap:'wrap' }}>
        <p style={{ color:'#3b82f6', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:0, fontWeight:'bold' }}>
          Space payments — month view
        </p>
        <div style={{ display:'flex', gap:'8px', alignItems:'center' }}>
          <label style={{ color:'#aaa', fontSize:'11px' }}>Period:</label>
          <input
            type='month'
            value={period}
            onChange={e => setPeriod(e.target.value)}
            style={{ padding:'5px 8px', background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'5px', color:'#eee', fontSize:'12px' }} />
          {status === 'loaded' && rows.length > 0 && (
            <button
              onClick={exportCsv}
              style={{ padding:'5px 10px', background:'#1e2535', color:'#3b82f6', border:'1px solid #1e3a5f', borderRadius:'5px', cursor:'pointer', fontSize:'11px', fontWeight:'bold' }}>
              Export CSV
            </button>
          )}
        </div>
      </div>

      {/* LOADING */}
      {status === 'loading' && (
        <div style={{ padding:'20px 12px', background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'6px', textAlign:'center', color:'#888', fontSize:'12px' }}>
          Loading report…
        </div>
      )}

      {/* ERROR — visually distinct from empty (Mateo Aug 31 §4) */}
      {status === 'error' && (
        <div style={{ padding:'12px', background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px' }}>
          <p style={{ color:'#f44336', fontSize:'12px', margin:'0 0 6px', fontWeight:'bold' }}>Could not load the report.</p>
          <p style={{ color:'#f88', fontSize:'11px', margin:'0 0 8px' }}>{error || 'Unknown error.'}</p>
          <button
            onClick={() => setStatus('idle')}
            style={{ padding:'6px 12px', background:'#1e2535', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'5px', cursor:'pointer', fontSize:'11px', fontWeight:'bold' }}>
            Retry
          </button>
        </div>
      )}

      {/* LOADED — empty */}
      {status === 'loaded' && rows.length === 0 && (
        <div style={{ padding:'14px 12px', background:'#0f1117', border:'1px dashed #2a2f3d', borderRadius:'6px', textAlign:'center', color:'#888', fontSize:'12px' }}>
          No fee-bearing spaces at this property. Set a monthly fee on a space to include it here.
        </div>
      )}

      {/* LOADED — rows */}
      {status === 'loaded' && rows.length > 0 && (
        <>
          {/* Totals summary */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:'8px', marginBottom:'10px' }}>
            <div style={{ padding:'8px 10px', background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'5px' }}>
              <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', margin:'0 0 3px' }}>Expected</p>
              <p style={{ color:'#eee', fontSize:'15px', fontWeight:'bold', margin:0, fontFamily:'Courier New' }}>${totals.expected.toFixed(2)}</p>
            </div>
            <div style={{ padding:'8px 10px', background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'5px' }}>
              <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', margin:'0 0 3px' }}>Recorded</p>
              <p style={{ color:'#4caf50', fontSize:'15px', fontWeight:'bold', margin:0, fontFamily:'Courier New' }}>${totals.recorded.toFixed(2)}</p>
            </div>
            <div style={{ padding:'8px 10px', background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'5px' }}>
              <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', margin:'0 0 3px' }}>Difference</p>
              <p style={{
                color: totals.difference === 0 ? '#4caf50' : totals.difference > 0 ? '#fbbf24' : '#f44336',
                fontSize:'15px', fontWeight:'bold', margin:0, fontFamily:'Courier New' }}>
                {totals.difference >= 0 ? '$' : '-$'}{Math.abs(totals.difference).toFixed(2)}
              </p>
            </div>
          </div>

          {/* Rows table */}
          <div style={{ maxHeight:'380px', overflowY:'auto', border:'1px solid #2a2f3d', borderRadius:'5px' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'12px' }}>
              <thead style={{ background:'#161b26', position:'sticky', top:0 }}>
                <tr>
                  <th style={thStyle}>Space</th>
                  <th style={thStyle}>Fee</th>
                  <th style={thStyle}>Assigned</th>
                  <th style={thStyle}>Recorded</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Flags</th>
                  {onOpenSpace && <th style={thStyle}></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.space_id} style={{
                    background: r.is_decommissioned ? '#151515' : 'transparent',
                    opacity:    r.is_decommissioned ? 0.7 : 1,
                    borderTop: '1px solid #2a2f3d',
                  }}>
                    <td style={tdStyle}>
                      <div style={{ color:'#eee', fontWeight:'bold' }}>{r.space_label}</div>
                      {r.space_type && <div style={{ color:'#888', fontSize:'10px' }}>{r.space_type}</div>}
                    </td>
                    <td style={tdStyleNum}>${Number(r.monthly_fee).toFixed(2)}</td>
                    <td style={tdStyle}>
                      {r.assigned_residents.length === 0
                        ? <span style={{ color:'#666', fontStyle:'italic' }}>— no ties —</span>
                        : (
                          <div style={{ display:'flex', flexDirection:'column', gap:'2px' }}>
                            {r.assigned_residents.map((a, i) => (
                              <div key={i} style={{ color:'#eee' }}>
                                {a.name || a.email || '(unnamed)'}
                                {a.unit && <span style={{ color:'#888' }}> · unit {a.unit}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                    </td>
                    <td style={{ ...tdStyleNum, color: r.recorded_total > 0 ? '#4caf50' : '#666' }}>
                      ${Number(r.recorded_total).toFixed(2)}
                    </td>
                    <td style={tdStyle}>
                      <StatusPill code={r.status} />
                    </td>
                    <td style={tdStyle}>
                      {r.is_vacant && <FlagPill label='vacant' color='#fbbf24' />}
                      {r.is_decommissioned && <FlagPill label='decommissioned' color='#888' />}
                    </td>
                    {onOpenSpace && (
                      <td style={{ ...tdStyle, textAlign:'right' }}>
                        <button
                          onClick={() => onOpenSpace(r.space_id, r.space_label)}
                          style={{ padding:'3px 8px', background:'#0a1e3a', color:'#3b82f6', border:'1px solid #3b82f6', borderRadius:'4px', cursor:'pointer', fontSize:'10px', fontWeight:'bold' }}>
                          View
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ color:'#666', fontSize:'10px', margin:'6px 0 0', fontStyle:'italic' }}>
            Statuses reflect what we recorded; a "no payment recorded" row does not mean the resident hasn't paid — they may have paid through the property's rent system.
          </p>
        </>
      )}
    </div>
  )
}

const thStyle: React.CSSProperties = {
  padding:'8px 10px', color:'#888', fontSize:'10px', textTransform:'uppercase',
  letterSpacing:'0.04em', textAlign:'left', fontWeight:'bold', borderBottom:'1px solid #2a2f3d',
}
const tdStyle: React.CSSProperties = { padding:'8px 10px', verticalAlign:'top' }
const tdStyleNum: React.CSSProperties = { ...tdStyle, textAlign:'right', fontFamily:'Courier New', color:'#eee' }

function StatusPill({ code }: { code: string }) {
  const style: React.CSSProperties = {
    padding:'2px 6px', borderRadius:'3px', fontSize:'10px', fontWeight:'bold', textTransform:'uppercase',
  }
  switch (code) {
    case 'paid':
      return <span style={{ ...style, background:'#0d1f0d', border:'1px solid #2e7d32', color:'#4caf50' }}>Paid</span>
    case 'partial':
      return <span style={{ ...style, background:'#3a2e0a', border:'1px solid #a16207', color:'#fbbf24' }}>Partial</span>
    case 'overpaid':
      return <span style={{ ...style, background:'#0a1e3a', border:'1px solid #1e3a5f', color:'#3b82f6' }}>Overpaid</span>
    case 'no_payment_recorded':
      return <span style={{ ...style, background:'#1e1e1e', border:'1px solid #444', color:'#aaa' }}>No payment recorded</span>
    default:
      return <span style={style}>{code}</span>
  }
}

function FlagPill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      display:'inline-block', padding:'1px 5px', marginRight:'3px',
      borderRadius:'3px', fontSize:'9px', fontWeight:'bold', textTransform:'uppercase',
      background:'#0f1117', border:`1px solid ${color}`, color,
    }}>
      {label}
    </span>
  )
}

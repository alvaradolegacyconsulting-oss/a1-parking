'use client'
//
// 2026-08-08 — Property warnings panel (V1: manager portal only).
//
// Extracted as a component so V2 CA-portal integration reuses the
// render layer without a rewrite (once CA gains per-property
// residents/vehicles state OR routes both portals through an RPC).
//
// Contract: pure presentation. Predicates + copy live in
// app/lib/property-warnings.ts; this file renders the resulting list
// with severity styling and hooks remedyAction to caller-supplied
// handlers.
//
// Copy discipline: NO column names, NO status values, NO internal
// concepts. Every row states what to do; self-service where it
// exists, named escalation contact where it doesn't. Enforced at the
// helper level; this component just renders.
//
// Empty state: caller decides. A parent that receives zero warnings
// should render nothing (silence, not "all clear"). This component
// does not render an empty header itself.
//
// ── COLLAPSE STATE — SESSION-ONLY BY DESIGN ──────────────────────────
//
// 2026-08-08 addition (Mateo relay #): a manager working through 14
// warnings can collapse rows they've read to reduce noise. Click the
// row header to toggle. Panel-level "Collapse all" available when
// warnings.length > 0.
//
// DELIBERATE: collapse state resets on reload. It is NOT persisted
// to localStorage, sessionStorage, IndexedDB, or a server. That
// property is load-bearing — persisted collapse is acknowledgement,
// and acknowledgement is V2. The value here is working through a
// list in one sitting, not remembering across days. A collapsed tow
// warning STILL REAPPEARS EXPANDED on the next portal load, so a
// manager who closed and forgot cannot silence a red row forever.

import { useState } from 'react'
import type { PropertyWarning, WarningRemedyAction } from '../lib/property-warnings'
import type { CrmResident } from '../lib/pm-crm'

interface Props {
  warnings:            PropertyWarning[]
  onOpenAddVehicle:    (resident: CrmResident) => void
  onScrollToPending:   (unit: string) => void
}

const SEVERITY_STYLE = {
  red:   { bg: '#3a1a1a', border: '#b71c1c', textColor: '#f44336', accent: '#f87171', prefix: '⚠ ' },
  amber: { bg: '#3a2e0a', border: '#a16207', textColor: '#fbbf24', accent: '#fde68a', prefix: ''     },
} as const

export default function PropertyWarningsPanel({ warnings, onOpenAddVehicle, onScrollToPending }: Props) {
  // Session-only. Set of warning IDs the manager has collapsed since
  // this render session started. Resets on portal reload — this is
  // load-bearing (see file header): persisted collapse is
  // acknowledgement, and a red row must never be silenceable.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())

  if (warnings.length === 0) return null

  const toggle = (id: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const collapseAll = () => setCollapsedIds(new Set(warnings.map(w => w.id)))
  const expandAll   = () => setCollapsedIds(new Set())

  // "Collapse all" toggles to "Expand all" once every row is collapsed
  // (fast un-do for a manager who wanted to skim then read one).
  const allCollapsed = warnings.length > 0 && warnings.every(w => collapsedIds.has(w.id))

  return (
    <div style={{ marginBottom: '16px' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        margin: '0 0 8px',
      }}>
        <p style={{
          color: '#aaa', fontSize: '11px', textTransform: 'uppercase',
          letterSpacing: '0.08em', margin: 0, fontWeight: 'bold',
        }}>
          Warnings <span style={{ color: '#555' }}>({warnings.length})</span>
        </p>
        <button
          onClick={allCollapsed ? expandAll : collapseAll}
          style={{
            background: 'transparent', color: '#888',
            border: '1px solid #3a4055', borderRadius: '5px',
            padding: '3px 10px', fontSize: '11px', cursor: 'pointer',
            fontFamily: 'Arial',
          }}
        >
          {allCollapsed ? 'Expand all' : 'Collapse all'}
        </button>
      </div>
      {warnings.map(w => {
        const s = SEVERITY_STYLE[w.severity]
        const isCollapsed = collapsedIds.has(w.id)
        return (
          <div key={w.id} style={{
            background: s.bg, border: `1px solid ${s.border}`,
            borderRadius: '10px', padding: '12px 14px', marginBottom: '8px',
          }}>
            {/* Header — click to toggle. Uses a button element so
                keyboard access + screen readers behave; button styling
                is stripped so it visually reads as the header. */}
            <button
              onClick={() => toggle(w.id)}
              type="button"
              aria-expanded={!isCollapsed}
              style={{
                background: 'transparent', border: 'none', padding: 0,
                width: '100%', textAlign: 'left', cursor: 'pointer',
                fontFamily: 'inherit', color: 'inherit',
              }}
            >
              <p style={{
                color: s.textColor, fontSize: '13px', fontWeight: 'bold',
                margin: '0', fontFamily: 'Arial',
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px',
              }}>
                <span>{s.prefix}{w.title}</span>
                <span style={{ color: s.accent, fontSize: '11px', fontWeight: 'normal', opacity: 0.7 }}>
                  {isCollapsed ? '▸' : '▾'}
                </span>
              </p>
            </button>
            {!isCollapsed && (
              <>
                <p style={{
                  color: s.accent, fontSize: '12.5px', margin: '4px 0 8px',
                  lineHeight: '1.5', fontFamily: 'Arial',
                }}>
                  {w.body}
                </p>
                <RemedyLine
                  remedy={w.remedy}
                  action={w.remedyAction}
                  severity={w.severity}
                  onOpenAddVehicle={onOpenAddVehicle}
                  onScrollToPending={onScrollToPending}
                />
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

function RemedyLine({
  remedy, action, severity, onOpenAddVehicle, onScrollToPending,
}: {
  remedy: string
  action?: WarningRemedyAction
  severity: 'red' | 'amber'
  onOpenAddVehicle: (resident: CrmResident) => void
  onScrollToPending: (unit: string) => void
}) {
  const linkColor = severity === 'red' ? '#f87171' : '#fbbf24'

  if (!action) {
    // No in-product action — copy names the escalation contact.
    return (
      <p style={{ color: '#e5e5e5', fontSize: '12px', margin: '0', lineHeight: '1.5', fontFamily: 'Arial' }}>
        {remedy}
      </p>
    )
  }

  if (action.kind === 'open_add_vehicle') {
    return (
      <button
        onClick={() => onOpenAddVehicle(action.resident)}
        style={{
          padding: '6px 12px', background: 'transparent',
          color: linkColor, border: `1px solid ${linkColor}`,
          borderRadius: '6px', cursor: 'pointer',
          fontSize: '12px', fontWeight: 'bold', fontFamily: 'Arial',
        }}
      >
        {remedy} →
      </button>
    )
  }

  if (action.kind === 'scroll_to_pending') {
    return (
      <button
        onClick={() => onScrollToPending(action.unit)}
        style={{
          padding: '6px 12px', background: 'transparent',
          color: linkColor, border: `1px solid ${linkColor}`,
          borderRadius: '6px', cursor: 'pointer',
          fontSize: '12px', fontWeight: 'bold', fontFamily: 'Arial',
        }}
      >
        {remedy} →
      </button>
    )
  }

  // Exhaustiveness — TS will flag any unhandled WarningRemedyAction kind.
  const _exhaustive: never = action
  void _exhaustive
  return null
}

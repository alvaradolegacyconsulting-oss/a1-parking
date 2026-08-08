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
  if (warnings.length === 0) return null

  return (
    <div style={{ marginBottom: '16px' }}>
      <p style={{
        color: '#aaa', fontSize: '11px', textTransform: 'uppercase',
        letterSpacing: '0.08em', margin: '0 0 8px', fontWeight: 'bold',
      }}>
        Warnings <span style={{ color: '#555' }}>({warnings.length})</span>
      </p>
      {warnings.map(w => {
        const s = SEVERITY_STYLE[w.severity]
        return (
          <div key={w.id} style={{
            background: s.bg, border: `1px solid ${s.border}`,
            borderRadius: '10px', padding: '12px 14px', marginBottom: '8px',
          }}>
            <p style={{
              color: s.textColor, fontSize: '13px', fontWeight: 'bold',
              margin: '0 0 4px', fontFamily: 'Arial',
            }}>
              {s.prefix}{w.title}
            </p>
            <p style={{
              color: s.accent, fontSize: '12.5px', margin: '0 0 8px',
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

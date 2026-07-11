'use client'
// B118 Layer 2 Commit 3 — <LegalGateAccordion>.
//
// Wraps N <LegalReadthroughGate>s in per-doc collapsible cards so a
// single acceptance surface can gate multiple documents (ToS + Privacy;
// or ToS + Privacy + SaaS on the redeem path) without stacking full-
// height panes vertically.
//
// UX (Option B — Jose's spec 2026-07-10):
//   • One accordion card per legal doc; each shows title + version +
//     status pill (Not read → Reviewed → ✓ Signed) inline in the header.
//   • Chevron rotates 180° on expand.
//   • Independent expand/collapse — multiple cards can be open at once.
//     (No enforced single-open; users often want two open to reference.)
//   • Each expanded card renders its own <LegalReadthroughGate>, so
//     scroll gates + reviewed_at capture stay per-document.
//
// reviewed_at flow: the gate's onSigned callback carries { version,
// reviewedAt }. This component re-fires that upward as
// onGateSigned(key, { version, reviewedAt }) so the parent can track
// per-doc state (e.g., tosReviewedAt, privacyReviewedAt, saasReviewedAt).
// Version is also handed back — reserved for cases where the parent
// needs it, though today all callers already pin from legal-versions.ts.
//
// Status pill state:
//   • 'Not read'  — gate not yet unlocked (no reviewedAt yet)
//   • 'Reviewed'  — user scrolled through, unlock fired, but hasn't
//                    clicked Sign yet. Not a status the parent state
//                    exposes directly today (we only latch on Sign) —
//                    reserved for future use if we want to surface
//                    unlock state without commitment.
//   • '✓ Signed'  — parent has a non-null reviewedAt for this key.

import { useState } from 'react'
import LegalReadthroughGate from './LegalReadthroughGate'

const GOLD = '#C9A227'
const CARD_BG = '#161b26'
const BORDER = '#2a2f3d'

export type GateSpec = {
  key: string                     // 'tos' | 'privacy' | 'saas' — stable identifier surfaced in onGateSigned
  title: string                   // 'Terms of Use'
  version: string                 // TOS_VERSION
  displayDate: string             // TOS_DISPLAY_DATE
  body: React.ReactNode           // <TermsBody />
  signButtonLabel?: string        // override the gate's Sign button label
}

export type LegalGateAccordionProps = {
  gates: GateSpec[]
  disabled?: boolean                                                                // parent gate (e.g., attestation checkbox above unchecked)
  signedKeys?: Set<string> | Record<string, boolean> | string[]                     // parent-managed signed state per key; used to render status pill
  onGateSigned: (key: string, info: { version: string; reviewedAt: string }) => void
}

function isSigned(key: string, signedKeys?: LegalGateAccordionProps['signedKeys']): boolean {
  if (!signedKeys) return false
  if (signedKeys instanceof Set) return signedKeys.has(key)
  if (Array.isArray(signedKeys)) return signedKeys.includes(key)
  return signedKeys[key] === true
}

export default function LegalGateAccordion({
  gates,
  disabled = false,
  signedKeys,
  onGateSigned,
}: LegalGateAccordionProps) {
  // Independent expand — Set of open keys. First card starts expanded
  // so the user sees an obvious action on landing; subsequent cards
  // stay collapsed to avoid a wall-of-scroll-panes.
  const [openKeys, setOpenKeys] = useState<Set<string>>(
    () => new Set(gates.length > 0 ? [gates[0].key] : [])
  )

  function toggle(k: string) {
    setOpenKeys(prev => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {gates.map((g) => {
        const isOpen = openKeys.has(g.key)
        const signed = isSigned(g.key, signedKeys)
        const pill = signed
          ? { label: '✓ Signed', bg: 'rgba(34,197,94,0.14)', border: 'rgba(34,197,94,0.45)', color: '#4ade80' }
          : { label: 'Not read', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.30)', color: '#94a3b8' }
        const headerId = `legal-gate-${g.key}-header`
        const panelId = `legal-gate-${g.key}-panel`
        return (
          <section
            key={g.key}
            style={{
              background: CARD_BG,
              border: `1px solid ${BORDER}`,
              borderRadius: 10,
              padding: 16,
            }}
          >
            <button
              type="button"
              id={headerId}
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => toggle(g.key)}
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                color: 'inherit',
                textAlign: 'left',
                fontFamily: 'inherit',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <h3 style={{ color: GOLD, fontSize: 14, fontWeight: 700, margin: 0 }}>{g.title}</h3>
                  <span
                    style={{
                      display: 'inline-block',
                      background: pill.bg,
                      border: `1px solid ${pill.border}`,
                      color: pill.color,
                      fontSize: 10.5,
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      padding: '3px 8px',
                      borderRadius: 999,
                    }}
                  >
                    {pill.label}
                  </span>
                </div>
                <p style={{ color: '#888', fontSize: 11, margin: '4px 0 0' }}>
                  Version {g.version} · {g.displayDate}
                </p>
              </div>
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-block',
                  color: GOLD,
                  fontSize: 14,
                  fontWeight: 700,
                  transition: 'transform 160ms ease',
                  transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                  flexShrink: 0,
                }}
              >
                ▾
              </span>
            </button>

            {isOpen && (
              <div id={panelId} role="region" aria-labelledby={headerId} style={{ marginTop: 4 }}>
                <LegalReadthroughGate
                  title={g.title}
                  version={g.version}
                  displayDate={g.displayDate}
                  body={g.body}
                  disabled={disabled}
                  signButtonLabel={g.signButtonLabel ?? `Sign & Accept ${g.title}`}
                  onSigned={(info) => onGateSigned(g.key, info)}
                />
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

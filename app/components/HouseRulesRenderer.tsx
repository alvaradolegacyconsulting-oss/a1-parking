'use client'
//
// 2026-08-20 house-rules arc — shared renderer for property house
// rules text.
//
// 🔴 THIS COMPONENT IS DELIBERATELY SHARED BY THREE SURFACES. If you
// are considering "simplifying" one of them back into a local render,
// don't — that reintroduces the drift risk this file exists to
// eliminate (Mateo Aug 20). Any change to the render treatment (font
// size, line height, wrap, escape rules, collapse behavior) must
// apply to all three by construction.
//
// Consumers:
//   - app/resident/page.tsx      → full display (metadata + caveat + collapsible)
//   - app/manager/page.tsx       → live Settings preview (text only,
//                                  no metadata, no caveat, no collapse
//                                  — the manager already sees the
//                                  effective-date input + caveat above
//                                  the textarea, and a "wall of text"
//                                  is only a signal if you can see
//                                  the WHOLE wall)
//   - app/company_admin/page.tsx → CA read-only modal (metadata + no
//                                  caveat) — Jose's dispatcher use
//                                  case; version + effective date
//                                  visible for tow-call lookups
//
// 🔴 LOAD-BEARING PROPERTIES — do not remove or bypass
//
//   whitespace: pre-wrap on the text container — the WHOLE formatting
//   story (Mateo Aug 20). HTML collapses newlines by default; with
//   pre-wrap, what the manager types is what the resident reads.
//
//   Plain-text React child — {text} — auto-escapes. NO markdown parse.
//   NO dangerouslySetInnerHTML. Every subscriber post-public_signup_open
//   is a potential author; HTML rendering would be stored-XSS surface.
//
//   If rich formatting is ever genuinely wanted, it's a SEPARATE design
//   with sanitisation — not an incremental tweak here.
//
// If you touch this component, verify ALL THREE consumer sites still
// render correctly.

import { useState } from 'react'
import { formatDate } from '../lib/format-time'

interface Props {
  text: string | null
  // Optional metadata line above the text. Renders when either field
  // is provided; both hidden when both null. Resident view passes both;
  // manager-side preview passes neither.
  effectiveDate?: string | null
  updatedAt?:     string | null
  // Reference-only framing above the metadata. Resident view passes
  // true (they need the "not ShieldMyLot policy" honesty); manager
  // preview passes false (manager is authoring, doesn't need to be
  // told what they wrote is not ShieldMyLot policy).
  showReferenceCaveat?: boolean
  // Long-text ceiling. Resident view collapses at ~15 rendered lines.
  // Manager preview passes false — the manager needs to see the whole
  // thing to know they haven't written a wall of text.
  collapsible?: boolean
  // Optional heading. Renders inside the box above the caveat.
  // Resident view passes 'House Rules'; manager preview may pass a
  // 'Preview' label instead.
  heading?: string
}

export default function HouseRulesRenderer({
  text,
  effectiveDate,
  updatedAt,
  showReferenceCaveat = false,
  collapsible = false,
  heading,
}: Props) {
  const [expanded, setExpanded] = useState(false)

  // Empty text renders nothing at all — the caller decides whether to
  // wrap this in a container. Absence is unambiguous by construction.
  if (!text || text.trim().length === 0) return null

  const isFuture = effectiveDate
    ? effectiveDate > new Date().toISOString().slice(0, 10)
    : false

  // Long-text heuristic — matches the pre-extraction resident render.
  // Client-side only; full text always in the DOM (one tap away).
  const isLong = text.length > 600 || text.split('\n').length > 12
  const collapsed = collapsible && isLong && !expanded

  return (
    <>
      {heading && (
        <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0 0 4px' }}>{heading}</p>
      )}
      {showReferenceCaveat && (
        <p style={{ color:'#555', fontSize:'12px', margin:'0 0 10px', lineHeight:'1.5' }}>
          Published by your property. Not ShieldMyLot policy — the platform doesn&apos;t enforce these rules;
          they&apos;re how the property communicates its expectations to residents.
        </p>
      )}
      {(effectiveDate || updatedAt) && (
        <div style={{ display:'flex', flexWrap:'wrap', gap:'12px', alignItems:'baseline', marginBottom:'10px', fontSize:'11px', color:'#7a8394' }}>
          {effectiveDate && (
            <span>
              {isFuture ? 'Takes effect' : 'Effective'}{' '}
              <strong style={{ color: isFuture ? '#fbbf24' : '#aaa' }}>{formatDate(effectiveDate)}</strong>
            </span>
          )}
          {updatedAt && (
            <span>Updated <span style={{ color:'#aaa' }}>{formatDate(updatedAt)}</span></span>
          )}
        </div>
      )}
      <div style={{ position:'relative' }}>
        <div style={{
          color:'#e5e7eb',
          fontSize:'13.5px',
          lineHeight:'1.6',
          whiteSpace: 'pre-wrap',      // 🔴 THE whole formatting story
          wordBreak: 'break-word',
          maxHeight: collapsed ? '300px' : undefined,
          overflow: collapsed ? 'hidden' : undefined,
          padding: '6px 2px',
        }}>
          {text}
        </div>
        {collapsed && (
          <div style={{
            position:'absolute', left:0, right:0, bottom:0, height:'80px',
            background:'linear-gradient(to bottom, rgba(22,27,38,0), rgba(22,27,38,1))',
            pointerEvents:'none',
          }} />
        )}
      </div>
      {collapsible && isLong && (
        <button
          onClick={() => setExpanded(v => !v)}
          style={{
            marginTop:'8px', padding:'6px 12px',
            background:'transparent', color:'#C9A227',
            border:'1px solid #3a2a00', borderRadius:'6px',
            cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'inherit',
          }}
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}
    </>
  )
}

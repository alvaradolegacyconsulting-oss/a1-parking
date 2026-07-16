'use client'

import { useState } from 'react'

// ════════════════════════════════════════════════════════════════════
// QRLinkAffordance — visible + selectable URL + Copy button
// 2026-07-15 — QR cluster
//
// Sits directly under a <QRCodeCanvas> on the CA portal QR-codes tab
// and the property-detail QR block. Two failure modes closed:
//
//   1. The URL under the QR was previously rendered as tiny #444 text
//      on #161b26 background — near-invisible. Operators couldn't
//      hand-copy the URL to paste into a bulk email or SMS to residents,
//      and couldn't verify it matched what they expected before printing.
//
//   2. No copy affordance. Hand-typing a URL with %20 and long property
//      names is error-prone (miss one character → the whole thing breaks).
//
// One-liner usage:
//   <QRLinkAffordance url={someUrl} />
//
// The Copy button prefers navigator.clipboard.writeText but falls back
// to the textarea+execCommand pattern for older browsers or non-secure
// contexts (some corporate networks strip HTTPS from internal pages).
// ════════════════════════════════════════════════════════════════════

export function QRLinkAffordance({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      return
    } catch {
      // Fall through to legacy fallback (non-secure context or old browser).
    }
    // Legacy fallback: hidden textarea + execCommand('copy'). Not deprecated
    // for THIS use case (clipboard.writeText requires secure context; some
    // CA-portal deployments over corporate proxies land on plain http:).
    const ta = document.createElement('textarea')
    ta.value = url
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Nothing worked — leave the URL selected so the operator can Ctrl-C.
    } finally {
      document.body.removeChild(ta)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 }}>
      <code
        style={{
          flex: 1,
          minWidth: 0,
          wordBreak: 'break-all',
          color: '#e2e8f0',
          background: '#0f1117',
          border: '1px solid #2a2f3d',
          borderRadius: 6,
          padding: '6px 8px',
          fontSize: 11,
          fontFamily: 'Menlo, Consolas, monospace',
          textAlign: 'left',
        }}
      >
        {url}
      </code>
      <button
        onClick={onCopy}
        style={{
          padding: '6px 10px',
          background: copied ? '#2e7d32' : '#1e2535',
          color: copied ? '#fff' : '#C9A227',
          border: `1px solid ${copied ? '#2e7d32' : '#C9A227'}`,
          borderRadius: 6,
          fontSize: 11,
          fontWeight: 'bold',
          cursor: 'pointer',
          fontFamily: 'Arial',
          whiteSpace: 'nowrap',
        }}
      >
        {copied ? 'Copied ✓' : 'Copy link'}
      </button>
    </div>
  )
}

'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

// B118 Layer 2 Commit 3 — <LegalReadthroughGate>.
//
// Previously the SaaS-only readthrough gate: hardcoded body import and
// hardcoded button/helper copy. Generalized in the acceptance-surface
// pass so the same read-through mechanic can gate any legal document
// (SaaS, Terms, Privacy, DPA, ...). The body is now passed in via the
// `body` prop; button label, helper text, and heading are all overridable
// with defaults that preserve the original SaaS-only behavior.
//
// Renders the passed-in legal document body in an inline scrollable pane
// and gates the sign button until the document has been presented in
// full. Triple-OR unlock is a11y-safe (works for mouse-scroll,
// keyboard-Tab, and screen-reader focus):
//
//   sentinelInView    — IntersectionObserver on a bottom sentinel with
//                       root = the scroll pane. Fires for any scroll
//                       modality (mouse wheel, touch drag, page-down,
//                       browser auto-scroll on Tab focus).
//   sentinelFocused   — onFocus handler on the sentinel (tabIndex=0).
//                       Fires for keyboard-only + screen-reader users
//                       who Tab through and land on the sentinel even
//                       if browser doesn't auto-scroll it into view.
//   wheeledPastLast   — onWheel/onScroll handler on the pane. Fires
//                       when scrollTop + clientHeight >= scrollHeight - 4.
//                       Redundant with sentinelInView in most cases;
//                       covers rapid-scroll where IntersectionObserver
//                       callback is throttled by the browser.
//
// SHORT-DOC CASE — sentinel visible on mount (doc fits without
// scrolling) → sentinelInView fires immediately → immediate unlock.
// Correct: "the full document was displayed" is the legal bar.
//
// reviewed_at CAPTURE — stamped once at the moment canSign first
// transitions false → true (any of the three signals firing).
// Stored in state (savedReviewedAt) and never re-set. Passed on sign
// click alongside the caller-supplied version. This is intentional:
// reviewed_at = when they finished reviewing (T1), accepted_at = when
// they clicked sign (T2), and T1 < T2 is the evidence gap.

export type LegalReadthroughGateProps = {
  version: string                                        // SAAS_VERSION (or equivalent) from legal-versions.ts
  displayDate: string                                    // SAAS_DISPLAY_DATE (or equivalent)
  disabled?: boolean                                     // parent gate (e.g., other checkboxes unchecked)
  paneHeight?: number                                    // px; default 560 (bumped 2026-07-09 per attorney readability note)
  onSigned: (info: { version: string, reviewedAt: string }) => void
  // — generalization props (defaults preserve original SaaS-only behavior) —
  title?: string
  body: React.ReactNode
  signButtonLabel?: string
  signedLabel?: string
  scrollHintCopy?: string
  signReadyCopy?: string
  parentDisabledCopy?: string
  acceptedCopy?: string
}

const GOLD = '#C9A227'

export default function LegalReadthroughGate({
  version,
  displayDate,
  disabled = false,
  paneHeight = 560,
  onSigned,
  title = 'SaaS Subscription Agreement',
  body,
  signButtonLabel = 'Sign & Accept SaaS Agreement',
  signedLabel = '✓ Signed',
  scrollHintCopy = 'Scroll to the end of the document to enable the Sign button.',
  signReadyCopy = 'You may now sign to accept.',
  parentDisabledCopy = 'Complete the checkboxes above first, then sign.',
  acceptedCopy = 'Acceptance captured. Continue below.',
}: LegalReadthroughGateProps) {
  const paneRef     = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const [sentinelInView,  setSentinelInView]  = useState(false)
  const [sentinelFocused, setSentinelFocused] = useState(false)
  const [wheeledPastLast, setWheeledPastLast] = useState(false)
  const [savedReviewedAt, setSavedReviewedAt] = useState<string | null>(null)
  const [signed,          setSigned]          = useState(false)

  const canSign = sentinelInView || sentinelFocused || wheeledPastLast

  // Stamp reviewed_at at the moment canSign first transitions false → true.
  // Guard against re-setting so subsequent signal-flips (e.g., re-scroll)
  // don't overwrite the T1 stamp.
  useEffect(() => {
    if (canSign && savedReviewedAt === null) {
      setSavedReviewedAt(new Date().toISOString())
    }
  }, [canSign, savedReviewedAt])

  // ── sentinelInView via IntersectionObserver ──────────────────────
  useEffect(() => {
    const sentinel = sentinelRef.current
    const pane = paneRef.current
    if (!sentinel || !pane) return
    const observer = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting) setSentinelInView(true)
        }
      },
      { root: pane, threshold: 0.1 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])

  // ── wheeledPastLast via scroll handler on the pane ───────────────
  const onScroll = useCallback(() => {
    const pane = paneRef.current
    if (!pane) return
    if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4) {
      setWheeledPastLast(true)
    }
  }, [])

  const handleSign = () => {
    if (!canSign || disabled || signed) return
    const reviewedAt = savedReviewedAt ?? new Date().toISOString()
    setSigned(true)
    onSigned({ version, reviewedAt })
  }

  return (
    <section aria-labelledby="saas-gate-heading"
      style={{ background:'#161b26', border:`1px solid ${GOLD}`, borderRadius:'10px', padding:'16px', marginTop:'14px' }}>

      <h2 id="saas-gate-heading" style={{ color: GOLD, fontSize:'14px', fontWeight:'bold', margin:'0 0 4px' }}>
        {title}
      </h2>
      <p style={{ color:'#888', fontSize:'11px', margin:'0 0 6px' }}>
        Version {version} · {displayDate}
      </p>
      <div style={{ background:'#2a1f0a', border:'1px solid #a16207', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}>
        <p style={{ color:'#fbbf24', fontSize:'11px', margin:0, lineHeight:1.5 }}>
          Draft placeholder — not for execution. Read through, then sign to accept.
        </p>
      </div>

      <div
        ref={paneRef}
        onScroll={onScroll}
        onWheel={onScroll}
        role="region"
        aria-label="SaaS Subscription Agreement — scroll to read the full document"
        tabIndex={0}
        style={{
          background:'#0f1117',
          border:'1px solid #2a2f3d',
          borderRadius:'8px',
          padding:'16px 18px',
          // Attorney readability fix (2026-07-09) — was 320px @ 13px/1.7.
          // maxHeight uses min(paneHeight, 70vh) so tall panes don't
          // overflow small viewports on mobile. IntersectionObserver
          // + scroll-to-bottom detection are dimension-live (both
          // derive from the pane's own scrollHeight/clientHeight at
          // event time), so resize doesn't regress the unlock gate.
          maxHeight: `min(${paneHeight}px, 70vh)`,
          overflowY:'auto',
          fontSize:'14.5px',
          lineHeight:'1.75',
        }}>
        {body}
        <div
          ref={sentinelRef}
          tabIndex={0}
          onFocus={() => setSentinelFocused(true)}
          aria-label="End of document"
          style={{
            marginTop:'20px',
            padding:'10px',
            background:'#1a1500',
            border:`1px dashed ${GOLD}`,
            borderRadius:'6px',
            color: GOLD,
            fontSize:'12px',
            textAlign:'center',
          }}>
          — End of document —
        </div>
      </div>

      <div style={{ marginTop:'12px', display:'flex', alignItems:'center', gap:'12px', flexWrap:'wrap' }}>
        <button
          type="button"
          onClick={handleSign}
          disabled={!canSign || disabled || signed}
          aria-disabled={!canSign || disabled || signed}
          style={{
            padding:'10px 18px',
            background: !canSign || disabled ? '#3a4055' : (signed ? '#1a3a1a' : GOLD),
            color:      !canSign || disabled ? '#888'    : (signed ? '#4caf50' : '#0a0d14'),
            border:'none',
            borderRadius:'8px',
            cursor: (!canSign || disabled || signed) ? 'not-allowed' : 'pointer',
            fontSize:'13px',
            fontWeight:700,
          }}>
          {signed ? signedLabel : signButtonLabel}
        </button>
        <p style={{ color:'#888', fontSize:'11.5px', margin:0 }}>
          {signed
            ? acceptedCopy
            : canSign
              ? (disabled
                  ? parentDisabledCopy
                  : signReadyCopy)
              : scrollHintCopy}
        </p>
      </div>
    </section>
  )
}

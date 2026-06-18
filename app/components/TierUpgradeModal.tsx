'use client'
// B165 — forced-upgrade modal.
//
// Surfaces at cap-hit moments in the CA portal (Add Property / Reactivate
// Property / Add Driver / Reactivate Driver). When the resource the
// customer is trying to add would exceed their tier limit, this modal
// prompts the upgrade to the next within-track tier so they can
// continue. Single canonical cap-hit-to-upgrade flow.
//
// Lifecycle:
//   1. Mount — calls /api/billing/preview-tier-change for live numbers
//   2. Preview success → renders "Upgrade to <tier>: $X prorated today,
//      then $Y/mo starting <date>. [Upgrade & continue] [Cancel]"
//   3. Preview refused (proposal_code / Premium / track_switch / etc.)
//      → renders refusal copy + Contact support button + Cancel
//   4. Preview Stripe failure → renders "Final amount calculated at
//      checkout" + Confirm button (per refinement B: real number or no
//      number; never an estimated wrong one)
//   5. User confirms → calls /api/billing/change-tier
//   6. change-tier success → onSuccess() (parent retries the original
//      add action; feature gates re-read tier from getCompanyContext)
//   7. change-tier refusal (one of the same reasons or a Stripe partial)
//      → renders the partial-failure copy ("Contact support; don't
//      retry") for the post-mutation cases

import { useEffect, useState } from 'react'

const GOLD = '#C9A227'

export type TierUpgradeContext = {
  companyId: number
  currentTier: string                       // e.g. 'starter', 'growth'
  targetTier: string                        // next within-track tier
  targetTrack: 'enforcement' | 'property_management'
  triggerReason: string                     // e.g. "You're at the 3-property limit"
}

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'ready'; proratedToday: number; newPeriodTotal: number; currency: string; periodEnd: number }
  | { kind: 'refused'; reason: string; detail?: string }
  | { kind: 'preview_failed'; detail?: string }

type ConfirmState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'succeeded' }
  | { kind: 'refused_post_mutation'; reason: string; detail?: string }
  | { kind: 'partial_swap_critical'; detail: string }

function tierLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase()
}

function trackLabel(track: string): string {
  return track === 'enforcement' ? 'Enforcement' : 'Property Management'
}

function fmtMoney(cents: number, currency: string): string {
  const dollars = cents / 100
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(dollars)
  } catch {
    return `$${dollars.toFixed(2)}`
  }
}

function fmtDate(unixSeconds: number): string {
  if (!unixSeconds) return 'next billing date'
  try {
    return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return 'next billing date'
  }
}

// Refusal copy — keyed by the TierChangeRefusalReason enum the helper
// returns. Each entry is the user-facing message + whether a Contact
// support CTA is appropriate. Premium + proposal_code are explicit
// contact-sales paths; track_switch + not_an_upgrade are explainers.
function refusalCopy(reason: string): { title: string; body: string; contactSupport: boolean } {
  switch (reason) {
    case 'proposal_code_attached':
      return {
        title: 'Custom pricing arrangement',
        body: "Your account is on a custom pricing arrangement. Please contact support to expand your limits or change tier — self-serve upgrade isn't available for custom plans.",
        contactSupport: true,
      }
    case 'premium_target':
      return {
        title: 'Premium is contact-sales',
        body: 'Premium tier is set up through our team. Please reach out and we’ll walk through what makes sense for your operation.',
        contactSupport: true,
      }
    case 'track_switch_refused':
      return {
        title: 'Track change not available here',
        body: "You can't change between Enforcement and Property Management tracks through this flow. If you need a different track, please contact support.",
        contactSupport: true,
      }
    case 'not_an_upgrade':
      return {
        title: 'Already at this tier or higher',
        body: "You're already on this tier or one above it. Downgrades aren't available self-serve — please contact support if you'd like to change.",
        contactSupport: true,
      }
    case 'manual_collection':
      return {
        title: 'Manual billing in place',
        body: "Your account is on manual billing (we send invoices directly). Self-serve upgrade isn't available — please contact support to change tier.",
        contactSupport: true,
      }
    case 'no_subscription':
      return {
        title: 'No active subscription',
        body: "We couldn't find an active subscription for your account. Please contact support and we'll get it sorted.",
        contactSupport: true,
      }
    case 'company_tier_drift':
      return {
        title: 'Account needs reconciliation',
        body: "Your account state doesn't match your live subscription. Please contact support — a quick reconciliation will let you upgrade.",
        contactSupport: true,
      }
    case 'target_tier_unknown':
    case 'cycle_unknown':
    case 'snapshot_failed':
    default:
      return {
        title: 'Upgrade unavailable right now',
        body: 'We hit a snag preparing your upgrade. Please contact support and we’ll handle it directly.',
        contactSupport: true,
      }
  }
}

export function TierUpgradeModal({
  ctx,
  onClose,
  onSuccess,
}: {
  ctx: TierUpgradeContext
  onClose: () => void
  onSuccess: () => void
}) {
  const [preview, setPreview] = useState<PreviewState>({ kind: 'loading' })
  const [confirm, setConfirm] = useState<ConfirmState>({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/billing/preview-tier-change', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company_id: ctx.companyId,
            target_tier: ctx.targetTier,
            target_track: ctx.targetTrack,
          }),
        })
        const json = await res.json()
        if (cancelled) return
        if (json.ok) {
          setPreview({
            kind: 'ready',
            proratedToday: json.prorated_today,
            newPeriodTotal: json.new_period_total,
            currency: json.currency,
            periodEnd: json.period_end,
          })
        } else if (json.reason) {
          // Server-side refusal returned from the helper. The reason maps
          // to user-facing copy via refusalCopy.
          const knownRefusals = ['proposal_code_attached', 'premium_target', 'track_switch_refused', 'not_an_upgrade', 'manual_collection', 'no_subscription', 'company_tier_drift', 'target_tier_unknown', 'cycle_unknown']
          if (knownRefusals.includes(json.reason)) {
            setPreview({ kind: 'refused', reason: json.reason, detail: json.detail })
          } else {
            // snapshot_failed / unknown → treat as preview_failed (per
            // refinement B: real number or no number). Customer can still
            // confirm; final amount surfaces at the Stripe-side mutation.
            setPreview({ kind: 'preview_failed', detail: json.detail })
          }
        } else {
          // HTTP error from route layer (401/403/400/500). Treat as
          // refusal with generic copy — customer shouldn't see internal
          // detail.
          setPreview({ kind: 'refused', reason: 'snapshot_failed' })
        }
      } catch (e) {
        if (cancelled) return
        setPreview({ kind: 'preview_failed', detail: (e as Error).message })
      }
    }
    load()
    return () => { cancelled = true }
  }, [ctx.companyId, ctx.targetTier, ctx.targetTrack])

  async function handleConfirm() {
    setConfirm({ kind: 'submitting' })
    try {
      const res = await fetch('/api/billing/change-tier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: ctx.companyId,
          target_tier: ctx.targetTier,
          target_track: ctx.targetTrack,
        }),
      })
      const json = await res.json()
      if (json.ok) {
        setConfirm({ kind: 'succeeded' })
        // Brief success state, then call parent. Parent re-reads tier
        // from getCompanyContext + retries the original add action.
        setTimeout(() => onSuccess(), 600)
        return
      }
      // ok:false from helper. If detail mentions partial-swap, surface
      // the critical "contact support; don't retry" copy. Otherwise
      // map reason to standard refusal copy.
      const detail = String(json.detail ?? '')
      if (detail.includes('partial-swap-CRITICAL') || detail.includes('Stripe upgrade applied successfully but DB write failed')) {
        setConfirm({ kind: 'partial_swap_critical', detail })
      } else {
        setConfirm({ kind: 'refused_post_mutation', reason: json.reason ?? 'snapshot_failed', detail: json.detail })
      }
    } catch (e) {
      setConfirm({ kind: 'refused_post_mutation', reason: 'snapshot_failed', detail: (e as Error).message })
    }
  }

  const overlay: React.CSSProperties = {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000, padding: 20,
  }
  const panel: React.CSSProperties = {
    background: '#0f1117', border: `1px solid ${GOLD}`, borderRadius: 12,
    maxWidth: 480, width: '100%', padding: 28, color: '#e2e8f0', fontFamily: 'system-ui, Arial',
  }
  const goldBtn: React.CSSProperties = {
    background: GOLD, color: '#0a0d14', fontWeight: 'bold',
    padding: '12px 18px', border: 'none', borderRadius: 8,
    cursor: 'pointer', fontSize: 14,
  }
  const ghostBtn: React.CSSProperties = {
    background: 'transparent', color: '#94a3b8', border: '1px solid #2a2f3d',
    padding: '12px 18px', borderRadius: 8, cursor: 'pointer', fontSize: 14,
  }

  // ── Render: PARTIAL-SWAP CRITICAL (highest priority) ────────────
  if (confirm.kind === 'partial_swap_critical') {
    return (
      <div style={overlay}>
        <div style={panel}>
          <h2 style={{ color: GOLD, fontSize: 18, margin: '0 0 12px' }}>⚠ Subscription updated</h2>
          <p style={{ color: '#e2e8f0', fontSize: 14, lineHeight: 1.6, margin: '0 0 12px' }}>
            Your billing has been updated, but your account hasn’t refreshed yet.
            Please <strong>contact support</strong> with your company name and the time of this message —
            do not retry the upgrade.
          </p>
          <p style={{ color: '#64748b', fontSize: 12, lineHeight: 1.5, margin: '0 0 20px' }}>
            Our team can see exactly what happened on our side and will get your account back in sync quickly.
            Your billing is already at the new rate, so there’s no need to do anything else.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <a href="mailto:support@shieldmylot.com?subject=Upgrade%20partial%20completion" style={{ ...goldBtn, textDecoration: 'none', display: 'inline-block' }}>Contact support</a>
            <button onClick={onClose} style={ghostBtn}>Close</button>
          </div>
        </div>
      </div>
    )
  }

  // ── Render: post-mutation refusal (Stripe-failed-during-changeTier) ─
  if (confirm.kind === 'refused_post_mutation') {
    const copy = refusalCopy(confirm.reason)
    return (
      <div style={overlay}>
        <div style={panel}>
          <h2 style={{ color: GOLD, fontSize: 18, margin: '0 0 12px' }}>{copy.title}</h2>
          <p style={{ color: '#e2e8f0', fontSize: 14, lineHeight: 1.6, margin: '0 0 20px' }}>{copy.body}</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            {copy.contactSupport && (
              <a href="mailto:support@shieldmylot.com?subject=Upgrade%20help" style={{ ...goldBtn, textDecoration: 'none', display: 'inline-block' }}>Contact support</a>
            )}
            <button onClick={onClose} style={ghostBtn}>Close</button>
          </div>
        </div>
      </div>
    )
  }

  // ── Render: success (brief, then onSuccess fires) ───────────────
  if (confirm.kind === 'succeeded') {
    return (
      <div style={overlay}>
        <div style={panel}>
          <h2 style={{ color: '#4caf50', fontSize: 18, margin: '0 0 12px' }}>✓ Upgrade applied</h2>
          <p style={{ color: '#e2e8f0', fontSize: 14, lineHeight: 1.6, margin: 0 }}>
            You’re now on the {trackLabel(ctx.targetTrack)} {tierLabel(ctx.targetTier)} tier. Returning to your add flow…
          </p>
        </div>
      </div>
    )
  }

  // ── Render: pre-mutation refusal (preview gate failed) ──────────
  if (preview.kind === 'refused') {
    const copy = refusalCopy(preview.reason)
    return (
      <div style={overlay}>
        <div style={panel}>
          <h2 style={{ color: GOLD, fontSize: 18, margin: '0 0 12px' }}>{copy.title}</h2>
          <p style={{ color: '#e2e8f0', fontSize: 14, lineHeight: 1.6, margin: '0 0 20px' }}>{copy.body}</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            {copy.contactSupport && (
              <a href={`mailto:support@shieldmylot.com?subject=Tier%20upgrade%20-%20${encodeURIComponent(copy.title)}`} style={{ ...goldBtn, textDecoration: 'none', display: 'inline-block' }}>Contact support</a>
            )}
            <button onClick={onClose} style={ghostBtn}>Close</button>
          </div>
        </div>
      </div>
    )
  }

  // ── Render: loading ─────────────────────────────────────────────
  if (preview.kind === 'loading') {
    return (
      <div style={overlay}>
        <div style={panel}>
          <h2 style={{ color: GOLD, fontSize: 18, margin: '0 0 12px' }}>Preparing your upgrade…</h2>
          <p style={{ color: '#94a3b8', fontSize: 13, margin: 0 }}>{ctx.triggerReason}</p>
        </div>
      </div>
    )
  }

  // ── Render: preview-failed but confirm is still possible ────────
  // Per refinement B: real number or no number. Show "final amount
  // calculated at checkout" copy + allow confirm. The Stripe-side
  // mutation will surface its own error if it fails.
  const headerText = `Upgrade to ${trackLabel(ctx.targetTrack)} ${tierLabel(ctx.targetTier)}`

  if (preview.kind === 'preview_failed') {
    return (
      <div style={overlay}>
        <div style={panel}>
          <h2 style={{ color: GOLD, fontSize: 18, margin: '0 0 6px' }}>{headerText}</h2>
          <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 18px' }}>{ctx.triggerReason}</p>
          <div style={{ background: 'rgba(255,193,7,0.08)', border: '1px solid rgba(255,193,7,0.35)', borderRadius: 8, padding: 14, marginBottom: 18 }}>
            <p style={{ color: '#ffc107', fontSize: 13, margin: 0, lineHeight: 1.5 }}>
              We couldn’t fetch the exact prorated amount right now. Your final amount will be calculated at the moment of upgrade and shown on your next invoice. You can proceed, or cancel and try again later.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={onClose} disabled={confirm.kind === 'submitting'} style={ghostBtn}>Cancel</button>
            <button onClick={handleConfirm} disabled={confirm.kind === 'submitting'} style={goldBtn}>
              {confirm.kind === 'submitting' ? 'Applying…' : 'Upgrade & continue'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Render: preview READY (the standard happy path) ─────────────
  const { proratedToday, newPeriodTotal, currency, periodEnd } = preview
  return (
    <div style={overlay}>
      <div style={panel}>
        <h2 style={{ color: GOLD, fontSize: 18, margin: '0 0 6px' }}>{headerText}</h2>
        <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 20px' }}>{ctx.triggerReason}</p>

        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: 18, marginBottom: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ color: '#94a3b8', fontSize: 13 }}>Prorated today</span>
            <span style={{ color: '#e2e8f0', fontWeight: 'bold', fontSize: 15 }}>{fmtMoney(proratedToday, currency)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#94a3b8', fontSize: 13 }}>Then per period (incl. tax)</span>
            <span style={{ color: '#e2e8f0', fontWeight: 'bold', fontSize: 15 }}>{fmtMoney(newPeriodTotal, currency)}</span>
          </div>
          <p style={{ color: '#64748b', fontSize: 11, margin: '12px 0 0' }}>
            Starting {fmtDate(periodEnd)}. Proration covers the time remaining in your current period.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={confirm.kind === 'submitting'} style={ghostBtn}>Cancel</button>
          <button onClick={handleConfirm} disabled={confirm.kind === 'submitting'} style={goldBtn}>
            {confirm.kind === 'submitting' ? 'Applying…' : 'Upgrade & continue'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Helper for callers — given current tier + track, return the next
// within-track tier (or null if already at top). Used at the cap-hit
// sites to pre-fill ctx.targetTier when opening the modal.
export function nextWithinTrackTier(currentTier: string, track: 'enforcement' | 'property_management'): string | null {
  const order = track === 'enforcement'
    ? ['starter', 'growth', 'legacy']
    : ['essential', 'professional', 'enterprise']
  const idx = order.indexOf(currentTier.toLowerCase())
  if (idx === -1 || idx >= order.length - 1) return null
  return order[idx + 1]
}

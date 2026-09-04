// ══════════════════════════════════════════════════════════════════════
// _tmp_alert_probe — Sept 4 2026 THROWAWAY
//
// Answers: does the provisioning-failure alert email actually reach
// a human inbox? The failure branch at
// app/lib/stripe-event-handlers/checkout-session-completed.ts:639
// sends an alert via sendEmail() from resend-client. That code has
// never fired in anger (no real provisioning failures have occurred),
// so the notification path is correct-in-review + unobserved-in-
// practice.
//
// This route calls THE EXACT SAME send function with a synthetic
// payload, so environmental failure modes (recipient env var,
// sending-domain verification, spam classification, unmonitored
// inbox) are exercised. A reimplementation would test a copy.
//
// ── SAFETY ──────────────────────────────────────────────────────────
// • ?key= guard against process.env.PROVISIONING_ALERT_PROBE_KEY
//   (new env var Jose sets in Vercel before deploy, removes after).
//   Returns 403 if missing or mismatched.
// • Does NOT write to provisioning_failures — send-only probe. A
//   synthetic row in a production table nobody reads would pollute
//   the future admin surface. failRowId=null in the payload.
// • Subject prefixed with [PROBE] so Jose isn't paged at 1am if
//   Resend delivery is delayed. Every other part of the message —
//   sender, template, body content shape — stays IDENTICAL to the
//   real alert so the test exercises the real path.
// • Response returns the provider result (message_id, ok/error) so
//   the caller learns whether Resend accepted the payload. Also
//   returns the resolved recipient + whether PROVISIONING_ALERT_EMAIL
//   env var is set — one call answers three questions.
//
// ── RUN ─────────────────────────────────────────────────────────────
// After Jose sets PROVISIONING_ALERT_PROBE_KEY in Vercel Production
// (+ redeploy):
//   curl -s 'https://www.shieldmylot.com/api/_tmp_alert_probe?key=<value>'
// Expected: JSON with ok=true, message_id, recipient, env_var_set.
// Then Jose verifies inbox delivery (item 2 of the 3-thing test; API
// response cannot tell you it arrived, only that it was accepted).
//
// ── REVERT ─────────────────────────────────────────────────────────
// SAME DAY. Two commits total: one adding this route + the middleware
// publicPaths entry + scripts/_tmp_percent_email_probe.ts, one
// reverting all three. Jose removes PROVISIONING_ALERT_PROBE_KEY.
// ══════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { sendEmail } from '../../lib/resend-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Duplicate the real alert-body helper's input shape rather than
// exporting the helper from checkout-session-completed.ts (that file
// isn't structured for external import + we don't want the probe
// coupled to production imports that might change).
//
// Inline a minimal body that MIRRORS the shape of the real template
// so a reader would recognize it. Full template rendering isn't
// necessary — the goal is exercising the send path, not proving the
// React Email template compiles (it already does in production sends
// from every existing alert code path).
function buildProbeBody(): { html: string, text: string } {
  const now = new Date().toISOString()
  const html = `<div style="font-family: system-ui, sans-serif; padding: 20px; color: #0f172a;">
  <h2 style="color: #b91c1c;">[PROBE] Provisioning-failure alert path test</h2>
  <p><strong>This is a synthetic payload.</strong> No real provisioning failure occurred. A customer has NOT paid + failed to be provisioned.</p>
  <p>The purpose of this email is to verify the alert-delivery path (Resend → recipient inbox) is wired correctly, before anyone actually pays and doesn't get an account.</p>
  <hr />
  <p style="color: #64748b; font-size: 12px;">
    <strong>Probe timestamp:</strong> ${now}<br />
    <strong>Route:</strong> /api/_tmp_alert_probe<br />
    <strong>Purpose:</strong> Answer three questions with one call: (1) does the send function work, (2) where does the alert go, (3) is that recipient deliberate or a fallback.<br />
    <strong>Action required:</strong> confirm this email arrived in the inbox (not spam / not promotions), then reply to Mateo. Revert commit removing this route ships same day.
  </p>
</div>`
  const text = `[PROBE] Provisioning-failure alert path test

This is a synthetic payload. No real provisioning failure occurred.

The purpose of this email is to verify the alert-delivery path (Resend
-> recipient inbox) is wired correctly, before anyone actually pays and
doesn't get an account.

Probe timestamp: ${now}
Route: /api/_tmp_alert_probe
Purpose: Answer three questions with one call: (1) does the send function
work, (2) where does the alert go, (3) is that recipient deliberate or a
fallback.

Action required: confirm this email arrived in the inbox (not spam / not
promotions), then reply to Mateo. Revert commit removing this route ships
same day.`
  return { html, text }
}

export async function GET(req: NextRequest) {
  const guardKey = process.env.PROVISIONING_ALERT_PROBE_KEY
  if (!guardKey) {
    return NextResponse.json(
      { ok: false, error: 'PROVISIONING_ALERT_PROBE_KEY env var not set — probe is disarmed' },
      { status: 403 }
    )
  }
  const providedKey = req.nextUrl.searchParams.get('key')
  if (providedKey !== guardKey) {
    // Constant-length response body regardless of match/mismatch to
    // avoid trivial timing hints. Not a security-critical route but
    // discipline is cheap.
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })
  }

  // Match the real alert-address resolution EXACTLY — this is the
  // whole point of the probe (proving the fallback doesn't fire when
  // we think it doesn't, and that the intended env var is set).
  const alertTo = process.env.PROVISIONING_ALERT_EMAIL || 'support@shieldmylot.com'
  const envVarSet = Boolean(process.env.PROVISIONING_ALERT_EMAIL)

  const body = buildProbeBody()
  const subject = `[PROBE][ShieldMyLot] Provisioning failure — customer paid, no account (probe-${new Date().toISOString().slice(0, 10)})`

  const sendResult = await sendEmail({
    to:      alertTo,
    subject,
    html:    body.html,
    text:    body.text,
  })

  return NextResponse.json({
    ok: sendResult.ok,
    message_id: sendResult.ok ? sendResult.message_id : null,
    error: sendResult.ok ? null : sendResult.error,
    recipient: alertTo,
    env_var_set: envVarSet,
    subject,
    note: 'Provider ok does NOT prove inbox delivery. Manually verify the message arrived in the inbox (not spam / not promotions).',
  })
}

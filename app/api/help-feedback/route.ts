// B85: thumbs-feedback endpoint. PURE NO-OP STUB for v1 per locked decision.
// Console-logs the payload only. TODO: wire to audit_logs or a help_feedback
// table when Jose explicitly greenlights — gated, not blanket-enabled.
// Middleware allowlists /api/help-feedback so anon callers reach this without
// a 302-to-login (same pattern as the rest of the /help subtree).

import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    // eslint-disable-next-line no-console
    console.log('[help-feedback stub]', { ts: new Date().toISOString(), body })
  } catch {
    // Silent — stub should never fail loudly to callers.
  }
  return NextResponse.json({ ok: true })
}

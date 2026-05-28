import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { sendEmail } from '../../../lib/resend-client'

// B66.5 commit 4.1 — Standalone Resend smoke endpoint.
//
// Lives at /api/smoke/resend-test. The /api/smoke/ namespace is reserved
// for throwaway test infrastructure that proves a new dependency works
// end-to-end before production code depends on it. NOT for ad-hoc dev
// utilities (which would be /api/dev/ if we ever add that namespace).
//
// DELETE this file after smoke verification in commit 4.2. Do not
// productionize; exists only to prove SDK + env var wiring before
// depending on Resend in cron + webhook handlers (per the locked May 27
// decision: "standalone smoke MUST run before depending on Resend in
// cron/handler code; sequencing matters").
//
// Naming note: originally drafted as /api/_dev/resend-test; renamed
// to /api/smoke/ because Next.js treats _-prefixed folders as private
// (non-routable) per the project-structure convention. See
// [[feedback-next-private-folder-routing-convention]] for the lesson.
//
// Auth: reuses CRON_SECRET Bearer pattern from /api/cron/dunning. Same
// fail-secure posture: missing or wrong header → 401. Avoids introducing
// a new auth surface for a throwaway endpoint.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  console.log('[resend-smoke] inbound request received')

  const result = await sendEmail({
    to: 'alvaradolegacyconsulting@gmail.com',
    from: 'noreply@mail.shieldmylot.com',
    subject: '[smoke] Resend SDK verification',
    html: '<p>Standalone smoke test for B66.5 commit 4.1. SDK + env var + DNS pipe all working end-to-end.</p>',
  })

  const timestamp = new Date().toISOString()

  if (!result.ok) {
    console.error('[resend-smoke] send failed', { error: result.error })
    return NextResponse.json({ ok: false, error: result.error, timestamp }, { status: 500 })
  }

  console.log('[resend-smoke] send ok', { message_id: result.message_id })
  return NextResponse.json({ ok: true, message_id: result.message_id, timestamp })
}

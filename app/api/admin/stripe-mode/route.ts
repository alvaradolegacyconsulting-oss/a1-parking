import { NextResponse } from 'next/server'
import { requireAdmin } from '../../../lib/server-auth'
import { getStripeMode } from '../../../lib/stripe'

// B66.2b commit 2 — admin-only read of STRIPE_MODE for the issue-time
// mode banner on /admin/proposal-codes/[code]. STRIPE_MODE is a server
// env var, so the value must be fetched via API rather than read at
// build time. Banner color/copy on the client changes when this flips
// from 'test' to 'live' — deliberate friction point against accidental
// live-mode issuance (pre-flight ask 15).

export const runtime = 'nodejs'

export async function GET() {
  const auth = await requireAdmin()
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const mode = getStripeMode()
    return NextResponse.json({ mode })
  } catch (e) {
    return NextResponse.json(
      { error: 'STRIPE_MODE not configured: ' + (e as Error).message },
      { status: 503 }
    )
  }
}

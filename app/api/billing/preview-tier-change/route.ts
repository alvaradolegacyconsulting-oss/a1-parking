import 'server-only'
import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { previewTierChange } from '../../../lib/stripe-mutations'
import { resolveCompanyByName } from '../../../lib/company-resolve'

// B165 — server-only proxy for previewTierChange.
//
// Same auth + authz pattern as /api/billing/change-tier and
// /api/billing/sync-on-add. Honest-or-nothing — if Stripe's preview-
// invoice call fails, the helper returns ok:false and the modal renders
// "final amount calculated at checkout" or blocks the confirm. Never
// returns an estimated/wrong number.

const ALLOWED_TARGETS = new Set([
  'starter', 'growth', 'legacy',
  'essential', 'professional', 'enterprise',
  'premium',
])
const ALLOWED_TRACKS = new Set(['enforcement', 'property_management'])

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const supabaseUser = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await supabaseUser.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }
  const callerEmail = (user.email ?? '').toLowerCase().trim()
  if (!callerEmail) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  let body: { company_id?: number; target_tier?: string; target_track?: string } = {}
  try { body = await request.json() } catch { /* empty body → 400 below */ }
  const companyId = body.company_id
  const targetTier = (body.target_tier ?? '').toLowerCase().trim()
  const targetTrack = (body.target_track ?? '').toLowerCase().trim()
  if (!Number.isInteger(companyId) || !ALLOWED_TARGETS.has(targetTier) || !ALLOWED_TRACKS.has(targetTrack)) {
    return NextResponse.json(
      { error: 'company_id (integer), target_tier (in catalog), target_track (enforcement|property_management) required' },
      { status: 400 }
    )
  }

  const supabase = createSupabaseServiceClient()
  const { data: callerRoles, error: rolesErr } = await supabase
    .from('user_roles')
    .select('role, company')
    .eq('email', callerEmail)
  if (rolesErr) {
    console.error('[B165-preview-tier-roles-error]', { callerEmail, error: rolesErr.message })
    return NextResponse.json({ error: 'authorization lookup failed' }, { status: 500 })
  }
  const caRoles = (callerRoles ?? []).filter(r => r.role === 'company_admin')
  if (caRoles.length === 0) {
    return NextResponse.json({ error: 'caller is not company_admin of any company' }, { status: 403 })
  }

  let authorized = false
  for (const ca of caRoles) {
    const resolved = await resolveCompanyByName(supabase, ca.company as string | null)
    if (!resolved.ok) continue
    if (Number(resolved.company.id) === companyId) {
      authorized = true
      break
    }
  }
  if (!authorized) {
    return NextResponse.json({ error: 'caller is not company_admin of this company' }, { status: 403 })
  }

  const result = await previewTierChange(
    companyId!,
    targetTier,
    targetTrack as 'enforcement' | 'property_management',
  )
  if (result.ok) {
    return NextResponse.json({
      ok: true,
      prorated_today: result.proratedToday,
      new_period_total: result.newPeriodTotal,
      currency: result.currency,
      period_end: result.periodEnd,
    })
  }
  return NextResponse.json({ ok: false, reason: result.reason, detail: result.detail })
}

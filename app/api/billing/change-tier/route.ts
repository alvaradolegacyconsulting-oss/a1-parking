import 'server-only'
import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { changeTier } from '../../../lib/stripe-mutations'
import { resolveCompanyByName } from '../../../lib/company-resolve'

// B165 — server-only proxy for changeTier (forced upgrade).
//
// Mirrors /api/billing/sync-on-add's auth + authz pattern: cookie-bound
// supabase client → auth.getUser() → 401 if missing; caller's CA role
// resolved via resolveCompanyByName → 403 if not CA of company_id.
// Helper is non-throwing; returns { ok: true | false } with discriminator
// so the modal renders the right state from the result body, not HTTP.
//
// FAILURE SHAPE — all returns are HTTP-coded:
//   401 unauthenticated
//   400 bad request (body validation)
//   403 forbidden (auth ok but not CA of company_id)
//   500 authorization-lookup-failed (DB error during gate)
//   200 with { ok: true, swaps } — Stripe swaps applied + DB updated
//   200 with { ok: false, reason, detail? } — refusal (per the
//        TierChangeRefusalReason enum) OR a Stripe failure that left
//        state inconsistent. UI maps `reason` to user-facing copy.

const ALLOWED_TARGETS = new Set([
  'starter', 'growth', 'legacy',
  'essential', 'professional', 'enterprise',
  'premium',  // included so the helper can return 'premium_target' refusal
])
const ALLOWED_TRACKS = new Set(['enforcement', 'property_management'])

export const runtime = 'nodejs'

export async function POST(request: Request) {
  // ── Auth ────────────────────────────────────────────────────────
  const supabaseUser = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await supabaseUser.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }
  const callerEmail = (user.email ?? '').toLowerCase().trim()
  if (!callerEmail) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  // ── Body parse ──────────────────────────────────────────────────
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

  // ── Authorization: caller is company_admin of company_id ─────────
  const supabase = createSupabaseServiceClient()
  const { data: callerRoles, error: rolesErr } = await supabase
    .from('user_roles')
    .select('role, company')
    .eq('email', callerEmail)
  if (rolesErr) {
    console.error('[B165-change-tier-roles-error]', { callerEmail, error: rolesErr.message })
    return NextResponse.json({ error: 'authorization lookup failed' }, { status: 500 })
  }
  const caRoles = (callerRoles ?? []).filter(r => r.role === 'company_admin')
  if (caRoles.length === 0) {
    return NextResponse.json({ error: 'caller is not company_admin of any company' }, { status: 403 })
  }

  let authorized = false
  for (const ca of caRoles) {
    const resolved = await resolveCompanyByName(supabase, ca.company as string | null)
    if (!resolved.ok) {
      console.warn('[B165-change-tier-resolve-skip]', {
        callerEmail, caCompany: ca.company, resolveReason: resolved.reason,
      })
      continue
    }
    if (Number(resolved.company.id) === companyId) {
      authorized = true
      break
    }
  }
  if (!authorized) {
    return NextResponse.json({ error: 'caller is not company_admin of this company' }, { status: 403 })
  }

  // ── Call helper server-side ─────────────────────────────────────
  const result = await changeTier(
    companyId!,
    targetTier,
    targetTrack as 'enforcement' | 'property_management',
  )
  if (result.ok) {
    return NextResponse.json({ ok: true, swaps: result.swaps })
  }
  return NextResponse.json({ ok: false, reason: result.reason, detail: result.detail })
}

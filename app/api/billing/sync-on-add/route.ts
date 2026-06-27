import 'server-only'
import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { syncOnAdd } from '../../../lib/stripe-mutations'
import { resolveCompanyByName } from '../../../lib/company-resolve'

// B147 3b.1 — server-only proxy for syncOnAdd.
//
// Why this route exists: app/lib/stripe-mutations.ts is server-only
// (createSupabaseServiceClient + Stripe SDK + STRIPE_*_SECRET_KEY).
// COMMIT 3b initially imported it directly from app/company_admin/page.tsx
// (a 'use client' component) — Next.js build failed at RSC compilation
// via the 'server-only' marker, AND it would have been a security
// boundary violation if it had bundled (service-role key in client
// bundle). This route is the bridge.
//
// AUTH: cookie-bound supabase client → auth.getUser() → 401 if missing.
//
// AUTHORIZATION (load-bearing): caller must be company_admin of the
// target company_id. Without this, any authenticated user (driver,
// manager, resident, attacker who signed up at /signup) could POST any
// company_id and trigger Stripe mutations on someone else's
// subscription.
//
// Gate shape (sibling to start-billing's auth pattern, hardened with
// 3a's resolveCompanyByName for the company-side compare):
//   • .eq with lowercased email — CA rows are reliably lowercase per
//     the signup-path audit (driver-row drift filed as B147 fast-follow)
//   • NO .maybeSingle() — a user can legitimately have multiple
//     user_roles rows (CA + driver in same company, historical
//     migrations); .maybeSingle() throws on 2+ rows and would
//     false-403 valid CAs
//   • Filter to role='company_admin' in code, iterate
//   • Per CA row: resolveCompanyByName trims + exact-matches +
//     ambiguous-detect (3a's discipline)
//   • Authorized iff any CA row's resolved company.id === requested
//
// FAILURE SHAPE — all returns are HTTP-coded:
//   401 unauthenticated
//   400 bad request (body validation)
//   403 forbidden (auth ok but not CA of company_id)
//   500 authorization-lookup-failed (DB error during gate)
//   200 with { ok, ... } — helper executed (success or expected
//       skip/failure path)

export const runtime = 'nodejs'

export async function POST(request: Request) {
  // ── Auth ─────────────────────────────────────────────────────────
  const supabaseUser = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await supabaseUser.auth.getUser()
  if (authErr || !user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const callerEmail = (user.email ?? '').toLowerCase().trim()
  if (!callerEmail) {
    // auth.getUser() returned a user with no email — defensive (should
    // be impossible per Supabase Auth invariants).
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  // ── Body parse ───────────────────────────────────────────────────
  let body: { company_id?: number; kind?: string } = {}
  try { body = await request.json() } catch { /* empty body → 400 below */ }
  const companyId = body.company_id
  const kind = body.kind
  // Slice 1 Commit 4b — 'permit' added to whitelist (fires from
  // app/manager/page.tsx after approve_vehicle RPC returns action='approved').
  if (!Number.isInteger(companyId) || (kind !== 'property' && kind !== 'driver' && kind !== 'permit')) {
    return NextResponse.json(
      { error: 'company_id (integer) and kind ("property"|"driver"|"permit") required' },
      { status: 400 }
    )
  }

  // ── Authorization: caller is company_admin of company_id ──────────
  const supabase = createSupabaseServiceClient()

  // Get ALL caller's user_roles rows. NOT .maybeSingle() (throws on
  // 2+ rows). .eq lowercased email: CA-role inserts on all signup
  // paths use .toLowerCase() before INSERT, so user_roles.email for
  // CA rows is reliably lowercase. (Driver-role inserts at admin/
  // page.tsx:654 and company_admin/page.tsx:905 don't lowercase as-
  // typed — filed as B147 driver-email-lowercase gap memory; irrelevant
  // here since we filter to CA below.)
  const { data: callerRoles, error: rolesErr } = await supabase
    .from('user_roles')
    .select('role, company')
    .eq('email', callerEmail)
  if (rolesErr) {
    console.error('[B147-sync-on-add-roles-error]', { callerEmail, error: rolesErr.message })
    return NextResponse.json({ error: 'authorization lookup failed' }, { status: 500 })
  }

  const caRoles = (callerRoles ?? []).filter(r => r.role === 'company_admin')
  if (caRoles.length === 0) {
    // Authenticated but no CA role — driver/manager/resident or
    // attacker who guessed the route URL.
    return NextResponse.json({ error: 'caller is not company_admin of any company' }, { status: 403 })
  }

  // Iterate CA rows (typically 1, rarely 2+); use 3a's
  // resolveCompanyByName for the company-side compare. That handles
  // trim, exact .eq, ambiguous-row detection, ownership cross-check —
  // single source of truth, sibling to the B159 normalization discipline.
  let authorized = false
  for (const ca of caRoles) {
    const resolved = await resolveCompanyByName(supabase, ca.company as string | null)
    if (!resolved.ok) {
      // Resolve failed for this CA row — log + skip to next. Common
      // reasons: empty_name (NULL company), not_found (data drift),
      // ambiguous (would have surfaced via 3a's /login error card).
      // Don't return 403 yet — caller might have another CA row that
      // resolves cleanly.
      console.warn('[B147-sync-on-add-resolve-skip]', {
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

  // ── Call helper server-side ──────────────────────────────────────
  // Helper is non-throwing; returns { ok: true; action } | { ok: false; reason }.
  const result = await syncOnAdd(companyId!, kind as 'property' | 'driver' | 'permit')
  if (result.ok) {
    return NextResponse.json({ ok: true, action: result.action })
  }
  // Helper returned !ok — surface the reason in body, use 200 so the
  // client distinguishes via the discriminator, not HTTP semantics.
  // A true 500 from this route would mean the route itself threw,
  // which the framework's error boundary handles.
  return NextResponse.json({ ok: false, reason: result.reason })
}

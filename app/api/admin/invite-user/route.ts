import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'

// /api/admin/invite-user — D1 Commit 2.
//
// REPLACES the swift-handler create_user + display-temp-password flow
// for CA-created NON-RESIDENT roles (manager / leasing_agent / driver).
// The CA Add-User form's non-resident path POSTs here; the route does
// the auth bit server-side (inviteUserByEmail + set_must_change_password
// + insert_user_role + drivers row) and returns success/failure.
//
// WHY THIS ROUTE EXISTS
//   1. Eliminates the temp-password operator handoff pattern for all
//      non-resident roles. The invited user receives an email link and
//      sets their own password — same UX as bulk-invited users.
//   2. Eliminates the swift-handler client-fetch from the Add-User
//      hot path, routing around B187's pre-existing Safari malformed-
//      URL DOMException (which was also B147's original root cause).
//      The fnBase + '/swift-handler' URL construction is gone from the
//      new code path; residents still hit swift-handler for now since
//      their flow is intentionally unchanged (see RESIDENTS section).
//   3. Symmetric with /api/billing/bulk-invite — both routes leverage
//      the JWT-carrying createSupabaseServerClient for RPC calls
//      (insert_user_role + set_must_change_password) so the D2-shipped
//      caller-role + company-scope guards fire from the CA's context.
//
// RESIDENTS — INTENTIONALLY EXCLUDED
// The CA-creates-resident path is the exception, not the norm: residents
// typically self-register via /signup/redeem. When a CA does create a
// resident, they're usually on the phone with the resident at creation
// time — temp-password display is acceptable for that scenario. Folding
// residents into invite-by-email would require a parallel resident-
// approval/email arc that doesn't exist today and isn't on the critical
// path for A1. If we want resident parity later, that's a separate arc.
//
// AUTH MODEL
//   • Caller MUST be admin or company_admin (CA Add-User's allowed
//     surface; managers / leasing_agents / drivers / residents cannot
//     invite users).
//   • For company_admin caller: p_company is forced to caller's own
//     company; admin caller can pass an explicit p_company.
//   • Account-state guard: CA caller on suspended / cancelled account
//     is blocked (mirrors bulk-invite + resend-invite pattern).
//
// AUTH-CONTEXT DISCIPLINE (the D2-discovery lesson)
// Two clients used deliberately:
//   • supabase = createSupabaseServerClient() — cookies-aware, carries
//     CA's JWT. Used for insert_user_role + set_must_change_password
//     RPC calls so the D2 caller-role / company-scope body guards fire
//     correctly (get_my_role() returns 'company_admin').
//   • service = createSupabaseServiceClient() — service-role. Used
//     ONLY for auth.admin.inviteUserByEmail (which requires service-
//     role). NEVER used for insert_user_role calls — that would bypass
//     the D2 body guards and re-open the escalation surface.

export const runtime = 'nodejs'

const ALLOWED_INVITE_ROLES = new Set(['manager', 'leasing_agent', 'driver'])

interface RequestBody {
  email?: string
  role?: string
  name?: string
  company?: string
  property?: string[]
  // Driver-only entity fields (ignored for manager/leasing_agent). Optional;
  // the dedicated Add Driver form collects these, the Add User form does not.
  phone?: string | null
  operator_license?: string | null
}

export async function POST(req: NextRequest) {
  // ── 1. AUTH ──────────────────────────────────────────────────────
  const supabase = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user?.email) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const { data: roleRow, error: roleErr } = await supabase
    .from('user_roles')
    .select('role, company')
    .ilike('email', user.email)
    .single()
  if (roleErr || !roleRow) {
    return NextResponse.json({ error: 'no role assigned' }, { status: 403 })
  }
  if (roleRow.role !== 'admin' && roleRow.role !== 'company_admin') {
    return NextResponse.json({ error: 'admin or company_admin required' }, { status: 403 })
  }
  if (roleRow.role === 'company_admin' && !roleRow.company) {
    return NextResponse.json({ error: 'no company associated with this account' }, { status: 404 })
  }

  // ── 2. ACCOUNT-STATE GUARD (CA only — admin bypasses) ────────────
  if (roleRow.role === 'company_admin') {
    const { data: callerCompany } = await supabase
      .from('companies')
      .select('account_state')
      .ilike('name', roleRow.company!)
      .maybeSingle()
    if (callerCompany?.account_state === 'suspended') {
      return NextResponse.json({
        error: 'Cannot invite users while your account is suspended. Update payment method to restore access.',
      }, { status: 403 })
    }
    if (callerCompany?.account_state === 'cancelled') {
      return NextResponse.json({
        error: 'Cannot invite users on cancelled accounts. To restore the account, contact support@shieldmylot.com within 30 days of cancellation.',
      }, { status: 403 })
    }
    // past_due is allowed — bulk-invite warns but permits; same here.
  }

  // ── 3. BODY PARSE + VALIDATE ─────────────────────────────────────
  let body: RequestBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const email = String(body.email ?? '').trim().toLowerCase()
  const role = String(body.role ?? '').trim()
  const name = body.name ? String(body.name).trim() : null
  // Property — accept the same shape as bulk-invite per-row.
  const property = Array.isArray(body.property)
    ? body.property.map(p => String(p).trim()).filter(Boolean)
    : []
  // Driver entity fields. Only used when role === 'driver'; trimmed +
  // normalized to null on empty. Manager/leasing_agent ignore these.
  const phone = body.phone ? String(body.phone).trim() || null : null
  const operatorLicense = body.operator_license ? String(body.operator_license).trim() || null : null

  // Company resolution: CA caller's own company always; admin can pass
  // an explicit company. Don't trust the client for CA's value.
  const targetCompany = roleRow.role === 'admin'
    ? (body.company ? String(body.company).trim() : null)
    : roleRow.company

  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 })
  }
  if (!ALLOWED_INVITE_ROLES.has(role)) {
    return NextResponse.json({
      error: 'role must be manager, leasing_agent, or driver',
    }, { status: 400 })
  }
  if (roleRow.role === 'admin' && !targetCompany) {
    return NextResponse.json({
      error: 'company required for admin invites',
    }, { status: 400 })
  }

  // ── 4. INVITE — service-role required for Auth admin API ─────────
  const service = createSupabaseServiceClient()
  const origin = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'
  const { error: inviteErr } = await service.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/reset-password-required`,
  })
  if (inviteErr) {
    return NextResponse.json({
      error: 'invite: ' + inviteErr.message,
    }, { status: 502 })
  }

  // ── 5. insert_user_role RPC (JWT-carrying — D2 guards fire) ──────
  // Critical: supabase (cookies-aware) not service (service-role).
  // Service-role would bypass the D2 caller-role / company-scope guards
  // we just shipped and re-open the B155.2 RPC-path escalation. The
  // CA's JWT context is what makes get_my_role() return 'company_admin'
  // in the function body.
  const { error: roleInsertErr } = await supabase.rpc('insert_user_role', {
    p_email: email,
    p_role: role,
    p_company: targetCompany,
    p_property: property,
    p_name: name,
  })
  if (roleInsertErr) {
    // No auto-rollback on the auth user — operator can re-run with
    // corrected inputs (idempotency at the auth layer for the email
    // already exists, but the row insert will still fail until inputs
    // are fixed) or manually deactivate the orphan via the existing
    // swift-handler deactivate_user path.
    return NextResponse.json({
      error: 'user_role: ' + roleInsertErr.message,
    }, { status: 500 })
  }

  // ── 6. must_change_password (graceful degrade) ───────────────────
  // Non-fatal — user can still log in via invite link, but they'll
  // skip the /change-password step on first login. Mirrors bulk-
  // invite's graceful-degrade pattern.
  const { error: mcpErr } = await supabase.rpc('set_must_change_password', {
    p_email: email,
    p_value: true,
  })
  if (mcpErr) {
    console.error('[invite-user] set_must_change_password failed for', email, mcpErr.message)
  }

  // ── 7. ENTITY ROW (drivers only — manager/leasing_agent have none) ─
  if (role === 'driver') {
    const { error: drvErr } = await supabase.from('drivers').insert([{
      email,
      // D2 fallback: prefer name, fall back to email for non-null entity name.
      name: name || email,
      company: targetCompany,
      assigned_properties: property,
      // Driver entity fields from the dedicated Add Driver form. Add User
      // form omits these — they land as NULL for that path, consistent
      // with the pre-refactor Add User → role=driver flow.
      phone,
      operator_license: operatorLicense,
      is_active: true,
    }])
    if (drvErr) {
      console.error('[invite-user] drivers insert failed for', email, drvErr.message)
      // Non-fatal at API level; the auth user + user_roles row landed.
      // Surfaced in response so the CA UI can act on it if needed.
      return NextResponse.json({
        ok: true,
        warning: 'invited + role assigned, but drivers entity row failed: ' + drvErr.message,
        email, role,
      })
    }
  }

  // ── 8. AUDIT LOG ─────────────────────────────────────────────────
  await supabase.from('audit_logs').insert({
    user_email: user.email,
    action: 'INVITE_USER_SENT',
    table_name: 'user_roles',
    record_id: email,
    new_values: { role, company: targetCompany, property, name },
  })

  return NextResponse.json({ ok: true, email, role })
}

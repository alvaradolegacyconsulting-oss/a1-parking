import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'

// B144 (folded into B66.5 commit 4.3) — CA-initiated resend invite.
//
// Lets a company_admin re-trigger an invite email for a driver/resident
// whose original invite expired (24h Supabase Auth window per B143).
// Same Supabase Auth API as B113 bulk-upload (inviteUserByEmail with
// redirectTo /reset-password-required) — just one user at a time.
//
// ── REQUEST SHAPE ───────────────────────────────────────────────────
//   POST /api/admin/resend-invite
//   Body: { target_email: string }
//   Response: { ok: true, was_rapid_resend?: boolean } | { error: string }
//
// ── AUTH ────────────────────────────────────────────────────────────
//   1. Caller must have an authenticated Supabase session
//   2. Caller's user_roles.role must be 'company_admin' (admin can also
//      use this if needed, but the CA list UI is the primary surface)
//   3. The target_email must belong to a user whose user_roles.company
//      matches the caller's user_roles.company (cross-company guard)
//
// ── RATE LIMIT (B66.5 c4.3 I.4 lock) ────────────────────────────────
//   • 60s client-side button disable (handled in the list UI)
//   • Server-side check: if an INVITE_RESENT audit row exists for this
//     target_email within the last 60s, set was_rapid_resend=true on
//     the audit log entry. Still allow the send (don't block — UI's
//     60s disable is the primary defense; this flag lets us identify
//     aggressive CAs in future dashboards).
//
// ── ACCOUNT STATE GUARD (B66.5 c4.3 Q7 lock) ────────────────────────
//   • If caller's company.account_state is 'suspended' or 'cancelled':
//     reject with 403 (same posture as bulk-invite guard).
//   • If 'past_due': allow (parity with bulk-invite's warn-but-allow).
//     Warning surfaced via response field (parallel to bulk-invite shape).

export const runtime = 'nodejs'

interface RequestBody {
  target_email?: string
}

export async function POST(req: NextRequest) {
  // ── 1. Auth ───────────────────────────────────────────────────────
  const supabase = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user?.email) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const { data: callerRoleRow, error: callerRoleErr } = await supabase
    .from('user_roles')
    .select('role, company')
    .ilike('email', user.email)
    .single()
  if (callerRoleErr || !callerRoleRow) {
    return NextResponse.json({ error: 'no role assigned' }, { status: 403 })
  }
  if (callerRoleRow.role !== 'company_admin' && callerRoleRow.role !== 'admin') {
    return NextResponse.json({ error: 'company_admin or admin required' }, { status: 403 })
  }
  if (!callerRoleRow.company && callerRoleRow.role === 'company_admin') {
    return NextResponse.json({ error: 'no company associated with caller' }, { status: 404 })
  }

  // ── 2. Body ───────────────────────────────────────────────────────
  let body: RequestBody
  try {
    body = (await req.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const targetEmail = body.target_email?.trim().toLowerCase()
  if (!targetEmail) {
    return NextResponse.json({ error: 'target_email is required' }, { status: 400 })
  }

  // ── 3. Account-state guard (B66.5 c4.3) ───────────────────────────
  // Skip for admin role (no company association). For company_admin,
  // mirror the bulk-invite guard pattern: block suspended + cancelled,
  // warn past_due, allow active + configuring.
  let warning: string | null = null
  if (callerRoleRow.role === 'company_admin' && callerRoleRow.company) {
    const { data: callerCompany } = await supabase
      .from('companies')
      .select('account_state')
      .ilike('name', callerRoleRow.company)
      .maybeSingle()
    if (callerCompany?.account_state === 'suspended') {
      return NextResponse.json(
        {
          error: 'Cannot resend invites while your account is suspended. ' +
                 'Update payment method to restore access.',
        },
        { status: 403 }
      )
    }
    if (callerCompany?.account_state === 'cancelled') {
      return NextResponse.json(
        {
          error: 'Cannot resend invites on cancelled accounts. To restore the ' +
                 'account, contact support@shieldmylot.com within 30 days of cancellation.',
        },
        { status: 403 }
      )
    }
    if (callerCompany?.account_state === 'past_due') {
      warning = 'Your account is past due. Invite was resent, but service may be ' +
                'interrupted if payment is not resolved.'
    }
  }

  // ── 4. Cross-company guard ────────────────────────────────────────
  // Target user MUST belong to the caller's company. Admin bypasses
  // this check (admin can resend any invite).
  const { data: targetRoleRow } = await supabase
    .from('user_roles')
    .select('role, company')
    .ilike('email', targetEmail)
    .maybeSingle()
  if (!targetRoleRow) {
    return NextResponse.json({ error: 'target user has no role assignment' }, { status: 404 })
  }
  if (callerRoleRow.role === 'company_admin'
    && targetRoleRow.company?.toLowerCase() !== callerRoleRow.company.toLowerCase()) {
    return NextResponse.json(
      { error: 'target user does not belong to your company' },
      { status: 403 }
    )
  }

  // ── 5. Rate-limit detection (server-side audit-log probe) ─────────
  // 60s client disable is primary. Server check augments with a flag
  // for future "aggressive CA" identification in dashboards.
  const sixtySecondsAgo = new Date(Date.now() - 60_000).toISOString()
  const { data: priorResends } = await supabase
    .from('audit_logs')
    .select('id, created_at')
    .eq('action', 'INVITE_RESENT')
    .eq('record_id', targetEmail)
    .gte('created_at', sixtySecondsAgo)
    .limit(1)
  const wasRapidResend = Array.isArray(priorResends) && priorResends.length > 0

  // ── 6. Resend the invite (service-role required for Auth admin API) ─
  const service = createSupabaseServiceClient()
  const origin = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'
  const { error: inviteErr } = await service.auth.admin.inviteUserByEmail(targetEmail, {
    redirectTo: `${origin}/reset-password-required`,
  })
  if (inviteErr) {
    return NextResponse.json(
      { error: 'invite resend failed: ' + inviteErr.message },
      { status: 500 }
    )
  }

  // ── 7. Audit log emission ─────────────────────────────────────────
  await supabase.from('audit_logs').insert({
    user_email: user.email,
    action: 'INVITE_RESENT',
    table_name: 'user_roles',
    record_id: targetEmail,
    new_values: {
      target_email: targetEmail,
      invoking_ca_email: user.email,
      target_company: targetRoleRow.company,
      was_rapid_resend: wasRapidResend,
    },
  })

  return NextResponse.json({
    ok: true,
    ...(wasRapidResend && { was_rapid_resend: true }),
    ...(warning && { warning }),
  })
}

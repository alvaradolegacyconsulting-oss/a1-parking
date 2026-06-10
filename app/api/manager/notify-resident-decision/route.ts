import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { sendEmail } from '../../../lib/resend-client'

// Resident approval / decline notification endpoint.
//
// Manager portal calls this AFTER the DB writes (residents +
// pending-vehicles updates + B166 owner-trim on decline) succeed.
// Non-blocking on the client side: a send failure logs to console but
// does NOT revert the approval — the manager already acted; email is
// the secondary channel. The audit log on the manager side captures
// email_sent + message_id for forensic visibility.
//
// CONTENT NOTE — no temp-password language.
// Self-registered residents set their own password at /register; there
// is no temp password to send. Approve body tells them to log in with
// the password they chose at signup. The B-resident-approval-email
// preflight (2026-06-10) confirmed the docs that said "approval sends
// a temp password" were wrong on three counts (no email sent today; no
// temp generated for self-reg; no must_change_password set on the
// self-reg path).

const LOGIN_URL = 'https://shieldmylot.com/login'

type Decision = 'approved' | 'declined'

interface RequestBody {
  residentId: string
  decision: Decision
  note?: string | null
}

export async function POST(req: NextRequest) {
  // ── 1. Auth ───────────────────────────────────────────────────────
  const supabase = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user?.email) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }
  const { data: roleRow, error: roleErr } = await supabase
    .from('user_roles')
    .select('role')
    .ilike('email', user.email)
    .single()
  if (roleErr || !roleRow) {
    return NextResponse.json({ error: 'no role assigned' }, { status: 403 })
  }
  if (roleRow.role !== 'manager' && roleRow.role !== 'leasing_agent') {
    return NextResponse.json({ error: 'manager or leasing_agent required' }, { status: 403 })
  }

  // ── 2. Parse body ─────────────────────────────────────────────────
  let body: RequestBody
  try {
    body = (await req.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!body.residentId || (body.decision !== 'approved' && body.decision !== 'declined')) {
    return NextResponse.json({ error: 'residentId and decision required' }, { status: 400 })
  }

  // ── 3. Fetch resident — RLS scopes to the caller's property ──────
  // If the residentId doesn't belong to a property in the caller's
  // assigned properties, RLS denies the SELECT and we 404. This is the
  // authorization check: don't trust the residentId from the client;
  // verify it via the manager session's own RLS scope.
  const { data: resident, error: residentErr } = await supabase
    .from('residents')
    .select('email, name, property')
    .eq('id', body.residentId)
    .maybeSingle()
  if (residentErr || !resident) {
    return NextResponse.json({ error: 'resident not found or not in your scope' }, { status: 404 })
  }
  if (!resident.email) {
    return NextResponse.json({ error: 'resident has no email on file' }, { status: 400 })
  }

  // ── 4. Construct + send email ────────────────────────────────────
  const property = resident.property || 'your property'
  const name = resident.name || 'there'
  const noteText = (body.note || '').trim()

  const subject = body.decision === 'approved'
    ? `You're approved at ${property}`
    : `Update on your registration at ${property}`

  const html = body.decision === 'approved'
    ? renderApprovedHtml({ name, property })
    : renderDeclinedHtml({ name, property, note: noteText || null })

  const sendResult = await sendEmail({
    to: resident.email,
    subject,
    html,
  })

  if (!sendResult.ok) {
    return NextResponse.json(
      { ok: false, error: sendResult.error },
      { status: 502 }
    )
  }

  return NextResponse.json({
    ok: true,
    message_id: sendResult.message_id || null,
  })
}

// ─── Email templates ───────────────────────────────────────────────
// Inline HTML — table-based layout for email-client compatibility.
// Light styling only; no external assets, no JavaScript.

function renderApprovedHtml(args: { name: string; property: string }): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:32px;max-width:560px;">
        <tr><td>
          <h1 style="font-size:22px;font-weight:700;margin:0 0 16px;color:#0f1117;">Your registration has been approved</h1>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Hi ${escapeHtml(args.name)},</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
            Good news — your resident registration at <strong>${escapeHtml(args.property)}</strong> has been approved by the property manager.
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 24px;">
            Log in to your resident portal to view authorized vehicles, issue visitor passes, and manage your account. Use the email and password you chose during signup.
          </p>
          <p style="margin:0 0 24px;">
            <a href="${LOGIN_URL}" style="display:inline-block;background:#C9A227;color:#0f1117;font-weight:700;font-size:14px;padding:12px 24px;border-radius:6px;text-decoration:none;">Log in</a>
          </p>
          <p style="font-size:13px;line-height:1.6;margin:0 0 8px;color:#6b7280;">
            If the button doesn't work, copy this link into your browser:<br>
            <a href="${LOGIN_URL}" style="color:#0066cc;word-break:break-all;">${LOGIN_URL}</a>
          </p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
          <p style="font-size:12px;line-height:1.5;margin:0;color:#9ca3af;">
            This message was sent because someone registered as a resident at ${escapeHtml(args.property)} using this email address. If that wasn't you, please ignore this email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

function renderDeclinedHtml(args: { name: string; property: string; note: string | null }): string {
  const reasonBlock = args.note
    ? `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
         <strong>Manager note:</strong><br>
         ${escapeHtml(args.note).replace(/\n/g, '<br>')}
       </p>`
    : `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
         Please contact property management for details.
       </p>`
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:32px;max-width:560px;">
        <tr><td>
          <h1 style="font-size:22px;font-weight:700;margin:0 0 16px;color:#0f1117;">Update on your registration</h1>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Hi ${escapeHtml(args.name)},</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
            Your registration at <strong>${escapeHtml(args.property)}</strong> could not be approved at this time.
          </p>
          ${reasonBlock}
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
          <p style="font-size:12px;line-height:1.5;margin:0;color:#9ca3af;">
            This message was sent in response to a resident registration submitted at ${escapeHtml(args.property)} using this email address.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { sendCompanyScopedEmail } from '../../../lib/company-scoped-email'

// ══════════════════════════════════════════════════════════════════════
// notify-resident-deactivation — deactivation-email arc, Commit C.
// ══════════════════════════════════════════════════════════════════════
//
// Called by deactivateResidentWrite (client) AFTER the residents
// UPDATE + audit have landed. The route:
//
//   1. Auth-gates on manager or leasing_agent
//   2. Reads resident row via SERVICE-ROLE (needs deactivated_at +
//      deactivation_notified_at for the dedup precondition; RLS on
//      residents is property-scoped and the caller may not see the
//      row through their session for that specific field set)
//   3. Dedup precondition: send only when
//        deactivation_notified_at IS NULL
//          OR deactivation_notified_at < deactivated_at
//      (defense-in-depth — the writer also detects no-op re-writes
//      via same-reason check upstream, but this catches the race)
//   4. Resolves property contact (pm_name / pm_email / pm_phone) —
//      appended to body when populated; generic sentence is the base
//   5. sendCompanyScopedEmail with resident_id anchor
//   6. On send success: stamps deactivation_notified_at = now()
//   7. Returns outcome for the writer's audit row
//
// COPY DISCIPLINE (Mateo Aug 4 → Aug 9)
//   - Property named in BOTH subject and body (multi-residency makes
//     "your account has been deactivated" factually wrong)
//   - No mention of spaces / guests / visitor passes (cascade behavior
//     for already-issued live guest auths is unverified — no unprovable
//     enforcement claims in writing)
//   - No mention of login (user_roles.is_active is the actual gate;
//     ban path is unreliable; silence on login is what keeps it true)
//   - No support@shieldmylot.com AND no hello@shieldmylot.com (upset
//     end user; support is B2B)
//   - No retention policy, rights statement, or ToS paraphrase
//
// AUTH SHAPE MIRRORS notify-resident-decision (:34-51).
// ══════════════════════════════════════════════════════════════════════

interface RequestBody {
  residentId: string
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
  if (!body.residentId) {
    return NextResponse.json({ error: 'residentId required' }, { status: 400 })
  }

  // ── 3. Read resident + dedup precondition (service-role) ─────────
  // Service-role because we need the deactivation_notified_at + the
  // deactivated_at columns to make the dedup decision; the caller's
  // session may not have SELECT on those columns depending on RLS
  // shape, and defaulting to normal send under a read failure would
  // send twice against the same deactivation. Read once, decide once.
  const admin = createSupabaseServiceClient()
  const { data: r, error: readErr } = await admin
    .from('residents')
    .select('id, email, name, property, deactivated_at, deactivation_notified_at')
    .eq('id', body.residentId)
    .maybeSingle()
  if (readErr) {
    console.error('[notify-resident-deactivation] resident read failed', { residentId: body.residentId, error: readErr.message })
    return NextResponse.json({ ok: false, outcome: 'failed', error: readErr.message }, { status: 500 })
  }
  if (!r) {
    return NextResponse.json({ ok: false, outcome: 'failed', error: 'resident not found' }, { status: 404 })
  }
  if (!r.email) {
    console.log('[notify-resident-deactivation] no email on file', { residentId: body.residentId })
    return NextResponse.json({ ok: true, outcome: 'no-email-on-file', message_id: null })
  }
  if (!r.deactivated_at) {
    console.warn('[notify-resident-deactivation] deactivated_at is null; caller called notify before writer stamped', { residentId: body.residentId })
    return NextResponse.json({ ok: false, outcome: 'failed', error: 'resident not deactivated yet' }, { status: 409 })
  }
  // Defense-in-depth dedup. Writer detects no-op re-writes upstream
  // via same-reason check; this catches the race where two calls
  // both pass the writer's check.
  if (r.deactivation_notified_at && new Date(r.deactivation_notified_at) >= new Date(r.deactivated_at)) {
    console.log('[notify-resident-deactivation] dedup skipped', {
      residentId: body.residentId,
      deactivated_at:            r.deactivated_at,
      deactivation_notified_at:  r.deactivation_notified_at,
    })
    return NextResponse.json({ ok: true, outcome: 'sent', message_id: null, dedup_skipped: true })
  }

  // ── 4. Resolve property contact (optional append) ────────────────
  const { data: prop } = await admin
    .from('properties')
    .select('pm_name, pm_email, pm_phone')
    .ilike('name', r.property)
    .maybeSingle()
  const pmName  = (prop?.pm_name  ?? '').trim() || null
  const pmEmail = (prop?.pm_email ?? '').trim() || null
  const pmPhone = (prop?.pm_phone ?? '').trim() || null

  // ── 5. Build + send ──────────────────────────────────────────────
  const subject = `Update on your registration at ${r.property}`
  const html = renderDeactivationHtml({
    name: r.name || 'there',
    property: r.property,
    pmName, pmEmail, pmPhone,
  })

  const send = await sendCompanyScopedEmail({
    to:            r.email,
    subject,
    html,
    companyAnchor: { kind: 'resident_id', residentId: body.residentId },
  })

  if (!send.ok) {
    console.error('[notify-resident-deactivation] send failed', { residentId: body.residentId, error: send.error })
    return NextResponse.json({ ok: false, outcome: 'failed', error: send.error, message_id: null }, { status: 502 })
  }

  // ── 6. Stamp deactivation_notified_at (service-role) ─────────────
  const nowIso = new Date().toISOString()
  const { error: stampErr } = await admin
    .from('residents')
    .update({ deactivation_notified_at: nowIso })
    .eq('id', body.residentId)
  if (stampErr) {
    // Send landed; stamp failed. Second call would re-send.
    // Log loud; still return ok=true so the writer records success —
    // the mail did go. Manual reconciliation on the stamp column if
    // it ever matters.
    console.error('[notify-resident-deactivation] stamp failed after successful send', {
      residentId: body.residentId, message_id: send.message_id, error: stampErr.message,
    })
  }

  return NextResponse.json({
    ok:         true,
    outcome:    send.outcome,        // 'sent' | 'overridden'
    message_id: send.message_id,
    originalTo: send.originalTo,
    actualTo:   send.actualTo,
  })
}

// ─── Email template ────────────────────────────────────────────────
// Inline HTML — table-based layout for email-client compatibility.
// Mirrors app/api/manager/notify-resident-decision/route.ts:
// renderApprovedHtml / renderDeclinedHtml shape.

function renderDeactivationHtml(args: {
  name:    string
  property: string
  pmName:  string | null
  pmEmail: string | null
  pmPhone: string | null
}): string {
  const hasContact = args.pmName || args.pmEmail || args.pmPhone
  const contactLine = hasContact
    ? `<p style="font-size:14px;line-height:1.6;margin:0 0 16px;color:#4b5563;">
         Property contact:
         ${args.pmName ? `<strong>${escapeHtml(args.pmName)}</strong>` : ''}
         ${args.pmEmail ? ` &middot; <a href="mailto:${escapeHtml(args.pmEmail)}" style="color:#0f1117;text-decoration:underline;">${escapeHtml(args.pmEmail)}</a>` : ''}
         ${args.pmPhone ? ` &middot; ${escapeHtml(args.pmPhone)}` : ''}
       </p>`
    : ''

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:32px;max-width:560px;">
        <tr><td>
          <h1 style="font-size:22px;font-weight:700;margin:0 0 16px;color:#0f1117;">Update on your registration at ${escapeHtml(args.property)}</h1>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Hi ${escapeHtml(args.name)},</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
            Vehicles you registered at <strong>${escapeHtml(args.property)}</strong> are no longer authorized to park there.
          </p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
            If you believe this was done in error, please contact your property management office.
          </p>
          ${contactLine}
          <p style="font-size:12px;line-height:1.5;margin:24px 0 0;color:#9ca3af;">
            ShieldMyLot — parking management platform.
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

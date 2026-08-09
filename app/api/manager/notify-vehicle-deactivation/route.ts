import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { sendCompanyScopedEmail } from '../../../lib/company-scoped-email'

// ══════════════════════════════════════════════════════════════════════
// notify-vehicle-deactivation — deactivation-email arc, Commit D.
// ══════════════════════════════════════════════════════════════════════
//
// Called by deactivateVehicleWrite (client) AFTER the deactivate_vehicle
// RPC + local audit have landed. Same shape as notify-resident-deactivation
// (:1-171) with one substantive difference:
//
//   Anchor: { kind: 'resident_email', email, property }
//
//   Vehicles carry both `resident_email` and `property` on the row —
//   never resident_id (design decision from B27 / project_b27). The
//   email-keyed anchor is the load-bearing branch of
//   sendCompanyScopedEmail's multiplicity resolver: 0 residents at
//   (email, property) → normal send (fail-open, arc-locked), 1 → use
//   it, N same env → use it, N with divergent envs → normal send plus
//   a loud [company-scoped-email:divergent-envs] warning. No LIMIT 1.
//
// This route is what makes probes 5 (divergence) and 7 (no-email-on-
// file) reachable — probe 5 because the anchor is email-keyed and can
// resolve multiple residents at one property, probe 7 because
// vehicles.resident_email is nullable by design (legacy unit-level /
// shared-vehicle case).
//
// Steps:
//   1. Auth-gates on manager or leasing_agent (mirrors notify-resident-*)
//   2. Reads vehicle via SERVICE-ROLE (need deactivation_notified_at +
//      deactivated_at for the dedup precondition; caller RLS may not
//      expose those columns)
//   3. Dedup precondition: send only when
//        deactivation_notified_at IS NULL
//          OR deactivation_notified_at < deactivated_at
//   4. Resolves property contact (pm_name / pm_email / pm_phone) —
//      appended to body when populated; generic sentence is the base
//   5. sendCompanyScopedEmail with resident_email + property anchor
//   6. On send success: stamps vehicles.deactivation_notified_at = now()
//   7. Returns outcome for the writer's audit row
//
// COPY DISCIPLINE (Mateo Aug 9 correction #3):
//   - Subject stays anodyne: `Update on your vehicle at <PROPERTY>`.
//     Plate lives in the BODY only. Symmetric with resident-side
//     notify-resident-deactivation (`Update on your registration at
//     <PROPERTY>`). Reasoning in the render function's site comment.
//   - No mention of spaces / guests / visitor passes
//   - No mention of login (user_roles.is_active is the actual gate)
//   - No support@shieldmylot.com / no hello@shieldmylot.com
//   - No retention policy, rights statement, or ToS paraphrase
//
// DEFENSIVE BRANCHES — dispositions:
//   - `!v.property` (malformed anchor): kept as `failed` per Mateo
//     Aug 9 correction #2. Under the current schema `vehicles.property`
//     is expected NOT NULL — every INSERT path populates it from the
//     manager session's `manager.name`, and every read filters on it.
//     If D-8's UPDATE attempt confirms NOT NULL, this branch is
//     unreachable via the write path but retained as a correctly-
//     labelled schema-drift guard.
//   - Dedup precondition (deactivation_notified_at gate):
//     STRUCTURAL VERIFICATION ONLY. Cannot be hand-driven by Jose
//     — the route is cookie-authenticated session-scoped, and probe
//     D-4's original "curl the route" plan would require cookie
//     extraction Jose doesn't have. Verified by reading the branch
//     above (`if (v.deactivation_notified_at && new Date(...) >= new
//     Date(v.deactivated_at))`). Guards the race where two writer
//     calls both pass the writer's snapshot check but only one
//     should stamp + send.
// ══════════════════════════════════════════════════════════════════════

interface RequestBody {
  vehicleId: string
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
  if (!body.vehicleId) {
    return NextResponse.json({ error: 'vehicleId required' }, { status: 400 })
  }

  // ── 3. Read vehicle + dedup precondition (service-role) ──────────
  // Service-role because we need deactivation_notified_at + deactivated_at
  // to make the dedup decision. Same rationale as notify-resident-
  // deactivation:79-84. Read once, decide once.
  const admin = createSupabaseServiceClient()
  const { data: v, error: readErr } = await admin
    .from('vehicles')
    .select('id, plate, resident_email, property, deactivated_at, deactivation_notified_at')
    .eq('id', body.vehicleId)
    .maybeSingle()
  if (readErr) {
    console.error('[notify-vehicle-deactivation] vehicle read failed', { vehicleId: body.vehicleId, error: readErr.message })
    return NextResponse.json({ ok: false, outcome: 'failed', error: readErr.message }, { status: 500 })
  }
  if (!v) {
    return NextResponse.json({ ok: false, outcome: 'failed', error: 'vehicle not found' }, { status: 404 })
  }
  if (!v.resident_email) {
    // Legacy unit-level / shared-vehicle case (vehicles.resident_email
    // is nullable by design). Not an error — audit as no-email-on-file.
    console.log('[notify-vehicle-deactivation] no email on file', { vehicleId: body.vehicleId })
    return NextResponse.json({ ok: true, outcome: 'no-email-on-file', message_id: null })
  }
  if (!v.property) {
    // Mateo Aug 9 correction #2: this is NOT no-email-on-file. A
    // vehicle missing its property may still have a perfectly good
    // resident_email — the anchor is what's malformed, not the
    // recipient. `no-email-on-file` means one specific thing;
    // conflating the two collapses a structural data problem into a
    // routine suppression class.
    //
    // Whether vehicles.property is NOT NULL at the DB level is not
    // verifiable from this write path; every INSERT path in the code
    // populates it from the manager session's `manager.name`, and the
    // enforcement + CRM reads all key on `.ilike('property', ...)` —
    // so a NULL-property row is invisible to the surfaces that would
    // otherwise surface the schema drift. Hard-fail here surfaces it
    // loudly. The writer maps ok:false to emailDecision:'failed' with
    // the malformed-anchor reason in email_error.
    console.error('[notify-vehicle-deactivation] vehicle has no property — malformed anchor', { vehicleId: body.vehicleId, resident_email: v.resident_email })
    return NextResponse.json(
      { ok: false, outcome: 'failed', error: 'vehicle has no property (malformed anchor)', message_id: null },
      { status: 500 },
    )
  }
  if (!v.deactivated_at) {
    console.warn('[notify-vehicle-deactivation] deactivated_at is null; caller called notify before writer stamped', { vehicleId: body.vehicleId })
    return NextResponse.json({ ok: false, outcome: 'failed', error: 'vehicle not deactivated yet' }, { status: 409 })
  }
  // Defense-in-depth dedup. Writer detects no-op re-writes upstream
  // via same-reason check; this catches the race where two calls
  // both pass the writer's check.
  if (v.deactivation_notified_at && new Date(v.deactivation_notified_at) >= new Date(v.deactivated_at)) {
    console.log('[notify-vehicle-deactivation] dedup skipped', {
      vehicleId: body.vehicleId,
      deactivated_at:            v.deactivated_at,
      deactivation_notified_at:  v.deactivation_notified_at,
    })
    return NextResponse.json({ ok: true, outcome: 'sent', message_id: null, dedup_skipped: true })
  }

  // ── 4. Resolve property contact (optional append) ────────────────
  const { data: prop } = await admin
    .from('properties')
    .select('pm_name, pm_email, pm_phone')
    .ilike('name', v.property)
    .maybeSingle()
  const pmName  = (prop?.pm_name  ?? '').trim() || null
  const pmEmail = (prop?.pm_email ?? '').trim() || null
  const pmPhone = (prop?.pm_phone ?? '').trim() || null

  // ── 5. Build + send ──────────────────────────────────────────────
  // Mateo Aug 9 correction #3: subject stays anodyne, plate lives in
  // the body only. Symmetric with the resident-side template
  // ("Update on your registration at <PROPERTY>"). Two reasons:
  //   - Lock-screen / notification-banner previews. "No longer
  //     authorized" reads as a threat to a recipient whose vehicle
  //     just became towable; a neutral subject with substance in the
  //     body lets the message land the way it's intended.
  //   - Plate in a subject line is more exposed (preview panes,
  //     shared devices, notification history) than plate in the body.
  const subject = `Update on your vehicle at ${v.property}`
  const html = renderVehicleDeactivationHtml({
    plate:    v.plate ?? '',
    property: v.property,
    pmName, pmEmail, pmPhone,
  })

  const send = await sendCompanyScopedEmail({
    to:            v.resident_email,
    subject,
    html,
    companyAnchor: { kind: 'resident_email', email: v.resident_email, property: v.property },
  })

  if (!send.ok) {
    console.error('[notify-vehicle-deactivation] send failed', { vehicleId: body.vehicleId, error: send.error })
    return NextResponse.json({ ok: false, outcome: 'failed', error: send.error, message_id: null }, { status: 502 })
  }

  // ── 6. Stamp deactivation_notified_at (service-role) ─────────────
  const nowIso = new Date().toISOString()
  const { error: stampErr } = await admin
    .from('vehicles')
    .update({ deactivation_notified_at: nowIso })
    .eq('id', body.vehicleId)
  if (stampErr) {
    // Send landed; stamp failed. Second call would re-send.
    // Log loud; still return ok=true so the writer records success —
    // the mail did go. Same discipline as notify-resident-deactivation.
    console.error('[notify-vehicle-deactivation] stamp failed after successful send', {
      vehicleId: body.vehicleId, message_id: send.message_id, error: stampErr.message,
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
// Mirrors the shape of notify-resident-deactivation:178-218.
//
// Deliberately does NOT paraphrase the reason code (which resident
// UPDATE never surfaces either — property-facing detail belongs with
// the property manager, not the resident-facing email). "No longer
// authorized to park at <property>" is the fact; details on request.

function renderVehicleDeactivationHtml(args: {
  plate:    string
  property: string
  pmName:   string | null
  pmEmail:  string | null
  pmPhone:  string | null
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

  const plateChip = args.plate
    ? `<strong style="font-family:'Courier New',monospace;">${escapeHtml(args.plate)}</strong>`
    : 'The vehicle'

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:32px;max-width:560px;">
        <tr><td>
          <h1 style="font-size:22px;font-weight:700;margin:0 0 16px;color:#0f1117;">A vehicle you registered at ${escapeHtml(args.property)} is no longer authorized</h1>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Hi there,</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
            ${plateChip} is no longer authorized to park at <strong>${escapeHtml(args.property)}</strong>.
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

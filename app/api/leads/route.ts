import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { verifyTurnstile } from '../../lib/turnstile-verify'
import { createSupabaseServiceClient } from '../../lib/supabase-admin'
import { guardEmail, normalizeEmail } from '../../lib/email-guard'
import { sendEmail } from '../../lib/resend-client'
import {
  normalizeSource, resolveTrack, tristate, cleanText, cleanCount, buildLeadAlert,
} from '../../lib/leads'

// ════════════════════════════════════════════════════════════════════
// /api/leads — negotiated-deal intake (2026-09-23). Commit 2 of 4.
// ════════════════════════════════════════════════════════════════════
//
// ONE route for BOTH entry surfaces: the /operators ad landing page and
// (later) the full public form. There is deliberately no second endpoint
// and no second table — a parallel lead path is how half the leads end
// up somewhere nobody reads.
//
// ── ORDER OF OPERATIONS IS LOAD-BEARING ─────────────────────────────
//   1. Verify Turnstile.  Refuse before anything else is touched.
//   2. guardEmail() on the address.
//   3. INSERT the row, service-role.
//   4. Fire the internal alert, then record its outcome on the row.
//
// 🔴 THE INSERT IS THE SUCCESS CONDITION. THE EMAIL IS NOT.
// If Resend is down, the row still exists and the visitor still sees
// success. The whole reason the August scope stores as well as notifies
// is so a missed notification never loses a lead; failing the request
// when the mail provider hiccups would defeat exactly that. The send
// failure is recorded in alert_email_error and logged — never thrown.
//
// 🔴 WHY anon HAS NO GRANT ON leads, THOUGH THIS IS A PUBLIC POST.
// The browser never touches the table. It POSTs here; this route holds
// the service role and writes on its behalf after the CAPTCHA and the
// email gate. Granting anon INSERT would let anyone skip both.

export const runtime = 'nodejs'

type LeadBody = {
  captchaToken?: string
  company_name?: unknown
  contact_name?: unknown
  email?: unknown
  phone?: unknown
  track?: unknown
  property_count?: unknown
  scale_note?: unknown
  timeline?: unknown
  growth_trend?: unknown
  texas_confirmed?: unknown
  wants_demo?: unknown
  source?: unknown
}

// One friendly sentence for anything the visitor can act on. Raw server
// or Postgres errors never reach this surface.
const refuse = (error: string, status: number, error_class: string) =>
  NextResponse.json({ ok: false, error, error_class }, { status })

export async function POST(req: NextRequest) {
  let body: LeadBody = {}
  try {
    body = await req.json()
  } catch {
    return refuse('We could not read that submission. Please try again.', 400, 'bad_body')
  }

  // ── 1. Turnstile, before anything else ────────────────────────────
  const remoteIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const captcha = await verifyTurnstile(body.captchaToken as string | undefined, remoteIp)
  if (!captcha.ok) {
    // missing_secret means TURNSTILE_SECRET_KEY is unset on Vercel and
    // the form is entirely broken — the right posture, but it is a
    // CONFIGURATION failure and must not read as the visitor's fault.
    const msg = captcha.reason === 'missing_token'
      ? 'Please complete the challenge below and submit again.'
      : captcha.reason === 'rejected'
        ? 'That challenge could not be verified. Please try it once more.'
        : 'We could not verify the challenge just now. Please try again in a moment.'
    const status = captcha.reason === 'missing_token' || captcha.reason === 'rejected' ? 400 : 503
    console.error('[leads] turnstile refused', { reason: captcha.reason, detail: captcha.detail })
    return refuse(msg, status, captcha.reason)
  }

  // ── 2. Email, server-side ─────────────────────────────────────────
  // Same shared gate every auth-minting ingress calls — blocked
  // characters AND the dead-TLD rule. The browser may run the same check
  // first; this is the one that counts.
  const email = normalizeEmail(body.email as string | undefined)
  if (!email || !email.includes('@')) {
    return refuse('Please enter the email address we should reply to.', 400, 'bad_email')
  }
  const eg = guardEmail(email)
  if (!eg.ok) return refuse(eg.message, 400, 'blocked_email')

  // Track is DERIVED and sent as a branch. An unrecognised value is
  // refused rather than defaulted, so a crafted POST cannot choose which
  // track it files itself under.
  const track = resolveTrack(body.track)
  if (!track) {
    console.error('[leads] missing or unknown track', { track: body.track })
    return refuse('Something went wrong with this form. Please contact us directly.', 400, 'bad_track')
  }

  const lead = {
    company_name:    cleanText(body.company_name),
    contact_name:    cleanText(body.contact_name),
    email,
    phone:           cleanText(body.phone, 40),
    track,
    property_count:  cleanCount(body.property_count),
    scale_note:      cleanText(body.scale_note),
    timeline:        cleanText(body.timeline),
    growth_trend:    cleanText(body.growth_trend),
    texas_confirmed: tristate(body.texas_confirmed),
    wants_demo:      tristate(body.wants_demo),
    source:          normalizeSource(body.source),
  }

  // ── 3. The insert. This is the success condition. ─────────────────
  const supabase = createSupabaseServiceClient()
  const { data: inserted, error: insertErr } = await supabase
    .from('leads').insert([lead]).select('id').single()

  if (insertErr) {
    // 🔴 Nothing was stored, so this one DOES fail the request — the
    // visitor must not be told we have their details when we do not.
    console.error('[leads] CRITICAL: insert failed, lead is lost', {
      code: insertErr.code, message: insertErr.message, email: lead.email,
    })
    return refuse(
      'We could not save your details just now. Please try again, or email us directly.',
      500, 'insert_failed',
    )
  }
  const leadId = (inserted as { id: number } | null)?.id ?? null

  // ── 4. The alert. Best-effort from here on. ───────────────────────
  // 🔴 D3: no fallback recipient. Defaulting to support@ would quietly
  // route lead notifications into the B2B support queue, which is worse
  // than a send that visibly did not happen — the lead would look
  // notified and nobody would be looking.
  const recipients = (process.env.LEADS_ALERT_EMAIL ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)

  let alertSent = false
  let alertMessageId: string | null = null
  let alertError: string | null = null

  if (recipients.length === 0) {
    alertError = 'LEADS_ALERT_EMAIL is not set — no alert was attempted. The lead IS saved.'
    console.error('[leads] ' + alertError, { leadId })
  } else {
    const alert = buildLeadAlert({ id: leadId, ...lead })
    // One send PER RECIPIENT rather than one send to many.
    //
    // sendEmail's `to` is typed as a single string; Resend itself takes
    // an array, but widening our shared wrapper would touch the module
    // dunning and Stripe provisioning also send through, and this is not
    // the commit to do that in. Sending individually is also the more
    // robust shape: one bad address in the list cannot suppress the
    // alert to everyone else, and the per-recipient outcome is recorded.
    const results: string[] = []
    for (const to of recipients) {
      try {
        const res = await sendEmail({ to, subject: alert.subject, text: alert.text })
        if (res.ok) {
          alertSent = true                       // at least one landed
          alertMessageId = alertMessageId ?? res.message_id
          results.push(`${to}=ok`)
        } else {
          results.push(`${to}=FAILED(${res.error})`)
        }
      } catch (e) {
        results.push(`${to}=THREW(${(e as Error)?.message ?? String(e)})`)
      }
    }
    // alert_email_sent records whether ANYONE was reached; the detail
    // line preserves which ones did not, so a partial failure is visible
    // rather than rounded up to success.
    const failed = results.filter(r => !r.endsWith('=ok'))
    if (failed.length > 0) alertError = results.join('; ')
    if (!alertSent) console.error('[leads] alert send FAILED to EVERY recipient — lead is saved but nobody was told', { leadId, results })
    else if (failed.length > 0) console.error('[leads] alert send partially failed', { leadId, results })
  }

  // D2: record the outcome on the row so "did anyone get told about this
  // lead" is a query rather than a question. A console line on a
  // serverless function is not a place anyone looks.
  if (leadId !== null) {
    const { error: updErr } = await supabase.from('leads').update({
      alert_email_sent: alertSent,
      alert_email_message_id: alertMessageId,
      alert_email_error: alertError,
    }).eq('id', leadId)
    // Never let the bookkeeping become a reason a lead is lost: the row
    // exists and the alert already went (or already failed).
    if (updErr) console.error('[leads] alert bookkeeping update failed', { leadId, err: updErr.message })
  }

  console.log('[leads] lead stored', { leadId, track, wants_demo: lead.wants_demo, alertSent })
  return NextResponse.json({ ok: true, id: leadId })
}

import 'server-only'
import { createSupabaseServiceClient } from './supabase-admin'
import { sendCompanyScopedEmail } from './company-scoped-email'

// ════════════════════════════════════════════════════════════════════
// Notifications for a load, a return and a reject
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16. Before this, a company_admin learned nothing after
// submitting: not that their file loaded, and — worse — not that it had
// been returned or rejected, or why.
//
// 🔴 A MAIL FAILURE MUST NOT FAIL THE ACTION, AND MUST NOT LOOK LIKE A
// SUCCESS EITHER. That is the whole shape of this module. Every send is
// attempted AFTER the action has committed, nothing here throws, and the
// outcome is written to the batch so the queue can say "loaded ·
// notification failed: {reason}". A best-effort send reported as
// success is the sweep-class-8 defect; a best-effort send that silently
// records nothing is the same defect with better manners.
//
// 🔴 THE OUTCOME VOCABULARY IS THREE-VALUED PLUS ONE, NOT A BOOLEAN.
// sendCompanyScopedEmail answers 'sent' | 'overridden' | 'failed',
// because a test or demo tenant's mail is redirected to
// EMAIL_OVERRIDE_TO and marked "[TEST → original@address]". Collapsing
// that into sent/not-sent would report every demo load as mail
// delivered to a CA who was never written to. 'skipped' is ours: there
// was no recipient to write to at all.
//
// 🔴 NO FALLBACK RECIPIENT FOR THE OPERATOR COPY. Defaulting to
// support@ would route operator notifications into the B2B support
// queue, which is worse than a send that visibly did not happen — the
// load would look notified and nobody would be looking. Same ruling as
// /api/leads. Unset means 'skipped' and the reason names the variable.

export type NotifyOutcome = 'sent' | 'overridden' | 'failed' | 'skipped'

/**
 * Where a reply to a CA-facing batch email goes.
 *
 * 🔴 THE COPY PROMISES A REPLY AND THE FROM CANNOT TAKE ONE. These
 * emails are sent from noreply@mail.shieldmylot.com — a Resend sending
 * subdomain with no inbox — while the reject copy says "reply to this
 * message and we will take another look". Without this header that
 * reply bounces or vanishes, which is worse than not inviting one.
 *
 * support@, not hello@: the recipient is a company administrator, so
 * this is B2B correspondence. hello@ is the public/marketing address.
 *
 * Set on the CA's mail only. The operator copy goes to us; a reply
 * address on it would point Jose at his own support queue.
 */
const CA_REPLY_TO = 'support@shieldmylot.com'

/** Central time, because "same day" in this product means the property's day. */
function central(iso: string | null | undefined): string {
  if (!iso) return 'an unrecorded time'
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short',
  }) + ' Central'
}

const esc = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * One plain shell for all four mails. Deliberately NOT DunningChrome:
 * that carries an account-status block, a billing support line and a
 * manage-preferences footer, none of which belong on "your file
 * loaded".
 */
function shell(heading: string, paragraphs: string[]): string {
  const body = paragraphs.map(p => `<p style="margin:0 0 14px;line-height:1.6">${p}</p>`).join('')
  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1a1a1a;max-width:560px">',
    `<h1 style="font-size:18px;margin:0 0 16px">${esc(heading)}</h1>`,
    body,
    '<p style="margin:24px 0 0;font-size:12px;color:#777">ShieldMyLot</p>',
    '</div>',
  ].join('')
}

export interface BatchForNotify {
  id: number
  company_id: number
  property_id: number
  company_name: string
  property_name: string
  source_filename: string | null
  attested_by_user_id: string | null
  attested_name: string | null
  attested_title: string | null
  attested_at: string | null
  approved_by: string | null
  approved_at: string | null
  loaded_at: string | null
}

type Admin = ReturnType<typeof createSupabaseServiceClient>

/** The submitting CA's address, from the id the attestation recorded. */
async function submitterEmail(db: Admin, userId: string | null): Promise<string | null> {
  if (!userId) return null
  try {
    const { data, error } = await db.auth.admin.getUserById(userId)
    if (error) return null
    return (data?.user?.email ?? '').trim() || null
  } catch { return null }
}

/**
 * Write what happened. 🔴 Never throws: this runs after the action
 * committed, and a failure to record a failure must not turn a loaded
 * batch into a 500.
 */
async function record(
  db: Admin, batchId: number,
  outcomes: { ca?: NotifyOutcome; admin?: NotifyOutcome; error?: string | null },
): Promise<void> {
  try {
    const patch: Record<string, unknown> = { notified_at: new Date().toISOString() }
    if (outcomes.ca !== undefined) patch.notify_ca_outcome = outcomes.ca
    if (outcomes.admin !== undefined) patch.notify_admin_outcome = outcomes.admin
    // Truncated: this column is read in a queue cell, not a log viewer.
    if (outcomes.error !== undefined) patch.notify_error = outcomes.error ? outcomes.error.slice(0, 500) : null
    const up = await db.from('import_batches').update(patch).eq('id', batchId)
    if (up.error) console.error(`[import-batch-notify] could not record outcome on batch ${batchId}:`, up.error.message)
  } catch (e) {
    console.error(`[import-batch-notify] recording threw for batch ${batchId}:`, (e as Error).message)
  }
}

/** Send, and never let a send throw into the caller. */
async function trySend(args: {
  to: string | null
  subject: string
  html: string
  companyId: number
  label: string
  /** Omitted for the operator copy; see CA_REPLY_TO. */
  replyTo?: string
}): Promise<{ outcome: NotifyOutcome; error: string | null }> {
  if (!args.to) return { outcome: 'skipped', error: null }
  try {
    const r = await sendCompanyScopedEmail({
      to: args.to,
      subject: args.subject,
      html: args.html,
      ...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
      // 🔴 The BATCH'S company, never the recipient's. The operator copy
      // goes to an address that belongs to no company, so anchoring on
      // the reader would resolve to company-not-found and the demo
      // redirect would never fire — a demo load would mail the operator
      // as though it were production traffic.
      companyAnchor: { kind: 'company_id', companyId: args.companyId },
    })
    if (!r.ok) {
      console.error(`[import-batch-notify] ${args.label} failed:`, r.error)
      return { outcome: 'failed', error: r.error ?? 'the mail provider refused the send' }
    }
    return { outcome: r.outcome === 'overridden' ? 'overridden' : 'sent', error: null }
  } catch (e) {
    // getResend() throws when RESEND_API_KEY is unset. sendEmail already
    // catches that, but this module must hold even if a future send path
    // does not.
    const msg = (e as Error).message
    console.error(`[import-batch-notify] ${args.label} threw:`, msg)
    return { outcome: 'failed', error: msg }
  }
}

/** The operator copies. Comma-separated; one send per recipient. */
function operatorRecipients(): string[] {
  return (process.env.IMPORT_BATCH_ALERT_EMAIL ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
}

// ── a successful load ───────────────────────────────────────────────
export async function notifyBatchLoaded(
  batch: BatchForNotify,
  counts: { residents: number; vehicles: number },
): Promise<void> {
  const db = createSupabaseServiceClient()
  const errors: string[] = []

  // ── the company_admin who submitted it ───────────────────────────
  const caTo = await submitterEmail(db, batch.attested_by_user_id)
  const ca = await trySend({
    to: caTo,
    companyId: batch.company_id,
    label: `batch ${batch.id} CA`,
    replyTo: CA_REPLY_TO,
    subject: `Your resident file for ${batch.property_name} is loaded`,
    html: shell(`Your file for ${batch.property_name} is loaded`, [
      `We loaded <strong>${counts.residents} resident${counts.residents === 1 ? '' : 's'}</strong> and <strong>${counts.vehicles} vehicle${counts.vehicles === 1 ? '' : 's'}</strong> from ${esc(batch.source_filename ?? 'your file')}.`,
      `Residents can now set up their own login using the <strong>Login Setup QR code</strong> at ${esc(batch.property_name)}.`,
      // 🔴 Said plainly, because the opposite is the reasonable
      // assumption. A CA who believes 200 residents were just emailed
      // will field calls that are not coming, or worse, will not put
      // the QR code up.
      `<strong>Nobody has been emailed.</strong> Residents set up their login themselves, from the flyer or the QR code — loading the file does not contact them.`,
    ]),
  })
  if (ca.error) errors.push(`CA: ${ca.error}`)
  if (!caTo) errors.push('CA: the submitting account has no email address on file')

  // ── the operator copy ────────────────────────────────────────────
  const to = operatorRecipients()
  let admin: NotifyOutcome = 'skipped'
  if (to.length === 0) {
    errors.push('operator: IMPORT_BATCH_ALERT_EMAIL is not set, so no operator copy was attempted')
  } else {
    const approver = await submitterEmail(db, batch.approved_by)
    const html = shell(`Batch #${batch.id} loaded`, [
      `<strong>${esc(batch.company_name)}</strong> / <strong>${esc(batch.property_name)}</strong> — ${counts.residents} resident${counts.residents === 1 ? '' : 's'}, ${counts.vehicles} vehicle${counts.vehicles === 1 ? '' : 's'}.`,
      `Submitted by ${esc(batch.attested_name ?? 'an unnamed submitter')}, ${esc(batch.attested_title ?? 'no title given')} (${esc(caTo ?? 'no email on file')}) at ${central(batch.attested_at)}.`,
      `Approved by ${esc(approver ?? 'an unresolved account')} at ${central(batch.approved_at)}.`,
      `Loaded at ${central(batch.loaded_at)}. <strong>Same-day rollback is available until midnight Central.</strong>`,
    ])
    const results: NotifyOutcome[] = []
    for (const one of to) {
      const r = await trySend({ to: one, companyId: batch.company_id, label: `batch ${batch.id} operator`,
        subject: `Batch #${batch.id} loaded: ${batch.company_name} / ${batch.property_name}`, html })
      results.push(r.outcome)
      if (r.error) errors.push(`operator ${one}: ${r.error}`)
    }
    // 🔴 The worst outcome wins. Two recipients where one failed is not
    // a success, and reporting the best of them is how a half-sent
    // notification reads as sent.
    admin = results.includes('failed') ? 'failed'
      : results.includes('skipped') ? 'skipped'
      : results.includes('overridden') ? 'overridden' : 'sent'
  }

  await record(db, batch.id, { ca: ca.outcome, admin, error: errors.length ? errors.join(' · ') : null })
}

// ── returned to the company, or rejected ────────────────────────────
export async function notifyBatchDecision(
  batch: BatchForNotify,
  decision: { kind: 'returned' | 'rejected'; reason: string; errorCount?: number | null },
): Promise<void> {
  const db = createSupabaseServiceClient()
  const errors: string[] = []
  const caTo = await submitterEmail(db, batch.attested_by_user_id)

  const returned = decision.kind === 'returned'
  const n = decision.errorCount ?? 0
  const paragraphs = returned
    ? [
        `Your file for <strong>${esc(batch.property_name)}</strong> needs changes before it can load, so we have sent it back to you.`,
        n > 0
          ? `There ${n === 1 ? 'is' : 'are'} <strong>${n} row${n === 1 ? '' : 's'}</strong> to fix. Sign in and open Resident upload — the row numbers match the row numbers in your spreadsheet, and you can download the list.`
          : `Sign in and open Resident upload for the details.`,
        `<strong>What we were told:</strong> ${esc(decision.reason)}`,
        `Fix those rows and upload the file again. Nothing has been loaded, and no resident has been contacted.`,
      ]
    : [
        `Your file for <strong>${esc(batch.property_name)}</strong> was not loaded.`,
        `<strong>Reason:</strong> ${esc(decision.reason)}`,
        `Nothing was loaded and no resident has been contacted. If this looks wrong, reply to this message and we will take another look.`,
      ]

  const ca = await trySend({
    to: caTo,
    companyId: batch.company_id,
    label: `batch ${batch.id} CA ${decision.kind}`,
    replyTo: CA_REPLY_TO,
    subject: returned
      ? `Your resident file for ${batch.property_name} needs changes`
      : `Your resident file for ${batch.property_name} was not loaded`,
    html: shell(returned ? 'Your file needs a few changes' : 'Your file was not loaded', paragraphs),
  })
  if (ca.error) errors.push(`CA: ${ca.error}`)
  if (!caTo) errors.push('CA: the submitting account has no email address on file')

  await record(db, batch.id, { ca: ca.outcome, error: errors.length ? errors.join(' · ') : null })
}

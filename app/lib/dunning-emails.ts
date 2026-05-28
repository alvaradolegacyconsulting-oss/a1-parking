import 'server-only'
import * as React from 'react'
import { render } from '@react-email/components'
import { createSupabaseServiceClient } from './supabase-admin'
import { sendEmail } from './resend-client'
import { TIER_DISPLAY_NAME, type TierType } from './tier-config'
import { DunningDay0 } from '../emails/DunningDay0'
import { DunningDay3 } from '../emails/DunningDay3'
import { DunningDay5 } from '../emails/DunningDay5'
import { DunningDay7 } from '../emails/DunningDay7'
import { DunningRecovery } from '../emails/DunningRecovery'
import { DunningCancellation } from '../emails/DunningCancellation'

// B66.5 commit 4.2 — Dunning email orchestration.
//
// SINGLE-PLACE-OF-TRUTH for sending the 6 dunning lifecycle emails.
// Webhook handlers + cron sweep call into the per-stage functions below
// rather than rendering + sending inline. Why:
//   • Centralizes the send + dedup-write + audit-log triplet pattern
//   • Centralizes recipient resolution (all CAs, deduped by email)
//   • Centralizes failure-mode handling (3 distinct modes — send fail,
//     dedup write fail, dedup verify mismatch)
//   • Single swap point if we change template wiring or recipient logic
//
// FAILURE MODES — three discrete cases handled by sendToCA below:
//
//   1. Send failure (Resend returns error OR throws)
//      → Audit: DUNNING_EMAIL_SEND_FAILED
//      → Dedup timestamp: UNTOUCHED
//      → Next cron iteration retries within the stage's natural window
//        (per H.4 fail-soft policy from greenlight). Upper-bound retry
//        is enforced by the stage scan's predicate (e.g., Day 3 scan
//        only fires when past_due_since <= NOW() - 3d AND
//        dunning_day3_sent_at IS NULL).
//
//   2. Dedup write failure AFTER successful send
//      → Audit: DUNNING_EMAIL_DEDUP_WRITE_FAILED
//      → Dedup timestamp: still NULL → next cron will re-send (duplicate
//        to CA)
//      → Accept the duplicate as lesser evil than crashing the handler.
//
//   3. Dedup verify-after-write mismatch
//      → Same as case 2: audit DUNNING_EMAIL_DEDUP_WRITE_FAILED.
//
// MULTI-CA RECIPIENT SEMANTICS (H.2 lock — all CAs):
// If a company has multiple company_admin user_roles, the email fires to
// ALL of them (deduped by lowercased email). The dedup timestamp is
// marked if AT LEAST ONE CA's send succeeded. Rare edge case: if 1 CA's
// send fails while N-1 succeed, the failed CA never gets that stage's
// email (the stage's scan predicate no longer matches on next iteration
// because dedup is marked). Acceptable trade-off for v1; a future
// per-CA tracking table would close this gap if customer demand surfaces.

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'
const UPDATE_PAYMENT_URL = `${APP_URL}/company_admin?tab=billing`

// Audit action constants — single source of truth.
export const DUNNING_AUDIT_ACTIONS = {
  DAY_0_SENT: 'DUNNING_EMAIL_DAY_0_SENT',
  DAY_3_SENT: 'DUNNING_EMAIL_DAY_3_SENT',
  DAY_5_SENT: 'DUNNING_EMAIL_DAY_5_SENT',
  DAY_7_SENT: 'DUNNING_EMAIL_DAY_7_SENT',
  RECOVERY_SENT: 'DUNNING_EMAIL_RECOVERY_SENT',
  CANCELLATION_SENT: 'DUNNING_EMAIL_CANCELLATION_SENT',
  SEND_FAILED: 'DUNNING_EMAIL_SEND_FAILED',
  DEDUP_WRITE_FAILED: 'DUNNING_EMAIL_DEDUP_WRITE_FAILED',
} as const

// Per-stage column name on companies for dedup. Type-safe; prevents typo
// from sneaking through.
type DunningStageColumn =
  | 'dunning_day0_sent_at'
  | 'dunning_day3_sent_at'
  | 'dunning_day5_sent_at'
  | 'dunning_day7_sent_at'
  | 'dunning_recovery_sent_at'
  | 'dunning_cancellation_sent_at'

export interface DunningCompany {
  id: number
  name: string
  display_name: string | null
  tier: string | null
  tier_type: string | null
}

export type DunningSource = 'cron' | 'webhook'

export interface SendStageResult {
  recipients_attempted: number
  recipients_sent: number
  recipients_failed: number
  dedup_written: boolean
  skipped_dedup: boolean  // true if the dedup gate caught an already-sent stage
}

// ════════════════════════════════════════════════════════════════════
// Recipient resolver
// ════════════════════════════════════════════════════════════════════
// All CAs for the company, deduped by lowercased email. Returns empty
// array on lookup failure (caller treats as 0 recipients — no send +
// no audit; the company-level audit for the state transition still
// fires upstream, so the missing email is visible in forensics by
// absence of DUNNING_EMAIL_*_SENT entries).

export async function resolveRecipients(companyName: string): Promise<string[]> {
  const supabase = createSupabaseServiceClient()
  const { data: rows, error } = await supabase
    .from('user_roles')
    .select('email')
    .eq('role', 'company_admin')
    .ilike('company', companyName)

  if (error || !rows) {
    console.error('[dunning-emails] resolveRecipients failed', {
      companyName, error: error?.message ?? 'no data',
    })
    return []
  }

  const seen = new Set<string>()
  const deduped: string[] = []
  for (const row of rows) {
    if (!row.email) continue
    const key = String(row.email).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(String(row.email))
  }
  return deduped
}

// ════════════════════════════════════════════════════════════════════
// Internal helpers
// ════════════════════════════════════════════════════════════════════

function buildChromeProps(company: DunningCompany, recipient_email: string) {
  const tierTypeKey = ((company.tier_type as string) || 'enforcement') as TierType
  const tier_display = TIER_DISPLAY_NAME[tierTypeKey]?.[String(company.tier)] ?? String(company.tier ?? 'Unknown')
  return {
    company_name: company.display_name ?? company.name,
    tier_display,
    recipient_email,
  }
}

function systemUserFor(source: DunningSource): string {
  return source === 'cron' ? 'system@cron-dunning' : 'system@stripe-webhook'
}

interface SendToCAArgs {
  company: DunningCompany
  recipient_email: string
  subject: string
  html: string
  source: DunningSource
  sentAuditAction: string
  stageLabel: string
  extraNewValues?: Record<string, unknown>
}

interface SendToCAResult {
  sent: boolean
  resend_message_id?: string
}

// Send to a single CA + emit the success/failure audit. Does NOT touch
// the dedup column — that's the caller's responsibility AFTER all CAs
// have been attempted (mark dedup if any CA's send succeeded).
async function sendToCA(args: SendToCAArgs): Promise<SendToCAResult> {
  const supabase = createSupabaseServiceClient()
  const systemUser = systemUserFor(args.source)

  const sendResult = await sendEmail({
    to: args.recipient_email,
    subject: args.subject,
    html: args.html,
  })

  if (!sendResult.ok) {
    await supabase.from('audit_logs').insert({
      user_email: systemUser,
      action: DUNNING_AUDIT_ACTIONS.SEND_FAILED,
      table_name: 'companies',
      record_id: String(args.company.id),
      new_values: {
        stage: args.stageLabel,
        recipient_email: args.recipient_email,
        error: sendResult.error,
        ...args.extraNewValues,
      },
    })
    return { sent: false }
  }

  await supabase.from('audit_logs').insert({
    user_email: systemUser,
    action: args.sentAuditAction,
    table_name: 'companies',
    record_id: String(args.company.id),
    new_values: {
      stage: args.stageLabel,
      resend_message_id: sendResult.message_id,
      recipient_email: args.recipient_email,
      ...args.extraNewValues,
    },
  })

  return { sent: true, resend_message_id: sendResult.message_id }
}

// Dedup write + verify-after-write. Returns true on clean write+verify;
// false on either failure (caller doesn't need to distinguish — both
// land an audit and accept the potential duplicate next cron run).
async function writeDedupTimestamp(
  company: DunningCompany,
  column: DunningStageColumn,
  source: DunningSource,
  stageLabel: string,
): Promise<boolean> {
  const supabase = createSupabaseServiceClient()
  const systemUser = systemUserFor(source)
  const nowIso = new Date().toISOString()

  const { error: updErr } = await supabase
    .from('companies')
    .update({ [column]: nowIso })
    .eq('id', company.id)

  if (updErr) {
    console.error('[dunning-emails] dedup write failed (UPDATE)', {
      companyId: company.id, stage: stageLabel, column, error: updErr.message,
    })
    await supabase.from('audit_logs').insert({
      user_email: systemUser,
      action: DUNNING_AUDIT_ACTIONS.DEDUP_WRITE_FAILED,
      table_name: 'companies',
      record_id: String(company.id),
      new_values: {
        stage: stageLabel,
        column,
        error: updErr.message,
        note: 'UPDATE failed; email already sent; next cron may re-send (duplicate)',
      },
    })
    return false
  }

  // Verify-after-write — F6 discipline.
  const { data: verifyRow, error: verifyErr } = await supabase
    .from('companies')
    .select(column)
    .eq('id', company.id)
    .maybeSingle()

  // verifyRow's column field is dynamic — narrow defensively.
  const verifiedValue = verifyRow ? (verifyRow as Record<string, unknown>)[column] : null

  if (verifyErr || !verifiedValue) {
    console.error('[dunning-emails] dedup verify-after-write mismatch', {
      companyId: company.id, stage: stageLabel, column,
      error: verifyErr?.message ?? 'verified value null/absent',
    })
    await supabase.from('audit_logs').insert({
      user_email: systemUser,
      action: DUNNING_AUDIT_ACTIONS.DEDUP_WRITE_FAILED,
      table_name: 'companies',
      record_id: String(company.id),
      new_values: {
        stage: stageLabel,
        column,
        verify_error: verifyErr?.message ?? null,
        verified_value: verifiedValue,
        note: 'verify mismatch; email already sent; next cron may re-send (duplicate)',
      },
    })
    return false
  }

  return true
}

// Common per-stage flow: send to each CA (recipients pre-resolved by
// caller) → mark dedup if any send succeeded → return summary.
//
// Returns { skipped_dedup: true } early if dedup column is already set
// on the company row (idempotency gate).
//
// Note: recipients resolved by the per-stage public function (single
// fetch). Passing them in here avoids a second DB round-trip.
async function dispatchStage(args: {
  company: DunningCompany
  recipients: string[]
  source: DunningSource
  dedupColumn: DunningStageColumn
  alreadySent: boolean
  subject: string
  html: string
  sentAuditAction: string
  stageLabel: string
  extraNewValues?: Record<string, unknown>
}): Promise<SendStageResult> {
  if (args.alreadySent) {
    return {
      recipients_attempted: 0,
      recipients_sent: 0,
      recipients_failed: 0,
      dedup_written: false,
      skipped_dedup: true,
    }
  }

  if (args.recipients.length === 0) {
    console.warn('[dunning-emails] no recipients for company', {
      companyId: args.company.id, stage: args.stageLabel,
    })
    return {
      recipients_attempted: 0,
      recipients_sent: 0,
      recipients_failed: 0,
      dedup_written: false,
      skipped_dedup: false,
    }
  }

  let sent = 0
  let failed = 0
  for (const recipient of args.recipients) {
    const result = await sendToCA({
      company: args.company,
      recipient_email: recipient,
      subject: args.subject,
      html: args.html,
      source: args.source,
      sentAuditAction: args.sentAuditAction,
      stageLabel: args.stageLabel,
      extraNewValues: args.extraNewValues,
    })
    if (result.sent) sent++
    else failed++
  }

  let dedupWritten = false
  if (sent > 0) {
    dedupWritten = await writeDedupTimestamp(
      args.company, args.dedupColumn, args.source, args.stageLabel
    )
  }

  return {
    recipients_attempted: args.recipients.length,
    recipients_sent: sent,
    recipients_failed: failed,
    dedup_written: dedupWritten,
    skipped_dedup: false,
  }
}

// Helper: per-stage early-exit when no recipients found (no work to do).
const NO_RECIPIENTS: SendStageResult = {
  recipients_attempted: 0,
  recipients_sent: 0,
  recipients_failed: 0,
  dedup_written: false,
  skipped_dedup: false,
}

// Helper: per-stage skipped-dedup shape.
const SKIPPED_DEDUP: SendStageResult = {
  recipients_attempted: 0,
  recipients_sent: 0,
  recipients_failed: 0,
  dedup_written: false,
  skipped_dedup: true,
}

// ════════════════════════════════════════════════════════════════════
// Per-stage public API
// ════════════════════════════════════════════════════════════════════
// Each function:
//   1. Takes a company row + source + stage-specific params
//   2. Renders the template once (recipients share same content)
//   3. Dispatches via dispatchStage which handles recipients, send,
//      dedup, audit
//
// Callers pass `alreadySent` based on the relevant dunning_*_sent_at
// column they read at row-fetch time. This avoids re-fetching the
// company row inside this module — the caller already has it.

// Per-stage flow shared by all 6 public functions:
//   1. Dedup gate via alreadySent → return SKIPPED_DEDUP
//   2. Resolve recipients once → return NO_RECIPIENTS if empty
//   3. Render template once (all CAs share same content; chrome footer
//      shows the first recipient's email — slight imperfection, v1
//      acceptable. Refactor if multi-CA reports surface confusion.)
//   4. dispatchStage handles per-CA send + dedup write + audit

export async function sendDunningDay0(
  company: DunningCompany,
  alreadySent: boolean,
  source: DunningSource,
  invoiceId: string | null,
): Promise<SendStageResult> {
  if (alreadySent) return SKIPPED_DEDUP
  const recipients = await resolveRecipients(company.name)
  if (recipients.length === 0) {
    console.warn('[dunning-emails] day0: no recipients', { companyId: company.id })
    return NO_RECIPIENTS
  }
  const html = await render(
    React.createElement(DunningDay0, {
      ...buildChromeProps(company, recipients[0]),
      update_payment_url: UPDATE_PAYMENT_URL,
    })
  )
  return dispatchStage({
    company,
    recipients,
    source,
    dedupColumn: 'dunning_day0_sent_at',
    alreadySent: false,
    subject: `Payment failed for ${company.display_name ?? company.name}`,
    html,
    sentAuditAction: DUNNING_AUDIT_ACTIONS.DAY_0_SENT,
    stageLabel: 'day0',
    extraNewValues: { stripe_invoice_id: invoiceId },
  })
}

export async function sendDunningDay3(
  company: DunningCompany,
  alreadySent: boolean,
  daysRemainingUntilSuspension: number,
): Promise<SendStageResult> {
  if (alreadySent) return SKIPPED_DEDUP
  const recipients = await resolveRecipients(company.name)
  if (recipients.length === 0) return NO_RECIPIENTS
  const html = await render(
    React.createElement(DunningDay3, {
      ...buildChromeProps(company, recipients[0]),
      days_remaining_until_suspension: daysRemainingUntilSuspension,
      update_payment_url: UPDATE_PAYMENT_URL,
    })
  )
  return dispatchStage({
    company,
    recipients,
    source: 'cron',
    dedupColumn: 'dunning_day3_sent_at',
    alreadySent: false,
    subject: `Action needed: ${company.display_name ?? company.name} payment past due`,
    html,
    sentAuditAction: DUNNING_AUDIT_ACTIONS.DAY_3_SENT,
    stageLabel: 'day3',
    extraNewValues: { days_remaining_until_suspension: daysRemainingUntilSuspension },
  })
}

export async function sendDunningDay5(
  company: DunningCompany,
  alreadySent: boolean,
  daysRemainingUntilSuspension: number,
): Promise<SendStageResult> {
  if (alreadySent) return SKIPPED_DEDUP
  const recipients = await resolveRecipients(company.name)
  if (recipients.length === 0) return NO_RECIPIENTS
  const html = await render(
    React.createElement(DunningDay5, {
      ...buildChromeProps(company, recipients[0]),
      days_remaining_until_suspension: daysRemainingUntilSuspension,
      update_payment_url: UPDATE_PAYMENT_URL,
    })
  )
  return dispatchStage({
    company,
    recipients,
    source: 'cron',
    dedupColumn: 'dunning_day5_sent_at',
    alreadySent: false,
    // "compact, no awkward verb phrasing" subject per greenlight option (1).
    subject: `${company.display_name ?? company.name}: ${daysRemainingUntilSuspension} days until suspension`,
    html,
    sentAuditAction: DUNNING_AUDIT_ACTIONS.DAY_5_SENT,
    stageLabel: 'day5',
    extraNewValues: { days_remaining_until_suspension: daysRemainingUntilSuspension },
  })
}

export async function sendDunningDay7(
  company: DunningCompany,
  alreadySent: boolean,
): Promise<SendStageResult> {
  if (alreadySent) return SKIPPED_DEDUP
  const recipients = await resolveRecipients(company.name)
  if (recipients.length === 0) return NO_RECIPIENTS
  const html = await render(
    React.createElement(DunningDay7, {
      ...buildChromeProps(company, recipients[0]),
      update_payment_url: UPDATE_PAYMENT_URL,
    })
  )
  return dispatchStage({
    company,
    recipients,
    source: 'cron',
    dedupColumn: 'dunning_day7_sent_at',
    alreadySent: false,
    subject: `${company.display_name ?? company.name} subscription suspended`,
    html,
    sentAuditAction: DUNNING_AUDIT_ACTIONS.DAY_7_SENT,
    stageLabel: 'day7',
  })
}

export async function sendDunningRecovery(
  company: DunningCompany,
  alreadySent: boolean,
  invoiceId: string | null,
  previousState: string,
): Promise<SendStageResult> {
  if (alreadySent) return SKIPPED_DEDUP
  const recipients = await resolveRecipients(company.name)
  if (recipients.length === 0) return NO_RECIPIENTS
  const html = await render(
    React.createElement(DunningRecovery, buildChromeProps(company, recipients[0]))
  )
  return dispatchStage({
    company,
    recipients,
    source: 'webhook',
    dedupColumn: 'dunning_recovery_sent_at',
    alreadySent: false,
    subject: `Payment received — ${company.display_name ?? company.name} restored`,
    html,
    sentAuditAction: DUNNING_AUDIT_ACTIONS.RECOVERY_SENT,
    stageLabel: 'recovery',
    extraNewValues: { stripe_invoice_id: invoiceId, previous_state: previousState },
  })
}

export async function sendDunningCancellation(
  company: DunningCompany,
  alreadySent: boolean,
  stripeSubscriptionId: string | null,
): Promise<SendStageResult> {
  if (alreadySent) return SKIPPED_DEDUP
  const recipients = await resolveRecipients(company.name)
  if (recipients.length === 0) return NO_RECIPIENTS
  const html = await render(
    React.createElement(DunningCancellation, buildChromeProps(company, recipients[0]))
  )
  return dispatchStage({
    company,
    recipients,
    source: 'cron',
    dedupColumn: 'dunning_cancellation_sent_at',
    alreadySent: false,
    subject: `${company.display_name ?? company.name} subscription cancelled`,
    html,
    sentAuditAction: DUNNING_AUDIT_ACTIONS.CANCELLATION_SENT,
    stageLabel: 'cancellation',
    extraNewValues: { stripe_subscription_id: stripeSubscriptionId },
  })
}

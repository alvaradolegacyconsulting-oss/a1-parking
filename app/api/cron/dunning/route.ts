import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import type Stripe from 'stripe'
import { getStripe } from '../../../lib/stripe'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { SUSPENSION_GRACE_MS } from '../../../lib/dunning-config'

// B66.5 commit 3 — hourly dunning cron.
//
// Drives the two grace-clock transitions established by commit 1 schema
// + commit 2 webhook handlers:
//
//   Sweep 1: past_due → suspended
//     Triggered when past_due_grace_until <= NOW(). Local state change
//     only (no Stripe API call — Stripe sub is already 'unpaid' under
//     locked Decision 1B; we just move our local lifecycle stage).
//
//   Sweep 2: suspended → cancelled
//     Triggered when suspension_grace_until <= NOW(). Calls
//     stripe.subscriptions.cancel() FIRST (Decision A — API-DELETE-first
//     ordering), then flips local state. On Stripe success → local
//     UPDATE + verify-after-write + audit. On 'resource_missing' →
//     treat as success (idempotent re-cancel). On other Stripe API
//     failure → audit BILLING_STATE_STRIPE_CANCEL_FAILED + leave row in
//     suspended for next-hour retry.
//
// ── SCHEDULE ────────────────────────────────────────────────────────
// Hourly (vercel.json: "0 * * * *" on Vercel Pro plan; cron fires within
// the minute specified). UTC. Configured in vercel.json crons array.
//
// ── AUTH ────────────────────────────────────────────────────────────
// Vercel auto-sends Authorization: Bearer <CRON_SECRET> on cron-driven
// invocations. Route 401-rejects without a matching header. CRON_SECRET
// must be set on Vercel Production + Preview env scopes.
//
// ── IDEMPOTENCY ─────────────────────────────────────────────────────
// Vercel docs note crons can occasionally deliver the same scheduled
// event twice. SELECT-then-UPDATE-by-id with grace_until predicate is
// naturally idempotent: once state flips, the row no longer matches
// the next sweep's predicate (account_state filter + grace_until <=
// NOW), so a duplicate run finds 0 rows. No SELECT FOR UPDATE lock
// (Decision E). Stripe API DELETE itself is idempotent (resource_missing
// on re-cancel → treated as success).
//
// ── CONTINUE-ON-ERROR ───────────────────────────────────────────────
// Per-row try/catch around all processing. One row's failure (DB error,
// Stripe API error, verify mismatch) never stops the sweep. Errors
// land in audit_logs + structured summary; Vercel function log captures
// the [cron-dunning] prefix for monitoring.
//
// ── DRIFT FROM STRIPE ───────────────────────────────────────────────
// If Stripe API DELETE succeeds but our local UPDATE fails, the webhook
// (customer.subscription.deleted fires from Stripe's processing of the
// API DELETE) self-heals via the existing handleSubscriptionDeleted
// handler. No data loss — local state catches up via the webhook path.

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

interface SweepSummary {
  past_due_to_suspended: {
    candidates: number
    transitioned: number
    errors: number
    verify_mismatches: number
  }
  suspended_to_cancelled: {
    candidates: number
    transitioned: number
    errors: number
    verify_mismatches: number
    stripe_cancel_failures: number
  }
}

// Stripe SDK error shape — `code` lives directly on the StripeError
// subclass for invalid_request errors; `raw.code` is the underlying
// API response code. Defensive read covers both.
function readStripeErrorCode(err: unknown): string | null {
  if (err === null || typeof err !== 'object') return null
  const e = err as { code?: unknown; raw?: { code?: unknown } }
  if (typeof e.code === 'string') return e.code
  if (e.raw && typeof e.raw.code === 'string') return e.raw.code
  return null
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // ── Auth ───────────────────────────────────────────────────────────
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createSupabaseServiceClient()
  const summary: SweepSummary = {
    past_due_to_suspended: { candidates: 0, transitioned: 0, errors: 0, verify_mismatches: 0 },
    suspended_to_cancelled: { candidates: 0, transitioned: 0, errors: 0, verify_mismatches: 0, stripe_cancel_failures: 0 },
  }

  // ══════════════════════════════════════════════════════════════════
  // SWEEP 1 — past_due → suspended
  // ══════════════════════════════════════════════════════════════════
  // Uses companies_past_due_grace_idx (partial index from commit 1
  // PART 5; WHERE account_state = 'past_due') — query predicate matches
  // index predicate so planner uses the partial index directly.

  const sweepStartIso = new Date().toISOString()
  const { data: pastDueRows, error: pdLookupErr } = await supabase
    .from('companies')
    .select('id, past_due_grace_until')
    .eq('account_state', 'past_due')
    .lte('past_due_grace_until', sweepStartIso)

  if (pdLookupErr) {
    console.error('[cron-dunning] past_due sweep lookup failed', { error: pdLookupErr.message })
    return NextResponse.json(
      { ok: false, summary, stage: 'past_due_lookup', error: pdLookupErr.message },
      { status: 500 }
    )
  }

  summary.past_due_to_suspended.candidates = pastDueRows?.length ?? 0

  for (const row of pastDueRows ?? []) {
    try {
      const nowIso = new Date().toISOString()
      const graceIso = new Date(Date.now() + SUSPENSION_GRACE_MS).toISOString()

      const { error: updErr } = await supabase
        .from('companies')
        .update({
          account_state: 'suspended',
          suspension_since: nowIso,
          suspension_grace_until: graceIso,
        })
        .eq('id', row.id)

      if (updErr) {
        console.error('[cron-dunning] past_due→suspended UPDATE failed', {
          companyId: row.id, error: updErr.message,
        })
        summary.past_due_to_suspended.errors++
        continue
      }

      // Verify-after-write — F6 discipline. Re-read the row + confirm
      // all 3 columns landed in their target states.
      const { data: verifyRow, error: verifyErr } = await supabase
        .from('companies')
        .select('account_state, suspension_since, suspension_grace_until')
        .eq('id', row.id)
        .maybeSingle()

      if (verifyErr || !verifyRow
        || verifyRow.account_state !== 'suspended'
        || !verifyRow.suspension_since
        || !verifyRow.suspension_grace_until) {
        console.error('[cron-dunning] past_due→suspended verify-after-write mismatch', {
          companyId: row.id, verifyRow, error: verifyErr?.message ?? null,
        })
        await supabase.from('audit_logs').insert({
          user_email: 'system@cron-dunning',
          action: 'BILLING_STATE_VERIFY_MISMATCH',
          table_name: 'companies',
          record_id: String(row.id),
          new_values: {
            intended_transition: 'past_due_to_suspended',
            verifyRow,
            verify_error: verifyErr?.message ?? null,
          },
        })
        summary.past_due_to_suspended.verify_mismatches++
        continue
      }

      await supabase.from('audit_logs').insert({
        user_email: 'system@cron-dunning',
        action: 'BILLING_STATE_SUSPENDED',
        table_name: 'companies',
        record_id: String(row.id),
        new_values: {
          account_state: 'suspended',
          suspension_since: nowIso,
          suspension_grace_until: graceIso,
        },
      })

      summary.past_due_to_suspended.transitioned++
    } catch (e) {
      console.error('[cron-dunning] past_due→suspended row processing exception', {
        companyId: row.id, error: (e as Error).message,
      })
      summary.past_due_to_suspended.errors++
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SWEEP 2 — suspended → cancelled
  // ══════════════════════════════════════════════════════════════════
  // Uses companies_suspension_grace_idx (partial index from commit 1
  // PART 5; WHERE account_state = 'suspended'). Each row: API-DELETE-
  // first (Decision A) then local UPDATE + verify + audit.

  const { data: suspendedRows, error: suspLookupErr } = await supabase
    .from('companies')
    .select('id, stripe_subscription_id, suspension_grace_until')
    .eq('account_state', 'suspended')
    .lte('suspension_grace_until', new Date().toISOString())

  if (suspLookupErr) {
    console.error('[cron-dunning] suspended sweep lookup failed', { error: suspLookupErr.message })
    return NextResponse.json(
      { ok: false, summary, stage: 'suspended_lookup', error: suspLookupErr.message },
      { status: 500 }
    )
  }

  summary.suspended_to_cancelled.candidates = suspendedRows?.length ?? 0

  // Lazy-init Stripe client only when we have cancellation work to do.
  // getStripe() throws on missing STRIPE_MODE / STRIPE_TEST_SECRET_KEY
  // env vars; lazy-init lets the cron succeed with 0 candidates even
  // if Stripe env config is broken (we still want the sweep summary).
  let stripe: Stripe | null = null

  for (const row of suspendedRows ?? []) {
    try {
      // Defensive: a row in 'suspended' should always have a Stripe
      // subscription ID (B66.3 webhook creates with it; B66.5 dunning
      // arrives only after invoice events fired against that sub). But
      // if somehow missing, log + audit + skip rather than crash.
      if (!row.stripe_subscription_id) {
        console.error('[cron-dunning] suspended row missing stripe_subscription_id; skipping', {
          companyId: row.id,
        })
        await supabase.from('audit_logs').insert({
          user_email: 'system@cron-dunning',
          action: 'BILLING_STATE_STRIPE_CANCEL_FAILED',
          table_name: 'companies',
          record_id: String(row.id),
          new_values: {
            reason: 'missing stripe_subscription_id; cannot DELETE; row left in suspended',
          },
        })
        summary.suspended_to_cancelled.stripe_cancel_failures++
        continue
      }

      if (!stripe) stripe = getStripe()

      // Decision A — Stripe API DELETE first.
      let stripeCancelOk = false
      try {
        await stripe.subscriptions.cancel(row.stripe_subscription_id)
        stripeCancelOk = true
      } catch (e) {
        const code = readStripeErrorCode(e)
        if (code === 'resource_missing') {
          // Idempotent re-cancel: subscription already gone in Stripe
          // (prior cron run succeeded but local UPDATE failed; manual
          // Dashboard cancel; etc.). Safe to proceed to local UPDATE.
          console.log('[cron-dunning] stripe subscription already gone; treating as success', {
            companyId: row.id, subId: row.stripe_subscription_id,
          })
          stripeCancelOk = true
        } else {
          const msg = (e as Error)?.message ?? 'unknown'
          console.error('[cron-dunning] stripe.subscriptions.cancel failed', {
            companyId: row.id,
            subId: row.stripe_subscription_id,
            code,
            message: msg,
          })
          await supabase.from('audit_logs').insert({
            user_email: 'system@cron-dunning',
            action: 'BILLING_STATE_STRIPE_CANCEL_FAILED',
            table_name: 'companies',
            record_id: String(row.id),
            new_values: {
              stripe_subscription_id: row.stripe_subscription_id,
              stripe_code: code,
              stripe_message: msg,
              reason: 'Stripe API error; row left in suspended for next-hour retry',
            },
          })
          summary.suspended_to_cancelled.stripe_cancel_failures++
          continue
        }
      }

      if (!stripeCancelOk) continue  // Belt-and-suspenders; logically unreachable.

      // Local UPDATE — mirrors handleSubscriptionDeleted's UPDATE shape
      // for consistency. The webhook handler will arrive shortly after
      // Stripe processes our API DELETE; it does an idempotent UPDATE
      // to the same columns + same target values, so no race.
      const { error: updErr } = await supabase
        .from('companies')
        .update({
          account_state: 'cancelled',
          subscription_status: 'canceled',  // Stripe's spelling on status
          cancel_at_period_end: false,
        })
        .eq('id', row.id)

      if (updErr) {
        // Local UPDATE failed AFTER Stripe cancel succeeded. Stripe sub
        // is already gone; webhook (customer.subscription.deleted) will
        // fire and self-heal local state to 'cancelled' via the existing
        // handler. Audit-log for forensic visibility.
        console.error('[cron-dunning] suspended→cancelled UPDATE failed post-Stripe-cancel', {
          companyId: row.id, error: updErr.message,
        })
        await supabase.from('audit_logs').insert({
          user_email: 'system@cron-dunning',
          action: 'BILLING_STATE_VERIFY_MISMATCH',
          table_name: 'companies',
          record_id: String(row.id),
          new_values: {
            intended_transition: 'suspended_to_cancelled',
            stage: 'local-update-failed-post-stripe-cancel',
            error: updErr.message,
            note: 'Stripe sub already canceled; webhook will self-heal local state',
          },
        })
        summary.suspended_to_cancelled.errors++
        continue
      }

      // Verify-after-write — confirm account_state landed.
      const { data: verifyRow, error: verifyErr } = await supabase
        .from('companies')
        .select('account_state, subscription_status, cancel_at_period_end')
        .eq('id', row.id)
        .maybeSingle()

      if (verifyErr || !verifyRow || verifyRow.account_state !== 'cancelled') {
        console.error('[cron-dunning] suspended→cancelled verify-after-write mismatch', {
          companyId: row.id, verifyRow, error: verifyErr?.message ?? null,
        })
        await supabase.from('audit_logs').insert({
          user_email: 'system@cron-dunning',
          action: 'BILLING_STATE_VERIFY_MISMATCH',
          table_name: 'companies',
          record_id: String(row.id),
          new_values: {
            intended_transition: 'suspended_to_cancelled',
            stage: 'verify',
            verifyRow,
            verify_error: verifyErr?.message ?? null,
          },
        })
        summary.suspended_to_cancelled.verify_mismatches++
        continue
      }

      await supabase.from('audit_logs').insert({
        user_email: 'system@cron-dunning',
        action: 'BILLING_STATE_CANCELLED',
        table_name: 'companies',
        record_id: String(row.id),
        new_values: {
          account_state: 'cancelled',
          stripe_subscription_id: row.stripe_subscription_id,
          stripe_cancel_status: 'ok',
        },
      })

      summary.suspended_to_cancelled.transitioned++
    } catch (e) {
      console.error('[cron-dunning] suspended→cancelled row processing exception', {
        companyId: row.id, error: (e as Error).message,
      })
      summary.suspended_to_cancelled.errors++
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // End-of-run structured summary
  // ══════════════════════════════════════════════════════════════════
  // Both sweeps complete. Summary lands in Vercel function logs with
  // [cron-dunning] prefix for monitoring; JSON response body returns
  // the same structure for ad-hoc curl introspection.
  console.log('[cron-dunning] sweep complete', summary)

  return NextResponse.json({ ok: true, summary })
}

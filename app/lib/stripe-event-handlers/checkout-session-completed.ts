import 'server-only'
import type Stripe from 'stripe'
import { createSupabaseServiceClient } from '../supabase-admin'
import { getStripe } from '../stripe'
import { sendEmail } from '../resend-client'
import type { HandlerResult } from './types'

interface IntendedTier {
  track: 'enforcement' | 'property_management'
  tier: 'starter' | 'growth' | 'legacy' | 'essential' | 'professional' | 'enterprise'
  cycle: 'monthly' | 'annual'
  property_count: number
  driver_count: number
  company_name: string
}

// ════════════════════════════════════════════════════════════════════
// B152 — eager-populate the 8 fields normally written by sibling
// handlers (customer.subscription.created/updated, customer.updated).
// Removes dependency on Stripe webhook arrival order — the row lands
// with all 16 fields populated at INSERT/UPDATE time, regardless of
// whether sibling events have arrived yet.
//
// Sibling handlers (handleSubscriptionUpdated, handleCustomerUpdated)
// remain wired (B151 dispatch entry + existing entries). They become
// idempotent UPDATE-on-match: when they arrive after eager-populate,
// they overwrite with the same values (no-op state-wise). When they
// arrive before checkout.session.completed has INSERTed the row, they
// SKIP cleanly (no harm — eager will fill on INSERT). The race is
// neutralized by construction.
//
// Graceful degradation: Stripe API retrieve calls are wrapped. If the
// API hiccups, fields fall back to null and the INSERT still lands
// with the core 8 fields. Sibling handlers will backfill from the
// actual webhook events when those events fire. Worst case = current
// pre-B152 behavior, which is the safety floor.
// ════════════════════════════════════════════════════════════════════
interface EagerFields {
  subscription_status: string | null
  current_period_end: string | null
  cancel_at_period_end: boolean | null
  address: string | null
  billing_city: string | null
  billing_state: string | null
  billing_postal_code: string | null
  billing_country: string | null
}
// B164 — semantic equality for timestamptz round-trip. JS Date → ISO
// produces '2026-07-07T23:37:08.000Z'; Postgres timestamptz read-back
// produces '2026-07-07T23:37:08+00:00'. Identical instant, different
// string form. Naive === false-positives on every signup. Compare via
// epoch ms. Falls back to string equality if either side fails to
// parse (NaN), so a genuine mismatch (null vs undefined vs malformed
// string) still surfaces rather than silently passing.
function timestampMatches(expected: unknown, actual: unknown): boolean {
  if (expected === null && actual === null) return true
  if (expected === null || actual === null) return false
  const e = typeof expected === 'string' ? Date.parse(expected) : NaN
  const a = typeof actual === 'string' ? Date.parse(actual) : NaN
  if (Number.isNaN(e) || Number.isNaN(a)) return expected === actual
  return e === a
}

const EAGER_NULL: EagerFields = {
  subscription_status: null,
  current_period_end: null,
  cancel_at_period_end: null,
  address: null,
  billing_city: null,
  billing_state: null,
  billing_postal_code: null,
  billing_country: null,
}

async function fetchEagerFields(
  stripeSubId: string,
  stripeCustomerId: string,
): Promise<EagerFields> {
  try {
    const stripe = getStripe()
    const [sub, customer] = await Promise.all([
      stripe.subscriptions.retrieve(stripeSubId, { expand: ['items.data'] }),
      stripe.customers.retrieve(stripeCustomerId),
    ])
    // current_period_end lives on items.data[0] per the API version that
    // moved it off the Subscription root. Mirrors subscription-updated.ts.
    const firstItem = sub.items?.data?.[0]
    const cpeIso = firstItem?.current_period_end
      ? new Date(firstItem.current_period_end * 1000).toISOString()
      : null
    // Customer may rarely come back as a DeletedCustomer if the customer
    // was deleted between session completion and our retrieve. Type-narrow.
    const addr = ('address' in customer && !('deleted' in customer && customer.deleted))
      ? customer.address
      : null
    return {
      subscription_status: sub.status,
      current_period_end: cpeIso,
      cancel_at_period_end: sub.cancel_at_period_end,
      address: addr?.line1 ?? null,
      billing_city: addr?.city ?? null,
      billing_state: addr?.state ?? null,
      billing_postal_code: addr?.postal_code ?? null,
      billing_country: addr?.country ?? null,
    }
  } catch (e) {
    // Graceful degradation per Jose's build discipline: don't let a Stripe
    // API hiccup abort the whole INSERT. Sibling handlers backfill.
    console.error('[checkout-session-completed] B152 eager-populate Stripe retrieve failed — falling back to null fields; sibling handlers will backfill:', (e as Error).message)
    return EAGER_NULL
  }
}

export async function handleCheckoutSessionCompleted(
  event: Stripe.CheckoutSessionCompletedEvent,
): Promise<HandlerResult> {
  const session = event.data.object
  const supabase = createSupabaseServiceClient()

  // ── Idempotency probe ──────────────────────────────────────────────
  // If a prior webhook delivery already updated/created the company for
  // this session, the stripe_subscription_id on companies will match. Skip.
  const stripeSubId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id ?? null
  if (stripeSubId) {
    const { data: existing } = await supabase
      .from('companies')
      .select('id')
      .eq('stripe_subscription_id', stripeSubId)
      .maybeSingle()
    if (existing) {
      return { ok: true, companyId: existing.id as number }
    }
  }

  // ── B66.7 — proposal-code discriminator ─────────────────────────────
  // Two code paths share this handler, distinguished by session.metadata:
  //   • proposal_code_id PRESENT → company already created by
  //     redeem_proposal_code RPC; webhook UPDATEs existing companies row
  //     with stripe_customer_id + stripe_subscription_id.
  //   • proposal_code_id ABSENT → self-serve path (existing B66.3
  //     behavior); webhook CREATES new companies row + user_roles row.
  // The proposal-code path's metadata is set in
  // app/api/proposal-codes/start-billing/route.ts at Checkout Session
  // create time.
  const meta = session.metadata ?? {}
  const proposalCodeIdRaw = meta.proposal_code_id
  if (proposalCodeIdRaw) {
    return handleProposalCodeCompletion(supabase, session, proposalCodeIdRaw, stripeSubId)
  }

  // ── Read session metadata (set by /api/signup/create-checkout-session) ─
  const userId = meta.supabase_user_id
  const intendedTierJson = meta.intended_tier_json
  if (!userId || !intendedTierJson) {
    return { ok: false, reason: 'session metadata missing supabase_user_id or intended_tier_json' }
  }
  let intendedTier: IntendedTier
  try {
    intendedTier = JSON.parse(intendedTierJson) as IntendedTier
  } catch {
    return { ok: false, reason: 'session metadata intended_tier_json is not valid JSON' }
  }

  const stripeCustomerId = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id ?? null
  if (!stripeCustomerId || !stripeSubId) {
    return { ok: false, reason: 'session missing customer or subscription ID (incomplete checkout?)' }
  }

  // ── Resolve caller email (for user_roles.email) ────────────────────
  const { data: authUser, error: authErr } = await supabase.auth.admin.getUserById(userId)
  if (authErr || !authUser?.user?.email) {
    return { ok: false, reason: `cannot resolve auth user ${userId}: ${authErr?.message ?? 'no email'}` }
  }
  const email = authUser.user.email.toLowerCase()

  // ── B2-1 C2: uniqueness pre-check moved pre-payment ──────────────
  // The old app-layer " (N)" disambiguation loop retired here (2026-
  // 07-21). Silent post-payment rename was worse than a stack trace —
  // a customer who signed up as "Acme" would be provisioned as
  // "Acme (2)" without consent, then land in a dashboard for a
  // company they didn't name. Pre-flight uniqueness now lives in
  // /api/signup/create-checkout-session via company_name_available
  // RPC (B2-1 C1, eea9f61). Any duplicate that reaches THIS INSERT
  // is either a true race between two simultaneous checkouts or a
  // pre-flight fail-open (RPC transient error). Both surface via
  // handleProvisioningFailure() below — logs to provisioning_failures
  // + emails ops with a runbook.
  const companyName = intendedTier.company_name.trim()

  // ── B152 eager-populate ──────────────────────────────────────────
  // Retrieve sub + customer from Stripe API BEFORE the INSERT so we
  // can land all 16 fields atomically. See the header block above for
  // the race-neutralization rationale.
  const eager = await fetchEagerFields(stripeSubId, stripeCustomerId)

  // ── INSERT companies row ──────────────────────────────────────────
  const { data: company, error: companyErr } = await supabase
    .from('companies')
    .insert({
      name: companyName,
      tier_type: intendedTier.track,
      tier: intendedTier.tier,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubId,
      acquisition_channel: 'self_serve',
      account_state: 'active',
      is_active: true,
      // B152 — race-resistant initial state.
      subscription_status: eager.subscription_status,
      current_period_end: eager.current_period_end,
      cancel_at_period_end: eager.cancel_at_period_end,
      address: eager.address,
      billing_city: eager.billing_city,
      billing_state: eager.billing_state,
      billing_postal_code: eager.billing_postal_code,
      billing_country: eager.billing_country,
    })
    .select('id, subscription_status, current_period_end, cancel_at_period_end, address, billing_city, billing_state, billing_postal_code, billing_country')
    .single()
  if (companyErr || !company) {
    // B2-1 C2 — failure mode #1: companies INSERT failed. No row
    // exists; name is FREE. Email runbook: provision normally.
    return await handleProvisioningFailure({
      supabase,
      stripeSessionId: session.id,
      stripeCustomerId,
      stripeSubscriptionId: stripeSubId,
      requestedCompanyName: companyName,
      intendedTier,
      errCode: companyErr?.code ?? null,
      errMessage: companyErr?.message ?? 'companies INSERT returned no row',
      failureMode: 'companies_insert',
    })
  }
  const companyId = company.id as number

  // Verify-after-write per F6 — eager fields should round-trip.
  // Mismatch indicates DB-side weirdness; log but continue (sibling
  // handlers will overwrite with the canonical Stripe values).
  // B164 — semantic compare on current_period_end (timestamptz string
  // form differs Stripe-ISO vs Postgres-read-back); B152 → B153 tag fix
  // (verify-after-write was added in B153, never updated).
  for (const k of ['subscription_status','current_period_end','cancel_at_period_end','address','billing_city','billing_state','billing_postal_code','billing_country'] as const) {
    const expected = eager[k]
    const actual = (company as Record<string, unknown>)[k]
    const matches = k === 'current_period_end'
      ? timestampMatches(expected, actual)
      : expected === actual
    if (!matches) {
      console.error('[checkout-session-completed] B153 verify mismatch', { companyId, field: k, expected, actual })
    }
  }

  // ── INSERT user_roles row (company_admin, no property scope) ───────
  const { error: roleErr } = await supabase
    .from('user_roles')
    .insert({
      email,
      role: 'company_admin',
      company: companyName,
      property: [],
    })
  if (roleErr) {
    // B2-1 C2 — failure mode #2: companies row EXISTS but user_roles
    // INSERT failed. Orphaned company (row holds the name with no CA).
    // Second orphan class (see
    // docs/backlog/orphaned-auth-users-after-name-collision.md for
    // the first, auth.users-orphan variant). Email runbook says
    // ADOPT the orphan — do NOT create a new company (would collide
    // on companies_name_lower_unique).
    return await handleProvisioningFailure({
      supabase,
      stripeSessionId: session.id,
      stripeCustomerId,
      stripeSubscriptionId: stripeSubId,
      requestedCompanyName: companyName,
      intendedTier,
      errCode: roleErr.code ?? null,
      errMessage: roleErr.message,
      failureMode: 'user_roles_insert',
      orphanedCompanyId: companyId,
    })
  }

  return { ok: true, companyId }
}

// ════════════════════════════════════════════════════════════════════
// B66.7 — proposal-code completion path
// ════════════════════════════════════════════════════════════════════
// Discriminator: session.metadata.proposal_code_id present.
//
// At this point the company already exists (created by
// redeem_proposal_code RPC at /signup/redeem/verify submit-time, with
// account_state='active', user_roles row attached, ToS captured).
// Webhook's job is narrow: attach Stripe IDs to the existing companies
// row. No company creation, no user_roles creation, no name
// disambiguation — those all happened before Checkout was even reached.
//
// Verify-after-write (per B66.5 F6 discipline): re-SELECT the updated
// columns to confirm the UPDATE landed. A silent UPDATE failure here
// would leave A1 paying via Stripe but with no DB linkage — invisible
// until B66.4 Portal embed renders blank or dunning can't find them.
async function handleProposalCodeCompletion(
  supabase: ReturnType<typeof createSupabaseServiceClient>,
  session: Stripe.Checkout.Session,
  proposalCodeIdRaw: string,
  stripeSubId: string | null,
): Promise<HandlerResult> {
  const proposalCodeId = Number(proposalCodeIdRaw)
  if (!Number.isInteger(proposalCodeId)) {
    return { ok: false, reason: `metadata.proposal_code_id is not an integer: ${proposalCodeIdRaw}` }
  }

  const companyIdRaw = session.metadata?.company_id
  if (!companyIdRaw) {
    return { ok: false, reason: 'metadata missing company_id (proposal-code path requires it)' }
  }
  const companyId = Number(companyIdRaw)
  if (!Number.isInteger(companyId)) {
    return { ok: false, reason: `metadata.company_id is not an integer: ${companyIdRaw}` }
  }

  const stripeCustomerId = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id ?? null
  if (!stripeCustomerId || !stripeSubId) {
    return { ok: false, reason: 'session missing customer or subscription ID (incomplete checkout?)' }
  }

  // ── B152 eager-populate (proposal-code path) ───────────────────────
  // Same rationale as the self-serve branch: race-resistant initial state.
  // A1's actual production path is proposal-code, so this branch is the
  // load-bearing one for the first real customer.
  const eager = await fetchEagerFields(stripeSubId, stripeCustomerId)

  // ── UPDATE the existing companies row with Stripe IDs + eager fields ─
  const { error: updErr } = await supabase
    .from('companies')
    .update({
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubId,
      // B152 — race-resistant initial state.
      subscription_status: eager.subscription_status,
      current_period_end: eager.current_period_end,
      cancel_at_period_end: eager.cancel_at_period_end,
      address: eager.address,
      billing_city: eager.billing_city,
      billing_state: eager.billing_state,
      billing_postal_code: eager.billing_postal_code,
      billing_country: eager.billing_country,
    })
    .eq('id', companyId)
  if (updErr) {
    return { ok: false, reason: `companies UPDATE failed for proposal-code path (company ${companyId}): ${updErr.message}` }
  }

  // ── Verify-after-write (F6 discipline) ─────────────────────────────
  // RLS bypass via service_role makes this a straight SELECT; the silent
  // failure mode we're guarding is "UPDATE matched zero rows" (e.g.,
  // company_id from metadata doesn't exist), which Postgres reports as
  // success on the UPDATE call itself.
  const { data: verify, error: verifyErr } = await supabase
    .from('companies')
    .select('id, stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end, cancel_at_period_end, address, billing_city, billing_state, billing_postal_code, billing_country')
    .eq('id', companyId)
    .maybeSingle()
  if (verifyErr || !verify) {
    return { ok: false, reason: `verify-after-write failed (company ${companyId}): ${verifyErr?.message ?? 'row not found'}` }
  }
  if (verify.stripe_customer_id !== stripeCustomerId || verify.stripe_subscription_id !== stripeSubId) {
    return {
      ok: false,
      reason: `verify-after-write mismatch: expected customer=${stripeCustomerId} sub=${stripeSubId}, got customer=${verify.stripe_customer_id} sub=${verify.stripe_subscription_id}`,
    }
  }
  // B153 — verify-after-write on the eager fields. Log but don't fail
  // (sibling handlers will overwrite). B164 fixed the timestamp-equality
  // false-positive on current_period_end (timestamptz round-trip
  // '.000Z' vs '+00:00' differ as strings but match as instants); also
  // fixed the stale B152 log tag → B153 (the verify-after-write was
  // added in B153, never relabeled).
  for (const k of ['subscription_status','current_period_end','cancel_at_period_end','address','billing_city','billing_state','billing_postal_code','billing_country'] as const) {
    const expected = eager[k]
    const actual = (verify as Record<string, unknown>)[k]
    const matches = k === 'current_period_end'
      ? timestampMatches(expected, actual)
      : expected === actual
    if (!matches) {
      console.error('[checkout-session-completed] B153 proposal-code verify mismatch', { companyId, field: k, expected, actual })
    }
  }

  console.log('[stripe-event-handlers] proposal-code completion linked', {
    companyId, proposalCodeId, stripeCustomerId, stripeSubId,
  })
  return { ok: true, companyId }
}

// ════════════════════════════════════════════════════════════════════
// B2-1 C2 — provisioning failure handling
// ════════════════════════════════════════════════════════════════════
// Retires the app-layer " (N)" disambiguation loop that silently
// appended suffixes to colliding company names POST-PAYMENT. When any
// self-serve INSERT fails after Stripe has charged the customer, we
// now log to provisioning_failures + alert ops via email. Two failure
// modes covered — with materially different recovery runbooks:
//
//   companies_insert   — companies INSERT failed. NO company row exists.
//                        Name is FREE. Runbook: provision normally.
//
//   user_roles_insert  — companies row created, user_roles INSERT
//                        failed. Company row EXISTS holding the name
//                        with no admin (CA). Runbook: ADOPT the orphan
//                        (attach CA to existing orphanedCompanyId — do
//                        NOT create a new company; that would collide
//                        on companies_name_lower_unique and cause a
//                        confusing dead end while trying to fix this).
//
// Email body branches on failureMode so support follows the correct
// runbook. orphanedCompanyId is included prominently in the
// user_roles_insert branch body.
//
// ── SECOND ORPHAN CLASS ─────────────────────────────────────────────
// The user_roles_insert branch creates an orphaned companies row (no
// CA attached) — a second orphan class alongside the auth.users
// orphan documented in
// docs/backlog/orphaned-auth-users-after-name-collision.md.
// Same operational shape (stranded mid-provisioning, invisible until
// someone looks); different mechanism. The deferred Commit 3
// admin_console reconciliation panel should address both classes in
// one surface.
//
// ── PERMANENT vs TRANSIENT (B2-7 forward-compat) ────────────────────
// Machine-readable classification lives on the provisioning_failures
// row via error_code (Postgres SQLSTATE) — no ambiguous prose. The
// helper isPermanentProvisioningFailure() below encodes the semantic
// mapping ('23505' = permanent unique_violation; else = transient).
//
// Today the wrapper (app/api/stripe/webhook/route.ts:202-206) always
// returns 200 to Stripe (B66.1 fail-closed), so Stripe never retries.
// The disambig-loop retry storm concern doesn't fire via Stripe.
//
// BUT: B2-7 will add an out-of-band webhook processor with real
// retries. When that lands, the processor MUST NOT retry a
// permanent failure (23505 will 23505 forever — the colliding row
// isn't going anywhere). isPermanentProvisioningFailure() is the
// contract: B2-7 imports it, branches retry logic on the result.
// Semantics baked in HERE at the point of failure — B2-7 inherits
// them rather than re-deriving from error strings months later.
//
// ── SESSION-GUARD ────────────────────────────────────────────────────
// Before INSERT + email, check for an existing provisioning_failures
// row with the same stripe_session_id. If exists, ack-and-drop (no
// new row, no new email). Belt-and-suspenders today (stripe_events
// UNIQUE catches most redelivery at the route layer + manual Stripe
// Dashboard redelivery is rare). Load-bearing when B2-7 async retries
// land.

/**
 * Machine-readable classification of a provisioning_failures.error_code.
 * Consumed by B2-7 (out-of-band webhook processor) to decide retryability.
 *
 * - permanent — do not retry, ever. Structural collision that only
 *               human intervention can resolve. Today only '23505'
 *               (unique_violation on companies_name_lower_unique).
 * - transient — retry safe. Connection blip, timeout, or other transient
 *               DB issue. Any error_code that isn't in the permanent
 *               set (or NULL) is treated as transient.
 *
 * The mapping lives HERE (with the write path that populated error_code)
 * so a future consumer doesn't re-derive semantics from error strings.
 */
export function isPermanentProvisioningFailure(errorCode: string | null | undefined): boolean {
  return errorCode === '23505'
}

interface ProvisioningFailureArgs {
  supabase:               ReturnType<typeof createSupabaseServiceClient>
  stripeSessionId:        string
  stripeCustomerId:       string | null
  stripeSubscriptionId:   string | null
  requestedCompanyName:   string
  intendedTier:           IntendedTier
  errCode:                string | null
  errMessage:             string
  failureMode:            'companies_insert' | 'user_roles_insert'
  orphanedCompanyId?:     number
}

async function handleProvisioningFailure(args: ProvisioningFailureArgs): Promise<HandlerResult> {
  const {
    supabase, stripeSessionId, stripeCustomerId, stripeSubscriptionId,
    requestedCompanyName, intendedTier, errCode, errMessage,
    failureMode, orphanedCompanyId,
  } = args

  const permanent      = isPermanentProvisioningFailure(errCode)
  const classification = permanent ? 'permanent' : 'transient'

  // ── Session-guard ────────────────────────────────────────────────
  // Belt-and-suspenders check for double-logging. Route layer's
  // stripe_events UNIQUE constraint catches most redelivery cases at
  // the event-id level, but manual Stripe Dashboard redelivery + the
  // future B2-7 async retry pass could reach here twice for the same
  // session. If a row already exists for this session, ack-and-drop
  // (no new row, no new email).
  const { data: existing } = await supabase
    .from('provisioning_failures')
    .select('id')
    .eq('stripe_session_id', stripeSessionId)
    .maybeSingle()
  if (existing) {
    console.log('[checkout-session-completed] provisioning_failures row already exists for session — no new row, no new alert', {
      stripeSessionId, existingId: existing.id, failureMode,
    })
    return {
      ok: false,
      reason: `provisioning_failed_${classification}_${failureMode}_already_logged (row ${existing.id})`,
    }
  }

  // ── INSERT the failure record ────────────────────────────────────
  // 🔴 IMPORTANT: this INSERT is its own Supabase-JS-client round-trip,
  // NOT part of a transaction with the failed write that triggered
  // this handler. Do NOT bundle these INSERTs into a single BEGIN/
  // COMMIT — the classic error-logging bug is "log inside the aborted
  // transaction → log rolls back with the failure." Supabase JS
  // client makes each call its own txn, so this is safe TODAY, but
  // this comment is deliberate: someone will one day try to
  // "optimize" this into a single txn and silently reintroduce the
  // bug. (Codified per Mateo 2026-07-21 review.)
  const { data: failRow, error: failInsertErr } = await supabase
    .from('provisioning_failures')
    .insert({
      stripe_session_id:      stripeSessionId,
      stripe_customer_id:     stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      requested_company_name: requestedCompanyName,
      error_code:             errCode,
      error_message:          errMessage,
      raw_intended_tier:      intendedTier as unknown as Record<string, unknown>,
    })
    .select('id')
    .single()

  let failRowId: number | null = null
  if (failInsertErr) {
    // Log-then-continue: the alert email is the customer's only path
    // to being noticed. If we can't log to our own table, we still
    // MUST fire the alert.
    console.error('[checkout-session-completed] CRITICAL: provisioning_failures INSERT failed — customer paid, no account, no ops row. Alert email is only trail:', {
      stripeSessionId, failInsertErr: failInsertErr.message,
    })
  } else if (failRow) {
    failRowId = failRow.id as number
  }

  // ── Send alert email to ops ──────────────────────────────────────
  const alertTo   = process.env.PROVISIONING_ALERT_EMAIL || 'support@shieldmylot.com'
  const emailBody = buildProvisioningFailureEmailBody({
    failRowId, classification, stripeSessionId, stripeCustomerId,
    stripeSubscriptionId, requestedCompanyName, intendedTier,
    errCode, errMessage, failureMode, orphanedCompanyId,
  })
  const subjectCore = failureMode === 'user_roles_insert'
    ? 'Provisioning failure — ADOPT ORPHAN'
    : 'Provisioning failure — customer paid, no account'
  const sendResult = await sendEmail({
    to:      alertTo,
    subject: `[ShieldMyLot] ${subjectCore} (${requestedCompanyName})`,
    html:    emailBody.html,
    text:    emailBody.text,
  })

  // ── Best-effort update of alert send result on the row ────────────
  if (failRowId !== null) {
    const { error: updateErr } = await supabase
      .from('provisioning_failures')
      .update({
        alert_email_sent:       sendResult.ok,
        alert_email_message_id: sendResult.ok ? sendResult.message_id : null,
        alert_email_error:      sendResult.ok ? null : sendResult.error,
      })
      .eq('id', failRowId)
    if (updateErr) {
      console.error('[checkout-session-completed] alert_email_sent update failed on provisioning_failures row', {
        failRowId, err: updateErr.message,
      })
    }
  }

  console.log('[checkout-session-completed] provisioning failure logged', {
    stripeSessionId, failRowId, errCode, classification, failureMode, alertSent: sendResult.ok,
  })

  return {
    ok:     false,
    reason: `provisioning_failed_${classification}_${failureMode} (row ${failRowId ?? 'unlogged'}, code ${errCode ?? 'null'}): ${errMessage}`,
  }
}

interface ProvisioningEmailBodyArgs {
  failRowId:              number | null
  classification:         'permanent' | 'transient'
  stripeSessionId:        string
  stripeCustomerId:       string | null
  stripeSubscriptionId:   string | null
  requestedCompanyName:   string
  intendedTier:           IntendedTier
  errCode:                string | null
  errMessage:             string
  failureMode:            'companies_insert' | 'user_roles_insert'
  orphanedCompanyId?:     number
}

function buildProvisioningFailureEmailBody(args: ProvisioningEmailBodyArgs): { html: string, text: string } {
  const {
    failRowId, classification, stripeSessionId, stripeCustomerId, stripeSubscriptionId,
    requestedCompanyName, intendedTier, errCode, errMessage, failureMode, orphanedCompanyId,
  } = args

  const isAdopt = failureMode === 'user_roles_insert'

  // Two distinct runbooks — the difference matters. See the
  // handler's header block for why.
  const nextSteps = isAdopt
    ? `NEXT STEPS (adopt orphan — do NOT create a new company):

  1. A companies row with id=${orphanedCompanyId} EXISTS and holds the
     name "${requestedCompanyName}" with no admin (CA) attached. Do NOT
     attempt to create a new company for this customer — that will
     collide on companies_name_lower_unique and fail.

  2. INSERT the CA into user_roles keyed on the customer's email +
     company="${requestedCompanyName}" + role="company_admin". Match
     the email against Stripe customer ${stripeCustomerId ?? '(unknown)'}
     for verification.

  3. The customer's Stripe subscription (${stripeSubscriptionId ?? '(unknown)'})
     is already attached to companies row ${orphanedCompanyId} via the
     Stripe fields — no additional linking needed.

  4. Stamp provisioning_failures.resolved=TRUE + resolved_by=<your email>
     + resolved_notes describing the adoption for the ops record.`
    : `NEXT STEPS (companies row absent — provision normally):

  1. No companies row was created for this customer. Name
     "${requestedCompanyName}" is FREE — OR belongs to a different
     existing customer if this is a true collision. Verify with:
       SELECT id, name FROM companies WHERE lower(trim(name)) = lower(trim($1));

  2. If the name collides with someone else, contact the customer to
     confirm a distinguishing variant OR verify this is their existing
     account (account recovery flow).

  3. If safe to provision: manually INSERT the companies row +
     user_roles row, then UPDATE with
     stripe_customer_id=${stripeCustomerId ?? '(unknown)'} +
     stripe_subscription_id=${stripeSubscriptionId ?? '(unknown)'}.

  4. Alternatively refund the Stripe charge via Dashboard and cancel
     the subscription if provisioning cannot proceed.

  5. Stamp provisioning_failures.resolved=TRUE + resolved_by=<your email>
     + resolved_notes describing the resolution.`

  const text = [
    `Provisioning failure — self-serve checkout webhook`,
    ``,
    `Classification: ${classification.toUpperCase()} (error_code=${errCode ?? 'null'})`,
    `Failure mode:   ${failureMode}`,
    ``,
    `Requested company name: ${requestedCompanyName}`,
    isAdopt ? `Orphaned company id:    ${orphanedCompanyId}` : `(no company row created)`,
    ``,
    `Stripe session:      ${stripeSessionId}`,
    `Stripe customer:     ${stripeCustomerId ?? '(unknown)'}`,
    `Stripe subscription: ${stripeSubscriptionId ?? '(unknown)'}`,
    ``,
    `DB error code:    ${errCode ?? '(none)'}`,
    `DB error message: ${errMessage}`,
    ``,
    `Intended tier (raw):`,
    `  track:          ${intendedTier.track}`,
    `  tier:           ${intendedTier.tier}`,
    `  cycle:          ${intendedTier.cycle}`,
    `  property_count: ${intendedTier.property_count}`,
    `  driver_count:   ${intendedTier.driver_count}`,
    ``,
    nextSteps,
    ``,
    `provisioning_failures.id: ${failRowId ?? '(row insert failed — this email is the only record)'}`,
  ].join('\n')

  const html = `<!DOCTYPE html>
<html>
<body style="font-family: system-ui, -apple-system, Arial, sans-serif; max-width: 640px; margin: 20px auto; padding: 20px; color: #0a0d14;">
<h2 style="color: #b71c1c; margin-top: 0;">Provisioning failure — self-serve checkout</h2>
<p style="background: ${isAdopt ? '#fff8e1' : '#f5f5f5'}; padding: 10px 14px; border-left: 4px solid ${isAdopt ? '#f57c00' : '#9e9e9e'}; margin: 12px 0;">
  <strong>${classification.toUpperCase()}</strong> failure mode <code>${failureMode}</code>${isAdopt ? ' &mdash; <strong>ADOPT ORPHAN</strong>, do not create a new company.' : ''}
</p>
<table style="border-collapse: collapse; width: 100%; margin: 12px 0;">
  <tr><td style="padding: 4px 8px; color: #64748b;">Requested company name</td><td style="padding: 4px 8px;"><strong>${escapeHtml(requestedCompanyName)}</strong></td></tr>
  ${isAdopt ? `<tr><td style="padding: 4px 8px; color: #64748b;">Orphaned company id</td><td style="padding: 4px 8px; background: #fff8e1;"><strong style="color: #b71c1c;">${orphanedCompanyId}</strong></td></tr>` : ''}
  <tr><td style="padding: 4px 8px; color: #64748b;">Stripe session</td><td style="padding: 4px 8px; font-family: monospace; font-size: 12px;">${escapeHtml(stripeSessionId)}</td></tr>
  <tr><td style="padding: 4px 8px; color: #64748b;">Stripe customer</td><td style="padding: 4px 8px; font-family: monospace; font-size: 12px;">${escapeHtml(stripeCustomerId ?? '(unknown)')}</td></tr>
  <tr><td style="padding: 4px 8px; color: #64748b;">Stripe subscription</td><td style="padding: 4px 8px; font-family: monospace; font-size: 12px;">${escapeHtml(stripeSubscriptionId ?? '(unknown)')}</td></tr>
  <tr><td style="padding: 4px 8px; color: #64748b;">DB error code</td><td style="padding: 4px 8px; font-family: monospace;">${escapeHtml(errCode ?? '(none)')}</td></tr>
  <tr><td style="padding: 4px 8px; color: #64748b;">DB error message</td><td style="padding: 4px 8px; font-family: monospace; font-size: 12px;">${escapeHtml(errMessage)}</td></tr>
</table>
<h3 style="margin-top: 20px; margin-bottom: 8px;">Intended tier</h3>
<pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; font-size: 12px; overflow-x: auto;">${escapeHtml(JSON.stringify(intendedTier, null, 2))}</pre>
<h3 style="margin-top: 20px; margin-bottom: 8px;">Next steps</h3>
<pre style="background: #f5f5f5; padding: 10px; border-radius: 4px; font-size: 12px; overflow-x: auto; white-space: pre-wrap;">${escapeHtml(nextSteps)}</pre>
<p style="color: #64748b; font-size: 12px; margin-top: 20px;">
  provisioning_failures.id: <strong>${failRowId ?? '(row insert failed &mdash; this email is the only record)'}</strong>
</p>
</body>
</html>`

  return { html, text }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

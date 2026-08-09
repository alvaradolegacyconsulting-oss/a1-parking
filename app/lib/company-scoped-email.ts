import 'server-only'
import { sendEmail } from './resend-client'
import { createSupabaseServiceClient } from './supabase-admin'
import { escapeIlikeValue } from './supabase-query-escape'

// ══════════════════════════════════════════════════════════════════════
// company-scoped-email — safe-test gate wrapper over sendEmail.
// ══════════════════════════════════════════════════════════════════════
//
// Deactivation-email arc, Commit B (2026-08-09).
//
// Redirects mail for recipients whose company is `test` or `demo` to
// EMAIL_OVERRIDE_TO when that env var is set. Every other recipient —
// including every real production customer — sends normally to the
// intended address.
//
// One deployment, one database, live and test properties side by side.
// A global override would redirect Green Acres along with everything
// else. This gate is row-level: the redirect decision is derived per
// recipient from `companies.company_env` (enum: 'production' | 'test'
// | 'demo'; NOT NULL DEFAULT 'production'). A1 defaulted to
// 'production' at insert by construction.
//
// ── 🔴 SERVICE-ROLE FOR THE ENV LOOKUP (Aug 9 v1.2 fix) ──────────────
//
// Every DB read inside this helper runs under createSupabaseServiceClient.
// The caller does NOT pass in a supabase client.
//
// Reason: the env lookup is an INFRASTRUCTURE routing decision, not
// user data access. If it ran under a request-scoped session client,
// RLS on companies would apply and the resolver would return different
// answers depending on who is logged in. A manager at Test Legacy has
// no relationship to (say) A1's company row; under RLS the join would
// miss silently, the gate would fall through to normal send, and the
// failure mode would look exactly like working code.
//
// This was measured at 13:38 on 2026-08-09: probe 2 (production
// scratch resident whose company was verifiable in SQL) resolved as
// `unresolvable` from the manager session, because the manager
// couldn't see the throwaway company via RLS. Fixed by promoting the
// internal lookups to service_role.
//
// Caller's auth check and RLS-scoped SELECT stay at the CALLER —
// the caller has already established which resident/user this send
// is for. This helper's job is to look up the company_env for that
// recipient, decide the redirect, and delegate to sendEmail.
//
// ── WHAT THIS GATE TRUSTS ────────────────────────────────────────────
//
// (1) companies.company_env is NOT NULL DEFAULT 'production' — real
//     customers default to production at insert.
// (2) No UI code path mutates company_env — grep-confirmed 2026-08-09.
//     Only the seed RPC changes it, and its guard prevents operating on
//     production rows.
// (3) Every miss (missing anchor, unmatched company name, resolver
//     error, N-row divergence) fails open to normal send.
//
// The "no leak of production email to Jose's inbox" property rests on
// (1) and (2). An operator who bypassed the seed RPC's guard to flip a
// production row to 'test' would cause that customer's manager-
// initiated emails to redirect to EMAIL_OVERRIDE_TO until corrected.
// Not a bug in this helper; a note on what this helper trusts.
//
// The seed addresses at Test Legacy Property are Jose's own Gmail
// aliases, so redirected sends to seed residents deliver to Jose.
// **That is a property of the seed data, not a safety property of
// this gate.** If someone reseeds test data with third-party
// addresses, this comment stops being true.
//
// ── WHAT THIS GATE DOES NOT COVER ────────────────────────────────────
//
// Supabase Auth email (confirm-signup, password reset, invite) is
// sent by Supabase over SMTP and NEVER passes through sendEmail. This
// wrapper cannot touch it. EMAIL_OVERRIDE_TO does not affect it.
//
// ── ANCHOR KINDS + MULTIPLICITY (Mateo Aug 9) ────────────────────────
//
// Three anchor kinds. Each resolves through its own table to
// companies.company_env via a `lower(trim())` text join. Text join
// contained in this ONE file — a future property_id/company_id FK
// migration touches only this function.
//
// All ILIKE inputs are escaped via escapeIlikeValue so metachars
// (%, _, \) in a company or property name cannot silently over-match.
// The `__gate_probe_prod_co__` name has six underscores; without
// escaping, each is a single-character wildcard.
//
// Multiplicity table (for every kind):
//   0 rows                            → normal send (anchor-missed)
//   1 row                             → use its company_env
//   N rows, all same company_env      → use it
//   N rows, DIVERGENT company_env     → 🔴 normal send + loud warning
//
// DO NOT `LIMIT 1` in any of the resolvers. That is the shape that
// makes this undefined instead of deterministic, and it looks correct
// in review.
//
// ── HELPER OUTPUT ────────────────────────────────────────────────────
//
// Returns { ok, message_id, outcome, originalTo, actualTo, error? }.
// outcome ∈ 'sent' | 'overridden' | 'failed' — delivery-side ONLY.
// Suppression outcomes (`suppressed-by-reason`, etc.) live at the
// WRITER level, before this helper is ever called. The audit
// vocabulary at the writer stays at 6; the helper's 3 is not the
// audit vocabulary.
// ══════════════════════════════════════════════════════════════════════

const SUBJECT_MARKER_PREFIX = '[TEST → '

export type CompanyAnchor =
  | { kind: 'resident_id';    residentId: string }
  | { kind: 'resident_email'; email: string; property: string }
  | { kind: 'user_email';     email: string }

export type SendCompanyScopedResult = {
  ok:         boolean
  message_id: string | null
  outcome:    'sent' | 'overridden' | 'failed'
  originalTo: string
  actualTo:   string
  error?:     string
}

export type SendCompanyScopedArgs = {
  // NOTE: NO `supabase` parameter. Internal env lookup uses
  // createSupabaseServiceClient (see header). Caller's auth check
  // + RLS-scoped SELECT of the recipient row stays at the caller.
  to:            string
  subject:       string
  from?:         string
  html?:         string
  text?:         string
  companyAnchor: CompanyAnchor
}

// Reason codes for a null env resolution — each maps to a distinct
// log tag so the fail-open branch is diagnosable at a glance.
type ResolveMiss =
  | 'anchor-missed'      // anchor lookup returned 0 rows OR company field was NULL
  | 'company-not-found'  // anchor resolved to a company name but no matching companies row
  | 'resolver-error'     // supabase returned an error at any step
  | 'divergent'          // multiple companies resolved to different envs

type ResolveResult =
  | { env: string;      miss: null }
  | { env: null;        miss: ResolveMiss }

export async function sendCompanyScopedEmail(args: SendCompanyScopedArgs): Promise<SendCompanyScopedResult> {
  const originalTo = args.to
  const overrideTo = process.env.EMAIL_OVERRIDE_TO?.trim() || null

  // Service-role client for internal lookups only. Explicit lazy-init
  // pattern; the caller doesn't see or need to know about this.
  const admin = createSupabaseServiceClient()
  const resolved = await resolveCompanyEnv(admin, args.companyAnchor)

  const env = resolved.env
  const shouldRedirect =
    overrideTo !== null &&
    env !== null &&
    (env === 'test' || env === 'demo')

  const actualTo = shouldRedirect ? overrideTo! : originalTo
  const subject = shouldRedirect
    ? `${SUBJECT_MARKER_PREFIX}${originalTo}] ${args.subject}`
    : args.subject

  const send = await sendEmail({
    to:      actualTo,
    subject,
    from:    args.from,
    ...(args.html !== undefined ? { html: args.html } : {}),
    ...(args.text !== undefined ? { text: args.text } : {}),
  } as Parameters<typeof sendEmail>[0])

  // ── Observability — one distinctive tag per outcome ───────────────
  //
  // Split from a single `unresolvable` tag (v1.1) to distinguish the
  // three ways env can be null — each is a different diagnostic path:
  //
  //   [company-scoped-email:overridden]        redirect fired
  //   [company-scoped-email:passthrough]       normal send, env known
  //   [company-scoped-email:anchor-missed]     anchor returned 0 rows
  //                                            (or company field NULL)
  //   [company-scoped-email:company-not-found] anchor resolved to a
  //                                            company name but no
  //                                            matching companies row
  //                                            (text-join miss)
  //   [company-scoped-email:resolver-error]    supabase returned an
  //                                            error at any step
  //   [company-scoped-email:divergent-envs]    N companies with
  //                                            different envs (already
  //                                            logs its own warning
  //                                            in lookupCompanyEnv)
  //   [company-scoped-email:override-unset]    test/demo env but no
  //                                            EMAIL_OVERRIDE_TO
  //   [company-scoped-email:failed]            sendEmail returned !ok
  const anchorKind = args.companyAnchor.kind
  if (!send.ok) {
    console.error('[company-scoped-email:failed]', {
      anchor:     anchorKind,
      resolved:   { env, miss: resolved.miss, shouldRedirect },
      originalTo, actualTo,
      error:      send.error,
    })
    return {
      ok:         false,
      message_id: null,
      outcome:    'failed',
      originalTo,
      actualTo,
      error:      send.error,
    }
  }

  if (shouldRedirect) {
    console.log('[company-scoped-email:overridden]', {
      anchor: anchorKind, env,
      originalTo, actualTo,
      message_id: send.message_id,
    })
  } else if (env === null) {
    // Split by miss reason. Divergent already logged its own detailed
    // warning in lookupCompanyEnv; we still emit the tag here so the
    // outcome is uniformly discoverable in log search.
    const tag = `[company-scoped-email:${resolved.miss === 'divergent' ? 'divergent-envs' : resolved.miss}]`
    console.log(tag, {
      anchor: anchorKind,
      originalTo, actualTo,
      message_id: send.message_id,
      note: 'env not resolvable; fell through to normal send per fail-open rule. Check the anchor resolution against the expected env.',
    })
  } else if ((env === 'test' || env === 'demo') && !overrideTo) {
    // Env said redirect but no override address set. Send went to
    // real recipient. Loud because a missing env var is easy to miss.
    console.warn('[company-scoped-email:override-unset]', {
      anchor: anchorKind, env,
      originalTo, actualTo,
      message_id: send.message_id,
      note: 'company_env is test/demo but EMAIL_OVERRIDE_TO is not set. Mail delivered to intended recipient (fail-open per policy). Set EMAIL_OVERRIDE_TO in Vercel project scope to redirect.',
    })
  } else {
    console.log('[company-scoped-email:passthrough]', {
      anchor: anchorKind, env,
      originalTo, actualTo,
      message_id: send.message_id,
    })
  }

  return {
    ok:         true,
    message_id: send.message_id,
    outcome:    shouldRedirect ? 'overridden' : 'sent',
    originalTo,
    actualTo,
  }
}

// ══════════════════════════════════════════════════════════════════════
// Anchor resolvers. All under service_role (see header) — RLS
// bypassed intentionally so the routing decision is invariant across
// caller sessions.
// ══════════════════════════════════════════════════════════════════════

type SupabaseServiceClient = ReturnType<typeof createSupabaseServiceClient>

async function resolveCompanyEnv(
  admin: SupabaseServiceClient,
  anchor: CompanyAnchor,
): Promise<ResolveResult> {
  switch (anchor.kind) {
    case 'resident_id':    return resolveByResidentId(admin, anchor.residentId)
    case 'resident_email': return resolveByResidentEmail(admin, anchor.email, anchor.property)
    case 'user_email':     return resolveByUserEmail(admin, anchor.email)
  }
}

async function resolveByResidentId(admin: SupabaseServiceClient, residentId: string): Promise<ResolveResult> {
  const { data, error } = await admin
    .from('residents')
    .select('company')
    .eq('id', residentId)
    .maybeSingle()
  if (error) {
    console.warn('[company-scoped-email:resolver-error-detail]', { anchor: 'resident_id', residentId, error: error.message })
    return { env: null, miss: 'resolver-error' }
  }
  const companyName = (data?.company ?? '').trim()
  if (!companyName) return { env: null, miss: 'anchor-missed' }
  return lookupCompanyEnv(admin, [companyName], { anchor: 'resident_id', context: { residentId } })
}

async function resolveByResidentEmail(admin: SupabaseServiceClient, email: string, property: string): Promise<ResolveResult> {
  const emailKey = email.trim().toLowerCase()
  const propKey  = property.trim()
  if (!emailKey || !propKey) return { env: null, miss: 'anchor-missed' }
  // No LIMIT 1 — the multiplicity table handles N rows explicitly.
  // Escape ILIKE metachars — email local-parts and property names could
  // carry %, _, \ that would silently over-match.
  const { data, error } = await admin
    .from('residents')
    .select('company')
    .ilike('email',    escapeIlikeValue(emailKey))
    .ilike('property', escapeIlikeValue(propKey))
  if (error) {
    console.warn('[company-scoped-email:resolver-error-detail]', { anchor: 'resident_email', email: emailKey, property: propKey, error: error.message })
    return { env: null, miss: 'resolver-error' }
  }
  const companyNames = Array.from(new Set(
    (data ?? []).map(r => ((r as { company: string | null }).company ?? '').trim()).filter(c => c.length > 0)
  ))
  if (companyNames.length === 0) return { env: null, miss: 'anchor-missed' }
  return lookupCompanyEnv(admin, companyNames, { anchor: 'resident_email', context: { email: emailKey, property: propKey } })
}

async function resolveByUserEmail(admin: SupabaseServiceClient, email: string): Promise<ResolveResult> {
  const emailKey = email.trim().toLowerCase()
  if (!emailKey) return { env: null, miss: 'anchor-missed' }
  // No LIMIT 1 — a driver working for two operators has 2 user_roles rows.
  const { data, error } = await admin
    .from('user_roles')
    .select('company')
    .ilike('email', escapeIlikeValue(emailKey))
  if (error) {
    console.warn('[company-scoped-email:resolver-error-detail]', { anchor: 'user_email', email: emailKey, error: error.message })
    return { env: null, miss: 'resolver-error' }
  }
  const companyNames = Array.from(new Set(
    (data ?? []).map(r => ((r as { company: string | null }).company ?? '').trim()).filter(c => c.length > 0)
  ))
  if (companyNames.length === 0) return { env: null, miss: 'anchor-missed' }
  return lookupCompanyEnv(admin, companyNames, { anchor: 'user_email', context: { email: emailKey } })
}

// Lookup company_env for a set of company NAMES (from the anchor
// resolvers). Applies the multiplicity table for the final env
// decision. Small N in practice — 1-2 company names per resolve.
//
// ILIKE input escaped so a company name with `_` or `%` (like
// `__gate_probe_prod_co__` — six underscores, each a single-character
// wildcard) doesn't silently over-match.
async function lookupCompanyEnv(
  admin: SupabaseServiceClient,
  companyNames: string[],
  logCtx: { anchor: string; context: Record<string, unknown> },
): Promise<ResolveResult> {
  const envs = new Set<string>()
  let sawError = false
  let sawAnyRow = false
  for (const name of companyNames) {
    const { data, error } = await admin
      .from('companies')
      .select('company_env')
      .ilike('name', escapeIlikeValue(name))
      .maybeSingle()
    if (error) {
      console.warn('[company-scoped-email:company-lookup-error]', { ...logCtx, company_name: name, error: error.message })
      sawError = true
      continue
    }
    if (data) sawAnyRow = true
    const env = (data as { company_env?: string } | null)?.company_env
    if (env) envs.add(env)
  }
  if (envs.size === 1) return { env: [...envs][0], miss: null }
  if (envs.size >= 2) {
    // 🔴 Divergent envs across the resolved companies. Under Mateo's
    // multiplicity rule, this is normal send + loud warning.
    console.error('[company-scoped-email:divergent-envs]', {
      ...logCtx,
      company_names:    companyNames,
      distinct_envs:    [...envs],
      resolution:       'normal_send',
      explanation:      'Multiple residents/user_roles rows resolved to companies with divergent company_env values. Falling through to normal send — the safe direction under ambiguity per the Aug 9 multiplicity rule.',
    })
    return { env: null, miss: 'divergent' }
  }
  // envs.size === 0 — distinguish company-not-found from resolver-error.
  if (sawError && !sawAnyRow) return { env: null, miss: 'resolver-error' }
  return { env: null, miss: 'company-not-found' }
}

import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from './resend-client'

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
// 'production' at insert by construction (no UI code path mutates
// company_env; only the test-tenant-reset RPC does, and that guard is
// `WHERE name = 'Test-PM' AND company_env = 'test'`).
//
// ── WHAT THIS GATE TRUSTS ────────────────────────────────────────────
//
// (1) companies.company_env is NOT NULL DEFAULT 'production' — real
//     customers default to production at insert.
// (2) No UI code path mutates company_env — grep-confirmed 2026-08-09.
//     Only the seed RPC changes it, and its guard prevents operating on
//     production rows.
// (3) Every miss (NULL company, unmatched name, unknown env, divergent
//     N-row lookup) fails open to normal send.
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
// State the boundary here in the header comment so the next reader
// doesn't inherit the wrong assumption that "prod email is now safe
// to test against."
//
// ── ANCHOR KINDS + MULTIPLICITY (Mateo Aug 9) ────────────────────────
//
// Three anchor kinds. Each resolves through its own table to
// companies.company_env via a `lower(trim())` text join. Text join
// contained in this ONE file — a future property_id/company_id FK
// migration touches only this function.
//
// Multiplicity table (for every kind):
//   0 rows                            → normal send (unresolvable)
//   1 row                             → use its company_env
//   N rows, all same company_env      → use it
//   N rows, DIVERGENT company_env     → 🔴 normal send + loud warning
//
// The last row matters. Under ambiguity, normal send is the safe
// direction: redirecting a possibly-production recipient breaks a
// live customer's email silently; failing to redirect a test-tenant
// send delivers to a seed address that is Jose's own inbox.
// Asymmetric harm, so it is not a coin flip.
//
// DO NOT `LIMIT 1` in any of the resolvers. That is the shape that
// makes this undefined instead of deterministic, and it looks correct
// in review.
//
// ── HELPER OUTPUT ────────────────────────────────────────────────────
//
// Returns { ok, message_id, outcome, originalTo, actualTo, error? }.
// outcome ∈ 'sent' | 'overridden' | 'failed' — the delivery-side three
// only. Suppression outcomes (`suppressed-by-reason`, etc.) live at
// the WRITER level, before this helper is ever called. Do not let the
// helper's narrower union become the audit vocabulary at the writer
// (Mateo Aug 9 Note 3).
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
  supabase:      SupabaseClient
  to:            string
  subject:       string
  from?:         string
  html?:         string
  text?:         string
  companyAnchor: CompanyAnchor
}

export async function sendCompanyScopedEmail(args: SendCompanyScopedArgs): Promise<SendCompanyScopedResult> {
  const originalTo = args.to
  const overrideTo = process.env.EMAIL_OVERRIDE_TO?.trim() || null

  const env = await resolveCompanyEnv(args.supabase, args.companyAnchor)

  const shouldRedirect =
    overrideTo !== null &&
    env !== null &&
    (env === 'test' || env === 'demo')

  const actualTo = shouldRedirect ? overrideTo! : originalTo
  const subject = shouldRedirect
    ? `${SUBJECT_MARKER_PREFIX}${originalTo}] ${args.subject}`
    : args.subject

  // Delegate to the SDK wrapper. Payload shape is the discriminated
  // union sendEmail already accepts; conditional-spread html/text so
  // the SDK's RequireAtLeastOne discriminator is satisfied.
  const send = await sendEmail({
    to:      actualTo,
    subject,
    from:    args.from,
    ...(args.html !== undefined ? { html: args.html } : {}),
    ...(args.text !== undefined ? { text: args.text } : {}),
  } as Parameters<typeof sendEmail>[0])

  if (!send.ok) {
    return {
      ok:         false,
      message_id: null,
      outcome:    'failed',
      originalTo,
      actualTo,
      error:      send.error,
    }
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
// Anchor resolvers.
//
// Every anchor kind runs its own table lookup (residents / user_roles),
// collects DISTINCT company_env values via a `lower(trim())` join to
// companies, and returns:
//   - the single env (0 or 1 distinct)
//   - null on any miss OR any divergence (with a loud warning log on
//     divergence)
//
// Callers of resolveCompanyEnv treat `null` uniformly as "fall through
// to normal send." Fail-open is enforced by this function's caller
// contract.
// ══════════════════════════════════════════════════════════════════════

async function resolveCompanyEnv(supabase: SupabaseClient, anchor: CompanyAnchor): Promise<string | null> {
  switch (anchor.kind) {
    case 'resident_id':    return resolveByResidentId(supabase, anchor.residentId)
    case 'resident_email': return resolveByResidentEmail(supabase, anchor.email, anchor.property)
    case 'user_email':     return resolveByUserEmail(supabase, anchor.email)
  }
}

async function resolveByResidentId(supabase: SupabaseClient, residentId: string): Promise<string | null> {
  // residents.id is unique by construction — at most one row.
  const { data, error } = await supabase
    .from('residents')
    .select('company')
    .eq('id', residentId)
    .maybeSingle()
  if (error) {
    console.warn('[company-scoped-email:resolve-error]', { anchor: 'resident_id', residentId, error: error.message })
    return null
  }
  const companyName = (data?.company ?? '').trim()
  if (!companyName) return null
  return lookupCompanyEnv(supabase, [companyName], { anchor: 'resident_id', context: { residentId } })
}

async function resolveByResidentEmail(supabase: SupabaseClient, email: string, property: string): Promise<string | null> {
  const emailKey = email.trim().toLowerCase()
  const propKey  = property.trim()
  if (!emailKey || !propKey) return null
  // No LIMIT 1 — the multiplicity table handles N rows explicitly.
  const { data, error } = await supabase
    .from('residents')
    .select('company')
    .ilike('email', emailKey)
    .ilike('property', propKey)
  if (error) {
    console.warn('[company-scoped-email:resolve-error]', { anchor: 'resident_email', email: emailKey, property: propKey, error: error.message })
    return null
  }
  const companyNames = Array.from(new Set(
    (data ?? []).map(r => ((r as { company: string | null }).company ?? '').trim()).filter(c => c.length > 0)
  ))
  if (companyNames.length === 0) return null
  return lookupCompanyEnv(supabase, companyNames, { anchor: 'resident_email', context: { email: emailKey, property: propKey } })
}

async function resolveByUserEmail(supabase: SupabaseClient, email: string): Promise<string | null> {
  const emailKey = email.trim().toLowerCase()
  if (!emailKey) return null
  // No LIMIT 1 — a driver working for two operators has 2 user_roles rows.
  const { data, error } = await supabase
    .from('user_roles')
    .select('company')
    .ilike('email', emailKey)
  if (error) {
    console.warn('[company-scoped-email:resolve-error]', { anchor: 'user_email', email: emailKey, error: error.message })
    return null
  }
  const companyNames = Array.from(new Set(
    (data ?? []).map(r => ((r as { company: string | null }).company ?? '').trim()).filter(c => c.length > 0)
  ))
  if (companyNames.length === 0) return null
  return lookupCompanyEnv(supabase, companyNames, { anchor: 'user_email', context: { email: emailKey } })
}

// Lookup company_env for a set of company NAMES (from the anchor
// resolvers). Applies the multiplicity table for the final env
// decision. Small N in practice — 1-2 company names per resolve.
async function lookupCompanyEnv(
  supabase: SupabaseClient,
  companyNames: string[],
  logCtx: { anchor: string; context: Record<string, unknown> },
): Promise<string | null> {
  const envs = new Set<string>()
  for (const name of companyNames) {
    const { data, error } = await supabase
      .from('companies')
      .select('company_env')
      .ilike('name', name)
      .maybeSingle()
    if (error) {
      console.warn('[company-scoped-email:company-lookup-error]', { ...logCtx, company_name: name, error: error.message })
      continue  // one company lookup failing shouldn't kill the whole resolve
    }
    const env = (data as { company_env?: string } | null)?.company_env
    if (env) envs.add(env)
  }
  if (envs.size === 0) return null
  if (envs.size === 1) return [...envs][0]
  // 🔴 Divergent envs across the resolved companies. Under Mateo's
  // multiplicity rule, this is normal send + loud warning. Loud
  // because a gate that silently declines to redirect is worse than
  // one that fails visibly (msgBox severity finding, Aug 8).
  console.error('[company-scoped-email:divergent-envs]', {
    ...logCtx,
    company_names:    companyNames,
    distinct_envs:    [...envs],
    resolution:       'normal_send',
    explanation:      'Multiple residents/user_roles rows resolved to companies with divergent company_env values. Falling through to normal send — the safe direction under ambiguity per the Aug 9 multiplicity rule. If this fires against a production recipient the mail will deliver normally, which is correct; if it fires against a test-tenant recipient the mail will deliver to the seed address (Jose alias), which is a property of the seed data rather than a safety guarantee.',
  })
  return null
}

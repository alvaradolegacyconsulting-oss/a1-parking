// ════════════════════════════════════════════════════════════════════
// smoke-auth — headless authenticated-session helper for scripts
// Introduced 2026-07-14; first user was
// scripts/smoke-accept-saas-agreement-ONE-TIME.ts
//
// ── WHAT THIS SOLVES ────────────────────────────────────────────────
// A large class of the security-critical surface in this codebase
// derives from auth.uid() / auth.jwt()->>'email': consent RPCs, billing
// gates, tenancy joins, RLS. Testing any of them scripted means minting
// a real user JWT — but Supabase Auth enforces Turnstile on
// signInWithPassword, and Turnstile requires a browser widget. curl
// fails with captcha_failed; the JS SDK fails the same way for the
// same reason.
//
// The correct workaround is not to bypass Turnstile but to use the
// service_role admin API, which is admin-privileged by design and
// exists precisely for headless server-to-server flows. The pattern:
//   1. As service_role, admin.generateLink({ type: 'magiclink', email })
//      mints a hashed_token bound to the target user (no email sent,
//      no CAPTCHA involved).
//   2. As anon, verifyOtp({ token_hash, type: 'magiclink' }) exchanges
//      the hash for a real session.access_token + user.
//   3. A new anon client with Authorization: Bearer <access_token> fires
//      subsequent RPCs under that user's JWT — auth.uid() +
//      auth.jwt()->>'email' resolve, DEFINER RPCs see the real caller,
//      RLS policies evaluate correctly.
//
// ── WHY A HELPER, NOT A ONE-OFF ─────────────────────────────────────
// Every future authenticated smoke is going to need this exact
// three-step dance. If it lives inline in scripts, the next author
// re-discovers generateLink + verifyOtp from scratch and probably
// re-invents the guardrails wrong. Centralize once.
//
// ── SAFETY: TWO-LOCK PRODUCTION GUARDRAIL ───────────────────────────
// service_role can create sessions for ANY user, including
// company_env='production' subscribers. That is a real capability we
// must not use casually. This helper enforces two independent locks:
//
//   Lock 1 (caller): pass targetEnv='production' explicitly.
//                    Default is 'test' — the safe default for smokes.
//   Lock 2 (env):    ALLOW_SMOKE_ON_PRODUCTION=1 must be set at run
//                    time. Not in .env.local; only in the operator
//                    shell, deliberately.
//
// Both must be present to reach a production user. Missing either =
// throw. This is not a check-box UX; it is the point.
//
// ── USAGE ───────────────────────────────────────────────────────────
//   import { sessionAs } from './lib/smoke-auth'
//
//   const s = await sessionAs('legacy-ca-2@test.shieldmylot.com')
//   const { data, error } = await s.client.rpc('accept_saas_agreement', {
//     p_saas_version: '2026-07-10-v1',
//     p_reviewed_at: new Date().toISOString(),
//   })
//   // Then read back via s.admin (service_role, bypasses RLS):
//   const { data: rows } = await s.admin.from('tos_acceptances')
//     .select('*').eq('user_id', s.userId)
//
// ── ENV ─────────────────────────────────────────────────────────────
//   NEXT_PUBLIC_SUPABASE_URL       — target project
//   NEXT_PUBLIC_SUPABASE_ANON_KEY  — for the session-carrying client
//   SUPABASE_SERVICE_ROLE_KEY      — for generateLink + read-back
//   ALLOW_SMOKE_ON_PRODUCTION=1    — required alongside targetEnv=
//                                    'production' to reach real users
// ════════════════════════════════════════════════════════════════════

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type CompanyEnv = 'production' | 'test' | 'demo'

export interface SessionAsResult {
  /** Sessioned client — Authorization: Bearer <access_token>. Fires
   *  RPCs under the target user's JWT. Subject to RLS. */
  client:       SupabaseClient
  /** service_role client — bypasses RLS. For read-backs, verify-after-
   *  write, and other operator-side inspection. Same URL. */
  admin:        SupabaseClient
  accessToken:  string
  userId:       string
  email:        string
  /** Resolved from user_roles.company → companies via lower(trim(...))
   *  join (matches companies_name_lower_unique + Commit A derivation).
   *  NULL for super-admin (user_roles.company IS NULL by design) or
   *  when the join misses. */
  companyId:    number | null
  companyName:  string | null
  companyEnv:   CompanyEnv | null
}

interface SessionAsOptions {
  /** Which environment the caller expects to smoke against. Default
   *  'test'. Must be set to 'production' AND ALLOW_SMOKE_ON_PRODUCTION=1
   *  must be in env to reach a production user. */
  targetEnv?: CompanyEnv
}

/**
 * Mint a real authenticated session for `email` without password or
 * CAPTCHA, via admin.generateLink + verifyOtp.
 *
 * Refuses to mint against a company_env='production' user unless the
 * caller passes targetEnv='production' AND the operator env has
 * ALLOW_SMOKE_ON_PRODUCTION=1 set. Missing either lock throws.
 *
 * Also refuses if any of NEXT_PUBLIC_SUPABASE_URL /
 * NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY is missing
 * from env.
 *
 * @param email       target user's email (case-insensitive)
 * @param opts.targetEnv   caller's declared target env (default 'test')
 * @returns SessionAsResult with client/admin/token/user/company fields
 * @throws Error on any guardrail violation or Supabase API failure
 */
export async function sessionAs(
  email: string,
  opts: SessionAsOptions = {},
): Promise<SessionAsResult> {
  const targetEnv: CompanyEnv = opts.targetEnv ?? 'test'

  // ── Env-var preflight ────────────────────────────────────────────
  const url        = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !anonKey || !serviceKey) {
    throw new Error(
      'smoke-auth: missing env — need NEXT_PUBLIC_SUPABASE_URL / ' +
      'NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY. ' +
      'Run with: npx tsx --env-file=.env.local <script>',
    )
  }

  // ── Resolve target user's company_env BEFORE minting a session ──
  // Guardrail must fire before we get anywhere near a production JWT.
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: roleRow, error: roleErr } = await admin
    .from('user_roles')
    .select('email, role, company')
    .ilike('email', email)
    .maybeSingle()
  if (roleErr) {
    throw new Error(`smoke-auth: user_roles lookup failed for ${email}: ${roleErr.message}`)
  }
  if (!roleRow) {
    throw new Error(`smoke-auth: no user_roles row for ${email} — user does not exist in this project`)
  }

  let companyId:   number | null      = null
  let companyName: string | null      = (roleRow.company as string | null) ?? null
  let companyEnv:  CompanyEnv | null  = null

  if (companyName) {
    // Match companies_name_lower_unique + Commit A derivation
    // normalization: lower(trim(...)) both sides. Uses ilike here for
    // brevity (service_role read, no injection surface — companyName
    // came from our own user_roles row).
    const { data: coRow } = await admin
      .from('companies')
      .select('id, name, company_env')
      .ilike('name', companyName)
      .maybeSingle()
    if (coRow) {
      companyId   = coRow.id as number
      companyName = coRow.name as string
      companyEnv  = (coRow.company_env as CompanyEnv | null) ?? null
    }
  }

  // ── 🔴 LOAD-BEARING GUARDRAIL — two-lock production check ────────
  if (companyEnv === 'production') {
    if (targetEnv !== 'production') {
      throw new Error(
        `smoke-auth: refusing to mint session for ${email} — resolved company_env=production ` +
        `but caller passed targetEnv='${targetEnv}'. To smoke against a real customer, ` +
        `pass targetEnv='production' AND set ALLOW_SMOKE_ON_PRODUCTION=1 in the operator shell.`,
      )
    }
    if (process.env.ALLOW_SMOKE_ON_PRODUCTION !== '1') {
      throw new Error(
        `smoke-auth: refusing to mint session for ${email} — company_env=production ` +
        `and ALLOW_SMOKE_ON_PRODUCTION is not set to '1'. Two-lock discipline: caller opts in ` +
        `via targetEnv AND operator env allows via ALLOW_SMOKE_ON_PRODUCTION. Set the env var ` +
        `deliberately in the shell (not .env.local) to proceed.`,
      )
    }
  }

  // ── Also refuse the inverse: caller declared 'production' but the
  //    user resolved to test/demo. That is likely a typo in the target
  //    email; surface it rather than silently minting the wrong session.
  if (targetEnv === 'production' && companyEnv !== 'production') {
    throw new Error(
      `smoke-auth: caller passed targetEnv='production' but ${email} resolved to ` +
      `company_env='${companyEnv}'. Refusing to proceed — either the email is wrong ` +
      `or the guardrail declaration is mistaken. Check both.`,
    )
  }

  // ── Mint magic link via service_role ─────────────────────────────
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type:  'magiclink',
    email,
  })
  if (linkErr) {
    throw new Error(`smoke-auth: generateLink failed for ${email}: ${linkErr.message}`)
  }
  const props = (linkData as { properties?: { hashed_token?: string } }).properties
  const hashedToken = props?.hashed_token
  if (!hashedToken) {
    throw new Error(
      `smoke-auth: no hashed_token in generateLink response for ${email}. ` +
      `Full response keys: ${Object.keys(linkData ?? {}).join(', ')}`,
    )
  }

  // ── Exchange hashed_token for a real session ─────────────────────
  const anonClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: verifyData, error: verifyErr } = await anonClient.auth.verifyOtp({
    token_hash: hashedToken,
    type:       'magiclink',
  })
  if (verifyErr || !verifyData.session || !verifyData.user) {
    throw new Error(
      `smoke-auth: verifyOtp failed for ${email}: ${verifyErr?.message ?? 'no session/user in response'}`,
    )
  }

  const accessToken = verifyData.session.access_token
  const userId      = verifyData.user.id

  // ── Sessioned client — every RPC fires under the user's JWT ─────
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })

  return {
    client,
    admin,
    accessToken,
    userId,
    email,
    companyId,
    companyName,
    companyEnv,
  }
}

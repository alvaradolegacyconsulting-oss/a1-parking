// B198 prefetch-interstitial regression probe.
//
// Three assertion lanes (lane 1 expanded for signup extension):
//
// LANE 1 — SOURCE-CODE REGRESSION (strengthened for signup ext.)
//   Reads app/auth/accept/page.tsx and asserts NO mount-time token
//   consumption via any mechanism — not just verifyOtp:
//     (1) NO `verifyOtp` call inside any useEffect block — the original
//         B198 invariant. Explicit consumption.
//     (2) NO `getSession`, `onAuthStateChange`, or `exchangeCodeForSession`
//         inside any useEffect — these trigger the Supabase SDK's
//         detectSessionInUrl auto-exchange when the URL has ?code= or
//         #access_token=. Effective consumption.
//     (3) Exactly TWO `verifyOtp` calls exist total in the file
//         (handlePrimaryClick + submitOtp; both user-action handlers).
//   (2) is the gap the original probe missed — the signup pages
//   (/signup/verify, /signup/redeem/verify) all satisfy (1) but FAIL
//   (2) because they call getSession()/onAuthStateChange() in useEffect
//   to wait for the SDK's auto-exchange to mint a session. /auth/accept
//   must NOT have that pattern; the page reads URL params only, never
//   inspects session state on mount.
//
// LANE 2 — TOKEN MECHANIC ROUND-TRIP (two types: invite + signup)
//   Uses auth.admin.generateLink to mint a real token_hash for each
//   type without sending an email, then exercises the verifyOtp mechanic:
//     • Round 1: verifyOtp({token_hash, type}) → succeeds (mints a session,
//       proves the token is live and the type+arg pair works end-to-end
//       against this Supabase project)
//     • Round 2: same call → fails with otp_expired (proves single-use)
//   Run for type='invite' (B198 original) AND type='signup' (this ext).
//   recovery/email_change/magiclink not generated here — recovery needs
//   resetPasswordForEmail, email_change needs auth.updateUser, magiclink
//   needs signInWithOtp; covered structurally via the source-check + the
//   COPY map's type-uniform shape.
//
// LANE 3 — POST-LOAD VERIFY (optional, manual-handoff)
//   When PROBE_VERIFY_TOKEN_HASH is set, calls verifyOtp on the supplied
//   token_hash. PROBE_VERIFY_TOKEN_TYPE controls the type (default 'invite').
//   Used after a manual browser page-load to confirm the token survived.
//
// PREFETCH-SURVIVAL SMOKE (manual, post-deploy)
//   The probe prints sample /auth/accept URLs for invite + signup with
//   fresh token_hashes. Paste in browser → page renders without
//   consuming → re-run probe with PROBE_VERIFY_TOKEN_HASH=<hash> +
//   PROBE_VERIFY_TOKEN_TYPE=<type> → PASS = token survived.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-b198-prefetch-interstitial.ts
//
//   With pre-captured token hash (after manual page-load):
//     PROBE_VERIFY_TOKEN_HASH=pkce_xxxxx \
//     PROBE_VERIFY_TOKEN_TYPE=signup \
//       npx tsx --env-file=.env.local \
//       scripts/probe-b198-prefetch-interstitial.ts

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const siteUrl    = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

const RUN_TAG = `b198-${Date.now()}`
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

type Check = { id: string; pass: boolean; detail: string }
const checks: Check[] = []
const record = (id: string, pass: boolean, detail: string) => {
  checks.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}
const cleanup: Array<() => Promise<void>> = []

// ── LANE 1: source-code regression ──────────────────────────────────────────
function lane1_sourceCheck(): void {
  console.log('\n── LANE 1 — SOURCE-CODE REGRESSION ──')
  const path = 'app/auth/accept/page.tsx'
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (e) {
    record('lane1.source_readable', false, `cannot read ${path}: ${(e as Error).message}`)
    return
  }
  record('lane1.source_readable', true, `${path} readable (${source.length} chars)`)

  // Count verifyOtp call sites. Expected: exactly 2 (handlePrimaryClick + submitOtp).
  const verifyOtpCalls = (source.match(/\bverifyOtp\s*\(/g) ?? []).length
  if (verifyOtpCalls === 2) {
    record('lane1.verify_otp_call_count', true, `exactly 2 verifyOtp call sites found`)
  } else {
    record('lane1.verify_otp_call_count', false,
      `expected 2 verifyOtp call sites, found ${verifyOtpCalls} — investigate before push`)
  }

  // Extract every useEffect block body. Rough parser but adequate for this
  // hand-written file with no string literals containing the names we check.
  const useEffectBlocks: string[] = []
  const re = /useEffect\s*\(\s*\(\s*\)\s*=>\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const start = m.index + m[0].length - 1  // position of the `{`
    let depth = 1
    let i = start + 1
    while (i < source.length && depth > 0) {
      const ch = source[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      i++
    }
    if (depth === 0) useEffectBlocks.push(source.slice(start, i))
  }

  if (useEffectBlocks.length === 0) {
    record('lane1.use_effect_present', false,
      'no useEffect blocks found — unexpected (the page parses URL params on mount)')
  } else {
    record('lane1.use_effect_present', true, `${useEffectBlocks.length} useEffect block(s) found`)
  }

  // ASSERTION (1) — original B198 invariant. No verifyOtp inside any useEffect.
  const useEffectVerifyOtpHits = useEffectBlocks.reduce(
    (n, b) => n + (b.match(/\bverifyOtp\s*\(/g)?.length ?? 0), 0,
  )
  if (useEffectVerifyOtpHits === 0) {
    record('lane1.no_verify_otp_in_use_effect', true,
      'CRITICAL INVARIANT HELD — verifyOtp does not run on mount')
  } else {
    record('lane1.no_verify_otp_in_use_effect', false,
      `PREFETCH HOLE REOPENED — ${useEffectVerifyOtpHits} verifyOtp call(s) inside useEffect; DO NOT MERGE`)
  }

  // ASSERTION (2) — signup-extension hardening. No SDK auto-exchange triggers
  // inside any useEffect. getSession / onAuthStateChange / exchangeCodeForSession
  // all cause the @supabase/ssr browser client (createBrowserClient default
  // has detectSessionInUrl: true) to consume any ?code= or #access_token= in
  // the URL — exactly the consumption channel the interstitial closes for
  // explicit verifyOtp. The signup pages (/signup/verify, /signup/redeem/verify)
  // FAIL this assertion by design: they wait for the SDK to auto-exchange.
  // /auth/accept must not — it reads URL params and renders, period.
  const triggers = ['getSession', 'onAuthStateChange', 'exchangeCodeForSession']
  const triggerHits: Record<string, number> = {}
  for (const t of triggers) {
    const re2 = new RegExp(`\\b${t}\\s*\\(`, 'g')
    triggerHits[t] = useEffectBlocks.reduce(
      (n, b) => n + (b.match(re2)?.length ?? 0), 0,
    )
  }
  const totalTriggerHits = Object.values(triggerHits).reduce((a, b) => a + b, 0)
  if (totalTriggerHits === 0) {
    record('lane1.no_sdk_auto_exchange_in_use_effect', true,
      'CRITICAL INVARIANT HELD — no getSession/onAuthStateChange/exchangeCodeForSession in useEffect; SDK cannot auto-exchange a URL token on mount')
  } else {
    const breakdown = Object.entries(triggerHits)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `${t}=${n}`)
      .join(', ')
    record('lane1.no_sdk_auto_exchange_in_use_effect', false,
      `SDK AUTO-EXCHANGE TRIGGERS PRESENT — ${breakdown}. detectSessionInUrl would consume URL token on mount; DO NOT MERGE without explicit { detectSessionInUrl: false } on a per-page client.`)
  }
}

// ── LANE 2: token-mechanic round-trip (per type) ────────────────────────────
async function lane2_tokenMechanicForType(
  type: 'invite' | 'signup',
  redirectTo: string,
): Promise<void> {
  console.log(`\n── LANE 2 — TOKEN MECHANIC (type=${type}) ──`)

  // Spawn a throwaway recipient (real auth user, deleted at cleanup).
  // Signup-type generateLink requires the email not already be confirmed;
  // invite-type works regardless. We use email_confirm: false in both cases
  // to support either flow on the same created user.
  const recipientEmail = `mateo+${RUN_TAG}-${type}@example.com`
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: recipientEmail,
    password: `B198_${RUN_TAG}_${type}!`,
    email_confirm: false,
  })
  if (cErr || !created.user) {
    record(`lane2.${type}.user_created`, false, `auth create: ${cErr?.message}`)
    return
  }
  cleanup.push(async () => { await admin.auth.admin.deleteUser(created.user!.id) })
  record(`lane2.${type}.user_created`, true, `throwaway recipient: ${recipientEmail}`)

  // generateLink({type}) returns properties.hashed_token + action_link.
  // No email is dispatched; we get the raw token_hash for direct verification.
  // The Supabase SDK uses a discriminated union per type — invite/magiclink
  // takes no password, signup REQUIRES password — so we branch the call to
  // keep TS's narrowing happy.
  const linkResult = type === 'signup'
    ? await admin.auth.admin.generateLink({
        type: 'signup',
        email: recipientEmail,
        password: `B198_${RUN_TAG}_${type}!`,
        options: { redirectTo },
      })
    : await admin.auth.admin.generateLink({
        type: 'invite',
        email: recipientEmail,
        options: { redirectTo },
      })
  const { data: linkData, error: linkErr } = linkResult
  if (linkErr || !linkData?.properties?.hashed_token) {
    record(`lane2.${type}.token_hash_captured`, false,
      `generateLink: ${linkErr?.message ?? 'no hashed_token in response'}`)
    return
  }
  const tokenHash = linkData.properties.hashed_token
  record(`lane2.${type}.token_hash_captured`, true, `hashed_token captured (${tokenHash.length} chars)`)

  // Round 1 — verifyOtp should succeed.
  const v1 = await admin.auth.verifyOtp({ token_hash: tokenHash, type })
  if (v1.error) {
    record(`lane2.${type}.round1_verifyOtp_succeeds`, false,
      `expected success, got: ${v1.error.message}`)
    return
  }
  record(`lane2.${type}.round1_verifyOtp_succeeds`, true,
    `token consumed cleanly via verifyOtp({token_hash, type:'${type}'})`)

  // Round 2 — same token_hash should now be exhausted.
  const v2 = await admin.auth.verifyOtp({ token_hash: tokenHash, type })
  if (v2.error && (v2.error.message.toLowerCase().includes('expired') ||
                   (v2.error as { code?: string }).code === 'otp_expired')) {
    record(`lane2.${type}.round2_single_use_enforced`, true,
      `single-use enforced — second call errored: ${v2.error.message}`)
  } else if (v2.error) {
    record(`lane2.${type}.round2_single_use_enforced`, false,
      `unexpected error shape on round 2: ${v2.error.message} (looking for 'expired' / 'otp_expired')`)
  } else {
    record(`lane2.${type}.round2_single_use_enforced`, false,
      `BUG — second verifyOtp on same token_hash succeeded; single-use not enforced`)
  }
}

async function lane2_tokenMechanic(): Promise<void> {
  // Run for both types that have generateLink support today.
  // recovery/email_change/magiclink not generated here — they require
  // different SDK paths (resetPasswordForEmail / auth.updateUser /
  // signInWithOtp) and are covered structurally via the source-check
  // + the COPY map's type-uniform shape.
  await lane2_tokenMechanicForType('invite', `${siteUrl}/reset-password-required`)
  await lane2_tokenMechanicForType('signup', `${siteUrl}/signup/verify`)
}

// ── OPTIONAL LANE 3: verify a token_hash captured from a manual page-load ──
// Reads PROBE_VERIFY_TOKEN_HASH for the captured hash + PROBE_VERIFY_TOKEN_TYPE
// for the type (default 'invite'; accepts invite | signup | recovery |
// email_change | magiclink — anything the COPY map handles).
async function lane3_postLoadVerify(): Promise<void> {
  const externalHash = process.env.PROBE_VERIFY_TOKEN_HASH
  if (!externalHash) return
  const externalType = (process.env.PROBE_VERIFY_TOKEN_TYPE || 'invite') as
    'invite' | 'signup' | 'recovery' | 'email_change' | 'magiclink'
  console.log(`\n── LANE 3 — POST-LOAD VERIFY (type=${externalType}, manual handoff) ──`)
  const v = await admin.auth.verifyOtp({ token_hash: externalHash, type: externalType })
  if (v.error) {
    if (v.error.message.toLowerCase().includes('expired') ||
        (v.error as { code?: string }).code === 'otp_expired') {
      record('lane3.token_survived_page_load', false,
        `PREFETCH CONSUMED — token already used. The page DID consume on mount (verifyOtp / SDK auto-exchange), or another prefetcher hit it. INVESTIGATE.`)
    } else {
      record('lane3.token_survived_page_load', false,
        `verifyOtp error (not otp_expired): ${v.error.message}`)
    }
  } else {
    record('lane3.token_survived_page_load', true,
      `token still live after page-load — prefetch invariant HELD for type=${externalType}`)
  }
}

// ── Sample-URL printer (manual smoke aid) ──────────────────────────────────
async function printSampleUrlForType(
  type: 'invite' | 'signup',
  nextPath: string,
  buttonLabel: string,
): Promise<void> {
  const sampleEmail = `mateo+${RUN_TAG}-${type}-smoke@example.com`
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: sampleEmail,
    password: `B198_smoke_${RUN_TAG}_${type}!`,
    email_confirm: false,
  })
  if (cErr || !created.user) {
    console.log(`  (${type}) could not mint sample (skipped): ${cErr?.message}`)
    return
  }
  cleanup.push(async () => { await admin.auth.admin.deleteUser(created.user!.id) })

  const linkResult = type === 'signup'
    ? await admin.auth.admin.generateLink({
        type: 'signup',
        email: sampleEmail,
        password: `B198_smoke_${RUN_TAG}_${type}!`,
        options: { redirectTo: `${siteUrl}${nextPath}` },
      })
    : await admin.auth.admin.generateLink({
        type: 'invite',
        email: sampleEmail,
        options: { redirectTo: `${siteUrl}${nextPath}` },
      })
  const { data: linkData, error: linkErr } = linkResult
  if (linkErr || !linkData?.properties?.hashed_token) {
    console.log(`  (${type}) could not mint sample (skipped): ${linkErr?.message}`)
    return
  }
  const tokenHash = linkData.properties.hashed_token
  const params = new URLSearchParams({
    token_hash: tokenHash,
    type,
    next:       nextPath,
    email:      sampleEmail,
  })
  console.log(`\n  [${type}]  ${siteUrl}/auth/accept?${params.toString()}`)
  console.log(`         token=${tokenHash}`)
  console.log(`         survival re-probe (paste, do NOT click, then run):`)
  console.log(`           PROBE_VERIFY_TOKEN_HASH=${tokenHash} \\`)
  console.log(`           PROBE_VERIFY_TOKEN_TYPE=${type} \\`)
  console.log(`             npx tsx --env-file=.env.local scripts/probe-b198-prefetch-interstitial.ts`)
  console.log(`         click "${buttonLabel}" → should redirect to ${nextPath} with a minted session.`)
}

async function printSampleUrl(): Promise<void> {
  console.log('\n── MANUAL SMOKE URLs (paste in browser) ──')
  console.log('  Smoke steps (per URL):')
  console.log('    1. Paste URL in browser. Page should render without auto-redirecting.')
  console.log('    2. Run the survival re-probe (printed under each URL) BEFORE clicking — token should survive.')
  console.log('    3. Click the primary button. Redirect to next path with an active session.')
  await printSampleUrlForType('invite', '/reset-password-required', 'Complete setup')
  await printSampleUrlForType('signup', '/signup/verify', 'Confirm account')
}

async function cleanupAll(): Promise<void> {
  console.log('\n── CLEANUP ──')
  for (const fn of cleanup.reverse()) {
    try { await fn() } catch (e) { console.error('cleanup error:', (e as Error).message) }
  }
}

async function main(): Promise<void> {
  console.log(`B198 prefetch-interstitial probe · ${RUN_TAG}`)
  console.log(`Project: ${url}`)
  console.log(`Site:    ${siteUrl}`)

  lane1_sourceCheck()
  await lane2_tokenMechanic()
  await lane3_postLoadVerify()
  await printSampleUrl()
  await cleanupAll()

  const passed = checks.filter(c => c.pass).length
  console.log(`\n── RESULT — ${passed}/${checks.length} passed ──`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.id}`)
  }
  process.exit(passed === checks.length ? 0 : 1)
}

main().catch(async (e) => {
  console.error('UNHANDLED:', (e as Error).message)
  await cleanupAll()
  process.exit(1)
})

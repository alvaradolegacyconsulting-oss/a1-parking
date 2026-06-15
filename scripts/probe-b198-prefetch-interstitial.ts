// B198 prefetch-interstitial regression probe.
//
// Two assertion lanes:
//
// LANE 1 — SOURCE-CODE REGRESSION
//   Reads app/auth/accept/page.tsx and asserts:
//     • NO `verifyOtp` call appears inside any useEffect block
//     • Exactly two `verifyOtp` calls exist total (one in handlePrimaryClick,
//       one in submitOtp; both are user-action handlers, not mount-time)
//   This is the load-bearing invariant — if someone ever adds a
//   verifyOtp call to a useEffect (e.g. trying to "auto-verify if user
//   is already on this page"), the prefetch hole reopens and the
//   probe fails.
//
// LANE 2 — TOKEN MECHANIC ROUND-TRIP
//   Uses auth.admin.generateLink to mint a real invite token_hash
//   without sending an email, then exercises the verifyOtp mechanic:
//     • Round 1: verifyOtp({token_hash, type: 'invite'}) → succeeds (mints
//       a session, proves the token is live and the type+arg pair works
//       end-to-end against this Supabase project)
//     • Round 2: same call → fails with otp_expired (proves single-use)
//
// PREFETCH-SURVIVAL SMOKE (manual, post-deploy)
//   The probe also prints a sample /auth/accept URL with a fresh token_hash
//   that Jose can paste into Vercel preview (or the deployed main) to
//   verify the page renders without consuming. After the manual smoke:
//     1. Open the URL in a browser (this simulates the prefetch GET)
//     2. DO NOT click the button
//     3. Re-run this probe with PROBE_VERIFY_TOKEN_HASH=<the_hash> env var
//        — it'll attempt verifyOtp and PASS if the token survived
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-b198-prefetch-interstitial.ts
//
//   With pre-captured token hash (after manual page-load):
//     PROBE_VERIFY_TOKEN_HASH=pkce_xxxxx npx tsx --env-file=.env.local \
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

  // CRITICAL: no verifyOtp inside any useEffect block.
  // Find useEffect(() => { ... }, [...]) blocks (rough but adequate for this
  // file's hand-written structure). We don't need a real parser — we control
  // the file and there are no string literals containing 'verifyOtp'.
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
}

// ── LANE 2: token-mechanic round-trip ───────────────────────────────────────
async function lane2_tokenMechanic(): Promise<void> {
  console.log('\n── LANE 2 — TOKEN MECHANIC ROUND-TRIP ──')

  // Spawn a throwaway recipient (real auth user, deleted at cleanup).
  const recipientEmail = `mateo+${RUN_TAG}-invite@example.com`
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: recipientEmail, password: `B198_${RUN_TAG}!`, email_confirm: false,
  })
  if (cErr || !created.user) {
    record('lane2.invite_user_created', false, `auth create: ${cErr?.message}`)
    return
  }
  cleanup.push(async () => { await admin.auth.admin.deleteUser(created.user!.id) })
  record('lane2.invite_user_created', true, `throwaway recipient: ${recipientEmail}`)

  // generateLink({type: 'invite'}) returns properties.hashed_token + action_link.
  // No email is dispatched; we get the raw token_hash for direct verification.
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type:  'invite',
    email: recipientEmail,
    options: { redirectTo: `${siteUrl}/reset-password-required` },
  })
  if (linkErr || !linkData?.properties?.hashed_token) {
    record('lane2.token_hash_captured', false, `generateLink: ${linkErr?.message ?? 'no hashed_token in response'}`)
    return
  }
  const tokenHash = linkData.properties.hashed_token
  record('lane2.token_hash_captured', true, `hashed_token captured (${tokenHash.length} chars)`)

  // Round 1 — verifyOtp should succeed.
  const v1 = await admin.auth.verifyOtp({ token_hash: tokenHash, type: 'invite' })
  if (v1.error) {
    record('lane2.round1_verifyOtp_succeeds', false,
      `expected success, got: ${v1.error.message}`)
    return
  }
  record('lane2.round1_verifyOtp_succeeds', true,
    `token consumed cleanly via verifyOtp({token_hash, type:'invite'})`)

  // Round 2 — same token_hash should now be exhausted.
  const v2 = await admin.auth.verifyOtp({ token_hash: tokenHash, type: 'invite' })
  if (v2.error && (v2.error.message.toLowerCase().includes('expired') ||
                   (v2.error as { code?: string }).code === 'otp_expired')) {
    record('lane2.round2_single_use_enforced', true,
      `single-use enforced — second call errored: ${v2.error.message}`)
  } else if (v2.error) {
    record('lane2.round2_single_use_enforced', false,
      `unexpected error shape on round 2: ${v2.error.message} (looking for 'expired' / 'otp_expired')`)
  } else {
    record('lane2.round2_single_use_enforced', false,
      `BUG — second verifyOtp on same token_hash succeeded; single-use not enforced`)
  }
}

// ── OPTIONAL LANE 3: verify a token_hash captured from a manual page-load ──
async function lane3_postLoadVerify(): Promise<void> {
  const externalHash = process.env.PROBE_VERIFY_TOKEN_HASH
  if (!externalHash) return
  console.log('\n── LANE 3 — POST-LOAD VERIFY (manual handoff) ──')
  const v = await admin.auth.verifyOtp({ token_hash: externalHash, type: 'invite' })
  if (v.error) {
    if (v.error.message.toLowerCase().includes('expired') ||
        (v.error as { code?: string }).code === 'otp_expired') {
      record('lane3.token_survived_page_load', false,
        `PREFETCH CONSUMED — token already used. The page DID call verifyOtp on mount, or another prefetcher hit it. INVESTIGATE.`)
    } else {
      record('lane3.token_survived_page_load', false,
        `verifyOtp error (not otp_expired): ${v.error.message}`)
    }
  } else {
    record('lane3.token_survived_page_load', true,
      `token still live after page-load — prefetch invariant HELD`)
  }
}

// ── Sample-URL printer (manual smoke aid) ──────────────────────────────────
async function printSampleUrl(): Promise<void> {
  console.log('\n── MANUAL SMOKE URL (paste in browser) ──')
  const sampleEmail = `mateo+${RUN_TAG}-smoke@example.com`
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: sampleEmail, password: `B198_smoke_${RUN_TAG}!`, email_confirm: false,
  })
  if (cErr || !created.user) {
    console.log(`  could not mint sample (skipped): ${cErr?.message}`)
    return
  }
  cleanup.push(async () => { await admin.auth.admin.deleteUser(created.user!.id) })

  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type:  'invite',
    email: sampleEmail,
    options: { redirectTo: `${siteUrl}/reset-password-required` },
  })
  if (linkErr || !linkData?.properties?.hashed_token) {
    console.log(`  could not mint sample (skipped): ${linkErr?.message}`)
    return
  }
  const tokenHash = linkData.properties.hashed_token
  const params = new URLSearchParams({
    token_hash: tokenHash,
    type:       'invite',
    next:       '/reset-password-required',
    email:      sampleEmail,
  })
  console.log(`\n  ${siteUrl}/auth/accept?${params.toString()}`)
  console.log(`\n  Smoke steps:`)
  console.log(`    1. Paste the URL above in a browser (this simulates prefetch + your click).`)
  console.log(`    2. CONFIRM the page renders without auto-redirecting (no verifyOtp on mount).`)
  console.log(`    3. Without clicking the button, run this probe again with:`)
  console.log(`         PROBE_VERIFY_TOKEN_HASH=${tokenHash} npx tsx --env-file=.env.local \\`)
  console.log(`           scripts/probe-b198-prefetch-interstitial.ts`)
  console.log(`       PASS = token still live; FAIL = prefetch consumed it.`)
  console.log(`    4. Then return to the browser and click "Complete setup" — should redirect to`)
  console.log(`       /reset-password-required with an active session.`)
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

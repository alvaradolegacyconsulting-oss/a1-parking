// A2 BLOCK-A1 close-out — get_company_admin_emails behavioral probe.
//
// Validates the post-migration state of public.get_company_admin_emails:
//
//   1. anon EXECUTE denied                — REVOKE FROM anon enforced
//   2. authenticated with no user_roles    — get_my_company()=NULL → 0 rows
//      row returns 0 rows                    (no leak via NULL caller-company)
//   3. driver in companyA + target=A       — own-company call returns A's admins
//   4. driver in companyA + target=B       — cross-company call returns A's
//                                            admins (target IGNORED + clamp)
//   5. driver in companyA + target=A with  — ILIKE preserved: case drift on the
//      different casing in target arg        ignored arg doesn't matter; the
//                                            CLAMP itself reads get_my_company()
//                                            via ILIKE so cross-row casing
//                                            within company A is tolerated
//   6. driver in companyA + nonsense       — target ignored; still returns A's
//      target string                          admins (proves arg is dead)
//   7. driver whose user_roles.company     — wildcard-spoof regression case.
//      is literally '%'                       Under the original ILIKE clamp
//                                             this caller would have matched
//                                             every row (% is a wildcard) and
//                                             leaked ALL tenants' admins. The
//                                             lower=lower clamp treats '%' as
//                                             a literal — caller gets ZERO
//                                             rows (no admin happens to be in
//                                             company='%'). FAILING THIS CASE
//                                             means someone restored ILIKE.
//
// Standing rule per A2 discipline: no DEFINER body-guard ships without a
// behavioral probe. This is the A2-class probe matching D2 (insert_user_role)
// and B182 (get_pm_ticket_summary) precedent.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/probe-a2-get-company-admin-emails-close.ts
//
// PRECONDITION: migration 20260615_a2_get_company_admin_emails_close.sql
// applied to the target project.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const RUN_TAG = `a2gcae-${Date.now()}`

// Throwaway companies for the cross-tenant slice. Real company strings live
// outside the test namespace; these will not collide with production rows.
const COMPANY_A = `A2_${RUN_TAG}_TenantA`
const COMPANY_B = `A2_${RUN_TAG}_TenantB`

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

type Check = { id: string; pass: boolean; detail: string }
const checks: Check[] = []
const record = (id: string, pass: boolean, detail: string) => {
  checks.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}
const cleanup: Array<() => Promise<void>> = []

interface Persona { email: string; client: SupabaseClient; authId: string }

async function spawnAuthUser(suffix: string): Promise<Persona> {
  const email = `mateo+${RUN_TAG}-${suffix}@example.com`
  const pw    = `A2_${RUN_TAG}_${suffix}!`
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password: pw, email_confirm: true,
  })
  if (cErr || !created.user) throw new Error(`auth create ${suffix}: ${cErr?.message}`)
  cleanup.push(async () => { await admin.auth.admin.deleteUser(created.user!.id) })
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: pw })
  if (sErr) throw new Error(`signIn ${suffix}: ${sErr.message}`)
  return { email, client, authId: created.user.id }
}

async function spawnDriverIn(company: string, suffix: string): Promise<Persona> {
  const p = await spawnAuthUser(suffix)
  const { error } = await admin.from('user_roles').insert({
    email: p.email, role: 'driver', company,
  })
  if (error) throw new Error(`user_roles driver insert: ${error.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

async function spawnCompanyAdminIn(company: string, suffix: string): Promise<Persona> {
  const p = await spawnAuthUser(suffix)
  const { error } = await admin.from('user_roles').insert({
    email: p.email, role: 'company_admin', company,
  })
  if (error) throw new Error(`user_roles company_admin insert: ${error.message}`)
  cleanup.push(async () => { await admin.from('user_roles').delete().eq('email', p.email) })
  await p.client.auth.refreshSession()
  return p
}

// Call the RPC and shape the result the way SupportContact does.
async function callRpc(c: SupabaseClient, target: string): Promise<{
  data: string[] | null
  error: { code?: string; message: string } | null
}> {
  const { data, error } = await c.rpc('get_company_admin_emails', { target_company: target })
  if (error) return { data: null, error }
  const emails = ((data as { email: string | null }[] | null) ?? [])
    .map(r => r.email)
    .filter((e): e is string => !!e)
    .sort()
  return { data: emails, error: null }
}

async function cleanupAll(): Promise<void> {
  console.log('\n── CLEANUP ──')
  for (const fn of cleanup.reverse()) {
    try { await fn() } catch (e) { console.error('cleanup error:', (e as Error).message) }
  }
}

async function main(): Promise<void> {
  console.log(`A2 close-out · get_company_admin_emails probe · ${RUN_TAG}`)
  console.log(`Project: ${url}\n`)

  console.log('── SETUP ──')
  let caA: Persona, caB: Persona, drvA: Persona, noRole: Persona, anonClient: SupabaseClient
  try {
    caA = await spawnCompanyAdminIn(COMPANY_A, 'caA')
    caB = await spawnCompanyAdminIn(COMPANY_B, 'caB')
    drvA = await spawnDriverIn(COMPANY_A, 'drvA')
    noRole = await spawnAuthUser('noRole')
    anonClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
    console.log(`  caA:    ${caA.email} (company_admin, ${COMPANY_A})`)
    console.log(`  caB:    ${caB.email} (company_admin, ${COMPANY_B})`)
    console.log(`  drvA:   ${drvA.email} (driver, ${COMPANY_A})`)
    console.log(`  noRole: ${noRole.email} (authenticated, no user_roles row)`)
  } catch (e) {
    console.error('SETUP FAILED:', (e as Error).message)
    await cleanupAll()
    process.exit(1)
  }

  // ── 1. anon EXECUTE denied ────────────────────────────────────────────────
  console.log('\n── CASE 1 — anon EXECUTE denied ──')
  const r1 = await callRpc(anonClient, COMPANY_A)
  if (r1.error) {
    const msg = r1.error.message.toLowerCase()
    const looksLikeRevoke =
      msg.includes('permission denied') ||
      msg.includes('not allowed') ||
      msg.includes('execute') ||
      r1.error.code === '42501'
    record('a2.anon_execute_denied', looksLikeRevoke,
      looksLikeRevoke
        ? `REVOKE FROM anon enforced: ${r1.error.message}`
        : `unexpected error shape (not a permission denial): ${r1.error.message}`)
  } else {
    record('a2.anon_execute_denied', false,
      `BUG — anon RPC succeeded; returned ${r1.data?.length ?? 0} email(s). REVOKE FROM anon NOT enforced.`)
  }

  // ── 2. authenticated, no user_roles row → get_my_company()=NULL → 0 rows ──
  console.log('\n── CASE 2 — authenticated with no role / NULL caller-company → 0 rows ──')
  const r2 = await callRpc(noRole.client, COMPANY_A)
  if (r2.error) {
    record('a2.no_role_zero_rows', false,
      `unexpected error: ${r2.error.message} (expected 0-row return, not denial)`)
  } else if ((r2.data?.length ?? 0) === 0) {
    record('a2.no_role_zero_rows', true,
      'authenticated user with no user_roles row → 0 emails (NULL get_my_company() excluded by ILIKE)')
  } else {
    record('a2.no_role_zero_rows', false,
      `LEAK — authenticated user with no user_roles row returned ${r2.data?.length} email(s): ${r2.data?.join(', ')}`)
  }

  // ── 3. driver in A + target=A → returns A's admins ────────────────────────
  console.log('\n── CASE 3 — driver in companyA + target=A → A admins ──')
  const r3 = await callRpc(drvA.client, COMPANY_A)
  if (r3.error) {
    record('a2.own_company_returns_admins', false, `unexpected error: ${r3.error.message}`)
  } else {
    const includesCaA = !!r3.data?.includes(caA.email)
    const excludesCaB = !r3.data?.includes(caB.email)
    if (includesCaA && excludesCaB) {
      record('a2.own_company_returns_admins', true,
        `companyA driver sees company_admin caA (${caA.email}); does NOT see caB (cross-company isolated)`)
    } else {
      record('a2.own_company_returns_admins', false,
        `expected caA included + caB excluded; got [${r3.data?.join(', ')}]`)
    }
  }

  // ── 4. driver in A + target=B → STILL returns A's admins (target IGNORED) ─
  console.log('\n── CASE 4 — driver in A + target=B → CLAMP returns A admins (target ignored) ──')
  const r4 = await callRpc(drvA.client, COMPANY_B)
  if (r4.error) {
    record('a2.cross_company_target_ignored', false, `unexpected error: ${r4.error.message}`)
  } else {
    const noCaB = !r4.data?.includes(caB.email)
    const onlyCaA = r4.data?.length === 1 && r4.data[0] === caA.email
    if (noCaB && onlyCaA) {
      record('a2.cross_company_target_ignored', true,
        `target=companyB IGNORED — caller still gets ONLY their own (caA); caB excluded. Body guard holds.`)
    } else if (!noCaB) {
      record('a2.cross_company_target_ignored', false,
        `CROSS-COMPANY LEAK — companyA driver passing target=companyB got caB back. Body guard FAILED.`)
    } else {
      record('a2.cross_company_target_ignored', false,
        `unexpected payload — expected exactly [caA.email]; got [${r4.data?.join(', ')}]`)
    }
  }

  // ── 5. ILIKE preserved — different casing on the IGNORED target ───────────
  // Defensive: even though target_company is ignored, prove the call doesn't
  // 500 or otherwise fail when the caller passes a casing-shifted string.
  // The CLAMP uses ILIKE against get_my_company(); the arg's casing doesn't
  // affect the clamp at all (arg is unused), but a working call confirms the
  // signature still accepts text.
  console.log('\n── CASE 5 — case-shifted target arg → still works (ILIKE preserved + arg unused) ──')
  const shifted = COMPANY_A.toUpperCase()
  const r5 = await callRpc(drvA.client, shifted)
  if (r5.error) {
    record('a2.case_shifted_target_works', false, `unexpected error: ${r5.error.message}`)
  } else {
    const includesCaA = !!r5.data?.includes(caA.email)
    if (includesCaA) {
      record('a2.case_shifted_target_works', true,
        `caller passes target=${shifted} (upper-cased); call returns caA — arg is structurally unused, signature accepts text`)
    } else {
      record('a2.case_shifted_target_works', false,
        `expected caA in result; got [${r5.data?.join(', ')}]`)
    }
  }

  // ── 6. nonsense target string — still returns A's admins (arg fully dead) ─
  console.log('\n── CASE 6 — nonsense target → still returns A admins (target arg fully dead) ──')
  const r6 = await callRpc(drvA.client, `${RUN_TAG}_NONEXISTENT_COMPANY_!@#$%`)
  if (r6.error) {
    record('a2.nonsense_target_works', false, `unexpected error: ${r6.error.message}`)
  } else {
    const includesCaA = !!r6.data?.includes(caA.email)
    if (includesCaA) {
      record('a2.nonsense_target_works', true,
        `target arg is structurally dead — nonsense input still returns own-company admins`)
    } else {
      record('a2.nonsense_target_works', false,
        `expected caA in result; got [${r6.data?.join(', ')}]`)
    }
  }

  // ── 7. WILDCARD SPOOF — driver whose user_roles.company is literally '%' ──
  // The regression case for the original ILIKE clamp. Under ILIKE,
  // get_my_company()='%' makes `ur.company ILIKE '%'` match every row
  // and the caller enumerates every company_admin in the platform. The
  // lower=lower clamp treats '%' as a literal — only matches rows whose
  // company is also '%' (none in this probe). Caller gets ZERO rows.
  //
  // We spawn a fresh driver, then service-role-OVERWRITE its
  // user_roles.company to '%'. (Spawning directly with company='%'
  // would be the same outcome but this path also proves a legacy or
  // attacker-modified row gets clamped, not just first-write data.)
  console.log('\n── CASE 7 — wildcard spoof: driver with company=\'%\' → ZERO rows ──')
  let drvWild: Persona | null = null
  try {
    drvWild = await spawnDriverIn(COMPANY_A, 'drvWild')
    // Overwrite the spawned driver's company to the literal '%' string.
    const { error: updErr } = await admin
      .from('user_roles')
      .update({ company: '%' })
      .eq('email', drvWild.email)
    if (updErr) throw new Error(`update company='%': ${updErr.message}`)
    // Force the JWT to pick up the change. user_roles is read by
    // get_my_company() under SECURITY DEFINER; no refresh required for
    // the body to see the new value, but refresh is harmless.
    await drvWild.client.auth.refreshSession()
  } catch (e) {
    record('a2.wildcard_spoof_zero_rows', false,
      `setup failed: ${(e as Error).message}`)
  }
  if (drvWild) {
    const r7 = await callRpc(drvWild.client, COMPANY_A)
    if (r7.error) {
      record('a2.wildcard_spoof_zero_rows', false,
        `unexpected error: ${r7.error.message}`)
    } else if ((r7.data?.length ?? 0) === 0) {
      record('a2.wildcard_spoof_zero_rows', true,
        `company='%' caller got 0 rows — wildcard semantics confirmed gone (lower=lower literal match holds)`)
    } else {
      const leaked = r7.data?.join(', ')
      record('a2.wildcard_spoof_zero_rows', false,
        `WILDCARD LEAK — company='%' caller got ${r7.data?.length} admin email(s): [${leaked}]. ILIKE clamp may have been restored — DO NOT MERGE.`)
    }
  }

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

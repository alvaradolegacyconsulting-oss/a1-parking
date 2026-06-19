// scripts/provision-a1-rehearsal.ts
//
// A1-onboarding rehearsal — provisions ONE company-admin account against
// a CLEARLY-DISTINCT company name so the A1 team can rehearse THEIR
// initial setup (add properties, managers, residents, drivers) on the
// post-signup state of the platform.
//
// THE NAME-COLLISION TRAP (locked decision 2026-06-19)
//   The company row is NOT named the literal 'A1 Wrecker LLC'. That
//   string is precisely what the pre-launch deny-list wipe is built to
//   PRESERVE — naming the rehearsal company that would let it survive
//   the wipe as if real, and the rehearsal-account user-metadata flag
//   ({a1_rehearsal: true}) is on the auth user, not the companies row,
//   so a name-match by the wipe would not catch the rehearsal.
//
//   Three independent throwaway signals so rehearsal data can't be
//   mistaken for production or leak through the wipe:
//     1. Email alias — alvaradolegacyconsulting+A1RehearsalCA@gmail.com
//     2. User metadata — {a1_rehearsal: true} on auth.users
//     3. Company name — 'A1 Wrecker (REHEARSAL)' — DELIBERATELY distinct
//        from the literal 'A1 Wrecker LLC' so the deny-list wipe DELETES
//        it as test data
//
// WHAT THE SCRIPT PROVISIONS
//   • companies row: name='A1 Wrecker (REHEARSAL)', tier='legacy',
//     tier_type='enforcement', is_active=true, account_state='active'.
//     Mirrors the post-signup state A1 will have after their real
//     proposal-code redemption — no properties, managers, drivers,
//     residents (the A1 team adds those during the rehearsal).
//   • auth user: alvaradolegacyconsulting+A1RehearsalCA@gmail.com,
//     email_confirmed=true (skips email verify; rehearsal), with user
//     metadata {a1_rehearsal: true, must_change_password: true}.
//   • user_roles row: role='company_admin', company='A1 Wrecker (REHEARSAL)',
//     property=[].
//
// WHAT THE SCRIPT DOES NOT PROVISION (intentional)
//   • Properties, managers, drivers, residents, vehicles — A1 team
//     adds these during rehearsal. That's the test.
//   • Stripe subscription — the real production path is B66.7
//     proposal-code redemption which creates the Stripe subscription.
//     Rehearsal skips this. The rehearsal CA will see "billing not set
//     up" in /company_admin/billing, which is realistic next-step UX
//     they'd resolve at production onboarding.
//
// REFUSE-IF-EXISTS GATE
//   If a row matching name='A1 Wrecker (REHEARSAL)' already exists, the
//   script aborts unless --force-rotate is passed. Defense against
//   double-provisioning (and an indicator that either Jose's running
//   accidentally OR a prior rehearsal hasn't been cleaned up).
//   --force-rotate updates the existing company + auth user (password
//   reset on the auth user) without creating duplicate companies.
//
// ENV VAR — REHEARSAL_CA_EMAIL (optional override)
//   Defaults to alvaradolegacyconsulting+A1RehearsalCA@gmail.com (the
//   locked rehearsal alias). Override by setting REHEARSAL_CA_EMAIL
//   in the environment. ANY override MUST be a clearly-marked
//   rehearsal alias — not A1's real contact email — and MUST be
//   deleted post-rehearsal.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/provision-a1-rehearsal.ts
//
//   To re-provision an existing rehearsal company (rotate password):
//   npx tsx --env-file=.env.local scripts/provision-a1-rehearsal.ts \
//     --force-rotate

import { createClient } from '@supabase/supabase-js'

const REHEARSAL_COMPANY_NAME = 'A1 Wrecker (REHEARSAL)' // NOT 'A1 Wrecker LLC' — deny-list wipe survivability hazard
const REHEARSAL_CA_EMAIL = (process.env.REHEARSAL_CA_EMAIL || 'alvaradolegacyconsulting+A1RehearsalCA@gmail.com').trim().toLowerCase()
const REHEARSAL_CA_PASSWORD = 'A1Rehearsal2026!' // initial password; must_change_password=true forces reset on first sign-in
const TIER_TYPE = 'enforcement' as const
const TIER = 'legacy' as const

const FORCE_ROTATE = process.argv.includes('--force-rotate')

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[provision-a1-rehearsal] missing env vars.')
    console.error('  NEXT_PUBLIC_SUPABASE_URL:', supabaseUrl ? '(set)' : '(MISSING)')
    console.error('  SUPABASE_SERVICE_ROLE_KEY:', serviceRoleKey ? `(set, len=${serviceRoleKey.length})` : '(MISSING)')
    process.exit(1)
  }

  // Name-collision sanity check at process boundary — REFUSES to proceed
  // if anything in the env looks like it's trying to provision the real
  // A1 company name. Defense-in-depth: even if a future edit accidentally
  // changes REHEARSAL_COMPANY_NAME to a real-looking string, this guard
  // fires first.
  if (REHEARSAL_COMPANY_NAME.toLowerCase().trim() === 'a1 wrecker llc') {
    console.error('[provision-a1-rehearsal] REHEARSAL_COMPANY_NAME matches the production A1 name.')
    console.error('  This would survive the pre-launch deny-list wipe as if real.')
    console.error('  Aborting. Use a clearly-distinct rehearsal name (e.g., "A1 Wrecker (REHEARSAL)").')
    process.exit(2)
  }
  if (!REHEARSAL_CA_EMAIL.includes('rehearsal') && !REHEARSAL_CA_EMAIL.includes('+uat') && !REHEARSAL_CA_EMAIL.includes('+test')) {
    console.error('[provision-a1-rehearsal] REHEARSAL_CA_EMAIL does not contain "rehearsal" / "uat" / "test".')
    console.error('  Refusing to use an ambiguous alias for a rehearsal account.')
    console.error('  Got:', REHEARSAL_CA_EMAIL)
    process.exit(3)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })

  console.log('╔══════════════════════════════════════════════════════════════════╗')
  console.log('║  A1 ONBOARDING REHEARSAL — REHEARSAL ENVIRONMENT, NOT PRODUCTION ║')
  console.log('╠══════════════════════════════════════════════════════════════════╣')
  console.log(`║  Company:   ${REHEARSAL_COMPANY_NAME.padEnd(53)}║`)
  console.log(`║  Tier:      ${`${TIER_TYPE} / ${TIER}`.padEnd(53)}║`)
  console.log(`║  CA email:  ${REHEARSAL_CA_EMAIL.padEnd(53)}║`)
  console.log(`║  Mode:      ${(FORCE_ROTATE ? 'force-rotate (will update existing if present)' : 'refuse-if-exists').padEnd(53)}║`)
  console.log('╚══════════════════════════════════════════════════════════════════╝\n')

  // ── 1. Companies row ────────────────────────────────────────────
  console.log('[1/3] Company row')
  const { data: existingCompany } = await supabase
    .from('companies')
    .select('id, name, tier_type, tier, is_active, account_state')
    .ilike('name', REHEARSAL_COMPANY_NAME)
    .maybeSingle()

  let companyId: number
  if (existingCompany) {
    if (!FORCE_ROTATE) {
      console.error(`  ✗ company "${REHEARSAL_COMPANY_NAME}" already exists (id=${existingCompany.id}).`)
      console.error(`    Refusing to double-provision. Pass --force-rotate to update existing.`)
      process.exit(4)
    }
    companyId = existingCompany.id
    const { error } = await supabase.from('companies').update({
      tier_type: TIER_TYPE,
      tier: TIER,
      is_active: true,
      account_state: 'active',
    }).eq('id', companyId)
    if (error) { console.error(`  ✗ company update failed: ${error.message}`); process.exit(5) }
    console.log(`  ✓ company "${REHEARSAL_COMPANY_NAME}" updated (id=${companyId})`)
  } else {
    const { data, error } = await supabase.from('companies').insert([{
      name: REHEARSAL_COMPANY_NAME,
      tier_type: TIER_TYPE,
      tier: TIER,
      is_active: true,
      account_state: 'active',
    }]).select('id').single()
    if (error || !data) { console.error(`  ✗ company INSERT failed: ${error?.message}`); process.exit(5) }
    companyId = data.id
    console.log(`  ✓ company "${REHEARSAL_COMPANY_NAME}" created (id=${companyId})`)
  }

  // ── 2. Auth user ────────────────────────────────────────────────
  console.log(`\n[2/3] Auth user (${REHEARSAL_CA_EMAIL})`)
  let authUserId: string
  const { data: created, error: cErr } = await supabase.auth.admin.createUser({
    email: REHEARSAL_CA_EMAIL,
    password: REHEARSAL_CA_PASSWORD,
    email_confirm: true,
    user_metadata: {
      a1_rehearsal: true,
      must_change_password: true,
    },
  })
  if (created?.user) {
    authUserId = created.user.id
    console.log(`  ✓ auth user created (id=${authUserId})`)
  } else if (cErr && (cErr.status === 422 || /already.*regis|already.*exist/i.test(cErr.message))) {
    if (!FORCE_ROTATE) {
      console.error(`  ✗ auth user ${REHEARSAL_CA_EMAIL} already exists.`)
      console.error(`    Pass --force-rotate to update (rotates password + metadata).`)
      process.exit(6)
    }
    // Find + update existing
    const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 })
    const existing = (list?.users ?? []).find(u => (u.email ?? '').toLowerCase() === REHEARSAL_CA_EMAIL)
    if (!existing) { console.error(`  ✗ auth user said-exists but listUsers can't find ${REHEARSAL_CA_EMAIL}`); process.exit(6) }
    authUserId = existing.id
    const { error: uErr } = await supabase.auth.admin.updateUserById(existing.id, {
      password: REHEARSAL_CA_PASSWORD,
      email_confirm: true,
      user_metadata: {
        a1_rehearsal: true,
        must_change_password: true,
      },
    })
    if (uErr) { console.error(`  ✗ auth user updateUserById failed: ${uErr.message}`); process.exit(6) }
    console.log(`  ✓ auth user updated (id=${authUserId}, password rotated)`)
  } else {
    console.error(`  ✗ auth user createUser failed: ${cErr?.message ?? 'unknown error'}`)
    process.exit(6)
  }

  // ── 3. user_roles row ───────────────────────────────────────────
  console.log(`\n[3/3] user_roles row`)
  const { data: existingRole } = await supabase
    .from('user_roles')
    .select('email, role, company, property')
    .ilike('email', REHEARSAL_CA_EMAIL)
    .maybeSingle()
  if (existingRole) {
    const matches = existingRole.role === 'company_admin' && existingRole.company === REHEARSAL_COMPANY_NAME
    if (matches) {
      console.log(`  ✓ user_roles row for ${REHEARSAL_CA_EMAIL} matches expected shape`)
    } else {
      const { error } = await supabase.from('user_roles').update({
        role: 'company_admin',
        company: REHEARSAL_COMPANY_NAME,
        property: [],
      }).ilike('email', REHEARSAL_CA_EMAIL)
      if (error) { console.error(`  ✗ user_roles update failed: ${error.message}`); process.exit(7) }
      console.log(`  ✓ user_roles updated for ${REHEARSAL_CA_EMAIL}`)
    }
  } else {
    const { error } = await supabase.from('user_roles').insert([{
      email: REHEARSAL_CA_EMAIL,
      role: 'company_admin',
      company: REHEARSAL_COMPANY_NAME,
      property: [],
    }])
    if (error) { console.error(`  ✗ user_roles INSERT failed: ${error.message}`); process.exit(7) }
    console.log(`  ✓ user_roles inserted for ${REHEARSAL_CA_EMAIL}`)
  }

  // ── Hand-off summary ────────────────────────────────────────────
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'
  console.log('\n═══════════════════════════════════════════════════════════════════')
  console.log('  REHEARSAL ENVIRONMENT READY')
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log(`\nCompany:   ${REHEARSAL_COMPANY_NAME}  (id=${companyId})`)
  console.log(`Tier:      ${TIER_TYPE} / ${TIER}`)
  console.log(`Login URL: ${appUrl}/login`)
  console.log(`CA email:  ${REHEARSAL_CA_EMAIL}`)
  console.log(`Password:  ${REHEARSAL_CA_PASSWORD}  (must_change_password=true → forced reset on first sign-in)`)
  console.log(`\nThe rehearsal CA logs in and rehearses:`)
  console.log(`  • Forced password change`)
  console.log(`  • Add properties → managers → leasing_agents → drivers → residents`)
  console.log(`  • Bulk-upload flow if A1 will use it`)
  console.log(`  • Manager portal workflows (approve vehicles, issue passes, etc.)`)
  console.log(`\nThe rehearsal does NOT exercise the real signup/proposal-code path.`)
  console.log(`That's a separate ~5-minute walkthrough Jose does before A1's actual`)
  console.log(`onboarding date — /signup/redeem flow + Stripe billing setup.`)
  console.log(`\nPost-rehearsal: delete the company + auth user. Pre-launch deny-list`)
  console.log(`wipe will catch it via name='${REHEARSAL_COMPANY_NAME}' (NOT 'A1 Wrecker LLC',`)
  console.log(`which is the protected production name).`)
}

main().catch(e => { console.error('Unhandled:', (e as Error).message); process.exit(99) })

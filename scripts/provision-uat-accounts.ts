// Pre-workshop UAT — provisioning script for testing-lead session.
//
// One-shot setup that creates a complete A1-context test environment
// (company + property + 5 role accounts + 2 seed vehicles) so the
// testing lead can hand credentials to 2 team members and observe.
//
// ── PROVISIONS ──────────────────────────────────────────────────────
//   • Company: "A1 Wrecker (UAT)" — enforcement.legacy, active.
//   • Property: "UAT Test Property" under that company.
//   • 5 auth users (auto-confirmed, passwords set):
//       - company_admin / driver / manager / leasing_agent / resident
//     All use +uat-<role>@gmail.com aliases on Jose's address.
//   • user_roles rows for each, manager + leasing_agent assigned to
//     the UAT property.
//   • drivers row for the driver user, assigned to UAT property.
//   • residents row for the resident user, unit "1A".
//   • 2 seed vehicles under the resident's unit, both active+approved.
//
// ── IDEMPOTENCY ─────────────────────────────────────────────────────
// Safe to re-run:
//   • Company / property / role rows checked-then-inserted via
//     .maybeSingle() probes.
//   • Auth users created via auth.admin.createUser; if the user
//     already exists (Supabase returns AuthApiError 422), we fall back
//     to listUsers + updateUserById to (re)set the password and
//     confirm the email. Net: re-running rotates passwords cleanly.
//   • Vehicles probe by (plate, unit, property) before insert.
//
// ── BYPASSES SIGNUP DELIBERATELY ────────────────────────────────────
// Per docs/smoke-test-user-procedure.md: B117 PKCE + email-delivery
// flakiness make the /signup flow unreliable for testing. This script
// is the standard test-user procedure — Dashboard add-user pattern,
// scripted for the 5-user multi-role case.
//
// ── USAGE ───────────────────────────────────────────────────────────
//   npx tsx --env-file=.env.local scripts/provision-uat-accounts.ts
//
// Or with explicit env:
//   NEXT_PUBLIC_SUPABASE_URL=https://... \
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
//   npx tsx scripts/provision-uat-accounts.ts
//
// ── SAFETY ──────────────────────────────────────────────────────────
//   • Refuses to run with missing env vars.
//   • Per-step error handling: a single failure logs + continues so
//     the run prints maximal context for diagnosis.
//   • No SERVICE_ROLE_KEY value logged (length-only).
//   • All test data scoped to "A1 Wrecker (UAT)" + "UAT Test Property"
//     for clean cascade-delete at pre-launch DB wipe.
//
// ── DELETE AFTER UAT? ───────────────────────────────────────────────
// Keep the script — re-runnable for any future pre-workshop session.
// The test DATA gets wiped pre-launch; the script stays.

import { createClient } from '@supabase/supabase-js'

// Tier variant selection. Default = enforcement.legacy (A1's actual tier;
// backward-compatible with all pre-existing UAT runs). CLI overrides:
//   --tier=starter       → enforcement.starter UAT account (scan-plate Starter 403 case)
//   --tier=pm-essential  → property_management.essential UAT account (scan-plate PM 403 case)
// Each variant creates a distinct company name + email-suffix namespace so
// the three variants coexist cleanly on the same Supabase project.
//
// USAGE:
//   npx tsx --env-file=.env.local scripts/provision-uat-accounts.ts
//   npx tsx --env-file=.env.local scripts/provision-uat-accounts.ts --tier=starter
//   npx tsx --env-file=.env.local scripts/provision-uat-accounts.ts --tier=pm-essential
type TierVariant = 'legacy' | 'starter' | 'pm-essential'
const tierArg = (process.argv.find(a => a.startsWith('--tier=')) ?? '').slice('--tier='.length)
const TIER_VARIANT: TierVariant = (() => {
  if (tierArg === 'starter' || tierArg === 'pm-essential' || tierArg === 'legacy' || tierArg === '') {
    return (tierArg || 'legacy') as TierVariant
  }
  console.error(`[provision-uat] unknown --tier=${tierArg}; valid: legacy | starter | pm-essential`)
  process.exit(2)
})()

const VARIANT_CONFIG = {
  legacy: {
    companyName: 'A1 Wrecker (UAT)',
    tier_type: 'enforcement' as const,
    tier: 'legacy' as const,
    emailSuffix: '',         // existing aliases — unchanged
    pwSuffix: '',
  },
  starter: {
    companyName: 'A1 Starter (UAT)',
    tier_type: 'enforcement' as const,
    tier: 'starter' as const,
    emailSuffix: '-starter',
    pwSuffix: 'ST',
  },
  'pm-essential': {
    companyName: 'A1 PM (UAT)',
    tier_type: 'property_management' as const,
    tier: 'essential' as const,
    emailSuffix: '-pm',
    pwSuffix: 'PM',
  },
}[TIER_VARIANT]

const COMPANY_NAME = VARIANT_CONFIG.companyName
const COMPANY_TIER_TYPE: 'enforcement' | 'property_management' = VARIANT_CONFIG.tier_type
const COMPANY_TIER: 'legacy' | 'starter' | 'essential' = VARIANT_CONFIG.tier
const PROPERTY_NAME = 'UAT Test Property'
const PROPERTY_ADDRESS = '123 UAT Lane'
const PROPERTY_CITY = 'Houston'
const PROPERTY_STATE = 'TX'
const PROPERTY_ZIP = '77001'
const PROPERTY_TOTAL_SPACES = 50

const RESIDENT_UNIT = '1A'

interface UserSpec {
  email: string
  password: string
  role: 'company_admin' | 'driver' | 'manager' | 'leasing_agent' | 'resident'
  scopeProperty: boolean // assigns property[] = [PROPERTY_NAME] in user_roles
}

// Email aliases parameterized by tier-variant suffix. Legacy stays at the
// original +uat-{role}; Starter/PM get +uat-starter-{role} / +uat-pm-{role}
// so all three variants coexist without collision. Passwords get a 2-char
// variant tag for ease-of-recall during UAT but stay deterministic per-role.
const ES = VARIANT_CONFIG.emailSuffix
const PS = VARIANT_CONFIG.pwSuffix
// PM track: MAX_DRIVERS=0 + no driver-portal feature (per tier-config).
// Skip the driver user + drivers entity row + vehicles for PM variant so
// we don't seed structurally meaningless rows. The CA persona on PM is
// sufficient for the scan-plate PM 403 entitlement test (entitlement
// gate fires per company.tier_type — caller role within the allowed set
// is fine; the matrix denies AI_PLATE_SCANNING for any PM tier).
const IS_PM = COMPANY_TIER_TYPE === 'property_management'
const USERS: UserSpec[] = [
  { email: `alvaradolegacyconsulting+uat${ES}-ca@gmail.com`,       password: `UAT2026!${PS}CA`, role: 'company_admin',  scopeProperty: false },
  ...(IS_PM ? [] : [
    { email: `alvaradolegacyconsulting+uat${ES}-driver@gmail.com`, password: `UAT2026!${PS}DR`, role: 'driver' as const, scopeProperty: false },
  ]),
  { email: `alvaradolegacyconsulting+uat${ES}-manager@gmail.com`,  password: `UAT2026!${PS}MG`, role: 'manager',        scopeProperty: true  },
  { email: `alvaradolegacyconsulting+uat${ES}-leasing@gmail.com`,  password: `UAT2026!${PS}LE`, role: 'leasing_agent',  scopeProperty: true  },
  { email: `alvaradolegacyconsulting+uat${ES}-resident@gmail.com`, password: `UAT2026!${PS}RE`, role: 'resident',       scopeProperty: true  },
]

interface VehicleSpec {
  plate: string
  state: string
  make: string
  model: string
  year: number
  color: string
}

const SEED_VEHICLES: VehicleSpec[] = [
  { plate: 'UAT001', state: 'TX', make: 'Toyota',    model: 'Camry',  year: 2022, color: 'Silver' },
  { plate: 'UAT002', state: 'TX', make: 'Ford',      model: 'F-150',  year: 2021, color: 'Black'  },
]

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[provision-uat] missing env vars.')
    console.error('  NEXT_PUBLIC_SUPABASE_URL:', supabaseUrl ? '(set)' : '(MISSING)')
    console.error('  SUPABASE_SERVICE_ROLE_KEY:', serviceRoleKey ? `(set, len=${serviceRoleKey.length})` : '(MISSING)')
    console.error('Run: npx tsx --env-file=.env.local scripts/provision-uat-accounts.ts')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  console.log('═══════════════════════════════════════════════════════════')
  console.log('  Pre-Workshop UAT — provisioning')
  console.log('═══════════════════════════════════════════════════════════')

  // ── 1. Company ────────────────────────────────────────────────────
  console.log(`\n[1/6] Company: "${COMPANY_NAME}"`)
  const { data: existingCompany } = await supabase
    .from('companies')
    .select('id, tier, tier_type, account_state')
    .ilike('name', COMPANY_NAME)
    .maybeSingle()

  let companyId: number
  if (existingCompany) {
    companyId = existingCompany.id as number
    console.log(`  ✓ exists (id=${companyId}, tier=${existingCompany.tier_type}.${existingCompany.tier}, state=${existingCompany.account_state})`)
    if (existingCompany.tier !== COMPANY_TIER || existingCompany.tier_type !== COMPANY_TIER_TYPE || existingCompany.account_state !== 'active') {
      console.log(`  → updating tier/state to enforcement.legacy/active`)
      await supabase.from('companies').update({
        tier: COMPANY_TIER,
        tier_type: COMPANY_TIER_TYPE,
        account_state: 'active',
        is_active: true,
      }).eq('id', companyId)
    }
  } else {
    const { data, error } = await supabase.from('companies').insert([{
      name: COMPANY_NAME,
      tier_type: COMPANY_TIER_TYPE,
      tier: COMPANY_TIER,
      account_state: 'active',
      is_active: true,
      // acquisition_channel intentionally NULL — CHECK admits only
      // 'self_serve' or 'proposal_code'; UAT data is neither.
    }]).select('id').single()
    if (error || !data) { console.error('  ✗ company INSERT failed:', error?.message); process.exit(2) }
    companyId = data.id as number
    console.log(`  ✓ created (id=${companyId})`)
  }

  // ── 2. Property ───────────────────────────────────────────────────
  console.log(`\n[2/6] Property: "${PROPERTY_NAME}"`)
  const { data: existingProperty } = await supabase
    .from('properties')
    .select('id, name, is_active')
    .ilike('name', PROPERTY_NAME)
    .ilike('company', COMPANY_NAME)
    .maybeSingle()

  if (existingProperty) {
    console.log(`  ✓ exists (id=${existingProperty.id}, active=${existingProperty.is_active})`)
    if (!existingProperty.is_active) {
      await supabase.from('properties').update({ is_active: true }).eq('id', existingProperty.id)
      console.log(`  → reactivated`)
    }
  } else {
    const { error } = await supabase.from('properties').insert([{
      name: PROPERTY_NAME,
      company: COMPANY_NAME,
      address: PROPERTY_ADDRESS,
      city: PROPERTY_CITY,
      state: PROPERTY_STATE,
      zip: PROPERTY_ZIP,
      total_spaces: PROPERTY_TOTAL_SPACES,
      is_active: true,
    }])
    if (error) { console.error('  ✗ property INSERT failed:', error.message); process.exit(2) }
    console.log(`  ✓ created`)
  }

  // ── 3. Auth users (idempotent) ────────────────────────────────────
  console.log(`\n[3/6] Auth users (5)`)
  // Pre-fetch existing users in one paginated listUsers call so the
  // per-user idempotency probe is cheap.
  const { data: listed } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const existingByEmail = new Map(
    (listed?.users || []).map(u => [u.email?.toLowerCase() ?? '', u])
  )

  for (const u of USERS) {
    const existing = existingByEmail.get(u.email.toLowerCase())
    if (existing) {
      const { error } = await supabase.auth.admin.updateUserById(existing.id, {
        password: u.password,
        email_confirm: true,
      })
      if (error) {
        console.error(`  ✗ ${u.email} — updateUserById failed: ${error.message}`)
        continue
      }
      console.log(`  ✓ ${u.email} (existing — password reset + confirmed)`)
    } else {
      const { error } = await supabase.auth.admin.createUser({
        email: u.email,
        password: u.password,
        email_confirm: true,
      })
      if (error) {
        console.error(`  ✗ ${u.email} — createUser failed: ${error.message}`)
        continue
      }
      console.log(`  ✓ ${u.email} (created + confirmed)`)
    }
  }

  // ── 4. user_roles ─────────────────────────────────────────────────
  console.log(`\n[4/6] user_roles`)
  for (const u of USERS) {
    const propertyArr = u.scopeProperty ? [PROPERTY_NAME] : []
    const { data: existing } = await supabase
      .from('user_roles')
      .select('email, role, company, property')
      .ilike('email', u.email)
      .maybeSingle()
    if (existing) {
      const propertyMatches = JSON.stringify((existing.property as string[]) || []) === JSON.stringify(propertyArr)
      const allMatch = existing.role === u.role && existing.company === COMPANY_NAME && propertyMatches
      if (allMatch) {
        console.log(`  ✓ ${u.email} (role=${u.role}, scope=${u.scopeProperty ? PROPERTY_NAME : '—'}) — exists`)
      } else {
        await supabase.from('user_roles').update({
          role: u.role,
          company: COMPANY_NAME,
          property: propertyArr,
        }).ilike('email', u.email)
        console.log(`  ✓ ${u.email} — updated to (role=${u.role}, scope=${u.scopeProperty ? PROPERTY_NAME : '—'})`)
      }
    } else {
      const { error } = await supabase.from('user_roles').insert([{
        email: u.email,
        role: u.role,
        company: COMPANY_NAME,
        property: propertyArr,
      }])
      if (error) { console.error(`  ✗ ${u.email} — user_roles INSERT failed:`, error.message); continue }
      console.log(`  ✓ ${u.email} (role=${u.role}, scope=${u.scopeProperty ? PROPERTY_NAME : '—'}) — inserted`)
    }
  }

  // ── 5. drivers row (for the driver user; ENFORCEMENT track only) ──
  console.log(`\n[5/6] drivers + residents seed rows`)
  const driverUser = USERS.find(u => u.role === 'driver')
  if (!driverUser) {
    console.log(`  ✓ drivers row SKIPPED (${COMPANY_TIER_TYPE} track — no driver user provisioned)`)
  } else {
    const { data: existingDriver } = await supabase
      .from('drivers')
      .select('id')
      .ilike('email', driverUser.email)
      .maybeSingle()
    if (existingDriver) {
      console.log(`  ✓ drivers row for ${driverUser.email} exists (id=${existingDriver.id})`)
    } else {
      const { error } = await supabase.from('drivers').insert([{
        name: 'UAT Driver',
        email: driverUser.email,
        phone: '713-555-0101',
        operator_license: 'TX-OPS-UAT-001',
        assigned_properties: [PROPERTY_NAME],
        company: COMPANY_NAME,
        is_active: true,
      }])
      if (error) console.error('  ✗ drivers INSERT failed:', error.message)
      else console.log(`  ✓ drivers row created for ${driverUser.email}`)
    }
  }

  // ── 5b. residents row (for the resident user) ─────────────────────
  const residentUser = USERS.find(u => u.role === 'resident')!
  const { data: existingResident } = await supabase
    .from('residents')
    .select('id')
    .ilike('email', residentUser.email)
    .maybeSingle()
  if (existingResident) {
    console.log(`  ✓ residents row for ${residentUser.email} exists (id=${existingResident.id})`)
  } else {
    const { error } = await supabase.from('residents').insert([{
      email: residentUser.email,
      name: 'UAT Resident',
      phone: '713-555-0102',
      unit: RESIDENT_UNIT,
      property: PROPERTY_NAME,
      company: COMPANY_NAME,
      is_active: true,
      status: 'approved',
      texas_confirmed: true,
      texas_confirmed_at: new Date().toISOString(),
    }])
    if (error) console.error('  ✗ residents INSERT failed:', error.message)
    else console.log(`  ✓ residents row created for ${residentUser.email} (unit ${RESIDENT_UNIT})`)
  }

  // ── 6. Seed vehicles (2, both active/approved) ────────────────────
  console.log(`\n[6/6] Seed vehicles (2)`)
  for (const v of SEED_VEHICLES) {
    const { data: existing } = await supabase
      .from('vehicles')
      .select('id, plate')
      .eq('plate', v.plate)
      .eq('unit', RESIDENT_UNIT)
      .ilike('property', PROPERTY_NAME)
      .maybeSingle()
    if (existing) {
      console.log(`  ✓ vehicle ${v.plate} exists (id=${existing.id})`)
      continue
    }
    const { error } = await supabase.from('vehicles').insert([{
      plate: v.plate,
      state: v.state,
      make: v.make,
      model: v.model,
      year: v.year,
      color: v.color,
      unit: RESIDENT_UNIT,
      property: PROPERTY_NAME,
      is_active: true,
      status: 'active',
    }])
    if (error) console.error(`  ✗ vehicle ${v.plate} INSERT failed:`, error.message)
    else console.log(`  ✓ vehicle ${v.plate} created (${v.year} ${v.color} ${v.make} ${v.model})`)
  }

  // ── HAND-OFF SUMMARY ──────────────────────────────────────────────
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'
  const encodedProperty = encodeURIComponent(PROPERTY_NAME)
  const encodedCompany = encodeURIComponent(COMPANY_NAME)
  const registerUrl = `${appUrl}/register?property=${encodedProperty}&company=${encodedCompany}`

  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('  HAND-OFF — copy below to the testing lead')
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`\nCompany:    ${COMPANY_NAME}`)
  console.log(`Tier:       ${COMPANY_TIER_TYPE} / ${COMPANY_TIER}`)
  console.log(`Property:   ${PROPERTY_NAME}  (manager + leasing_agent scoped)`)
  console.log(`\nCredentials (login at ${appUrl}/login):`)
  for (const u of USERS) {
    console.log(`  ${u.role.padEnd(15)} ${u.email}`)
    console.log(`  ${' '.repeat(15)}   password: ${u.password}`)
  }
  console.log(`\nKnown resident plate (driver plate-lookup TC + visitor precheck TC):`)
  console.log(`  ${SEED_VEHICLES[0].plate} — ${SEED_VEHICLES[0].year} ${SEED_VEHICLES[0].color} ${SEED_VEHICLES[0].make} ${SEED_VEHICLES[0].model}`)
  console.log(`  unit: ${RESIDENT_UNIT}`)
  console.log(`\nResident self-registration link (for new-resident TC):`)
  console.log(`  ${registerUrl}`)
  console.log(`\nVisitor flow (anonymous — incognito):`)
  console.log(`  ${appUrl}/visitor  →  select "${PROPERTY_NAME}"`)
  console.log('\n═══════════════════════════════════════════════════════════')
}

main().catch(err => {
  console.error('[provision-uat] fatal:', err)
  process.exit(1)
})

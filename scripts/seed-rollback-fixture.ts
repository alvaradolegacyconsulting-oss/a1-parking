// ════════════════════════════════════════════════════════════════════
// Rollback-path test fixture — manager addResident catch (2026-09-22)
// ════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS
// ---------------
// Step 2 of the swift-handler deploy needs the ROLLBACK at
// app/manager/page.tsx:2892 to actually fire. The obvious trigger — "use
// an email that already exists" — does NOT work: create_user returns 400,
// app/manager/page.tsx:2770 alerts and `return`s, and the try block is
// never entered. No auth user is created, so no orphan, so the test comes
// back clean having proved nothing.
//
// The rollback only fires when the auth user IS created and a LATER step
// fails. This fixture engineers exactly that:
//
//   user_roles row EXISTS for the address  +  auth.users row does NOT
//
// So in the manager portal:
//   1. create_user succeeds            → a real auth user now exists
//   2. residents INSERT succeeds       → residentInserted = true
//   3. insert_user_role RPC fails      → 23505 on user_roles_lower_email_uidx
//   4. throw → catch → ROLLBACK RUNS   → this is what we are testing
//
// The seeded row's company matches the manager's, so insert_user_role
// clears its company-scope check and fails at the INSERT — the realistic
// failure, not a scope refusal that would also fire the rollback but for
// the wrong reason.
//
// Usage:
//   npx tsx scripts/seed-rollback-fixture.ts            seed + verify
//   npx tsx scripts/seed-rollback-fixture.ts --cleanup  remove everything
import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const sb = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'))

// 🔴 TEST-LEGACY ONLY. Do NOT run this against an A1 property: the
// residents row lands and is then deleted, and cascadeVehiclesIfUnitVacant
// runs on rollback — real churn visible to a live customer's manager.
const EMAIL = 'rollback-fixture-922@test.shieldmylot.com'
const COMPANY = 'Test-LEGACY'
const PROPERTY = 'Test Legacy Property'
const MANAGER = 'legacy-manager@test.shieldmylot.com'

async function authIdFor(email: string) {
  const { data } = await sb.rpc('get_auth_user_id_by_email', { p_email: email })
  return (data as string | null) ?? null
}

async function cleanup() {
  console.log('── cleanup ──')
  const { data: del } = await sb.from('user_roles').delete().ilike('email', EMAIL).select('email')
  console.log(`  user_roles rows removed: ${(del || []).length}`)
  const { data: res } = await sb.from('residents').delete().ilike('email', EMAIL).select('email')
  console.log(`  residents rows removed:  ${(res || []).length}`)
  const id = await authIdFor(EMAIL)
  if (id) {
    const { error } = await sb.auth.admin.deleteUser(id)
    console.log(error ? `  🔴 auth user delete failed: ${error.message}` : '  auth user removed: 1')
  } else {
    console.log('  auth user removed: 0 (none present)')
  }
  const { data: left } = await sb.from('user_roles').select('email').ilike('email', EMAIL)
  const leftAuth = await authIdFor(EMAIL)
  console.log((left || []).length === 0 && !leftAuth
    ? '  ✅ verified — nothing remains'
    : `  🔴 REMAINS: ${(left || []).length} role row(s), auth user ${leftAuth ? 'PRESENT' : 'absent'}`)
}

async function seed() {
  // Never seed on top of existing state — a probe that collides with what
  // is already there measures the collision, not the thing.
  const { data: pre } = await sb.from('user_roles').select('email').ilike('email', EMAIL)
  const preAuth = await authIdFor(EMAIL)
  if ((pre || []).length || preAuth) {
    console.log('🔴 fixture address is already in use. Run with --cleanup first.')
    console.log(`   user_roles rows: ${(pre || []).length}   auth user: ${preAuth ? 'PRESENT' : 'absent'}`)
    process.exit(1)
  }

  const { error } = await sb.from('user_roles').insert([{
    email: EMAIL, role: 'resident', company: COMPANY, property: [PROPERTY],
  }])
  if (error) { console.log('🔴 seed failed:', error.message); process.exit(1) }

  // Verify the fixture is in the shape the test needs — BOTH halves.
  // A role row alone is not the fixture; the ABSENT auth user is half of it.
  const { data: post } = await sb.from('user_roles').select('email, role, company, property').ilike('email', EMAIL)
  const postAuth = await authIdFor(EMAIL)
  const ok = (post || []).length === 1 && !postAuth
  console.log('── fixture state ──')
  console.log(`  user_roles row : ${(post || []).length === 1 ? '✅ present' : '🔴 ' + (post || []).length + ' rows'}  ${JSON.stringify(post?.[0] ?? null)}`)
  console.log(`  auth.users row : ${!postAuth ? '✅ absent (required)' : '🔴 PRESENT — the fixture will not trigger the rollback'}`)
  if (!ok) { console.log('\n🔴 fixture is NOT in the required shape.'); process.exit(1) }

  console.log(`
✅ SEEDED.

Run the trigger in the manager portal:
  • sign in as   ${MANAGER}
  • property     ${PROPERTY}   (🔴 NOT an A1 property)
  • Add Resident → email: ${EMAIL}
  • name and unit: anything. A vehicle plate is irrelevant — the failure
    happens before the vehicle step.

Expected: an alert reading
  "Could not complete resident setup: user_role INSERT failed: duplicate
   key value violates unique constraint "user_roles_lower_email_uidx"
   ...The login account has been deactivated."

Then verify with:
  npx tsx scripts/seed-rollback-fixture.ts --verify
`)
}

async function verify() {
  console.log('── post-trigger state ──')
  const id = await authIdFor(EMAIL)
  if (!id) {
    console.log('  🔴 no auth.users row — create_user never ran, so the rollback was never reached.')
    console.log('     The trigger did not exercise the path. Check the alert text.')
    return
  }
  const { data: lu } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const row = (lu?.users ?? []).find(u => u.email?.toLowerCase() === EMAIL) as { banned_until?: string } | undefined
  const banned = !!row?.banned_until && new Date(row.banned_until).getTime() > Date.now()
  console.log(`  auth user      : present (${id})`)
  console.log(`  banned_until   : ${row?.banned_until ?? '(none)'}`)
  console.log(banned
    ? '  ✅ ROLLBACK FIRED — manager:2892 ran and the ban landed.'
    : '  🔴 ROLLBACK DID NOT FIRE — the auth user exists and is NOT banned. This is the orphan.')

  const { data: res } = await sb.from('residents').select('id, email, property').ilike('email', EMAIL)
  console.log(`  residents rows : ${(res || []).length} ${(res || []).length === 0 ? '✅ rolled back' : '🔴 ' + JSON.stringify(res)}`)

  const { data: roles } = await sb.from('user_roles').select('email, company').ilike('email', EMAIL)
  console.log(`  seeded role row: ${(roles || []).length === 1 ? '✅ still present (untouched, as expected)' : '🔴 ' + (roles || []).length + ' rows'}`)

  console.log(`
🔴 Note on the success criterion: deactivate_user BANS, it does not
delete. A banned auth.users row remaining is the CORRECT outcome — the
rollback makes the account unusable, it does not make it disappear.

When finished:  npx tsx scripts/seed-rollback-fixture.ts --cleanup`)
}

const mode = process.argv[2]
if (mode === '--cleanup') cleanup()
else if (mode === '--verify') verify()
else seed()

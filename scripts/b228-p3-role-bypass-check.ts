// B228 Phase 3 — server-side verification that the two DEFINER RPCs
// reject a non-admin authenticated caller with forbidden_not_admin
// (42501). Throwaway. Provisions a fresh non-admin user via service-
// role, signs in as that user via the anon client, calls both RPCs,
// cleans up the user + role row.
//
// Uses p_company_id: 99999999 (nonexistent) so that if the gate
// hypothetically fails, the next branch inside the RPC hits
// company_not_found (check_violation) before any cascade runs — no
// destructive risk even in a failure mode.
//
// Run: node --env-file=.env.local --experimental-strip-types scripts/b228-p3-role-bypass-check.ts
//   (or) npx tsx --env-file=.env.local scripts/b228-p3-role-bypass-check.ts

import { createClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!URL || !ANON || !SERVICE) {
  console.error('Missing env — need NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const TEST_COMPANY_ID = 99999999   // nonexistent — safe even if gate breaks
const RESULT: Record<string, string> = {}

interface RpcAttempt {
  rpc:      string
  args:     Record<string, unknown>
  passWhen: (err: { code?: string; message?: string } | null) => boolean
}

async function main() {
  const admin = createClient(URL!, SERVICE!, { auth: { autoRefreshToken: false, persistSession: false } })
  const anon  = createClient(URL!, ANON!,    { auth: { autoRefreshToken: false, persistSession: false } })

  const testEmail    = `b228-p3-bypass-${Date.now()}@example.com`
  const testPassword = `x${Math.random().toString(36).slice(2)}A1!`
  let userId: string | null = null

  console.log('════════════════════════════════════════════════════════')
  console.log('B228 Phase 3 — role-bypass verification')
  console.log('════════════════════════════════════════════════════════\n')

  try {
    // 1) Provision throwaway non-admin user
    console.log('1) Creating throwaway user:', testEmail)
    const { data: userData, error: userErr } = await admin.auth.admin.createUser({
      email:         testEmail,
      password:      testPassword,
      email_confirm: true,
    })
    if (userErr || !userData.user) {
      console.error('   createUser failed:', userErr?.message)
      process.exit(1)
    }
    userId = userData.user.id
    console.log('   user id:', userId)

    // 2) Assign non-admin role (resident is the least-privileged)
    console.log('\n2) Assigning role=resident (non-admin)')
    const { error: roleErr } = await admin.from('user_roles').insert({
      email:    testEmail,
      role:     'resident',
      company:  null,
      property: [],
    })
    if (roleErr) {
      console.error('   user_roles insert failed:', roleErr.message)
      process.exit(1)
    }
    console.log('   role assigned')

    // 3) Sign in as the non-admin via anon client using the C′′ pattern
    //    (admin.generateLink → anon.verifyOtp). signInWithPassword is
    //    captcha-gated post-B213 toggle-on; verifyOtp is not. Same
    //    approach the /register single-solve build uses.
    console.log('\n3) Acquiring session via generateLink + verifyOtp (captcha-ungated path)')
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type:  'magiclink',
      email: testEmail,
    })
    if (linkErr || !linkData.properties?.hashed_token) {
      console.error('   generateLink failed:', linkErr?.message)
      process.exit(1)
    }
    const { data: signIn, error: signInErr } = await anon.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type:       'magiclink',
    })
    if (signInErr || !signIn.session) {
      console.error('   verifyOtp failed:', signInErr?.message)
      process.exit(1)
    }
    console.log('   signed in as:', signIn.user?.email, '— access_token acquired')

    // 4) Attempt both RPCs; PASS = 42501 / forbidden_not_admin
    const attempts: RpcAttempt[] = [
      {
        rpc:  'super_admin_deactivate_company',
        args: { p_company_id: TEST_COMPANY_ID, p_reason: 'security_boundary_test' },
        passWhen: (err) => err?.code === '42501' && err?.message === 'forbidden_not_admin',
      },
      {
        rpc:  'super_admin_reactivate_company',
        args: { p_company_id: TEST_COMPANY_ID },
        passWhen: (err) => err?.code === '42501' && err?.message === 'forbidden_not_admin',
      },
    ]

    for (const a of attempts) {
      console.log(`\n── ${a.rpc} ──`)
      const { data, error } = await anon.rpc(a.rpc, a.args)
      console.log('   data:  ', data)
      console.log('   error: ', error)

      if (a.passWhen(error)) {
        console.log('   ✓ PASS — 42501 / forbidden_not_admin fired')
        RESULT[a.rpc] = 'PASS'
      } else if (!error && (data as { ok?: boolean } | null)?.ok) {
        console.log('   ★★★ CRITICAL FAIL — non-admin got ok:true. Role gate did NOT fire.')
        RESULT[a.rpc] = 'CRITICAL_FAIL'
      } else if (error?.message?.includes('company_not_found')) {
        console.log('   ★★★ CRITICAL FAIL — non-admin passed the role gate and reached the company-resolve step (company_not_found on nonexistent id). Role gate did NOT fire.')
        RESULT[a.rpc] = 'CRITICAL_FAIL'
      } else {
        console.log('   ? INVESTIGATE — unexpected error shape. Expected code:42501 message:forbidden_not_admin.')
        RESULT[a.rpc] = 'INVESTIGATE'
      }
    }

    console.log('\n════════════════════════════════════════════════════════')
    console.log('SUMMARY')
    console.log('════════════════════════════════════════════════════════')
    for (const [rpc, verdict] of Object.entries(RESULT)) {
      console.log(`  ${rpc.padEnd(35)} ${verdict}`)
    }
    const allPass = Object.values(RESULT).every(v => v === 'PASS')
    console.log('\nOverall:', allPass ? '✓ SECURITY BOUNDARY HOLDS' : '★ INVESTIGATE / FAIL')
  } finally {
    // 5) Cleanup — leave zero trace
    console.log('\n5) Cleanup (delete role row + auth user)')
    if (userId) {
      const { error: delRoleErr } = await admin.from('user_roles').delete().eq('email', testEmail)
      if (delRoleErr) console.warn('   user_roles delete warn:', delRoleErr.message)
      const { error: delAuthErr } = await admin.auth.admin.deleteUser(userId)
      if (delAuthErr) console.warn('   auth.deleteUser warn:', delAuthErr.message)
      console.log('   cleanup done.')
    }
  }
}

main().catch(err => {
  console.error('Script threw:', err)
  process.exit(1)
})

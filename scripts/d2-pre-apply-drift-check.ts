// D2 migration pre-apply drift check.
// Verifies production state matches what we surveyed in the audit.
// HALT conditions:
//   • insert_user_role already has 5-arg signature → parallel apply
//   • user_roles.name column already exists → parallel apply
//   • get_my_role / get_my_company missing → migration body would break

import { createClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const c = createClient(url, serviceKey, { auth: { persistSession: false } })

async function probeUserRolesColumns(): Promise<string[]> {
  const { data } = await c.from('user_roles').select('*').limit(1)
  return data?.[0] ? Object.keys(data[0]) : []
}

async function probeInsertUserRoleArgCount(): Promise<'4-arg' | '5-arg' | 'unknown'> {
  // Behavioral probe: try a deliberately failing 5-arg call. If the
  // function is 4-arg, PostgREST surfaces "function ... does not exist"
  // referencing the 5-arg shape. If it's 5-arg, we get a body-level
  // failure (foreign key or null violation on a noop insert that we
  // then clean up).
  //
  // Simpler: call with p_name and read the data/error shape.
  // Pre-fix function is 4-arg and would either ignore p_name (sql lang
  // accepts extra named args? actually no — PostgREST would 404 on
  // signature mismatch).
  const probeEmail = `noop-drift-check-${Date.now()}@example.com`
  const { error } = await c.rpc('insert_user_role', {
    p_email: probeEmail, p_role: 'noop-drift', p_company: 'noop', p_property: [], p_name: 'drift-probe',
  })
  // Clean up if accidentally inserted.
  await c.from('user_roles').delete().eq('email', probeEmail)

  if (!error) return '5-arg'  // The 5-arg signature accepted the call.
  // PostgREST returns code='PGRST202' with message='Could not find the function...'
  // when the requested signature doesn't exist. That's the 4-arg signal.
  if (error.code === 'PGRST202' || error.message.includes('Could not find the function')) return '4-arg'
  return 'unknown'
}

async function probeHelpers(): Promise<{ get_my_role: boolean; get_my_company: boolean }> {
  // get_my_role / get_my_company should both return null under service-role
  // (no JWT). Presence = no PGRST202 error.
  const r1 = await c.rpc('get_my_role')
  const r2 = await c.rpc('get_my_company')
  return {
    get_my_role: !r1.error || !r1.error.message.includes('PGRST202'),
    get_my_company: !r2.error || !r2.error.message.includes('PGRST202'),
  }
}

async function main() {
  console.log('── D2 PRE-APPLY DRIFT CHECK ──\n')

  // Check 1: user_roles.name column absence
  const cols = await probeUserRolesColumns()
  const nameAlreadyExists = cols.includes('name')
  console.log(`Check 1: user_roles columns = [${cols.join(', ')}]`)
  console.log(`  user_roles.name present: ${nameAlreadyExists ? 'YES (HALT)' : 'no (OK)'}\n`)

  // Check 2: insert_user_role signature
  const sig = await probeInsertUserRoleArgCount()
  console.log(`Check 2: insert_user_role signature: ${sig}`)
  console.log(`  expected pre-apply: 4-arg`)
  console.log(`  ${sig === '4-arg' ? 'OK' : 'UNEXPECTED — HALT'}\n`)

  // Check 3: helpers present
  const helpers = await probeHelpers()
  console.log(`Check 3: get_my_role present: ${helpers.get_my_role ? 'yes' : 'NO (HALT)'}`)
  console.log(`         get_my_company present: ${helpers.get_my_company ? 'yes' : 'NO (HALT)'}\n`)

  const haltConditions: string[] = []
  if (nameAlreadyExists) haltConditions.push('user_roles.name already exists')
  if (sig !== '4-arg') haltConditions.push(`insert_user_role is ${sig}, expected 4-arg`)
  if (!helpers.get_my_role) haltConditions.push('get_my_role missing')
  if (!helpers.get_my_company) haltConditions.push('get_my_company missing')

  console.log('── VERDICT ──')
  if (haltConditions.length > 0) {
    console.log('HALT — drift detected:')
    for (const h of haltConditions) console.log(`  • ${h}`)
    process.exit(1)
  } else {
    console.log('GO — production state matches pre-apply expectations.')
    process.exit(0)
  }
}

main().catch(e => { console.error('ERR:', e.message); process.exit(2) })

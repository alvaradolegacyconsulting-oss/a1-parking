// Auth-overhead probe — measure per-query overhead under manager session
// vs service-role, on tables of varying RLS complexity + a no-op RPC.
// Purpose: is the ~5.5s per manager-session query auth-side or table-side?
//
// Run: npx tsx --env-file=.env.local scripts/probe-auth-overhead.ts

import { createClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const MANAGER = 'chris.tobar94+happy@gmail.com'

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T, elapsedMs: number }> {
  const start = process.hrtime.bigint()
  const result = await fn()
  const end = process.hrtime.bigint()
  return { result, elapsedMs: Number((end - start) / 1000000n) }
}

async function main() {
  const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: linkData } = await admin.auth.admin.generateLink({ type: 'magiclink', email: MANAGER })
  const tokenHash = (linkData?.properties as any)?.hashed_token
  const anon = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
  await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })

  console.log('\n══ Baseline: cheap queries — is overhead per-query or per-table? ══\n')

  // 1) user_roles.select — the manager reads own row (simplest RLS)
  for (let i = 1; i <= 3; i++) {
    const t = await timed(() => anon.from('user_roles').select('email, role').ilike('email', MANAGER))
    console.log(`  user_roles(#${i}) session : ${t.elapsedMs}ms  rows=${(t.result as any).data?.length || 0}`)
  }

  // 2) properties.select limit 1 — tiny table
  for (let i = 1; i <= 3; i++) {
    const t = await timed(() => anon.from('properties').select('id').limit(1))
    console.log(`  properties LIMIT 1 (#${i}) session : ${t.elapsedMs}ms  rows=${(t.result as any).data?.length || 0}`)
  }

  // 3) service-role parity (baseline)
  console.log('')
  for (let i = 1; i <= 3; i++) {
    const t = await timed(() => admin.from('user_roles').select('email, role').ilike('email', MANAGER))
    console.log(`  user_roles(#${i}) svc     : ${t.elapsedMs}ms  rows=${(t.result as any).data?.length || 0}`)
  }
  for (let i = 1; i <= 3; i++) {
    const t = await timed(() => admin.from('properties').select('id').limit(1))
    console.log(`  properties LIMIT 1 (#${i}) svc     : ${t.elapsedMs}ms  rows=${(t.result as any).data?.length || 0}`)
  }

  console.log('\n══ helper-function calls under manager session ══\n')
  for (let i = 1; i <= 2; i++) {
    const t = await timed(() => anon.rpc('get_my_role'))
    console.log(`  get_my_role() (#${i}) session : ${t.elapsedMs}ms  data=${JSON.stringify((t.result as any).data)}  err=${(t.result as any).error?.message || 'none'}`)
  }
  for (let i = 1; i <= 2; i++) {
    const t = await timed(() => anon.rpc('get_my_properties'))
    console.log(`  get_my_properties() (#${i}) session : ${t.elapsedMs}ms  data=${JSON.stringify((t.result as any).data)}  err=${(t.result as any).error?.message || 'none'}`)
  }

  console.log('\n══ scale of spaces table ══\n')
  const { data: sCount } = await admin.from('spaces').select('id', { count: 'exact', head: true })
  console.log(`  spaces total (service): ${(sCount as any)?.length ?? '(count via head)'}`)
  // use head count method
  const c = await admin.from('spaces').select('*', { count: 'exact', head: true })
  console.log(`  spaces count exact: ${c.count}`)
  const cR = await admin.from('residents').select('*', { count: 'exact', head: true })
  console.log(`  residents count exact: ${cR.count}`)

  await anon.auth.signOut()
}

main().catch(e => { console.error(e); process.exit(99) })

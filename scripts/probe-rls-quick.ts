import { createClient } from '@supabase/supabase-js'
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
async function main() {
  // Peek pg_policies via a SELECT (works if RLS on the catalog admits service_role)
  const { data, error } = await admin.rpc('exec_sql' as any, { p_sql: '' })
  if (error) {
    // No exec_sql RPC. Fall back to a signal: check that a small
    // grep-side artifact is applied — probe a table indirectly by
    // measuring row-count timing.
    console.log('No exec_sql RPC available; inferring from indirect signals.')
  }
  // Simple timing on violations count as anon (no RLS), then service (bypasses RLS)
  const t0 = Date.now()
  const { count } = await admin.from('violations').select('id', { count: 'exact', head: true })
  console.log(`violations count via service_role: ${count} rows in ${Date.now()-t0}ms (bypasses RLS)`)
}
main().catch(e => { console.error(e); process.exit(99) })

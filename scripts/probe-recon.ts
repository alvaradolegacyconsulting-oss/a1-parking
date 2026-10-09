import { createClient } from '@supabase/supabase-js'
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
async function main() {
  const { data } = await admin.from('audit_logs').select('action, new_values, created_at')
    .in('action', ['SCHEMA_RPC_ADDED','SCHEMA_RPC_UPDATED','SCHEMA_RLS_UPDATED','SCHEMA_COLUMN_ADDED','SCHEMA_MIGRATION','SCHEMA_TABLE_ADDED'])
    .gte('created_at', '2026-06-15').order('created_at',{ascending:false}).limit(200)
  console.log(`Total recent schema-change audits: ${data?.length ?? 0}`)
  const byMigration = new Map<string, {date: string, action: string, note: string}[]>()
  ;(data ?? []).forEach((r: any) => {
    const m = r.new_values?.migration ?? '(no migration)'
    if (!byMigration.has(m)) byMigration.set(m, [])
    byMigration.get(m)!.push({ date: r.created_at.slice(0,10), action: r.action, note: (r.new_values?.rpc ?? r.new_values?.change ?? '').slice(0, 100) })
  })
  ;[...byMigration.entries()].sort().forEach(([m, rs]) => {
    console.log(`\n[${rs[0].date}] ${m}  (${rs.length} rows)`)
    rs.forEach(r => console.log(`  ${r.action}  ${r.note}`))
  })
}
main().catch(e => { console.error(e); process.exit(99) })

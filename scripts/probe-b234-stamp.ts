import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
async function main() {
  const { data: audit } = await admin.from('audit_logs').select('action, new_values, created_at')
    .in('action', ['SCHEMA_RPC_UPDATED', 'SCHEMA_RPC_ADDED', 'STAMP_TOW_TICKET_UPDATED'])
    .order('created_at', { ascending: false }).limit(50)
  console.log(`Recent RPC-change audit rows (${audit?.length ?? 0}):`)
  ;(audit ?? []).forEach((r: any) => {
    const nv = JSON.stringify(r.new_values)
    if (nv.includes('stamp_tow_ticket') || nv.includes('regenerate') || nv.includes('D2')) {
      console.log(`  ${r.created_at}  ${r.action}  ${nv.slice(0, 200)}`)
    }
  })
}
main().catch(e => { console.error(e); process.exit(99) })

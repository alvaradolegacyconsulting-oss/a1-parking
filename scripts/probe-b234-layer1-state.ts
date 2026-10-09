// B234 Layer 1 state probe — is the June 26 migration applied to prod?
// USAGE:  npx tsx --env-file=.env.local scripts/probe-b234-layer1-state.ts
import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

async function main() {
  // 1. Does user_roles.can_regenerate_tow_ticket exist?
  const { data: canRegen, error: e1 } = await admin
    .from('user_roles').select('can_regenerate_tow_ticket').limit(1)
  console.log('user_roles.can_regenerate_tow_ticket column exists:', !e1)
  if (e1) console.log('  →', e1.message)

  // 2. Does violations.regenerate_reason exist?
  const { error: e2 } = await admin
    .from('violations').select('regenerate_reason, regenerate_reason_note, regenerated_from').limit(1)
  console.log('violations regen columns exist:', !e2)
  if (e2) console.log('  →', e2.message)

  // 3. Does the audit_logs row exist for SCHEMA_RPC_ADDED regenerate_tow_ticket?
  const { data: audit, error: e3 } = await admin
    .from('audit_logs')
    .select('action, new_values, created_at')
    .eq('action', 'SCHEMA_RPC_ADDED')
    .order('created_at', { ascending: false })
    .limit(20)
  if (e3) { console.log('audit_logs query error:', e3.message); return }
  console.log(`Recent SCHEMA_RPC_ADDED rows (${audit?.length ?? 0}):`)
  ;(audit ?? []).forEach((r: any) => {
    const nv = r.new_values as any
    if (nv && (JSON.stringify(nv).includes('regenerate') || JSON.stringify(nv).includes('stamp_tow_ticket'))) {
      console.log(`  ${r.created_at}  → ${JSON.stringify(nv).slice(0, 160)}`)
    }
  })
}
main().catch(e => { console.error(e); process.exit(99) })

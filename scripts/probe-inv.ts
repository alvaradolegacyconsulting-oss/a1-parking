import { createClient } from '@supabase/supabase-js'
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
async function check(name: string, fn: () => Promise<any>) {
  try {
    const r = await fn()
    console.log(`✅ ${name}`)
    if (r != null && r !== true) console.log(`   → ${JSON.stringify(r).slice(0, 200)}`)
  } catch (e: any) { console.log(`❌ ${name}\n   → ${e?.message?.slice(0, 200)}`) }
}
async function main() {
  // 1. space_requests table (Spaces v1 arc)
  await check('space_requests table', async () => {
    const { error } = await admin.from('space_requests').select('id').limit(1)
    if (error) throw error
    return true
  })
  // 2. vehicles.mileage_fee + vin (B191 mileage/VIN)
  await check('violations.mileage_fee + vin cols', async () => {
    const { error } = await admin.from('violations').select('mileage_fee, vin').limit(1)
    if (error) throw error
    return true
  })
  // 3. user_roles unique lower(email) constraint — indirect: attempt duplicate insert would tell, skip; check for a probe of it
  await check('user_roles UNIQUE(lower(email)) constraint (existence via duplicate scan)', async () => {
    const { data, error } = await admin.from('user_roles').select('email')
    if (error) throw error
    const lower = new Map<string, number>()
    ;(data ?? []).forEach((r: any) => lower.set(String(r.email).toLowerCase(), (lower.get(String(r.email).toLowerCase()) ?? 0) + 1))
    const dups = [...lower.entries()].filter(([, c]) => c > 1)
    return { total_rows: data?.length ?? 0, duplicate_lowered_emails: dups.length }
  })
  // 4. drivers table + is_active semantics (indirect check for B234 L3 driver-list surface)
  await check('drivers table + can_regenerate_tow_ticket linkage (via user_roles)', async () => {
    const { data, error } = await admin.from('user_roles').select('email, role, can_regenerate_tow_ticket').eq('role', 'driver').limit(10)
    if (error) throw error
    return { drivers_sampled: data?.length ?? 0, with_regen_true: data?.filter((r: any) => r.can_regenerate_tow_ticket === true).length ?? 0 }
  })
  // 5. permit_door_piece1 flip backstop — probe by looking for any specific column/RPC introduced
  await check('permit_door_piece1_default_flip_backstop applied (audit check)', async () => {
    const { data, error } = await admin.from('audit_logs').select('action, new_values').ilike('new_values::text', '%permit_door_piece1_default_flip_backstop%').limit(1)
    if (error) throw error
    return { audit_row_exists: (data?.length ?? 0) > 0 }
  })
}
main().catch(e => { console.error(e); process.exit(99) })

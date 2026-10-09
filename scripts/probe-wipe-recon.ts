import { createClient } from '@supabase/supabase-js'
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })

async function check(name: string, fn: () => Promise<any>) {
  try { const r = await fn(); console.log(`\n── ${name} ──`); console.log(r ?? '(no result)') }
  catch (e: any) { console.log(`\n── ${name} ──`); console.log('ERR:', e?.message?.slice(0, 300)) }
}

async function main() {
  // Ask 1 — Live-Stripe-presence
  await check('Ask 1a — companies row-count total', async () => {
    const { count } = await admin.from('companies').select('*', { count: 'exact', head: true })
    return { total_companies: count }
  })
  await check('Ask 1b — companies with non-null stripe_customer_id', async () => {
    const { data, count } = await admin.from('companies')
      .select('id, name, tier, stripe_customer_id, stripe_subscription_id, company_env', { count: 'exact' })
      .not('stripe_customer_id', 'is', null)
    return { count, rows: data }
  })
  await check('Ask 1c — companies with non-null stripe_subscription_id', async () => {
    const { data, count } = await admin.from('companies')
      .select('id, name, tier, stripe_customer_id, stripe_subscription_id, company_env', { count: 'exact' })
      .not('stripe_subscription_id', 'is', null)
    return { count, rows: data }
  })
  await check('Ask 1d — companies grouped by company_env (informational)', async () => {
    const { data } = await admin.from('companies').select('company_env')
    const counts = new Map<string, number>()
    ;(data ?? []).forEach((r: any) => counts.set(String(r.company_env ?? 'NULL'), (counts.get(String(r.company_env ?? 'NULL')) ?? 0) + 1))
    return Object.fromEntries(counts)
  })

  // Ask 3 — stripe_prices catalog vs custom
  await check('Ask 3a — stripe_prices column shape', async () => {
    const { data } = await admin.from('stripe_prices').select('*').limit(1)
    return data && data[0] ? Object.keys(data[0]) : '(empty table)'
  })
  await check('Ask 3b — stripe_prices with proposal_code_id NOT NULL (custom rows)', async () => {
    const { data, count } = await admin.from('stripe_prices')
      .select('id, tier_track, tier_name, line_item, cycle, mode, proposal_code_id, stripe_product_id, stripe_price_id', { count: 'exact' })
      .not('proposal_code_id', 'is', null).limit(30)
    return { count, sample: data }
  })
  await check('Ask 3c — stripe_prices with proposal_code_id IS NULL (catalog rows to KEEP)', async () => {
    const { data, count } = await admin.from('stripe_prices')
      .select('id, tier_track, tier_name, line_item, cycle, mode, proposal_code_id', { count: 'exact' })
      .is('proposal_code_id', null).limit(30)
    return { count, sample: data }
  })

  // Ask 4 — Auth users enumeration
  await check('Ask 4a — auth.users total count via list()', async () => {
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 })
    if (error) throw error
    // The v2 admin API returns { users, aud, total (sometimes) }; explore the shape.
    return { has_users_array: Array.isArray((data as any).users), users_returned: Array.isArray((data as any).users) ? (data as any).users.length : 'n/a', keys_on_response: Object.keys(data ?? {}) }
  })
  await check('Ask 4b — enumerate all auth.users (paged)', async () => {
    let page = 1
    const all: any[] = []
    while (true) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
      if (error) throw error
      const users = (data as any).users ?? []
      all.push(...users)
      if (users.length < 1000) break
      page++
      if (page > 20) break  // safety cap
    }
    const admins = all.filter(u => String(u.email ?? '').toLowerCase().includes('admin'))
    return {
      total_auth_users: all.length,
      containing_admin_in_email: admins.map(u => ({ id: u.id, email: u.email }))
    }
  })

  // Ask 2 (partial) — sample cross-table row counts to size the wipe
  await check('Ask 2 — per-table row counts (tenant tables — informational)', async () => {
    const tables = ['companies','properties','user_roles','residents','vehicles','drivers','violations','visitor_passes','guest_authorizations','space_requests','space_residents','spaces','storage_facilities','dispute_requests','proposal_codes','tos_acceptances','stripe_events','audit_logs','vehicle_plate_changes','stripe_prices']
    const out: Record<string, number | string> = {}
    for (const t of tables) {
      const { count, error } = await admin.from(t as any).select('*', { count: 'exact', head: true })
      out[t] = error ? `ERR: ${error.message}` : (count ?? -1)
    }
    return out
  })
}
main().catch(e => { console.error('probe threw:', e); process.exit(99) })

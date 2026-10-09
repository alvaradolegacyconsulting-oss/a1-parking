import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

async function main() {
  const { data, error } = await admin
    .from('proposal_codes')
    .select('base_tier, base_tier_type')
  if (error) { console.error(error); process.exit(2) }
  const distinct = new Map<string, number>()
  ;(data ?? []).forEach(r => {
    const k = `${r.base_tier ?? 'NULL'} | ${r.base_tier_type ?? 'NULL'}`
    distinct.set(k, (distinct.get(k) ?? 0) + 1)
  })
  console.log(`Total proposal_codes rows: ${data?.length ?? 0}`)
  console.log('base_tier | base_tier_type | count')
  console.log('---------------------------------------')
  ;[...distinct.entries()].sort().forEach(([k,v]) => console.log(`${k}  →  ${v}`))
}
main().catch(e => { console.error(e); process.exit(99) })

// Probe: does a manufactured @supabase/ssr cookie authenticate a real
// CA against /api/bulk-onboarding/context? Answers the one unknown the
// CA HTTP gate rests on. Throwaway-but-kept, like the other probe-*.
import { createClient } from '@supabase/supabase-js'
import { startDevServer, portBusy, type DevServer } from './lib/dev-server'
import { spawn } from 'child_process'
import fs from 'fs'
import { cookieHeaderFor } from './lib/ssr-session'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL_ = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL_, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
const S = Date.now(), PORT = 3992, BASE = `http://127.0.0.1:${PORT}`

const main = async () => {
  const { data: props } = await db.from('properties').select('id,name,company').eq('company', 'Test-LEGACY').limit(1)
  const target = (props ?? [])[0]
  console.log('target property:', target)
  const email = `zz-ck-${S}@test.invalid`
  const u = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${S}q` })
  if (u.error) throw u.error
  await db.from('user_roles').insert({ email, role: 'company_admin', company: 'Test-LEGACY', property: [target.name], is_active: true })
  const { cookie } = await cookieHeaderFor(db, URL_, ANON, email)
  console.log('cookie built, length', cookie.length)

  const srv = await startDevServer(PORT)
  if (!srv) { console.error('🔴 server did not come up'); process.exit(2) }
  for (const hdr of [{ Cookie: cookie }, {}]) {
    const r = await fetch(`${BASE}/api/bulk-onboarding/context`, { headers: hdr as Record<string, string> })
    console.log(`  ${Object.keys(hdr).length ? 'WITH cookie' : 'anonymous  '} → HTTP ${r.status} ${(await r.text()).slice(0, 180)}`)
  }
  await srv.stop()
  await db.from('user_roles').delete().ilike('email', email)
  await db.auth.admin.deleteUser(u.data.user!.id)
  console.log('cleaned')
}
main().catch(e => { console.error('🔴', e); process.exit(1) })

// Diagnose: "The string did not match the expected pattern" surfaced
// in CA Add-User Step 1 of D2 UI smoke. Replicates the swift-handler
// create_user call shape from app/company_admin/page.tsx:830-833 with
// varying inputs to localize whether the failure is:
//   (a) password format (length / character class / policy)
//   (b) plus-addressed email
//   (c) swift-handler internal validation
//   (d) Supabase Auth project-level password policy
//
// Reports per-attempt error; cleans up successful creations.

import { createClient } from '@supabase/supabase-js'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const fnBase     = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL!

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

const TAG = Math.floor(Date.now() / 1000).toString(36).toUpperCase()

async function spawnCASession(): Promise<string> {
  const caEmail = `mateo+swift-probe-${TAG}@example.com`
  const caPw    = `B155_${TAG}!`
  const { data: created } = await admin.auth.admin.createUser({ email: caEmail, password: caPw, email_confirm: true })
  if (!created.user) throw new Error('CA create failed')
  await admin.from('user_roles').insert({ email: caEmail, role: 'company_admin', company: 'Demo Towing LLC' })
  const ca = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  await ca.auth.signInWithPassword({ email: caEmail, password: caPw })
  const { data: { session } } = await ca.auth.getSession()
  if (!session?.access_token) throw new Error('CA signIn failed')
  // schedule cleanup
  process.on('beforeExit', async () => {
    await admin.from('user_roles').delete().eq('email', caEmail)
    await admin.auth.admin.deleteUser(created.user!.id)
  })
  return session.access_token
}

interface Attempt { label: string; email: string; password: string }
const ATTEMPTS: Attempt[] = [
  // Baseline — minimal viable per Supabase Auth defaults (6 char min)
  { label: 'plain-email + 8-char strong pw',       email: `swift-probe-${TAG}-1@example.com`,                   password: 'AbcDef12!' },
  // Plus-addressed (mimics Jose's typical pattern)
  { label: 'plus-addressed email + same pw',       email: `alvaradolegacyconsulting+swift-${TAG}@gmail.com`,    password: 'AbcDef12!' },
  // Short password (under 6 char Supabase default min)
  { label: 'plus-addressed + 5-char short pw',     email: `alvaradolegacyconsulting+swift-${TAG}b@gmail.com`,   password: 'Abc12' },
  // 6 char (exactly at default min)
  { label: 'plus-addressed + 6-char min pw',       email: `alvaradolegacyconsulting+swift-${TAG}c@gmail.com`,   password: 'Abc123' },
  // No special chars (some policies require non-alphanumeric)
  { label: 'plus-addressed + 8-char alphanum only', email: `alvaradolegacyconsulting+swift-${TAG}d@gmail.com`,   password: 'AbcDef12' },
  // 8 char with special — likely the "Test1234!" pattern Jose would type
  { label: 'plus-addressed + 9-char with special',  email: `alvaradolegacyconsulting+swift-${TAG}e@gmail.com`,   password: 'Test1234!' },
]

async function main() {
  console.log(`Diagnostic — swift-handler create_user probe · TAG=${TAG}`)
  console.log(`Endpoint: ${fnBase}/swift-handler\n`)

  if (!fnBase) {
    console.log('FATAL: NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL missing from env')
    process.exit(2)
  }

  let token: string
  try { token = await spawnCASession() } catch (e) {
    console.error('SETUP FAILED:', (e as Error).message); process.exit(1)
  }

  for (const a of ATTEMPTS) {
    let result: { status: number; body: string }
    try {
      const res = await fetch(`${fnBase}/swift-handler`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ action: 'create_user', email: a.email, password: a.password }),
      })
      const body = await res.text()
      result = { status: res.status, body }
    } catch (e) {
      result = { status: 0, body: 'NETWORK: ' + (e as Error).message }
    }

    const tag = result.status === 200 ? 'OK ' : 'ERR'
    const trimmedBody = result.body.length > 200 ? result.body.slice(0, 200) + '…' : result.body
    console.log(`${tag} [${result.status}]  ${a.label}`)
    console.log(`     email=${a.email}  password=${a.password}`)
    console.log(`     body: ${trimmedBody}`)
    console.log()

    // Cleanup any successful auth.users so they don't pollute the project.
    if (result.status === 200) {
      const { data: page } = await admin.auth.admin.listUsers({ page:1, perPage:200 })
      const u = page.users.find(u => u.email === a.email)
      if (u) await admin.auth.admin.deleteUser(u.id)
    }
  }

  console.log('Done.')
}

main().catch(e => { console.error('UNHANDLED:', e); process.exit(2) })

// 500 reproduction probe — 2026-07-02 (throwaway; delete after use)
//
// Reproduce the EXACT browser queries that returned HTTP 500 in Jose's
// devtools capture (property="French Quarter", manager chris.tobar94+happy):
//
//   GET /rest/v1/residents?select=*&property=ilike.French+Quarter&order=unit.asc
//   GET /rest/v1/spaces?select=*&property=ilike.French+Quarter&is_active=eq.true&status=eq.available&order=label.asc&offset=0&limit=50
//   GET /rest/v1/spaces?select=type,status&property=ilike.French+Quarter&is_active=eq.true
//
// Runs each query TWICE:
//   (1) service-role  — baseline, bypasses RLS; if it 500s too, cause is NOT RLS
//   (2) manager       — real session via generateLink+verifyOtp (ungated per prior probe)
//
// Then isolates each knob (select=* vs explicit, order vs no-order) to
// pinpoint which parameter flips 200 → 500.
//
// Run: npx tsx --env-file=.env.local scripts/probe-residents-500.ts

import { createClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!URL || !ANON || !SERVICE) {
  console.error('Missing env — need NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const MANAGER  = 'chris.tobar94+happy@gmail.com'
const PROPERTY = 'French Quarter'

function fmt(err: any, data: any, elapsedMs: number): string {
  if (err) {
    return `❌ ${elapsedMs}ms · code=${err.code || '?'} · status=${err.status || '?'} · message=${JSON.stringify(err.message)} · details=${JSON.stringify(err.details)} · hint=${JSON.stringify(err.hint)}`
  }
  return `✓  ${elapsedMs}ms · rows=${Array.isArray(data) ? data.length : (data ? 1 : 0)}`
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T, elapsedMs: number }> {
  const start = process.hrtime.bigint()
  const result = await fn()
  const end = process.hrtime.bigint()
  return { result, elapsedMs: Number((end - start) / 1000000n) }
}

async function main() {
  const admin = createClient(URL!, SERVICE!, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('════════════════════════════════════════════════════════')
  console.log('500 reproduction — residents + spaces at "French Quarter"')
  console.log('════════════════════════════════════════════════════════\n')

  // Get manager session
  console.log('── setup manager session ────────────────────────────────')
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: MANAGER })
  if (linkErr) { console.error('generateLink failed:', linkErr.message); process.exit(2) }
  const tokenHash = (linkData?.properties as any)?.hashed_token
  if (!tokenHash) { console.error('no hashed_token'); process.exit(3) }
  const anon = createClient(URL!, ANON!, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: otpErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
  if (otpErr) { console.error('verifyOtp failed:', otpErr.message); process.exit(4) }
  const { data: sess } = await anon.auth.getSession()
  console.log('  manager JWT email:', sess?.session?.user?.email, '\n')

  // ─────────────── RESIDENTS ───────────────
  console.log('══ residents ══════════════════════════════════════════════\n')

  console.log('A. residents · select=* · order(unit)   [THE BROWSER QUERY]')
  const A_svc = await timed(() => admin.from('residents').select('*').ilike('property', PROPERTY).order('unit'))
  console.log('   service-role :', fmt((A_svc.result as any).error, (A_svc.result as any).data, A_svc.elapsedMs))
  const A_mgr = await timed(() => anon.from('residents').select('*').ilike('property', PROPERTY).order('unit'))
  console.log('   manager sess :', fmt((A_mgr.result as any).error, (A_mgr.result as any).data, A_mgr.elapsedMs))

  console.log('\nB. residents · select=* · NO order   (isolate the sort knob)')
  const B_svc = await timed(() => admin.from('residents').select('*').ilike('property', PROPERTY))
  console.log('   service-role :', fmt((B_svc.result as any).error, (B_svc.result as any).data, B_svc.elapsedMs))
  const B_mgr = await timed(() => anon.from('residents').select('*').ilike('property', PROPERTY))
  console.log('   manager sess :', fmt((B_mgr.result as any).error, (B_mgr.result as any).data, B_mgr.elapsedMs))

  console.log('\nC. residents · explicit cols · order(unit)   (isolate the `*` knob)')
  const C_svc = await timed(() => admin.from('residents').select('id, email, unit, property, status, is_active, company').ilike('property', PROPERTY).order('unit'))
  console.log('   service-role :', fmt((C_svc.result as any).error, (C_svc.result as any).data, C_svc.elapsedMs))
  const C_mgr = await timed(() => anon.from('residents').select('id, email, unit, property, status, is_active, company').ilike('property', PROPERTY).order('unit'))
  console.log('   manager sess :', fmt((C_mgr.result as any).error, (C_mgr.result as any).data, C_mgr.elapsedMs))

  console.log('\nD. residents · explicit cols · NO order   (both knobs off)')
  const D_svc = await timed(() => admin.from('residents').select('id, email, unit, property, status, is_active, company').ilike('property', PROPERTY))
  console.log('   service-role :', fmt((D_svc.result as any).error, (D_svc.result as any).data, D_svc.elapsedMs))
  const D_mgr = await timed(() => anon.from('residents').select('id, email, unit, property, status, is_active, company').ilike('property', PROPERTY))
  console.log('   manager sess :', fmt((D_mgr.result as any).error, (D_mgr.result as any).data, D_mgr.elapsedMs))

  // ─────────────── SPACES ───────────────
  console.log('\n══ spaces ═════════════════════════════════════════════════\n')

  console.log('E. spaces · select=type,status · property+is_active   [THE BROWSER QUERY #2]')
  const E_svc = await timed(() => admin.from('spaces').select('type,status').ilike('property', PROPERTY).eq('is_active', true))
  console.log('   service-role :', fmt((E_svc.result as any).error, (E_svc.result as any).data, E_svc.elapsedMs))
  const E_mgr = await timed(() => anon.from('spaces').select('type,status').ilike('property', PROPERTY).eq('is_active', true))
  console.log('   manager sess :', fmt((E_mgr.result as any).error, (E_mgr.result as any).data, E_mgr.elapsedMs))

  console.log('\nF. spaces · select=* · property+is_active+status · order(label) · limit 50   [BROWSER QUERY #1]')
  const F_svc = await timed(() => admin.from('spaces').select('*').ilike('property', PROPERTY).eq('is_active', true).eq('status', 'available').order('label').range(0, 49))
  console.log('   service-role :', fmt((F_svc.result as any).error, (F_svc.result as any).data, F_svc.elapsedMs))
  const F_mgr = await timed(() => anon.from('spaces').select('*').ilike('property', PROPERTY).eq('is_active', true).eq('status', 'available').order('label').range(0, 49))
  console.log('   manager sess :', fmt((F_mgr.result as any).error, (F_mgr.result as any).data, F_mgr.elapsedMs))

  console.log('\nG. spaces · select=* · NO filters   (baseline: does the table itself work?)')
  const G_svc = await timed(() => admin.from('spaces').select('*').limit(3))
  console.log('   service-role :', fmt((G_svc.result as any).error, (G_svc.result as any).data, G_svc.elapsedMs))
  const G_mgr = await timed(() => anon.from('spaces').select('*').limit(3))
  console.log('   manager sess :', fmt((G_mgr.result as any).error, (G_mgr.result as any).data, G_mgr.elapsedMs))

  console.log('\nH. spaces · property-only · no is_active   (isolate is_active filter)')
  const H_mgr = await timed(() => anon.from('spaces').select('id').ilike('property', PROPERTY))
  console.log('   manager sess :', fmt((H_mgr.result as any).error, (H_mgr.result as any).data, H_mgr.elapsedMs))

  // ─────────────── DIFF: French Quarter vs other property ───────────────
  console.log('\n══ compare properties (find the row that\'s different about French Quarter) ══\n')
  const { data: allProps } = await admin.from('properties').select('*')
  console.log(`  properties count: ${allProps?.length || 0}`)
  for (const p of allProps || []) {
    const cols = Object.keys(p)
    const nulls = cols.filter(k => p[k] == null)
    console.log(`  · "${p.name}"  id=${p.id}  company=${p.company}  nulls=[${nulls.join(', ')}]`)
  }

  await anon.auth.signOut()

  // ─────────────── NEGATIVE ISOLATION — different-property manager ───────────────
  console.log('\n══ NEGATIVE ISOLATION — manager on a different property ══\n')
  const { data: otherMgrs } = await admin
    .from('user_roles')
    .select('email, property')
    .eq('role', 'manager')
    .neq('email', MANAGER)
  const OTHER_MGR = (otherMgrs || []).find(r =>
    Array.isArray(r.property)
    && !r.property.some((p: string) => (p || '').toLowerCase() === PROPERTY.toLowerCase())
  )
  if (!OTHER_MGR) {
    console.log('  ⚠ skipped — no other manager with a DIFFERENT property found in user_roles')
  } else {
    console.log(`  other manager: ${OTHER_MGR.email}  property=${JSON.stringify(OTHER_MGR.property)}`)
    const { data: linkData2, error: linkErr2 } = await admin.auth.admin.generateLink({ type: 'magiclink', email: OTHER_MGR.email })
    if (linkErr2) {
      console.log('  generateLink for other mgr failed:', linkErr2.message, '(if user does not exist in auth, this is expected)')
    } else {
      const tokenHash2 = (linkData2?.properties as any)?.hashed_token
      const anon2 = createClient(URL!, ANON!, { auth: { autoRefreshToken: false, persistSession: false } })
      const { error: otpErr2 } = await anon2.auth.verifyOtp({ token_hash: tokenHash2, type: 'magiclink' })
      if (otpErr2) {
        console.log('  verifyOtp for other mgr failed:', otpErr2.message)
      } else {
        const N_res = await timed(() => anon2.from('residents').select('id').ilike('property', PROPERTY))
        console.log(`  neg residents · ilike 'French Quarter' : ${N_res.elapsedMs}ms  rows=${(N_res.result as any).data?.length ?? '?'}  err=${(N_res.result as any).error?.message || 'none'}   (expected 0)`)
        const N_spc = await timed(() => anon2.from('spaces').select('id').ilike('property', PROPERTY))
        console.log(`  neg spaces    · ilike 'French Quarter' : ${N_spc.elapsedMs}ms  rows=${(N_spc.result as any).data?.length ?? '?'}  err=${(N_spc.result as any).error?.message || 'none'}   (expected 0)`)
        await anon2.auth.signOut()
      }
    }
  }

  console.log('\n(script does not write anything; delete after use)')
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })

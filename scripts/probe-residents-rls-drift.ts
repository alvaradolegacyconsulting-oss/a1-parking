// Resident RLS drift probe — 2026-07-02 (throwaway; delete after use)
//
// Read-only. Service-role. NO mutations. Compares:
//   residents.property           for  chris.tobar94+jes@gmail.com
//   user_roles.property[]        for  chris.tobar94+happy@gmail.com  (manager)
//   vehicles.property (companion) for the same resident_email
// and reports byte-identity vs case-drift vs whitespace-drift between the
// resident-property string and each of the manager's property[] entries.
//
// Run:
//   node --env-file=.env.local --experimental-strip-types scripts/probe-residents-rls-drift.ts
//   (or) npx tsx --env-file=.env.local scripts/probe-residents-rls-drift.ts

import { createClient } from '@supabase/supabase-js'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!URL || !SERVICE) {
  console.error('Missing env — need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const MANAGER  = 'chris.tobar94+happy@gmail.com'
const RESIDENT = 'chris.tobar94+jes@gmail.com'

function describe(a: string, b: string): string {
  if (a === b) return 'BYTE-IDENTICAL'
  if (a.toLowerCase() === b.toLowerCase()) return `CASE-DRIFT   (a="${a}" b="${b}")`
  if (a.trim() === b.trim()) return `WHITESPACE-DRIFT (a=${JSON.stringify(a)} b=${JSON.stringify(b)})`
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return `CASE+WHITESPACE-DRIFT (a=${JSON.stringify(a)} b=${JSON.stringify(b)})`
  return `UNRELATED (a=${JSON.stringify(a)} b=${JSON.stringify(b)})`
}

async function main() {
  const admin = createClient(URL!, SERVICE!, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log('════════════════════════════════════════════════════════')
  console.log('Residents RLS drift probe')
  console.log('════════════════════════════════════════════════════════\n')

  // ── 1. residents row for the resident ──────────────────────────────
  const { data: rRows, error: rErr } = await admin
    .from('residents')
    .select('id, email, property, status, is_active, company, unit, created_at')
    .ilike('email', RESIDENT)
    .order('created_at', { ascending: false })

  if (rErr) { console.error('residents lookup failed:', rErr.message); process.exit(2) }
  console.log(`residents(${RESIDENT}): ${rRows?.length || 0} row(s)`)
  for (const r of rRows || []) {
    console.log('  ', JSON.stringify({
      id: r.id,
      email: r.email,
      property: r.property,
      property_len: r.property?.length ?? null,
      property_json: JSON.stringify(r.property),
      status: r.status,
      is_active: r.is_active,
      company: r.company,
      unit: r.unit,
      created_at: r.created_at,
    }))
  }

  // ── 2. user_roles for the manager ──────────────────────────────────
  const { data: urRows, error: urErr } = await admin
    .from('user_roles')
    .select('email, role, property, company, can_approve_vehicles')
    .ilike('email', MANAGER)

  if (urErr) { console.error('user_roles lookup failed:', urErr.message); process.exit(3) }
  console.log(`\nuser_roles(${MANAGER}): ${urRows?.length || 0} row(s)`)
  for (const ur of urRows || []) {
    console.log('  RAW:', JSON.stringify(ur))
  }

  // ── 3. companion vehicles for the resident ─────────────────────────
  const { data: vRows, error: vErr } = await admin
    .from('vehicles')
    .select('id, plate, resident_email, property, unit, status, is_active, created_at')
    .ilike('resident_email', RESIDENT)
    .order('created_at', { ascending: false })

  if (vErr) { console.error('vehicles lookup failed:', vErr.message); process.exit(4) }
  console.log(`\nvehicles(${RESIDENT}): ${vRows?.length || 0} row(s)`)
  for (const v of vRows || []) {
    console.log('  ', JSON.stringify({
      id: v.id,
      plate: v.plate,
      property: v.property,
      property_json: JSON.stringify(v.property),
      unit: v.unit,
      status: v.status,
      is_active: v.is_active,
      created_at: v.created_at,
    }))
  }

  // ── 4. drift verdict ───────────────────────────────────────────────
  console.log('\n─── DRIFT VERDICT ─────────────────────────────────────')
  const residentProp = rRows?.[0]?.property as string | null
  const managerProps = (urRows?.[0]?.property || []) as string[]
  const vehicleProps = Array.from(new Set((vRows || []).map(v => v.property as string).filter(Boolean)))

  console.log(`resident.property = ${JSON.stringify(residentProp)}  (len=${residentProp?.length ?? 'null'})`)
  console.log(`manager.property[] = ${JSON.stringify(managerProps)}`)
  console.log(`vehicle.property distinct = ${JSON.stringify(vehicleProps)}`)

  if (residentProp == null) {
    console.log('\n⚠ resident.property is NULL — this would ALSO have blanked vehicle.property; check separately.')
  } else {
    console.log('\nresident.property vs each manager.property[]:')
    for (const mp of managerProps) {
      console.log(`  vs ${JSON.stringify(mp)}  →  ${describe(residentProp, mp)}`)
    }
    console.log('\nresident.property vs each vehicle.property (should be byte-identical if written together):')
    for (const vp of vehicleProps) {
      console.log(`  vs ${JSON.stringify(vp)}  →  ${describe(residentProp, vp)}`)
    }
  }

  // ── 5. also read-back what the SELECT policy WOULD see if it were ILIKE ──
  //   (informational — proves the parity fix would surface the row)
  if (residentProp && managerProps.length > 0) {
    console.log('\n─── SIMULATED policy-side check ──────────────────────')
    const wouldMatchEq   = managerProps.some(mp => mp === residentProp)
    const wouldMatchIlik = managerProps.some(mp => mp.toLowerCase() === residentProp.toLowerCase())
    console.log(`  current  (= ANY)         → ${wouldMatchEq}`)
    console.log(`  proposed (~~* ANY/ILIKE) → ${wouldMatchIlik}`)
    if (!wouldMatchEq && wouldMatchIlik) {
      console.log('  ✓ Diagnosis confirmed: current policy blocks visibility; ~~* parity would restore it.')
    } else if (wouldMatchEq) {
      console.log('  ⚠ Current policy WOULD match — asymmetry is NOT the cause of THIS instance. HALT the fix.')
    } else if (!wouldMatchIlik) {
      console.log('  ⚠ Even ~~* parity would NOT match — manager.property[] does not contain this property under any casing. Different root cause.')
    }
  }

  // ── 6. simulate the manager's actual session and see what RLS returns ──
  console.log('\n─── SESSION-SIDE probe (sign in as manager, query as them) ───')
  const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!ANON) {
    console.log('  skipped — no ANON key in env')
  } else {
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: MANAGER,
    })
    if (linkErr) {
      console.log('  generateLink failed:', linkErr.message)
    } else {
      const tokenHash = (linkData?.properties as any)?.hashed_token
      if (!tokenHash) {
        console.log('  no hashed_token in generateLink response')
      } else {
        const anon = createClient(URL!, ANON, { auth: { autoRefreshToken: false, persistSession: false } })
        const { error: otpErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
        if (otpErr) {
          console.log('  verifyOtp failed:', otpErr.message)
        } else {
          const { data: session } = await anon.auth.getSession()
          console.log('  manager JWT email:', session?.session?.user?.email)

          // ── A. can the manager SELECT their own user_roles row? ────────
          const { data: urOwn, error: urOwnErr } = await anon.from('user_roles').select('email, role, property, company').ilike('email', MANAGER)
          console.log(`  A. manager reads own user_roles via session: rows=${urOwn?.length || 0}  err=${urOwnErr?.message || 'none'}`)
          for (const r of urOwn || []) console.log('     ', JSON.stringify(r))

          // ── B. can the manager SELECT the pending resident row? ─────────
          const { data: rSess, error: rSessErr } = await anon.from('residents').select('*').ilike('property', 'French Quarter')
          console.log(`  B. manager reads residents ilike 'French Quarter': rows=${rSess?.length || 0}  err=${rSessErr?.message || 'none'}`)
          for (const r of (rSess as any[]) || []) console.log('     ', JSON.stringify({ id: r.id, email: r.email, property: r.property, status: r.status, is_active: r.is_active, company: r.company }))

          // ── C. can the manager SELECT vehicles for the resident? ────────
          const { data: vSess, error: vSessErr } = await anon.from('vehicles').select('id, plate, property, status').ilike('property', 'French Quarter')
          console.log(`  C. manager reads vehicles ilike 'French Quarter': rows=${vSess?.length || 0}  err=${vSessErr?.message || 'none'}`)
          for (const r of (vSess as any[]) || []) console.log('     ', JSON.stringify(r))

          // ── D. direct fetch by resident id via session ──────────────────
          const rid = rRows?.[0]?.id
          if (rid) {
            const { data: rId, error: rIdErr } = await anon.from('residents').select('*').eq('id', rid)
            console.log(`  D. manager reads residents id=${rid} directly: rows=${rId?.length || 0}  err=${rIdErr?.message || 'none'}`)
          }

          await anon.auth.signOut()
        }
      }
    }
  }

  console.log('\n(script does not write anything; delete after use)')
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })

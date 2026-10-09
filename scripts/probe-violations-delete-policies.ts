// Probe: violations DELETE policy quals — LIVE catalog read.
// Mateo Sep 3 followup §3 verification.
//
// USAGE: npx tsx --env-file=.env.local scripts/probe-violations-delete-policies.ts

import { createClient } from '@supabase/supabase-js'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const { data, error } = await sb
    .from('pg_policies')
    .select('policyname, cmd, qual, permissive, roles')
    .eq('schemaname', 'public')
    .eq('tablename', 'violations')
    .eq('cmd', 'DELETE')
    .order('policyname')

  if (error) {
    console.error('[probe] pg_policies read failed:', error.message)
    console.error('  Run this in Supabase SQL Editor as fallback:')
    console.error(`  SELECT policyname, cmd, qual, permissive, roles`)
    console.error(`  FROM pg_policies`)
    console.error(`  WHERE schemaname='public' AND tablename='violations' AND cmd='DELETE'`)
    console.error(`  ORDER BY policyname;`)
    process.exit(1)
  }

  console.log('[probe] LIVE DELETE policies on public.violations:')
  console.log('  Count:', data?.length ?? 0)
  console.log('')
  for (const p of data ?? []) {
    console.log(`── ${p.policyname} (roles=${p.roles})`)
    console.log(`   qual: ${p.qual}`)
    console.log('')
  }

  // Check for is_confirmed=false gate
  let allHaveConfirmedGate = true
  let adminPresent = false
  for (const p of data ?? []) {
    if (!/is_confirmed[^A-Za-z_]*=\s*false/.test(p.qual ?? '')) {
      console.log(`🔴 ${p.policyname} does NOT gate on is_confirmed=false — qual: ${p.qual}`)
      allHaveConfirmedGate = false
    }
    if ((p.policyname ?? '').startsWith('admin_') || (p.policyname ?? '').includes('admin')) {
      adminPresent = true
    }
  }

  console.log('')
  console.log('── VERIFICATION ──')
  console.log(`All policies gate is_confirmed=false: ${allHaveConfirmedGate ? '✓ YES' : '✗ NO (finding)'}`)
  console.log(`Admin DELETE policy present:         ${adminPresent ? '⚠ YES (unexpected — F10 sweep intended NONE)' : '✓ NO (matches F10 intent)'}`)
}

main().catch(e => { console.error('[probe] fatal:', e); process.exit(1) })

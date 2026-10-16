// ════════════════════════════════════════════════════════════════════
// Retire the Southmore Park demo PM login — repoint first, then delete
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16. Role 1037 ("Charles Miller (demo)",
// demo-pm-southmore-park@test.shieldmylot.com) is a prospect-demo login
// created 2026-09-30 whose 14-day expiry nothing ever enforced.
//
// 🔴 IT IS ALSO THE ONLY MANAGER COVERING SOUTHMORE PARK.
// demo-manager@test.shieldmylot.com (role 528) covers Sunset Ridge,
// Willowbrook and Northgate — not Southmore. Vehicle approval is
// manager-portal-only, so deleting 1037 first would leave the property
// Jose runs his uploads against with nobody able to approve a pending
// vehicle. Hence: repoint, PROVE the repoint works, then delete.
//
// 🔴 AND NOT endProspectDemo. Its only refusal is company_env='demo',
// which Southmore Park satisfies — it would proceed and delete the
// PROPERTY: every visitor pass, removal, violation, vehicle, space and
// resident on it, then the property row. That is 5 residents and 6
// vehicles and the upload target, not a login.
//
// 🔴 THE VISIBILITY CHECK IS MEASURED BEFORE AND AFTER, UNDER RLS.
// An RLS denial returns { data: [], error: null } — an empty list, not
// an error. "Role 528 sees 0 rows" therefore proves nothing on its
// own. Measured both sides of the repoint, 0-then-N is unambiguous.
//
// Usage: npx tsx --env-file=.env.local scripts/retire-demo-pm-login.ts [--apply]
//        Without --apply it measures and changes nothing.

import { createClient } from '@supabase/supabase-js'
import { sessionAs } from './lib/smoke-auth'

const APPLY = process.argv.includes('--apply')
const PROPERTY = 'Southmore Park'
const KEEP_ROLE = 528            // demo-manager@…, the login that survives
const RETIRE_ROLE = 1037         // demo-pm-southmore-park@…
const RETIRE_EMAIL = 'demo-pm-southmore-park@test.shieldmylot.com'
const MANAGER_EMAIL = 'demo-manager@test.shieldmylot.com'

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } })

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

/** What role 528 can actually see at the property, under its own JWT. */
async function visibleToManager(): Promise<{ vehicles: number; pending: number; residents: number }> {
  const s = await sessionAs(MANAGER_EMAIL, { targetEnv: 'demo' })
  const veh = await s.client.from('vehicles').select('id').ilike('property', PROPERTY)
  const pend = await s.client.from('vehicles').select('id').ilike('property', PROPERTY).eq('status', 'pending')
  const res = await s.client.from('residents').select('id').ilike('property', PROPERTY)
  return { vehicles: (veh.data ?? []).length, pending: (pend.data ?? []).length, residents: (res.data ?? []).length }
}

async function main() {
  console.log(`\n══ retire ${RETIRE_EMAIL} ══`)
  console.log(APPLY ? '   MODE: apply\n' : '   MODE: measure only (pass --apply to write)\n')

  // ── what is true now, from service_role ──────────────────────────
  const truth = {
    vehicles: (await db.from('vehicles').select('id').ilike('property', PROPERTY)).data?.length ?? 0,
    pending: (await db.from('vehicles').select('id').ilike('property', PROPERTY).eq('status', 'pending')).data?.length ?? 0,
    residents: (await db.from('residents').select('id').ilike('property', PROPERTY)).data?.length ?? 0,
  }
  console.log(`${PROPERTY}, from service_role: ${truth.vehicles} vehicle(s) (${truth.pending} pending), ${truth.residents} resident(s)`)

  const before528 = (await db.from('user_roles').select('id,email,property,is_active').eq('id', KEEP_ROLE).maybeSingle()).data
  console.log(`role ${KEEP_ROLE}: ${JSON.stringify(before528?.property)}`)

  const seenBefore = await visibleToManager()
  console.log(`role ${KEEP_ROLE} can see: ${seenBefore.vehicles} vehicle(s), ${seenBefore.pending} pending, ${seenBefore.residents} resident(s)`)
  chk(`🔴 before the repoint, role ${KEEP_ROLE} is BLIND to ${PROPERTY}`,
    seenBefore.vehicles === 0 && seenBefore.residents === 0,
    seenBefore.vehicles === 0
      ? 'RLS returns an empty list, which is the baseline the after-measurement is read against'
      : `🔴 already sees ${seenBefore.vehicles} — the repoint is not what grants access, so this check proves nothing`)

  if (!APPLY) {
    console.log('\nmeasure-only: stopping before any write.\n')
    process.exit(fails === 0 ? 0 : 1)
  }

  // ── 1. repoint ───────────────────────────────────────────────────
  const current = (before528?.property as string[] | null) ?? []
  if (current.includes(PROPERTY)) {
    console.log(`\nrole ${KEEP_ROLE} already lists ${PROPERTY}; no write needed`)
  } else {
    const next = [...current, PROPERTY]
    const up = await db.from('user_roles').update({ property: next }).eq('id', KEEP_ROLE).select('property')
    // 🔴 Read back. The update's own return is the row it claims to
    // have written, which is not the same as the row that is there.
    const after = (await db.from('user_roles').select('property').eq('id', KEEP_ROLE).maybeSingle()).data
    chk(`role ${KEEP_ROLE} now covers ${PROPERTY}`,
      !up.error && Array.isArray(after?.property) && (after!.property as string[]).includes(PROPERTY),
      JSON.stringify(after?.property))
  }

  const seenAfter = await visibleToManager()
  chk(`🔴 role ${KEEP_ROLE} can now see ${PROPERTY}'s vehicles, and ALL of them`,
    seenAfter.vehicles === truth.vehicles && seenAfter.residents === truth.residents,
    `sees ${seenAfter.vehicles}/${truth.vehicles} vehicle(s), ${seenAfter.residents}/${truth.residents} resident(s)`)
  // 🔴 "none" and "cannot see" are different answers, and the pending
  // queue is legitimately empty today. Say which one this is.
  chk(`   ...and its pending-vehicle queue resolves`,
    seenAfter.pending === truth.pending,
    truth.pending === 0
      ? 'the queue is EMPTY, not hidden: service_role also counts 0 pending at this property'
      : `sees ${seenAfter.pending} of ${truth.pending} pending`)

  if (fails > 0) {
    console.log('\n🔴 the repoint did not verify — NOT deleting role 1037.\n')
    process.exit(1)
  }

  // ── 2. delete the retired login ──────────────────────────────────
  const { data: us } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const u = (us?.users ?? []).find(x => (x.email ?? '').toLowerCase() === RETIRE_EMAIL)
  if (u) {
    const del = await db.auth.admin.deleteUser(u.id)
    console.log(del.error ? `🔴 auth delete: ${del.error.message}` : `auth user ${u.id} deleted`)
  } else {
    console.log('no auth user to delete')
  }
  const dr = await db.from('user_roles').delete().eq('id', RETIRE_ROLE).select('id,email')
  console.log(`user_roles delete returned ${JSON.stringify(dr.data)}`)

  // ── 3. read back: both gone, and the property untouched ──────────
  const { data: us2 } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const stillAuth = (us2?.users ?? []).filter(x => (x.email ?? '').toLowerCase() === RETIRE_EMAIL)
  const stillRole = (await db.from('user_roles').select('id').eq('id', RETIRE_ROLE)).data ?? []
  chk('🔴 the auth user is gone (read back, not inferred from the call)', stillAuth.length === 0, `${stillAuth.length} remaining`)
  chk(`🔴 role ${RETIRE_ROLE} is gone`, stillRole.length === 0, `${stillRole.length} remaining`)

  const endTruth = {
    vehicles: (await db.from('vehicles').select('id').ilike('property', PROPERTY)).data?.length ?? 0,
    residents: (await db.from('residents').select('id').ilike('property', PROPERTY)).data?.length ?? 0,
  }
  chk(`🔴 ${PROPERTY} itself is untouched — this was a login, not a property`,
    endTruth.vehicles === truth.vehicles && endTruth.residents === truth.residents,
    `${endTruth.residents} resident(s), ${endTruth.vehicles} vehicle(s) — unchanged`)

  const mgrs = (await db.from('user_roles').select('id,email,is_active,property')
    .eq('role', 'manager').eq('company', 'Demo Company')).data ?? []
  const covering = mgrs.filter(r => Array.isArray(r.property) && (r.property as string[]).includes(PROPERTY) && r.is_active)
  chk(`🔴 ${PROPERTY} still has an ACTIVE manager`, covering.length >= 1,
    covering.map(r => `${r.email} (role ${r.id})`).join(', ') || '🔴 none')

  console.log(fails === 0 ? '\n✅ all green\n' : `\n❌ ${fails} failed\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(e => { console.error('🔴', (e as Error).message); process.exit(2) })

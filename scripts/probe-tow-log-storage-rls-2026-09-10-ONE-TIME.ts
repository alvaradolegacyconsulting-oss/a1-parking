// ════════════════════════════════════════════════════════════════════
// PROBE — does storage RLS on `vehicle-removal-photos` actually DENY?
//
// USAGE:
//   npx tsx --env-file=.env.local \
//     scripts/probe-tow-log-storage-rls-2026-09-10-ONE-TIME.ts
//
// ONE-TIME. Revert same day. Not part of Commit 6.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────
// /api/tow-log/media-url has two gates:
//   1. the path must resolve to a vehicle_removal_media row the caller
//      can SELECT (that table's RLS)
//   2. createSignedUrl runs as the caller (storage.objects RLS)
//
// Gate 1 refuses everything gate 2 would refuse, so in normal operation
// gate 2 NEVER DECIDES ANYTHING. What that leaves:
//
//   ALLOW direction — proven by the app. A photo that displays means
//     removal_photos_manager_all permitted the read. First time those
//     policies have done anything since Commit 1.
//   DENY direction — UNPROVEN. Gate 1 catches every case that would
//     test it. If the storage policy were wide open, nothing in normal
//     operation would reveal it: we would believe we had two boundaries
//     and have one.
//
// This probe calls createSignedUrl DIRECTLY as an impersonated user,
// bypassing the route, so gate 2 is the only thing deciding.
//
// ── 🔴 POSITIVE CONTROLS ARE NOT OPTIONAL ───────────────────────────
// A probe that only attempts forbidden reads cannot tell "the policy
// denied me" from "the bucket is misconfigured / the object does not
// exist / my session is broken" — every one of those refuses too, and
// all of them look like a pass. So each role attempts BOTH an in-scope
// path (must SIGN) and an out-of-scope path (must REFUSE). Only the
// pair is evidence.
//
// ── SAFETY ──────────────────────────────────────────────────────────
// Test tenants only (company_env='test'). Seeds its own rows with
// STG-PROBE plates, and deletes every object, media row and removal row
// it created in a finally block. Touches no user_roles row
// (feedback_probe_hygiene_rule) and no production data.
// ════════════════════════════════════════════════════════════════════
import { sessionAs } from './lib/smoke-auth'
import type { SupabaseClient } from '@supabase/supabase-js'

const BUCKET = 'vehicle-removal-photos'

// Property A — pm-manager IS assigned; pm-ca's company owns it.
const PROP_A = { name: 'Test PM Property',     company: 'Test-PM' }
// Property B — pm-manager is NOT assigned; different company from pm-ca.
const PROP_B = { name: 'Test Legacy Property', company: 'Test-LEGACY' }

const MANAGER = 'pm-manager@test.shieldmylot.com'
const CA      = 'pm-ca@test.shieldmylot.com'

type Seeded = { removalId: number; propertyId: number; path: string }

const created: { removalIds: number[]; mediaIds: number[]; paths: string[] } =
  { removalIds: [], mediaIds: [], paths: [] }

async function seed(admin: SupabaseClient, prop: { name: string; company: string }, tag: string): Promise<Seeded> {
  const { data: p, error: pErr } = await admin
    .from('properties').select('id, name, company')
    .eq('name', prop.name).limit(1).maybeSingle()
  if (pErr || !p) throw new Error(`FIXTURE: property "${prop.name}" not found — seed the test tenants first. ${pErr?.message ?? ''}`)

  // Direct INSERT as service_role — deliberately NOT through
  // record_vehicle_removal. The probe is about storage RLS, and going
  // through the RPC would make the seed depend on the tier gate too.
  const { data: removal, error: rErr } = await admin
    .from('vehicle_removals')
    .insert({
      company: prop.company, property: prop.name, property_id: p.id,
      removal_type: 'tow', plate: `STGPROBE${tag}`, reason_code: 'probe',
      towed_at: new Date().toISOString(),
      authorized_by_email: 'probe@test.shieldmylot.com',
      operator_name: 'STG-PROBE OPERATOR',
      recorded_by_email: 'probe@test.shieldmylot.com',
    })
    .select('id').single()
  if (rErr || !removal) throw new Error(`seed removal at ${prop.name} failed: ${rErr?.message}`)
  created.removalIds.push(removal.id)

  // A real object at the real convention: {property_id}/{removal_id}/...
  const path = `${p.id}/${removal.id}/stg-probe.txt`
  const { error: upErr } = await admin.storage.from(BUCKET)
    .upload(path, new Blob(['storage rls probe'], { type: 'image/png' }), { contentType: 'image/png', upsert: true })
  if (upErr) throw new Error(`seed upload ${path} failed: ${upErr.message}`)
  created.paths.push(path)

  const { data: media, error: mErr } = await admin
    .from('vehicle_removal_media')
    .insert({ removal_id: removal.id, storage_path: path, kind: 'photo', created_by_email: 'probe@test.shieldmylot.com' })
    .select('id').single()
  if (mErr || !media) throw new Error(`seed media row failed: ${mErr?.message}`)
  created.mediaIds.push(media.id)

  return { removalId: removal.id, propertyId: p.id, path }
}

async function attempt(client: SupabaseClient, path: string) {
  const { data, error } = await client.storage.from(BUCKET).createSignedUrl(path, 60)
  return { signed: !!data?.signedUrl, message: error?.message ?? null }
}

// Which gate WOULD have caught it in the route — reported alongside, so
// a deny result distinguishes "storage RLS denied" from "gate 1 would
// have caught this anyway."
async function mediaRowVisible(client: SupabaseClient, path: string): Promise<boolean> {
  const { data } = await client.from('vehicle_removal_media')
    .select('id').eq('storage_path', path).is('removed_at', null)
  return (data ?? []).length > 0
}

async function main() {
  const results: string[] = []
  let failures = 0

  const bootstrap = await sessionAs(MANAGER)
  const admin = bootstrap.admin

  let a: Seeded | null = null
  let b: Seeded | null = null
  try {
    a = await seed(admin, PROP_A, 'A')
    b = await seed(admin, PROP_B, 'B')
    console.log(`seeded: A=${a.path}  B=${b.path}\n`)

    for (const [who, email, inScope, outScope] of [
      ['manager', MANAGER, a, b],
      ['company_admin', CA, a, b],
    ] as const) {
      const s = await sessionAs(email)

      const allow = await attempt(s.client, inScope.path)
      const deny  = await attempt(s.client, outScope.path)
      const denyRowVisible = await mediaRowVisible(s.client, outScope.path)

      // POSITIVE CONTROL — must sign. If this fails, every "deny" below
      // is meaningless: the refusal could be anything.
      if (allow.signed) {
        results.push(`PASS  ${who} · in-scope path SIGNED (positive control — the policy permits)`)
      } else {
        failures++
        results.push(`🔴 CONTROL FAILED  ${who} · in-scope path REFUSED (${allow.message}). Every deny result below is uninterpretable until this passes.`)
      }

      // THE ACTUAL QUESTION — must refuse.
      if (!deny.signed) {
        results.push(`PASS  ${who} · out-of-scope path REFUSED by storage RLS (${deny.message ?? 'no url returned'})`)
      } else {
        failures++
        results.push(`🔴 FAIL  ${who} · out-of-scope path SIGNED. removal_photos_${who === 'manager' ? 'manager' : 'ca'}_all is NOT scoping by path prefix. Gate 1 in /api/tow-log/media-url is the ONLY thing between this user and another ${who === 'manager' ? 'property' : 'company'}'s photos.`)
      }

      results.push(`      ${who} · route gate 1 would have ${denyRowVisible ? 'ALLOWED (media row visible — investigate)' : 'refused first (media row not visible)'}`)
    }
  } finally {
    // Cleanup runs even on a thrown seed — a half-seeded probe must not
    // leave rows behind. Order matters: media rows reference removals
    // with ON DELETE RESTRICT.
    if (created.paths.length)  await admin.storage.from(BUCKET).remove(created.paths)
    if (created.mediaIds.length)   await admin.from('vehicle_removal_media').delete().in('id', created.mediaIds)
    if (created.removalIds.length) await admin.from('vehicle_removals').delete().in('id', created.removalIds)
    console.log(`\ncleanup: ${created.paths.length} object(s), ${created.mediaIds.length} media row(s), ${created.removalIds.length} removal row(s) removed`)
  }

  console.log('\n── RESULTS ──')
  results.forEach(r => console.log(r))
  console.log(`\n${failures === 0 ? '✅ ALL PASS — storage RLS denies independently of the route' : `🔴 ${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error('probe threw:', e); process.exit(1) })

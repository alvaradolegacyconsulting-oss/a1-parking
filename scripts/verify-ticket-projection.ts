// ════════════════════════════════════════════════════════════════════
// GATE — the anonymous tow-ticket link publishes exactly its 20 keys
// ════════════════════════════════════════════════════════════════════
//
// THE DISCLOSURE THIS EXISTS FOR (2026-10-16). get_violation_by_view_token
// returned `to_jsonb(v.*)` — all 42 columns of the violations row — to
// any anonymous holder of a ticket link. Measured as reaching the
// browser and never rendered: notes, void_reason, voided_by_email (a
// staff address), the decline and regenerate notes, status_changed_by,
// scanned_at, snapshot_status, and view_token itself. Not an escalation
// (256-bit token, and the reader is the vehicle's owner) but a
// disclosure to that reader of things written for us.
//
// 🔴 IT CALLS AS anon, NOT AS THE APPLIER. The paired SQL verification
// runs in whatever role applies it, and the function is SECURITY
// DEFINER so the payload looks the same from there. That makes the SQL
// check unable to notice if the GRANT were lost — the link would be
// dead for real visitors while the block still passed. This gate holds
// the anon key and nothing else, which is what a motorist has.
//
// 🔴 PRESENT AND ABSENT, BOTH. A projection check that counts keys
// passes while naming the wrong twenty, and one that only checks for
// 'notes' passes while publishing void_reason. Every intended key is
// required and every dropped field is named individually, so a failure
// says which internal field is being published.
//
// Fixture preference: a TEST-tenant ticket. The gate needs one real
// token and reads nothing else; preferring test data keeps a customer's
// tow ticket out of a routine gate run.
//
// Usage: npx tsx --env-file=.env.local scripts/verify-ticket-projection.ts

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const anon = createClient(url, anonKey, { auth: { persistSession: false } })

const WANT = [
  'id', 'plate', 'violation_type', 'location', 'property', 'created_at',
  'vehicle_year', 'vehicle_make', 'vehicle_model', 'vehicle_color',
  'driver_name', 'driver_license',
  'tow_storage_name', 'tow_storage_address', 'tow_storage_phone',
  'tow_fee', 'tow_mileage_fee', 'tow_ticket_generated_at',
  'resolved_tdlr_license', 'resolved_vsf_license',
].sort()

/** Every field ruled out, named so a failure says which one leaked. */
const BANNED = [
  'notes',
  'void_reason', 'voided_at', 'voided_by_email', 'voided_by_role',
  'regenerate_reason', 'regenerate_reason_note', 'regenerated_from',
  'decline_reason', 'decline_reason_note',
  'status', 'status_changed_by', 'status_changed_at',
  'view_token', 'view_token_expires_at',
  'is_confirmed', 'scanned_at', 'headline_status_at_scan', 'snapshot_status',
  'was_authorized_at_time', 'video_url', 'vehicle_vin', 'tow_ticket_generated',
]

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '\n       ' + d : ''}`) }

async function main() {
  console.log('\n══ anonymous tow-ticket projection ══\n')

  // A live, readable fixture. Test/demo tenants first.
  const { data: rows } = await admin.from('violations')
    .select('id, property, view_token, view_token_expires_at')
    .not('view_token', 'is', null).eq('is_confirmed', true).is('voided_at', null)
    .gt('view_token_expires_at', new Date().toISOString())
  const { data: props } = await admin.from('properties').select('name, company')
  const envOf = new Map((props ?? []).map(p => [String(p.name), String(p.company)]))
  const pool = (rows ?? []).sort((a, b) => {
    const t = (r: typeof a) => /test|demo|probe|legacy/i.test(envOf.get(String(r.property)) ?? '') ? 0 : 1
    return t(a) - t(b)
  })

  // 🔴 No fixture is INCONCLUSIVE, not a pass. A green run with nothing
  // read would mean the projection was never compared.
  if (pool.length === 0) {
    console.log('❌ INCONCLUSIVE: no live tokened violation to read. The projection was NOT checked.\n')
    process.exit(2)
  }
  const fixture = pool[0]
  console.log(`fixture: violation ${fixture.id} at ${fixture.property} (${envOf.get(String(fixture.property))})\n`)

  const { data, error } = await anon.rpc('get_violation_by_view_token', { p_token: fixture.view_token })
  chk('anon can still execute the function — the public link works',
    !error, error ? `🔴 ${error.message}` : 'EXECUTE intact for anon')
  if (error) { console.log(`\n❌ ${fails} failed\n`); process.exit(1) }

  const payload = (data ?? {}) as Record<string, unknown>
  const v = (payload.violation ?? {}) as Record<string, unknown>
  const got = Object.keys(v).sort()

  chk('photos is still a sibling key, not folded into the violation',
    Array.isArray(payload.photos), `photos=${Array.isArray(payload.photos) ? 'array' : typeof payload.photos}`)

  const extra = got.filter(k => !WANT.includes(k))
  const missing = WANT.filter(k => !got.includes(k))
  chk(`🔴 exactly the ${WANT.length} intended keys`,
    extra.length === 0 && missing.length === 0,
    extra.length || missing.length
      ? `${got.length} key(s) returned\n       🔴 unexpected: ${extra.join(', ') || 'none'}\n       🔴 missing:    ${missing.join(', ') || 'none'}`
      : got.join(', '))

  const leaked = BANNED.filter(k => k in v)
  chk('🔴 every ruled-out field is absent, by name',
    leaked.length === 0,
    leaked.length === 0
      ? `${BANNED.length} internal field(s) checked, none present`
      : `🔴 PUBLISHED TO ANON: ${leaked.join(', ')}`)

  // The two refusal shapes, unchanged by this work.
  const short = await anon.rpc('get_violation_by_view_token', { p_token: 'tooshort' })
  chk('a short token is refused as invalid_token',
    (short.data as Record<string, unknown> | null)?.error === 'invalid_token',
    JSON.stringify(short.data ?? short.error?.message))
  const unknown = await anon.rpc('get_violation_by_view_token', { p_token: 'z'.repeat(43) })
  chk('an unknown 43-char token is not_found_or_expired',
    (unknown.data as Record<string, unknown> | null)?.error === 'not_found_or_expired',
    JSON.stringify(unknown.data ?? unknown.error?.message))

  console.log(fails === 0 ? '\n✅ all green\n' : `\n❌ ${fails} failed\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(e => { console.error('🔴', (e as Error).message); process.exit(2) })

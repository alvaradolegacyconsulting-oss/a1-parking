// ════════════════════════════════════════════════════════════════════
// GATE — properties CA-only columns
// ════════════════════════════════════════════════════════════════════
//
// properties_manager_update is FOR UPDATE TO authenticated for manager
// AND leasing_agent with no column list. So every assertion here is
// about a PATCH the RLS policy permits and the guard trigger must
// refuse — which only a real manager session can prove, because the
// guard keys on auth.jwt() and a SQL session passes through by design.
//
// 🔴 THE POSITIVE CONTROLS ARE HALF THE POINT. A guard that refused
// every manager UPDATE would pass all fourteen refusal checks and
// silently take the pass caps and house rules away from the people who
// own them. Those are tested explicitly, and leasing_agent is tested
// separately from manager because the policy grants it the same writes.
//
// 🔴 WHY THIS GATE REFUSES TO RUN WHEN THE GUARD IS MISSING
// An earlier version of this file demonstrated the exposure by making
// the writes and restoring them in `finally`. That corrupted production:
// the run was piped through `head`, SIGPIPE killed the process mid-loop,
// `finally` never ran, and the restore's own error was unchecked. The
// fixture property sat in another company — a billing-relevant count —
// until it was repaired by hand.
//
// So, in order:
//   1. ARM the restore before the first write: a snapshot, signal
//      handlers, and an idempotent restoreNow(). EPIPE cannot kill us.
//   2. CANARY first. One harmless protected column (authorization_notes)
//      is probed as a manager. If it is NOT refused the guard is absent
//      — the gate restores that one column and exits 2. It never reaches
//      `company`, `is_active` or the auth_* set on an unguarded table.
//   3. NO REAL TENANT VALUES. The company probe writes a loud sentinel,
//      not a real company name. A leak is then self-evident and alters
//      nobody's property count. Proving "a manager cannot change company"
//      never required naming a company that exists.
//   4. The restore is CHECKED, RETRIED, and VERIFIED, and a restore that
//      does not hold exits non-zero with the values needed to fix it.
//
// Usage: npx tsx scripts/verify-property-columns.ts
//        (pipe to a file, not to `head` — though EPIPE is now survivable)

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

// A broken pipe must never prevent the restore. Swallow EPIPE and continue.
process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })
process.stderr.on('error', () => {})

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const STAMP = Date.now()
const COMPANY = 'Test-LEGACY', PROPERTY = 'Test Legacy Property'
let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }
const users: { email: string; uid: string }[] = []

// 🔴 Never a real company. If this ever leaks it is obvious, it belongs to
// no tenant, and the orphan-company check below fails on the next run.
const SENTINEL_COMPANY = `ZZ-GATE-LEAK-DO-NOT-USE-${STAMP}`

// The canary must be a column protected ONLY by the new migration, and
// harmless to leak. The two feature flags fail the first test: Piece 0
// already guards them, with a different token (feature_switch_not_
// permitted), so they cannot tell "Piece 0 applied" from "this applied".
// authorization_notes passes both: free text, NULL on all 28 properties,
// and carrying none of the billing (company), access (is_active) or
// authorization-state (auth_status) semantics of its neighbours.
const CANARY: [string, unknown] = ['authorization_notes', `zz canary ${STAMP}`]

// Each protected column with a value that is definitely a CHANGE.
const PROTECTED: Array<[string, unknown]> = [
  CANARY,                                        // probed first, on its own
  ['parking_tags_enabled', true],
  ['printable_visitor_passes_enabled', true],
  ['company', SENTINEL_COMPANY],                 // 🔴 the cross-tenant move
  ['is_active', false],
  ['auth_status', 'authorized'],                 // 🔴 self-authorizing
  ['auth_document_url', `https://x.invalid/${STAMP}`],
  ['auth_reference', `ZZ-${STAMP}`],
  ['auth_uploaded_by', `zz-${STAMP}@test.invalid`],
  ['auth_uploaded_at', new Date().toISOString()],
  ['auth_expires_at', new Date(Date.now() + 864e5).toISOString()],
  ['auth_notes', `zz ${STAMP}`],
  ['authorization_pdf_path', `zz/${STAMP}.pdf`],
  ['authorization_expiration_date', '2030-01-01'],
]

// Must REMAIN manager-editable (ruled).
//
// 🔴 THIS LIST IS EXHAUSTIVE ON PURPOSE. properties has 33 columns:
// 14 protected above, the 16 here, and id / name / created_at, which no
// UPDATE path should set (name is already held by the policy's own
// WITH CHECK). A column in neither list is a column this gate cannot
// say anything about — and since the guard is a DENYLIST, an untested
// column is exactly where an over-broad guard would go unnoticed. The
// count is asserted at the end of the run.
const ALLOWED: Array<[string, unknown]> = [
  ['visitor_pass_limit', 7],
  ['visitor_capacity', 11],
  ['exempt_plates', ['ZZGATE1']],
  ['house_rules_text', `zz house rules ${STAMP}`],
  ['house_rules_effective_date', '2030-02-02'],
  ['address', `${STAMP} Test St`],
  ['city', 'Houston'],
  ['state', 'TX'],
  ['zip', '77407'],
  ['notes', `zz ${STAMP}`],
  ['pm_phone', '555-0100'],
  ['pm_name', `ZZ PM ${STAMP}`],
  ['pm_email', `zz-pm-${STAMP}@test.invalid`],
]

// 🔴 TRIGGER-MANAGED, NOT DIRECTLY WRITTEN. A trigger on properties
// fires whenever house_rules_text changes and overwrites all three:
// version +1, updated_at = now(), updated_by_email = the JWT email
// (NULL for a service-role write). Three consequences:
//   • house_rules_version is an INTEGER, so the first version of this
//     gate wrote `zz-<stamp>` to it and got "invalid input syntax for
//     type integer" — reported as the guard refusing a manager, which
//     it was not.
//   • They cannot be restored in the SAME update as house_rules_text:
//     the trigger rewrites them after the assignment. restoreNow does
//     it in two phases for exactly this reason.
//   • A manager editing house_rules_text is the real positive control
//     and it is asserted below — the trigger must bump the version and
//     stamp the manager's own email.
// The trigger also TRIMS the text, which is why a probe writing
// `text + ' '` sees no bump at all: the trimmed value is not distinct.
const DERIVED = ['house_rules_version', 'house_rules_updated_at', 'house_rules_updated_by_email']

// Columns no UPDATE path sets; listed so the coverage assertion can
// account for all 33 rather than silently ignoring the remainder.
const NOT_WRITTEN = ['id', 'name', 'created_at']

const TOUCHED = [...PROTECTED, ...ALLOWED].map(([c]) => c)

// ── the armed restore ────────────────────────────────────────────────
let snap: Record<string, unknown> | null = null
let restoreDone = false

async function restoreNow(why: string): Promise<boolean> {
  if (restoreDone || !snap) return true
  restoreDone = true
  const want: Record<string, unknown> = {}
  for (const c of TOUCHED) want[c] = snap[c] ?? null
  const derived: Record<string, unknown> = {}
  for (const c of DERIVED) derived[c] = snap[c] ?? null
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Phase 1 restores everything this gate wrote, house_rules_text
    // included — which re-fires the house-rules trigger and clobbers
    // the three derived columns. Phase 2 then puts those back, and
    // must come second or the trigger overwrites it.
    const { error } = await db.from('properties').update(want).eq('name', PROPERTY).select('id')
    if (error) { console.error(`🔴 restore attempt ${attempt} (${why}) phase 1 FAILED: ${error.message}`); continue }
    const { data, error: e2 } = await db.from('properties').update(derived).eq('name', PROPERTY).select('*')
    if (e2) { console.error(`🔴 restore attempt ${attempt} (${why}) phase 2 FAILED: ${e2.message}`); continue }
    if (!data?.length) { console.error(`🔴 restore attempt ${attempt} (${why}) matched NO ROW`); continue }
    const row = data[0] as Record<string, unknown>
    const bad = [...TOUCHED, ...DERIVED].filter(c => String(row[c] ?? '') !== String(want[c] ?? snap![c] ?? ''))
    if (!bad.length) { console.log(`✅ fixture restored and verified (${why}): ${TOUCHED.length + DERIVED.length} columns match the snapshot`); return true }
    console.error(`🔴 restore attempt ${attempt} (${why}) did not hold for: ${bad.join(', ')}`)
  }
  console.error('\n🔴🔴 THE FIXTURE PROPERTY IS LEFT MODIFIED. Restore it by hand with:')
  console.error(`UPDATE properties SET ${[...TOUCHED, ...DERIVED].map(c => `${c} = ${snap![c] === null || snap![c] === undefined ? 'NULL' : typeof snap![c] === 'boolean' || typeof snap![c] === 'number' ? snap![c] : `'${String(snap![c]).replace(/'/g, "''")}'`}`).join(', ')} WHERE name = '${PROPERTY}';`)
  return false
}

async function cleanupUsers() {
  await db.from('audit_logs').delete().eq('action', 'PROPERTY_FEATURE_SWITCH_SET').in('user_email', users.map(u => u.email))
  for (const u of users) {
    await db.from('user_roles').delete().ilike('email', u.email)
    await db.auth.admin.deleteUser(u.uid).catch(() => {})
  }
  const { data: orph } = await db.auth.admin.listUsers({ perPage: 1000 })
  for (const o of (orph?.users ?? []).filter(u => /^zz-pc-[a-z]+-\d+@test\.invalid$/.test(u.email ?? ''))) {
    await db.from('user_roles').delete().ilike('email', o.email!)
    await db.auth.admin.deleteUser(o.id).catch(() => {})
    console.log(`  swept orphan: ${o.email}`)
  }
}

// 🔴 `finally` does not run when a signal kills the process. These do.
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => {
    if (dying) return
    dying = true
    console.error(`\n🔴 ${sig} — restoring the fixture before exiting.`)
    restoreNow(sig).then(cleanupUsers).then(() => process.exit(2)).catch(() => process.exit(2))
  })
}
process.on('uncaughtException', e => {
  console.error('🔴 uncaught:', (e as Error).message)
  restoreNow('uncaughtException').then(cleanupUsers).then(() => process.exit(2)).catch(() => process.exit(2))
})

async function actor(tag: string, role: string) {
  const email = `zz-pc-${tag}-${STAMP}@test.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${STAMP}q` })
  if (error || !data.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  users.push({ email, uid: data.user.id })
  const r = await db.from('user_roles').insert({ email, role, company: COMPANY, property: [PROPERTY], is_active: true })
  if (r.error) throw new Error(`user_roles ${tag}: ${r.error.message}`)
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (lErr || !link.properties?.hashed_token) throw new Error(`generateLink ${tag}: ${lErr?.message}`)
  const { error: vErr } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (vErr) throw new Error(`verifyOtp ${tag}: ${vErr.message}`)
  return { email, client }
}

const main = async () => {
  const reach = await db.from('properties').select('id').limit(1)
  if (reach.error) { console.error('db unreachable'); process.exit(2) }

  snap = (await db.from('properties').select('*').eq('name', PROPERTY).single()).data as Record<string, unknown>
  if (!snap) { console.error(`fixture property ${PROPERTY} not found`); process.exit(2) }
  for (const c of TOUCHED) {
    if (!(c in snap)) { console.error(`🔴 column ${c} is not on properties — refusing to write what cannot be restored.`); process.exit(2) }
  }
  console.log(`snapshot taken: ${PROPERTY} (id ${snap.id}), company=${snap.company}, is_active=${snap.is_active}, auth_status=${snap.auth_status}\n`)

  const probe = await db.rpc('set_property_feature_switch', { p_property: PROPERTY, p_switch: 'parking_tags', p_enabled: false })
  if (probe.error && /Could not find the function/i.test(probe.error.message)) {
    console.error('Piece 0 is not applied. Apply it, then the protected-columns migration.')
    process.exit(2)
  }

  let MGR: Awaited<ReturnType<typeof actor>> | null = null
  let LA: Awaited<ReturnType<typeof actor>> | null = null
  let CA: Awaited<ReturnType<typeof actor>> | null = null
  try {
    MGR = await actor('mgr', 'manager')
    LA  = await actor('la',  'leasing_agent')
    CA  = await actor('ca',  'company_admin')

    // ── 🔴 CANARY: is the guard actually installed? ──────────────────
    // Probed with the one protected column that is harmless to leak,
    // BEFORE anything touches company / is_active / auth_*.
    const [cCol, cVal] = CANARY
    const canary = await MGR.client.from('properties').update({ [cCol]: cVal }).eq('name', PROPERTY).select('id')
    if (!canary.error) {
      console.error(`🔴 GUARD ABSENT — a manager changed ${cCol} with no error.`)
      console.error('   The exposure is real, and this gate will not demonstrate it by')
      console.error('   writing a cross-tenant company or clearing an authorization onto')
      console.error('   a live row. Apply the protected-columns migration, then re-run.')
      console.error('   (Nothing but the canary column was written; it is restored below.)')
      await restoreNow('canary')
      await cleanupUsers()
      process.exit(2)
    }
    if (!/protected_column_not_permitted/.test(canary.error.message)) {
      console.error(`🔴 ${cCol} was refused, but not by the guard: ${canary.error.message}`)
      await restoreNow('canary'); await cleanupUsers(); process.exit(2)
    }
    console.log(`✅ canary: the guard is installed (manager refused on ${cCol})\n`)

    console.log('── a manager is refused on every protected column ──')
    for (const [col, val] of PROTECTED) {
      const r = await MGR.client.from('properties').update({ [col]: val }).eq('name', PROPERTY).select('id')
      const refused = !!r.error && /protected_column_not_permitted/.test(r.error.message)
      chk(`manager refused: ${col}`, refused, r.error ? '' : `NO ERROR — updated ${r.data?.length} row(s) 🔴`)
    }

    // leasing_agent has the same policy grant, so it needs its own proof.
    console.log('\n── and so is a leasing agent (same policy grant) ──')
    for (const col of ['company', 'auth_status', 'is_active'] as const) {
      const val = PROTECTED.find(p => p[0] === col)![1]
      const r = await LA.client.from('properties').update({ [col]: val }).eq('name', PROPERTY).select('id')
      chk(`leasing_agent refused: ${col}`, !!r.error && /protected_column_not_permitted/.test(r.error.message),
        r.error ? '' : `NO ERROR 🔴`)
    }

    console.log('\n── CONTROL: a manager can still edit what they own ──')
    for (const [col, val] of ALLOWED) {
      const r = await MGR.client.from('properties').update({ [col]: val }).eq('name', PROPERTY).select('id')
      chk(`manager CAN edit: ${col}`, !r.error && (r.data?.length ?? 0) === 1,
        r.error ? r.error.message.slice(0, 70) : 'ok')
    }

    console.log('\n── CONTROL: a CA can edit everything ──')
    let caFails = 0
    for (const [col, val] of [...PROTECTED.filter(p => p[0] !== 'company' && p[0] !== 'is_active'), ...ALLOWED]) {
      const r = await CA.client.from('properties').update({ [col]: val }).eq('name', PROPERTY).select('id')
      if (r.error) { caFails++; chk(`CA CAN edit: ${col}`, false, r.error.message.slice(0, 70)) }
    }
    chk('CA edited every protected column except company/is_active without error', caFails === 0,
      'company and is_active excluded from the CA sweep on purpose — moving the fixture company or deactivating it would disturb other gates')
    const sw = (await CA.client.rpc('set_property_feature_switch', { p_property: PROPERTY, p_switch: 'parking_tags', p_enabled: true })).data as Record<string, unknown>
    chk('CA can flip a switch (the guarded column) via the RPC', sw?.ok === true, JSON.stringify(sw?.error ?? sw?.enabled))

    // The data invariant the guard protects — and the leak detector for
    // SENTINEL_COMPANY, which is deliberately absent from this list.
    // 🔴 Coverage: every column is in exactly one bucket. A column added
    // to properties later lands in none of them and fails here, which is
    // the prompt to rule on it rather than let the denylist drift.
    const known = new Set([...TOUCHED, ...DERIVED, ...NOT_WRITTEN])
    const uncovered = Object.keys(snap!).filter(c => !known.has(c))
    chk(`every properties column is ruled on (${Object.keys(snap!).length} columns)`,
      uncovered.length === 0, uncovered.length
        ? `unruled: ${uncovered.join(', ')}`
        : `${PROTECTED.length} protected · ${ALLOWED.length} manager-editable · ${DERIVED.length} trigger-managed · ${NOT_WRITTEN.length} never written`)

    // 🔴 The house-rules positive control that matters: managers author
    // house rules, so a manager's edit must land AND be attributed to
    // them by the trigger. A guard that refused house_rules_text would
    // be caught by the ALLOWED loop; a guard that let the write through
    // but broke attribution would not.
    const hrText = `zz manager-authored house rules ${STAMP}`
    const hrW = await MGR.client.from('properties').update({ house_rules_text: hrText }).eq('name', PROPERTY).select('id')
    const hrR = (await db.from('properties')
      .select('house_rules_text, house_rules_version, house_rules_updated_by_email')
      .eq('name', PROPERTY).single()).data as Record<string, unknown>
    chk('manager authors house rules and the trigger attributes it to them',
      !hrW.error && hrR.house_rules_text === hrText
        && Number(hrR.house_rules_version) > Number(snap!.house_rules_version)
        && String(hrR.house_rules_updated_by_email).toLowerCase() === MGR.email.toLowerCase(),
      hrW.error ? hrW.error.message.slice(0, 70)
        : `v ${snap!.house_rules_version} → ${hrR.house_rules_version}, by ${hrR.house_rules_updated_by_email}`)

    const KNOWN = ['Test-LEGACY', 'A1 Wrecker llc', 'Demo Company', 'Test-PM', 'Test-ENF', 'Test PM Starter 2']
    const orphan = (await db.from('properties').select('id, name, company')).data!
      .filter(p => !KNOWN.includes(String(p.company)))
    chk('no property points at a non-existent company (also catches a gate leak)', orphan.length === 0, JSON.stringify(orphan))
  } finally {
    const held = await restoreNow('finally')
    if (!held) fails++
    await cleanupUsers()
  }

  const after = (await db.from('properties').select('*').eq('name', PROPERTY).single()).data as Record<string, unknown>
  const drifted = TOUCHED.filter(c => String(after[c] ?? '') !== String(snap![c] ?? ''))
  chk('fixture property restored exactly', drifted.length === 0, drifted.join(', '))

  console.log('')
  if (fails) { console.log(`❌ ${fails} FAILURE(S).`); process.exit(1) }
  console.log('✅ CA-only columns are CA-only; managers keep the caps, house rules and contact fields.')
}
main().catch(e => {
  console.error('FATAL', e.message)
  restoreNow('fatal').then(cleanupUsers).then(() => process.exit(2)).catch(() => process.exit(2))
})

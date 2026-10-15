// ════════════════════════════════════════════════════════════════════
// GATE — bulk_validate_rows: the four checks only the database knows
// ════════════════════════════════════════════════════════════════════
//
// 🔴 WHY THIS GATE IS MANDATORY AND THE SQL ONE IS NOT SUFFICIENT.
// A RETURNS TABLE function whose output columns do not match its SELECT
// list raises 42804 at CALL time, not CREATE time. The SQL verification
// does call the RPC, but with no JWT the call lands on the authority
// gate and raises property_not_in_scope before the query body is ever
// reached — so it proves the function runs and refuses, not that its
// eight columns line up. Only a real company_admin JWT reaches the
// body, which is what this file brings.
//
// 🔴 EVERY PROBE ROW IS FRESH AND MARKED. Prohibition and uniqueness
// triggers on vehicles mean a probe that reuses an existing row cannot
// tell its own refusal from someone else's; and a "realistic" fixture
// collides with production the second time anyone runs it. Every row
// here carries the run stamp and is deleted by it.
//
// Usage: npm run verify:bulkvalidate

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import { normalizeUnit } from '../app/lib/plate'
import { validateBulkRows, type BulkRowInput } from '../app/lib/bulk-validator'

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'EPIPE') throw e })

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const URL = g('NEXT_PUBLIC_SUPABASE_URL'), ANON = g('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const db = createClient(URL, g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const CO = 'Test-LEGACY'
const S = Date.now()
const MARK = `ZZBV${S}`.slice(0, 12)

let fails = 0
const chk = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`) }

const users: { email: string; uid: string }[] = []
const flipped: string[] = []
const vehicleIds: number[] = []
const prohibitionIds: number[] = []
const residentIds: number[] = []
let cleaned = false

async function restoreFlag() {
  while (flipped.length) {
    const co = flipped[flipped.length - 1]
    let ok = false
    for (let i = 1; i <= 3 && !ok; i++) {
      const r = await db.from('companies').update({ bulk_onboarding_enabled: false })
        .eq('name', co).select('name,bulk_onboarding_enabled')
      if (!r.error && r.data?.[0]?.bulk_onboarding_enabled === false) {
        ok = true; console.log(`   ↩ ${co}.bulk_onboarding_enabled restored to false (verified)`)
      } else console.error(`   🔴 restore ${i}/3 for ${co} failed: ${r.error?.message ?? 'read back true'}`)
    }
    if (!ok) {
      console.error(`\n🔴🔴 MANUAL ACTION REQUIRED: UPDATE public.companies SET bulk_onboarding_enabled = FALSE WHERE name = '${co}';`)
      fails++
    }
    flipped.pop()
  }
}

async function cleanup(why: string) {
  if (cleaned) return
  cleaned = true
  if (why !== 'end') console.error(`\n🔴 cleanup (${why})`)
  // RETURNING on every delete: a cleanup that reports nothing cannot be
  // told from one that matched nothing.
  if (vehicleIds.length) {
    const r = await db.from('vehicles').delete().in('id', vehicleIds).select('id')
    if (r.error || (r.data ?? []).length !== vehicleIds.length) console.error(`   🔴 vehicles: removed ${(r.data ?? []).length}/${vehicleIds.length}`, r.error ?? '')
  }
  if (prohibitionIds.length) {
    const r = await db.from('property_plate_prohibitions').delete().in('id', prohibitionIds).select('id')
    if (r.error || (r.data ?? []).length !== prohibitionIds.length) console.error(`   🔴 prohibitions: removed ${(r.data ?? []).length}/${prohibitionIds.length}`, r.error ?? '')
  }
  if (residentIds.length) {
    const r = await db.from('residents').delete().in('id', residentIds).select('id')
    if (r.error || (r.data ?? []).length !== residentIds.length) console.error(`   🔴 residents: removed ${(r.data ?? []).length}/${residentIds.length}`, r.error ?? '')
  }
  // Belt: anything carrying this run's stamp, whatever created it.
  for (const [t, c] of [['vehicles', 'plate'], ['residents', 'email'], ['property_plate_prohibitions', 'plate']] as const) {
    const stray = await db.from(t).delete().ilike(c, `%${MARK}%`).select('id')
    if ((stray.data ?? []).length) console.error(`   ⚠ swept ${(stray.data ?? []).length} stray ${t} row(s) by stamp`)
  }
  for (const u of users) {
    await db.from('user_roles').delete().ilike('email', u.email)
    await db.auth.admin.deleteUser(u.uid).catch(() => {})
  }
  const { data: orph } = await db.auth.admin.listUsers({ perPage: 1000 })
  for (const o of (orph?.users ?? []).filter(u => /^zz-bv-/.test(u.email ?? ''))) {
    await db.from('user_roles').delete().ilike('email', o.email!)
    await db.auth.admin.deleteUser(o.id).catch(() => {})
  }
  await restoreFlag()
}

// 🔴 `finally` does not run on a signal. Arm before mutating anything.
let dying = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => { if (dying) return; dying = true
    cleanup(sig).then(() => process.exit(2)).catch(() => process.exit(2)) })
}
process.on('uncaughtException', e => {
  console.error('🔴 uncaught:', (e as Error).message)
  cleanup('uncaughtException').then(() => process.exit(2)).catch(() => process.exit(2))
})

async function actor(tag: string, role: string, company: string, property: string[]) {
  const email = `zz-bv-${tag}-${S}@test.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true, password: `Zz!${S}q` })
  if (error || !data.user) throw new Error(`createUser ${tag}: ${error?.message}`)
  users.push({ email, uid: data.user.id })
  const r = await db.from('user_roles').insert({ email, role, company, property, is_active: true })
  if (r.error) throw new Error(`user_roles ${tag}: ${r.error.message}`)
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  if (lErr || !link.properties?.hashed_token) throw new Error(`link ${tag}: ${lErr?.message}`)
  const { error: vErr } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' })
  if (vErr) throw new Error(`otp ${tag}: ${vErr.message}`)
  return { email, client }
}

const main = async () => {
  // ── 0. refuse to report on an RPC that is not there ───────────────
  // Without it every refusal below passes: PostgREST answers "function
  // not found" with an error, and an error reads as a refusal.
  const probe = await db.rpc('bulk_validate_rows', { p_property_id: 0, p_rows: [] })
  if (probe.error && /could not find the function|does not exist/i.test(probe.error.message)) {
    console.error(`\n🔴 bulk_validate_rows is not installed — apply wip-20261015_bulk_validate_rows.sql first.`)
    console.error(`   Refusing to run: every negative check here would pass against a missing function.`)
    process.exit(2)
  }

  const { data: props } = await db.from('properties').select('id,name,company,is_active')
  const target = props?.find(p => p.company === CO && p.name === 'Test Legacy Property' && p.is_active)
  const sibling = props?.find(p => p.company === CO && p.is_active && p.id !== target?.id)
  const foreign = props?.find(p => p.company !== CO && p.is_active)
  if (!target || !sibling || !foreign) {
    console.error(`🔴 need two active ${CO} properties and one other company's: target=${target?.id} sibling=${sibling?.id} foreign=${foreign?.id}`)
    process.exit(2)
  }
  console.log(`fixtures: target=${target.id} (${target.name})  sibling=${sibling.id} (${sibling.name})  foreign=${foreign.id} (${foreign.company})\n`)

  let CA: Awaited<ReturnType<typeof actor>> | null = null
  let MGR: Awaited<ReturnType<typeof actor>> | null = null

  try {
    // ── probe rows, each fresh and stamped ──────────────────────────
    const pHere = `${MARK}A`, pSib = `${MARK}B`, pForeign = `${MARK}C`
    const pReview = `${MARK}D`, pDead = `${MARK}E`, pProhib = `${MARK}F`, pClean = `${MARK}G`
    const resEmail = `zz-bv-res-${S}-${MARK}@test.invalid`

    const mk = async (plate: string, propName: string, company: string, status: string, active: boolean) => {
      const r = await db.from('vehicles').insert({
        plate, state: 'TX', property: propName, company, status, is_active: active, unit: '101',
      }).select('id').single()
      if (r.error) throw new Error(`vehicle ${plate}: ${r.error.message}`)
      vehicleIds.push(r.data.id as number)
    }
    await mk(pHere, target.name as string, CO, 'active', true)
    await mk(pSib, sibling.name as string, CO, 'active', true)
    await mk(pForeign, foreign.name as string, foreign.company as string, 'active', true)
    await mk(pReview, target.name as string, CO, 'under_review', true)
    await mk(pDead, target.name as string, CO, 'declined', false)

    const pr = await db.from('property_plate_prohibitions').insert({
      property_id: target.id, plate: pProhib, reason: `gate probe ${MARK}`, added_by: 'verify:bulkvalidate',
    }).select('id').single()
    if (pr.error) throw new Error(`prohibition: ${pr.error.message}`)
    prohibitionIds.push(pr.data.id as number)

    const rr = await db.from('residents').insert({
      name: `ZZ BV ${MARK}`, email: resEmail, unit: '101',
      property: target.name, company: CO, is_active: true, status: 'active',
    }).select('id').single()
    if (rr.error) throw new Error(`resident: ${rr.error.message}`)
    residentIds.push(rr.data.id as number)

    CA = await actor('ca', 'company_admin', CO, [target.name as string])
    MGR = await actor('mgr', 'manager', CO, [target.name as string])

    // ── 1. authority, before the flag is on ─────────────────────────
    console.log('── 1. authority ──')
    const anon = createClient(URL, ANON, { auth: { persistSession: false } })
    const a1 = await anon.rpc('bulk_validate_rows', { p_property_id: target.id, p_rows: [] })
    chk('anon cannot execute the RPC', !!a1.error, a1.error ? a1.error.message.slice(0, 50) : '🔴 EXECUTED')

    const off = await CA.client.rpc('bulk_validate_rows', { p_property_id: target.id, p_rows: [] })
    chk('CA refused while bulk_onboarding_enabled = false', !!off.error,
      off.error ? off.error.message.slice(0, 50) : '🔴 EXECUTED — the flag is not gating the preview')

    const f = await db.from('companies').update({ bulk_onboarding_enabled: true })
      .eq('name', CO).select('bulk_onboarding_enabled')
    if (f.error || f.data?.[0]?.bulk_onboarding_enabled !== true) throw new Error(`could not enable the flag: ${f.error?.message}`)
    flipped.push(CO)
    console.log(`   ⚑ ${CO}.bulk_onboarding_enabled = true (restored at exit)`)

    const m1 = await MGR.client.rpc('bulk_validate_rows', { p_property_id: target.id, p_rows: [] })
    chk('a manager is refused even with the flag on', !!m1.error && /property_not_in_scope/.test(m1.error.message),
      m1.error ? m1.error.message.slice(0, 50) : '🔴 EXECUTED — onboarding is a CA act')

    const fo = await CA.client.rpc('bulk_validate_rows', { p_property_id: foreign.id, p_rows: [] })
    chk(`CA refused for another company's property (${foreign.id})`,
      !!fo.error && /property_not_in_scope/.test(fo.error.message),
      fo.error ? fo.error.message.slice(0, 50) : '🔴 EXECUTED — cross-tenant preview')

    // ── 2. 🔴 the body runs, and the eight columns line up ──────────
    // This is the 42804 gate. Everything above refuses before the query.
    console.log('\n── 2. the query body (the 42804 gate) ──')
    const rows = [
      { i: 0, email: 'nobody@test.invalid', plate: pClean },
      // Written with a dash and a space: if the key were a TS copy, or
      // whitespace-only, these would not match the stored plate.
      { i: 1, email: 'nobody@test.invalid', plate: `${pHere.slice(0, 4)}-${pHere.slice(4)}` },
      { i: 2, email: 'nobody@test.invalid', plate: `${pSib.slice(0, 4)} ${pSib.slice(4)}` },
      { i: 3, email: 'nobody@test.invalid', plate: pForeign },
      { i: 4, email: 'nobody@test.invalid', plate: pReview },
      { i: 5, email: 'nobody@test.invalid', plate: pDead },
      { i: 6, email: 'nobody@test.invalid', plate: pProhib.toLowerCase() },
      { i: 7, email: resEmail.toUpperCase(), plate: pClean + 'X' },
    ]
    const r = await CA.client.rpc('bulk_validate_rows', { p_property_id: target.id, p_rows: rows })
    chk('the RPC returns rows for a real CA', !r.error, r.error ? '🔴 ' + r.error.message.slice(0, 70) : 'ok')
    if (r.error) { await cleanup('end'); console.log(`\n❌ ${fails} failed`); process.exit(1) }

    const out = (r.data ?? []) as Record<string, unknown>[]
    chk('one row back per input row', out.length === rows.length, `got ${out.length} of ${rows.length}`)
    const COLS = ['row_index', 'plate_norm', 'plate_active_here', 'plate_active_other',
                  'other_property', 'plate_prohibited', 'resident_exists', 'resident_active']
    const missing = COLS.filter(c => !(c in (out[0] ?? {})))
    chk('all eight output columns are present', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : 'ok')
    const at = (i: number) => out.find(o => o.row_index === i) as Record<string, unknown> | undefined
    chk('row_index round-trips (error rows would otherwise point at the wrong line)',
      rows.every(x => at(x.i) !== undefined), 'ok')

    // ── 3. the key is the DATABASE's normalize_plate ────────────────
    console.log('\n── 3. normalize_plate is the key ──')
    chk('plate_norm strips a dash and uppercases', at(1)?.plate_norm === pHere, `got ${at(1)?.plate_norm}`)
    chk('plate_norm strips a space', at(2)?.plate_norm === pSib, `got ${at(2)?.plate_norm}`)
    chk('a lowercase plate normalizes to the stored form', at(6)?.plate_norm === pProhib, `got ${at(6)?.plate_norm}`)

    // ── 4. the index's predicate, not a looser one ──────────────────
    console.log('\n── 4. the predicates mirror vehicles_plate_norm_uniq ──')
    chk('active at THIS property is found through a dash', at(1)?.plate_active_here === true)
    chk("status 'under_review' counts as active (the index includes it)", at(4)?.plate_active_here === true)
    chk('a declined, inactive vehicle does NOT count', at(5)?.plate_active_here === false,
      at(5)?.plate_active_here === false ? 'ok' : '🔴 would report a conflict the index will not raise')
    chk('a clean plate is clean on every axis',
      at(0)?.plate_active_here === false && at(0)?.plate_active_other === false &&
      at(0)?.plate_prohibited === false && at(0)?.resident_exists === false)

    // ── 5. sibling scope, and the disclosure boundary ───────────────
    console.log('\n── 5. "active elsewhere" stops at the company line ──')
    chk('active at a SIBLING property is reported', at(2)?.plate_active_other === true)
    chk('   ...and names it', at(2)?.other_property === sibling.name, `got ${at(2)?.other_property}`)
    chk(`🔴 active at ANOTHER COMPANY's property is NOT reported (${foreign.company})`,
      at(3)?.plate_active_other === false && at(3)?.other_property === null,
      at(3)?.plate_active_other === false ? 'ok' : `🔴 DISCLOSED ${at(3)?.other_property}`)

    // ── 6. prohibitions and residents ───────────────────────────────
    console.log('\n── 6. prohibitions and residents ──')
    chk('a live prohibition is reported', at(6)?.plate_prohibited === true)
    chk('an existing resident is found case-insensitively on email',
      at(7)?.resident_exists === true && at(7)?.resident_active === true)
    chk('a row with no resident match reports neither', at(0)?.resident_exists === false && at(0)?.resident_active === false)

    // ── 7. the pure half, against production's real unit values ─────
    // The unit rule's own claim is "removing a leading noise word would
    // change the comparison key". Asserted against live data rather
    // than against examples I chose.
    console.log('\n── 7. the unit rule holds against production units ──')
    const { data: resUnits } = await db.from('residents').select('unit').limit(5000)
    const units = (resUnits ?? []).map(x => String(x.unit ?? '')).filter(Boolean)
    const rejected = units.filter(u => flagsFor(u).length > 0)
    const wrongly = rejected.filter(u => normalizeUnit(u) === normalizeUnit(stripNoise(u)))
    chk(`every unit the rule rejects really does break the key (${rejected.length} of ${units.length} rejected)`,
      wrongly.length === 0, wrongly.length ? `🔴 rejected without cause: ${wrongly.slice(0, 5).join(' | ')}` : 'ok')
    for (const keep of ['#197', 'B-1', 'Trlr 129', 'Traila 80', '1150', "'1150"]) {
      chk(`   "${keep}" is accepted`, flagsFor(keep).length === 0, flagsFor(keep)[0]?.message?.slice(0, 40) ?? 'ok')
    }
    for (const kill of ['Apt 1150', 'Unit 81', 'apt. 1048', 'Suite 12']) {
      chk(`   "${kill}" is rejected`, flagsFor(kill).length > 0)
    }

  } finally {
    await cleanup('end')
  }

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  console.log('\n── 🔴 the name rule ──')
  nameRuleChecks(chk)

  console.log(`\n${fails === 0 ? '✅ all green' : `❌ ${fails} failed`}`)
  process.exit(fails === 0 ? 0 : 1)
}

const NOISE = /^\s*(apts?|apt\.|appt\.?|apartments?|apartamentos?|units?|ste\.?|suites?|no\.?|num\.?)\s*[\s.#-]*\s*(?=[A-Za-z0-9])/i
const stripNoise = (u: string) => u.trim().replace(/^'/, '').replace(NOISE, '')

/** A row that passes everything, so one field can be varied at a time. */
function baseRow(over: Partial<BulkRowInput> = {}): BulkRowInput {
  return {
    index: 0, unit: '101', first_name: 'A', last_name: 'B', email: 'a@b.invalid', phone: '',
    plate: 'ABC1234', plate_state: 'TX', make: '', model: '', color: '', tag_number: '',
    plateNorm: 'ABC1234',
    ...over,
  }
}

/** Run the real validator on one unit value and keep only unit errors. */
function flagsFor(unit: string) {
  return validateBulkRows([baseRow({ unit })]).filter(e => e.column === 'unit')
}

// ════════════════════════════════════════════════════════════════════
// 🔴 THE NAME RULE — one is enough, neither is not
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16. Requiring both rejected a shape the architect's own
// Alden file contains and that real tenancies produce: a mononym, a
// business name on the lease, a resident whose given name nobody wrote
// down.
//
// 🔴 AND THE DATABASE NEVER HAD THE PAIR. residents has a SINGLE `name`
// column; the loader concatenates and trims, so ('Alex','') stores as
// 'Alex' and ('','Draper') as 'Draper'. Measured across the 228
// batch-loaded rows: 0 with a stray leading or trailing space. The
// first/last split exists only in the template, which is why this is a
// rule about a PAIR and cannot live in the per-field REQUIRED loop.
export function nameRuleChecks(
  chk: (n: string, ok: boolean, d?: string) => void,
) {
  const nameErrs = (first: string, last: string) =>
    validateBulkRows([baseRow({ first_name: first, last_name: last })])
      .filter(e => e.code === 'name_required' || e.column === 'first_name' || e.column === 'last_name')

  chk('🔴 both names given → accepted', nameErrs('Alex', 'Draper').length === 0,
    JSON.stringify(nameErrs('Alex', 'Draper')))
  chk('🔴 LAST name only → accepted (the shape the instructions ask for)',
    nameErrs('', 'Draper').length === 0,
    `${JSON.stringify(nameErrs('', 'Draper'))} — "If you only have one name, put it in last name"`)
  chk('🔴 FIRST name only → accepted too',
    nameErrs('Alex', '').length === 0,
    `${JSON.stringify(nameErrs('Alex', ''))} — the ruling says either may be blank, not that one is privileged`)
  chk('🔴 NEITHER name → refused',
    nameErrs('', '').length === 1 && nameErrs('', '')[0].code === 'name_required',
    JSON.stringify(nameErrs('', '')))
  chk('   ...and the error points at last_name, where the customer is told to put one name',
    nameErrs('', '')[0]?.column === 'last_name',
    `column=${nameErrs('', '')[0]?.column} — naming the column alphabetically first would send them to the wrong box`)
  chk('   ...and whitespace is not a name',
    nameErrs('   ', '\t').length === 1,
    JSON.stringify(nameErrs('   ', '\t')))
  // 🔴 The negative control: email is STILL required. Relaxing the name
  // rule must not have relaxed its neighbour in the same REQUIRED list.
  const noEmail = validateBulkRows([baseRow({ email: '' })]).filter(e => e.column === 'email')
  chk('🔴 email is still required — the relaxation was narrow',
    noEmail.length >= 1 && noEmail.some(e => e.code === 'required'),
    JSON.stringify(noEmail))
  const noUnit = validateBulkRows([baseRow({ unit: '' })]).filter(e => e.column === 'unit')
  chk('   ...and so are unit, plate and plate_state',
    noUnit.length >= 1
    && validateBulkRows([baseRow({ plate: '' })]).some(e => e.column === 'plate')
    && validateBulkRows([baseRow({ plate_state: '' })]).some(e => e.column === 'plate_state'),
    'the REQUIRED list lost exactly two entries and kept four')
}

main().catch(async e => { console.error('🔴', (e as Error).message); await cleanup('throw'); process.exit(2) })

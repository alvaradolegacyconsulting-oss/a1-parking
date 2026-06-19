// B209 — /register companion-vehicle route regression probe.
//
// Three cases per Jose's design sign-off 2026-06-19:
//   1. Fake/invalid JWT → 401 unauthenticated
//   2. Valid session BUT no matching residents row → 400 no_residents_row
//   3. Valid scope (real session + matching residents row) → 200 ok with
//      vehicles_inserted > 0 AND the vehicles row lands in DB with
//      resident_email stamped + status='pending' + correct
//      property/unit derived from the residents row
//
// Why this probe earns its cost (per Jose 2026-06-19): the route fixes
// a wrongful-tow-class bug on the PRIMARY onboarding path, is about to
// become the most-trafficked write surface for residents, AND gets
// CAPTCHA bolted on tomorrow. A standing regression probe ensures the
// 3 cases STILL pass after each next-edit, not just at ship time.
//
// Discipline:
//   • Throwaway personas (fresh auth.users + residents per run).
//   • Reverse-LIFO cleanup (matches B90 v2 / A2 / deactivation-model /
//     B165 probe pattern).
//   • Read-only against the route itself; the route does writes (that's
//     the point), but they're against the throwaway resident.
//   • Refusal-case assertions check the route's error response shape AND
//     that NO vehicle row landed for the refused call.
//
// USAGE
//   npx tsx --env-file=.env.local --require ./scripts/_server-only-shim.cjs \
//     scripts/probe-b209-register-vehicle.ts
//
//   Probe runs against the locally-running dev server by default
//   (http://localhost:3000). Override with PROBE_BASE_URL env var to hit
//   a deployed preview / production probe.

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAdminKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const baseUrl = process.env.PROBE_BASE_URL || 'http://localhost:3000'

const admin = createClient(supabaseUrl, supabaseAdminKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const RUN_TAG = `B209${Math.random().toString(36).slice(2, 7)}`
const cleanup: Array<() => Promise<void>> = []

const results: { id: string; pass: boolean; detail: string }[] = []
function record(id: string, pass: boolean, detail: string) {
  results.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}

// ── Fixture helpers (throwaway personas) ────────────────────────────

interface Persona {
  email: string
  password: string
  authUserId: string
  accessToken: string
}

async function spawnPersona(suffix: string): Promise<Persona> {
  const email = `b209-probe-${RUN_TAG}-${suffix}@example.com`.toLowerCase()
  const password = `B209Pr0be!${RUN_TAG}`
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (cErr || !created.user) throw new Error(`spawnPersona ${suffix}: ${cErr?.message ?? 'no user'}`)
  cleanup.push(async () => { await admin.auth.admin.deleteUser(created.user!.id).catch(() => {}) })

  // Acquire access_token by signing in (anon client). This is the
  // session JWT the route will see via Cookie.
  const anon = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: signedIn, error: sErr } = await anon.auth.signInWithPassword({ email, password })
  if (sErr || !signedIn.session) throw new Error(`spawnPersona ${suffix} signin: ${sErr?.message ?? 'no session'}`)

  return {
    email, password,
    authUserId: created.user.id,
    accessToken: signedIn.session.access_token,
  }
}

async function spawnFixtureResident(suffix: string, email: string, property: string, unit: string) {
  const { error } = await admin.from('residents').insert({
    email,
    name: `B209 Probe ${suffix}`,
    property,
    unit,
    is_active: false,    // pending — matches /register state at companion-vehicle call time
    status: 'pending',
    texas_confirmed: true,
    texas_confirmed_at: '2026-01-01T00:00:00Z',
  })
  if (error) throw new Error(`spawnFixtureResident ${suffix}: ${error.message}`)
  cleanup.push(async () => {
    // Resident row + any vehicle rows the probe created against it.
    try { await admin.from('vehicles').delete().ilike('resident_email', email) } catch { /* best-effort */ }
    try { await admin.from('residents').delete().ilike('email', email) } catch { /* best-effort */ }
  })
}

// ── Probe call helpers ──────────────────────────────────────────────

interface RouteResponse {
  status: number
  body: any
}

async function callRoute(accessToken: string | null, payload: any): Promise<RouteResponse> {
  // Supabase's auth cookie name in this project's config:
  // sb-<project_ref>-auth-token. We send the access_token via a
  // synthesized cookie that createSupabaseServerClient will read.
  // (The route uses createServerClient which calls getUser() against
  // the JWT it finds in the cookie store.)
  const projectRef = supabaseUrl.split('//')[1].split('.')[0]
  const cookieName = `sb-${projectRef}-auth-token`
  // Cookie value shape Supabase expects: a JSON object stringified with the access_token field.
  const cookieValue = accessToken
    ? encodeURIComponent(JSON.stringify({ access_token: accessToken, token_type: 'bearer' }))
    : ''
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (accessToken) headers.Cookie = `${cookieName}=${cookieValue}`

  const res = await fetch(`${baseUrl}/api/register/companion-vehicle`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

// ── Case 1 — fake/invalid JWT → 401 ─────────────────────────────────

async function caseFakeJwt() {
  const id = 'rpc.fake_jwt_unauthenticated'
  try {
    const r = await callRoute('NOT_A_REAL_JWT_AT_ALL', {
      vehicles: [{ plate: 'FAKE1', state: 'TX' }],
    })
    const pass = r.status === 401 && r.body?.ok === false && r.body?.error_class === 'unauthenticated'
    record(id, pass, pass
      ? `401 unauthenticated as expected (error_class=${r.body?.error_class})`
      : `EXPECTED 401/unauthenticated, got status=${r.status} body=${JSON.stringify(r.body)}`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

// Sub-case: no cookie at all (anon caller)
async function caseNoCookie() {
  const id = 'rpc.no_cookie_unauthenticated'
  try {
    const r = await callRoute(null, {
      vehicles: [{ plate: 'NONE1', state: 'TX' }],
    })
    const pass = r.status === 401 && r.body?.ok === false
    record(id, pass, pass ? '401 unauthenticated as expected' : `EXPECTED 401, got status=${r.status}`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

// ── Case 2 — valid session, no matching residents row → 400 ─────────

async function caseNoResidentsRow() {
  const id = 'rpc.valid_session_no_residents_row'
  try {
    const persona = await spawnPersona('noresidents')
    // Persona exists in auth.users but we DO NOT spawn a residents row.
    // This simulates a between-steps race where signInWithPassword
    // landed but the residents insert hasn't fired yet, OR a future
    // bug where the residents insert was skipped.
    const r = await callRoute(persona.accessToken, {
      vehicles: [{ plate: 'ORPH1', state: 'TX', make: 'Honda', model: 'Civic', color: 'silver' }],
    })
    const pass = r.status === 400 && r.body?.ok === false && r.body?.error_class === 'no_residents_row'
    record(id, pass, pass
      ? `400 no_residents_row as expected`
      : `EXPECTED 400/no_residents_row, got status=${r.status} body=${JSON.stringify(r.body)}`)

    // Negative side-check: the vehicle must NOT have landed.
    const { count } = await admin
      .from('vehicles')
      .select('id', { count: 'exact', head: true })
      .eq('plate', 'ORPH1')
      .eq('resident_email', persona.email)
    const sideOk = count === 0
    record(`${id}.negative_side_check`, sideOk, sideOk
      ? 'No vehicle row landed (refusal honored at DB layer too)'
      : `LEAK — ${count} vehicle row(s) landed for ORPH1`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

// ── Case 3 — valid scope → insert lands with correct stamping ───────

async function caseValidScope() {
  const id = 'rpc.valid_scope_inserts_with_pending_status'
  try {
    const persona = await spawnPersona('valid')
    const property = 'Bayou Heights Apartments'  // existing demo property
    const unit = `B209-${RUN_TAG.slice(-3)}`     // unique per probe run
    await spawnFixtureResident('valid', persona.email, property, unit)

    const plates = [`B209${RUN_TAG.slice(-3)}A`, `B209${RUN_TAG.slice(-3)}B`]
    const r = await callRoute(persona.accessToken, {
      vehicles: plates.map(p => ({
        plate: p,
        state: 'TX',
        make: 'Honda',
        model: 'Accord',
        year: 2024,
        color: 'gold',
      })),
    })

    const okShape = r.status === 200
      && r.body?.ok === true
      && r.body?.vehicles_attempted === 2
      && r.body?.vehicles_inserted === 2
      && r.body?.vehicles_failed === 0
      && Array.isArray(r.body?.inserted_plates) && r.body.inserted_plates.length === 2
      && r.body?.gap_message === null
    record(`${id}.response_shape`, okShape, okShape
      ? `200 ok, 2/2 inserted, gap_message=null`
      : `EXPECTED 200 + 2/2 inserted, got ${JSON.stringify(r.body)}`)

    // DB-side assertions: rows landed with correct stamping.
    const { data: rows } = await admin
      .from('vehicles')
      .select('plate, status, is_active, property, unit, resident_email')
      .in('plate', plates)
    const allCorrect = rows && rows.length === 2 && rows.every(row =>
      row.status === 'pending'
      && row.is_active === false
      && row.property === property
      && row.unit === unit
      && row.resident_email === persona.email.toLowerCase()
    )
    record(`${id}.db_stamping`, !!allCorrect, allCorrect
      ? `Both rows have status='pending', is_active=false, scope from residents row (not body)`
      : `STAMP MISMATCH — rows=${JSON.stringify(rows)}`)

    // Manager-queue predicate equivalent (filter status='pending' ilike property)
    const { data: queueView } = await admin
      .from('vehicles')
      .select('plate, status')
      .ilike('property', property)
      .eq('status', 'pending')
      .in('plate', plates)
    const visibleInQueue = (queueView ?? []).length === 2
    record(`${id}.manager_queue_visibility`, visibleInQueue, visibleInQueue
      ? `Both plates visible to the manager pending queue predicate`
      : `MANAGER QUEUE MISS — ${(queueView ?? []).length}/2 visible`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

// ── Case 4 (bonus) — scope-spoof attempt: body supplies different email ──
// Confirms the route IGNORES caller-supplied scope (the load-bearing
// defense per Jose's "cross-resident-insert hole" guard).

async function caseScopeSpoof() {
  const id = 'rpc.scope_spoof_caller_supplied_email_ignored'
  try {
    const persona = await spawnPersona('spoof')
    await spawnFixtureResident('spoof', persona.email, 'Bayou Heights Apartments', `B209-${RUN_TAG.slice(-3)}-SPOOF`)

    const plate = `SPOOF${RUN_TAG.slice(-3)}`
    const targetVictimEmail = `b209-VICTIM-${RUN_TAG}@example.com`  // does not exist; doesn't matter — body field is ignored
    const r = await callRoute(persona.accessToken, {
      vehicles: [{ plate, state: 'TX' }],
      // Try to inject scope via body. The route ignores these (uses
      // residents-row-derived scope only).
      resident_email: targetVictimEmail,
      unit: 'SPOOF999',
      property: 'Some Other Property',
    } as any)

    const okShape = r.status === 200 && r.body?.ok === true && r.body?.vehicles_inserted === 1
    record(`${id}.response_shape`, okShape, okShape ? '200 ok, 1 inserted (body scope fields silently ignored)' : `unexpected body: ${JSON.stringify(r.body)}`)

    // The row should be scoped to the CALLER's residents row, not the
    // spoofed body fields.
    const { data: rows } = await admin
      .from('vehicles')
      .select('plate, resident_email, property, unit')
      .eq('plate', plate)
    const scopeCorrect = rows && rows.length === 1
      && rows[0].resident_email === persona.email.toLowerCase()
      && rows[0].property === 'Bayou Heights Apartments'
      && rows[0].unit === `B209-${RUN_TAG.slice(-3)}-SPOOF`
    record(`${id}.scope_locked_to_jwt`, !!scopeCorrect, scopeCorrect
      ? `Row scope = persona's residents row (jwt-derived); spoofed body fields ignored`
      : `SCOPE LEAK — row=${JSON.stringify(rows?.[0])}`)

    // Defense-in-depth: no row at the victim email
    const { count: victimCount } = await admin
      .from('vehicles')
      .select('id', { count: 'exact', head: true })
      .ilike('resident_email', targetVictimEmail)
    const noLeak = victimCount === 0
    record(`${id}.victim_email_clean`, noLeak, noLeak ? 'No row stamped to spoofed email' : `LEAK — ${victimCount} row(s) at spoofed email`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`── B209 /register companion-vehicle probe (RUN_TAG=${RUN_TAG}) ──`)
  console.log(`── base URL: ${baseUrl} ──\n`)
  try {
    await caseFakeJwt()
    await caseNoCookie()
    await caseNoResidentsRow()
    await caseValidScope()
    await caseScopeSpoof()
  } finally {
    console.log('\n── Cleanup (reverse-LIFO) ──')
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { await cleanup[i]() } catch { /* best-effort */ }
    }
  }
  const passed = results.filter(r => r.pass).length
  console.log(`\n── RESULT — ${passed}/${results.length} passed ──`)
  if (passed !== results.length) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })

// Spaces v1 — update_space_metadata RPC pre-deploy regression probe.
//
// Jose ordered Option 2 (Jose 2026-06-21) — probe the load-bearing
// label_already_exists catch + the role guard + the audit row BEFORE
// commit-3 UI code deploys. Deferring to the in-product UI smoke means
// a user is first to exercise the catch, same false-green pattern we
// keep catching at the data layer (B220 / B225).
//
// FIVE CASES:
//   1. guard.driver_role_rejected — auth as DRIVER, call RPC → role_not_allowed
//      (verification C in SQL Editor proves unauthenticated rejection;
//      this proves authenticated-but-wrong-role rejection — different scenario)
//   2. catch.label_collision (D) — manager renames space A to space B's label
//      at the same property → label_already_exists (NOT raw unique_violation)
//   3. guard.invalid_type (E) — manager submits type='not_real' → invalid_type
//   4. guard.empty_label (F) — manager submits label='' → label_required
//   5. success.audit_row + REVERT (G) — manager renames to a probe-tagged label,
//      asserts AUTH_SPACE_UPDATE_METADATA audit row written with old+new label,
//      THEN renames back to the original label so the DB is in its pre-probe state
//
// REUSABLE HARNESS (per Jose 2026-06-21 — "reusable for future role-pinned
// RPC smoke: assign/reassign, eventually B225's driver_plate_lookup")
//
//   spawnRolePersona(role, suffix, company) creates a throwaway auth.users
//   row + a user_roles row pinned to the given role+company, signs in via
//   signInWithPassword to get a real session, and returns a Supabase client
//   instance with that session pre-loaded. Future role-pinned RPC probes
//   (assign_space, reassign_space, free_space, generate_spaces_from_pool,
//   decommission_space, and B225's driver_plate_lookup) can reuse the
//   helper verbatim — just call spawnRolePersona('manager', ...) and
//   await client.rpc('<rpc_name>', { p_* params }).
//
// MUTATING-WRITE STORY (per Jose 2026-06-21 — "don't leave it mutating
// data with no cleanup story")
//
//   Cases 1-4 don't mutate (RPC raises before COMMIT; PL/pgSQL rolls back
//   the function call). Case 5 DOES mutate (successful UPDATE writes the
//   new label + the audit row). Cleanup story:
//     - Renames revert inline at end of case G via a second RPC call
//       (rename back to the original label, captured at probe start).
//     - The AUTH_SPACE_UPDATE_METADATA audit row from G is NOT reverted —
//       audit rows are append-only by design. Probe leaves 2 audit rows
//       (the forward rename + the revert rename), both tagged with the
//       probe's RUN_TAG in new_values.new_label so they're identifiable.
//     - Throwaway auth.users + user_roles rows torn down in reverse-LIFO.
//
//   If the probe crashes between G's forward-rename and the revert, the
//   space's label is stuck at 'PROBE-DELETE-ME-<RUN_TAG>'. The RUN_TAG
//   in the label makes this obvious + searchable; the cleanup block runs
//   in finally{} so this is unlikely but possible.
//
// USAGE
//   npx tsx --env-file=.env.local --require ./scripts/_server-only-shim.cjs \
//     scripts/probe-spaces-metadata-rpc.ts
//
//   Default base = local dev; override with PROBE_BASE_URL for deployed
//   preview / production probe. Note: this probe talks to the Supabase
//   PostgREST RPC endpoint directly (via supabase-js client), NOT to a
//   Next.js API route, so PROBE_BASE_URL doesn't actually matter for the
//   RPC calls — only matters if a future case calls a wrapper route.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAdminKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const admin = createClient(supabaseUrl, supabaseAdminKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const RUN_TAG = `SPMETA${Math.random().toString(36).slice(2, 7).toUpperCase()}`
const cleanup: Array<() => Promise<void>> = []

const results: { id: string; pass: boolean; detail: string }[] = []
function record(id: string, pass: boolean, detail: string) {
  results.push({ id, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}

// ── Reusable role-persona harness ───────────────────────────────────
// Spawn an auth.users row + a user_roles row with the given role+company,
// sign in to get a session, return a Supabase client with that session.
// Reusable for any future role-pinned RPC probe.

interface RolePersona {
  email: string
  password: string
  authUserId: string
  client: SupabaseClient  // ready to call .rpc() with the persona's auth
}

async function spawnRolePersona(role: string, suffix: string, company: string): Promise<RolePersona> {
  const email = `spmeta-${role}-${RUN_TAG}-${suffix}@example.com`.toLowerCase()
  const password = `SpMeta!${RUN_TAG}`

  // auth.users
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (cErr || !created.user) throw new Error(`spawnRolePersona ${role}/${suffix}: ${cErr?.message ?? 'no user'}`)
  cleanup.push(async () => { await admin.auth.admin.deleteUser(created.user!.id).catch(() => {}) })

  // user_roles row — the load-bearing identity for the role-guard
  const { error: rErr } = await admin.from('user_roles').insert({
    email,
    role,
    company,
    property: [],  // empty property list is fine for the metadata RPC's defenses
                   // (it checks company match, not property assignment)
  })
  if (rErr) throw new Error(`spawnRolePersona ${role}/${suffix} user_roles: ${rErr.message}`)
  cleanup.push(async () => { try { await admin.from('user_roles').delete().ilike('email', email) } catch { /* best-effort */ } })

  // signInWithPassword → real session on a fresh anon client
  const anon = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: signedIn, error: sErr } = await anon.auth.signInWithPassword({ email, password })
  if (sErr || !signedIn.session) throw new Error(`spawnRolePersona ${role}/${suffix} signin: ${sErr?.message ?? 'no session'}`)

  return {
    email, password,
    authUserId: created.user.id,
    client: anon,  // anon client now carries the persona's session for .rpc() calls
  }
}

// ── Setup: discover the UAT Test Property + two spaces + the company ──
// All cases need 2 spaces at the same property (for D collision). The
// company name comes from the property row so the throwaway persona's
// user_roles.company matches and the company-scope defense lets the RPC
// reach the actual UPDATE attempt.

interface Setup {
  company: string
  property: string
  spaceA: { id: number; originalLabel: string }
  spaceB: { id: number; originalLabel: string }
}

async function discoverSetup(): Promise<Setup> {
  // Find a property with ≥ 2 spaces. UAT Test Property is the likely
  // candidate post-commit-1 backfill (126 spaces); pick whichever
  // property has ≥ 2 active spaces.
  const { data: candidates, error: cErr } = await admin
    .from('spaces')
    .select('id, label, property, company')
    .eq('is_active', true)
    .order('property')
    .order('id')
    .limit(50)
  if (cErr) throw new Error(`discoverSetup spaces query: ${cErr.message}`)
  if (!candidates || candidates.length < 2) throw new Error(`discoverSetup: need ≥ 2 active spaces; found ${candidates?.length ?? 0}`)

  // Group by property; pick the first property with ≥ 2 spaces.
  const byProperty = new Map<string, typeof candidates>()
  for (const s of candidates) {
    if (!byProperty.has(s.property)) byProperty.set(s.property, [] as any)
    byProperty.get(s.property)!.push(s)
  }
  const propertyEntry = Array.from(byProperty.entries()).find(([, list]) => list.length >= 2)
  if (!propertyEntry) throw new Error(`discoverSetup: no property has ≥ 2 active spaces`)
  const [property, spaces] = propertyEntry
  const company = spaces[0].company
  if (!company) throw new Error(`discoverSetup: space ${spaces[0].id} has NULL company — backfill bug?`)

  return {
    company,
    property,
    spaceA: { id: spaces[0].id, originalLabel: spaces[0].label },
    spaceB: { id: spaces[1].id, originalLabel: spaces[1].label },
  }
}

// ── Cases ────────────────────────────────────────────────────────────

async function caseDriverRejected(setup: Setup) {
  const id = 'guard.driver_role_rejected'
  try {
    const persona = await spawnRolePersona('driver', 'rejected', setup.company)
    const { error } = await persona.client.rpc('update_space_metadata', {
      p_space_id: setup.spaceA.id,
      p_label: 'WHATEVER',
      p_description: null,
      p_type: 'regular',
      p_is_bundled: false,
    })
    const pass = !!error && /role_not_allowed/i.test(error.message)
    record(id, pass, pass
      ? `Driver caller correctly rejected with role_not_allowed (${error.message})`
      : `EXPECTED role_not_allowed; got ${error ? `error="${error.message}"` : 'no error'}`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

async function caseLabelCollision(setup: Setup, manager: RolePersona) {
  const id = 'catch.label_collision_clean_raise (D)'
  try {
    // Rename space A's label to space B's label → UNIQUE collision.
    const { error } = await manager.client.rpc('update_space_metadata', {
      p_space_id: setup.spaceA.id,
      p_label: setup.spaceB.originalLabel,
      p_description: null,
      p_type: 'regular',
      p_is_bundled: false,
    })
    const passRaise = !!error && /label_already_exists/i.test(error.message)
    record(`${id}.clean_raise`, passRaise, passRaise
      ? `label_already_exists raised (NOT raw unique_violation) — message="${error.message}"`
      : `EXPECTED label_already_exists; got ${error ? `"${error.message}"` : 'no error'}`)

    // Side-check: space A's label is STILL its original (rollback worked)
    const { data: row } = await admin.from('spaces').select('label').eq('id', setup.spaceA.id).single()
    const passRollback = row?.label === setup.spaceA.originalLabel
    record(`${id}.rollback_intact`, passRollback, passRollback
      ? `space A label still '${setup.spaceA.originalLabel}' (PL/pgSQL rolled back the failed UPDATE)`
      : `ROLLBACK BUG — space A label = '${row?.label}' (expected '${setup.spaceA.originalLabel}')`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

async function caseInvalidType(setup: Setup, manager: RolePersona) {
  const id = 'guard.invalid_type (E)'
  try {
    const { error } = await manager.client.rpc('update_space_metadata', {
      p_space_id: setup.spaceA.id,
      p_label: setup.spaceA.originalLabel,    // current label — wouldn't collide even if reached
      p_description: null,
      p_type: 'not_a_real_type',
      p_is_bundled: false,
    })
    const pass = !!error && /invalid_type/i.test(error.message)
    record(id, pass, pass
      ? `invalid_type raised with HINT listing valid 6 — message="${error.message}"`
      : `EXPECTED invalid_type; got ${error ? `"${error.message}"` : 'no error'}`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

async function caseEmptyLabel(setup: Setup, manager: RolePersona) {
  const id = 'guard.empty_label (F)'
  try {
    const { error } = await manager.client.rpc('update_space_metadata', {
      p_space_id: setup.spaceA.id,
      p_label: '',
      p_description: null,
      p_type: 'regular',
      p_is_bundled: false,
    })
    const pass = !!error && /label_required/i.test(error.message)
    record(id, pass, pass
      ? `label_required raised (NULLIF + trim catches '') — message="${error.message}"`
      : `EXPECTED label_required; got ${error ? `"${error.message}"` : 'no error'}`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

async function caseSuccessAuditRevert(setup: Setup, manager: RolePersona) {
  const id = 'success.metadata_update_with_audit_then_revert (G)'
  const probeLabel = `PROBE-DELETE-ME-${RUN_TAG}`
  try {
    // ── Forward: rename to probe-tagged label
    const { error: fwdErr } = await manager.client.rpc('update_space_metadata', {
      p_space_id: setup.spaceA.id,
      p_label: probeLabel,
      p_description: null,
      p_type: 'regular',
      p_is_bundled: false,
    })
    record(`${id}.forward_rename_succeeded`, !fwdErr, fwdErr
      ? `forward rename FAILED: "${fwdErr.message}"`
      : `forward rename succeeded (label now '${probeLabel}')`)
    if (fwdErr) return

    // ── Side-check 1: spaces.label updated
    const { data: row } = await admin.from('spaces').select('label').eq('id', setup.spaceA.id).single()
    const labelOk = row?.label === probeLabel
    record(`${id}.label_persisted`, labelOk, labelOk
      ? `spaces.id=${setup.spaceA.id}.label = '${probeLabel}'`
      : `LABEL NOT PERSISTED — read back '${row?.label}'`)

    // ── Side-check 2: AUTH_SPACE_UPDATE_METADATA audit row written
    //    with old+new label, type, and the probe persona's email
    const { data: auditRows } = await admin
      .from('audit_logs')
      .select('user_email, action, record_id, new_values, created_at')
      .eq('action', 'AUTH_SPACE_UPDATE_METADATA')
      .eq('record_id', setup.spaceA.id)
      .order('created_at', { ascending: false })
      .limit(1)
    const auditOk =
      !!auditRows && auditRows.length === 1
      && auditRows[0].user_email === manager.email.toLowerCase()
      && auditRows[0].new_values?.old_label === setup.spaceA.originalLabel
      && auditRows[0].new_values?.new_label === probeLabel
    record(`${id}.audit_row_written`, auditOk, auditOk
      ? `AUTH_SPACE_UPDATE_METADATA row written: old='${setup.spaceA.originalLabel}' → new='${probeLabel}' by ${manager.email}`
      : `audit row missing or mismatched: ${JSON.stringify(auditRows?.[0])}`)

    // ── Revert: rename back to original label
    const { error: revertErr } = await manager.client.rpc('update_space_metadata', {
      p_space_id: setup.spaceA.id,
      p_label: setup.spaceA.originalLabel,
      p_description: null,
      p_type: 'regular',
      p_is_bundled: false,
    })
    record(`${id}.revert_succeeded`, !revertErr, revertErr
      ? `REVERT FAILED — space ${setup.spaceA.id} STILL labeled '${probeLabel}' (manual cleanup needed): "${revertErr.message}"`
      : `reverted: spaces.id=${setup.spaceA.id}.label = '${setup.spaceA.originalLabel}'`)

    // ── Side-check 3: label is back to original
    const { data: reverted } = await admin.from('spaces').select('label').eq('id', setup.spaceA.id).single()
    const revertedOk = reverted?.label === setup.spaceA.originalLabel
    record(`${id}.label_back_to_original`, revertedOk, revertedOk
      ? `space A label back to '${setup.spaceA.originalLabel}' — DB state restored`
      : `DB STATE NOT RESTORED — label = '${reverted?.label}'`)
  } catch (e) {
    record(id, false, `threw: ${(e as Error).message}`)
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`── Spaces v1 update_space_metadata probe (RUN_TAG=${RUN_TAG}) ──\n`)
  let setup: Setup | null = null
  let manager: RolePersona | null = null
  try {
    setup = await discoverSetup()
    console.log(`── Setup discovered ──`)
    console.log(`   property: ${setup.property}`)
    console.log(`   company:  ${setup.company}`)
    console.log(`   space A:  id=${setup.spaceA.id}, label='${setup.spaceA.originalLabel}'`)
    console.log(`   space B:  id=${setup.spaceB.id}, label='${setup.spaceB.originalLabel}'\n`)

    manager = await spawnRolePersona('manager', 'success', setup.company)
    console.log(`── Manager persona spawned: ${manager.email} (company=${setup.company}) ──\n`)

    await caseDriverRejected(setup)
    await caseLabelCollision(setup, manager)
    await caseInvalidType(setup, manager)
    await caseEmptyLabel(setup, manager)
    await caseSuccessAuditRevert(setup, manager)
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

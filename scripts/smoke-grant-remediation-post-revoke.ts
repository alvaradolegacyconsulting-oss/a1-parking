#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// Smoke — post-REVOKE gating for 20260722_grant_remediation_deny_by_default
// 2026-07-22
//
// Runs after the migration COMMITs. Gates C5 code half from shipping.
// Any failure → paste scripts/emergency-restore-grants.sql, diagnose.
//
// ── COVERAGE ───────────────────────────────────────────────────────
// 1. FUNCTIONAL anon RPC calls — 7 of 8 preserved RPCs (validate_proposal_code
//    skipped unless a probe code is provided). Not just "grant present"
//    — actual call. Tow link is non-negotiable per Mateo.
// 2. STRUCTURAL anon table SELECTs — must all return permission-denied.
//    If ANY returns 0 rows without error, a table grant leaked through.
// 3. AUTHENTICATED READ smoke — as legacy-manager (Test-LEGACY),
//    load residents. Proves the 3 RLS helpers + auth EXECUTE held.
//    Missing = total authenticated outage.
// 4. AUTHENTICATED WRITE smoke — as legacy-manager, create a visitor
//    pass → enforce_visitor_pass_limit trigger fires → write succeeds.
//    Missing trigger EXECUTE = silent write failure (Category B risk
//    per Mateo).
// 5. SERVICE_ROLE write smoke — INSERT + DELETE against
//    provisioning_failures (lowest-blast-radius write path). Proves
//    service_role retention (VQ.4d belt-and-suspenders + real call).
//
// ── ENV ────────────────────────────────────────────────────────────
//   NEXT_PUBLIC_SUPABASE_URL       — target project
//   NEXT_PUBLIC_SUPABASE_ANON_KEY  — for anon client
//   SUPABASE_SERVICE_ROLE_KEY      — for service_role write smoke +
//                                    sessionAs internal
//   SMOKE_ANON_PROBE_PROPERTY      — a real property name (e.g. Miramar)
//   SMOKE_ANON_PROBE_COMPANY       — A1 or Test company name
//   SMOKE_ANON_PROBE_PLATE         — any plate (check just returns status)
//   SMOKE_ANON_PROBE_VIEW_TOKEN    — optional; skip tow smoke if unset
//   SMOKE_ANON_PROBE_PROPOSAL_CODE — optional
//   SMOKE_AUTH_MANAGER_EMAIL       — legacy-manager@test.shieldmylot.com
//                                    or equivalent
//
// ── USAGE ──────────────────────────────────────────────────────────
//   npx tsx --env-file=.env.local scripts/smoke-grant-remediation-post-revoke.ts
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { sessionAs } from './lib/smoke-auth'

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!URL || !ANON || !SERVICE) {
  console.error('❌ missing env: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(2)
}

const GREEN = '\x1b[32m'
const RED   = '\x1b[31m'
const DIM   = '\x1b[2m'
const RESET = '\x1b[0m'

let fails = 0
let criticalFails = 0  // Stage 3 read-smoke failures = tripwire (immediate restore, no diagnosis first)
function ok(msg: string)          { console.log(`${GREEN}✓${RESET} ${msg}`) }
function fail(msg: string)        { console.log(`${RED}✗${RESET} ${msg}`); fails++ }
function failCritical(msg: string) { console.log(`${RED}✗ 🔴 CRITICAL${RESET} ${msg}`); fails++; criticalFails++ }

const anon  = createClient(URL, ANON, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const admin = createClient(URL, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ══════════════════════════════════════════════════════════════════════
// AUTO-PROBE — resolve missing env vars from real Test-LEGACY data.
// Added 2026-07-22 after first re-run failed on env-var mismatches
// (property "Miramar" not in Test-LEGACY, view_token unset, manager
// email unset). Per Mateo: "re-run with real probe values pulled
// from the DB." Service-role query grabs actuals; env-var overrides
// still win if set (operator can force a specific probe).
// ══════════════════════════════════════════════════════════════════════
async function resolveProbes() {
  const TEST_COMPANY = 'Test-LEGACY'  // canonical per project convention (memory + smoke-consent-hard-gate)
  const probes = {
    company:      process.env.SMOKE_ANON_PROBE_COMPANY       ?? TEST_COMPANY,
    property:     process.env.SMOKE_ANON_PROBE_PROPERTY,
    plate:        process.env.SMOKE_ANON_PROBE_PLATE         ?? `FAKEPRB${Date.now() % 100000}`,
    viewToken:    process.env.SMOKE_ANON_PROBE_VIEW_TOKEN,
    proposalCode: process.env.SMOKE_ANON_PROBE_PROPOSAL_CODE,
    managerEmail: process.env.SMOKE_AUTH_MANAGER_EMAIL,
  }

  // Property — pick any live property under Test-LEGACY.
  if (!probes.property) {
    const { data } = await admin.from('properties').select('name').ilike('company', probes.company).limit(1).maybeSingle()
    if (data?.name) probes.property = data.name as string
  }
  // View token — pick any violation with a view_token set. Tow-link is non-negotiable
  // per Mateo — if this returns null, the smoke will still hard-fail Stage 1 tow-link.
  if (!probes.viewToken) {
    const { data } = await admin
      .from('violations')
      .select('view_token')
      .not('view_token', 'is', null)
      .limit(1)
      .maybeSingle()
    if (data?.view_token) probes.viewToken = data.view_token as string
  }
  // Manager email — pick any manager in Test-LEGACY. Auth smokes gate Stage 3/4.
  if (!probes.managerEmail) {
    const { data } = await admin
      .from('user_roles')
      .select('email')
      .eq('role', 'manager')
      .ilike('company', probes.company)
      .limit(1)
      .maybeSingle()
    if (data?.email) probes.managerEmail = data.email as string
  }
  // Proposal code — optional; probe any issued/redeemed under Test-LEGACY.
  if (!probes.proposalCode) {
    const { data: co } = await admin.from('companies').select('id').ilike('name', probes.company).maybeSingle()
    if (co?.id) {
      const { data: pc } = await admin
        .from('proposal_codes')
        .select('code')
        .eq('company_id', co.id)
        .in('status', ['issued', 'redeemed'])
        .limit(1)
        .maybeSingle()
      if (pc?.code) probes.proposalCode = pc.code as string
    }
  }

  return probes
}

async function main() {
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  smoke — grant remediation post-REVOKE gating')
  console.log('══════════════════════════════════════════════════════════════════\n')

  // ── Auto-probe missing env vars from Test-LEGACY ──────────────────
  const p = await resolveProbes()
  console.log(`${DIM}Probe values (auto-resolved from Test-LEGACY where env unset):${RESET}`)
  console.log(`${DIM}  company:      ${p.company}${RESET}`)
  console.log(`${DIM}  property:     ${p.property ?? '(unresolved — Stage 1 property/plate smokes will fail)'}${RESET}`)
  console.log(`${DIM}  plate:        ${p.plate}${RESET}`)
  console.log(`${DIM}  viewToken:    ${p.viewToken ? p.viewToken.slice(0, 12) + '...' : '(unresolved — tow-link smoke will fail)'}${RESET}`)
  console.log(`${DIM}  managerEmail: ${p.managerEmail ?? '(unresolved — Stage 3/4 auth smokes will skip)'}${RESET}`)
  console.log(`${DIM}  proposalCode: ${p.proposalCode ?? '(unresolved — validate_proposal_code will hit invalid path)'}${RESET}`)
  console.log('')

  // ══════════════════════════════════════════════════════════════════
  // STAGE 1 — FUNCTIONAL anon RPC calls (7 preserved RPCs)
  // ══════════════════════════════════════════════════════════════════
  console.log(`${DIM}─── Stage 1: functional anon RPC calls ───${RESET}\n`)

  {
    const { data, error } = await anon.rpc('get_platform_defaults')
    if (error) fail(`get_platform_defaults: ${error.message}`)
    else ok(`get_platform_defaults returned ${data ? Object.keys(data).length + ' keys' : 'null'}`)
  }

  const testProperty = p.property ?? '__no_property_resolved__'
  {
    const { data, error } = await anon.rpc('get_property_for_visitor', { p_name: testProperty })
    if (error) fail(`get_property_for_visitor: ${error.message}`)
    else if (!data || (Array.isArray(data) && data.length === 0)) fail(`get_property_for_visitor empty for "${testProperty}"`)
    else ok(`get_property_for_visitor returned property row for "${testProperty}"`)
  }

  {
    const { data, error } = await anon.rpc('get_company_branding', { p_name: p.company })
    if (error) fail(`get_company_branding: ${error.message}`)
    else ok(`get_company_branding returned row for "${p.company}"`)
  }

  {
    const { data, error } = await anon.rpc('get_properties_for_visitor_select', { p_company: p.company })
    if (error) fail(`get_properties_for_visitor_select: ${error.message}`)
    else if (!data || data.length === 0) fail(`get_properties_for_visitor_select empty for "${p.company}"`)
    else ok(`get_properties_for_visitor_select returned ${data.length} properties`)
  }

  {
    const { data, error } = await anon.rpc('check_resident_plate', { p_plate: p.plate, p_property: testProperty })
    if (error) fail(`check_resident_plate: ${error.message}`)
    else ok(`check_resident_plate returned ${JSON.stringify(data)}`)
  }

  {
    const { data, error } = await anon.rpc('get_plate_pass_status', { p_plate: p.plate, p_property: testProperty })
    if (error) fail(`get_plate_pass_status: ${error.message}`)
    else ok(`get_plate_pass_status returned status`)
  }

  // ── 🔴 TOW LINK — non-negotiable per Mateo ─────────────────────────
  {
    if (!p.viewToken) {
      fail(`SMOKE_ANON_PROBE_VIEW_TOKEN unresolvable (no violations with view_token in DB) — tow-link smoke MANDATORY`)
    } else {
      const { data, error } = await anon.rpc('get_violation_by_view_token', { p_token: p.viewToken })
      if (error) fail(`🔴 TOW LINK BROKEN: get_violation_by_view_token: ${error.message}`)
      else if (!data) fail(`🔴 TOW LINK BROKEN: get_violation_by_view_token returned null`)
      else ok(`🔴 tow link resolved: get_violation_by_view_token returned violation`)
    }
  }

  {
    const testCode = p.proposalCode ?? 'A1-INVALID-PROBE'
    const { data, error } = await anon.rpc('validate_proposal_code', { p_code: testCode })
    if (error) fail(`validate_proposal_code: ${error.message}`)
    else ok(`validate_proposal_code returned ${JSON.stringify(data).slice(0, 80)}`)
  }

  // ══════════════════════════════════════════════════════════════════
  // STAGE 2 — STRUCTURAL anon .from() = permission-denied
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${DIM}─── Stage 2: structural anon .from() denied ───${RESET}\n`)

  for (const tbl of [
    'visitor_passes', 'vehicles', 'violations', 'residents', 'companies',
    'user_roles', 'tos_acceptances', 'audit_logs', 'platform_settings',
    'order_forms', 'provisioning_failures',
  ]) {
    const { data, error } = await anon.from(tbl).select('*').limit(1)
    if (error) {
      if (error.code === '42501' || /permission denied/i.test(error.message)) {
        ok(`anon .from(${tbl}) → permission denied (as expected)`)
      } else {
        fail(`anon .from(${tbl}) unexpected error: ${error.message}`)
      }
    } else if (data && data.length > 0) {
      fail(`🔴 anon .from(${tbl}) returned ${data.length} rows — TABLE GRANT LEAKED`)
    } else {
      fail(`anon .from(${tbl}) returned 0 rows without permission error — grant exists (RLS silent-blocks)`)
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // STAGE 3 — AUTHENTICATED READ smoke (RLS helpers proven)
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${DIM}─── Stage 3: authenticated read smoke ───${RESET}\n`)

  const managerEmail = p.managerEmail
  if (!managerEmail) {
    failCritical(`SMOKE_AUTH_MANAGER_EMAIL unresolvable (no manager in Test-LEGACY user_roles) — auth smokes REQUIRED to prove the RLS-helper tripwire`)
  } else {
    try {
      const session = await sessionAs(managerEmail, { targetEnv: 'test' })
      ok(`sessionAs('${managerEmail}') succeeded — auth path works`)

      // ── STAGE 3 IS THE TRIPWIRE (Mateo 2026-07-22) ─────────────────
      // Load residents queue. Proves get_my_role/get_my_company evaluate
      // + RLS admits + auth SELECT grant intact. Failure here = the
      // 56-policy get_my_role() surface is broken = total authenticated
      // outage. Immediate emergency restore, no diagnosis first.

      const { data, error } = await session.client
        .from('residents')
        .select('id, email')
        .limit(5)
      if (error) failCritical(`residents SELECT as authenticated: ${error.message} — RLS HELPER OUTAGE, PASTE RESTORE NOW`)
      else if (data === null) failCritical(`residents SELECT returned null — RLS HELPER OUTAGE, PASTE RESTORE NOW`)
      else ok(`residents SELECT as authenticated returned ${data.length} rows (RLS scoped)`)

      // Load violations queue too — different RLS policies, exercises
      // get_my_properties via manager scope.
      const { data: vdata, error: verror } = await session.client
        .from('violations')
        .select('id')
        .limit(5)
      if (verror) failCritical(`violations SELECT as authenticated: ${verror.message} — get_my_properties broken, PASTE RESTORE NOW`)
      else ok(`violations SELECT as authenticated returned ${vdata?.length ?? 0} rows`)

      // ══════════════════════════════════════════════════════════════
      // STAGE 4 — AUTHENTICATED WRITE smoke (trigger fires)
      // ══════════════════════════════════════════════════════════════
      console.log(`\n${DIM}─── Stage 4: authenticated write smoke (trigger EXECUTE) ───${RESET}\n`)

      // As authenticated manager, INSERT a visitor pass. This should:
      //   1. Fire enforce_visitor_pass_limit trigger (Category B).
      //   2. Fire enforce_visitor_pass_duration trigger.
      //   3. Fire enforce_visitor_pass_monthly_limit trigger.
      //   4. Succeed (write lands).
      //
      // A trigger missing EXECUTE would throw here despite the row being
      // otherwise valid. Grant-check alone would NOT catch this.

      const probeName = `__probe_grant_smoke_${Date.now()}`
      const probePlate = `TESTPRB${Date.now() % 100000}`

      // Pick a property the manager can write to (per RLS).
      const { data: props } = await session.client
        .from('properties')
        .select('name')
        .limit(1)
      if (!props || props.length === 0) {
        fail(`could not resolve a property for write smoke — skipping trigger smoke`)
      } else {
        const propName = props[0].name as string
        const expiresAt = new Date(Date.now() + 4 * 3600 * 1000).toISOString()  // 4h from now
        const { data: pass, error: passErr } = await session.client
          .from('visitor_passes')
          .insert({
            plate:      probePlate,
            state:      'TX',
            name:       probeName,
            property:   propName,
            expires_at: expiresAt,
          })
          .select('id')
          .single()
        if (passErr) {
          fail(`🔴 visitor_passes INSERT as authenticated (manager): ${passErr.message} — TRIGGER EXECUTE broken?`)
        } else if (pass) {
          ok(`visitor_passes INSERT as authenticated succeeded — triggers fired, write landed (id=${pass.id})`)
          // Clean up via service_role (bypasses RLS)
          await session.admin.from('visitor_passes').delete().eq('id', pass.id)
          ok(`probe visitor_passes row cleaned up`)
        }
      }
    } catch (e) {
      fail(`sessionAs failed: ${(e as Error).message}`)
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // STAGE 5 — SERVICE_ROLE write smoke (retention proof)
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${DIM}─── Stage 5: service_role write smoke ───${RESET}\n`)

  {
    // Reuse the top-level admin client from probe resolution.
    const probeSession = `probe_grant_smoke_${Date.now()}`
    const { data: row, error: insErr } = await admin
      .from('provisioning_failures')
      .insert({
        stripe_session_id:      probeSession,
        requested_company_name: '__probe_service_role_post_revoke__',
        error_message:          'smoke — service_role write after grant remediation',
        error_code:             null,
      })
      .select('id')
      .single()
    if (insErr) {
      fail(`🔴 service_role INSERT into provisioning_failures: ${insErr.message} — SERVICE_ROLE BROKEN`)
    } else if (row) {
      ok(`service_role INSERT succeeded (id=${row.id})`)
      // Clean up
      const { error: delErr } = await admin.from('provisioning_failures').delete().eq('id', row.id)
      if (delErr) fail(`service_role DELETE cleanup: ${delErr.message}`)
      else ok(`service_role DELETE cleanup succeeded`)
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${DIM}══════════════════════════════════════════════════════════════════${RESET}`)
  if (fails === 0) {
    console.log(`${GREEN}✓ ALL SMOKES PASSED${RESET} — grant remediation verified end-to-end.`)
    console.log(`${DIM}  C5 code half unblocked. Migration is done.${RESET}`)
    process.exit(0)
  } else if (criticalFails > 0) {
    // Stage 3 (authenticated READ smoke) failed — the RLS-helper /
    // total-outage tripwire. Per Mateo 2026-07-22: immediate restore,
    // NO diagnosis first. Logged-in access is down.
    console.log(`${RED}🔴 ${criticalFails} CRITICAL SMOKE(S) FAILED — AUTHENTICATED READ PATH DOWN${RESET}`)
    console.log(`${RED}🔴 PASTE scripts/emergency-restore-grants.sql IMMEDIATELY — DO NOT DIAGNOSE FIRST${RESET}`)
    console.log(`${DIM}  Logged-in portals are non-functional. Restore first, investigate after.${RESET}`)
    process.exit(1)
  } else {
    // Non-critical smokes failed (anon or write). Emergency restore
    // still recommended, but lower urgency — public surface only,
    // A1 is the only real data behind these anon surfaces.
    console.log(`${RED}✗ ${fails} SMOKE(S) FAILED${RESET} (non-critical — anon or write path)`)
    console.log(`${RED}🔴 Paste scripts/emergency-restore-grants.sql, then diagnose.${RESET}`)
    console.log(`${DIM}  Lower urgency than a read-smoke failure but still gates C5.${RESET}`)
    process.exit(1)
  }
}

main().catch(e => {
  console.error(`\n${RED}FATAL${RESET}: ${(e as Error).message}`)
  console.error(e)
  console.log(`\n${RED}🔴 PASTE scripts/emergency-restore-grants.sql IF SMOKES DIDN'T EVEN RUN${RESET}`)
  process.exit(2)
})

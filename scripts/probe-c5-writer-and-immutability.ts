#!/usr/bin/env tsx
// ════════════════════════════════════════════════════════════════════
// probe-c5-writer-and-immutability.ts
// ════════════════════════════════════════════════════════════════════
// C5 verify WITHOUT a live checkout. Self-cleaning synthetic snapshot
// + immutability probe. No Stripe API, no checkout, no money.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────
// C5 shipped end-to-end: order_forms schema (20b1462) + writer +
// both webhook callers (90a2179). But the table is EMPTY on prod —
// no provisioning has fired since the writer landed. Jose's previous
// immutability probe (UPDATE ... WHERE id = MIN(id)) returned
// "Success, no rows returned" — which proved nothing, because MIN(id)
// on an empty table is NULL and the UPDATE matched zero rows.
// The claim "RLS blocks it" wasn't tested; the emptiness masked it.
//
// STRIPE_MODE=live blocks the natural verify path — a real proposal-
// code redemption is a real subscription + real charge. Not
// acceptable. And STRIPE_MODE flip is platform-wide on a system with
// a live customer; Jose ruled it out.
//
// This script fills the gap: land a synthetic row via the REAL
// writer, prove the payload assembly + FK resolution + immutability,
// clean up.
//
// ── SAFETY ──────────────────────────────────────────────────────────
// • Test-LEGACY only. Refuses to touch A1 (company_id=91) or any
//   company_env='production' row.
// • FK target is an EXISTING tos_acceptances row (never fabricated).
//   If Test-LEGACY has no SaaS acceptance row, script exits with a
//   clear error — no writes at all.
// • Self-cleaning — deletes the synthetic order_forms row at end
//   (via service_role — the intended write path per DB-enforced
//   immutability model). Deletion is the LAST step; failures earlier
//   leave the row for forensic review + a printed cleanup one-liner.
//
// ── WHAT THIS PROVES vs. DOESN'T ────────────────────────────────────
// The probe IMPORTS AND CALLS the real writeOrderFormSnapshot from
// checkout-session-completed.ts (exported for testability per Mateo
// 2026-07-23 review). Not a re-implementation — the exact function
// the webhook calls.
//
// PROVES:
//   • writeOrderFormSnapshot assembles the payload correctly
//     (FK lookup, stripe_prices JOIN, line_items JSONB build,
//      accepted_at derivation, INSERT — all exercised for real)
//   • Table accepts the writer's output (schema shape OK)
//   • FKs resolve (company_id, saas_acceptance_id)
//   • Immutability: authenticated UPDATE/DELETE fail; service_role UPDATE/DELETE work
//
// DOES NOT PROVE:
//   • That the webhook actually calls the writer at the right moment
//     (covered by source-inspection at handleCheckoutSessionCompleted
//     + handleProposalCodeCompletion, both of which call
//     await writeOrderFormSnapshot(...) at the end)
//   • Real Stripe line-item shape (proven by the FIRST real proposal-
//     code redemption in production — which will write a genuine
//     snapshot at zero extra cost; verify it then, closes C5 fully)
//
// ── USAGE ───────────────────────────────────────────────────────────
// The --require flag loads scripts/_server-only-shim.cjs BEFORE the
// import graph resolves — needed because the probe imports from
// app/lib/stripe-event-handlers/checkout-session-completed.ts which
// starts with `import 'server-only'` (blows up in bare tsx without
// the shim). Established pattern: see provision-b165-test-subs.ts,
// probe-b209-register-vehicle.ts.
//
//   npx tsx --env-file=.env.local \
//     --require ./scripts/_server-only-shim.cjs \
//     scripts/probe-c5-writer-and-immutability.ts
//
// ── ENV ─────────────────────────────────────────────────────────────
//   NEXT_PUBLIC_SUPABASE_URL      — target project
//   NEXT_PUBLIC_SUPABASE_ANON_KEY — for the authenticated-role
//                                   immutability probe (via sessionAs)
//   SUPABASE_SERVICE_ROLE_KEY     — for the writer call + read-back
//                                   + cleanup DELETE
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { sessionAs } from './lib/smoke-auth'
// Import the REAL writer + its arg type. Not a re-implementation.
// checkout-session-completed.ts has `import 'server-only'` at the top —
// the shim below (loaded via tsx.config.json / tsx-side neutralization,
// or by the fallback below) lets scripts require it. If tsx can't
// resolve 'server-only' in the caller graph, the import fails loudly.
import type { WriteOrderFormSnapshotArgs } from '../app/lib/stripe-event-handlers/checkout-session-completed'
import { writeOrderFormSnapshot } from '../app/lib/stripe-event-handlers/checkout-session-completed'

const URL      = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON     = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE  = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!URL || !ANON || !SERVICE) {
  console.error('❌ missing env: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(2)
}

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', RESET = '\x1b[0m'

const TEST_COMPANY_NAME  = 'Test-LEGACY'
const A1_COMPANY_ID_GUARD = 91  // refuse if resolution ever lands on A1

let fails = 0
function ok(msg: string)   { console.log(`${GREEN}✓${RESET} ${msg}`) }
function fail(msg: string) { console.log(`${RED}✗${RESET} ${msg}`); fails++ }

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })

async function main() {
  console.log('══════════════════════════════════════════════════════════════════')
  console.log('  probe — C5 writer + immutability (synthetic, self-cleaning)')
  console.log('══════════════════════════════════════════════════════════════════\n')

  // ── STAGE 1 — Resolve FK target (Test-LEGACY SaaS acceptance) ────
  console.log(`${DIM}─── Stage 1: resolve FK target (Test-LEGACY SaaS row) ───${RESET}\n`)

  const { data: company, error: coErr } = await admin
    .from('companies')
    .select('id, name, company_env')
    .ilike('name', TEST_COMPANY_NAME)
    .maybeSingle()
  if (coErr || !company) {
    fail(`companies lookup failed for '${TEST_COMPANY_NAME}': ${coErr?.message ?? 'no row'}`)
    process.exit(1)
  }
  if (company.id === A1_COMPANY_ID_GUARD) {
    fail(`🔴 CRITICAL: '${TEST_COMPANY_NAME}' resolved to A1 (id=${A1_COMPANY_ID_GUARD}). Refusing.`)
    process.exit(1)
  }
  if (company.company_env === 'production') {
    fail(`🔴 CRITICAL: '${TEST_COMPANY_NAME}' has company_env='production'. Refusing.`)
    process.exit(1)
  }
  ok(`Test-LEGACY company_id=${company.id}, company_env='${company.company_env}'`)

  const { data: saas, error: saasErr } = await admin
    .from('tos_acceptances')
    .select('id, user_id, company_id, document_type, saas_version, reviewed_at, created_at')
    .eq('company_id', company.id)
    .eq('document_type', 'saas')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (saasErr) {
    fail(`tos_acceptances SaaS lookup failed: ${saasErr.message}`)
    process.exit(1)
  }
  if (!saas) {
    fail(`No SaaS tos_acceptances row for Test-LEGACY. Cannot test writer without a real FK target — refusing to fabricate one.`)
    console.log(`\n${YELLOW}Fix:${RESET} redeem a Test-LEGACY proposal code first (creates the SaaS row inline), then re-run this probe.`)
    process.exit(1)
  }
  ok(`FK target: tos_acceptances.id=${saas.id} (saas_version=${saas.saas_version}, reviewed_at=${saas.reviewed_at})`)

  // ── STAGE 2 — Assemble synthetic payload for writer ──────────────
  console.log(`\n${DIM}─── Stage 2: assemble synthetic payload ───${RESET}\n`)

  // Pick 3 real stripe_prices rows to use as line_items input. Use
  // pm_only or enforcement_only (standard catalog). Same shape the
  // webhook's fetchEagerFields would supply.
  const { data: priceRows, error: pxErr } = await admin
    .from('stripe_prices')
    .select('stripe_price_id, line_item, unit_amount_cents, tier_track, tier_name, cycle')
    .eq('tier_name', 'pm_only')
    .eq('cycle', 'monthly')
    .is('proposal_code_id', null)
    .eq('is_active', true)
    .limit(5)
  if (pxErr || !priceRows || priceRows.length === 0) {
    fail(`stripe_prices lookup failed / empty: ${pxErr?.message ?? 'no rows'}`)
    process.exit(1)
  }
  const synthSubItems = priceRows.slice(0, 3).map(r => ({
    stripe_price_id: r.stripe_price_id as string,
    quantity: r.line_item === 'base' ? 1 : r.line_item === 'per_property' ? 2 : 1,
  }))
  ok(`Synthetic subscription_items assembled (${synthSubItems.length} items from stripe_prices)`)

  const synthesizedProbeId = `probe_c5_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  // ── STAGE 3 — Call the REAL writer via import ────────────────────
  console.log(`\n${DIM}─── Stage 3: call writeOrderFormSnapshot (real webhook writer) ───${RESET}\n`)

  // Build the args the webhook's fetchEagerFields would supply. Then
  // hand them to the actual exported writer. This exercises FK lookup,
  // stripe_prices JOIN, line_items JSONB assembly, and accepted_at
  // derivation — all in production code, not re-implemented here.
  const args: WriteOrderFormSnapshotArgs = {
    supabase:               admin,
    companyId:              company.id,
    source:                 'proposal_code',  // Test-LEGACY is a proposal-code company
    intendedTier:           null,  // proposal-code path pulls from proposal_codes row
    stripeCustomerId:       `cus_synthetic_${synthesizedProbeId}`,
    stripeSubscriptionId:   `sub_synthetic_${synthesizedProbeId}`,
    subscriptionItems:      synthSubItems,
    // Look up a Test-LEGACY proposal code (any status; writer reads
    // base_tier + base_tier_type + included_properties/drivers +
    // collection_method from this row).
    proposalCodeId:         await (async () => {
      const { data } = await admin
        .from('proposal_codes')
        .select('id')
        .eq('company_id', company.id)
        .in('status', ['issued', 'redeemed'])
        .limit(1)
        .maybeSingle()
      if (!data?.id) {
        fail(`No Test-LEGACY proposal_codes row found — writer's proposal-code branch needs one for lookup. Redeem/issue a Test-LEGACY code first.`)
        process.exit(1)
      }
      return data.id as number
    })(),
  }

  await writeOrderFormSnapshot(args)
  ok(`writeOrderFormSnapshot returned (fail-open by design — check DB for actual row)`)

  // Read back the row the writer produced. The writer picks up the
  // latest saas_acceptance_id via its own lookup — we don't tell it
  // which row, we assert the one it chose matches Stage 1's target.
  const { data: rows, error: readErr } = await admin
    .from('order_forms')
    .select('id, company_id, saas_acceptance_id, proposal_code_id, source, track, tier, cycle, property_count, driver_count, stripe_customer_id, stripe_subscription_id, currency, line_items, accepted_at, supersedes_order_form_id, created_at')
    .eq('stripe_customer_id', `cus_synthetic_${synthesizedProbeId}`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (readErr) {
    fail(`readback failed: ${readErr.message}`)
    process.exit(1)
  }
  if (!rows) {
    fail(`🔴 writer did not create a row — check console output above for skip-reason (fail-open path may have logged 'no SaaS row' or 'proposal_codes lookup failed')`)
    process.exit(1)
  }
  const ofRow = rows
  const probeRowId = ofRow.id as number
  ok(`Writer landed row: order_forms.id=${probeRowId}`)

  // Print a cleanup one-liner NOW so if any downstream assertion aborts, Jose has it.
  const CLEANUP_SQL = `DELETE FROM public.order_forms WHERE id = ${probeRowId};`
  console.log(`${DIM}  Cleanup (auto-runs at end; paste this if script aborts):${RESET}`)
  console.log(`${DIM}  ${CLEANUP_SQL}${RESET}`)

  // ── STAGE 4 — Assertions on the row the writer produced ─────────
  console.log(`\n${DIM}─── Stage 4: assert row shape (writer's actual output) ───${RESET}\n`)

  // What we KNOW from the args we passed:
  if (ofRow.company_id !== company.id) fail(`company_id mismatch: expected ${company.id}, got ${ofRow.company_id}`)
  else ok(`company_id = ${ofRow.company_id}`)

  if (ofRow.source !== 'proposal_code') fail(`source mismatch: expected 'proposal_code', got '${ofRow.source}'`)
  else ok(`source = 'proposal_code'`)

  if (ofRow.proposal_code_id !== args.proposalCodeId) fail(`proposal_code_id mismatch: expected ${args.proposalCodeId}, got ${ofRow.proposal_code_id}`)
  else ok(`proposal_code_id = ${ofRow.proposal_code_id}`)

  if (ofRow.stripe_customer_id !== args.stripeCustomerId) fail(`stripe_customer_id mismatch`)
  else ok(`stripe_customer_id round-trip OK`)

  if (ofRow.stripe_subscription_id !== args.stripeSubscriptionId) fail(`stripe_subscription_id mismatch`)
  else ok(`stripe_subscription_id round-trip OK`)

  if (ofRow.supersedes_order_form_id !== null) fail(`supersedes_order_form_id should be NULL for first write, got ${ofRow.supersedes_order_form_id}`)
  else ok(`supersedes_order_form_id = NULL (first write)`)

  // What we KNOW the writer looks up via its own logic (not our inputs):
  //   - saas_acceptance_id: writer picks latest tos_acceptances for
  //     (company_id, document_type='saas'). Should equal Stage 1's saas.id.
  if (ofRow.saas_acceptance_id !== saas.id) {
    fail(`saas_acceptance_id mismatch: writer picked ${ofRow.saas_acceptance_id}, Stage 1 latest was ${saas.id} (means writer's SaaS lookup drifted or another SaaS row was inserted between Stage 1 and Stage 3)`)
  } else {
    ok(`saas_acceptance_id = ${ofRow.saas_acceptance_id} — writer's SaaS lookup matches Stage 1 target (FK resolves)`)
  }

  //   - accepted_at: writer sources from saas.reviewed_at (or accepted_at fallback)
  const acceptedAtIso = new Date(ofRow.accepted_at as string).toISOString()
  const saasReviewedIso = new Date(saas.reviewed_at as string).toISOString()
  if (acceptedAtIso !== saasReviewedIso) {
    fail(`accepted_at (${acceptedAtIso}) != saas.reviewed_at (${saasReviewedIso}) — writer's derivation drifted`)
  } else {
    ok(`accepted_at matches saas.reviewed_at (writer's derivation correct)`)
  }

  //   - track/tier/cycle/counts: writer reads from proposal_codes row.
  //     We don't hardcode the expected values (Test-LEGACY's proposal_code
  //     fields are the ground truth — the writer just copies them). Assert
  //     that non-null values landed for the required NOT-NULL columns.
  if (!ofRow.track || !['enforcement','property_management'].includes(ofRow.track as string)) {
    fail(`track invalid: '${ofRow.track}'`)
  } else {
    ok(`track = '${ofRow.track}' (from proposal_codes.base_tier_type)`)
  }
  if (!ofRow.tier) fail(`tier missing`)
  else ok(`tier = '${ofRow.tier}' (from proposal_codes.base_tier)`)
  if (!ofRow.cycle || !['monthly','annual'].includes(ofRow.cycle as string)) {
    fail(`cycle invalid: '${ofRow.cycle}'`)
  } else {
    ok(`cycle = '${ofRow.cycle}' (from writer default 'monthly' — see writer comment re: proposal_codes lacking cycle field)`)
  }

  //   - line_items: writer assembles from subscriptionItems × stripe_prices JOIN.
  //     Assert each input price_id appears in output with correct quantity.
  const savedLineItems = ofRow.line_items as Array<{ line_item: string | null, stripe_price_id: string, quantity: number, unit_amount_cents: number | null, tiers: unknown }>
  if (!Array.isArray(savedLineItems) || savedLineItems.length !== synthSubItems.length) {
    fail(`line_items count mismatch: expected ${synthSubItems.length} (writer's input), got ${savedLineItems?.length ?? 'not-array'}`)
  } else {
    ok(`line_items has ${savedLineItems.length} entries (matches subscriptionItems input count)`)
    for (const input of synthSubItems) {
      const found = savedLineItems.find(li => li.stripe_price_id === input.stripe_price_id)
      if (!found) {
        fail(`  line_items missing entry for input price_id ${input.stripe_price_id}`)
      } else if (found.quantity !== input.quantity) {
        fail(`  line_items[price_id=${input.stripe_price_id}]: quantity expected ${input.quantity}, got ${found.quantity}`)
      } else {
        ok(`  line_items[${input.stripe_price_id}]: quantity=${found.quantity}, line_item='${found.line_item}', unit_amount_cents=${found.unit_amount_cents} (writer's stripe_prices JOIN populated the meta fields)`)
      }
    }
  }

  // ── STAGE 5 — Immutability probe (the assertion never before made) ─
  console.log(`\n${DIM}─── Stage 5: immutability probe (authenticated deny + service_role allow) ───${RESET}\n`)

  // Session as Test-LEGACY CA (any authenticated Test-LEGACY user works).
  const TEST_AUTH_EMAIL = process.env.SMOKE_AUTH_TEST_LEGACY_EMAIL ?? 'legacy-ca@test.shieldmylot.com'
  let sessioned: Awaited<ReturnType<typeof sessionAs>>
  try {
    sessioned = await sessionAs(TEST_AUTH_EMAIL, { targetEnv: 'test' })
    ok(`sessioned as '${TEST_AUTH_EMAIL}' (authenticated)`)
  } catch (e) {
    fail(`sessionAs('${TEST_AUTH_EMAIL}') failed: ${(e as Error).message}`)
    console.log(`\n${YELLOW}Manual cleanup required:${RESET} ${CLEANUP_SQL}\n`)
    process.exit(1)
  }

  // 5a — authenticated UPDATE should fail or affect 0 rows (no UPDATE policy)
  {
    const { data: updData, error: updErr, count } = await sessioned.client
      .from('order_forms')
      .update({ tier: 'tampered' })
      .eq('id', probeRowId)
      .select('id', { count: 'exact' })
    if (updErr) {
      // Some grant setups error with 42501; RLS-deny generally returns empty. Either is "blocked".
      ok(`authenticated UPDATE denied (error: ${updErr.message})`)
    } else if ((count ?? 0) === 0 && (!updData || updData.length === 0)) {
      ok(`authenticated UPDATE affected 0 rows (RLS blocked without erroring — immutability holds)`)
    } else {
      fail(`🔴 IMMUTABILITY BROKEN: authenticated UPDATE affected ${count} row(s), data: ${JSON.stringify(updData)}`)
    }
  }

  // 5b — authenticated DELETE should fail or affect 0 rows
  {
    const { data: delData, error: delErr, count } = await sessioned.client
      .from('order_forms')
      .delete()
      .eq('id', probeRowId)
      .select('id', { count: 'exact' })
    if (delErr) {
      ok(`authenticated DELETE denied (error: ${delErr.message})`)
    } else if ((count ?? 0) === 0 && (!delData || delData.length === 0)) {
      ok(`authenticated DELETE affected 0 rows (RLS blocked — immutability holds)`)
    } else {
      fail(`🔴 IMMUTABILITY BROKEN: authenticated DELETE affected ${count} row(s), data: ${JSON.stringify(delData)}`)
    }
  }

  // 5c — service_role UPDATE MUST succeed (intended write path for future append-with-supersedes)
  {
    const { data: svcUpdData, error: svcUpdErr } = await admin
      .from('order_forms')
      .update({ stripe_customer_id: 'cus_synthetic_svc_role_probe' })
      .eq('id', probeRowId)
      .select('id, stripe_customer_id')
    if (svcUpdErr || !svcUpdData || svcUpdData.length !== 1) {
      fail(`service_role UPDATE failed: ${svcUpdErr?.message ?? 'no row affected'}`)
    } else {
      ok(`service_role UPDATE succeeded (intended write path)`)
    }
  }

  // 5d — Verify tamper attempts left no trace
  {
    const { data: verify } = await admin
      .from('order_forms')
      .select('tier, stripe_customer_id')
      .eq('id', probeRowId)
      .single()
    if (verify?.tier === 'tampered') {
      fail(`🔴 IMMUTABILITY BROKEN: tier column WAS mutated to 'tampered' (RLS did not block)`)
    } else {
      ok(`tier still = '${verify?.tier}' (authenticated UPDATE from 5a produced no persistent change)`)
    }
  }

  // ── STAGE 6 — Cleanup ────────────────────────────────────────────
  console.log(`\n${DIM}─── Stage 6: cleanup ───${RESET}\n`)

  const { error: delFinal, count: delCount } = await admin
    .from('order_forms')
    .delete()
    .eq('id', probeRowId)
    .select('id', { count: 'exact' })
  if (delFinal) {
    fail(`service_role DELETE cleanup failed: ${delFinal.message}`)
    console.log(`${YELLOW}Manual cleanup:${RESET} ${CLEANUP_SQL}`)
  } else if ((delCount ?? 0) !== 1) {
    fail(`cleanup DELETE affected ${delCount} rows (expected 1)`)
    console.log(`${YELLOW}Manual cleanup:${RESET} ${CLEANUP_SQL}`)
  } else {
    ok(`synthetic row deleted (service_role DELETE — 1 row affected)`)
  }

  // ── SUMMARY ──────────────────────────────────────────────────────
  console.log(`\n${DIM}══════════════════════════════════════════════════════════════════${RESET}`)
  if (fails === 0) {
    console.log(`${GREEN}✓ ALL CHECKS PASSED${RESET} — C5 writer payload correct, immutability HOLDS.`)
    console.log(`${DIM}  Remaining verify (out of scope for this script): first real proposal-code`)
    console.log(`${DIM}  redemption in production will land a genuine snapshot — verify then, closes C5 fully.${RESET}`)
    process.exit(0)
  } else {
    console.log(`${RED}✗ ${fails} CHECK(S) FAILED${RESET} — investigate before treating C5 as verified.`)
    console.log(`${YELLOW}Cleanup check:${RESET} synthetic row id=${probeRowId} — run ${CLEANUP_SQL} if not auto-cleaned.`)
    process.exit(1)
  }
}

main().catch(e => {
  console.error(`\n${RED}FATAL${RESET}: ${(e as Error).message}`)
  console.error(e)
  process.exit(2)
})

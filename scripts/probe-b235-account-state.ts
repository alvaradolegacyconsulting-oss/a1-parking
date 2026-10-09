// B235 diagnostic — read-only account_state + webhook trace for the
// smoke user (alvaradolegacyconsulting+a1testrun@gmail.com).
//
// Reports:
//   1. The load-bearing companies row (account_state + Stripe IDs).
//   2. stripe_events history around the cancellation window (if any).
//   3. The user_roles row it maps to (evidence for question 1's SELECT).
//
// Read-only. Zero mutations. Safe under the probe hygiene rule
// ([[feedback_probe_hygiene_rule]]) — SELECTs only.
//
// USAGE:  npx tsx --env-file=.env.local scripts/probe-b235-account-state.ts

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

const TARGET_EMAIL = 'alvaradolegacyconsulting+a1testrun@gmail.com'

async function main() {
  console.log('══ B235 ACCOUNT_STATE PROBE ════════════════════════════════════')
  console.log(`  Target: ${TARGET_EMAIL}\n`)

  // 1. user_roles lookup — need company_id to reach companies.
  const { data: role, error: roleErr } = await admin
    .from('user_roles')
    .select('id, email, company, role')
    .ilike('email', TARGET_EMAIL)
    .maybeSingle()

  if (roleErr) { console.error('user_roles SELECT failed:', roleErr.message); process.exit(2) }
  if (!role) { console.log('🔴 No user_roles row for this email — user may already be deleted.'); process.exit(0) }

  console.log('─── user_roles ─────────────────────────────────────────────────')
  console.log(role)
  console.log('')

  // 2. companies — the load-bearing row (matched by name, since
  // user_roles doesn't carry company_id).
  const { data: co, error: coErr } = await admin
    .from('companies')
    .select('id, name, account_state, subscription_status, past_due_grace_until, suspension_grace_until, stripe_customer_id, stripe_subscription_id, cancel_at_period_end, tier, tier_type')
    .ilike('name', String(role.company ?? ''))
    .maybeSingle()
  if (coErr) { console.error('companies SELECT failed:', coErr.message); process.exit(3) }
  if (!co) { console.log('🔴 No companies row.'); process.exit(0) }

  console.log('─── companies (LOAD-BEARING) ───────────────────────────────────')
  console.log({
    id:                     co.id,
    name:                   co.name,
    tier_type:              co.tier_type,
    tier:                   co.tier,
    account_state:          co.account_state,
    subscription_status:    co.subscription_status,
    cancel_at_period_end:   co.cancel_at_period_end,
    stripe_customer_id:     co.stripe_customer_id,
    stripe_subscription_id: co.stripe_subscription_id,
    past_due_grace_until:   co.past_due_grace_until,
    suspension_grace_until: co.suspension_grace_until,
  })
  console.log('')

  // 3. stripe_events — did any cancel-class event land?
  const { data: events, error: evErr } = await admin
    .from('stripe_events')
    .select('id, event_type, stripe_event_id, processed, process_error, received_at, processed_at')
    .in('event_type', ['customer.subscription.deleted', 'customer.subscription.updated', 'customer.deleted', 'customer.updated', 'invoice.payment_failed'])
    .order('received_at', { ascending: false })
    .limit(20)
  if (evErr) { console.log('stripe_events SELECT failed (table may not exist or column differs):', evErr.message) }
  else {
    console.log(`─── stripe_events (recent cancel-class, up to 20) ──────────────`)
    if (!events || events.length === 0) console.log('  (no rows)')
    else events.forEach(e => console.log(`  ${e.received_at}  ${e.event_type}  processed=${e.processed}  err=${e.process_error ?? ''}  id=${e.stripe_event_id}`))
    console.log('')
  }

  // 4. Verdict.
  console.log('─── VERDICT ────────────────────────────────────────────────────')
  if (co.account_state === 'active') {
    console.log('  🟡 account_state = active → cancellation NEVER PROPAGATED.')
    console.log('     Login gate is behaving correctly for what it believes.')
    console.log('     Real question: did the webhook deliver + process? See stripe_events above.')
  } else if (co.account_state === 'cancelled' || co.account_state === 'canceled') {
    console.log(`  🔴 account_state = ${co.account_state} but Jose sees full dashboard.`)
    console.log('     Front-end gate NOT firing → real B235 gap.')
  } else {
    console.log(`  ⚪ account_state = ${co.account_state} — other state, investigate.`)
  }
}

main().catch(e => { console.error('probe threw:', e); process.exit(99) })

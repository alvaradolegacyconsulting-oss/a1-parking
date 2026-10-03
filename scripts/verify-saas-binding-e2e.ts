// ════════════════════════════════════════════════════════════════════
// GATE — a test-mode signup binds all four consent rows AND writes an
// order-form snapshot. Proven by EXECUTION, not by reading source.
// ════════════════════════════════════════════════════════════════════
//
// 🔴 WHY SOURCE-READING WAS NOT ENOUGH. verify-saas-consent.ts asserts
// that the handler CONTAINS a binding block, and it passed throughout
// the period the binding never once worked: the block filtered on
// session.client_reference_id, which create-checkout-session has never
// set, so the predicate was `user_id = ''`. It matched nothing on every
// run and took the non-fatal warn branch silently. A structural gate
// cannot catch a predicate that is well-formed and wrong.
//
// So this one drives the real thing: a real test-mode Stripe
// subscription, a real auth user, four real unbound acceptance rows,
// and a genuinely SIGNED checkout.session.completed POSTed to the real
// /api/stripe/webhook on a server this script starts itself. Then it
// asks the database what happened.
//
// 🔴 client_reference_id IS DELIBERATELY LEFT NULL on the synthetic
// session — exactly as the real route leaves it. If someone restores
// the old predicate, this gate goes red instead of passing on a
// fixture that was quietly more generous than production.
//
// Usage: npm run build && npx tsx scripts/verify-saas-binding-e2e.ts

import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { spawn } from 'child_process'
import net from 'net'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const KEY = process.env.STRIPE_TEST_SECRET_KEY || g('STRIPE_TEST_SECRET_KEY')
const WH  = process.env.STRIPE_TEST_WEBHOOK_SECRET || g('STRIPE_TEST_WEBHOOK_SECRET')
if (!KEY || !WH) { console.error('need STRIPE_TEST_SECRET_KEY + STRIPE_TEST_WEBHOOK_SECRET'); process.exit(2) }
const stripe = new Stripe(KEY)
const db = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const PORT = 3100
const STAMP = Date.now()
const COMPANY = `ZZ Bind Gate ${STAMP}`
const EMAIL = `zz-bind-gate-${STAMP}@test.invalid`
const DOCS = ['tos', 'privacy', 'texas_attestation', 'saas']

let fails = 0
const chk = (name: string, ok: boolean, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`)
}

const portBusy = (p: number) => new Promise<boolean>(res => {
  const s = net.createServer()
  s.once('error', () => res(true))
  s.once('listening', () => s.close(() => res(false)))
  s.listen(p, '127.0.0.1')
})

const main = async () => {
  // 🔴 Refuse a server we did not start. A leftover one would answer
  // from an old build and report a green run against code not under test.
  if (await portBusy(PORT)) {
    console.error(`port ${PORT} is already in use — refusing. A server this gate did not start is not a pass.`)
    process.exit(2)
  }

  const srv = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    env: { ...process.env, STRIPE_MODE: 'test' },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  srv.stdout.on('data', d => { log += d.toString() })
  srv.stderr.on('data', d => { log += d.toString() })

  let custId: string | null = null
  let subId: string | null = null
  let userId: string | null = null

  try {
    for (let i = 0; i < 60; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/api/stripe/webhook`, { method: 'GET' }); break } catch { await new Promise(r => setTimeout(r, 500)) }
    }

    // ── A real test-mode subscription (Operator Pro, 2 properties) ──
    const { data: prices } = await db.from('stripe_prices')
      .select('line_item, stripe_price_id')
      .eq('tier_track', 'enforcement').eq('tier_name', 'legacy')
      .eq('cycle', 'monthly').eq('mode', 'test')
      .is('proposal_code_id', null).eq('is_active', true)
    const base = prices?.find(p => p.line_item === 'base')?.stripe_price_id as string
    const prop = prices?.find(p => p.line_item === 'per_property')?.stripe_price_id as string
    if (!base || !prop) { console.error('test-mode Operator Pro catalog rows missing'); process.exit(2) }

    const cust = await stripe.customers.create({ name: COMPANY, email: EMAIL })
    custId = cust.id
    const pm = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } })
    await stripe.paymentMethods.attach(pm.id, { customer: cust.id })
    await stripe.customers.update(cust.id, { invoice_settings: { default_payment_method: pm.id } })
    const sub = await stripe.subscriptions.create({
      customer: cust.id,
      items: [{ price: base, quantity: 1 }, { price: prop, quantity: 2 }],
    })
    subId = sub.id

    // ── The auth user the signup flow would have created ──
    const intended = {
      track: 'enforcement', tier: 'legacy', cycle: 'monthly',
      property_count: 2, driver_count: 0, company_name: COMPANY,
    }
    const { data: created, error: cErr } = await db.auth.admin.createUser({
      email: EMAIL, email_confirm: true, password: `Zz!${STAMP}aQ`,
      user_metadata: { intended_tier: intended },
    })
    if (cErr || !created?.user) { console.error('createUser failed:', cErr?.message); process.exit(2) }
    userId = created.user.id

    // ── The four consent rows, UNBOUND, as the real flow writes them ──
    const { error: accErr } = await db.from('tos_acceptances').insert(DOCS.map(d => ({
      user_id: userId, company_id: null, document_type: d,
      tos_version:         d === 'tos' ? '2026-07-12-v2' : null,
      privacy_version:     d === 'privacy' ? '2026-07-12-v2' : null,
      attestation_version: d === 'texas_attestation' ? '2026-05-23-v0' : null,
      saas_version:        d === 'saas' ? '2026-07-10-v1' : null,
      accepted_at: new Date().toISOString(),
    })))
    if (accErr) { console.error('acceptance insert failed:', accErr.message); process.exit(2) }

    // ── The signed webhook, shaped exactly like the real session ──
    const payload = JSON.stringify({
      id: `evt_bindgate_${STAMP}`, object: 'event', type: 'checkout.session.completed',
      api_version: null, created: Math.floor(Date.now() / 1000),
      data: { object: {
        id: `cs_bindgate_${STAMP}`, object: 'checkout.session',
        mode: 'subscription', status: 'complete', payment_status: 'paid',
        customer: cust.id, subscription: sub.id, customer_email: EMAIL,
        // 🔴 null, exactly as production leaves it.
        client_reference_id: null,
        metadata: { supabase_user_id: userId, intended_tier_json: JSON.stringify(intended) },
      } },
    })
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WH })
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stripe/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': header }, body: payload,
    })
    const body = await res.text()
    chk('webhook accepted the signed event', res.ok, `${res.status} ${body.slice(0, 160)}`)

    // ── What actually happened in the database ──
    const { data: co } = await db.from('companies').select('id, name').eq('name', COMPANY).maybeSingle()
    chk('company provisioned', !!co, co ? `id ${co.id}` : 'no company row')
    if (!co) throw new Error('no company — nothing further can be asserted')

    const { data: acc } = await db.from('tos_acceptances')
      .select('id, document_type, company_id').eq('user_id', userId).order('document_type')
    const boundTypes = (acc ?? []).filter(r => r.company_id === co.id).map(r => r.document_type as string).sort()
    for (const d of DOCS) {
      chk(`consent row bound: ${d}`, boundTypes.includes(d),
        boundTypes.includes(d) ? `company_id=${co.id}` : 'still NULL — the webhook did not bind it')
    }

    const { data: of } = await db.from('order_forms')
      .select('id, company_id, saas_acceptance_id').eq('company_id', co.id).maybeSingle()
    chk('order_forms snapshot written', !!of, of ? `id ${of.id}` : 'no snapshot — the SaaS lookup found nothing')
    const saasRow = (acc ?? []).find(r => r.document_type === 'saas')
    chk('snapshot points at the SaaS acceptance row',
      !!of && !!saasRow && of.saas_acceptance_id === saasRow.id,
      of ? `saas_acceptance_id=${of.saas_acceptance_id}, saas row=${saasRow?.id}` : '')

    const { data: ur } = await db.from('user_roles')
      .select('id, saas_accepted_version').ilike('email', EMAIL).maybeSingle()
    chk('user_roles.saas_accepted_version stamped', ur?.saas_accepted_version === '2026-07-10-v1',
      `got ${JSON.stringify(ur?.saas_accepted_version)}`)

    // ── Teardown (DB) ──
    await db.from('order_forms').delete().eq('company_id', co.id)
    await db.from('tos_acceptances').delete().eq('user_id', userId)
    await db.from('user_roles').delete().eq('company', COMPANY)
    await db.from('properties').delete().eq('company', COMPANY)
    await db.from('companies').delete().eq('id', co.id)
  } finally {
    if (userId) await db.auth.admin.deleteUser(userId).catch(() => {})
    if (subId)  await stripe.subscriptions.cancel(subId).catch(() => {})
    if (custId) await stripe.customers.del(custId).catch(() => {})
    try { process.kill(-srv.pid!, 'SIGTERM') } catch { /* already gone */ }
    await new Promise(r => setTimeout(r, 800))
    if (await portBusy(PORT)) console.warn(`⚠️  port ${PORT} still bound after teardown — kill it before the next run`)
  }

  // Residue check: the throwaway must not survive a green run.
  const left = (await db.from('companies').select('*', { count: 'exact', head: true }).eq('name', COMPANY)).count
  chk('throwaway company cleaned up', left === 0, `${left} row(s) left`)

  console.log('')
  if (fails) {
    console.log(`❌ ${fails} FAILURE(S). Consent rows are the evidence trail for a paid subscription.`)
    console.log('--- server log tail ---\n' + log.split('\n').slice(-25).join('\n'))
    process.exit(1)
  }
  console.log('✅ a test-mode signup binds all four consent rows and writes the order-form snapshot.')
}
main().catch(e => { console.error('FATAL', e); process.exit(2) })

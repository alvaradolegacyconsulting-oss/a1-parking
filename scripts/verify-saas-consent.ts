// ════════════════════════════════════════════════════════════════════
// GATE — SaaS acceptance: gated, bound, and stamped
// ════════════════════════════════════════════════════════════════════
//
// The SaaS Agreement IS the subscription contract. Before 2026-10-02 it
// was gated in the UI only — /signup/verify disabled the Continue
// button, but the page submits by programmatic form POST to
// create-checkout-session, so a direct POST skipped it entirely.
//
// Three things must now hold, and this asserts all three:
//   (a) the server gate names 'saas' at the pinned version;
//   (b) a subscriber's SaaS row is BOUND to their company, or the
//       order-form snapshot silently finds nothing;
//   (c) user_roles.saas_accepted_version is stamped, because that is
//       where every other consumer looks.
//
// Usage: npx tsx scripts/verify-saas-consent.ts
import { createClient } from '@supabase/supabase-js'
import { SAAS_VERSION } from '../app/lib/legal-versions'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const db = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

let fails = 0
const chk = (name: string, ok: boolean, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
}

const main = async () => {
  // ── (a) the gate's source, asserted as source ─────────────────────
  // 🔴 Reading the route file. This proves the gate NAMES saas; it does
  // not prove a POST is refused — that needs a cookie-bound session and
  // is Jose's live signup. Said plainly rather than implied.
  const route = fs.readFileSync('app/api/signup/create-checkout-session/route.ts', 'utf8')
  chk('(a) the consent query selects saas rows',
    /\.in\('document_type', \[[^\]]*'saas'[^\]]*\]\)/.test(route))
  chk('(a) it compares against the PINNED SAAS_VERSION',
    /document_type === 'saas' && r\.saas_version === SAAS_VERSION/.test(route))
  chk('(a) a missing saas blocks checkout',
    /!hasTos \|\| !hasPrivacy \|\| !hasTexas \|\| !hasSaas/.test(route))
  chk('(a) and the error names it',
    /missing\.push\('saas_agreement'\)/.test(route))

  // ── (b) + (c) every subscriber, measured ──────────────────────────
  const { data: subs } = await db.from('companies')
    .select('id, name, stripe_subscription_id').not('stripe_subscription_id', 'is', null)
  console.log(`\nsubscribers with a Stripe subscription: ${subs?.length ?? 0}`)
  for (const c of subs ?? []) {
    const { data: row } = await db.from('tos_acceptances')
      .select('id, saas_version').eq('company_id', c.id).eq('document_type', 'saas')
      .order('accepted_at', { ascending: false }).limit(1).maybeSingle()
    chk(`(b) ${String(c.name).padEnd(22)} SaaS row bound to the company`, !!row,
      row ? `id=${row.id} v=${row.saas_version}` : '🔴 the order-form snapshot finds nothing for this company')

    const { data: ca } = await db.from('user_roles')
      .select('email, saas_accepted_version').eq('company', c.name).eq('role', 'company_admin')
    const stamped = (ca ?? []).filter(r => r.saas_accepted_version)
    chk(`(c) ${String(c.name).padEnd(22)} a company_admin carries the version`,
      stamped.length > 0, `${stamped.length} of ${ca?.length ?? 0} stamped`)
  }

  // ── The version the code pins and the data carry must agree ───────
  const { data: anySaas } = await db.from('tos_acceptances')
    .select('saas_version').eq('document_type', 'saas').limit(50)
  const versions = [...new Set((anySaas ?? []).map(r => r.saas_version))]
  chk(`SAAS_VERSION (${SAAS_VERSION}) is a version the data actually carries`,
    versions.includes(SAAS_VERSION), `rows carry: ${versions.join(', ')}`)

  console.log('')
  if (fails) { console.log(`❌ ${fails} FAILURE(S).`); process.exit(1) }
  console.log('✅ SAAS CONSENT: gated at the pinned version, bound to the company, stamped on the role.')
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })

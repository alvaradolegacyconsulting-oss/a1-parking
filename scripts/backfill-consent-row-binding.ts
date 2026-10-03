// ════════════════════════════════════════════════════════════════════
// BACKFILL — bind orphaned tos_acceptances rows to their company
// ════════════════════════════════════════════════════════════════════
//
// WHY THESE ROWS ARE UNBOUND. A self-serve signup writes its consent
// rows before a company exists, so they land with company_id NULL and
// user_id as the only key. The checkout webhook was supposed to bind
// them afterwards, but it filtered on session.client_reference_id —
// which create-checkout-session has never set — so the predicate was
// `user_id = ''` and matched nothing, on every run, silently. Fixed
// 2026-10-03 in checkout-session-completed.ts; this cleans up what the
// broken version left behind.
//
// 🔴 ONLY BINDS WHAT IT CAN PROVE. The company is resolved through the
// user's own role row (user_roles.company -> companies.id). A row whose
// user has no role row, or whose company name does not resolve, is
// LEFT ALONE AND REPORTED. Guessing a company for a consent record
// would fabricate legal evidence, which is worse than leaving a gap
// that is visible.
//
// Idempotent: only touches rows where company_id IS NULL, so a second
// run binds nothing and says so.
//
// Usage: npx tsx scripts/backfill-consent-row-binding.ts [--apply]
//        (default is a DRY RUN — nothing is written without --apply)

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
const db = createClient(g('NEXT_PUBLIC_SUPABASE_URL'), g('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const APPLY = process.argv.includes('--apply')
// Same allowlist the webhook binds. Imported by eye rather than by
// module because the handler is `server-only`; the gate asserts the
// two lists agree.
const BINDABLE = ['tos', 'privacy', 'texas_attestation', 'saas']

type Row = { id: number; user_id: string; document_type: string; accepted_at: string }

const main = async () => {
  console.log(APPLY ? '── APPLYING ──\n' : '── DRY RUN (pass --apply to write) ──\n')

  const { data: rows, error } = await db
    .from('tos_acceptances')
    .select('id, user_id, document_type, accepted_at')
    .is('company_id', null)
    .in('document_type', BINDABLE)
    .order('id')
  if (error) { console.error('read failed:', error.message); process.exit(2) }
  console.log(`unbound rows in scope: ${rows?.length ?? 0}\n`)

  // Resolve each distinct user to a company, once.
  const resolved = new Map<string, { companyId: number | null; why: string; email: string | null }>()
  for (const uid of [...new Set((rows ?? []).map(r => (r as Row).user_id))]) {
    const { data: u } = await db.auth.admin.getUserById(uid)
    const email = u?.user?.email?.toLowerCase() ?? null
    if (!email) { resolved.set(uid, { companyId: null, why: 'auth user no longer exists', email: null }); continue }
    const { data: ur } = await db.from('user_roles').select('company').ilike('email', email)
    const names = [...new Set((ur ?? []).map(r => (r as { company: string }).company).filter(Boolean))]
    if (names.length === 0) { resolved.set(uid, { companyId: null, why: 'no user_roles row — company cannot be proven', email }); continue }
    if (names.length > 1)  { resolved.set(uid, { companyId: null, why: `role rows name ${names.length} companies (${names.join(', ')}) — ambiguous`, email }); continue }
    const { data: co } = await db.from('companies').select('id').eq('name', names[0]).maybeSingle()
    if (!co) { resolved.set(uid, { companyId: null, why: `company "${names[0]}" not in companies`, email }); continue }
    resolved.set(uid, { companyId: co.id as number, why: `via user_roles.company = "${names[0]}"`, email })
  }

  const toBind = (rows ?? []).filter(r => resolved.get((r as Row).user_id)?.companyId != null) as Row[]
  const skipped = (rows ?? []).filter(r => resolved.get((r as Row).user_id)?.companyId == null) as Row[]

  console.log('WILL BIND:')
  for (const r of toBind) {
    const m = resolved.get(r.user_id)!
    console.log(`  ${r.id}  ${r.document_type.padEnd(18)}  ${m.email}  →  company ${m.companyId}  (${m.why})`)
  }
  if (!toBind.length) console.log('  (none)')

  console.log('\nLEFT ALONE — reported, not guessed:')
  for (const r of skipped) {
    const m = resolved.get(r.user_id)!
    console.log(`  ${r.id}  ${r.document_type.padEnd(18)}  ${m.email ?? '(user gone)'}  →  SKIP: ${m.why}`)
  }
  if (!skipped.length) console.log('  (none)')

  if (!APPLY) { console.log('\nDry run — nothing written.'); return }
  if (!toBind.length) { console.log('\nNothing to bind.'); return }

  // ── Write, grouped by company, each UPDATE returning its rows ──
  const byCompany = new Map<number, number[]>()
  for (const r of toBind) {
    const cid = resolved.get(r.user_id)!.companyId!
    byCompany.set(cid, [...(byCompany.get(cid) ?? []), r.id])
  }
  const boundAll: { id: number; document_type: string; company_id: number }[] = []
  for (const [cid, ids] of byCompany) {
    const { data: upd, error: uErr } = await db
      .from('tos_acceptances')
      .update({ company_id: cid })
      .in('id', ids)
      .is('company_id', null)          // re-assert: never overwrite a binding
      .select('id, document_type, company_id')
    if (uErr) { console.error(`\nUPDATE failed for company ${cid}:`, uErr.message); process.exit(2) }
    for (const r of upd ?? []) boundAll.push(r as { id: number; document_type: string; company_id: number })
  }
  console.log(`\nbound: ${boundAll.length}`)
  for (const r of boundAll) console.log(`  ${r.id}  ${r.document_type} → company ${r.company_id}`)

  // ── Audit row ──
  const { error: aErr } = await db.from('audit_logs').insert({
    user_email: null,
    action: 'CONSENT_ROWS_BACKFILL_BOUND',
    table_name: 'tos_acceptances',
    record_id: null,
    old_values: { company_id: null, row_ids: boundAll.map(r => r.id) },
    new_values: { bound: boundAll, skipped: skipped.map(r => ({ id: r.id, document_type: r.document_type, why: resolved.get(r.user_id)!.why })) },
    notes: 'Backfill after the checkout webhook bound consent rows on session.client_reference_id, which create-checkout-session never set — the predicate was user_id = \'\' and matched nothing. Handler fixed 2026-10-03 to key on metadata.supabase_user_id and to bind all four document types. Company resolved via user_roles.company; rows whose company could not be proven were left unbound deliberately.',
  })
  if (aErr) { console.error('audit row insert failed:', aErr.message); process.exit(2) }
  console.log('audit row written (CONSENT_ROWS_BACKFILL_BOUND)')

  // ── Verify after write ──
  const stillUnbound = (await db.from('tos_acceptances')
    .select('*', { count: 'exact', head: true })
    .is('company_id', null).in('document_type', BINDABLE)).count
  console.log(`\nAFTER — unbound rows remaining: ${stillUnbound} (expect ${skipped.length}, the ones with no provable company)`)
  if (stillUnbound !== skipped.length) { console.error('❌ unexpected count'); process.exit(1) }
  console.log('✅ backfill complete')
}
main().catch(e => { console.error('FATAL', e); process.exit(2) })

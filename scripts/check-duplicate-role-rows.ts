// ════════════════════════════════════════════════════════════════════
// STANDING CHECK — no email may hold more than one `user_roles` row
// ════════════════════════════════════════════════════════════════════
//
// Was Block C of the 2026-09-18 catalog pass. Pulled out because it
// needs no catalog access at all — `user_roles` is a plain table in
// `public` and PostgREST reaches it. It should not have been sitting
// behind the SQL editor.
//
// WHY IT MATTERS
// --------------
// get_my_role(), get_my_company() and get_my_properties() are each
// `SELECT … WHERE email … LIMIT 1` with NO ORDER BY. With two rows for
// one email, which row answers is arbitrary — and every company-scoped
// RLS policy in the system reads through those helpers. So a duplicate
// is not a tidy-up item: it makes that person's role resolution a coin
// flip on every request.
//
// 🔴 THE ASYMMETRY THAT MAKES THIS A TRAP
// `residents` has ~25 duplicate-email groups and that is CORRECT BY
// DESIGN — one person can be a resident at several properties, and
// app/resident/page.tsx:259 reads it as an array on purpose. Do not
// "fix" that by analogy with this check. `user_roles` cannot tolerate
// the same shape, and only because of the LIMIT 1 helpers above.
//
// KNOWN MECHANISM
// The /register:310 fallback fires when insert_user_role RAISEs
// `caller_role_not_authorized` — which happens when the registering
// person ALREADY holds a non-resident role — and then inserts a second
// row anyway. That is the path that would make this check trip.
//
// Read-only. Exits 0 clean, 1 on a duplicate, 2 if it could not tell.
// Run: npx tsx scripts/check-duplicate-role-rows.ts
import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'

function serviceClient() {
  const env = fs.readFileSync('.env.local', 'utf8')
  const g = (k: string) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim()
  const url = g('NEXT_PUBLIC_SUPABASE_URL')
  const key = g('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local')
  return createClient(url, key)
}

async function main() {
  let sb
  try { sb = serviceClient() } catch (e: any) {
    // 🔴 Could-not-check must never print as clean. Absence is not the
    // success signal — that is the whole reason this file exists.
    console.error(`⚠️  COULD NOT CHECK — ${e.message}`)
    console.error('    This is NOT a pass. Nothing was verified.')
    process.exit(2)
  }

  const { data, error } = await sb
    .from('user_roles')
    .select('id, email, role, company, property, is_active, created_at')

  if (error) {
    console.error(`⚠️  COULD NOT CHECK — user_roles read failed: ${error.message}`)
    console.error('    This is NOT a pass. Nothing was verified.')
    process.exit(2)
  }
  if (data === null) {
    console.error('⚠️  COULD NOT CHECK — user_roles returned null. This is NOT a pass.')
    process.exit(2)
  }
  // An empty table is not a pass either: user_roles is never legitimately
  // empty, so zero rows means the read was filtered, not that all is well.
  if (data.length === 0) {
    console.error('⚠️  COULD NOT CHECK — user_roles came back empty, which it never legitimately is.')
    console.error('    Most likely the key is not service-role. This is NOT a pass.')
    process.exit(2)
  }

  const groups = new Map<string, typeof data>()
  for (const r of data) {
    const key = (r.email ?? '').trim().toLowerCase()
    if (!key) continue
    groups.set(key, [...(groups.get(key) ?? []), r] as typeof data)
  }
  const dupes = [...groups.entries()].filter(([, rows]) => rows.length > 1)

  console.log(`user_roles rows scanned: ${data.length}   distinct emails: ${groups.size}`)

  if (dupes.length === 0) {
    console.log('✅ CLEAN — no email holds more than one user_roles row.')
    process.exit(0)
  }

  console.log('')
  console.log(`🔴 ${dupes.length} EMAIL(S) HOLD MORE THAN ONE user_roles ROW.`)
  console.log('   Role resolution for these people is arbitrary on every request,')
  console.log('   because get_my_role/company/properties are LIMIT 1 with no ORDER BY.')
  console.log('   This is same-day, not backlog.')
  console.log('')
  for (const [key, rows] of dupes.sort((a, b) => b[1].length - a[1].length)) {
    console.log(`   ${key}  (${rows.length} rows)`)
    for (const r of rows) {
      console.log(`      id=${r.id}  role=${String(r.role).padEnd(14)} company=${JSON.stringify(r.company)}  property=${JSON.stringify(r.property)}  created=${r.created_at}`)
    }
  }
  process.exit(1)
}
main()

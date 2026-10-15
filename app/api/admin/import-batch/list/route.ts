import { NextResponse } from 'next/server'
import { authorizeImportOperator } from '../../../../lib/import-batch-review'

// ════════════════════════════════════════════════════════════════════
// The queue list
// ════════════════════════════════════════════════════════════════════
// ib_admin_select already grants an active admin SELECT on every batch,
// so this needs no new policy. It exists to join the company and
// property names in one call rather than letting the page fan out, and
// to keep the ordering in one place so the list the operator sees is
// the list the queue index is built for.
//
// 🔴 NO RE-VALIDATION HERE. 358 rows through bulk_validate_rows per
// batch would make opening the queue a multi-second operation that
// re-reads every stored file, and the list is a list — the verdict
// belongs to the review screen, where the operator is looking at one
// batch and about to act on it. The list says what the row claims; the
// review screen says what is true now.

export async function GET() {
  const auth = await authorizeImportOperator()
  if (!auth.ok) return NextResponse.json({ error: auth.code, message: auth.message }, { status: auth.status })
  const { db } = auth

  const { data: batches, error } = await db
    .from('import_batches')
    .select('id, company_id, property_id, source_filename, file_sha256, status, resident_count, vehicle_count, attested_name, attested_title, attested_at, created_at, approved_by, approved_at, reject_reason, reject_error_count, loaded_at, loaded_by, loaded_resident_count, loaded_vehicle_count')
    // 🔴 submitted and approved first, both oldest-first inside their
    // group: the queue is a work list, and the batch that has waited
    // longest is the one someone is waiting on.
    .order('created_at', { ascending: true })
  if (error) {
    console.error('[import-batch/list]', error)
    return NextResponse.json({ error: 'list_failed', message: 'Something went wrong loading the queue.' }, { status: 500 })
  }

  const companyIds = [...new Set((batches ?? []).map(b => b.company_id))]
  const propertyIds = [...new Set((batches ?? []).map(b => b.property_id))]
  const [{ data: companies }, { data: properties }] = await Promise.all([
    db.from('companies').select('id, name, is_active, account_state, bulk_onboarding_enabled').in('id', companyIds.length ? companyIds : [-1]),
    db.from('properties').select('id, name, is_active').in('id', propertyIds.length ? propertyIds : [-1]),
  ])
  const coById = new Map((companies ?? []).map(c => [c.id, c]))
  const prById = new Map((properties ?? []).map(p => [p.id, p]))

  const RANK: Record<string, number> = { submitted: 0, approved: 1, rejected: 2, loaded: 3, rolled_back: 4 }
  const rows = (batches ?? []).map(b => {
    const co = coById.get(b.company_id)
    const pr = prById.get(b.property_id)
    return {
      ...b,
      // 🔴 Named, and said so when they could not be resolved. A blank
      // company column would read as "no company" rather than "we
      // could not look it up", and those are different problems.
      company_name: co?.name ?? `(company ${b.company_id} did not resolve)`,
      property_name: pr?.name ?? `(property ${b.property_id} did not resolve)`,
      // Enough for the list to show a blocked badge without re-reading
      // every file. The review screen computes the authoritative set.
      block_hint:
        !co || !pr ? 'references could not be resolved'
        : pr.is_active !== true ? 'property is not active'
        : co.is_active !== true ? 'company is not active'
        : ['suspended', 'cancelled'].includes(String(co.account_state ?? '')) ? `account is ${co.account_state}`
        : co.bulk_onboarding_enabled !== true ? 'bulk onboarding is switched off'
        : null,
    }
  }).sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)
                 || String(a.created_at).localeCompare(String(b.created_at)))

  return NextResponse.json({ ok: true, batches: rows, operator: auth.email })
}

import { NextResponse } from 'next/server'
import { authorizeBulkCompany } from '../../../lib/bulk-onboarding-auth'
import { BULK_BUCKET, BULK_CSV_HEADER, MAX_BULK_BYTES, MAX_BULK_ROWS } from '../../../lib/bulk-onboarding'

// What the upload page needs to render itself, from the SAME gate the
// upload and the submission run.
//
// 🔴 A lookalike check here is worse than no check. If this endpoint
// said "enabled" where authorizeBulkUpload would refuse, the customer
// would get a working-looking form that cannot submit, and the reason
// would be visible to nobody. So it calls authorizeBulkCompany() —
// identical identity, role, is_active, company, account_state and flag
// logic — and the page renders whatever that says.
//
// This is still only the render. The upload is gated by the storage
// policy and the submission re-runs everything.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const auth = await authorizeBulkCompany()
  if (!auth.ok) return NextResponse.json({ error: auth.code, message: auth.message }, { status: auth.status })

  // Only this company's ACTIVE properties. A deactivated property is
  // not a place to put new residents, and may_bulk_upload_at() would
  // refuse it at the bucket anyway — so offering it would be offering
  // a dead end.
  const { data: props, error } = await auth.db
    .from('properties').select('id, name, company, is_active')
  if (error) {
    console.error('[bulk-onboarding/context] properties read:', error)
    return NextResponse.json({ error: 'context_failed', message: 'Something went wrong loading your properties. Please try again.' }, { status: 500 })
  }
  const want = auth.company.name.trim().toLowerCase()
  const properties = (props ?? [])
    .filter(p => p.is_active === true && (p.company ?? '').trim().toLowerCase() === want)
    .map(p => ({ id: p.id as number, name: (p.name ?? '') as string }))
    // Natural order, so "Building 10" sorts after "Building 9" rather
    // than between 1 and 2.
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))

  return NextResponse.json({
    ok: true,
    company: auth.company.name,
    bucket: BULK_BUCKET,
    properties,
    max_rows: MAX_BULK_ROWS,
    max_bytes: MAX_BULK_BYTES,
    header: BULK_CSV_HEADER,
  })
}

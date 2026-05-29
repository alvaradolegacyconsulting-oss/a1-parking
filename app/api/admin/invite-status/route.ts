import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { getActivationStatusByEmail } from '../../../lib/invite-status'

// B144 (folded into B66.5 commit 4.3) — activation status fetcher.
//
// CA portal calls this on driver/resident list mount to render "Invited"
// vs "Active" status badges. Returns a map email → status for the
// requested email list, scoped to the caller's company (cross-company
// emails are rejected as a security guard).
//
// ── REQUEST SHAPE ───────────────────────────────────────────────────
//   POST /api/admin/invite-status
//   Body: { emails: string[] }
//   Response: { statusByEmail: { [email]: 'activated' | 'invited' | 'unknown' } }
//
// ── AUTH + COMPANY SCOPE ────────────────────────────────────────────
//   Caller must be company_admin or admin. For company_admin, all
//   requested emails must belong to users whose user_roles.company
//   matches the caller's company. Cross-company emails reject with 403.
//   For admin, no company-scope restriction (admin can query any).

export const runtime = 'nodejs'

interface RequestBody {
  emails?: unknown
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user?.email) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const { data: callerRoleRow } = await supabase
    .from('user_roles')
    .select('role, company')
    .ilike('email', user.email)
    .single()
  if (!callerRoleRow) {
    return NextResponse.json({ error: 'no role assigned' }, { status: 403 })
  }
  if (callerRoleRow.role !== 'company_admin' && callerRoleRow.role !== 'admin') {
    return NextResponse.json({ error: 'company_admin or admin required' }, { status: 403 })
  }

  let body: RequestBody
  try {
    body = (await req.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!Array.isArray(body.emails)) {
    return NextResponse.json({ error: 'emails must be an array' }, { status: 400 })
  }
  const emails = (body.emails as unknown[])
    .filter((e): e is string => typeof e === 'string')
    .map(e => e.trim().toLowerCase())
    .filter(e => e.length > 0)
  if (emails.length === 0) {
    return NextResponse.json({ statusByEmail: {} })
  }
  if (emails.length > 1000) {
    return NextResponse.json(
      { error: 'too many emails (max 1000 per request)' },
      { status: 400 }
    )
  }

  // Company-scope guard for company_admin role. Cross-company emails
  // reject with 403 — security guard against a CA enumerating activation
  // status across the platform.
  if (callerRoleRow.role === 'company_admin') {
    const { data: roleRows } = await supabase
      .from('user_roles')
      .select('email, company')
      .in('email', emails)
    const callerCompanyLc = callerRoleRow.company?.toLowerCase() ?? ''
    const outOfScope = (roleRows ?? []).filter(
      r => (r.company as string | null)?.toLowerCase() !== callerCompanyLc
    )
    if (outOfScope.length > 0) {
      return NextResponse.json(
        { error: 'some requested emails do not belong to your company' },
        { status: 403 }
      )
    }
  }

  const statusMap = await getActivationStatusByEmail(emails)
  const statusByEmail: Record<string, string> = {}
  for (const [email, status] of statusMap.entries()) {
    statusByEmail[email] = status
  }

  return NextResponse.json({ statusByEmail })
}

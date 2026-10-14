import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { mayToggle, setUserActive, type RoleRow } from '../../../lib/user-active'

// ════════════════════════════════════════════════════════════════════
// Per-user activate / deactivate
// ════════════════════════════════════════════════════════════════════
// The work itself lives in app/lib/user-active.ts, which the property
// cascade also calls. This route is the authorization plus the HTTP
// shape — nothing else, so there is exactly one implementation of
// "revoke a user" and the ban-read-back discipline cannot end up in
// only one of two places.
//
// 🔴 WHY IT EXISTS. Measured 2026-10-15: deactivating a user the old
// way revoked NOTHING at the data layer. The canary kept its session,
// get_my_role() still returned "manager", and it still read residents
// and vehicles through direct PostgREST — the portal gate is
// client-side and is not in that path. A1 had a manager deactivated on
// 2026-08-10 who signed in on 2026-08-21, because the ban was
// best-effort and its failure was audited rather than reported.
//
// 🔴 THE AUTHORIZATION IS A MIRROR. service_role bypasses RLS, so this
// must re-implement exactly what RLS allows or it becomes the
// escalation. Swept by execution with a real company_admin session:
// manager / leasing_agent / driver / resident ALLOWED; company_admin
// and admin refused by WITH CHECK; another company refused by the
// USING filter. Those are two different refusal shapes and this route
// collapses them into one message, because the caller should not learn
// which.

export const runtime = 'nodejs'

const BAD = (status: number, code: string, message: string) =>
  NextResponse.json({ ok: false, error: code, message }, { status })

export async function POST(req: NextRequest) {
  let body: { email?: unknown; active?: unknown }
  try { body = await req.json() } catch { return BAD(400, 'bad_request', 'The request could not be read.') }

  const targetEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (typeof body.active !== 'boolean') return BAD(400, 'bad_request', 'The request could not be read.')
  const active = body.active
  if (!targetEmail) return BAD(400, 'bad_request', 'No user was named.')

  const sb = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser()
  if (authErr || !user?.email) return BAD(401, 'unauthenticated', 'Please sign in again.')

  const db = createSupabaseServiceClient()
  const { data: roleRows, error: roleErr } = await db
    .from('user_roles').select('email, role, company, is_active')
  if (roleErr) {
    console.error('[user-active] user_roles read:', roleErr)
    return BAD(500, 'lookup_failed', 'Something went wrong. Nothing was changed.')
  }
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()
  const rows = (roleRows ?? []) as RoleRow[]
  const caller = rows.find(r => norm(r.email) === norm(user.email) && r.is_active === true)
  if (!caller) return BAD(403, 'no_active_role', 'Your account does not have an active role.')
  if (caller.role !== 'admin' && caller.role !== 'company_admin') {
    return BAD(403, 'not_permitted', 'Only an administrator can change whether a user is active.')
  }

  const targets = rows.filter(r => norm(r.email) === targetEmail)
  if (targets.length === 0) return BAD(404, 'user_not_found', 'That user was not found.')
  if (targets.length > 1) {
    // One email, one role. 0 of 386 addresses violate this today; if one
    // ever does, acting on an arbitrary row is worse than refusing.
    console.error(`[user-active] ${targets.length} user_roles rows for ${targetEmail} — refusing to act on an arbitrary one`)
    return BAD(409, 'ambiguous_user', 'That address has more than one role on file. Support needs to resolve it before it can be changed.')
  }
  if (!mayToggle(caller, targets[0])) {
    return BAD(403, 'not_permitted', 'That user is not one you can change.')
  }

  const r = await setUserActive(db, caller.email, targets[0], active)
  if (!r.ok) return BAD(502, active ? 'unban_failed' : 'ban_failed', r.reason ?? 'Nothing was changed.')

  return NextResponse.json({
    ok: true, changed: r.changed, email: r.email, active,
    ban_applied: r.ban_state,
    driver_row: r.driver_row,
    warning: r.driver_row === 'FAILED'
      ? 'Their access was changed, but the driver record could not be updated — billing counts may be stale until it is reconciled.'
      : undefined,
    message: !r.changed
      ? (active ? 'That user is already active.' : 'That user is already deactivated.')
      : active
        ? 'User reactivated. Their login has been restored.'
        : r.ban_state === 'no_auth_user'
          ? 'User deactivated. They had no login to revoke.'
          : 'User deactivated. Their login has been revoked and existing sessions can no longer be refreshed.',
  })
}

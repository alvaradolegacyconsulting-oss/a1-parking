import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'

// ════════════════════════════════════════════════════════════════════
// Per-user activate / deactivate — Phase B step 2
// ════════════════════════════════════════════════════════════════════
// Replaces four client-side `UPDATE user_roles SET is_active = …`
// writes plus a best-effort edge-function ban, each of which could
// succeed or fail independently with the UI saying "done" either way.
//
// 🔴 WHY THIS ROUTE EXISTS. Measured 2026-10-15: deactivating a user
// the old way revoked NOTHING at the data layer. The canary kept its
// session, get_my_role() still returned "manager", and it still read
// residents and vehicles through direct PostgREST — the portal gate is
// client-side and is not in that path. A1 had a manager deactivated on
// 2026-08-10 who signed in on 2026-08-21, because the ban was
// best-effort and its failure was audited as `ban_applied: false`
// rather than reported. A deactivation that does not revoke is a
// promise the product breaks.
//
// 🔴 A BAN FAILURE IS A FAILURE. Never "done". If the ban cannot be
// applied and verified, this route reverts what it changed and returns
// an error. Same on reactivation, where the failure mode is worse:
// an unban that silently fails leaves a reactivated user locked out
// while the screen says they are back.
//
// ── THE AUTHORIZATION IS A MIRROR, NOT AN INVENTION ─────────────────
// service_role bypasses RLS, so this route must re-implement exactly
// what RLS allows today or it becomes the escalation. Swept by
// execution 2026-10-15 with a real company_admin session:
//
//   target manager / leasing_agent / driver / resident  → ALLOWED
//   target company_admin                                → refused (WITH CHECK)
//   target admin                                        → refused (WITH CHECK)
//   target in another company                           → refused (0 rows)
//
// Those are two different refusal shapes under RLS — a WITH CHECK
// error and a USING filter — and this route collapses them into one
// message, because the caller should not learn which.

export const runtime = 'nodejs'

/** 100 years, in hours. Matches swift-handler's '876600h' exactly, which
 *  is where the existing 2126 banned_until values come from. Go's
 *  time.ParseDuration has no year unit, so '100y' silently no-ops —
 *  that was a real defect here, found 2026-08-29. */
const BAN_DURATION = '876600h'
const UNBAN = 'none'

/** What a company_admin may toggle. Anything else is admin-only. */
const CA_MAY_TOGGLE = ['manager', 'leasing_agent', 'driver', 'resident']

const BAD = (status: number, code: string, message: string, extra: object = {}) =>
  NextResponse.json({ ok: false, error: code, message, ...extra }, { status })

export async function POST(req: NextRequest) {
  let body: { email?: unknown; active?: unknown }
  try { body = await req.json() } catch { return BAD(400, 'bad_request', 'The request could not be read.') }

  const targetEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const active = body.active === true
  if (typeof body.active !== 'boolean') return BAD(400, 'bad_request', 'The request could not be read.')
  if (!targetEmail) return BAD(400, 'bad_request', 'No user was named.')

  // ── 1. who is asking ──────────────────────────────────────────────
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
  const callerEmail = norm(user.email)
  const caller = (roleRows ?? []).find(r => norm(r.email) === callerEmail && r.is_active === true)
  if (!caller) return BAD(403, 'no_active_role', 'Your account does not have an active role.')
  if (caller.role !== 'admin' && caller.role !== 'company_admin') {
    return BAD(403, 'not_permitted', 'Only an administrator can change whether a user is active.')
  }

  // ── 2. the target ─────────────────────────────────────────────────
  const targets = (roleRows ?? []).filter(r => norm(r.email) === targetEmail)
  if (targets.length === 0) return BAD(404, 'user_not_found', 'That user was not found.')
  if (targets.length > 1) {
    // One email, one role. 0 of 386 addresses violate this today; if one
    // ever does, acting on an arbitrary row is worse than refusing.
    console.error(`[user-active] ${targets.length} user_roles rows for ${targetEmail} — refusing to act on an arbitrary one`)
    return BAD(409, 'ambiguous_user', 'That address has more than one role on file. Support needs to resolve it before it can be changed.')
  }
  const target = targets[0]

  // 🔴 One refusal for "not your company" and "too privileged", so the
  // caller cannot use the difference to probe either fact.
  const sameCompany = norm(target.company) === norm(caller.company)
  const permitted = caller.role === 'admin'
    || (sameCompany && CA_MAY_TOGGLE.includes(String(target.role)))
  if (!permitted) return BAD(403, 'not_permitted', 'That user is not one you can change.')

  if (target.is_active === active) {
    // Not an error, and not a silent success either — say which.
    return NextResponse.json({
      ok: true, changed: false, email: targetEmail, active,
      message: active ? 'That user is already active.' : 'That user is already deactivated.',
    })
  }

  // ── 3. the auth user, via the DETERMINISTIC lookup ────────────────
  // 🔴 get_auth_user_id_by_email, not admin.listUsers(). listUsers
  // defaults to perPage:50 ordered created_at DESC, which left 73% of
  // auth.users unreachable and reported "User not found" for users that
  // plainly existed — the 2026-08-10 A1 failure. An error from this RPC
  // is NOT "no such user": collapsing those is how that month of
  // misleading 404s happened.
  const look = await db.rpc('get_auth_user_id_by_email', { p_email: targetEmail })
  if (look.error) {
    console.error('[user-active] get_auth_user_id_by_email failed:', look.error)
    return BAD(500, 'lookup_failed', 'We could not check that user\'s login. Nothing was changed.')
  }
  const uid = look.data as string | null

  // ── 4. the login half FIRST, because it is the safety-critical one ─
  let banState: string
  let priorBan: string | null = null
  if (!uid) {
    // Nothing to ban: the address has no login. That is a real state,
    // reported as itself rather than as a failure or as a success.
    banState = 'no_auth_user'
  } else {
    const before = await db.auth.admin.getUserById(uid)
    priorBan = (before.data?.user as { banned_until?: string } | undefined)?.banned_until ?? null

    const upd = await db.auth.admin.updateUserById(uid, { ban_duration: active ? UNBAN : BAN_DURATION })
    if (upd.error) {
      console.error(`[user-active] ${active ? 'unban' : 'ban'} failed for ${targetEmail}:`, upd.error)
      await audit(db, caller.email as string, targetEmail, active, false, 'update_failed: ' + upd.error.message, null)
      return BAD(502, active ? 'unban_failed' : 'ban_failed', active
        ? 'We could not restore that user\'s login, so nothing was changed. Please try again.'
        : 'We could not revoke that user\'s login, so nothing was changed — they would still have had access. Please try again.')
    }

    // 🔴 READ IT BACK. "We asked" is not "it is set", and the whole
    // reason this route exists is a ban that was asked for and never
    // applied.
    const after = await db.auth.admin.getUserById(uid)
    const nowBan = (after.data?.user as { banned_until?: string } | undefined)?.banned_until ?? null
    const bannedNow = nowBan !== null && new Date(nowBan).getTime() > Date.now()
    if (active === bannedNow) {
      console.error(`[user-active] ban read-back disagrees for ${targetEmail}: wanted ${active ? 'unbanned' : 'banned'}, read ${JSON.stringify(nowBan)}`)
      await audit(db, caller.email as string, targetEmail, active, false, `read_back_mismatch: ${JSON.stringify(nowBan)}`, null)
      return BAD(502, active ? 'unban_failed' : 'ban_failed', active
        ? 'We could not confirm that user\'s login was restored, so nothing was changed.'
        : 'We could not confirm that user\'s login was revoked, so nothing was changed.')
    }
    banState = active ? 'unbanned' : `banned_until ${nowBan}`
    // A ban also refuses a refresh ("Invalid Refresh Token: User
    // Banned", measured), so no separate token revocation is needed.
    // 🔴 It does NOT revoke an access token already issued: a raw
    // bearer kept returning 200 for its full 60-minute life. That
    // residual window is what the get_my_role() is_active term closes.
  }

  // ── 5. the record half, and revert the login half if it fails ─────
  const flip = await db.from('user_roles')
    .update({ is_active: active }).eq('email', target.email as string).select('email, is_active')
  const flipped = (flip.data ?? []).length === 1 && flip.data![0].is_active === active
  if (flip.error || !flipped) {
    console.error(`[user-active] is_active flip failed for ${targetEmail}:`, flip.error ?? flip.data)
    let reverted = 'n/a'
    if (uid) {
      // Put the login back exactly as it was, so the system is never
      // left in a state nobody chose.
      const back = await db.auth.admin.updateUserById(uid, {
        ban_duration: priorBan && new Date(priorBan).getTime() > Date.now() ? BAN_DURATION : UNBAN,
      })
      reverted = back.error ? 'FAILED' : 'ok'
      if (back.error) console.error(`[user-active] 🔴 could not revert the login for ${targetEmail}:`, back.error)
    }
    await audit(db, caller.email as string, targetEmail, active, false,
      `is_active flip failed: ${flip.error?.message ?? 'no row updated'}; login revert ${reverted}`, null)
    return BAD(500, 'change_failed', reverted === 'FAILED'
      ? 'Something went wrong and we could not fully undo it. Please contact support before trying again.'
      : 'Something went wrong and nothing was changed. Please try again.')
  }

  // ── 5b. the drivers row, for a driver target ──────────────────────
  // The CA driver toggle flips drivers.is_active alongside the role
  // row, because that column feeds the driver cap and the billing
  // counters. Absorbing it here keeps the whole operation in one
  // place; it is the same write the client was already making, not a
  // new rule.
  //
  // Reported separately rather than folded into success: a driver
  // gated out of their login but still counted is a billing question,
  // not an access one, and the two should not share a word.
  let driverRow = 'n/a'
  if (target.role === 'driver') {
    const dv = await db.from('drivers')
      .update({ is_active: active }).ilike('email', target.email as string).select('id, is_active')
    if (dv.error || (dv.data ?? []).length === 0) {
      driverRow = 'FAILED'
      console.error(`[user-active] drivers.is_active write failed for ${targetEmail} (the access change already applied):`, dv.error ?? 'no row matched')
    } else {
      driverRow = `${(dv.data ?? []).length} row(s)`
    }
  }

  await audit(db, caller.email as string, targetEmail, active, true, null, banState, driverRow)

  return NextResponse.json({
    ok: true, changed: true, email: targetEmail, active,
    ban_applied: banState,
    driver_row: driverRow,
    warning: driverRow === 'FAILED'
      ? 'Their access was changed, but the driver record could not be updated — billing counts may be stale until it is reconciled.'
      : undefined,
    message: active
      ? 'User reactivated. Their login has been restored.'
      : banState === 'no_auth_user'
        ? 'User deactivated. They had no login to revoke.'
        : 'User deactivated. Their login has been revoked and existing sessions can no longer be refreshed.',
  })
}

/** 🔴 ban_applied is recorded as what HAPPENED, and a failure is audited
 *  as a failure. The old path audited `ban_applied: false` next to a UI
 *  that said "done", which is how a deactivated manager kept a working
 *  login for eleven days. */
async function audit(
  db: ReturnType<typeof createSupabaseServiceClient>,
  actor: string, targetEmail: string, active: boolean,
  succeeded: boolean, failure: string | null, banState: string | null,
  driverRow = 'n/a',
) {
  const r = await db.from('audit_logs').insert({
    user_email: actor.toLowerCase(),
    action: active ? 'USER_REACTIVATED' : 'USER_DEACTIVATED',
    table_name: 'user_roles',
    record_id: targetEmail,
    new_values: {
      email: targetEmail, is_active: active,
      // ban_applied is kept because the Aug 5-8 remediation query greps
      // it; `outcome` is the forward-looking discriminant and carries
      // the partial case, which a boolean cannot.
      ban_applied: succeeded, ban_state: banState, driver_row: driverRow, failure,
      outcome: succeeded ? (driverRow === 'FAILED' ? 'ok_driver_row_failed' : 'ok') : 'failed',
    },
    notes: succeeded
      ? `${actor} ${active ? 'reactivated' : 'deactivated'} ${targetEmail}; login ${banState}`
      : `🔴 ${actor} attempted to ${active ? 'reactivate' : 'deactivate'} ${targetEmail} and it FAILED: ${failure}. Nothing was reported as done.`,
  })
  if (r.error) console.error('[user-active] audit insert failed:', r.error)
}

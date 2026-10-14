import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

// ════════════════════════════════════════════════════════════════════
// Deactivating / reactivating ONE user — the only implementation
// ════════════════════════════════════════════════════════════════════
// Extracted from /api/admin/user-active so the property cascade calls
// THIS rather than a second copy.
//
// 🔴 WHY ONE COPY MATTERS HERE SPECIFICALLY. The discipline that makes
// this correct — ban FIRST, read the ban BACK, revert the is_active
// flip if the ban cannot be confirmed, never report success it did not
// achieve — is the whole fix. A cascade that re-implemented it would
// get the easy half (flip the flag) and quietly lose the hard half,
// which is exactly how an A1 manager deactivated on 2026-08-10 signed
// in on 2026-08-21.
//
// It returns a RESULT, not an HTTP response, because the cascade needs
// one of these per user in a list and an HTTP response cannot be an
// element of a list.

/** 100 years in hours. Matches swift-handler's '876600h', which is
 *  where the existing 2126 banned_until values come from. Go's
 *  time.ParseDuration has no year unit, so '100y' silently no-ops. */
export const BAN_DURATION = '876600h'
export const UNBAN = 'none'

/** What a company_admin may toggle. Mirrors RLS, swept by execution
 *  2026-10-15: these four are ALLOWED, company_admin and admin are
 *  refused by WITH CHECK, another company by the USING filter. */
export const CA_MAY_TOGGLE = ['manager', 'leasing_agent', 'driver', 'resident'] as const

export interface RoleRow {
  email: string
  role: string
  company: string | null
  is_active: boolean | null
}

/**
 * May this caller change this target?
 *
 * 🔴 A MIRROR, NOT AN INVENTION. These functions run as service_role,
 * which bypasses RLS, so they must re-implement exactly what RLS
 * allows or they BECOME the escalation.
 */
export function mayToggle(caller: RoleRow, target: RoleRow): boolean {
  if (caller.role === 'admin') return true
  if (caller.role !== 'company_admin') return false
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()
  return norm(caller.company) === norm(target.company)
    && (CA_MAY_TOGGLE as readonly string[]).includes(target.role)
}

/**
 * The auth user id, via the DETERMINISTIC lookup.
 *
 * 🔴 NEVER admin.listUsers(). It defaults to perPage:50 ordered
 * created_at DESC, which left 73% of auth.users unreachable and
 * reported "User not found" for users that plainly existed — the
 * 2026-08-10 A1 failure. A lookup ERROR is not "no such user", and
 * collapsing the two is what produced a month of misleading 404s, so
 * this returns a discriminated result instead of a nullable id.
 */
export async function resolveAuthUserId(
  db: SupabaseClient, email: string,
): Promise<{ ok: true; uid: string | null } | { ok: false; error: string }> {
  const r = await db.rpc('get_auth_user_id_by_email', { p_email: email })
  if (r.error) return { ok: false, error: r.error.message }
  return { ok: true, uid: (r.data as string | null) ?? null }
}

export interface UserActiveResult {
  email: string
  ok: boolean
  /** false when the user was already in the requested state. */
  changed: boolean
  /** 'banned_until …' | 'unbanned' | 'no_auth_user' */
  ban_state: string
  /** row count, 'n/a' for a non-driver, or 'FAILED' */
  driver_row: string
  /** Present only when ok === false. User-facing, never a raw error. */
  reason?: string
}

/** Stamp written when a cascade is the actor, so the reverse can act
 *  only on its own work (sweep class 15). */
export interface CascadeStamp { propertyId: number; runId: string }

/**
 * Set one user active or inactive, all-or-report.
 *
 * Order is deliberate: the LOGIN first, because that is the
 * safety-critical half, then the record. If the record write fails the
 * login is put back exactly as it was, so the system is never left in a
 * state nobody chose.
 */
export async function setUserActive(
  db: SupabaseClient,
  actorEmail: string,
  target: RoleRow,
  active: boolean,
  stamp: CascadeStamp | null = null,
): Promise<UserActiveResult> {
  const email = target.email.trim().toLowerCase()

  if (target.is_active === active) {
    return { email, ok: true, changed: false, ban_state: 'unchanged', driver_row: 'n/a' }
  }

  // ── the login half ──────────────────────────────────────────────
  const look = await resolveAuthUserId(db, email)
  if (!look.ok) {
    console.error(`[user-active] lookup failed for ${email}:`, look.error)
    await audit(db, actorEmail, email, active, false, `lookup_failed: ${look.error}`, null, 'n/a', stamp)
    return { email, ok: false, changed: false, ban_state: 'unknown', driver_row: 'n/a',
             reason: 'We could not check that user\'s login, so nothing was changed.' }
  }

  let banState: string
  let priorBan: string | null = null
  if (!look.uid) {
    // A real state, reported as itself. Not a failure, not a ban.
    banState = 'no_auth_user'
  } else {
    const before = await db.auth.admin.getUserById(look.uid)
    priorBan = (before.data?.user as { banned_until?: string } | undefined)?.banned_until ?? null

    const upd = await db.auth.admin.updateUserById(look.uid, { ban_duration: active ? UNBAN : BAN_DURATION })
    if (upd.error) {
      console.error(`[user-active] ${active ? 'unban' : 'ban'} failed for ${email}:`, upd.error)
      await audit(db, actorEmail, email, active, false, `update_failed: ${upd.error.message}`, null, 'n/a', stamp)
      return { email, ok: false, changed: false, ban_state: 'unchanged', driver_row: 'n/a',
               reason: active
                 ? 'We could not restore that user\'s login, so nothing was changed.'
                 : 'We could not revoke that user\'s login, so nothing was changed — they would still have had access.' }
    }

    // 🔴 READ IT BACK. "We asked" is not "it is set", and an
    // unverified ban is the entire defect this replaces.
    const after = await db.auth.admin.getUserById(look.uid)
    const nowBan = (after.data?.user as { banned_until?: string } | undefined)?.banned_until ?? null
    const bannedNow = nowBan !== null && new Date(nowBan).getTime() > Date.now()
    if (active === bannedNow) {
      console.error(`[user-active] ban read-back disagrees for ${email}: wanted ${active ? 'unbanned' : 'banned'}, read ${JSON.stringify(nowBan)}`)
      await audit(db, actorEmail, email, active, false, `read_back_mismatch: ${JSON.stringify(nowBan)}`, null, 'n/a', stamp)
      return { email, ok: false, changed: false, ban_state: 'unverified', driver_row: 'n/a',
               reason: active
                 ? 'We could not confirm that user\'s login was restored, so nothing was changed.'
                 : 'We could not confirm that user\'s login was revoked, so nothing was changed.' }
    }
    banState = active ? 'unbanned' : `banned_until ${nowBan}`
    // A ban also refuses a refresh ("Invalid Refresh Token: User
    // Banned", measured), so no separate token revocation is needed.
    // It does NOT revoke an already-issued access token — that window
    // is closed by get_my_role()'s is_active term (step 3).
  }

  // ── the record half, with the cascade stamp ─────────────────────
  // Deactivating stamps provenance; reactivating CLEARS it, because a
  // restored user is no longer owed to any cascade and a stale stamp
  // would make the next reactivation of that property restore them
  // again.
  // 🔴 THE STAMP COLUMNS ARE TOUCHED ONLY WHEN A CASCADE IS THE ACTOR.
  // The first version cleared them on EVERY reactivation, which made
  // this module depend on wip-20261015_cascade_stamps.sql — and
  // /api/admin/user-active is already live and wired to two client
  // sites, so until that migration landed every flip failed on "column
  // does not exist", reverted the ban, and correctly reported failure.
  // The gate caught it on the first run after the extraction.
  //
  // So: a cascade writes its provenance and clears it; an individual
  // toggle does not touch those columns at all, which keeps the live
  // route byte-identical to before the extraction and free of the
  // ordering dependency.
  //
  // The one consequence, stated rather than hidden: an INDIVIDUAL
  // reactivation leaves a cascade stamp in place. That is harmless —
  // the cascade's restore predicate also requires is_active = false, so
  // a stamped-but-active user is skipped, and setUserActive reports
  // changed:false for them rather than acting.
  const patch: Record<string, unknown> = { is_active: active }
  if (stamp) {
    patch.cascade_deactivated_by_property = active ? null : stamp.propertyId
    patch.cascade_deactivated_run = active ? null : stamp.runId
    patch.cascade_deactivated_at = active ? null : new Date().toISOString()
  }

  const flip = await db.from('user_roles').update(patch).eq('email', target.email).select('email, is_active')
  const flipped = (flip.data ?? []).length === 1 && flip.data![0].is_active === active
  if (flip.error || !flipped) {
    console.error(`[user-active] is_active flip failed for ${email}:`, flip.error ?? flip.data)
    let reverted = 'n/a'
    if (look.uid) {
      const back = await db.auth.admin.updateUserById(look.uid, {
        ban_duration: priorBan && new Date(priorBan).getTime() > Date.now() ? BAN_DURATION : UNBAN,
      })
      reverted = back.error ? 'FAILED' : 'ok'
      if (back.error) console.error(`[user-active] 🔴 could not revert the login for ${email}:`, back.error)
    }
    await audit(db, actorEmail, email, active, false,
      `is_active flip failed: ${flip.error?.message ?? 'no row updated'}; login revert ${reverted}`, null, 'n/a', stamp)
    return { email, ok: false, changed: false, ban_state: reverted === 'FAILED' ? 'INCONSISTENT' : 'unchanged', driver_row: 'n/a',
             reason: reverted === 'FAILED'
               ? 'Something went wrong and we could not fully undo it. Contact support before trying again.'
               : 'Something went wrong and nothing was changed.' }
  }

  // ── the drivers row, reported separately ───────────────────────
  // It feeds the driver cap and the billing counters. A driver gated
  // out of their login but still COUNTED is a billing question, not an
  // access one, and the two must not share a word.
  let driverRow = 'n/a'
  if (target.role === 'driver') {
    const dv = await db.from('drivers').update({ is_active: active }).ilike('email', target.email).select('id')
    if (dv.error || (dv.data ?? []).length === 0) {
      driverRow = 'FAILED'
      console.error(`[user-active] drivers.is_active write failed for ${email} (the access change already applied):`, dv.error ?? 'no row matched')
    } else {
      driverRow = `${(dv.data ?? []).length} row(s)`
    }
  }

  await audit(db, actorEmail, email, active, true, null, banState, driverRow, stamp)
  return { email, ok: true, changed: true, ban_state: banState, driver_row: driverRow }
}

/** 🔴 ban_applied records what HAPPENED. The old path audited
 *  ban_applied:false beside a UI that said "done", which is how a
 *  deactivated manager kept a working login for eleven days. */
async function audit(
  db: SupabaseClient, actor: string, targetEmail: string, active: boolean,
  succeeded: boolean, failure: string | null, banState: string | null,
  driverRow = 'n/a', stamp: CascadeStamp | null = null,
) {
  const r = await db.from('audit_logs').insert({
    user_email: actor.toLowerCase(),
    action: active ? 'USER_REACTIVATED' : 'USER_DEACTIVATED',
    table_name: 'user_roles',
    record_id: targetEmail,
    new_values: {
      email: targetEmail, is_active: active,
      ban_applied: succeeded, ban_state: banState, driver_row: driverRow, failure,
      outcome: succeeded ? (driverRow === 'FAILED' ? 'ok_driver_row_failed' : 'ok') : 'failed',
      // Present only for a cascade, so an individual deactivation and a
      // cascade one are distinguishable in the log as well as in the row.
      cascade_property_id: stamp?.propertyId ?? null,
      cascade_run: stamp?.runId ?? null,
    },
    notes: succeeded
      ? `${actor} ${active ? 'reactivated' : 'deactivated'} ${targetEmail}${stamp ? ` via the property-${stamp.propertyId} cascade (run ${stamp.runId})` : ''}; login ${banState}`
      : `🔴 ${actor} attempted to ${active ? 'reactivate' : 'deactivate'} ${targetEmail} and it FAILED: ${failure}. Nothing was reported as done.`,
  })
  if (r.error) console.error('[user-active] audit insert failed:', r.error)
}

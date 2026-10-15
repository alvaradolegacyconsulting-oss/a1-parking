import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseServerClient } from '../../../lib/server-auth'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { setUserActive, type RoleRow } from '../../../lib/user-active'

// ════════════════════════════════════════════════════════════════════
// Property deactivate / reactivate cascade
// ════════════════════════════════════════════════════════════════════
// One implementation for BOTH portals. /admin may act on any property;
// a company_admin only on their own company's. The per-user work is
// setUserActive() from app/lib/user-active.ts — the same function the
// individual toggle uses, so the ban-then-read-back discipline cannot
// exist in only one of the two.
//
// ── MODES ───────────────────────────────────────────────────────────
//   mode:'plan'   read-only. Returns the PLAN: every affected user with
//                 the action they will get and why. The operator
//                 confirms this list.
//   mode:'apply'  streams NDJSON, one line per user as it completes,
//                 then the data counts, then a final verdict.
//
// 🔴 THE OPERATOR CONFIRMS A LIST, NOT A COUNT. The old dialog said
// "N accounts affected", and N came from the same filter that carried
// Finding B — so the number was wrong in exactly the cases that
// mattered. A list of names with per-user actions cannot be wrong in a
// way nobody sees.
//
// 🔴 NO ROLLBACK ACROSS USERS. Auth is not transactional. Pretending
// otherwise would mean un-banning users who were correctly banned
// because a later one failed. A partial outcome is a real outcome; the
// job is to report it precisely, which is what the result list and the
// retry set are for. `ok` is true only when every user succeeded.
//
// 🔴 SEQUENTIAL, not Promise.all. It is kind to the auth admin rate
// limits, it makes the audit order match the result order, and a
// 40-user property finishes in under a minute. Bounded parallelism is
// a later question if a real run is slow.

export const runtime = 'nodejs'
export const maxDuration = 300

const STAFF_ROLES = ['manager', 'leasing_agent'] as const
const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()

type Action = 'revoke' | 'restore' | 'keep' | 'skip'
interface PlanRow {
  email: string
  /** 🔴 The email AS STORED, for the write.
   *
   * `email` above is normalized for display and comparison, but
   * user_roles.email is NOT stored lowercased — uniqueness is a
   * lower(email) expression index only (noted in get_my_role's own
   * history). setUserActive writes with .eq('email', …), so handing it
   * the normalized value would match zero rows for any mixed-case
   * address and report that user as failed. It would fail closed and
   * loudly rather than silently, but it would still be wrong. */
  raw_email: string
  role: string
  action: Action
  reason: string
  has_login: boolean
  other_active_properties: string[]
}

interface Ctx {
  db: SupabaseClient
  actor: string
  property: { id: number; name: string; company: string; is_active: boolean }
  plan: PlanRow[]
  residents: number
  vehicles: number
}

/** Authorize, resolve the property, and build the plan. No writes. */
async function prepare(
  propertyId: number, active: boolean, onlyEmails: string[] | null,
): Promise<{ ok: true; ctx: Ctx } | { ok: false; status: number; code: string; message: string }> {
  const sb = await createSupabaseServerClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser()
  if (authErr || !user?.email) return { ok: false, status: 401, code: 'unauthenticated', message: 'Please sign in again.' }

  const db = createSupabaseServiceClient()
  const { data: roleRows, error: roleErr } = await db
    .from('user_roles')
    .select('email, role, company, property, is_active, cascade_deactivated_by_property')
  if (roleErr) {
    console.error('[property-active] user_roles read:', roleErr)
    return { ok: false, status: 500, code: 'lookup_failed', message: 'Something went wrong. Nothing was changed.' }
  }
  const rows = (roleRows ?? []) as (RoleRow & { property: string[] | null; cascade_deactivated_by_property: number | null })[]
  const caller = rows.find(r => norm(r.email) === norm(user.email) && r.is_active === true)
  if (!caller) return { ok: false, status: 403, code: 'no_active_role', message: 'Your account does not have an active role.' }
  if (caller.role !== 'admin' && caller.role !== 'company_admin') {
    return { ok: false, status: 403, code: 'not_permitted', message: 'Only an administrator can change a property.' }
  }

  const { data: props, error: propErr } = await db
    .from('properties').select('id, name, company, is_active')
  if (propErr) {
    console.error('[property-active] properties read:', propErr)
    return { ok: false, status: 500, code: 'lookup_failed', message: 'Something went wrong. Nothing was changed.' }
  }
  const all = (props ?? []) as { id: number; name: string; company: string; is_active: boolean }[]
  const property = all.find(p => p.id === propertyId)
  // 🔴 One refusal for "no such property" and "not your company", so a
  // CA cannot use the difference to learn which property ids exist.
  if (!property || (caller.role === 'company_admin' && norm(property.company) !== norm(caller.company))) {
    return { ok: false, status: 403, code: 'property_not_in_scope', message: 'That property is not one you can change.' }
  }

  // 🔴 FINDING B. "No other property" must mean "no other ACTIVE
  // property". The old filter compared array length only, while its own
  // comment said "no other active properties" — so a manager assigned
  // to [X, Y] where Y was already deactivated kept their login when X
  // went down, with zero active properties left.
  const activeNames = new Set(all.filter(p => p.is_active).map(p => norm(p.name)))
  const assigned = rows.filter(r =>
    (STAFF_ROLES as readonly string[]).includes(r.role)
    && (r.property ?? []).some(n => norm(n) === norm(property.name)))

  const plan: PlanRow[] = []
  for (const r of assigned) {
    if (onlyEmails && !onlyEmails.includes(norm(r.email))) continue
    const others = (r.property ?? []).filter(n => norm(n) !== norm(property.name))
    // When deactivating, THIS property is about to stop being active,
    // so it is excluded from the "still has somewhere active" test.
    const otherActive = others.filter(n => activeNames.has(norm(n)))
    const look = await db.rpc('get_auth_user_id_by_email', { p_email: norm(r.email) })
    const hasLogin = !look.error && !!look.data

    let action: Action, reason: string
    if (!active) {
      if (r.is_active !== true) {
        action = 'skip'; reason = 'already deactivated'
      } else if (otherActive.length > 0) {
        action = 'keep'
        reason = `still assigned to ${otherActive.length} other active ${otherActive.length === 1 ? 'property' : 'properties'}`
      } else {
        action = 'revoke'; reason = 'this is their only active property'
      }
    } else {
      if (r.is_active === true) {
        action = 'skip'; reason = 'already active'
      } else if (r.cascade_deactivated_by_property === property.id) {
        action = 'restore'; reason = 'deactivated by this property\'s cascade'
      } else {
        // 🔴 Sweep class 15. The reverse acts only on its own stamps.
        // An unstamped row is unknown provenance — pre-2026-10-15
        // deactivations are all unstamped, because the old cascade
        // audited one row per PROPERTY and so cannot be told apart from
        // an individual deactivation. Guessing would restore access on
        // a maybe.
        action = 'skip'
        reason = 'deactivated separately; reactivate individually if intended'
      }
    }
    plan.push({ email: norm(r.email), raw_email: r.email, role: r.role, action, reason, has_login: hasLogin, other_active_properties: otherActive })
  }
  plan.sort((a, b) => a.action.localeCompare(b.action) || a.email.localeCompare(b.email))

  const { count: resCount } = await db.from('residents')
    .select('*', { count: 'exact', head: true }).eq('property', property.name).eq('is_active', !active)
  const { count: vehCount } = await db.from('vehicles')
    .select('*', { count: 'exact', head: true }).eq('property', property.name).eq('is_active', !active)

  return { ok: true, ctx: { db, actor: caller.email, property, plan, residents: resCount ?? 0, vehicles: vehCount ?? 0 } }
}

export async function POST(req: NextRequest) {
  let body: { property_id?: unknown; active?: unknown; mode?: unknown; only_emails?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ ok: false, error: 'bad_request', message: 'The request could not be read.' }, { status: 400 })
  }
  const propertyId = Number(body.property_id)
  if (!Number.isSafeInteger(propertyId) || typeof body.active !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'bad_request', message: 'The request could not be read.' }, { status: 400 })
  }
  const active = body.active
  const mode = body.mode === 'apply' ? 'apply' : 'plan'
  const onlyEmails = Array.isArray(body.only_emails)
    ? body.only_emails.filter((e): e is string => typeof e === 'string').map(norm)
    : null

  const prep = await prepare(propertyId, active, onlyEmails)
  if (!prep.ok) {
    return NextResponse.json({ ok: false, error: prep.code, message: prep.message }, { status: prep.status })
  }
  const { db, actor, property, plan, residents, vehicles } = prep.ctx

  if (mode === 'plan') {
    return NextResponse.json({
      ok: true, mode: 'plan',
      property: { id: property.id, name: property.name, is_active: property.is_active },
      active_target: active,
      // raw_email is an implementation detail of the write; the caller
      // gets the normalized address it will display and retry with.
      users: plan.map(({ raw_email: _raw, ...rest }) => rest),
      counts: {
        revoke:  plan.filter(p => p.action === 'revoke').length,
        restore: plan.filter(p => p.action === 'restore').length,
        keep:    plan.filter(p => p.action === 'keep').length,
        skip:    plan.filter(p => p.action === 'skip').length,
      },
      residents_to_change: active ? 0 : residents,
      vehicles_to_change:  active ? 0 : vehicles,
      // Stated here so the dialog cannot imply otherwise: reactivation
      // restores the property and the users this cascade took, and does
      // NOT restore residents, vehicles, space assignments or pending
      // requests. Deliberate and long-standing.
      note: active
        ? 'Reactivation restores the property and the users this property\'s cascade deactivated. Residents, vehicles, space assignments and pending requests are NOT restored.'
        : 'Residents and vehicles at this property will be deactivated. Reactivating later does not restore space assignments or pending requests.',
    })
  }

  // ── apply: stream, so progress is real rather than a spinner ─────
  const runId = crypto.randomUUID()
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start(c) {
      const send = (o: unknown) => c.enqueue(enc.encode(JSON.stringify(o) + '\n'))
      const results: { email: string; action: Action; ok: boolean; detail: string }[] = []
      try {
        const todo = plan.filter(p => p.action === 'revoke' || p.action === 'restore')
        // raw_email is stripped here as well as from the plan response:
        // it exists only so the write matches a row whose stored email
        // may not be lowercased, and it has no business in a payload a
        // client renders or logs.
        send({ type: 'start', run: runId, property: property.name, total: todo.length,
               skipped: plan.filter(p => p.action === 'skip' || p.action === 'keep')
                            .map(({ raw_email: _raw, ...rest }) => rest) })

        // 🔴 Sequential and independent. One failure does not stop the
        // rest and does not undo the ones before it.
        let done = 0
        for (const p of todo) {
          // raw_email, not the normalized one — see PlanRow.raw_email.
          const row: RoleRow = { email: p.raw_email, role: p.role, company: property.company, is_active: !active }
          const r = await setUserActive(db, actor, row, active, { propertyId: property.id, runId })
          done++
          results.push({ email: p.email, action: p.action, ok: r.ok,
                         detail: r.ok ? `${r.ban_state}${r.driver_row !== 'n/a' ? ` · driver ${r.driver_row}` : ''}` : (r.reason ?? 'failed') })
          send({ type: 'user', done, total: todo.length, email: p.email, action: p.action, ok: r.ok,
                 detail: results[results.length - 1].detail })
        }

        // ── the property's data, after the users ───────────────────
        let dataDetail = 'not changed'
        if (!active) {
          const res = await db.from('residents').update({ is_active: false }).eq('property', property.name).select('id')
          const veh = await db.from('vehicles').update({ is_active: false }).eq('property', property.name).select('id')
          dataDetail = `${(res.data ?? []).length} residents, ${(veh.data ?? []).length} vehicles deactivated`
          if (res.error || veh.error) dataDetail += ` 🔴 (${res.error?.message ?? ''}${veh.error?.message ?? ''})`
          send({ type: 'data', ok: !res.error && !veh.error, detail: dataDetail })
        } else {
          // Deliberately NOT restored. Disclosed in the plan's note.
          send({ type: 'data', ok: true, detail: 'residents and vehicles left as they are (reactivation does not restore them)' })
        }

        const pf = await db.from('properties').update({ is_active: active }).eq('id', property.id).select('id, is_active')
        const propOk = !pf.error && (pf.data ?? []).length === 1 && pf.data![0].is_active === active
        send({ type: 'property', ok: propOk, detail: propOk ? `marked ${active ? 'active' : 'inactive'}` : (pf.error?.message ?? 'no row updated') })

        const failed = results.filter(r => !r.ok).map(r => r.email)
        // One cascade-level row for a human, beside the per-user rows
        // setUserActive already wrote for a remediation query.
        await db.from('audit_logs').insert({
          user_email: actor.toLowerCase(),
          action: active ? 'PROPERTY_CASCADE_REACTIVATE' : 'PROPERTY_CASCADE_DEACTIVATE',
          table_name: 'properties', record_id: String(property.id),
          new_values: { run: runId, property: property.name, is_active: active,
                        users_attempted: results.length, users_failed: failed,
                        data: dataDetail, property_flipped: propOk,
                        outcome: failed.length === 0 && propOk ? 'ok' : 'partial' },
          notes: failed.length === 0 && propOk
            ? `${actor} ${active ? 'reactivated' : 'deactivated'} ${property.name}; ${results.length} user(s), ${dataDetail}`
            : `🔴 ${actor} ${active ? 'reactivated' : 'deactivated'} ${property.name} PARTIALLY: ${failed.length} user(s) failed (${failed.join(', ')}). Not reported as done.`,
        })

        send({ type: 'done', ok: failed.length === 0 && propOk, run: runId,
               results, failed, retry: failed, property_flipped: propOk })
      } catch (e) {
        console.error('[property-active] cascade threw:', e)
        send({ type: 'done', ok: false, error: 'cascade_failed',
               message: 'The cascade stopped partway. The result list above is what completed.',
               results, failed: results.filter(r => !r.ok).map(r => r.email) })
      } finally {
        c.close()
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

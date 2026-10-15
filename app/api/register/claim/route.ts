import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { verifyTurnstile } from '../../../lib/turnstile-verify'
import { guardEmail } from '../../../lib/email-guard'

// ════════════════════════════════════════════════════════════════════
// Phase B.1 — the claim step
// ════════════════════════════════════════════════════════════════════
// A resident whose record already exists but who has no login asks for
// a setup link. Built out of parts that already work:
//
//   inviteUserByEmail  →  /auth/accept?type=invite  (public, OTP
//                         fallback)  →  /reset-password-required  →
//                         session  →  /consent (portal layout gate)  →
//                         the resident portal, their vehicles already
//                         there
//
// 🔴 WHY NOT /api/register/create-user. That route hands a token_hash to
// the BROWSER, which verifyOtps it into a session — the email is never
// verified. Safe for a brand-new address, which owns nothing. NOT safe
// for a records-bearing one: on 2026-10-15 a canary proved it minted a
// session on a resident's record, and for a manager canary the session
// returned get_my_role() = 'manager'. That route now refuses any email
// with a residents or user_roles row, which is precisely why this one
// exists. inviteUserByEmail sends the token to the MAILBOX, so only
// the person who controls the address proceeds.
//
// 🔴 THE RESPONSE IS BYTE-IDENTICAL IN EVERY CASE. Record found and
// invited, record found but already has a login, no record at all,
// rate-limited — all return the same body. Otherwise this form is an
// oracle for "is this person a resident at this property", which is a
// worse disclosure than the dead end it replaces. Every branch returns
// SAME_ANSWER.
//
// 🔴 ON DEMAND ONLY. Nothing here is triggered by a load or a batch.
// The resident asks, one address at a time.
//
// ── WHAT DEFENDS THIS ENDPOINT ──────────────────────────────────────
// Three things, and they are the whole list:
//
//   1. TURNSTILE, PER REQUEST, checked before any lookup. A bot cannot
//      probe at all without solving one. This is the per-request cost.
//   2. THE BYTE-IDENTICAL ANSWER. What defeats enumeration — a caller
//      learns nothing from the response in any branch.
//   3. THE uid CHECK. Caps unsolicited invites at ONE PER ADDRESS,
//      EVER: once an auth user exists this route sends nothing more.
//      Bounded by construction rather than by a counter.
//
// 🔴 THERE IS NO RATE-LIMIT COUNTER, DELIBERATELY. One was written and
// removed on 2026-10-15 because it counted the wrong thing: it counted
// audit rows, which exist only after a SUCCESSFUL invite, so a caller
// probing unknown addresses wrote none and was never throttled. It
// capped legitimate repeats — already capped by (3) — and did nothing
// about abuse. A control that does not work is worse than a missing
// one, because it stops anyone looking. Its own gate caught it: the
// ceiling assertion passed because (3) short-circuited first.
//
// If the claim screen ever becomes a bare public form rather than
// something reached through a property QR link and a Turnstile solve,
// a REQUEST-counting store becomes necessary — see
// docs/backlog/claim-rate-limit-counts-successes.md. Not before.

export const runtime = 'nodejs'

/** The only body this route ever returns. */
const SAME_ANSWER = {
  ok: true,
  message:
    'If we have your details on file for that property, we have emailed you a link to set up your login. '
    + 'It can take a minute to arrive — check your spam folder too.',
}
const answer = () => NextResponse.json(SAME_ANSWER)

const ACTION = 'RESIDENT_CLAIM_INVITE'

export async function POST(req: NextRequest) {
  let body: { email?: unknown; property?: unknown; captchaToken?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ ok: false, error: 'bad_request', message: 'The request could not be read.' }, { status: 400 })
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const property = typeof body.property === 'string' ? body.property.trim() : ''
  const captchaToken = typeof body.captchaToken === 'string' ? body.captchaToken.trim() : ''

  // Shape errors are NOT part of the identical-answer rule: they say
  // nothing about whether a record exists, and a user who typed a bad
  // address needs to be told.
  if (!email || !property) {
    return NextResponse.json({ ok: false, error: 'bad_request', message: 'Please enter your email address.' }, { status: 400 })
  }
  const guarded = guardEmail(email)
  if (!guarded.ok) {
    return NextResponse.json({ ok: false, error: 'email_rejected', message: guarded.message }, { status: 400 })
  }

  // Public ingress, so the captcha is checked here and server-side —
  // before any lookup, so a bot cannot use this endpoint to enumerate
  // at all, identical answer or not.
  const remoteIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const verify = await verifyTurnstile(captchaToken, remoteIp === 'unknown' ? undefined : remoteIp)
  if (!verify.ok) {
    return NextResponse.json(
      { ok: false, error: 'captcha_failed', message: 'CAPTCHA verification failed. Please try again.' },
      { status: verify.reason === 'missing_token' ? 400 : verify.reason === 'network_error' ? 503 : 403 },
    )
  }

  const db = createSupabaseServiceClient()
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()

  // ── is there a live record for this address AT THIS PROPERTY? ────
  // Matched in Node on lower(trim(...)) rather than with ILIKE: there
  // is no pattern side to escape, and `_` is a LIKE wildcard that
  // guardEmail does NOT block and is ordinary in real addresses.
  const { data: residents, error: resErr } = await db
    .from('residents').select('id, email, name, unit, property, company, is_active, status')
  if (resErr) {
    console.error('[register/claim] residents read failed:', resErr)
    return answer()
  }
  const match = (residents ?? []).find(r =>
    norm(r.email) === email && norm(r.property) === norm(property)
    && r.is_active === true && r.status === 'active')
  if (!match) return answer()

  // 🔴 Already has a login → send nothing. inviteUserByEmail would fail
  // for an existing user anyway, and re-inviting someone who can
  // already sign in is how an account gets a surprise password reset.
  // They go to /login or /forgot-password; the answer does not say so,
  // because saying so would confirm the address.
  const { data: uid, error: lookErr } = await db.rpc('get_auth_user_id_by_email', { p_email: email })
  if (lookErr) {
    console.error('[register/claim] auth lookup failed:', lookErr)
    return answer()
  }
  if (uid) {
    console.info(`[register/claim] ${email} already has a login — no invite sent`)
    return answer()
  }

  // ── the role row, BEFORE the invite ─────────────────────────────
  // 🔴 ALL 35 of the current claim population have NO user_roles row
  // (measured 2026-10-15). get_my_role() returns NULL without one, so
  // claiming the account alone would land every one of them in a blank
  // portal — they would set a password and see nothing.
  //
  // Created BEFORE the invite on purpose: an inert row whose invite
  // later failed is harmless and is reused by the next attempt, whereas
  // an accepted invite with no role row is the blank portal. Every
  // value is derived from the residents row — nothing is invented, the
  // same discipline as the amandacanchol one-off.
  //
  // Not through insert_user_role(): that RPC is granted to
  // `authenticated` and carries its own caller-role guard, which a
  // service_role call does not satisfy.
  const { data: existingRole } = await db
    .from('user_roles').select('id').ilike('email', match.email as string).limit(1)
  if ((existingRole ?? []).length === 0) {
    const ins = await db.from('user_roles').insert({
      email: match.email,
      role: 'resident',
      company: match.company,
      property: [match.property],
      is_active: true,
    }).select('id').single()
    if (ins.error) {
      // 23505 = someone claimed concurrently and won the unique index.
      // That is fine: the row exists, which is all this step wanted.
      if (ins.error.code !== '23505') {
        console.error(`[register/claim] could not create the resident role row for ${email} — refusing to invite into a blank portal:`, ins.error)
        return answer()
      }
    }
  }

  // ── the invite ──────────────────────────────────────────────────
  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin
  const { error: invErr } = await db.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/reset-password-required`,
    // 🔴 PROPERTY AND UNIT, NEVER A PLATE. If the customer typo'd the
    // address this email reaches a stranger, and they must be able to
    // tell it is not theirs — while learning nothing about a vehicle.
    // The typo risk is an attestation risk, accepted; this is what
    // bounds it.
    data: { claim_property: match.property, claim_unit: match.unit ?? null },
  })
  if (invErr) {
    console.error(`[register/claim] invite failed for ${email}:`, invErr)
    return answer()
  }

  await db.from('audit_logs').insert({
    user_email: 'resident-claim',
    action: ACTION,
    table_name: 'residents',
    record_id: email,
    new_values: {
      email, property: match.property, unit: match.unit ?? null,
      resident_id: match.id, ip: remoteIp,
      role_row: (existingRole ?? []).length === 0 ? 'created' : 'already_present',
    },
    notes: `Setup link sent to ${email} for ${match.property}${match.unit ? ` unit ${match.unit}` : ''}. Requested from ${remoteIp}.`,
  })

  return answer()
}

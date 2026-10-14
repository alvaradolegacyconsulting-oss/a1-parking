import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { verifyTurnstile } from '../../../lib/turnstile-verify'
import { guardEmail } from '../../../lib/email-guard'
import { escapeIlikeValue } from '../../../lib/supabase-query-escape'

// /api/register/create-user — public resident self-registration creator
// (C′′, 2026-06-29). Replaces the /register path's call chain of
// (/api/register/captcha-verify → swift-handler create_user →
// signInWithPassword) with a single round-trip: this route does its
// own Cloudflare siteverify (ADD 1 — bot-rejection is the security
// boundary, must live server-side, not client-orchestrated), admin-
// creates the auth.users row, generates a one-time magic-link token,
// and returns the token to the client. Client then calls
// supabase.auth.verifyOtp({email, token_hash, type:'magiclink'}) to
// establish the session — verifyOtp is UNGATED (confirmed by the
// 2026-06-29 prod probe), so no second captcha is needed.
//
// SCOPE: ONLY the /register surface. swift-handler stays in use for
// admin / company_admin / manager create_user calls (7 other call
// sites) — they remain untouched. Same security model overall: a
// service-role admin-create gated by a captcha token verified server-
// side.
//
// RESIDENT SIDE EFFECTS (ADD 2): swift-handler's create_user does ONLY
// admin.createUser — it does NOT create the user_roles row or any
// other side effects. Those happen client-side AFTER swift-handler
// returns: residents INSERT (RLS-gated), insert_user_role RPC, and
// companion-vehicle route call. Under the new flow those steps happen
// AFTER verifyOtp establishes the session — exactly as today, just
// with a different session-acquisition mechanism. So no role-row trap.
//
// FAIL-CLOSED: any non-OK siteverify or admin-create error returns 4xx
// before any DB write. A direct tokenless / forged POST to this route
// is rejected at the verifyTurnstile call.

// ── 2026-07-25 attach-hardening ──────────────────────────────────
// The route handles TWO shapes with byte-identical caller-visible output:
//   • create — email is new, admin-create auth user, mint magic-link
//   • attach — email exists (createUser returns email_exists / 422),
//              skip create, resolve existing user_id, mint magic-link
// Response shape is byte-identical across both. No `mode` field. Attach
// path never touches the existing auth user beyond READ-ONLY id
// resolution. Password from the request body is IGNORED on the attach
// path — the existing user's password is preserved. This is the
// load-bearing property-A-login guarantee: silent attach must not damage
// the caller's login at their prior property. Enforce by construction —
// this route calls NO updateUserById / password / email_confirm /
// metadata mutation anywhere on the attach branch.
//
// Discriminator locked (probe 2026-07-25):
//   err.code === 'email_exists' AND err.status === 422 (AuthApiError)
// Never message-match — Supabase reserves the right to reword.
//
// ENUMERATION BAR:
//   • Success paths (create + attach) return identical status + body shape.
//   • The two 500 branches (not-found post-attach-resolve + generateLink
//     failure) return the same message class so a 500 doesn't tell the
//     caller which path produced it.
//   • Non-duplicate createErr returns a generic 400 (not the raw SDK
//     message) — a weak-password on a NEW email must not distinguish
//     from a weak-password on an EXISTING email (the existing one now
//     hits the attach path and returns 200 instead of createUser's 400).
//   • RESIDUAL — timing side-channel: CLOSED 2026-09-11. The attach
//     path used to call listUsers (O(users), paginated) while the
//     create path didn't, so existing emails responded measurably
//     slower. That call existed only to feed generateLink on the attach
//     branch; removing the branch's token removed the call.
//     docs/backlog/attach-endpoint-listusers-timing-enumeration.md
//
//   • ⚠ NEW DELTA, ACCEPTED 2026-09-11: the create response carries
//     token_hash and the existing-email response does not, so the two
//     are distinguishable. Deliberate — see the security note on the
//     duplicate branch. Strictly less bad than the takeover it replaced.

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  // ── 1. Parse body ───────────────────────────────────────────────
  let body: { captchaToken?: string; email?: string; password?: string } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body.' }, { status: 400 })
  }
  const captchaToken = (body.captchaToken ?? '').trim()
  const email        = (body.email ?? '').trim().toLowerCase()
  const password     =  body.password ?? ''
  if (!email || !password) {
    return NextResponse.json({ ok: false, error: 'Email and password are required.' }, { status: 400 })
  }

  // 🔴 TOURNIQUET (2026-09-11) — see app/lib/email-guard.ts. This is the
  // PUBLIC, live ingress: admin.createUser accepts `%` (probed against
  // production the same day), and a session held under `%@gmail.com`
  // makes every `email ~~*` RLS policy match every Gmail address in the
  // table. Checked BEFORE Turnstile so a rejected address costs no
  // siteverify call, and before any DB or auth write.
  // Interim — the fix is the policy rewrite.
  const emailGuard = guardEmail(email)
  if (!emailGuard.ok) {
    return NextResponse.json({ ok: false, error: emailGuard.message }, { status: 400 })
  }

  // ── 2. CAPTCHA siteverify (ADD 1 — the security boundary) ─────
  // Done server-side INSIDE this route, not by a client-orchestrated
  // upstream call. A bot that skips the client sequence and POSTs
  // straight here gets rejected before any admin.createUser call.
  // The IP forwarded to Cloudflare improves their bot signal.
  const remoteIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined
  const verify = await verifyTurnstile(captchaToken, remoteIp)
  if (!verify.ok) {
    const status =
      verify.reason === 'missing_token'  ? 400 :
      verify.reason === 'missing_secret' ? 500 :
      verify.reason === 'network_error'  ? 503 :
                                            403
    return NextResponse.json(
      { ok: false, error: 'CAPTCHA verification failed. Please try again.', reason: verify.reason },
      { status },
    )
  }

  // ── 3. Service-role admin client ───────────────────────────────
  const supabase = createSupabaseServiceClient()

  // ══════════════════════════════════════════════════════════════
  // 🔴 3b. RECORDS-BEARING EMAIL — REFUSE BEFORE CREATING ANYTHING
  //        Added 2026-10-15 after an executed canary.
  // ══════════════════════════════════════════════════════════════
  // The 2026-09-11 fix stopped this route minting a token for an email
  // that already has an AUTH ACCOUNT. Its reasoning — a brand-new email
  // owns nothing, so creating it and handing back a session is harmless
  // — silently assumed that "no auth account" means "no records".
  //
  // It does not. An identity can hold records and no login:
  //
  //   • a resident imported by bulk onboarding (none yet; 228 at Alden
  //     Park alone once a batch loads), or a legacy resident who never
  //     registered (35 today, all demo/test);
  //   • 🔴 a user_roles row whose auth user was never created or was
  //     deleted. Production holds ONE: a manager at A1 Wrecker llc with
  //     is_active=false.
  //
  // Canary, executed 2026-10-15 on a Test-LEGACY row, never on A1:
  // POSTing such an address returned 200 with a token_hash, createUser
  // succeeded, and verifyOtp established a real session. For the
  // resident canary that session read their record (and their vehicles
  // once a user_roles row existed). For the manager canary:
  //
  //   get_my_role()    → "manager"      ← the row is is_active=false;
  //   get_my_company() → the company       that helper does not check it
  //
  // So every policy written as get_my_role() = 'manager' evaluated in
  // the caller's favour. Same shape as the takeover closed in
  // September, reached through a different door: not "an account you do
  // not own" but "a record whose account does not exist yet".
  //
  // 🔴 BOTH TABLES, not just residents. The ruling said "any residents
  // row"; the manager canary is why this is wider. A role-bearing
  // identity is the more dangerous of the two, and scoping the check to
  // residents would have left the only live instance open.
  //
  // The response is byte-identical to the existing-email branch below —
  // {ok:true}, 200, no token_hash — so a caller cannot tell "already
  // registered" from "has records". The create/no-create distinction
  // remains the enumeration delta accepted on 2026-09-11.
  //
  // 🔴 NO AUTH USER IS CREATED on this branch. Creating one would both
  // consume the address and break the claim path, since
  // inviteUserByEmail fails for an existing user.
  //
  // ILIKE with the value escaped: guardEmail blocks `%` and `\` but NOT
  // `_`, which is a LIKE wildcard and is ordinary in real addresses
  // (john_doe@…). Unescaped it would match john-doe@… too — a false
  // refusal of a legitimate signup rather than a bypass, but wrong.
  // Escaped, ILIKE is exact-but-case-insensitive, which is what
  // residents.email and user_roles.email need.
  const emailPattern = escapeIlikeValue(email)
  const [residentHit, roleHit] = await Promise.all([
    supabase.from('residents').select('id').ilike('email', emailPattern).limit(1),
    supabase.from('user_roles').select('id').ilike('email', emailPattern).limit(1),
  ])
  if (residentHit.error || roleHit.error) {
    // Fail CLOSED, in the shape that reveals nothing. A read failure
    // here must not fall through to createUser: "we could not check"
    // is not "there is nothing to find".
    console.error('[register/create-user] records-bearing pre-check failed — refusing, fail-closed:',
      residentHit.error ?? roleHit.error)
    return NextResponse.json({ ok: true })
  }
  if ((residentHit.data ?? []).length > 0 || (roleHit.data ?? []).length > 0) {
    return NextResponse.json({ ok: true })
  }

  // ── 4. Admin-create OR resolve-existing (silent attach) ────────
  // Two-shape branch: create for new emails, attach for existing.
  // Discriminator locked to (err.code='email_exists' + err.status=422)
  // per 2026-07-25 probe against this project's SDK version. See
  // scripts/probe-createuser-duplicate-discriminator-ONE-TIME.ts.
  const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createErr) {
    const isDuplicate =
      (createErr as { code?: string }).code === 'email_exists' &&
      createErr.status === 422
    if (!isDuplicate) {
      // Non-duplicate createUser failure (weak_password, validation_failed,
      // rate_limit, etc.). Return a GENERIC 400 rather than createErr.message —
      // the raw SDK message would let a caller who submits a bad-password body
      // distinguish "existing email (200 attach)" from "new email
      // (400 weak_password)". Generic message closes that enumeration axis.
      return NextResponse.json(
        { ok: false, error: 'Registration failed. Please check your input and try again.' },
        { status: 400 },
      )
    }
    // ══════════════════════════════════════════════════════════════
    // 🔴 EXISTING EMAIL — RETURN WITHOUT A SESSION TOKEN. SECURITY FIX
    //    2026-09-11. DO NOT REINSTATE generateLink ON THIS BRANCH.
    // ══════════════════════════════════════════════════════════════
    // Until today this branch resolved the existing user's id and FELL
    // THROUGH to the generateLink block below, so the route returned a
    // magic-link token_hash FOR AN ACCOUNT THE CALLER DID NOT OWN.
    // Combined with ungated verifyOtp that was full account takeover of
    // any address an attacker knew, from a public endpoint, with no
    // password and no mailbox access:
    //
    //   POST {email: victim, password: anything, captchaToken}
    //     → read token_hash from the 200 response
    //     → verifyOtp({token_hash}) → session AS THE VICTIM
    //
    // Manager addresses are on tow tickets, invite emails and help
    // pages, so "an address an attacker knows" is not a high bar. And
    // a session as the victim means get_my_role() and get_my_company()
    // return the VICTIM's values — every equality-based guard in the
    // system evaluates in the attacker's favour.
    //
    // The property-A-login guarantee is about NOT DAMAGING the existing
    // account. It never required handing the caller a session, and it
    // still holds: nothing below this line touches the existing user.
    //
    // resolveExistingAuthUserId is no longer called here. It existed
    // only to feed generateLink. Dropping it also closes the filed
    // timing side-channel (docs/backlog/attach-endpoint-listusers-
    // timing-enumeration.md) — the attach path no longer does an
    // O(users) listUsers scan, so existing emails no longer respond
    // measurably slower.
    //
    // ⚠ KNOWN ENUMERATION DELTA, ACCEPTED 2026-09-11: this response has
    // no token_hash and the create response does, so a caller can tell
    // whether an address is registered. That is strictly less bad than
    // account takeover. Closing it too means dropping token_hash from
    // BOTH branches and signing in with the password instead — blocked
    // today because signInWithPassword is captcha-gated on this project
    // and the caller's only Turnstile token was consumed above. See the
    // report; that is a follow-up, not a regression introduced here.
    return NextResponse.json({ ok: true })
  }
  // NOTE: the created user's id is deliberately NOT captured or
  // returned. It was only ever echoed to the caller, and a public
  // endpoint has no reason to expose an internal auth id.

  // ── 5. Generate a magic-link token for ungated session acquisition ──
  // admin.generateLink does NOT send the email (Supabase admin-API
  // behavior — the email is only sent by user-facing methods like
  // signInWithOtp). The route returns the hashed_token to the client,
  // which calls verifyOtp({token_hash}) to establish the session.
  // verifyOtp is UNGATED — confirmed by the 2026-06-29 prod probe —
  // so no second captcha solve is required on the client.
  // Works for BOTH new (just-created) and existing (attach) users.
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkErr || !linkData?.properties?.hashed_token) {
    // User was created but link generation failed. Surface as a partial
    // failure — /register should display "Account created but session
    // setup failed" so the user knows their account exists; they can
    // sign in via /login after manager approval. Email was already
    // confirmed via email_confirm:true so the password they entered
    // is the working credential.
    return NextResponse.json(
      { ok: false, error: 'Account created but session-link generation failed: ' + (linkErr?.message ?? 'no hashed_token returned') },
      { status: 500 },
    )
  }

  // Only reachable when THIS request created the account. user_id and
  // email are no longer echoed — a public endpoint has no reason to
  // hand back an internal auth id, and on the (now removed) attach path
  // that id belonged to somebody else.
  return NextResponse.json({
    ok: true,
    token_hash: linkData.properties.hashed_token,
  })
}

/*
 * resolveExistingAuthUserId REMOVED 2026-09-11.
 *
 * It resolved an existing auth.users id so the attach branch could mint
 * a magic link for an account the caller did not own. That was the
 * takeover. The function is deleted rather than left unused: dead code
 * that hands back exactly the capability we just removed is an
 * invitation, and the next reader would have no way to know it must not
 * be called.
 *
 * Removing it also closes the filed timing side-channel — the attach
 * path no longer performs an O(users) listUsers scan, so existing
 * emails no longer respond measurably slower than new ones.
 * (docs/backlog/attach-endpoint-listusers-timing-enumeration.md)
 */

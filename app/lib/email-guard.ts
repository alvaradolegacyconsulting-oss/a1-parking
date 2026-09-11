// ════════════════════════════════════════════════════════════════════
// 🔴 TOURNIQUET — NOT THE FIX. READ THIS BEFORE CLOSING ANY TICKET.
//
// ── WHAT THIS IS ────────────────────────────────────────────────────
// ~24 RLS policy sites compare `email ~~* (auth.jwt() ->> 'email')`.
// `~~*` is ILIKE, so THE CALLER'S OWN EMAIL IS USED AS A PATTERN. An
// account whose address is `%@gmail.com` matches EVERY Gmail address in
// those tables.
//
// Probed 2026-09-11 against production: `supabase.auth.admin.createUser`
// ACCEPTS `%` in the local part. No error, no code, no message — GoTrue
// returned success. There is no metacharacter filtering upstream of us.
//
// This module blocks the two characters that make the attack wholesale,
// at every ingress that can mint an auth.users row. It buys time. It is
// not a fix.
//
// ── 🔴 THE ACTUAL FIX IS THE POLICY REWRITE ─────────────────────────
//   lower(email) = lower(auth.jwt() ->> 'email')
// across all ~24 sites, matching the b155.2 helper shape
// (20260610_b155_2_f9_helper_lower_match.sql).
//
// DO NOT conclude from the existence of this file that the vector is
// handled. It is not. This file does not help:
//   · the 11 existing accounts that already contain `_` (see below)
//   · any ingress added after today that forgets to call it
//   · the two /signup paths, which call GoTrue FROM THE BROWSER and
//     cannot be server-guarded — see INGRESS COVERAGE below
//
// ── WHY `%` AND `\` BUT NOT `_` ─────────────────────────────────────
// `%`  matches any sequence — this is the entire wholesale case. Valid
//      per RFC 5322 and effectively nobody's real address has one:
//      0 of 231 user_roles rows and 0 of 262 residents rows carry it
//      (measured 2026-09-11). Rejecting it costs nothing measurable.
//
// `\`  the third LIKE metacharacter, and the escape character. Same
//      reasoning, no legitimate use. Consistent with the 2026-09-01
//      CHECK on companies.name and properties.name, which blocks
//      [%_\\].
//
// `_`  DELIBERATELY ALLOWED. It matches exactly ONE character, so reach
//      is bounded — `____@gmail.com` matches four-character local parts,
//      not everything, and breadth requires many registrations at many
//      lengths, each through Turnstile.
//
//      🔴 And the cost of blocking it is real: ELEVEN of 231 existing
//      accounts contain `_` — about five percent. Rejecting one in
//      twenty resident self-registrations to close a targeted vector is
//      a bad trade, and `john_smith@gmail.com` being refused is a
//      support ticket that makes the product look broken.
//
//      `_` is handled by the policy rewrite, which is the real fix
//      regardless.
//
// ── INGRESS COVERAGE (2026-09-11) ───────────────────────────────────
// The attacker's pattern arrives via the JWT, so it comes from
// auth.users. A CHECK on user_roles.email or residents.email would NOT
// close this — those hold the VICTIM side of the comparison.
//
// SERVER-SIDE, guarded by this module:
//   · app/api/register/create-user/route.ts   admin.createUser  (PUBLIC, live)
//   · app/api/admin/invite-user/route.ts      inviteUserByEmail
//   · app/api/admin/resend-invite/route.ts    inviteUserByEmail
//   · app/api/billing/bulk-invite/route.ts    inviteUserByEmail
//   · app/lib/bulk-upload-helpers.ts          CSV validation, pre-invite
//
// ⚠ NOT SERVER-GUARDABLE — app/signup/page.tsx:217 and
//   app/signup/redeem/page.tsx:173 call supabase.auth.signUp() DIRECTLY
//   FROM THE BROWSER. There is no API route in between, so a check
//   there is UX, not a control: an attacker POSTs straight to GoTrue.
//   Those pages call this module anyway — consistent messaging, and it
//   stops an honest user creating an account nothing else will accept —
//   but do not count them as closed.
//
//   Whether auth.signUp itself accepts `%` is UNKNOWN. The 2026-09-11
//   probe tested admin.createUser only, and the two do not necessarily
//   validate alike. Until that is probed, treat /signup as OPEN.
// ════════════════════════════════════════════════════════════════════

// The LIKE metacharacters that make the pattern match more than itself.
// `_` is excluded on purpose — see the header. Do not add it here
// without re-reading the eleven-accounts paragraph.
export const BLOCKED_EMAIL_CHARS = ['%', '\\'] as const

export type BlockedEmailChar = typeof BLOCKED_EMAIL_CHARS[number]

// Returns the offending character, or null when the address is fine.
// Returns the CHARACTER rather than a boolean so the caller can name it
// in the message — "we can't accept %" is actionable, "invalid email"
// sends the user round in circles retyping a valid address.
export function findBlockedEmailChar(email: string | null | undefined): BlockedEmailChar | null {
  if (!email) return null
  for (const ch of BLOCKED_EMAIL_CHARS) {
    if (email.includes(ch)) return ch
  }
  return null
}

// User-facing copy. Names the character, says what to do next, and does
// not leak why — "it would match other accounts" is a description of the
// vulnerability (feedback_raw_error_never_reaches_user).
export function blockedEmailMessage(ch: BlockedEmailChar): string {
  return `Email addresses can't contain the "${ch}" character here. `
       + `Please use an address without it, or contact your property manager if that's the only address you have.`
}

export type EmailGuardResult =
  | { ok: true }
  | { ok: false; char: BlockedEmailChar; message: string }

// The single entry point. One validator, not one per ingress — three
// copies is how the fourth ingress ships without one.
export function guardEmail(email: string | null | undefined): EmailGuardResult {
  const ch = findBlockedEmailChar(email)
  if (!ch) return { ok: true }
  return { ok: false, char: ch, message: blockedEmailMessage(ch) }
}

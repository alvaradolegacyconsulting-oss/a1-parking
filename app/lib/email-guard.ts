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
  // `char` is null when the refusal came from the dead-TLD rule rather
  // than a blocked character. Callers read `.message`; nothing in the
  // tree branches on `.char` (verified 2026-09-21).
  | { ok: false; char: BlockedEmailChar | null; message: string }

// The single entry point. One validator, not one per ingress — three
// copies is how the fourth ingress ships without one.
export function guardEmail(email: string | null | undefined): EmailGuardResult {
  const ch = findBlockedEmailChar(email)
  if (ch) return { ok: false, char: ch, message: blockedEmailMessage(ch) }

  // 2026-09-21 — dead-TLD check folded in here so every ingress that
  // already calls guardEmail() gets it without a second call site.
  // `char` is reported as null: the caller only ever reads `.message`,
  // and inventing a fake character to satisfy the old shape would make
  // the "we can't accept X" copy name something that isn't there.
  const tld = checkDeadTld(email)
  if (!tld.ok) return { ok: false, char: null, message: tld.message }

  return { ok: true }
}

// ════════════════════════════════════════════════════════════════════
// TYPO GUARD (2026-09-21) — a SECOND, INDEPENDENT concern in this file
// ════════════════════════════════════════════════════════════════════
//
// Deliberately added here rather than in a new module. `guardEmail()` is
// already the single entry point every auth-minting ingress calls; a
// second validator would mean a second list of call sites to keep in
// sync, and the first thing that goes wrong with two gates is that a new
// ingress gets one of them. One email gate, not two.
//
// ── WHAT THIS BUYS, HONESTLY ────────────────────────────────────────
// Of the five bounced addresses that prompted this (2026-09-21), these
// rules would have caught exactly ONE — `greth.plancarte@gmail.con`.
// The other four are well-formed addresses that are simply wrong, and
// no amount of syntax checking finds those. Bounce visibility is the
// actual fix; this is cheap insurance in front of it.
//
// ── TWO CLASSES, ON PURPOSE ─────────────────────────────────────────
// HARD BLOCK  — top-level domains that do not exist. Mail to them cannot
//               be delivered under any circumstances, so refusing costs
//               a legitimate user nothing. Enforced SERVER-SIDE.
//
// SUGGEST     — misspellings of providers our users actually use. These
//               are almost certainly typos, but `gmial.com` is a domain
//               someone could genuinely own, and a hard block would lock
//               them out with no recourse. CLIENT-SIDE ONLY: show the
//               suggestion, let them keep what they typed.
//
// 🔴 `.co`, `.cm` and `.om` are REAL top-level domains — Colombia,
// Cameroon and Oman. They are NOT in the block list and must not be
// added. `name@example.co` is a valid address and the gate proves it.
// The matching below is on the FINAL LABEL, exact, for exactly this
// reason: a substring or startsWith test would catch `.co` inside
// `.com` and refuse the entire internet.

// Final-label values that are not real TLDs. Every one is a keyboard
// slip for `.com` — adjacent keys, transpositions, doubled letters.
const DEAD_TLDS = new Set([
  'con', 'cmo', 'ocm', 'cpm', 'vom', 'xom', 'comm', 'coom',
])

// Second-level-domain misspellings of the providers our users use.
const SLD_TYPOS: Record<string, string> = {
  gmial: 'gmail.com', gmal: 'gmail.com', gamil: 'gmail.com',
  gmali: 'gmail.com', gnail: 'gmail.com', gmaill: 'gmail.com',
  hotmial: 'hotmail.com', hotmai: 'hotmail.com', hotmil: 'hotmail.com',
  yahooo: 'yahoo.com', yaho: 'yahoo.com', yhoo: 'yahoo.com',
  outlok: 'outlook.com', outloo: 'outlook.com',
  iclod: 'icloud.com', icoud: 'icloud.com',
}

// Whole-domain cases the SLD map cannot catch, because the SLD is
// spelled correctly and only the TLD is short.
const DOMAIN_TYPOS: Record<string, string> = {
  'gmail.co': 'gmail.com',
}

// Matches the lower(trim(email)) convention used everywhere else.
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at < 0 || at === email.length - 1) return null
  return email.slice(at + 1)
}

export type DeadTldResult = { ok: true } | { ok: false; tld: string; message: string }

// HARD BLOCK. Server-enforced.
export function checkDeadTld(email: string | null | undefined): DeadTldResult {
  const domain = domainOf(normalizeEmail(email))
  if (!domain) return { ok: true }          // not our job — shape is validated elsewhere

  // A trailing dot ("name@gmail.com.") leaves an empty final label. It is
  // technically a fully-qualified root form and no mail provider accepts
  // it from a form, so it is treated as the typo it always is.
  if (domain.endsWith('.')) {
    return {
      ok: false,
      tld: '(trailing dot)',
      message: 'That address ends with a dot. Please remove the dot at the end and try again.',
    }
  }

  const labels = domain.split('.')
  const tld = labels[labels.length - 1]
  if (labels.length < 2 || !tld) return { ok: true }

  if (DEAD_TLDS.has(tld)) {
    return {
      ok: false,
      tld,
      message: `That address ends in ".${tld}" — did you mean ".com"? Please check the address and try again.`,
    }
  }
  return { ok: true }
}

// SUGGEST. Client-side only — never rejects, only proposes.
// Returns the corrected FULL address so the form can offer one-tap accept.
export function suggestEmailCorrection(email: string | null | undefined): string | null {
  const normalized = normalizeEmail(email)
  const domain = domainOf(normalized)
  if (!domain) return null
  const local = normalized.slice(0, normalized.lastIndexOf('@'))

  const whole = DOMAIN_TYPOS[domain]
  if (whole) return `${local}@${whole}`

  const labels = domain.split('.')
  if (labels.length < 2) return null
  const sld = labels[labels.length - 2]
  const corrected = SLD_TYPOS[sld]
  if (corrected) return `${local}@${corrected}`

  return null
}

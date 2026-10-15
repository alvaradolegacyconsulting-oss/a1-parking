// ════════════════════════════════════════════════════════════════════
// invite-origin — the one place that decides where an emailed link goes
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-16, after an invite arrived carrying
//   next=http://localhost:3000/reset-password-required
//
// 🔴 NEVER THE REQUEST ORIGIN. The claim route built its redirect from
// `new URL(req.url).origin` as a fallback, and the other three invite
// senders already used a hardcoded production default — so one of four
// could mint a link pointing at whatever host served the request. On a
// Vercel preview deployment that is a preview URL in a customer's
// inbox; behind a proxy it is whatever the Host header said. A link
// emailed to a person has to point at the product, and the request has
// no authority over where the product lives.
//
// 🔴 AND A MISCONFIGURED ENV VAR CANNOT MINT A DEAD LINK EITHER.
// In production, a NEXT_PUBLIC_APP_URL that is not a shieldmylot.com
// origin is ignored in favour of the canonical host. That is what would
// have caught the localhost link before it reached an inbox: the value
// was right for local development and wrong for anything that mails a
// real person, and nothing in between noticed.
//
// ── MEASURED, 2026-10-16 ────────────────────────────────────────────
// Asked GoTrue directly what its Redirect URLs allowlist accepts
// (scripts/probe-redirect-allowlist.ts):
//
//   SITE_URL                               https://shieldmylot.com
//   https://shieldmylot.com/...            ACCEPTED verbatim
//   http://localhost:3000/...              🔴 ACCEPTED verbatim
//   https://www.shieldmylot.com/...        replaced with SITE_URL
//   a Vercel preview host                  replaced with SITE_URL
//   https://evil.example.com/...           replaced with SITE_URL
//   https://shieldmylot.com.evil.../x      replaced with SITE_URL
//
// So GoTrue already fails safe for everything EXCEPT localhost, which
// is allowlisted and therefore carried through verbatim. That is why
// the localhost link reached a real inbox rather than being rewritten,
// and it is the one allowlist entry that has to come out before UAT.
//
// 🔴 Note the www row: a www redirectTo is silently replaced with the
// bare host. Bare is canonical for auth, which is worth knowing
// alongside the B108 canonical-hostname work.

/** The canonical production origin. The allowlist's only non-local entry. */
export const CANONICAL_ORIGIN = 'https://shieldmylot.com'

/** A shieldmylot.com origin, with or without a subdomain, https only. */
const CANONICAL_HOST = /^https:\/\/([a-z0-9-]+\.)*shieldmylot\.com$/

/**
 * The origin to put in an emailed link.
 *
 * Reads NEXT_PUBLIC_APP_URL, which is http://localhost:3000 in local
 * development and the production host on Vercel. 🔴 It NEVER consults
 * the request: see the header.
 *
 * In production a non-canonical configured value is refused and logged,
 * because the alternative is a dead or hostile link in a real inbox.
 * Outside production it is used as given, so a local rehearsal still
 * produces links a developer can click.
 */
export function inviteOrigin(): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim()
  if (!configured) return CANONICAL_ORIGIN

  let origin: string
  try { origin = new URL(configured).origin } catch {
    console.warn('[invite-origin] NEXT_PUBLIC_APP_URL is not a URL; using the canonical origin', { configured })
    return CANONICAL_ORIGIN
  }

  if (process.env.NODE_ENV === 'production' && !CANONICAL_HOST.test(origin)) {
    // Loud, because it means production is misconfigured and somebody
    // has to fix an env var — but not fatal, because refusing to send
    // the invite at all would be worse than sending a working one.
    console.error('[invite-origin] 🔴 NEXT_PUBLIC_APP_URL is not a canonical origin in production; using the canonical origin instead', { configured, origin })
    return CANONICAL_ORIGIN
  }
  return origin
}

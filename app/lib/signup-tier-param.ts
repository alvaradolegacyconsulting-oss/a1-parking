// ════════════════════════════════════════════════════════════════════
// signup-tier-param — ?tier= preselect for /signup
// ════════════════════════════════════════════════════════════════════
//
// Pure so both the accept and the ignore path are provable without a
// browser, on a page that is LIVE AND TAKING SIGNUPS.
//
// 🔴 ALLOWLIST, NOT PASSTHROUGH. The value chosen here is persisted into
// auth user_metadata.intended_tier at signUp and is later read by
// /api/signup/create-checkout-session to resolve Stripe Price IDs. That
// route validates intended_tier's SHAPE (presence of track/tier/cycle
// and the count types) but NOT its VOCABULARY — an unrecognised tier
// passes the 400 gate and fails later at catalog resolution as a 503
// "catalog lookup failed". So an unfiltered ?tier= would not be rejected
// at the door; it would mint an account and then dead-end the person at
// checkout. Two values in, everything else ignored.
//
// Ignoring is deliberate over erroring: a mistyped or stale campaign
// link should still deliver a working signup page on today's default,
// not an error screen. The visitor did nothing wrong.
//
// This is NOT a security control and must never be treated as one.
// user_metadata is client-writable, so anyone can set intended_tier to
// anything regardless of this function. It is here for correctness —
// so an honest link cannot silently select the wrong plan.

export type SelfServeTier = 'pm_starter' | 'enforcement_only'

// Today's default, unchanged. Named so a future change is one edit and
// shows up in the gate's expectations rather than hiding in a literal.
export const DEFAULT_TIER: SelfServeTier = 'enforcement_only'

const ALLOWED: readonly SelfServeTier[] = ['pm_starter', 'enforcement_only']

export function resolveInitialTier(search: string | null | undefined): SelfServeTier {
  if (!search) return DEFAULT_TIER
  let raw: string | null
  try {
    raw = new URLSearchParams(search).get('tier')
  } catch {
    return DEFAULT_TIER
  }
  if (raw === null) return DEFAULT_TIER
  const v = raw.trim()
  return (ALLOWED as readonly string[]).includes(v) ? (v as SelfServeTier) : DEFAULT_TIER
}

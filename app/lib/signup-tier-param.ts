// ════════════════════════════════════════════════════════════════════
// signup-tier-param — UI plan tokens → (track, backend tier)
// ════════════════════════════════════════════════════════════════════
//
// Pure, so every token can be asserted without a browser, on a page
// that is LIVE AND TAKING SIGNUPS.
//
// 🔴 WHY A MAP AND NOT A HEURISTIC. /signup used to derive the track
// from the tier — "the tier IS the track", pm_starter → PM, everything
// else → enforcement. The Oct 2026 lineup breaks that: `legacy` is the
// backend tier for BOTH PM Pro and Operator Pro, so a tier no longer
// tells you its track. A one-line heuristic cannot express a tier that
// lives on two tracks, and the version that tried would have sent every
// PM Pro buyer to the enforcement catalog.
//
// 🔴 THE TIER MODEL IS UNCHANGED. pm_starter, enforcement_only and
// legacy are exactly what they were, in code, data and gating. What is
// new is a DISPLAY layer: a token the URL and the picker speak, which
// resolves to a (track, tier) pair the rest of the system already
// understands. Nothing downstream learns a new word.
//
// 🔴 ALLOWLIST, NOT PASSTHROUGH. The resolved pair is persisted into
// auth user_metadata.intended_tier and read by
// /api/signup/create-checkout-session to resolve Stripe Price IDs. That
// route validates intended_tier's SHAPE but not its VOCABULARY — an
// unrecognised tier passes its 400 and fails later at catalog
// resolution as a 503, after the account exists. So an unknown token is
// IGNORED and the page opens on today's default. A stale campaign link
// should still deliver a working signup, not an error screen.
//
// NOT a security control: user_metadata is client-writable, so anyone
// can set intended_tier to anything regardless of this file. This is
// correctness — so an honest link cannot silently select the wrong plan.

export type Track = 'enforcement' | 'property_management'

// The three BACKEND tiers. Unchanged, and deliberately not widened.
export type BackendTier = 'pm_starter' | 'enforcement_only' | 'legacy'

// The tokens a URL or a picker card may use. `enforcement_only` is kept
// as a token because links already exist in the wild — the PM page's
// self-serve line, anything shared, anything printed. It resolves to
// the same plan as `operator_starter`.
export type PlanToken =
  | 'pm_starter'
  | 'pm_pro'
  | 'operator_starter'
  | 'operator_pro'
  | 'enforcement_only'

export type Plan = {
  token: PlanToken
  track: Track
  tier: BackendTier
  /** Public name, Oct 2026 lineup. */
  label: string
  /** Transition label. See FORMERLY_LABELS_ON. */
  formerly?: string
}

// 🔴 ONE SWITCH for the "(formerly …)" labels. Printed SWTO flyers in
// circulation say "Legacy plan" and "Enforcement-Only", so the old
// names stay visible until those are gone. Flip this to false and every
// one of them disappears — rather than hunting scattered strings.
export const FORMERLY_LABELS_ON = true

export const PLANS: Record<PlanToken, Plan> = {
  pm_starter: {
    token: 'pm_starter', track: 'property_management', tier: 'pm_starter',
    label: 'PM Starter',
  },
  pm_pro: {
    token: 'pm_pro', track: 'property_management', tier: 'legacy',
    label: 'PM Pro',
  },
  operator_starter: {
    token: 'operator_starter', track: 'enforcement', tier: 'enforcement_only',
    label: 'Operator Starter', formerly: 'Enforcement-Only',
  },
  operator_pro: {
    token: 'operator_pro', track: 'enforcement', tier: 'legacy',
    label: 'Operator Pro', formerly: 'Legacy',
  },
  // Alias. Same plan as operator_starter; kept so existing links work.
  enforcement_only: {
    token: 'enforcement_only', track: 'enforcement', tier: 'enforcement_only',
    label: 'Operator Starter', formerly: 'Enforcement-Only',
  },
}

// The four cards the picker shows, in order. `enforcement_only` is
// absent on purpose — it is an alias, not a fifth product.
export const PICKER_TOKENS: PlanToken[] = [
  'pm_starter', 'pm_pro', 'operator_starter', 'operator_pro',
]

export const DEFAULT_TOKEN: PlanToken = 'operator_starter'

export function isPlanToken(v: unknown): v is PlanToken {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PLANS, v)
}

export function planFor(token: PlanToken): Plan {
  return PLANS[token]
}

/** The display name, with the transition label when it is switched on. */
export function displayName(token: PlanToken): string {
  const p = PLANS[token]
  return FORMERLY_LABELS_ON && p.formerly ? `${p.label} (formerly ${p.formerly})` : p.label
}

export function resolveInitialToken(search: string | null | undefined): PlanToken {
  if (!search) return DEFAULT_TOKEN
  let raw: string | null
  try {
    raw = new URLSearchParams(search).get('tier')
  } catch {
    return DEFAULT_TOKEN
  }
  if (raw === null) return DEFAULT_TOKEN
  const v = raw.trim()
  return isPlanToken(v) ? v : DEFAULT_TOKEN
}

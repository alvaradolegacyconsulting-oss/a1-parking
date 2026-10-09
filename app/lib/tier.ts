import { FeatureFlag, FEATURE_FLAGS, isNumericFlag } from './feature-flags'
import { TIER_CONFIG, TIER_LADDER, Tier, TierType } from './tier-config'
import { tokenFor, PLANS } from './signup-tier-param'
import { supabase } from '../supabase'

export type { FeatureFlag, Tier, TierType }

// ───────────────────────────────────────────────────────────────────────
// Legacy localStorage helpers — kept for backward compatibility. New code
// should call hasFeature(flag, getCompanyContext()).
// ───────────────────────────────────────────────────────────────────────

export function getTier(): string {
  return (typeof window !== 'undefined' && localStorage.getItem('company_tier')) || 'legacy'
}

export function getTierType(): string {
  const raw = (typeof window !== 'undefined' && localStorage.getItem('company_tier_type')) || 'enforcement'
  // Normalize legacy 'pm' value to canonical 'property_management'.
  return raw === 'pm' ? 'property_management' : raw
}

export function isEnforcement(): boolean { return getTierType() === 'enforcement' }
export function isPropertyManagement(): boolean { return getTierType() === 'property_management' }

export function isStarter(): boolean { return isEnforcement() && getTier() === 'starter' }
export function isGrowth(): boolean { return isEnforcement() && getTier() === 'growth' }
export function isLegacy(): boolean { return isEnforcement() && getTier() === 'legacy' }

export function isEssential(): boolean { return isPropertyManagement() && getTier() === 'essential' }
export function isProfessional(): boolean { return isPropertyManagement() && getTier() === 'professional' }
export function isEnterprise(): boolean { return isPropertyManagement() && getTier() === 'enterprise' }

// ───────────────────────────────────────────────────────────────────────
// Typed feature-flag API (Phase 1)
// ───────────────────────────────────────────────────────────────────────

export type ProposalCode = {
  id?: number
  code?: string
  status?: string
  feature_overrides?: Record<string, boolean | number> | null
  redeemed_at?: string | null
  expires_at?: string | null
}

export type CompanyContext = {
  tier: Tier | string
  tier_type: TierType | string
  proposal_code?: ProposalCode | null
}

const TIER_TYPE_ALIASES: Record<string, TierType> = {
  pm: 'property_management',
  property_management: 'property_management',
  enforcement: 'enforcement',
}

function normalizeTierType(value: string): TierType {
  return TIER_TYPE_ALIASES[value] || 'enforcement'
}

export function getCompanyContext(): CompanyContext {
  if (typeof window === 'undefined') {
    return { tier: 'legacy', tier_type: 'enforcement', proposal_code: null }
  }
  const tier = (localStorage.getItem('company_tier') || 'legacy') as Tier
  const tier_type = normalizeTierType(localStorage.getItem('company_tier_type') || 'enforcement')
  const raw = localStorage.getItem('company_proposal_code')
  let proposal_code: ProposalCode | null = null
  if (raw) {
    try { proposal_code = JSON.parse(raw) as ProposalCode } catch { proposal_code = null }
  }
  return { tier, tier_type, proposal_code }
}

// B147 3a — read cached company_id from localStorage. Populated by
// bootstrapCompanyContext after /login resolve (or post-activation
// path). Returns null if missing/invalid; callers degrade gracefully
// (e.g., B147 syncOnAdd sites skip the Stripe sync but the DB write
// already succeeded — renewal trim auto-heals next cycle). SSR-safe.
export function getCachedCompanyId(): number | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem('company_id')
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

// Resolve a flag value: proposal_code override > tier config > false.
// Numeric flags fall back to 0 (no allowance) when undefined.
export function hasFeature(flag: FeatureFlag, company: CompanyContext): boolean | number {
  const override = company.proposal_code?.feature_overrides?.[flag]
  if (override !== undefined && override !== null) return override

  const tierType = normalizeTierType(String(company.tier_type))
  const tierMap = TIER_CONFIG[tierType]
  const config = tierMap?.[String(company.tier)]
  if (!config) return isNumericFlag(flag) ? 0 : false

  const value = config[flag]
  if (value === undefined) return isNumericFlag(flag) ? 0 : false
  return value
}

// For numeric flags only — coerces booleans to 0 and returns -1 for unlimited.
export function getLimit(flag: FeatureFlag, company: CompanyContext): number {
  const value = hasFeature(flag, company)
  if (typeof value === 'number') return value
  return 0
}

// True only if the user is *under* the limit (count + 1 still allowed),
// or the flag is unlimited (-1). Use at submit-time as a race guard.
// ════════════════════════════════════════════════════════════════════
// The PROPERTY ceiling is resolved by the SERVER, not by tier-config
// ════════════════════════════════════════════════════════════════════
//
// 🔴 tier-config.ts carries MAX_PROPERTIES = -1 for enforcement_only
// and legacy. That was true until the 2026-10-02 ceiling migration and
// is now WRONG — the database caps those tiers at 50, so a client that
// trusts the config lets a customer fill in an add-property form and
// then meets a raw Postgres cap error.
//
// Writing 50 into tier-config instead would be a THIRD copy of a number
// that already lives in two places, and would STILL be wrong for A1,
// whose proposal-code override is -1 and who must stay uncapped in the
// UI as well.
//
// So the client asks the server, and the server answers with the same
// precedence the trigger applies — override first, then tier default.
// One rule, one place.
//
// Returns null when it cannot resolve. The caller must then NOT block:
// the database is still enforcing, and refusing a legitimate customer
// because a lookup failed is the worse error. Fail-open in the UI,
// fail-closed in the DB.
export async function getEffectivePropertyLimit(companyName: string): Promise<number | null> {
  if (!companyName || !companyName.trim()) return null
  const { data, error } = await supabase.rpc('get_effective_property_limit', { p_company_name: companyName })
  if (error) {
    console.error('[tier] get_effective_property_limit failed:', error.message)
    return null
  }
  return typeof data === 'number' ? data : null
}

/** Negative is unlimited — the trigger's own convention. */
export function limitIsUnlimited(limit: number | null): boolean {
  return limit === null || limit < 0
}

export function isUnderLimit(flag: FeatureFlag, count: number, company: CompanyContext): boolean {
  const limit = getLimit(flag, company)
  if (limit < 0) return true
  return count < limit
}

// Async path — fetches company + redeemed proposal_code from DB. Use when
// you don't have the cached company context (e.g., server-side helpers).
export async function hasFeatureAsync(flag: FeatureFlag, companyId: number): Promise<boolean | number> {
  const { data: company } = await supabase
    .from('companies')
    .select('id, tier, tier_type')
    .eq('id', companyId)
    .single()
  if (!company) return isNumericFlag(flag) ? 0 : false

  const { data: pc } = await supabase
    .from('proposal_codes_summary')
    .select('feature_overrides')
    .eq('company_id', companyId)
    .eq('status', 'redeemed')
    .maybeSingle()

  return hasFeature(flag, {
    tier: (company.tier as string) || 'legacy',
    tier_type: (company.tier_type as string) || 'enforcement',
    proposal_code: pc ? { feature_overrides: pc.feature_overrides as Record<string, boolean | number> } : null,
  })
}

// User-facing upgrade prompt: walks up the tier ladder, finds the lowest
// tier that grants the flag, returns its display name and base price.
// Returns null if the user is already on the top tier or no upgrade helps.
export function getUpgradePrompt(
  flag: FeatureFlag,
  currentTier: Tier | string,
  tierType: TierType | string,
): { message: string; targetTier: Tier } | null {
  const tt = normalizeTierType(String(tierType))
  const ladder = TIER_LADDER[tt]
  const tierMap = TIER_CONFIG[tt]
  const currentIdx = ladder.indexOf(currentTier as Tier)
  if (currentIdx < 0 || currentIdx >= ladder.length - 1) return null

  const currentValue = tierMap?.[String(currentTier)]?.[flag]

  // If current tier already grants the flag (boolean true, or unlimited
  // numeric), no upgrade is needed.
  if (isNumericFlag(flag)) {
    if (typeof currentValue === 'number' && currentValue < 0) return null
  } else {
    if (currentValue === true) return null
  }

  for (let i = currentIdx + 1; i < ladder.length; i++) {
    const candidate = ladder[i]
    // B89: skip candidates with no published price (contact-sales tiers
    // like Enforcement Premium). They have entries in TIER_LADDER and
    // TIER_DISPLAY_NAME but are deliberately absent from TIER_PRICING —
    // surfacing them as a "$0/mo" upgrade target would be garbage. Sales-
    // driven contact path lives outside this self-serve upgrade prompt.
    // 2026-09-04 shape change: TIER_PRICING is { base, perProperty }.
    // base can be null (contact-sales / negotiated — Premium, Legacy).
    // Skip candidates with no PUBLISHED base — surfacing "$0/mo" as an
    // upgrade target would be garbage (B89 rule generalized: applies to
    // both explicit null AND undefined entries).
    // tt is a runtime TierType; use getTierPricing to widen the
    // per-track union at the call site (ladder[i] came from the same
    // table so the lookup is always safe at runtime).
    // ════════════════════════════════════════════════════════════
    // 🔴 READ THIS BEFORE ADDING A PRO TIER TO TIER_LADDER
    // ════════════════════════════════════════════════════════════
    // TIER_PRICING IS NOT A PRICE LIST. It is a stale internal map.
    // Its `legacy` entry still reads { base: 199, perProperty: 0 }
    // while Operator Pro is $299 + $20/property and PM Pro is $249 +
    // $15 — the exact discrepancy that, on 2026-10-02, had /signup
    // advertising $199 for a subscription Stripe then billed at $339.
    // Caught in a live run before anyone paid.
    //
    // This call site is SAFE ONLY BY ACCIDENT: TIER_LADDER is a
    // single-element array per track, so the loop never reaches a
    // second candidate and no price is ever surfaced. The moment a Pro
    // tier is added to that ladder — which launching self-serve Pro
    // invites — this line starts quoting $199 as an upgrade price in
    // the CA portal.
    //
    // 🔴 WHEN YOU ADD THE LADDER STEP: price it through
    // /api/signup/quote (app/lib/pricing-quote.ts), which reads the
    // stripe_prices catalog Checkout charges from. Do not read a price
    // out of TIER_PRICING. The quote endpoint takes a plan token, a
    // cycle and a property count and returns total_cents.
    // 🔴 2026-10-09 — LEGACY IS NEVER AN UPGRADE TARGET.
    //
    // There is no self-serve upgrade INTO a Pro plan from this prompt:
    // Pro is bought at /signup, and the step above Pro is Elite, which
    // is contact-sales. So a `legacy` candidate has no upgrade price to
    // quote — TIER_PRICING's stale 199 was the only thing that made it
    // look like it did.
    //
    // Removing the path rather than repointing it at the quote endpoint:
    // a correct price for an upgrade that cannot be bought here is still
    // the wrong thing to show. TIER_LADDER is single-element per track
    // so no candidate is reachable today either; this makes the
    // dangerous one impossible rather than merely unreachable.
    if (candidate === 'legacy') continue

    // 🔴 2026-10-10 — NO PRICE IN THIS MESSAGE, and TIER_PRICING is gone.
    //
    // Pricing an upgrade needs a cycle and a property count, and this
    // helper has neither — it knows only a tier. TIER_PRICING supplied
    // a number that needed neither because it was a flat lie: its
    // `legacy` entry read 199 while Operator Pro is $299 + $20.
    //
    // Callers render `upgrade.message` only, so targetPrice is removed
    // from the return type rather than typed as null — a field nobody
    // reads is a field that invites someone to start. If a priced upgrade prompt is
    // ever wanted, it goes through /api/signup/quote with a real cycle.
    const value = tierMap?.[candidate]?.[flag]
    let qualifies = false
    if (isNumericFlag(flag)) {
      const c = typeof currentValue === 'number' ? currentValue : 0
      const v = typeof value === 'number' ? value : 0
      qualifies = v < 0 || v > c
    } else {
      qualifies = value === true
    }
    if (qualifies) {
      // 🔴 Never the raw tier key. `?? candidate` used to print
      // `legacy` or `pm_only` at a customer; tokenFor() resolves the
      // (track, tier) pair to the public plan name, and an unmapped
      // pair falls back to the track.
      const upgradeToken = tokenFor(tt, candidate)
      const display = upgradeToken
        ? PLANS[upgradeToken].label
        : (tt === 'property_management' ? 'Property Management' : 'Enforcement')
      const message = isNumericFlag(flag)
        ? `Upgrade to ${display} to expand this limit.`
        : `Upgrade to ${display} to enable this feature.`
      return { message, targetTier: candidate }
    }
  }
  return null
}

// Re-export for convenience
export { FEATURE_FLAGS }

// Legacy string-keyed hasFeature — DEPRECATED. Maps to the matrix when
// possible, returns false otherwise. Kept so callers from earlier phases
// don't break. New code: use the typed hasFeature(flag, company) above.
const LEGACY_FEATURE_ALIAS: Record<string, FeatureFlag | null> = {
  violations: FEATURE_FLAGS.VIOLATION_DOCUMENTATION,
  plate_lookup: FEATURE_FLAGS.AI_PLATE_SCANNING,
  tow_tickets: FEATURE_FLAGS.TOW_TICKET_GENERATION,
  audit_log: FEATURE_FLAGS.AUDIT_LOGS,
  visitor_passes: FEATURE_FLAGS.VISITOR_PASS_MANAGEMENT,
  reports: FEATURE_FLAGS.ADVANCED_ANALYTICS,
  bulk_upload: null,
  multi_property: null,
  residents: FEATURE_FLAGS.RESIDENT_MANAGEMENT,
  vehicle_approval: null,
  qr_codes: null,
}

export function hasFeatureLegacy(feature: string): boolean {
  const flag = LEGACY_FEATURE_ALIAS[feature]
  if (!flag) return false
  const result = hasFeature(flag, getCompanyContext())
  return result === true || (typeof result === 'number' && result !== 0)
}

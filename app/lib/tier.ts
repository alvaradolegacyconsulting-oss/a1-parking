import { FeatureFlag, FEATURE_FLAGS, isNumericFlag } from './feature-flags'
import { TIER_CONFIG, TIER_PRICING, TIER_LADDER, TIER_DISPLAY_NAME, Tier, TierType } from './tier-config'
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
): { message: string; targetTier: Tier; targetPrice: number } | null {
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
      const price = TIER_PRICING[tt]?.[candidate] ?? 0
      const display = TIER_DISPLAY_NAME[tt]?.[candidate] ?? candidate
      const message = isNumericFlag(flag)
        ? `Upgrade to ${display} ($${price}/mo) to expand this limit.`
        : `Upgrade to ${display} ($${price}/mo) to enable this feature.`
      return { message, targetTier: candidate, targetPrice: price }
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

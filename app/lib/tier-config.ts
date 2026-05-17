// ════════════════════════════════════════════════════════════════════
// Tier Matrix v1 — locked May 7, 2026.
// SOURCE OF TRUTH for client-side feature gating. Edit via PR only.
//
// ⚠ NUMERIC LIMITS (max_properties, etc.) are mirrored in the SQL
//   function get_company_property_limit() in
//   migrations/20260508_phase1_tier_enforcement.sql. If you change a
//   numeric limit here, change it there too. Phase 2 will move limits
//   into a tier_limits DB table to eliminate this drift risk.
// ════════════════════════════════════════════════════════════════════

import { FEATURE_FLAGS, FeatureFlag } from './feature-flags'

export type TierType = 'enforcement' | 'property_management'
export type EnforcementTier = 'starter' | 'growth' | 'legacy'
export type PropertyManagementTier = 'essential' | 'professional' | 'enterprise'
export type Tier = EnforcementTier | PropertyManagementTier

export type TierConfigShape = Record<FeatureFlag, boolean | number>

const F = FEATURE_FLAGS

// Enforcement: starter ─────────────────────────────────────────────────
const ENF_STARTER: TierConfigShape = {
  [F.MAX_PROPERTIES]: 5,
  [F.MAX_DRIVERS]: 3,
  [F.MAX_VISITOR_PASSES_PER_PROPERTY_MONTH]: 0,
  [F.MAX_VISITOR_PASS_DURATION_HOURS]: 0,
  // Phase 2a: video uploads allowed at 30s on starter (matches Q2 decision).
  [F.VIDEO_MAX_DURATION_SECONDS]: 30,
  // B42: photo count cap per violation. Starter = 3.
  [F.MAX_PHOTOS_PER_VIOLATION]: 3,

  // enforcement core
  [F.AI_PLATE_SCANNING]: true,
  [F.VIOLATION_DOCUMENTATION]: true,
  [F.TOW_TICKET_GENERATION]: true,
  [F.TOWING_AUTHORIZATION_UI]: true,
  [F.DRIVER_PORTAL]: true,
  [F.STORAGE_FACILITY_MANAGEMENT]: true,
  [F.PHOTO_UPLOADS]: true,
  [F.DISPUTE_REQUESTS]: true,
  [F.FINDMYTOWEDCAR_LINKS]: true,
  [F.CSV_EXPORT_BASIC]: true,

  // cross-track core
  [F.RESIDENT_MANAGEMENT]: true,
  [F.VISITOR_PASS_MANAGEMENT]: true,
  [F.MANAGER_PORTAL]: true,
  [F.AUDIT_LOGS]: true,
  [F.CUSTOM_LOGO_BRANDING]: true,
  [F.MOBILE_FRIENDLY_PORTALS]: true,
  [F.BASIC_DASHBOARDS]: true,
  [F.EMAIL_SUPPORT]: true,

  // PM-only flags (false on enforcement track)
  [F.PROPERTY_MANAGEMENT]: false,
  [F.RESIDENT_SELF_REGISTRATION]: false,
  [F.VISITOR_PASS_SELF_SERVICE]: false,
  [F.RESIDENT_PORTAL]: false,
  [F.VEHICLE_REGISTRY]: false,
  [F.MULTIPLE_MANAGERS_PER_PROPERTY]: false,
  // B75 (was B70 PM_PLATE_LOOKUP=false): manual plate lookup is a baseline
  // utility, not a competitive feature. Available on all enforcement tiers
  // — gating Starter out would hurt the weakest customers most. Pricing
  // differentiation lives in AI_PLATE_SCANNING + violation workflow + tow
  // tickets + evidence capture. Inherits to ENF_GROWTH + ENF_LEGACY.
  [F.MANAGER_PLATE_LOOKUP]: true,

  // tiered
  [F.LEASING_AGENT_ROLE]: false,
  [F.ADVANCED_ANALYTICS]: false,
  [F.CUSTOM_DATE_RANGE_EXPORTS]: false,
  [F.ADVANCED_PDF_REPORTS]: false,
  [F.TOWBOOK_CSV_EXPORT]: false,
  [F.API_ACCESS_READ_ONLY]: false,
  [F.VIDEO_UPLOADS_LIMITED]: false,
  [F.VIDEO_UPLOADS_FULL]: false,
  [F.PRIORITY_SUPPORT]: false,
  [F.DEDICATED_ACCOUNT_MANAGER]: false,
}

// Enforcement: growth ──────────────────────────────────────────────────
const ENF_GROWTH: TierConfigShape = {
  ...ENF_STARTER,
  [F.MAX_PROPERTIES]: 15,
  [F.MAX_DRIVERS]: 10,
  // Phase 2a: growth and legacy both allow 60s video.
  [F.VIDEO_MAX_DURATION_SECONDS]: 60,
  // B42: photo cap on Growth = 10.
  [F.MAX_PHOTOS_PER_VIOLATION]: 10,

  [F.LEASING_AGENT_ROLE]: true,
  [F.ADVANCED_ANALYTICS]: true,
  [F.CUSTOM_DATE_RANGE_EXPORTS]: true,
  [F.TOWBOOK_CSV_EXPORT]: true,
  [F.VIDEO_UPLOADS_LIMITED]: true,
}

// Enforcement: legacy ──────────────────────────────────────────────────
const ENF_LEGACY: TierConfigShape = {
  ...ENF_GROWTH,
  [F.MAX_PROPERTIES]: -1,
  [F.MAX_DRIVERS]: -1,
  // B42: legacy bumps video duration from inherited 60s → 120s, and
  // photo cap from inherited 10 → unlimited. BOTH must be explicit
  // overrides because spread-inheritance from ENF_GROWTH carries 60s
  // and 10. Same gotcha as Phase 2a's video override pattern.
  [F.VIDEO_MAX_DURATION_SECONDS]: 120,
  [F.MAX_PHOTOS_PER_VIOLATION]: -1,

  [F.ADVANCED_PDF_REPORTS]: true,
  [F.API_ACCESS_READ_ONLY]: true,
  [F.VIDEO_UPLOADS_LIMITED]: false, // matrix: legacy = full only, limited off
  [F.VIDEO_UPLOADS_FULL]: true,
  [F.PRIORITY_SUPPORT]: true,
  [F.DEDICATED_ACCOUNT_MANAGER]: true,
}

// PM: essential ────────────────────────────────────────────────────────
const PM_ESSENTIAL: TierConfigShape = {
  [F.MAX_PROPERTIES]: 3,
  [F.MAX_DRIVERS]: 0,
  [F.MAX_VISITOR_PASSES_PER_PROPERTY_MONTH]: 50,
  [F.MAX_VISITOR_PASS_DURATION_HOURS]: 12,
  // Phase 2a: PM tiers don't have driver/violation/video workflow.
  // 0 means "no video allowed on this track". Inherited by professional + enterprise.
  [F.VIDEO_MAX_DURATION_SECONDS]: 0,
  // B42: photo cap = 3 on all PM tiers. Present-but-dead — PM has
  // no driver violation submission surface today, but populating the
  // value keeps the matrix self-documenting and survives any future
  // PM submission workflow addition. Inherited by professional + enterprise.
  [F.MAX_PHOTOS_PER_VIOLATION]: 3,

  // PM-only core
  [F.PROPERTY_MANAGEMENT]: true,
  [F.RESIDENT_SELF_REGISTRATION]: true,
  [F.VISITOR_PASS_SELF_SERVICE]: true,
  [F.RESIDENT_PORTAL]: true,
  [F.VEHICLE_REGISTRY]: true,
  [F.MULTIPLE_MANAGERS_PER_PROPERTY]: true,
  // B75 (was B70 PM_PLATE_LOOKUP=true): manual plate lookup, all PM tiers.
  // Renamed for cross-track consistency — same flag is now also true on
  // every enforcement tier (see ENF_STARTER above). Inherits to
  // PM_PROFESSIONAL + PM_ENTERPRISE via spread.
  [F.MANAGER_PLATE_LOOKUP]: true,

  // cross-track core
  [F.RESIDENT_MANAGEMENT]: true,
  [F.VISITOR_PASS_MANAGEMENT]: true,
  [F.MANAGER_PORTAL]: true,
  [F.AUDIT_LOGS]: true,
  [F.CUSTOM_LOGO_BRANDING]: true,
  [F.MOBILE_FRIENDLY_PORTALS]: true,
  [F.BASIC_DASHBOARDS]: true,
  [F.EMAIL_SUPPORT]: true,

  // enforcement-track flags — explicitly false per matrix
  [F.AI_PLATE_SCANNING]: false,
  [F.VIOLATION_DOCUMENTATION]: false,
  [F.TOW_TICKET_GENERATION]: false,
  [F.TOWING_AUTHORIZATION_UI]: false,
  [F.DRIVER_PORTAL]: false,
  [F.STORAGE_FACILITY_MANAGEMENT]: false,
  [F.PHOTO_UPLOADS]: false,
  [F.DISPUTE_REQUESTS]: false,
  [F.FINDMYTOWEDCAR_LINKS]: false,
  [F.CSV_EXPORT_BASIC]: false,
  [F.TOWBOOK_CSV_EXPORT]: false,
  [F.API_ACCESS_READ_ONLY]: false,
  [F.VIDEO_UPLOADS_LIMITED]: false,
  [F.VIDEO_UPLOADS_FULL]: false,

  // tiered
  [F.LEASING_AGENT_ROLE]: false,
  [F.ADVANCED_ANALYTICS]: false,
  [F.CUSTOM_DATE_RANGE_EXPORTS]: false,
  [F.ADVANCED_PDF_REPORTS]: false,
  [F.PRIORITY_SUPPORT]: false,
  [F.DEDICATED_ACCOUNT_MANAGER]: false,
}

// PM: professional ─────────────────────────────────────────────────────
const PM_PROFESSIONAL: TierConfigShape = {
  ...PM_ESSENTIAL,
  [F.MAX_PROPERTIES]: 10,
  [F.MAX_VISITOR_PASSES_PER_PROPERTY_MONTH]: 200,
  [F.MAX_VISITOR_PASS_DURATION_HOURS]: 24,

  [F.LEASING_AGENT_ROLE]: true,
  [F.ADVANCED_ANALYTICS]: true,
  [F.CUSTOM_DATE_RANGE_EXPORTS]: true,
}

// PM: enterprise ───────────────────────────────────────────────────────
const PM_ENTERPRISE: TierConfigShape = {
  ...PM_PROFESSIONAL,
  [F.MAX_PROPERTIES]: -1,
  [F.MAX_VISITOR_PASSES_PER_PROPERTY_MONTH]: -1,
  [F.MAX_VISITOR_PASS_DURATION_HOURS]: 48,

  [F.ADVANCED_PDF_REPORTS]: true,
  [F.PRIORITY_SUPPORT]: true,
  [F.DEDICATED_ACCOUNT_MANAGER]: true,
}

export const TIER_CONFIG: Record<TierType, Record<string, TierConfigShape>> = {
  enforcement: {
    starter: ENF_STARTER,
    growth: ENF_GROWTH,
    legacy: ENF_LEGACY,
  },
  property_management: {
    essential: PM_ESSENTIAL,
    professional: PM_PROFESSIONAL,
    enterprise: PM_ENTERPRISE,
  },
}

// Pricing (base monthly fees) — referenced by getUpgradePrompt(). Kept
// separate from TIER_CONFIG so feature flags stay free of dollar amounts.
// Matches Pricing v2 (May 8, 2026). If pricing changes, also update the
// landing page tiers in app/page.tsx.
export const TIER_PRICING: Record<TierType, Record<string, number>> = {
  enforcement: { starter: 129, growth: 149, legacy: 199 },
  property_management: { essential: 129, professional: 199, enterprise: 279 },
}

export const TIER_LADDER: Record<TierType, Tier[]> = {
  enforcement: ['starter', 'growth', 'legacy'],
  property_management: ['essential', 'professional', 'enterprise'],
}

export const TIER_DISPLAY_NAME: Record<TierType, Record<string, string>> = {
  enforcement: { starter: 'Starter', growth: 'Growth', legacy: 'Legacy' },
  property_management: { essential: 'Essential', professional: 'Professional', enterprise: 'Enterprise' },
}

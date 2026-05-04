export function getTier(): string {
  return (typeof window !== 'undefined' && localStorage.getItem('company_tier')) || 'legacy'
}

export function getTierType(): string {
  return (typeof window !== 'undefined' && localStorage.getItem('company_tier_type')) || 'enforcement'
}

export function isEnforcement(): boolean { return getTierType() === 'enforcement' }
export function isPropertyManagement(): boolean { return getTierType() === 'property_management' }

// Enforcement tiers
export function isStarter(): boolean { return isEnforcement() && getTier() === 'starter' }
export function isGrowth(): boolean { return isEnforcement() && getTier() === 'growth' }
export function isLegacy(): boolean { return isEnforcement() && getTier() === 'legacy' }

// Property management tiers
export function isEssential(): boolean { return isPropertyManagement() && getTier() === 'essential' }
export function isProfessional(): boolean { return isPropertyManagement() && getTier() === 'professional' }
export function isEnterprise(): boolean { return isPropertyManagement() && getTier() === 'enterprise' }

const ENFORCEMENT_FEATURES: Record<string, string[]> = {
  starter:  ['violations', 'plate_lookup', 'tow_tickets', 'audit_log'],
  growth:   ['violations', 'plate_lookup', 'tow_tickets', 'audit_log', 'visitor_passes', 'reports'],
  legacy:   ['violations', 'plate_lookup', 'tow_tickets', 'audit_log', 'visitor_passes', 'reports', 'bulk_upload', 'multi_property'],
}

const PM_FEATURES: Record<string, string[]> = {
  essential:    ['violations', 'plate_lookup', 'visitor_passes', 'residents', 'vehicle_approval'],
  professional: ['violations', 'plate_lookup', 'visitor_passes', 'residents', 'vehicle_approval', 'reports', 'qr_codes'],
  enterprise:   ['violations', 'plate_lookup', 'visitor_passes', 'residents', 'vehicle_approval', 'reports', 'qr_codes', 'bulk_upload', 'multi_property', 'audit_log'],
}

export function hasFeature(feature: string): boolean {
  const type = getTierType()
  const tier = getTier()
  const map = type === 'property_management' ? PM_FEATURES : ENFORCEMENT_FEATURES
  return (map[tier] || []).includes(feature)
}

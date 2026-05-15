// B65.2: shared tier-card display data. Single source of truth for the
// marketing surfaces — currently consumed by the landing page (app/page.tsx)
// and the /signup placeholder. When pricing changes, edit it once here.
//
// This module is for DISPLAY only. Runtime tier capability checks live in
// app/lib/tier.ts (hasFeature, getLimit) and app/lib/tier-config.ts (the
// tier matrix). Do not derive runtime behavior from these arrays.

export type TierTrack = 'enforcement' | 'pm'

export type TierDisplay = {
  name: string
  base: number
  perProp: number
  perDriver?: number
  popular?: boolean
  // Legacy attributes from earlier landing-page iterations. Kept on the type
  // because dead-code render branches in app/page.tsx still reference them.
  // No current tier sets `enterprise: true` or `badge`; deletion deferred to
  // a dedicated landing-page cleanup commit per B62 scope guard.
  enterprise?: boolean
  badge?: string
  features: string[]
}

// B55 — testimonials were removed and three Enf Legacy / PM Enterprise features
// were rewritten away from overpromised claims (white-label / custom integrations /
// dedicated account manager). B62 left this data shape in place.
export const ENFORCEMENT_TIERS: TierDisplay[] = [
  {
    name: 'Starter', base: 129, perProp: 15, perDriver: 10,
    features: ['Up to 3 properties', 'Unlimited violations', 'QR code registration', 'Resident portal', 'Visitor pass system', 'Driver app access', 'Email support'],
  },
  {
    name: 'Growth', base: 149, perProp: 12, perDriver: 8, popular: true,
    features: ['Up to 10 properties', 'Everything in Starter', 'Analytics dashboard', 'Bulk CSV upload', 'Dispute management', 'Priority email support'],
  },
  {
    name: 'Legacy', base: 199, perProp: 10, perDriver: 6,
    features: ['Unlimited properties', 'Everything in Growth', 'Custom logo on tow tickets and resident pages', 'Advanced analytics', 'Towbook CSV export', 'Dedicated escalation path', 'Priority email support'],
  },
  // B55 removed Enterprise as a 4th Enf tier — replaced by the Enterprise-scale
  // callout below the pricing grid on the landing page.
]

export const PROPERTY_MANAGEMENT_TIERS: TierDisplay[] = [
  {
    name: 'Essential', base: 129, perProp: 20,
    features: ['Up to 3 properties', 'Resident portal', 'Visitor pass system', 'QR code registration', 'Manager dashboard', 'Email support'],
  },
  {
    name: 'Professional', base: 199, perProp: 15, popular: true,
    features: ['Up to 10 properties', 'Everything in Essential', 'Analytics dashboard', 'Registration QR codes', 'Dispute management', 'Priority email support'],
  },
  {
    name: 'Enterprise', base: 279, perProp: 10,
    features: ['Unlimited properties', 'Everything in Professional', 'Custom logo on tow tickets and resident pages', 'Towbook CSV export', 'Dedicated escalation path', 'Priority email support'],
  },
]

export function tiersForTrack(track: TierTrack): TierDisplay[] {
  return track === 'enforcement' ? ENFORCEMENT_TIERS : PROPERTY_MANAGEMENT_TIERS
}

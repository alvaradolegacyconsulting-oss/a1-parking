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
  // base + perProp are optional because contact-sales tiers (enterprise:
  // true) don't have published prices — the `tier.enterprise ?` render
  // branch in app/page.tsx renders "Let's talk" without reading these
  // fields. Non-contact-sales tiers (the existing six) all set them.
  base?: number
  perProp?: number
  perDriver?: number
  popular?: boolean
  // B89 (was B55-era legacy): `enterprise: true` triggers the contact-sales
  // render branch (no published price, "Let's talk" headline, "Contact us →"
  // CTA). Currently used by Enforcement Premium. PM Enterprise is NOT a
  // contact-sales card — it has real pricing and does not set this flag.
  // `badge` is unused today but kept for forward-compat per the B62 scope guard.
  enterprise?: boolean
  badge?: string
  features: string[]
}

// B55 — testimonials were removed and three Enf Legacy / PM Enterprise features
// were rewritten away from overpromised claims (white-label / custom integrations /
// dedicated account manager). B62 left this data shape in place.
//
// 2026-06-17 site cleanup — dispute-management product feature retired (architecturally
// wrong; real disputes go through legal channels off-system, not PM-mediated). Towbook
// CSV de-branded to "Tow records CSV export" (data portability, no third-party tool
// name). Custom-logo-on-tow-tickets claim removed — logo is universal, not tier-gated;
// keeping it as a tier differentiator misrepresented the product. Analytics terminology
// collapsed to one canonical phrase: "Advanced analytics" appears once at the unlock
// tier (Growth, Professional); upper tiers inherit via "Everything in [prev]".
export const ENFORCEMENT_TIERS: TierDisplay[] = [
  {
    name: 'Starter', base: 129, perProp: 15, perDriver: 10,
    features: ['Up to 3 properties', 'Unlimited violations', 'QR code registration', 'Resident portal', 'Visitor pass system', 'Driver app access', 'Email support'],
  },
  {
    name: 'Growth', base: 149, perProp: 12, perDriver: 8, popular: true,
    features: ['Up to 10 properties', 'Everything in Starter', 'Advanced analytics', 'Bulk CSV upload', 'Tow records CSV export', 'Priority email support'],
  },
  {
    name: 'Legacy', base: 199, perProp: 10, perDriver: 6,
    features: ['Unlimited properties', 'Everything in Growth', 'Dedicated escalation path', 'Priority email support'],
  },
  {
    // B89: Premium — 4th Enforcement tier; contact-sales (no published
    // price). Renders via the existing `tier.enterprise: true` branch in
    // app/page.tsx (the dead-code path B55 left in place when Enterprise
    // was removed as a 4th tier). `base` / `perProp` deliberately omitted —
    // not rendered for this branch. PM Enterprise has real published pricing
    // and does NOT use this flag.
    name: 'Premium', enterprise: true,
    features: ['Everything in Legacy', 'Custom pricing for unusual operations', 'Dedicated account contact', 'Custom onboarding'],
  },
]

export const PROPERTY_MANAGEMENT_TIERS: TierDisplay[] = [
  {
    name: 'Essential', base: 129, perProp: 20,
    features: ['Up to 3 properties', 'Resident portal', 'Visitor pass system', 'QR code registration', 'Manager dashboard', 'Email support'],
  },
  {
    name: 'Professional', base: 199, perProp: 15, popular: true,
    features: ['Up to 10 properties', 'Everything in Essential', 'Advanced analytics', 'Bulk CSV upload', 'Priority email support'],
  },
  {
    name: 'Enterprise', base: 279, perProp: 10,
    features: ['Unlimited properties', 'Everything in Professional', 'Dedicated escalation path', 'Priority email support'],
  },
]

export function tiersForTrack(track: TierTrack): TierDisplay[] {
  return track === 'enforcement' ? ENFORCEMENT_TIERS : PROPERTY_MANAGEMENT_TIERS
}

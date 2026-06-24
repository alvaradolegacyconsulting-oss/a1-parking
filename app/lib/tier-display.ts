// 3-Tier Pricing — single source of truth for marketing surfaces.
//
// Locked model (Jose 2026-06-24): ONE product, THREE offerings —
// PM-Only / Enforcement-Only / Legacy. Pricing = base (per tier) +
// per-property + per-reserved-space ($0.50, zero included). Visitor
// capacity is FREE + UNLIMITED (a metric, not billed). Drivers on
// enforcement tiers only.
//
// Working numbers: these reflect the locked model but may refine before
// public launch. Edit here — one file, single edit point. Landing page,
// /signup, and any future marketing surface all consume from this module.
//
// A1 is a per-account custom override (Legacy tier, $325 base, $0 add-ons)
// applied at the billing slice — NOT represented in this display config.
// The site shows the standard Legacy $349/$12/$0.50/$10 working numbers.
//
// This module is for DISPLAY only. Runtime tier capability checks live in
// app/lib/tier.ts (hasFeature, getLimit) and app/lib/tier-config.ts (the
// tier matrix). Do not derive runtime behavior from these arrays.

export type TierTrack = 'enforcement' | 'pm'   // kept for backwards-compat consumers

export type TierDisplay = {
  name: string
  // Optional because legacy contact-sales tiers (enterprise: true) had no
  // published price. All 3 new offerings DO publish prices.
  base?: number
  perProp?: number
  perDriver?: number     // undefined = "n/a" (PM-Only has no driver concept)
  perSpace?: number      // NEW — $0.50 universal across all 3 offerings, zero included
  perSpaceNote?: string  // optional caption rendered below the per-space line
  popular?: boolean
  enterprise?: boolean   // kept for forward-compat; NOT used by the 3 current offerings
  badge?: string         // unused today; forward-compat
  // NEW track-membership flags so the derived ENFORCEMENT_TIERS /
  // PROPERTY_MANAGEMENT_TIERS legacy exports can compute subsets for
  // /signup (which still uses the track-tabbed picker pre-billing).
  includesEnforcement: boolean
  includesPM: boolean
  features: string[]
  // Operator-focused framing — currently only Legacy uses this.
  // (The bid-winning operator pitch: full PM is how you close the deal;
  // you recover the cost in enforcement.)
  pitchLine?: string
}

// ── The canonical 3 offerings ────────────────────────────────────────

export const OFFERINGS: TierDisplay[] = [
  {
    name: 'PM-Only',
    base: 179,
    perProp: 20,
    perSpace: 0.50,
    perSpaceNote: '$0.50 per reserved space, zero included (pay-per-use)',
    includesEnforcement: false,
    includesPM: true,
    features: [
      'Resident portal',
      'Resident self-registration',
      'Self-serve visitor passes',
      'Detailed reporting & analytics',
      'Reserved space management',
      'Unlimited visitor capacity (free)',
      'Email support',
    ],
  },
  {
    name: 'Enforcement-Only',
    base: 199,
    perProp: 15,
    perSpace: 0.50,
    perDriver: 10,
    perSpaceNote: '$0.50 per reserved space, zero included (pay-per-use)',
    includesEnforcement: true,
    includesPM: false,
    features: [
      'Full enforcement (plate scan, video evidence, tow tickets)',
      'Driver mobile app + scan workflow',
      'QR-code visitor pass entry',
      'Manager-added residents',
      'Basic reporting',
      'Reserved space management',
      'Unlimited visitor capacity (free)',
      'Up to 3 property managers',
      'Email support',
    ],
  },
  {
    name: 'Legacy',
    base: 349,
    perProp: 12,
    perSpace: 0.50,
    perDriver: 10,
    perSpaceNote: '$0.50 per reserved space, zero included (pay-per-use)',
    popular: true,
    includesEnforcement: true,
    includesPM: true,
    pitchLine: 'The management features you give the properties you service are how you win their business — they get a full resident platform; you recover the cost in enforcement.',
    features: [
      'Everything in PM-Only AND Enforcement-Only',
      'Full PM functionality for serviced properties',
      'Full enforcement (plate scan, video, tow tickets)',
      'Resident self-registration + self-serve visitor passes',
      'Detailed reporting & analytics',
      'Higher property-manager allotment',
      'Reserved space management',
      'Unlimited visitor capacity (free)',
      'Priority email support',
      'Dedicated escalation path',
    ],
  },
]

// ── Backwards-compat exports for /signup pre-billing flow ────────────
//
// DEPRECATED — to be removed when the self-serve checkout flow (gated
// by stripe_billing_enabled + public_signup_open dormancy flags) gets
// restructured for the one-product / three-offering model.
//
// Today /signup splits its picker into two tabs (enforcement vs PM) and
// reads these arrays. Pre-launch the dormancy flag keeps that flow in
// its "Coming soon" placeholder branch, so the deprecated exports stay
// compiling without rendering wrong content to users.
//
// PM-Only appears under PM tab; Enforcement-Only under Enforcement; Legacy
// (which spans both) appears under BOTH — fine semantically (a Legacy
// subscriber gets both capabilities) and irrelevant pre-billing since
// /signup self-serve isn't open yet.

export const ENFORCEMENT_TIERS: TierDisplay[] = OFFERINGS.filter(o => o.includesEnforcement)
export const PROPERTY_MANAGEMENT_TIERS: TierDisplay[] = OFFERINGS.filter(o => o.includesPM)

export function tiersForTrack(track: TierTrack): TierDisplay[] {
  return track === 'enforcement' ? ENFORCEMENT_TIERS : PROPERTY_MANAGEMENT_TIERS
}

// ── Feature-split comparison table (rendered on landing) ─────────────
//
// Per Jose's spec 2026-06-24. Shared as a const so a future docs page
// or sales sheet can render the same data without duplication.

export type ComparisonRow = {
  capability: string
  pmOnly:           string  // — / ✓ / value
  enforcementOnly:  string
  legacy:           string
}

export const FEATURE_COMPARISON: ComparisonRow[] = [
  { capability: 'Full enforcement (plate scan, video, tow tickets)',
    pmOnly: '—',                   enforcementOnly: '✓',                  legacy: '✓' },
  { capability: 'Resident portal',
    pmOnly: '✓',                   enforcementOnly: '—',                  legacy: '✓' },
  { capability: 'Resident self-registration',
    pmOnly: '✓',                   enforcementOnly: 'Manager adds',       legacy: '✓' },
  { capability: 'Visitor passes',
    pmOnly: 'Self-serve',          enforcementOnly: 'QR code only',       legacy: 'Self-serve' },
  { capability: 'Detailed reporting / analytics',
    pmOnly: '✓',                   enforcementOnly: 'Basic only',         legacy: '✓' },
  { capability: 'Reserved spaces',
    pmOnly: '✓ ($0.50/space)',     enforcementOnly: '✓ ($0.50/space)',    legacy: '✓ ($0.50/space)' },
  { capability: 'Visitor capacity',
    pmOnly: 'Unlimited (free)',    enforcementOnly: 'Unlimited (free)',   legacy: 'Unlimited (free)' },
  { capability: 'Property managers',
    pmOnly: 'Included allotment',  enforcementOnly: '3',                  legacy: 'Higher allotment' },
]

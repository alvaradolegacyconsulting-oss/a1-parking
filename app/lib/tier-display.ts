// 3-Tier Pricing — single source of truth for marketing surfaces.
//
// Current model (Jose 2026-07-02 update):
//   PM-Only          — $179/mo base + $20/mo per property + graduated
//                      per-approved-permit meter (2.00 → 1.75 → 1.50 →
//                      1.25 across 1-50 / 51-200 / 201-500 / 501+).
//                      Reserved spaces are INCLUDED (no per-space fee).
//                      No property-manager cap. No driver concept.
//   Enforcement-Only — $199/mo base + $15/mo per property. No permit
//                      meter, no per-driver fee, no per-space fee. No
//                      property-manager cap. Enforcement doesn't have
//                      reserved-space management (PM feature).
//   Legacy           — CUSTOM PRICING via proposal code. Do NOT publish
//                      numbers on marketing surfaces (Jose 2026-07-02
//                      lock — Legacy price is hidden; CTA is "Request a
//                      proposal").
//
// RETIRED (Jose 2026-07-02):
//   - per-driver fee — no per-driver charge on any offering.
//   - per-reserved-space fee ($0.50) — reserved spaces are included
//     at no additional cost.
//   - "Up to N property managers" cap — no cap on any offering.
//   - "Most Popular" badge on Legacy — Legacy is a custom deal, not a
//     popular-choice standard tier.
//   - Legacy pitchLine ("bid-winning operator" blurb) — removed.
//
// Edit here — one file, single edit point. Landing page, /signup, and
// any future marketing surface all consume from this module.
//
// A1 is a per-account custom override applied at the billing slice —
// NOT represented in this display config.
//
// This module is for DISPLAY only. Runtime tier capability checks live in
// app/lib/tier.ts (hasFeature, getLimit) and app/lib/tier-config.ts (the
// tier matrix). Do not derive runtime behavior from these arrays.

export type TierTrack = 'enforcement' | 'pm'   // kept for backwards-compat consumers

// Graduated per-permit meter (PM-Only only). Each band: bill at
// `ratePerPermit` for permits in the range (previous band's upTo, upTo].
// Trailing band has upTo=null (∞).
export type PermitBand = {
  upTo: number | null
  ratePerPermit: number
}

export type TierDisplay = {
  name: string
  // Optional because Legacy hides its price on marketing surfaces
  // (customPrice: true replaces the numeric with "Custom pricing").
  base?: number
  perProp?: number
  // PM-Only per-approved-permit graduated meter. Rendered as a small
  // table under the base + per-property lines when present.
  permitTiers?: PermitBand[]
  // When true, marketing surfaces hide numeric price and render
  // "Custom pricing" + a "Request a proposal" CTA. Locked on Legacy
  // (Jose 2026-07-02).
  customPrice?: boolean
  // Track-membership flags for the derived subsets used by /signup's
  // pre-billing track-tabbed picker.
  includesEnforcement: boolean
  includesPM: boolean
  features: string[]

  // ── DEPRECATED (Jose 2026-07-02): kept on the TierDisplay type so
  // pre-billing /signup + /signup/verify keep compiling until the
  // Bar-2 self-serve rewrite lands. Not populated on any OFFERING
  // anymore. Consumers that read these get `undefined` and should
  // treat it as "n/a / zero".
  perDriver?: number
  enterprise?: boolean
}

// ── The canonical 3 offerings ────────────────────────────────────────

export const OFFERINGS: TierDisplay[] = [
  {
    name: 'PM-Only',
    base: 179,
    perProp: 20,
    // Graduated per-approved-permit meter. Rate declines as volume
    // grows. Meter fires on approved resident vehicles; declined and
    // pending vehicles are free.
    permitTiers: [
      { upTo: 50,   ratePerPermit: 2.00 },
      { upTo: 200,  ratePerPermit: 1.75 },
      { upTo: 500,  ratePerPermit: 1.50 },
      { upTo: null, ratePerPermit: 1.25 },
    ],
    includesEnforcement: false,
    includesPM: true,
    features: [
      'Resident portal',
      'Resident self-registration',
      'Self-serve visitor passes',
      'Reserved space management',
      'Detailed reporting & analytics',
      'Unlimited visitor capacity (free)',
      'Unlimited property manager accounts',
      'Email support',
    ],
  },
  {
    name: 'Enforcement-Only',
    base: 199,
    perProp: 15,
    includesEnforcement: true,
    includesPM: false,
    features: [
      'Full enforcement (plate scan, video evidence, tow tickets)',
      'Driver mobile app + scan workflow',
      'QR-code visitor pass entry',
      'Manager-added residents',
      'Basic reporting',
      'Unlimited driver accounts (no per-driver fee)',
      'Unlimited property manager accounts',
      'Email support',
    ],
  },
  {
    name: 'Legacy',
    customPrice: true,
    includesEnforcement: true,
    includesPM: true,
    features: [
      'Everything in PM-Only AND Enforcement-Only',
      'Full PM functionality for serviced properties',
      'Full enforcement (plate scan, video, tow tickets)',
      'Resident self-registration + self-serve visitor passes',
      'Reserved space management',
      'Detailed reporting & analytics',
      'Unlimited visitor capacity (free)',
      'Unlimited property manager accounts',
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
    pmOnly: '✓',                   enforcementOnly: '—',                  legacy: '✓' },
  { capability: 'Visitor capacity',
    pmOnly: 'Unlimited (free)',    enforcementOnly: 'Unlimited (free)',   legacy: 'Unlimited (free)' },
  // "Property managers" row removed 2026-07-02 — there is no property-
  // manager cap on any offering. Advertising a number here would
  // reintroduce the fossil the spec explicitly retires.
]

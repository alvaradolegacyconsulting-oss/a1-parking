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

// PM Starter permit-allowance shape (2026-08-31 public-catalog rewrite):
// N permits included at flat rate, then $X per additional. Renders
// differently from the graduated permitTiers meter.
export type PermitAllowance = {
  includedUpTo: number
  overageRate:  number
}

export type TierDisplay = {
  name: string
  // B2-5 C2 (2026-07-21) — explicit slug field. Was previously derived
  // from `name.toLowerCase()`, which produced "pm-only" (hyphen) —
  // mismatching the stripe_prices.tier_name CHECK constraint values
  // 'pm_only' / 'enforcement_only' / 'legacy' (underscore/lowercase).
  // Every self-serve checkout would have 503'd on catalog resolution.
  // Latent because public_signup_open has never been true; still a bug.
  // Callers MUST use this field, never derive from the display name.
  // Union kept narrow so a typo like 'pm-only' is caught at compile time.
  slug: 'pm_starter' | 'pm_pro' | 'operator_starter' | 'operator_pro'
  /** Transition label; rendered only while FORMERLY_LABELS_ON. */
  formerly?: string
  // Optional because Legacy hides its price on marketing surfaces
  // (customPrice: true replaces the numeric with "Custom pricing").
  base?: number
  // null = flat fee, no per-property line rendered (PM Starter).
  perProp?: number | null
  // PM-Only per-approved-permit graduated meter. Rendered as a small
  // table under the base + per-property lines when present.
  permitTiers?: PermitBand[]
  // PM Starter shape (2026-08-31): N permits included, then $X per
  // additional. Simpler than the graduated schedule; rendered as
  // one line + reassurance note. NEVER both permitTiers AND
  // permitAllowance on the same offering.
  permitAllowance?: PermitAllowance
  // One-line subtitle under the offering name — sets the audience
  // in one sentence. Optional (older offerings didn't have it).
  taglineOneLine?: string
  // Marketing sub-copy shown in place of the ✓ features list on
  // customPrice offerings (2026-08-31 pricing-page rewrite —
  // "Every portfolio is different, so we quote those directly.").
  // Optional; falls back to features[] rendering if unset.
  customPitch?: string
  // When true, marketing surfaces hide numeric price and render
  // "Custom pricing" + a "Request a proposal" CTA. Locked on Legacy
  // (Jose 2026-07-02).
  customPrice?: boolean
  // Track-membership flags for the derived subsets used by /signup's
  // pre-billing track-tabbed picker.
  includesEnforcement: boolean
  includesPM: boolean
  // B2-5 C1 (2026-07-21) — hide from /signup self-serve picker while
  // keeping the entry in OFFERINGS for marketing/landing consumers.
  // Legacy is the only entry with this set today: it's negotiated per
  // proposal code by Jose (custom pricing, custom terms), not
  // self-servable. /signup filters this out via selfServeTiers(); other
  // consumers of OFFERINGS (landing /page.tsx) show Legacy normally so
  // prospects know it exists + can Request a Proposal.
  hiddenFromSelfServe?: boolean
  features: string[]

  // ── DEPRECATED (Jose 2026-07-02): kept on the TierDisplay type so
  // pre-billing /signup + /signup/verify keep compiling until the
  // Bar-2 self-serve rewrite lands. Not populated on any OFFERING
  // anymore. Consumers that read these get `undefined` and should
  // treat it as "n/a / zero".
  perDriver?: number
  enterprise?: boolean
}

// ── The canonical 3 offerings (public catalog) ───────────────────────
//
// 🔴 2026-08-31 REWRITE per Mateo — public catalog collapsed to what's
// actually sold publicly:
//   1. PM Starter        ($149/mo flat, 1 property, 500 permits + $1.25)
//   2. Enforcement-Only  ($199 + $15/property — unchanged shape)
//   3. Custom quote      (everything else, contact-for-quote)
//
// Retired from public per Mateo (kept in tier-config.ts as internal
// anchors for existing proposal codes — this file is DISPLAY only):
//   - PM-Only ($179 + $20/property)  → replaced by Starter (Public);
//                                       PM-Only stays negotiated-only
//                                       via proposal codes
//   - Legacy display                  → renamed to "Custom quote" for
//                                       the marketing shelf; underlying
//                                       negotiated-tier machinery stays
//
// 🔴 CTA note (2026-08-31): public_signup_open=false, so all three
// cards route to the contact form (#contact), NOT to a signup flow.
// Cards render without any "Get started" button — the CTA text +
// href are chosen at render time in page.tsx (single source of truth
// there so a signup-open flip is one edit per card, not one per
// tier-display constant).

// ════════════════════════════════════════════════════════════════════
// OFFERINGS — the Oct 2026 lineup
// ════════════════════════════════════════════════════════════════════
//
// 🔴 PM-Only and "Custom quote" are GONE from the public page. PM-Only
// is retired and no longer sold; Elite replaces "Custom quote" and is a
// LEAD, not a card you can buy — it routes to the existing intake form.
//
// Every feature line below was checked against TIER_CONFIG, not written
// from the plan names. The audit is the reason two obvious-sounding
// lines are NOT here: leasing-agent seats are on all four plans so they
// differentiate nothing, and support tiering is deliberately absent
// from the public page (Jose, 2026-10-02).
export const OFFERINGS: TierDisplay[] = [
  {
    name: 'PM Starter',
    slug: 'pm_starter',
    base: 149,
    perProp: null,               // flat fee, no per-property line
    taglineOneLine: 'For a single property.',
    permitAllowance: { includedUpTo: 500, overageRate: 1.25 },
    includesEnforcement: false,
    includesPM: true,
    features: [
      'One property',
      '500 active permits included, then $1.25 each',
      'Residents, permits, reserved spaces, visitor passes, house rules',
      'Reserved-space fee tracking',
    ],
  },
  {
    name: 'PM Pro',
    slug: 'pm_pro',
    base: 249,
    perProp: 15,
    taglineOneLine: 'For property management companies.',
    includesEnforcement: false,
    includesPM: true,
    features: [
      'Everything in PM Starter, across your whole portfolio',
      'Unlimited permits',
      'Properties 21–50 included',
      'Managers and leasing agents across properties',
      'Tow log for every property',
    ],
  },
  {
    name: 'Operator Starter',
    slug: 'operator_starter',
    formerly: 'Enforcement-Only',
    base: 199,
    perProp: 15,
    taglineOneLine: 'Driver and office tools for towing operators.',
    includesEnforcement: true,
    includesPM: false,
    features: [
      'Violations, tow tickets, plate scanning, enforcement reporting',
      'No permit charges',
      'Properties 21–50 included',
    ],
  },
  {
    name: 'Operator Pro',
    slug: 'operator_pro',
    formerly: 'Legacy',
    base: 299,
    perProp: 20,
    taglineOneLine: 'The full platform for towing operators.',
    includesEnforcement: true,
    includesPM: true,
    features: [
      'Everything in Operator Starter',
      'Resident self-registration, visitor passes, and spaces & permits for every property you serve',
      'Give each property its own parking system, run by you',
      'Properties 21–50 included',
    ],
  },
]

// ════════════════════════════════════════════════════════════════════
// FEATURE_COMPARISON — four columns, every cell checked against
// TIER_CONFIG rather than written from the plan names
// ════════════════════════════════════════════════════════════════════
//
// 🔴 Rows that are NOT here, and why:
//   • Leasing-agent seats — LEASING_AGENT_ROLE is true on all four, so
//     a row would imply a difference that does not exist.
//   • Priority support / dedicated account manager — true on PM Starter
//     and false on the pricier Operator Starter, which is a flag audit
//     to run separately. Jose's ruling: no support rows on the public
//     table for any self-serve plan.
export type ComparisonRow = {
  capability: string
  pmStarter: string
  pmPro: string
  operatorStarter: string
  operatorPro: string
}

export const FEATURE_COMPARISON: ComparisonRow[] = [
  // AI_PLATE_SCANNING / VIOLATION_DOCUMENTATION / TOW_TICKET_GENERATION
  { capability: 'Full enforcement (plate scan, video, tow tickets)',
    pmStarter: '—',          pmPro: '—',          operatorStarter: '✓',                operatorPro: '✓' },
  // RESIDENT_PORTAL
  { capability: 'Resident portal',
    pmStarter: '✓',          pmPro: '✓',          operatorStarter: '—',                operatorPro: '✓' },
  // RESIDENT_SELF_REGISTRATION
  { capability: 'Resident self-registration',
    pmStarter: '✓',          pmPro: '✓',          operatorStarter: 'Office adds',      operatorPro: '✓' },
  // VISITOR_PASS_SELF_SERVICE is true everywhere, but resident-issued
  // passes need RESIDENT_PORTAL — which Operator Starter does not have.
  // So the flag is right and the row says what the operator actually
  // gets (Jose's ruling 2026-10-02).
  { capability: 'Visitor passes',
    pmStarter: 'QR, office and resident-issued', pmPro: 'QR, office and resident-issued',
    operatorStarter: 'QR and office-issued',     operatorPro: 'QR, office and resident-issued' },
  // ADVANCED_ANALYTICS (BASIC_DASHBOARDS is true everywhere)
  { capability: 'Detailed reporting / analytics',
    pmStarter: '✓',          pmPro: '✓',          operatorStarter: 'Basic only',       operatorPro: '✓' },
  // Reserved spaces ride PROPERTY_MANAGEMENT + VEHICLE_REGISTRY
  { capability: 'Reserved spaces',
    pmStarter: '✓',          pmPro: '✓',          operatorStarter: '—',                operatorPro: '✓' },
  // MAX_VISITOR_PASSES_PER_PROPERTY_MONTH = -1 on all four
  { capability: 'Visitor capacity',
    pmStarter: 'Unlimited (free)', pmPro: 'Unlimited (free)',
    operatorStarter: 'Unlimited (free)', operatorPro: 'Unlimited (free)' },
  // The ceiling, from the Oct 2026 decision. PM Starter is one property
  // by definition; the other three pay to 20 and are free to 50.
  { capability: 'Properties included',
    pmStarter: 'One',        pmPro: 'Pay to 20, free to 50',
    operatorStarter: 'Pay to 20, free to 50', operatorPro: 'Pay to 20, free to 50' },
  // pm_starter's graduated meter vs unlimited everywhere else.
  { capability: 'Permits',
    pmStarter: '500 included, then $1.25', pmPro: 'Unlimited',
    operatorStarter: 'Not metered',        operatorPro: 'Not metered' },
]

// One line under the table — Elite is not a column, because it is not a
// plan you can select. Its terms are negotiated.
export const ELITE_TABLE_NOTE =
  'More than 50 properties? Elite is priced around your portfolio, with a dedicated contact. Talk to us.'


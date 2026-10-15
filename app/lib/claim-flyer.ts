// ════════════════════════════════════════════════════════════════════
// claim-flyer — who sees the login-setup flyer, and what it points at
// ════════════════════════════════════════════════════════════════════
// Ruled 2026-10-15: the CA's QR screen offers a SECOND flyer, pointing
// at /claim, visible only when the company has bulk onboarding on.
//
// 🔴 ONE DERIVATION, TWO CALL SITES. The CA portal renders this flyer
// in two places — the QR tab's per-property list and the property
// detail panel — and the two gates are not the same question:
//
//   residentPortal        "is there a portal to log in to?"
//   bulkOnboardingEnabled "did anyone get loaded into it?"
//
// Inlining the `&&` at both sites is how one of them later gains a gate
// the other does not, and the flyer then appears on one screen for a
// company that cannot use it. So the decision lives here and the gate
// asserts the truth table by execution rather than by reading JSX.
//
// This is the same discipline as the preview/executor line-item share:
// if two surfaces must agree, they call one function.

export interface ClaimFlyerVisibility {
  /** companies.bulk_onboarding_enabled — the operator-set flag. */
  bulkOnboardingEnabled: boolean
  /** hasFeature(FEATURE_FLAGS.RESIDENT_PORTAL, ctx) === true */
  residentPortal: boolean
}

/**
 * Whether to offer the /claim flyer.
 *
 * 🔴 Both gates are required, and failing either one hides it:
 *
 *  • Flag off → the company never uploaded a resident file, so nobody
 *    has a record waiting to be claimed. A second flyer at every
 *    property would be one more thing to explain for no reason, and
 *    the ruling is explicit that flag off means the screen is
 *    unchanged.
 *
 *  • No resident portal → the claim would SUCCEED and land them
 *    nowhere. The invite sets a password for a portal their company's
 *    tier does not include. That is a worse outcome than no flyer.
 */
export function showClaimFlyer(v: ClaimFlyerVisibility): boolean {
  return v.bulkOnboardingEnabled === true && v.residentPortal === true
}

/**
 * The flyer's URL.
 *
 * 🔴 Built here so it cannot drift from what /claim accepts. There is
 * no property token in this codebase — every property QR is
 * ?property=<name>&company=<name> — and /claim reuses that shape so
 * its own "Register here →" fallback lands on the SAME property the
 * flyer was printed for. Both values are encoded: property names
 * contain spaces routinely and `&` occasionally ("Oak & Vine"), and an
 * unencoded `&` would silently truncate the property at the ampersand
 * and send the resident to a property that does not exist.
 */
export function claimFlyerUrl(baseUrl: string, property: string, company: string): string {
  return `${baseUrl}/claim?property=${encodeURIComponent(property)}&company=${encodeURIComponent(company)}`
}

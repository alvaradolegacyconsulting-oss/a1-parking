// ════════════════════════════════════════════════════════════════════
// property-cap-message — the one place the property ceiling is explained
// ════════════════════════════════════════════════════════════════════
//
// 🔴 THREE LAYERS REFUSE THE SAME THING, so they must say the same
// thing. In the CA portal a property can be refused by:
//
//   1. the pre-flight check in saveProperty      (the FAST path, and
//      the one a user actually hits)
//   2. the enforce_property_limit trigger, translated in saveProperty's
//      insErr handler (the path that catches a form-state race, a stale
//      count, or a direct API call)
//   3. the pre-flight check in togglePropertyActive, because the
//      trigger's Commit C branch fires on a false→true flip too
//
// Before this helper, (1) told a PM Starter subscriber "More than 1
// properties is an Elite plan" while (2) correctly told them to
// upgrade — and (1) fires first, so the wrong answer was the one
// customers saw. Inlined copy in three places drifts; a shared
// derivation cannot.
//
// 🔴 PM Starter's next step is PM Pro, NOT Elite. Elite begins above
// the 50-property ceiling. Telling a single-community property manager
// that a second property requires an Elite proposal is both wrong and
// a lost upgrade.
//
// Addresses follow the support model: this is an authenticated portal
// surface for a subscriber, so support@ — hello@ is the public,
// non-subscriber address used in docs/help and marketing.

/** Which refusal the user ran into. Reactivation needs its own clause. */
export type PropertyCapMode = 'add' | 'reactivate'

/**
 * Plain-language refusal naming the actual next step.
 *
 * @param tier     company tier key; only 'pm_starter' changes the path
 * @param effLimit server-resolved ceiling, or null when it could not be
 *                 resolved — the copy then omits the number rather than
 *                 printing "null" or guessing
 */
export function propertyCapMessage(
  tier: string | null | undefined,
  effLimit: number | null,
  mode: PropertyCapMode,
): string {
  const support = 'support@shieldmylot.com'

  if (tier === 'pm_starter') {
    const lead = mode === 'reactivate'
      ? "PM Starter covers one property, so this one can't be reactivated while another is active."
      : 'PM Starter covers one property.'
    return `${lead} To run more, move to PM Pro — email ${support} and we'll set it up.`
  }

  // Everything else is a 50-property self-serve plan or an Elite
  // account whose limit comes from its proposal. Above the ceiling the
  // next step is Elite, and the sizing conversation starts on the
  // property-managers page.
  const n = effLimit == null ? null : String(effLimit)
  const lead = n
    ? (mode === 'reactivate'
        ? `You're at your ${n}-property limit, so this one can't be reactivated.`
        : `You're at your ${n}-property limit.`)
    : (mode === 'reactivate'
        ? "Your plan's property limit was reached, so this one can't be reactivated."
        : "Your plan's property limit was reached.")
  const tail = n
    ? `More than ${n} properties is an Elite plan`
    : 'More properties than your plan covers is an Elite plan'
  return `${lead} ${tail} — tell us about your portfolio at /property-managers and we'll size it with you.`
}

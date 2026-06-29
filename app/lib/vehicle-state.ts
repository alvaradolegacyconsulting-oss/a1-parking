// Permit-Door Fixes Piece 1 (§1) — centralized vehicle-insert state.
//
// Single chokepoint for "what state does a new vehicle row land in?"
// Centralizing the tier-conditional decision here keeps the 3+
// vehicle-insert sites (manager manual add, manager resident-create
// cascade, bulk-invite companion vehicle) calling one function that
// owns the policy. A future 4th/5th insert site that uses this helper
// gets correct behavior for free.
//
// POLICY (Jose 2026-06-28):
//   - PM-Only companies: vehicles land PENDING (`status:'pending',
//     is_active:false`). Approval via approve_vehicle() RPC is the
//     billable event (fires the per-permit meter sync). Bulk
//     ingress (bulk-invite of N companion vehicles) → N pending →
//     property-wide Approve-All batches them into one sync call.
//   - All other tiers (Enforcement-Only, Legacy): vehicles land
//     ACTIVE (`status:'active', is_active:true`). Preserves
//     pre-Piece-1 behavior; no permit meter on these tiers, so
//     pending-routing would be friction with no billing reason.
//
// EXCLUDED SITES (do not use this helper):
//   - app/api/register/companion-vehicle/route.ts — public self-
//     registration writes 'pending' UNCONDITIONALLY (regardless of
//     tier) because the trust model is "resident self-registered →
//     manager approves the registration + its vehicles". That's a
//     trust-model decision, not a billing-meter decision; the helper
//     would wrongly write 'active' for non-PM register-companion-
//     vehicle calls. Leave the unconditional 'pending' there.
//
// MIGRATION B BACKSTOP:
//   After app smoke confirms every insert-site routes through this
//   helper, Migration B flips `vehicles.status` DEFAULT 'active' →
//   'pending'. If a future insert site forgets the helper, it lands
//   pending — fails SAFE (operator approves vs. silent billing leak).
//   The helper's explicit status-set always overrides the DB default,
//   so existing routed sites are unaffected by Migration B.

export function initialVehicleState(
  tier?: string | null,
): { status: 'pending' | 'active'; is_active: boolean } {
  if (tier === 'pm_only') {
    return { status: 'pending', is_active: false }
  }
  return { status: 'active', is_active: true }
}

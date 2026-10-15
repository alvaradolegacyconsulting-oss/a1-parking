// ════════════════════════════════════════════════════════════════════
// import-batch-block — the two pure decisions, in their own module
// ════════════════════════════════════════════════════════════════════
// 🔴 NO `server-only` HERE, DELIBERATELY, AND NO RUNTIME IMPORT OF IT.
// These two functions are pure — a value in, a value out, no database,
// no Stripe, no clock — and they are the decisions worth testing by
// execution rather than by reading a regex over route source. They sit
// apart from import-batch-review.ts, which IS server-only, so a gate
// can import them directly.
//
// MeteredLineItemCheck comes from stripe-mutations.ts, which is
// server-only. It is imported as `import type`, which TypeScript erases
// entirely — so nothing from that module is loaded at runtime and the
// server-only guard never fires. A value import would have made this
// module unusable from a gate for the sake of a shape.
//
// 🔴 AND NEITHER IS A FAULT-INJECTION SEAM. The standing rule is no
// such seam in production code. Nothing here exists only for tests:
// these are the functions the real path calls, with the inputs it gives
// them. A gate that hands meteredLoadReasons a metered check result is
// exercising the production decision, not a branch built to be poked.

import type { MeteredLineItemCheck } from './stripe-mutations'

/** Why a batch cannot be loaded right now, regardless of its contents. */
export interface BatchBlock {
  /**
   * Nothing can be done with this batch at all. An inactive property,
   * an inactive or suspended company, bulk onboarding switched off.
   * These stop Return and Reject too, because the company could not
   * act on a returned batch either.
   */
  blocked: boolean
  reasons: string[]
  /**
   * 🔴 A DIFFERENT KIND OF BLOCK, AND THE DISTINCTION IS THE POINT.
   * Approve and Load are refused; Return and Reject are NOT.
   *
   * The metered-plan case is the whole reason this field exists. A
   * company whose subscription meters permits cannot have 358 vehicles
   * written into it without billing consequences — so the load is
   * refused. But returning the batch to them is exactly the right
   * action: "we cannot bulk-load you, your plan bills per permit."
   * Folding it into `blocked` would leave the batch stuck with no move
   * the operator could make.
   */
  loadBlocked: boolean
  loadReasons: string[]
}

/**
 * The load-only reasons a billing check produces. PURE: no reads, no
 * clock, no Stripe — a MeteredLineItemCheck in, sentences out.
 *
 * 🔴 EXTRACTED SO THE DECISION CAN BE TESTED WITHOUT A METERED TENANT.
 * No subscription in the system carries a per_permit item yet, so the
 * metered branch cannot be reached through a real subscription. The
 * standing rule is no fault-injection seam in production code — and
 * this is not one: it is the function the real path calls, with the
 * same inputs it gets there. A gate hands it a check result and reads
 * the answer. Nothing exists here that exists only for tests.
 */
export function meteredLoadReasons(
  check: MeteredLineItemCheck, companyName: string, vehicleCount: number,
): string[] {
  if (!check.ok) {
    // Fail closed. An unreachable billing system is not permission.
    return [`${companyName}'s billing could not be checked (${check.reason}). Loading is held until it can be — an unreachable billing system is not a reason to risk a charge nobody agreed to.`]
  }
  if (check.metered) {
    return [`Blocked: metered tenant. ${companyName}'s plan bills per permit (currently ${check.quantity}), and this batch would add ${vehicleCount} at once. Loading it would either bill them for all of them with a proration they did not agree to, or under-bill by that many until renewal. Return the batch and agree the billing first.`]
  }
  return []
}

/**
 * Does a block refuse this action?
 *
 * 🔴 ONE DERIVATION, NOT FOUR INLINE CONDITIONS. Four routes each
 * hand-rolled `block.blocked` or `block.blocked || block.loadBlocked`,
 * and the whole point of the two kinds is that they differ per action —
 * which is exactly the shape where four copies drift and the fourth one
 * silently gets it wrong. A source-text check that the conditions look
 * right is not the same as a truth table that runs.
 *
 * approve / load   both kinds refuse
 * return / reject  only the hard block refuses, because sending the
 *                  batch back is the right answer for a metered tenant
 *                  and blocking it would leave the batch with no move
 */
export function blockRefusesAction(
  action: 'approve' | 'load' | 'return' | 'reject', block: BatchBlock,
): boolean {
  if (block.blocked) return true
  return (action === 'approve' || action === 'load') && block.loadBlocked
}

export interface BatchBlock {
  /**
   * Nothing can be done with this batch at all. An inactive property,
   * an inactive or suspended company, bulk onboarding switched off.
   * These stop Return and Reject too, because the company could not
   * act on a returned batch either.
   */
  blocked: boolean
  reasons: string[]
  /**
   * 🔴 A DIFFERENT KIND OF BLOCK, AND THE DISTINCTION IS THE POINT.
   * Approve and Load are refused; Return and Reject are NOT.
   *
   * The metered-plan case is the whole reason this field exists. A
   * company whose subscription meters permits cannot have 358 vehicles
   * written into it without billing consequences — so the load is
   * refused. But returning the batch to them is exactly the right
   * action: "we cannot bulk-load you, your plan bills per permit."
   * Folding it into `blocked` would leave the batch stuck with no move
   * the operator could make.
   */
  loadBlocked: boolean
  loadReasons: string[]
}


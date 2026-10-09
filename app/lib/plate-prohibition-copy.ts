// ════════════════════════════════════════════════════════════════════
// plate-prohibition-copy — one token, three audiences
// ════════════════════════════════════════════════════════════════════
//
// The BEFORE triggers on vehicles / visitor_passes / guest_authorizations
// raise a single matchable token, 'plate_prohibited'. Thirteen paths can
// trip it, including direct inserts and a service-role bulk import, so
// the token has to be translated into audience-appropriate copy wherever
// it surfaces — otherwise a resident sees a raw Postgres error, which is
// both ugly and a disclosure.
//
// 🔴 THE RULE THIS FILE EXISTS TO ENFORCE (Jose, 2026-10-11):
// a resident or visitor must NEVER see the word "prohibited", and never
// the reason. They get "can't be registered here, contact the office".
// Managers and company admins get explicit wording — and the reason, but
// they read that from the prohibition row itself, not from the error,
// because the error travels to everyone.
//
// Pure, so the copy rules can be asserted without a browser. The gate
// checks the resident and visitor strings for the forbidden words rather
// than trusting that nobody pasted the manager string into the wrong
// branch.

/** The token the triggers and RPCs raise. */
export const PLATE_PROHIBITED_TOKEN = 'plate_prohibited'

/**
 * Does this error mean "that plate is not permitted here"?
 *
 * Matches the message, which is the convention every other
 * resident-facing refusal in this codebase uses (account_deactivated,
 * vehicle_already_registered, not_your_unit) and what the clients
 * already pattern-match on.
 */
export function isPlateProhibitedError(err: unknown): boolean {
  const msg = typeof err === 'string'
    ? err
    : (err as { message?: string } | null)?.message ?? ''
  return msg.includes(PLATE_PROHIBITED_TOKEN)
}

export type ProhibitionAudience = 'resident' | 'visitor' | 'manager'

/**
 * 🔴 The resident and visitor strings contain neither "prohibit" in any
 * form nor "banned" nor any reason. They name the ONE action available
 * to the person reading them: contact the office. Anything more would
 * either leak the office's internal note or invite an argument with a
 * screen that cannot settle it.
 *
 * The manager string is explicit because a manager is entitled to the
 * whole picture and needs to know this was a deliberate decision at
 * their property rather than a glitch — otherwise they retry, and then
 * they file a bug.
 */
export function plateProhibitedCopy(audience: ProhibitionAudience, plate?: string): string {
  const p = plate?.trim() ? `${plate.trim()} ` : ''
  switch (audience) {
    case 'resident':
      return `${p}can't be registered at this property. Please contact the property office.`
    case 'visitor':
      return `${p}can't be given a pass at this property. Please contact the property office.`
    case 'manager':
      return `${p}is not permitted at this property. A prohibition is on file — open the property's prohibition list for the reason and history, or lift it there first.`
  }
}

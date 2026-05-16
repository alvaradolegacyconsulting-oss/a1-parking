// B65.4: pinned legal-document versions. Two exports per doc:
//   • VERSION       — machine string persisted into tos_acceptances
//   • DISPLAY_DATE  — human-friendly date shown on /terms + /privacy
//
// Different audiences (audit log vs end user) want different formats.
// When legal review finishes, bump both — VERSION to '2026-MM-DD-v1',
// DISPLAY_DATE to the matching clean human string.
//
// Single source of truth: changing a version here propagates to (a) the
// activation RPC arg passed from /signup/redeem/verify, (b) the "Last
// updated" line on /terms and /privacy. Acceptance rows persisted in
// tos_acceptances will reference the value that was active at the
// moment of acceptance — bumping these strings does NOT retroactively
// re-version existing rows.

export const TOS_VERSION = '2026-05-21-draft-1'
export const TOS_DISPLAY_DATE = 'May 21, 2026'

export const PRIVACY_VERSION = '2026-05-21-draft-1'
export const PRIVACY_DISPLAY_DATE = 'May 21, 2026'

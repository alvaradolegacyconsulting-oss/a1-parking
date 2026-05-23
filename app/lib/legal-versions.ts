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

// B66.3 + B95 — Texas operations attestation. Pinned to a 'v0' suffix
// to signal pre-attorney-review draft wording. When attorney returns
// with sharpened text (1-3 weeks out), bump to 'v1.0' here; users who
// signed up against v0 will see a re-attest prompt at next login (the
// re-attest flow itself is a future small commit when wording bumps).
//
// Risk posture at v0: public_signup_open=false means no real customers
// are signing up yet; UAT-only. The wording is defensible-on-its-face
// (no "pending review" hedging in user-visible text) and tightens
// later without retroactive validity issues.
export const TEXAS_ATTESTATION_VERSION = '2026-05-23-v0'
export const TEXAS_ATTESTATION_TEXT = `I attest that:

1. The enforcement and/or property management operations I will conduct through ShieldMyLot are located in Texas;

2. I will use ShieldMyLot only for parking and enforcement activities at properties located in Texas; and

3. I understand that ShieldMyLot is licensed for Texas-only operations and that using it outside Texas may violate the Terms of Service and applicable law.`

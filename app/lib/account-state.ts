// B65.2: account_state gate. Shared by the login dispatcher
// (app/login/page.tsx), CA portal entry (app/company_admin/page.tsx),
// and B66.5 commit 4.3 — extended to the 3 customer portals
// (resident/manager/driver) so the entire portal surface enforces the
// same rules.
//
// State semantics (spec §3.4 + B66.5 lifecycle):
//   active      → full dashboard, normal flow
//   configuring → user signed up but hasn't finished activation;
//                 redirect to /signup/redeem/verify to complete it
//   past_due    → portal renders with a "past due" banner (B66.5 commit
//                 4.3 — caller renders <PastDueBanner /> above content)
//   suspended   → hard redirect to /account-suspended landing page
//   cancelled   → hard redirect to /account-cancelled landing page
//
// ── BEHAVIOR CHANGE FROM B65.2-ERA (B66.5 commit 4.3, 2026-05-29) ───
// The 'suspended' arm previously returned {kind:'allow_with_banner'}
// because no code path could actually transition a company to suspended
// (B65.2 had no admin tooling for suspension). B66.5 commits 1-3 added
// the dunning cron that makes suspended a reachable state on real
// customer payment failures. Banner-only is no longer the correct
// posture; hard redirect is. The 'past_due' state inherits the
// banner-only pattern that used to belong to 'suspended' — it's now
// the "warn but allow" lifecycle stage.
//
// Future readers grep'ing through history: the B65.2-era pattern was
// correct for that era; the B66.5-era pattern is correct for this era.
// Not a regression; an intentional posture shift driven by the state
// machine actually being live.
//
// NULL handling: companies that pre-date the B65.1 migration's backfill
// won't have account_state set. The backfill flipped them all to 'active'.
// In practice we shouldn't see NULL post-B65.1. This helper defensively
// treats unknown/null states as 'allow' to avoid locking users out for
// data-integrity issues — but callers should ALSO defensively null-check
// companyData itself before calling this helper (silent fail-open on a
// missing companies row is the bigger risk, e.g., if RLS blocks SELECT).

export type AccountState = 'configuring' | 'active' | 'past_due' | 'suspended' | 'cancelled'

export const ACTIVATION_CONTINUE_HREF = '/signup/redeem/verify'
export const SUSPENDED_REDIRECT_HREF = '/account-suspended'
export const CANCELLED_REDIRECT_HREF = '/account-cancelled'

export type AccountGate =
  | { kind: 'allow' }
  | { kind: 'allow_with_banner'; banner: 'past_due' }
  | { kind: 'redirect'; href: string; reason: 'configuring' | 'suspended' | 'cancelled' }

export function gateAccountState(state: AccountState | null | undefined): AccountGate {
  if (state === 'configuring') {
    return { kind: 'redirect', href: ACTIVATION_CONTINUE_HREF, reason: 'configuring' }
  }
  if (state === 'cancelled') {
    return { kind: 'redirect', href: CANCELLED_REDIRECT_HREF, reason: 'cancelled' }
  }
  if (state === 'suspended') {
    return { kind: 'redirect', href: SUSPENDED_REDIRECT_HREF, reason: 'suspended' }
  }
  if (state === 'past_due') {
    return { kind: 'allow_with_banner', banner: 'past_due' }
  }
  return { kind: 'allow' }
}

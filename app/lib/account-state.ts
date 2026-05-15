// B65.2: account_state gate. Shared by the login dispatcher
// (app/login/page.tsx) and the CA portal entry (app/company_admin/page.tsx)
// so both surfaces enforce the same rules. Defense-in-depth: any future
// portal entry that bypasses login still gets the same routing decision.
//
// State semantics (spec §3.4):
//   active      → full dashboard, normal flow
//   configuring → user signed up but hasn't finished activation;
//                 redirect to /signup/redeem/verify to complete it
//   suspended   → portal renders with a read-only banner (caller's
//                 responsibility — gate just signals "allow + banner")
//   cancelled   → hard redirect to a contact-support page
//
// NULL handling: companies that pre-date the B65.1 migration's backfill
// won't have account_state set. The backfill flips them all to 'active',
// so in practice we shouldn't see NULL after B65.1 applies. Defensively
// treat NULL as 'allow' (don't lock anyone out) — if a real NULL ever
// appears, that's a data-integrity bug, not a permissions decision.

export type AccountState = 'configuring' | 'active' | 'suspended' | 'cancelled'

export const ACTIVATION_CONTINUE_HREF = '/signup/redeem/verify'
export const CANCELLED_REDIRECT_HREF = '/account-cancelled'

export type AccountGate =
  | { kind: 'allow' }
  | { kind: 'allow_with_banner'; banner: 'suspended' }
  | { kind: 'redirect'; href: string; reason: 'configuring' | 'cancelled' }

export function gateAccountState(state: AccountState | null | undefined): AccountGate {
  if (state === 'configuring') {
    return { kind: 'redirect', href: ACTIVATION_CONTINUE_HREF, reason: 'configuring' }
  }
  if (state === 'cancelled') {
    return { kind: 'redirect', href: CANCELLED_REDIRECT_HREF, reason: 'cancelled' }
  }
  if (state === 'suspended') {
    return { kind: 'allow_with_banner', banner: 'suspended' }
  }
  return { kind: 'allow' }
}

// B66.5 commit 4.3 — shared portal account-state gating helper.
//
// Encapsulates the standard mount-time gating pattern used by the 3
// customer portals (driver/manager/resident). The CA portal does NOT
// use this helper — its existing companies SELECT at /company_admin
// mount logic is integrated with the billing tab data + uses a slightly
// different SELECT shape; extension lives inline there for parity with
// the established CA pattern.
//
// Pattern enforced:
//   1. SELECT companies row by name (authenticated session client per
//      audit-pass Item 6 — companies RLS Policy 2 permits SELECT to any
//      authenticated user for is_active=true rows).
//   2. Defensive null-check: if companies row is missing OR account_state
//      is null/undefined, fail CLOSED — redirect to /account-cancelled.
//      This handles the edge case where a cancelled company has
//      is_active=false (legacy soft-delete) and the RLS SELECT returns
//      no rows. The customer slipping past the cancelled gate is the
//      bigger risk; over-aggressive cancellation lockout is the safer
//      failure mode (customer surfaces via the /account-cancelled
//      support CTA + we diagnose the data integrity issue from there).
//   3. Call gateAccountState — if 'redirect', navigate + signal caller.
//   4. If 'allow_with_banner' (past_due variant only — suspended is now
//      a redirect per the 4.3 era-shift), return banner props for the
//      caller to render <PastDueBanner /> above main portal content.
//   5. If 'allow', return clean.
//
// Caller pattern:
//   const result = await evaluatePortalGate(user.email, roleRow.company)
//   if (result.redirected) return  // helper already navigated
//   // ... continue with portal mount logic
//   // ... render result.pastDueBanner if non-null

import { supabase } from '../supabase'
import {
  gateAccountState,
  type AccountState,
} from './account-state'
import type { PastDueBannerProps } from '../components/PastDueBanner'

export type PortalGateResult =
  | { redirected: true }
  | {
      redirected: false
      pastDueBanner: PastDueBannerProps | null
    }

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'
const UPDATE_PAYMENT_URL = `${APP_URL}/company_admin?tab=billing`

export async function evaluatePortalGate(
  companyName: string,
): Promise<PortalGateResult> {
  const { data: companyRow } = await supabase
    .from('companies')
    .select('id, name, display_name, account_state, past_due_grace_until')
    .ilike('name', companyName)
    .maybeSingle()

  // Defensive null-check — fail CLOSED. Covers:
  //  • RLS-blocked SELECT (e.g., is_active=false on cancelled companies)
  //  • Orphaned user_roles (company name doesn't match any companies row)
  //  • Race condition between cron transition + portal mount
  // In all cases, redirecting to /account-cancelled is safer than allowing
  // through with unknown company state.
  if (!companyRow || !companyRow.account_state) {
    if (typeof window !== 'undefined') {
      window.location.href = '/account-cancelled'
    }
    return { redirected: true }
  }

  const gate = gateAccountState(companyRow.account_state as AccountState)

  if (gate.kind === 'redirect') {
    if (typeof window !== 'undefined') {
      window.location.href = gate.href
    }
    return { redirected: true }
  }

  if (gate.kind === 'allow_with_banner' && gate.banner === 'past_due') {
    // Compute days remaining from past_due_grace_until; floor at 0 for
    // cron-lag edge cases where grace_until is in the past but cron
    // hasn't transitioned to suspended yet.
    const daysRemaining = companyRow.past_due_grace_until
      ? Math.max(
          0,
          Math.ceil(
            (new Date(companyRow.past_due_grace_until).getTime() - Date.now()) /
              (24 * 60 * 60 * 1000),
          ),
        )
      : 0

    const displayName = companyRow.display_name ?? companyRow.name

    return {
      redirected: false,
      pastDueBanner: {
        companyName: displayName,
        daysRemainingUntilSuspension: daysRemaining,
        updatePaymentUrl: UPDATE_PAYMENT_URL,
        companyId: companyRow.id,
      },
    }
  }

  // gate.kind === 'allow' — normal flow, no banner
  return { redirected: false, pastDueBanner: null }
}

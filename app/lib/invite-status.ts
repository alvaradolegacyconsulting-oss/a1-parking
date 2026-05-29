import 'server-only'
import { createSupabaseServiceClient } from './supabase-admin'

// B144 (folded into B66.5 commit 4.3) — activation-status mapper.
//
// Resolves "is this email an invited-but-not-yet-activated user, or an
// already-active user?" via auth.admin.listUsers + last_sign_in_at.
//
// Per [[project-b66-5-commit-4-3-closure]] H findings: `last_sign_in_at
// IS NULL` is the cleanest signal (more direct than email_confirmed_at,
// which can have invite-flow-specific quirks). Service-role required
// for auth.admin.* admin APIs.
//
// ── 1000-USER PER-PAGE CAP (TODO future migration) ──────────────────
// listUsers is paginated; default perPage=50, max 1000. For v1 we hard-
// cap at 1000 since no current customer exceeds that. When a customer
// crosses ~800 drivers+residents, swap to a schema-based detection
// pattern (invite_sent_at + activated_at columns on drivers/residents,
// populated by bulk-invite + cleared on first sign-in via login hook).
// Until then, the cap is documented but not enforced — anything beyond
// 1000 users at a single company would silently miss activation status
// for the overflow. Filed as future B-arc when scale demands.

export type ActivationStatus = 'activated' | 'invited' | 'unknown'

const LIST_USERS_PER_PAGE = 1000

export async function getActivationStatusByEmail(
  emails: string[],
): Promise<Map<string, ActivationStatus>> {
  const map = new Map<string, ActivationStatus>()
  if (emails.length === 0) return map

  // Initialize all requested emails as 'unknown' — will be overwritten
  // for any that listUsers returns.
  for (const email of emails) {
    map.set(email.toLowerCase(), 'unknown')
  }

  const service = createSupabaseServiceClient()
  const { data, error } = await service.auth.admin.listUsers({
    perPage: LIST_USERS_PER_PAGE,
  })
  if (error || !data?.users) {
    // Service-role failure or unexpected shape — leave all entries as
    // 'unknown'. Caller decides how to render (likely "Active" fallback
    // to avoid surfacing a "Resend invite" button on a status we can't
    // verify).
    console.error('[invite-status] listUsers failed', { error: error?.message })
    return map
  }

  // Map lowercase email → status. Note: listUsers returns users across
  // the entire auth.users table (not scoped to caller's company); we
  // index into the map only for emails the caller asked about.
  for (const u of data.users) {
    const lc = u.email?.toLowerCase()
    if (!lc || !map.has(lc)) continue
    map.set(lc, u.last_sign_in_at ? 'activated' : 'invited')
  }

  return map
}

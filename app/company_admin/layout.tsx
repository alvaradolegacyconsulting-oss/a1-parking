// ════════════════════════════════════════════════════════════════════
// /company_admin/layout.tsx — server-side consent-gate for the CA portal
// P1 CONSENT HARD-GATE Commit 3 of 5 · 2026-07-16
//
// ── THE ENFORCEMENT POINT ───────────────────────────────────────────
// This layout is what turns /consent (Commit 2) into a HARD gate. On
// every request to /company_admin/* (page load, direct-nav, deep-link,
// new-tab, refresh — all of it), the server component below runs and
// redirects unconsented users to /consent BEFORE any CA-portal page
// renders. No client-side bypass possible.
//
// ── LOOP PREVENTION (STRUCTURAL) ────────────────────────────────────
// /consent is a SIBLING route (app/consent/page.tsx), NOT a child of
// /company_admin/*. Next.js layouts wrap only children of their route
// segment. This layout therefore CANNOT fire on /consent by
// construction — no runtime predicate, no exclusion list, just the
// route tree. That's the best possible loop guarantee.
//
// ── FRESH ON EVERY LOAD (Mateo decision 1) ──────────────────────────
// Server components re-run on every request. No JWT-claim caching.
// A version bump in legal-versions.ts takes effect on the next portal
// load, no user re-login required. hasCurrentConsents() reads
// tos_acceptances fresh; row existence at current version is the
// source of truth (NOT the user_roles stamp).
//
// ── REDIRECT MATRIX ─────────────────────────────────────────────────
//   getUser() error / null / no email → /login
//   user_roles lookup error / no row  → /login
//   hasCurrentConsents → !consented   → /consent?missing=<csv>
//   hasCurrentConsents → consented    → pass through (render children)
// Fail-closed on DB error inside hasCurrentConsents (helper returns
// consented=false + missing=required set) → redirect to /consent →
// which itself will show a friendly error if the DB stays unreachable.
// Never fall through to the portal on a transient DB glitch.
//
// ── SCOPE ───────────────────────────────────────────────────────────
// CONSENT enforcement only. Role authorization ("is this user actually
// a company_admin?") stays with RLS + the portal's existing
// evaluatePortalGate. A driver reaching /company_admin still hits RLS
// on the CA data queries (403); this layout doesn't need to duplicate
// that check.
//
// ── PROPAGATION ─────────────────────────────────────────────────────
// This is the FIRST of 5-6 portal layouts (Option B rollout per Mateo).
// Once bypass test #3 passes on /company_admin, the shape propagates
// verbatim to /manager, /driver, /resident, /admin (+ /admin_console).
// Only the doc-set differs per role, and that difference lives in
// hasCurrentConsents's requiredDocsForRole — same helper, same result.
// ════════════════════════════════════════════════════════════════════

import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '../lib/server-auth'
import { hasCurrentConsents, type Role } from '../lib/consent-gate'

export default async function CompanyAdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createSupabaseServerClient()

  // 1. Session — stale/expired cookie surfaces here as null user +/or
  //    userErr. Either → clean /login. No crash, no loop (login IS
  //    the recovery path for an unauthenticated request).
  const { data: { user }, error: userErr } = await supabase.auth.getUser()
  if (userErr || !user?.email) {
    redirect('/login')
  }

  // 2. Role resolution — same lookup shape as requireAdmin /
  //    requireAuthenticated in server-auth.ts (ILIKE for case-
  //    insensitive email match, matches the codebase pattern).
  //    No role row = authenticated but unassigned; punt to /login
  //    (their login flow handles the empty-role case).
  const { data: roleRow, error: roleErr } = await supabase
    .from('user_roles')
    .select('role')
    .ilike('email', user.email)
    .maybeSingle()
  if (roleErr || !roleRow?.role) {
    redirect('/login')
  }
  const role = roleRow.role as Role

  // ══════════════════════════════════════════════════════════════════
  // 2b. 🔴 DEACTIVATION — ruled 2026-10-16
  // ══════════════════════════════════════════════════════════════════
  // The lookup above reads `role` and nothing else, and a deactivated
  // CA can still READ their own role row — measured:
  //   select role, is_active  →  [{"role":"company_admin","is_active":false}]
  // So the gate above passed them, and what actually stopped them was
  // RLS returning nothing for every subsequent query: they reached the
  // portal and saw a blank one. That is the worst of the three possible
  // outcomes, because it looks like the product is broken rather than
  // like their access was removed.
  //
  // 🔴 get_my_effective_active(), NOT user_roles.is_active, because that
  // is what the other three portals use (evaluatePortalGate) and it
  // covers the whole chain rather than one link: user_roles.is_active,
  // residents.is_active, properties.is_active and per-property PM
  // assignment. A CA locked out by a link further down the chain must
  // land in the same place as one locked out at the top.
  //
  // Measured before wiring it, because an over-redirect here locks out
  // every CA:
  //   active CA, properties assigned   → true
  //   active CA, property: [] (demo-ca) → true
  //   deactivated CA                    → false
  //
  // 🔴 AND IT RUNS BEFORE THE CONSENT CHECK. Until today a deactivated
  // CA was sent to /consent — asked to sign a SaaS agreement for an
  // account they no longer have access to. Deactivation is the earlier
  // fact and has to be answered first.
  //
  // Fail closed on an RPC error, the same posture as evaluatePortalGate:
  // a transient failure sends them to the escalation screen rather than
  // through to a portal whose state is unknown.
  const { data: effectiveActive, error: effErr } = await supabase.rpc('get_my_effective_active')
  if (effErr) {
    redirect(`/deactivated?role=${encodeURIComponent(role)}&reason=rpc_error`)
  }
  if (effectiveActive !== true) {
    redirect(`/deactivated?role=${encodeURIComponent(role)}`)
  }

  // 3. Consent check — SAME helper /consent uses (single source of
  //    truth). Fail-closed on read error (helper returns
  //    consented=false + missing=required set) so a transient DB
  //    glitch redirects to /consent rather than silently passing
  //    through to the portal.
  const status = await hasCurrentConsents(supabase, user.id, role)
  if (!status.consented) {
    redirect(`/consent?missing=${status.missing.join(',')}`)
  }

  // 4. Consented. Pass through — page.tsx renders under the root layout.
  return <>{children}</>
}

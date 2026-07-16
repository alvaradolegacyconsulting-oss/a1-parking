// ════════════════════════════════════════════════════════════════════
// consent-gate — role-conditional missing-doc detection
// P1 CONSENT HARD-GATE Commit 2 · 2026-07-16
//
// Used by /consent (this commit) to decide which docs to render, AND
// by the portal-layout gates (Commit 3) to decide whether to redirect
// to /consent in the first place.
//
// ── SOURCE OF TRUTH ─────────────────────────────────────────────────
// "Consented" = ROW EXISTENCE in tos_acceptances at the CURRENT
// version string, per Mateo directive. NOT the user_roles stamp
// columns. Stamps and rows can disagree (e.g., a version bump moves
// the stamp forward but leaves an old-version row); the RPC contract
// is that a valid consent is a row at the version we're currently
// asking for.
//
// The current-version strings are pinned in app/lib/legal-versions.ts.
// Bump there = re-gate everyone at next portal load.
// ════════════════════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  TOS_VERSION,
  PRIVACY_VERSION,
  SAAS_VERSION,
  TEXAS_ATTESTATION_VERSION,
} from './legal-versions'

export type Role =
  | 'admin'
  | 'company_admin'
  | 'manager'
  | 'leasing_agent'
  | 'driver'
  | 'resident'

export type DocKey = 'tos' | 'privacy' | 'saas' | 'texas_attestation'

/**
 * Which docs a caller of the given role needs at current version.
 *
 * Matrix (Mateo decision 5, 2026-07-15):
 *   • company_admin → tos + privacy + saas + texas_attestation
 *     (subscribing/contracting party — attests SaaS + Texas ops)
 *   • admin (super-admin) → tos + privacy
 *     (not subscribing; no company; SaaS/Texas do not apply)
 *   • manager / leasing_agent / driver / resident → tos + privacy
 */
export function requiredDocsForRole(role: Role): DocKey[] {
  if (role === 'company_admin') {
    return ['tos', 'privacy', 'saas', 'texas_attestation']
  }
  return ['tos', 'privacy']
}

/**
 * Current-version string for a doc. Single-source-of-truth here so
 * consent-gate reads + accept_all_pending_consents args stay in sync
 * with what /terms + /privacy + /saas display.
 */
export function currentVersionFor(doc: DocKey): string {
  switch (doc) {
    case 'tos':               return TOS_VERSION
    case 'privacy':           return PRIVACY_VERSION
    case 'saas':              return SAAS_VERSION
    case 'texas_attestation': return TEXAS_ATTESTATION_VERSION
  }
}

/**
 * Column in tos_acceptances that holds the version string for a given
 * doc. The schema uses ONE row per doc kind, with the version stored
 * in a doc-specific column and other version columns NULL:
 *   document_type='tos'               → tos_version col
 *   document_type='privacy'           → privacy_version col
 *   document_type='saas'              → saas_version col
 *   document_type='texas_attestation' → attestation_version col
 */
function versionColFor(doc: DocKey): 'tos_version' | 'privacy_version' | 'saas_version' | 'attestation_version' {
  switch (doc) {
    case 'tos':               return 'tos_version'
    case 'privacy':           return 'privacy_version'
    case 'saas':              return 'saas_version'
    case 'texas_attestation': return 'attestation_version'
  }
}

export interface ConsentStatus {
  consented: boolean
  missing:   DocKey[]
  role:      Role
}

/**
 * For the given authenticated userId + role, compute which required
 * docs the user has NOT yet consented to at the current version.
 *
 * Reads tos_acceptances rows for the user, filters to required docs,
 * matches against currentVersionFor() per doc. Missing = no row for
 * that doc at that version.
 *
 * Client-agnostic: works with any SupabaseClient (server or client
 * session). Commit 3 will call this from server components in each
 * portal's layout.tsx; /consent (this commit) calls it client-side
 * on mount.
 *
 * If the caller's role has no required docs (shouldn't happen with
 * current matrix but future-proof), returns consented=true with
 * missing=[].
 */
export async function hasCurrentConsents(
  supabase: SupabaseClient,
  userId: string,
  role: Role,
): Promise<ConsentStatus> {
  const required = requiredDocsForRole(role)
  if (required.length === 0) {
    return { consented: true, missing: [], role }
  }

  const { data: rows, error } = await supabase
    .from('tos_acceptances')
    .select('document_type, tos_version, privacy_version, saas_version, attestation_version')
    .eq('user_id', userId)
    .in('document_type', required)

  if (error) {
    // Fail closed: on read error, treat as unconsented so the user
    // gets re-gated rather than silently reaching the portal on a
    // transient DB glitch. Log server-side for triage.
    console.error('[consent-gate] hasCurrentConsents read failed:', error.message)
    return { consented: false, missing: required, role }
  }

  const missing: DocKey[] = []
  for (const doc of required) {
    const expectedVersion = currentVersionFor(doc)
    const col = versionColFor(doc)
    const found = (rows ?? []).some(r =>
      r.document_type === doc && (r as Record<string, unknown>)[col] === expectedVersion,
    )
    if (!found) missing.push(doc)
  }

  return { consented: missing.length === 0, missing, role }
}

/**
 * Post-consent redirect. Mirrors the /login redirectByRole so a user
 * completing /consent lands in the same portal they would have from
 * a fresh login. Kept in-module (not extracted from /login) to
 * minimize surface change in Commit 2; /login's copy retires when
 * Commit 4 deletes the login-modal path.
 */
export function redirectByRole(role: Role): string {
  switch (role) {
    case 'admin':          return '/'
    case 'company_admin':  return '/company_admin'
    case 'manager':
    case 'leasing_agent':  return '/manager'
    case 'driver':         return '/driver'
    case 'resident':       return '/resident'
  }
}

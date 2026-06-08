// B147 3a — shared company-by-name resolution with hardened semantics.
//
// SCOPE: ONE source of truth for "given a text company name (from
// user_roles.company or any other authenticated context), look up the
// matching companies row." Replaces naked `.ilike(name).single()`
// patterns that swallow 0-row + 2+-row errors and silently degrade
// to context-less portals — the B76 class.
//
// HARDENING:
//   • trim() the input — strips trailing-space class (sibling to B159)
//   • exact .eq() match, NOT .ilike() — case + whitespace exact
//   • explicit array shape (no .single() / .maybeSingle()) — 0 / 1 /
//     multi-row all visible; we never guess
//   • ownership cross-check — defense-in-depth verify that the
//     returned row's trim(name) equals the requested name
//   • tagged-log differentiation for ops — [company-resolve-*]
//     prefix per failure mode; user-facing copy is single-string
//     (no info leak about which case fired)
//
// CALLERS (current + planned):
//   • /login dispatch (this commit's integration site)
//   • B147 future caller sites (e.g., utility paths that need
//     companyId before invoking syncOnAdd)
//   • B159 follow-up (any other naked-ilike sites get migrated here)
//
// CLIENT-SAFE: pass in whatever SupabaseClient you have. Client-side
// goes through RLS (user can read own company); service-role bypass.

import type { SupabaseClient } from '@supabase/supabase-js'

export type CompanyResolveErrorReason =
  | 'empty_name'        // input was null/undefined/whitespace
  | 'not_found'         // exact-match query returned 0 rows
  | 'ambiguous'         // exact-match query returned 2+ rows
  | 'error'             // Supabase error (RLS, network, schema)
  | 'name_mismatch'     // returned row's name doesn't trim-equal input (defense)

export type CompanyResolveResult =
  | { ok: true; company: ResolvedCompanyRow }
  | { ok: false; reason: CompanyResolveErrorReason; detail?: string }

// Columns selected — matches the existing /login resolve set so the
// integration is a drop-in. Future callers can extend if needed.
export interface ResolvedCompanyRow {
  id: number | string
  name: string
  is_active: boolean | null
  logo_url: string | null
  display_name: string | null
  support_phone: string | null
  support_email: string | null
  support_website: string | null
  tier: string | null
  tier_type: string | null
  theme: string | null
  account_state: string | null
}

const SELECT_COLUMNS = 'id, name, is_active, logo_url, display_name, support_phone, support_email, support_website, tier, tier_type, theme, account_state'

export async function resolveCompanyByName(
  supabase: SupabaseClient,
  rawName: string | null | undefined,
): Promise<CompanyResolveResult> {
  const normalizedName = (rawName ?? '').trim()
  if (!normalizedName) {
    console.warn('[company-resolve-empty-name]', { rawName })
    return { ok: false, reason: 'empty_name' }
  }

  // Exact match, NO .single() / .maybeSingle() — explicit 0/1/2+ visibility.
  const { data, error } = await supabase
    .from('companies')
    .select(SELECT_COLUMNS)
    .eq('name', normalizedName)

  if (error) {
    console.error('[company-resolve-error]', {
      normalizedName, errorMessage: error.message, errorCode: error.code,
    })
    return { ok: false, reason: 'error', detail: error.message }
  }

  if (!data || data.length === 0) {
    console.warn('[company-resolve-not-found]', { normalizedName })
    return { ok: false, reason: 'not_found' }
  }

  if (data.length > 1) {
    console.error('[company-resolve-ambiguous]', {
      normalizedName, count: data.length,
      ids: data.map((r: { id: number | string }) => r.id),
    })
    return { ok: false, reason: 'ambiguous', detail: `${data.length} rows` }
  }

  const company = data[0] as ResolvedCompanyRow
  // Ownership cross-check (defense-in-depth). .eq() should already
  // guarantee an exact match; this catches null-vs-empty-string,
  // unicode-normalization-equivalence, future query-builder quirks.
  if ((company.name ?? '').trim() !== normalizedName) {
    console.error('[company-resolve-name-mismatch]', {
      expected: normalizedName, got: company.name,
    })
    return {
      ok: false,
      reason: 'name_mismatch',
      detail: `expected '${normalizedName}', got '${company.name}'`,
    }
  }

  return { ok: true, company }
}

// B76: shared company-context bootstrap. Extracted from app/login/page.tsx
// so the post-activation redirect in /signup/redeem/verify can populate
// the same localStorage keys that /login does. Before this extraction,
// the activation path bypassed bootstrap entirely and the user landed
// on /company_admin with null localStorage + 'Legacy Enforcement'
// fallback rendering until they signed out and back in. See
// project_b76_*.md (memory) for the bug arc.
//
// SCOPE GUARD: this is a refactor-and-relocate. Logic is byte-equivalent
// to the original /login block at app/login/page.tsx:173-228. Behavior
// changes are deliberately ZERO — /login should be a no-op refactor,
// the activation path is purely additive. The source-of-truth refactor
// (replacing app/lib/tier.ts hardcoded 'legacy'/'enforcement' fallbacks
// with proper null-handling + DB reads) is filed as B77.

import { supabase } from '../supabase'
import { applyTheme } from './theme'

// Shape used by both callers. /login selects with .ilike on name + this
// field set; the activation path will select by id with the same fields.
// Match the select list in app/login/page.tsx:80-82 so the two paths
// stay byte-equivalent.
export type CompanyBootstrapRow = {
  id: number | string | null
  logo_url: string | null
  display_name: string | null
  support_phone: string | null
  support_email: string | null
  support_website: string | null
  tier: string | null
  tier_type: string | null
  theme: string | null
}

// Convenience for the activation path — fetch by the company_id returned
// from redeem_proposal_code(). Returns null if the row isn't found
// (caller decides what to do; in practice activation just succeeded so
// the row exists).
export async function fetchCompanyBootstrapRowById(
  companyId: number | string,
): Promise<CompanyBootstrapRow | null> {
  const { data } = await supabase
    .from('companies')
    .select('id, logo_url, display_name, support_phone, support_email, support_website, tier, tier_type, theme')
    .eq('id', companyId)
    .single()
  return (data as CompanyBootstrapRow | null) ?? null
}

// Populates all company-context localStorage keys + applies theme.
//
// • Pass a populated row → resolve each field with platform_settings
//   fallback (same as /login today), write each localStorage key,
//   fetch proposal_codes_summary for any feature_overrides, applyTheme().
// • Pass null → clear all 9 company-* keys. Matches /login's `else`
//   branch (admin path, no company association). Theme intentionally
//   not re-applied — applyTheme() with cleared theme key falls back
//   to the default, same as the existing /login behavior.
export async function bootstrapCompanyContext(
  companyData: CompanyBootstrapRow | null,
): Promise<void> {
  if (!companyData) {
    // Admin path / no company. Mirrors app/login/page.tsx:218-228.
    localStorage.removeItem('company_logo')
    localStorage.removeItem('company_name')
    localStorage.removeItem('company_support_phone')
    localStorage.removeItem('company_support_email')
    localStorage.removeItem('company_support_website')
    localStorage.removeItem('company_tier')
    localStorage.removeItem('company_tier_type')
    localStorage.removeItem('company_theme')
    localStorage.removeItem('company_proposal_code')
    return
  }

  // Fetch platform fallbacks only if any field on companyData is missing.
  // Matches the conditional fetch at app/login/page.tsx:173-177.
  let platformData: any = null
  if (
    !companyData.logo_url ||
    !companyData.display_name ||
    !companyData.support_phone ||
    !companyData.support_email ||
    !companyData.support_website ||
    !companyData.theme
  ) {
    const { data: pd } = await supabase.from('platform_settings').select('*').eq('id', 1).single()
    platformData = pd
  }

  const logo = companyData.logo_url || platformData?.default_logo_url
  const displayName = companyData.display_name
  const theme = companyData.theme || platformData?.default_theme || 'gold'
  const phone = companyData.support_phone || platformData?.default_support_phone
  const email2 = companyData.support_email || platformData?.default_support_email
  const website = companyData.support_website || platformData?.default_support_website

  if (logo) localStorage.setItem('company_logo', logo)
  else localStorage.removeItem('company_logo')
  if (displayName) localStorage.setItem('company_name', displayName)
  else localStorage.removeItem('company_name')
  if (phone) localStorage.setItem('company_support_phone', phone)
  else localStorage.removeItem('company_support_phone')
  if (email2) localStorage.setItem('company_support_email', email2)
  else localStorage.removeItem('company_support_email')
  if (website) localStorage.setItem('company_support_website', website)
  else localStorage.removeItem('company_support_website')
  if (companyData.tier) localStorage.setItem('company_tier', companyData.tier)
  else localStorage.removeItem('company_tier')
  if (companyData.tier_type) {
    // Normalize the legacy 'pm' value to canonical 'property_management'.
    // Matches the same normalization in /login + app/lib/tier.ts.
    const canonicalTierType = companyData.tier_type === 'pm' ? 'property_management' : companyData.tier_type
    localStorage.setItem('company_tier_type', canonicalTierType)
  } else {
    localStorage.removeItem('company_tier_type')
  }
  localStorage.setItem('company_theme', theme)
  applyTheme()

  if (companyData.id) {
    const { data: pc } = await supabase
      .from('proposal_codes_summary')
      .select('id, code, status, feature_overrides, redeemed_at, expires_at, client_name, client_email, notes')
      .eq('company_id', companyData.id)
      .eq('status', 'redeemed')
      .maybeSingle()
    if (pc) localStorage.setItem('company_proposal_code', JSON.stringify(pc))
    else localStorage.removeItem('company_proposal_code')
  } else {
    localStorage.removeItem('company_proposal_code')
  }
}

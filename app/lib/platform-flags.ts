import { createSupabaseServiceClient } from './supabase-admin'

// B66.1 — Typed reads for the two dormancy flags on platform_settings.
//
// Both flags default FALSE in the DB schema (NOT NULL DEFAULT FALSE) so
// reads can never return undefined for the column itself. The "default
// FALSE on read failure" pattern below is for the OUTER layer — if the
// platform_settings row query itself fails (network blip, RLS quirk,
// etc.) the safest fail-closed default is FALSE: billing/signup OFF.
//
// Reads use service_role to avoid coupling these checks to the caller's
// auth state. The flags govern public surfaces — `/api/stripe/webhook`
// (unauthenticated) and `/signup` (anon) — where the caller's JWT
// either doesn't exist or shouldn't influence the check.

type FlagsRow = {
  stripe_billing_enabled: boolean | null
  public_signup_open: boolean | null
}

export async function getStripeBillingEnabled(): Promise<boolean> {
  const supabase = createSupabaseServiceClient()
  const { data, error } = await supabase
    .from('platform_settings')
    .select('stripe_billing_enabled')
    .eq('id', 1)
    .single<Pick<FlagsRow, 'stripe_billing_enabled'>>()
  if (error || !data) return false
  return data.stripe_billing_enabled === true
}

export async function getPublicSignupOpen(): Promise<boolean> {
  const supabase = createSupabaseServiceClient()
  const { data, error } = await supabase
    .from('platform_settings')
    .select('public_signup_open')
    .eq('id', 1)
    .single<Pick<FlagsRow, 'public_signup_open'>>()
  if (error || !data) return false
  return data.public_signup_open === true
}

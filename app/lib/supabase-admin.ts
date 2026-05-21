import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// B66.1 — Service-role Supabase client for server-side writes that
// have no authenticated user context. service_role bypasses RLS via
// Supabase's BYPASSRLS grant, so policies don't apply.
//
// USE SPARINGLY. Only call this from server-only code paths where:
//   1. The caller has been authenticated by some other mechanism
//      (e.g., Stripe webhook signature verification), AND
//   2. There's no JWT to authenticate the Supabase call with, AND
//   3. The write target's RLS policies would otherwise block the write.
//
// Initial use: B66.1 webhook handler inserts into stripe_events after
// validating the Stripe signature. Future uses (B66.5 dunning processor,
// B66.7 proposal-code Stripe sub creation, etc.) will reuse this same
// singleton.
//
// NEVER imported by client components. The 'server-only' guard above
// fails the build if a client component attempts to bundle this.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

let _client: SupabaseClient | null = null

export function createSupabaseServiceClient(): SupabaseClient {
  if (_client) return _client
  if (!SUPABASE_URL) {
    throw new Error('[supabase-admin] NEXT_PUBLIC_SUPABASE_URL is not set')
  }
  if (!SERVICE_ROLE_KEY) {
    throw new Error(
      '[supabase-admin] SUPABASE_SERVICE_ROLE_KEY is not set. ' +
      'Configure on Vercel (Production + Preview) before deploy.'
    )
  }
  _client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
  return _client
}

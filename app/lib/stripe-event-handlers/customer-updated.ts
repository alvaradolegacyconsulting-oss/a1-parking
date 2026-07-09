import 'server-only'
import type Stripe from 'stripe'
import { createSupabaseServiceClient } from '../supabase-admin'
import type { SyncResult, SkipResult } from './types'

/**
 * customer.updated handler.
 *
 * Fires when the customer record changes in Stripe — including billing
 * address edits made via the Customer Portal. Syncs the address into
 * companies for B110 Texas tax jurisdiction lookups and customer-
 * facing invoice display.
 *
 * Does NOT sync customer.name → companies.name (internal identity used
 * by RLS via get_my_company() + audit logs + user_roles.company
 * matching; renaming via Stripe-side customer.name update could break
 * a lot).
 */
export async function handleCustomerUpdated(
  event: Stripe.CustomerUpdatedEvent,
): Promise<SyncResult | SkipResult> {
  const customer = event.data.object
  const supabase = createSupabaseServiceClient()

  const { data: company, error: lookupErr } = await supabase
    .from('companies')
    .select('id')
    .eq('stripe_customer_id', customer.id)
    // Seed/Wipe Layer 1 — belt-and-suspenders. Test/demo tenants never
    // hold Stripe IDs, so this filter is defensive against a future bug
    // that copies a real customer id onto a non-production row.
    .eq('company_env', 'production')
    .maybeSingle()
  if (lookupErr) {
    return { ok: false, reason: `companies lookup failed for customer ${customer.id}: ${lookupErr.message}` }
  }
  if (!company) {
    console.warn('[stripe-event-handlers] customer.updated for unknown customer_id', { customerId: customer.id })
    return { ok: true, skipped: true, reason: `unknown customer_id ${customer.id}` }
  }

  const addr = customer.address
  const { error: updErr } = await supabase
    .from('companies')
    .update({
      address:             addr?.line1 ?? null,
      billing_city:        addr?.city ?? null,
      billing_state:       addr?.state ?? null,
      billing_postal_code: addr?.postal_code ?? null,
      billing_country:     addr?.country ?? null,
    })
    .eq('id', company.id)
  if (updErr) {
    return { ok: false, reason: `companies UPDATE failed for customer ${customer.id}: ${updErr.message}` }
  }

  return { ok: true }
}

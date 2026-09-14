import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServiceClient } from '../../../lib/supabase-admin'
import { syncOnAdd } from '../../../lib/stripe-mutations'
import { runPermitSync } from '../../../lib/permit-sync-cron'

// ════════════════════════════════════════════════════════════════════
// /api/cron/sync-permits — daily, up-only permit quantity sync.
//
// See app/lib/permit-sync-cron.ts for what the loop is and is not. This
// file is the wiring: auth, company enumeration, the real syncOnAdd, and
// the audit row.
//
// ── 🔴 THIS BYPASSES /api/billing/sync-on-add's AUTHORIZATION. BY DESIGN.
// That route resolves company_id from the CALLER's company_admin role.
// A service_role cron has no role row, so it cannot go through the
// route — it calls syncOnAdd() directly, per company. That means the
// route's "must be a company_admin of this company" check never runs
// here, and CRON_SECRET IS THE ONLY THING between "runs daily" and
// "anyone can trigger a company-wide Stripe sync". The header check
// below is load-bearing, not ceremony. Same idiom as
// /api/cron/dunning — one pattern for cron auth in this codebase, not
// two.
//
// What that still does NOT allow: the route contract for
// /api/billing/sync-on-add is untouched. No manager can trigger a
// Stripe call. billing-is-subscriber-only holds.
//
// ── SCHEDULE: DAILY, DELIBERATELY ───────────────────────────────────
// Hourly would cost nothing when nothing changes (noop_within_floor is
// a DB read, not a Stripe call). But when something DOES change, every
// run that sees a delta writes a proration line item with
// create_prorations. A property approving twenty permits across a
// working day would produce up to a dozen small proration lines on the
// invoice instead of one — and the CUSTOMER reads that invoice. Daily
// trades proration latency (a day, not an hour, of un-prorated
// permits) for invoice legibility. At zero PM subscribers the latency
// side is worth exactly nothing; the legibility side is a support
// conversation avoided. Tune it knowing that is the trade.
//
// ── COMPANY SELECTION ───────────────────────────────────────────────
// Every company with a stripe_subscription_id. syncOnAdd handles the
// rest itself — no per_permit line item → skipped_no_line_item, manual
// collection → skipped_manual_collection — so the enumeration stays
// dumb and the decisions stay in one place.
// ════════════════════════════════════════════════════════════════════

export async function GET(request: NextRequest): Promise<NextResponse> {
  // ── Auth — load-bearing, see header ──────────────────────────────
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createSupabaseServiceClient()

  const summary = await runPermitSync({
    listCompanies: async () => {
      const { data, error } = await supabase
        .from('companies')
        .select('id, name')
        .not('stripe_subscription_id', 'is', null)
        .order('id')
      if (error) throw new Error(`companies enumeration failed: ${error.message}`)
      return (data ?? []).map(c => ({ id: Number(c.id), name: String(c.name) }))
    },
    sync: (companyId) => syncOnAdd(companyId, 'permit'),
  })

  // ── One audit row per run. Durable where the Vercel log is not. ──
  // Written AFTER the loop so completed_loop is true on the row —
  // which is the point: a run that died mid-loop would leave NO row,
  // and that absence is itself the signal (distinct from a row saying
  // "scanned 3, errors 1").
  const { error: auditErr } = await supabase.from('audit_logs').insert({
    user_email: 'cron:sync-permits',
    action:     'BILLING_SYNC_CRON',
    table_name: 'companies',
    record_id:  summary.started_at,
    new_values: {
      kind:              'permit',
      companies_scanned: summary.companies_scanned,
      by_action:         summary.by_action,
      errors:            summary.errors,
      completed_loop:    summary.completed_loop,
      elapsed_ms:        summary.elapsed_ms,
      outcomes:          summary.outcomes,
      note:              'up-only via syncOnAdd (floor-guarded, create_prorations). Bidirectional trim is reconcileAtRenewal at subscription_cycle.',
    },
    created_at: new Date().toISOString(),
  })
  if (auditErr) console.error('[sync-permits] audit row insert failed', auditErr)

  console.info('[sync-permits]', {
    companies_scanned: summary.companies_scanned,
    by_action: summary.by_action,
    errors: summary.errors,
    elapsed_ms: summary.elapsed_ms,
    audit_written: !auditErr,
  })

  return NextResponse.json({ ok: true, ...summary, audit_written: !auditErr })
}

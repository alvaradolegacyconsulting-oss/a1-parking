// ════════════════════════════════════════════════════════════════════
// Permit sync — the loop behind /api/cron/sync-permits.
//
// Pure orchestration with injected dependencies, so the behaviour the
// audit design depends on — "a per-company error does not abort the
// run" — can be PROVEN with a fake that throws, without touching
// Stripe. The route wires the real syncOnAdd and the real audit write;
// the verification wires fakes. Same loop either way.
//
// ── WHAT THIS IS, AND IS NOT ────────────────────────────────────────
// It calls syncOnAdd(companyId, 'permit') for every company that holds
// a Stripe subscription. syncOnAdd is FLOOR-GUARDED — it only ever moves
// the per_permit quantity UP, with create_prorations, and returns
// noop_within_floor when the approved count has not crossed the prepaid
// floor. So:
//
//   🔴 THIS IS UP-ONLY. It is NOT reconciliation. A permit approved on
//   day 1 and deactivated on day 3 is prorated UP on day 1's run and is
//   not prorated down until renewal. That is identical to today's
//   immediate-sync behaviour — no regression — but "daily reconciliation"
//   would be a name that promises bidirectionality this does not have.
//   reconcileAtRenewal (stripe-mutations.ts) is the bidirectional one,
//   and it must NOT be removed as "redundant" because this exists.
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────
// /api/billing/sync-on-add is gated to company_admin. A MANAGER
// approving permits — which is who works the approval queue — cannot
// call it (billing is subscriber-only, by design). So a manager's
// approve never syncs, and the prorated charge for the partial cycle
// between the approve and the next renewal was lost. This closes that
// gap without widening who may trigger a Stripe call: the cron runs as
// service_role, no role change anywhere. It also catches every OTHER
// missed sync — a failed fetch, a closed tab mid-request, a bulk import,
// whatever ships next — because it reconciles state rather than
// reacting to a click.
//
// ── "FOUND NOTHING" AND "DID NOT RUN" ARE DIFFERENT ROWS ───────────
// The route writes ONE audit row per run with companies scanned,
// per-company action, and elapsed time. Vercel's cron log is not
// durable; audit_logs is. A run that saw every company return
// noop_within_floor is a row; a run that never fired is the ABSENCE of
// a row; a run that errored on company #2 of 3 is a row that records
// #1 and #3 as processed and #2 as errored. None of those three can be
// mistaken for another.
// ════════════════════════════════════════════════════════════════════

import type { SyncOnAddResult } from './stripe-mutations'

export type PermitSyncCompany = { id: number; name: string }

export type PermitSyncOutcome =
  | { company_id: number; company_name: string; ok: true;  action: string }
  | { company_id: number; company_name: string; ok: false; reason: string; threw: boolean }

export type PermitSyncSummary = {
  started_at: string
  elapsed_ms: number
  companies_scanned: number
  // Counted by the action string syncOnAdd returned. noop_within_floor
  // and the skipped_* family are "nothing to do", incremented is a
  // real Stripe mutation, errors are counted separately.
  by_action: Record<string, number>
  errors: number
  // The one thing G4 exists to prove: an error on company N did not
  // stop companies N+1.. from being processed.
  completed_loop: boolean
  outcomes: PermitSyncOutcome[]
}

export type PermitSyncDeps = {
  listCompanies: () => Promise<PermitSyncCompany[]>
  sync: (companyId: number) => Promise<SyncOnAddResult>
  now?: () => number
}

export async function runPermitSync(deps: PermitSyncDeps): Promise<PermitSyncSummary> {
  const now = deps.now ?? (() => Date.now())
  const t0 = now()
  const summary: PermitSyncSummary = {
    started_at: new Date(t0).toISOString(),
    elapsed_ms: 0,
    companies_scanned: 0,
    by_action: {},
    errors: 0,
    completed_loop: false,
    outcomes: [],
  }

  const companies = await deps.listCompanies()
  summary.companies_scanned = companies.length

  for (const c of companies) {
    // 🔴 PER-COMPANY try/catch IS THE DESIGN, not defensiveness.
    // syncOnAdd is documented non-throwing, but that is a contract in a
    // comment, and a later refactor that adds a `throw` would otherwise
    // convert "company #2 failed" into "the run vanished after #1" —
    // with the audit row never written. The loop must outlive any one
    // company. G4 in the verification asserts exactly this.
    try {
      const r = await deps.sync(c.id)
      if (r.ok) {
        summary.by_action[r.action] = (summary.by_action[r.action] ?? 0) + 1
        summary.outcomes.push({ company_id: c.id, company_name: c.name, ok: true, action: r.action })
      } else {
        summary.errors++
        summary.outcomes.push({ company_id: c.id, company_name: c.name, ok: false, reason: r.reason, threw: false })
      }
    } catch (e) {
      summary.errors++
      summary.outcomes.push({
        company_id: c.id, company_name: c.name, ok: false,
        reason: (e as Error)?.message ?? String(e), threw: true,
      })
    }
  }

  summary.completed_loop = true
  summary.elapsed_ms = now() - t0
  return summary
}

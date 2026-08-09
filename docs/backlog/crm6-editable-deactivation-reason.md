# Backlog — CRM-6 candidate: editable deactivation reason (in place)

**Filed:** 2026-08-09 (surfaced during deactivation-email arc Commit C smoke).
**Priority:** P2. Not a bug — a workflow gap. Deactivation email arc
ships without it; this fills the "wrong reason recorded" gap after
the arc lands.

## What surfaced this

Commit C's no-op detection at [manager-crm-writes.ts](../../app/lib/manager-crm-writes.ts)
returns ok WITHOUT re-writing when a re-fire hits the same reason
against the same already-deactivated row. That is correct — one
deactivation event → one audit → one email. But it means a **wrong**
reason cannot be corrected today by clicking Deactivate again with a
different reason:

- The `residents.status === 'active' && resident.is_active` gate at
  [PmResidentCrm.tsx:640](../../app/components/PmResidentCrm.tsx#L640)
  hides the Deactivate button once `is_active=false`. There is no
  affordance to re-open the modal against a deactivated row.
- Even if the UI were opened directly, the writer's no-op check would
  skip the write (same reason → return) or run the RPC with a NEW
  reason but stamp deactivated_at again — which would re-fire the
  email (dedup on `deactivation_notified_at < deactivated_at`).
- Neither shape matches what the user actually wants: **change the
  reason on an existing deactivation record without re-notifying and
  without shifting the deactivation timestamp.**

## Scope

New in-place edit affordance on deactivated rows in the CRM. Behaves
as an **amendment**, not a re-deactivation:

1. Reactivate + re-deactivate is the wrong shape (fires an email, resets
   deactivated_at, would need a separate email for "actually, we meant
   X reason"). Don't use it.
2. Two dropdowns get an "Edit reason" link when the row is already
   `is_active=false`:
   - PmResidentCrm DetailHeader (near the current StatusPill at :653)
   - VehicleCard's deactivated presentation (mirror shape)
3. Opens the same modal as Deactivate but pre-fills reason + note and
   changes the primary button to "Update reason". Submit calls a NEW
   RPC (`amend_deactivation_reason`) that:
   - Requires `is_active=false` (fails otherwise; this is edit-in-place
     only)
   - Updates `deactivation_reason` + `deactivation_note` only —
     **does NOT touch `deactivated_at`, `is_active`, or `deactivation_notified_at`**
   - Writes a distinct audit action `AMEND_DEACTIVATION_REASON` with
     `old_values` (prior reason + note) and `new_values` (new reason +
     note). No `email_decision` field — no email fires.
4. Reason validation reuses `isValidResidentReason` /
   `isValidVehicleReason` + `reasonRequiresNote` — same guardrails
   as the initial Deactivate.

## Why an amendment, not a re-deactivation

Deactivation carries three distinct facts:
- **When** it happened (`deactivated_at`)
- **Why** it happened (`deactivation_reason` + `deactivation_note`)
- **Who** was told (`deactivation_notified_at` — Commit A column)

An amendment corrects the "why" without disturbing "when" or "who
was told." A re-deactivate would rewrite all three and fire a second
email — inappropriate for a clerical correction. The audit trail
distinguishes the two via action code (`DEACTIVATE_*` vs
`AMEND_DEACTIVATION_REASON`).

## Interaction with Commit D + the no-op path

Commit D preserves the writer's no-op detection specifically because
this backlog exists — same-reason re-fire remains a true no-op
(don't email, don't audit, don't touch the row). Once
`amend_deactivation_reason` ships, the "I picked the wrong reason"
workflow has a first-class path that doesn't rely on the writer
accepting a re-deactivation.

## Scope negatives

- No **historical revision** to prior email content — the email that
  went out under the wrong reason stays gone; the correction is
  internal to the CRM.
- No **email to the resident** on amendment. This is a bookkeeping
  fix, not a communication.
- No **restriction on how many amendments** per row. The audit log
  is the ledger; N `AMEND_DEACTIVATION_REASON` rows chronicle N edits.

## Related

- [cascade-reason-stamping.md](cascade-reason-stamping.md) — the sibling
  gap where cascade paths stamp NULL reasons today. Amendment workflow
  would let managers fix those after cascade ships to real properties.
- Deactivation-email arc Commit C (5aab961) — introduced the no-op
  check that this backlog complements.

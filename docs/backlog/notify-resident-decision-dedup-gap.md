# Backlog — `notifyResidentDecision` fires twice on double-click

**Filed:** 2026-08-06.
**Priority:** LOW — cosmetic, not a data or authorization defect. But confirmed at a live property, and a duplicate transactional email reads as a system that isn't in control of itself.

## Observation

Live in prod, resident 695 (Arely Cruz), 2026-08-03:

```
2026-08-03 01:05:02.127+00  DECLINE_RESIDENT  message_id 18a050ce-…
2026-08-03 01:05:02.911+00  DECLINE_RESIDENT  message_id 332c50c3-…
```

Two `DECLINE_RESIDENT` audit rows **0.8 seconds apart**, each with a distinct Resend `message_id`. The resident received two identical decline emails.

## Preflight already predicted this exact shape

From the 2026-08-04 deactivation-preflight Part E:

> `notifyResidentDecision` — **NO DEDUP AT ALL** ([route.ts:34-111](app/api/manager/notify-resident-decision/route.ts#L34-L111)) has no idempotency guard, no prior-send check, no DB flag. Double-click / retry → double email. Only defense is the manager UI (not read here). This is the closest precedent to the new deactivation email — worth calling out that if double-fire protection is a requirement, it has to be built new (either dunning-style column on `residents`/`vehicles`, or audit-log probe like resend-invite).

Now observed, not theoretical.

## Failure mechanism

The sending happens client-side via [manager-crm-writes.ts:70](app/lib/manager-crm-writes.ts#L70) `notifyResidentDecision` → `fetch('/api/manager/notify-resident-decision', POST)`. Two rapid clicks (or a double-click during a slow response) produce two POSTs, each of which fetches the resident under RLS + builds an HTML body + calls `sendEmail()` + writes an audit row. No idempotency layer between the click and Resend.

## Fix shape

Dunning-style timestamp compare, applied to `residents`:

- Add `decision_notified_at TIMESTAMPTZ` to `residents`.
- Route logic: `sendEmail` only when `decision_notified_at IS NULL OR decision_notified_at < COALESCE(status_changed_at, updated_at)`.
- After `sendEmail` succeeds, update `decision_notified_at = now()`.

Note the `COALESCE` — `residents` doesn't currently carry a per-decision timestamp; `updated_at` is a reasonable proxy but the correct primitive is a `status_changed_at` set alongside any `status` write. That's out of scope for the dedup fix but worth noting so the belt covers the actual state transition.

## Alternative: audit-log probe (soft)

Analogous to [resend-invite/route.ts:136-144](app/api/admin/resend-invite/route.ts#L136-L144) which queries `audit_logs` for the same action within 60s to flag `was_rapid_resend`. This is a softer guard — it detects duplicates for reporting but does NOT block. Less protection than the column-gate, but doesn't require a schema change. Discussed in the preflight; rejected there for the deactivation email because the harder guard is worth the column.

## Relationship to deactivation email dedup

The deactivation notification email spec (Task 3 Commit 4+, pending) already carries this fix in its design:

> Dedup timestamp compare: `send if deactivation_notified_at IS NULL OR deactivation_notified_at < deactivated_at`

That handles deactivate → reactivate → deactivate correctly (both are real events; both should send) without a clear-on-reactivate step. Same primitive works here for `notifyResidentDecision`.

**When the deactivation email work touches `residents-crm-writes.ts` / the API route, fold this fix in.** Same file, same shape, same reasoning. Don't ship the deactivation email with dedup and leave the older sibling without.

## Scope

- ~10 LOC in the API route (guard check + timestamp write)
- 1 migration for the column
- No behavior change on happy path
- Fold into deactivation Commit 4+ when we're in this file

## Adjacent

- Preflight Part E [FOR MATEO deactivation preflight 2026-08-04]
- [app/api/manager/notify-resident-decision/route.ts](app/api/manager/notify-resident-decision/route.ts)
- Dunning dedup precedent at [app/lib/dunning-emails.ts:71-77](app/lib/dunning-emails.ts#L71-L77) (per-stage column gate + verify-after-write)

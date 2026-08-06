# Backlog — Guest-authorization arrival grace: product policy question

**Filed:** 2026-08-05 during guest-auth `CURRENT_DATE` fix (FOR MATEO thread).
**Type:** Product policy decision, not a bug fix. **Not on the engineering queue** until Jose raises it with A1.

## What the fix creates

Commit B of the guest-auth `CURRENT_DATE` fix (`20260805_pm_plate_lookup_current_date_central_sweep.sql`) corrects a bug on both edges of the guest-authorization window. On the end-edge (last day of the window), guests were getting denied 5 hours early at 7pm Central; that's fixed. On the start-edge (day before the window opens), guests were getting **admitted 5 hours early** at 7pm the evening before; that's also fixed, in the tightening direction.

The result: a guest whose window starts Aug 4 who parks at 8pm CDT on Aug 3 was covered today and won't be after the fix.

## The question

**Should a guest authorization window admit from the evening before its start date?**

The current fix says NO — the window means what it says, and enforcement matches the property's declared start date to the Central-time calendar day. Any earlier arrival lands in the pre-window period; enforcement is correct to treat the plate as unauthorized.

The alternative would say YES — a resident inviting a guest for "Aug 4" is being loose with time. Their guest may arrive at 10pm Aug 3 to be there for the Aug 4 event. Requiring the resident to know that "Aug 4" means midnight-to-midnight Aug 4 Central is an unforgiving product contract.

## Why this is not part of the timezone fix

The bug is a timezone bug: `CURRENT_DATE` in a UTC session mis-reads what "today" means in Central. Correcting that is not a policy choice. Adding arrival grace (or checkout grace, for that matter) IS a policy choice — it says the window extends beyond its stated dates by some amount for some reason.

Smuggling a policy change into a timezone fix would be the wrong shape for both. The timezone fix ships; if arrival grace is wanted, it lands as its own decision with its own scoping — how much grace, applied where, communicated to residents how.

## Data we'd want before deciding

Not needed to make the decision; needed to make it well.

1. **How often do current guest authorizations get used on the evening before their start date?** Query the plate-lookup audit logs for `result_type='guest_authorized'` where `now() < start_date` in Central time. If it's zero, the current fail-open behavior isn't being relied on. If it's non-trivial, changing it produces visible friction.
2. **How does A1 talk about start dates to residents / guests today?** If the resident portal or manager UI says "starts on Aug 4," does anyone read that as "midnight Aug 4" vs "the evening of Aug 4" vs "sometime on Aug 4"? Copy audit + user interview.
3. **What do peer platforms do?** ParkMobile, PropertyMeld, whoever — is 24-hour precision the industry norm or the outlier?

## Scope if built

- Add an optional `arrival_grace_hours INTEGER` (or per-property setting) to `guest_authorizations`.
- Rewrite the branch-4 predicate in `pm_plate_lookup` to:
  ```sql
  AND ga.start_date <= public.current_date_central() + interval '<grace> hours'
  ```
  (or equivalent, converted properly for timestamptz-vs-date semantics)
- Communicate the grace window in the resident/guest UI so it's not a hidden behavior.
- Same question on the end-edge (checkout grace) — does a guest whose window ends Aug 5 get admitted at midnight-Aug-6 to leave? Probably yes (harmless), but the answer should be explicit.

## Adjacent

- [pattern_enforcement_matches_on_plate_alone.md](../../.claude/projects/-Users-ALC-a1-parking/memory/pattern_enforcement_matches_on_plate_alone.md) — the standing pattern that enforcement predicates are load-bearing across many surfaces. Any grace-window change is a coordinated multi-artifact edit.
- [migrations/20260805_pm_plate_lookup_current_date_central_sweep.sql](../../migrations/20260805_pm_plate_lookup_current_date_central_sweep.sql) — the fix that surfaced this question.

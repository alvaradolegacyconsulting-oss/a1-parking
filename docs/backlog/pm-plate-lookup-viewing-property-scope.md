# pm_plate_lookup ignores the manager's viewing property

**Status:** open, tomorrow's first task.
**Priority:** MEDIUM (silent-wrong on 5 branches, visibly-wrong on AP). No live-customer impact today (A1 has zero managers).
**Filed:** 2026-07-23 (surfaced during AP-MANAGE-CLIENT smoke)
**Affects:** `pm_plate_lookup` RPC + `app/manager/page.tsx` Plate Lookup tab render.

## The defect

`pm_plate_lookup` scopes every match against the caller's ENTIRE assigned-properties portfolio via `= ANY (v_properties_normalized)`. No branch takes or uses a "currently viewing" property. Manager viewing property X sees matches from property Y as if they were at X.

**Verified via code inspection AND behaviourally** (2026-07-23, Jose):
- Resident `LESLY` (Unit 205) — returns *"Active resident"* whether manager `+forcee@` is viewing Test Legacy Property (138) or Test Property for Driver (146)
- `TESTAP` (authorized at 146) — same manager viewing 138 gets `authorized_plate` result rendering as ✓ Authorized

## The 7 branches all share the defect

Grep-verified in `migrations/20260723_ap_cascade_check_authorized_plate.sql`:

| Branch | Line | Scoping |
|---|---|---|
| 0 — DNT (parked) | 262 | `= ANY (v_properties_normalized)` |
| 1 — Resident active | 280 | `= ANY (v_properties_normalized)` |
| 1.5 — AP (via `check_authorized_plate(v_normalized, NULL)`) | 275 | caller-role scope internally = `get_my_properties()` |
| 2 — Pending permit | 309 | `= ANY (v_properties_normalized)` |
| 3 — Plate change | 322 | `= ANY (v_properties_normalized)` |
| 4 — Guest auth | 345 | `= ANY (v_properties_normalized)` |
| 5 — Visitor pass | 359 | `= ANY (v_properties_normalized)` |

## Why AP surfaced it now

Only AP branch returns `ap_property_name` in the response. Other 5 branches return only `unit_number` / `guest_name` / etc — no property field. Client has no data to compare against `manager.name` for those branches, so no warning to render. **Silent-wrong** for resident/pending/plate_change/guest/visitor; **visibly-wrong** for AP (green ✓ next to a different property's name on the card).

## Severity ranking (Mateo 2026-07-23)

**Silent-and-confidently-wrong beats visibly-inconsistent** as a failure mode. A manager reading the AP card sees contradictory data on screen — a careful one can catch it. A manager reading the resident card sees only "Unit 205" — nothing to contradict, nothing to notice. That reverses the initial urgency reading: **the 5 silent branches are more urgent than AP**, and both should be fixed together.

## Fix shape (proposed — report-first tomorrow)

Add a viewing-property parameter to `pm_plate_lookup`; scope every branch (including branch 1.5's `check_authorized_plate` call) to that property when provided.

```sql
CREATE OR REPLACE FUNCTION public.pm_plate_lookup(
  p_plate         TEXT,
  p_viewing_property TEXT DEFAULT NULL   -- NEW; NULL = full-portfolio (back-compat)
) RETURNS jsonb ...
```

Each branch's predicate: `AND (p_viewing_property IS NULL OR lower(trim(x.property)) = lower(trim(p_viewing_property)))` layered onto the existing `= ANY (v_properties_normalized)` scope. Both must hold — belt (portfolio scope) and braces (viewing scope).

Client passes `manager.name` for the viewing-property when calling from the Plate Lookup tab. Default NULL preserves back-compat.

## 🔴 Pre-build checks (report-first, tomorrow)

1. **Does `pm_plate_lookup` have callers other than the manager Plate Lookup tab?** If it's called from anywhere without a viewing-property concept, a required parameter breaks them. Defaulted parameter (proposed above) preserves back-compat but must be confirmed via grep across `app/` + migrations.
2. **CREATE OR REPLACE with a changed signature creates a duplicate, not a replacement** — DROP first, verify `pg_proc` COUNT = 1 (standing trap; see AP-SCHEMA VQ.SIGNATURE for the pattern).
3. **Which branches need the predicate.** All 7 by default, but AP branch's `check_authorized_plate` already takes p_property — pass viewing-property through instead of NULL.
4. **Driver-facing paths need nothing** — driver already passes `targetProp` per-call to `check_authorized_plate`. This is a manager-surface fix.
5. **Multi-property manager backlog entry** — same-day filed 2026-07-23 (`docs/backlog/manager-multi-property-settings-selector.md`) — its silent-first-property gap is DIFFERENT from this (that one is Settings-tab UI; this is Plate Lookup RPC). Both should be resolved before the first multi-property manager customer.

## Impact today

Zero live-customer impact. A1 has 2 CAs + 3 drivers, **no managers**. Test-LEGACY's `alvaradolegacyconsulting+forcee@gmail.com` is the only multi-property manager and is a probe account.

## Trigger for pickup

**Tomorrow's first task** — before any new arc work starts. Fix as a single logical unit (RPC + client + VQs) so the 5 silent branches and the 1 visible branch are corrected together.

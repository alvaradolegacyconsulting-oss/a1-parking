# Policy question for A1 — the daily-renewed 24h visitor pass

**Date filed:** 2026-10-09
**Ruling:** Jose — "a policy question for A1, not a bug."

## The observation

`XPW9029`, unit 62, Green Acres: **31 passes since 2026-09-16**, one
almost every day, each for 24 hours, almost all issued by
`giselle.castaneda111@gmail.com` for the same visitor name.

A 24-hour pass renewed every day is a resident vehicle wearing a
visitor pass. The vehicle is parked there continuously; only the
paperwork is temporary.

## Why it is not a bug

Nothing is broken. Green Acres sets `visitor_pass_limit = null`, so
there is no cap to exceed, and every pass was validly issued by a real
resident for their own unit. The platform is doing exactly what it was
asked to do.

**It is also not ours to decide.** Whether a long-term guest vehicle
should be registered as a resident vehicle, pay a permit fee, or keep
renewing visitor passes is A1's property-management policy and their
contract with the resident. The platform states facts; it does not
grant or withhold permission.

## What A1 may want to know

- 20 of 28 properties set **no** pass limit, including Green Acres. A
  limit is the lever that would surface this pattern, and it is a
  per-property setting A1 already controls from the manager portal.
- If they want visibility rather than a cap, the useful report is
  "plates with more than N passes in 30 days at this property" — a
  repeat-visitor list. That is a small manager-portal view, not a
  product change, and it would be worth building only if A1 says the
  pattern matters to them.
- If the answer is "that vehicle should be registered", the resident
  can add it through the normal add-vehicle flow and the pass renewals
  stop. No migration needed.

## Recommendation

Report the pattern to A1 and ask. Do not add an automatic rule: a cap
on consecutive renewals would break legitimate cases (a relative
staying a fortnight, a contractor on a long job) and would be the
platform making a property-management decision on A1's behalf.

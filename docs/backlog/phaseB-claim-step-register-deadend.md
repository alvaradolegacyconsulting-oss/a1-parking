# 🔴 Phase B blocker — /register is a dead end for every IMPORTED resident

Found 2026-10-15 while answering the architect's "15 residents have no
vehicle" question. The answer to that is easy; this is the thing it
surfaced.

## The mechanic

`app/register/page.tsx:177-190` refuses registration when an
**active** `residents` row already exists at that property:

```
.ilike('email', emailLower).ilike('property', escapedProperty)
.eq('is_active', true).eq('status', 'active')
→ "You are already registered at this property. Please log in instead."
```

The Phase B loader creates `residents` rows and **no auth users** — by
design, because Jose ruled out a shared temp password and the customer
owns the data until the resident claims it.

So after the Alden Park load, all **228 imported residents** have a
record, no login, and the QR code — the only path they know — tells
them to log in instead. There is nothing to log in with.

## It inverts the obvious reading

The architect's 15 vehicle-less residents are the only Alden Park
residents for whom `/register` will still work after the load, because
they are the only ones without a `residents` row. The 228 we DO import
are the ones who lose the path.

That is also why leaving the 15 out is the right call rather than a
compromise — see the recommendation below.

## What Phase B has to do

The claim step is already in the plan. What this adds is that it cannot
be a separate surface the resident has to be told about out of band:

1. **The refusal message is the handoff.** A resident who scans the QR
   and has an imported record must be sent to the claim flow from that
   screen, not told to log in. "We already have your details for this
   unit — set up your password" is the same screen doing its job, not a
   new one.
2. **The claim path must be reachable with what the resident has**:
   their email, and the property from the QR. Same shape as the
   existing OTP recovery card (B162).
3. 🔴 **Do not relax the `/register` guard to fix this.** The guard is
   what stops a second resident silently attaching to an occupied
   active residency; widening it to let imported rows through would
   re-open the case it was hardened for on 2026-07-25.

## Verify it before building

```sql
-- after a load, these are the people with a record and no way in
SELECT count(*) FROM residents r
 WHERE r.property = 'Alden Park Kingsland' AND r.is_active AND r.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(btrim(r.email)));
```

Expected immediately post-load: the full imported count. Expected after
the claim flow ships and is used: falling.

## Recommendation on the 15 (the original question)

**Leave them out of the file.** Reasons, in order:

1. Enforcement needs vehicles, so a vehicle-less resident changes no
   enforcement outcome.
2. They are the only Alden Park residents for whom the normal QR
   registration still works after the load, so excluding them keeps
   them on a working path instead of moving them onto one that does not
   exist yet.
3. Allowing vehicle-less rows would mean making `plate` and
   `plate_state` optional, which weakens the required-field check for
   358 rows to accommodate 15 — and a blank plate is indistinguishable
   from a row someone forgot to finish.

The cost is that those 15 units read as empty in the manager's unit
view until the resident registers. That is visible, reversible and
honest; a half-populated resident record is none of those.

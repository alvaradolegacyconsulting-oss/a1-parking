# VEHICLE_STATE_CHANGE records "system" where a person acted

Filed 2026-10-15. **Not built.** Reported because the fix has a design
tension with a deliberate choice in the existing trigger, and that
should be settled before anyone writes it.

## What is happening

`migrations/20261013_stage1_vehicle_state_audit.sql:51`

```sql
v_actor := COALESCE(NULLIF(lower(trim(COALESCE(auth.jwt() ->> 'email', ''))), ''), 'system');
```

Service-role paths have no user JWT, so `auth.jwt()` is NULL and the
actor falls to `system`. Accurate, and it reads like a background job.

Affected paths, all of them inserts by server code on behalf of a
person:

| path | who really acted |
|---|---|
| QR registration (`/api/register/companion-vehicle`) | the registrant — e.g. 10/15 06:02, Green Acres, XYF7494, pending |
| `/register`'s own companion vehicle | the registrant |
| B113 bulk invite (`/api/billing/bulk-invite`) | the company_admin running the upload |
| the Phase B loader, when it lands | the CA who submitted, and Jose who approved |

## 🔴 The tension: the trigger says actor never comes from an argument

Its own comment, same file, line 109:

> Actor comes from the JWT (**'system' when there is none**), never
> from an argument.

That is deliberate. It is why a direct PATCH cannot claim to be
somebody else — the actor is derived, not declared.

A transaction-local setting **is** a declared value. `SET LOCAL
app.whatever` is issued by whoever is running the transaction, so
reading it into `audit_logs.user_email` would make the actor
caller-supplied for exactly the paths where it is currently
unforgeable. That is a real weakening, even if every current setter is
trustworthy server code.

## The precedent that shows the way

Stage 1b already does this, and does it carefully.
`approve_vehicle` sets `app.vehicle_approve_id`, the audit trigger
reads it, and it is documented as **an audit annotation, not a security
control**. `new_values.via_approve_rpc` then records *whether the flag
was set*, which is what distinguishes an approval from a direct write
that reached the same state.

So the shape that preserves both properties:

- **`user_email` stays derived.** JWT when there is one, `system`
  otherwise. Never the GUC.
- **The declared identity goes in `new_values`**, named as a claim:
  `acted_for` (or `registrant_email`), plus `actor_source:
  'jwt' | 'declared' | 'none'`.
- A reader then sees "system, acting for jane@…, declared by the
  registration route" — which answers the question the current row
  fails to answer, without turning a derived field into a claimed one.

The alternative — overwrite `user_email` from the GUC — is simpler to
read in the log and strictly worse: one spoofable field instead of one
honest field plus one labelled claim.

## Who can set the GUC matters

`SET LOCAL` is not reachable from PostgREST directly, so a browser
cannot set it. But any `SECURITY DEFINER` RPC *could*, and RPCs are
callable by `authenticated`. So the setting is exactly as trustworthy
as the code that sets it — which is an argument for labelling it
`declared` rather than treating it as identity, and for a gate that
asserts only the intended paths set it.

## Scope when it is built

1. the trigger reads `current_setting('app.acting_for', true)` and
   records it in `new_values` with `actor_source`, leaving
   `user_email` alone;
2. the three service-role insert paths set it;
3. 🔴 the Phase B loader sets it too — a 358-row load attributed to
   `system` is the worst instance of this, and the one with the most
   need for provenance;
4. a gate: a JWT path records `actor_source: 'jwt'` and no
   `acted_for`; a service-role path with the setting records
   `declared` and the address; a service-role path **without** it
   records `none` and still writes the row rather than failing.

## Not in scope

Backfilling existing `system` rows. The information is not recoverable
from the audit log, and inventing it is worse than leaving it honest.

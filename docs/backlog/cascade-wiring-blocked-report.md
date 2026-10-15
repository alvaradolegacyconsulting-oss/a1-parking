# 🔴 Cascade wiring: stop. My approved proposal was wrong about reactivation.

Report-first, 2026-10-15. **Nothing wired.** The route is built and
gate-green, but wiring it today as designed would be a regression, and
the error is in the proposal that was ruled on — so the ruling rests on
a false premise.

## What I got wrong

The proposal's comparison table said, for `/admin`:

```
REACTIVATE
  (residents NOT restored)
  (vehicles NOT restored)
```

**That is false.** `/admin`'s reactivate branch does both:

```ts
// admin/page.tsx:542
await supabase.from('residents').update({ is_active: true }).ilike('property', escapeIlikeValue(propertyName))

// admin/page.tsx:555 — NOT a blanket write, deliberately
const { data: reVeh } = await supabase.rpc('admin_reactivate_property_vehicles', { p_property_id: p.id })
```

I derived "not restored" from the **deactivate dialog's** wording —
"any resident parking-space **assignments** and pending space/guest
requests will NOT auto-restore" — which is about space assignments and
pending requests, not residents and vehicles themselves. I read a
narrow, accurate disclosure as a broad one and never opened the
reactivate branch.

🔴 **And then my gate certified it.** `verify:cascade` control 9
asserts "reactivation does NOT restore residents or vehicles" and
passes — so a gate I wrote is currently defending the regression. That
is worse than the original error: a wrong assertion that passes will
outlive the conversation that produced it.

## What `/admin` actually does, both directions

| | deactivate | reactivate |
|---|---|---|
| staff users | ban + `is_active=false` for those with **no other property** (array length only — Finding B) | unban + `is_active=true` for **all** assigned (Finding A) |
| residents | `is_active=false` | 🔴 `is_active=true` |
| vehicles | blanket `is_active=false` | 🔴 `admin_reactivate_property_vehicles` RPC — restores only `status='active' AND is_active=false`, reports what it skipped, alerts if it fails |
| property | `is_active=false` | `is_active=true` |
| audit | one `DEACTIVATE_PROPERTY_CASCADE` row | one `ACTIVATE_PROPERTY_CASCADE` row |
| billing | — | 🔴 permit sync (`/api/billing/sync-on-add`, `kind:'permit'`) — "without this call the meter stays stale until renewal-reconcile" |

The vehicle RPC exists *because* a blanket restore was wrong: it would
bring back vehicles declined or removed **before** the property went
down, as enforceable. My route restoring nothing is a different wrong,
not a safer one.

## What the CA toggle actually does

| | deactivate | reactivate |
|---|---|---|
| everything | `properties.is_active=false` + audit. Nothing else. | 🔴 property-limit cap check first, then `is_active=true` + audit + B147 `callSyncOnAdd(company,'property')` |

The cap check matters: its own comment says a client that guarded only
the add path "would let someone reactivate into a raw cap error" from
the `enforce_property_limit` trigger.

## So wiring as-is would regress five things

1. `/admin` reactivate stops restoring **residents**
2. `/admin` reactivate stops restoring **vehicles**
3. `/admin` reactivate stops firing the **permit sync** → stale meter
4. CA reactivate loses the **property-limit cap check** → raw trigger error
5. CA reactivate loses the **B147 property sync**

(6 is intended: CA deactivate *gains* the cascade, per class 16.)

## 🔴 And a blocker I cannot route around

`admin_reactivate_property_vehicles` is **super-admin only**:

```sql
IF public.get_my_role() <> 'admin' THEN
  RETURN jsonb_build_object('ok', FALSE, 'error', 'not_super_admin');
```

The cascade route runs as **service_role**, which carries no `email`
claim, so `get_my_role()` returns NULL inside the RPC, `NULL <> 'admin'`
is true, and the call is refused. **The route cannot call it.**

And the usual escape — adding `current_user = 'service_role'` as a
permitted condition — **does not work here**, because that RPC is
`SECURITY DEFINER`: inside it, `current_user` is the owner, not
service_role. That is the same trap documented in the companies guard.

## Options, for your ruling

**(a) Generalize the RPC's authority** to "admin, **or** company_admin
of that property's company". Then both portals restore vehicles the
same careful way, which is what class 16 asks for — same operation from
two portals, same end state. The route would call it with the
**caller's JWT**, not service_role, so the authority check stays real
and nothing is re-implemented.
*Cost:* it is an authority change to a live RPC, so it needs its own
writer sweep and positive controls (a CA restores their own property's
vehicles; a CA is refused on another company's; an admin still works).

**(b) Interim: wire `/admin` only**, with the route calling that RPC
using the caller's JWT. `/admin` keeps its exact behaviour, the CA
toggle is left alone, and class 16 stays open.
*Cost:* the two portals still differ, which is the defect we are
closing.

**(c) The route re-implements the vehicle logic** as service_role.
*Cost:* two implementations of "restore only `status='active' AND
is_active=false`" — the duplication class, on the rule that exists
specifically to avoid restoring declined vehicles as enforceable. I do
not recommend it.

**Either way**, the cap check and both syncs belong at the edges, not
in the route: the cap check is a **pre-condition** the client tests
before opening the dialog, and the syncs are **post-conditions** after
the dialog reports success. The route handles the cascade; it should not
learn about Stripe.

## What I will fix regardless, once you rule

- the route's reactivate branch: restore residents, restore vehicles
  via the RPC, surface its `restored_count` / `skipped` in the stream
- the route's plan `note`, which currently tells the operator the
  opposite of the truth
- 🔴 `verify:cascade` control 9, inverted: reactivation **does** restore
  residents and vehicles, while space assignments and pending requests
  do not — with the skip list asserted, so a future blanket restore
  fails there

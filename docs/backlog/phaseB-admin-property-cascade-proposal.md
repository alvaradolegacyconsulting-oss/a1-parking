# /admin property cascade — proposal. Report only, nothing built.

Proposed against the ruling: pre-flight all targets, process each user
independently, per-user result list, audit each, never "done" unless
every user succeeded, offer retry-failed, no all-or-nothing rollback
across auth.

---

## 1. What it does today

`app/admin/page.tsx:452-535`. Not a per-user toggle — a property
operation that happens to include user access.

```
propertyUsers = user_roles
   .contains('property', [propertyName])
   .in('role', ['manager','leasing_agent'])

DEACTIVATE                           REACTIVATE
  confirm dialog                       (no dialog)
  toDeactivate = those with no         swift-handler activate_user
    OTHER property                       for ALL propertyUsers
  swift-handler deactivate_user        user_roles.is_active = true
    for each (Promise.all)               for ALL propertyUsers
  user_roles.is_active = false
    for toDeactivate
  residents.is_active = false          (residents NOT restored)
  vehicles.is_active = false           (vehicles NOT restored)
  properties.is_active = false         properties.is_active = true
  audit: ONE row for the cascade
```

The resident/vehicle asymmetry is already known and disclosed in the
confirm dialog. Two things are not.

## 2. 🔴 Finding A — reactivation restores more than deactivation took

Deactivation bans **only** users with no other property. Reactivation
unbans and reactivates **every** user assigned to the property.

So reactivating property X restores a manager who was deactivated for
an unrelated reason — individually by a CA, or by property Y's
cascade — provided they happen to be assigned to X. The code frames
this as idempotence ("PMs whose flag was never flipped stay at true"),
which is true only if the flag was flipped by *this* cascade.

**Proposal:** reactivation restores a user only if this property is the
reason they are deactivated — i.e. they have no other deactivated
property and no individual deactivation on record. Anything else needs
a person to decide, so it belongs in the result list as
`skipped — deactivated for another reason`, not restored silently.

## 3. 🔴 Finding B — the deactivate filter never checks `is_active`

```js
const toDeactivate = propertyUsers.filter(u =>
  (u.property || []).filter(p => p.toLowerCase() !== propertyName.toLowerCase()).length === 0
)
```

The comment above it says *"only ban users with no other **active**
properties."* The code checks only that the array has no other
entries. A manager assigned to `[X, Y]` where Y is already deactivated
keeps their login when X is deactivated, despite having zero active
properties left.

**Measured: 0 rows are in that state today** (21 manager/leasing_agent
rows, none with every assigned property deactivated, none with an empty
property array). So this is latent, not live — it bites the first time
a multi-property manager's properties are deactivated one at a time.

**Proposal:** resolve the remaining properties against
`properties.is_active` and ban when none remain active. Then the
comment and the code agree.

## 4. The proposed shape

`POST /api/admin/property-active` → `{ property_id, active }`, admin
only, service_role, with the per-user work **calling the same function
`/api/admin/user-active` already uses** rather than a second copy of
it. Two implementations of "revoke a user" is how the two drift, and
the ban-read-back discipline only exists in one place today.

### Phase 1 — pre-flight, no writes

Resolve every target and return the plan before touching anything:

| per user | |
|---|---|
| `email`, `role` | |
| `other_active_properties` | resolved against `properties.is_active` (Finding B) |
| `action` | `revoke` · `keep (still has active properties)` · `skip (deactivated for another reason)` (Finding A) |
| `has_login` | from `get_auth_user_id_by_email`, never `listUsers` |

Plus the resident/vehicle counts the confirm dialog already shows. The
operator confirms **this list**, not a count — the current dialog says
"N accounts affected" and N is computed by the same filter that has
Finding B in it.

### Phase 2 — per user, independently

For each `revoke`/`restore` target, in sequence, not `Promise.all`:
ban-then-read-back, flip `is_active`, revert the login if the flip
fails, audit **that user**. Exactly the step-2 route's discipline.

🔴 **No rollback across users.** Auth is not transactional and pretending
otherwise would mean un-banning users who were correctly banned because
a later one failed. A partial outcome is a real outcome; the job is to
report it precisely, not to hide it.

### Phase 3 — the property and its data

`residents`, `vehicles`, `properties` after the user loop, each
reported separately. If the property flip fails, users are already
revoked — report that plainly rather than reverting access.

### The response

```json
{ "ok": false,
  "property": "Green Acres",
  "users": [
    {"email":"…","action":"revoke","result":"revoked_and_banned"},
    {"email":"…","action":"keep","result":"kept — 2 other active properties"},
    {"email":"…","action":"revoke","result":"failed","reason":"ban read-back disagreed"}
  ],
  "residents": "41 deactivated", "vehicles": "58 deactivated",
  "property_flipped": true,
  "retry": ["…"] }
```

🔴 `ok` is true **only** when every user succeeded. The banner says
"Deactivated. 1 of 7 accounts did not complete" and offers **Retry
failed**, which re-runs phase 2 for the `retry` list alone — idempotent,
because the route already treats "already in that state" as
`changed:false` rather than an error.

### Audit

One row per user, from the step-2 route, plus one cascade row naming
the property, the counts and the failed list. The per-user rows are
what a remediation query needs; the cascade row is what a human reads.

## 5. Positive controls the gate must have

Negative-only would pass a cascade that revokes nobody.

1. a single-property manager → revoked, banned, refresh refused
2. 🔴 a multi-property manager → **kept**, still signs in
3. 🔴 Finding B: a manager whose other property is already deactivated → revoked
4. 🔴 Finding A: a manager deactivated individually, assigned to this property → **skipped** on reactivate, stays deactivated
5. residents and vehicles at the property deactivated; **not** at another property
6. an induced ban failure on user 3 of 5 → users 1-2 revoked, 4-5 still processed, `ok:false`, user 3 in `retry`
7. Retry failed → user 3 revoked, now `ok:true`
8. a CA caller refused; anon refused
9. reactivate restores residents? **No** — asserted as unchanged, because that asymmetry is deliberate and disclosed

## 6. What I need ruled

1. **Finding A's skip rule** — is "no other deactivated property and no
   individual deactivation on record" the right test? It needs the
   audit log to distinguish an individual deactivation from a cascade
   one, which the step-2 route now writes (`USER_DEACTIVATED`) but the
   old cascade did not (`DEACTIVATE_PROPERTY_CASCADE`). Pre-step-2
   history is therefore ambiguous: for those, I would default to
   **skip and report** rather than restore.
2. **Sequential or bounded-parallel.** Sequential is simpler to reason
   about and audits cleanly; a 40-user property means 40 ban calls. Is
   a slower, legible cascade acceptable?
3. **Does the CA path need the same treatment?**
   `togglePropertyActive` in the CA portal shares the confirm helper —
   I have not swept it yet and will not until this is ruled.

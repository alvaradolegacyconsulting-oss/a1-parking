# 🔴 /admin reactivation over-restores residents — 46 rows, 33 of them A1's

Report only, 2026-10-15, as ruled. **Behaviour unchanged in this
wiring.** Changing it is a new decision.

## The question

`/admin`'s reactivate does

```ts
await supabase.from('residents').update({ is_active: true })
  .ilike('property', escapeIlikeValue(propertyName))
```

Blanket, no status filter, no provenance filter. So: does it resurrect
residents deactivated **individually**, before the cascade?

**Yes. And more than that.**

## Measured

Residents currently `is_active = false` at a property that is **active**
— every one of which a blanket restore would bring back if that
property were cascaded down and up:

| rows | status | `deactivation_reason` | what they are |
|---|---|---|---|
| **27** | `declined` | NULL | refused registrations. Should never be restored |
| **11** | `active` | set | 🔴 individually deactivated — `moved_out`, `duplicate_record`, `other` |
| 4 | `active` | NULL | the shape a cascade actually leaves |
| 4 | `pending` | NULL | never approved |
| **46** | | | **all restored today** |

🔴 **33 of the 46 belong to A1** — 31 at **Green Acres**, 2 at
**Esperanza @ Queenston**.

So this is not hypothetical and not test data. If Green Acres is ever
deactivated and reactivated, 31 residents come back active, including
ones a manager removed deliberately:

```
Green Acres  coqueto201612@gmail.com    reason=duplicate_record  by=isabellagongora14@icloud.com
Green Acres  jaimegarcia.7@icluod.com   reason=other             by=isabellagongora14@icloud.com
```

A `duplicate_record` resident returning is a data-integrity problem, not
just an access one.

## It is the class-15 shape, for residents

Exactly the asymmetry ruled on for staff: the reverse restores more than
the forward took. The difference is that for staff we now have a stamp,
and for residents there is already a **discriminator sitting unused** —
the same one the vehicles RPC uses.

`admin_reactivate_property_vehicles` restores only
`status='active' AND is_active=false`, and its migration says why: the
blanket version "restored EVERY vehicle at the property — including ones
declined or removed BEFORE it went down, brought back as enforceable."

Residents have both `status` and `deactivation_reason`. Mirroring the
vehicle rule would give:

> **4 restored, 42 skipped** — of 46.

That is the size of the over-restore: the blanket write restores 42
residents it should not, including all 27 declined.

## Why it has not bitten yet

Nobody has reactivated a property that had individually-deactivated
residents. The 4 `status='active'` / no-reason rows are the only ones a
cascade legitimately owns, and they are the only ones a filtered restore
would touch.

## The shape of a fix, when it is decided

Not built, and deliberately not proposed in detail, because the resident
case has a question the vehicle case did not:

- **vehicles**: `status='active' AND is_active=false` is sufficient,
  because a declined vehicle has `status='declined'`.
- **residents**: `status='active'` alone is NOT sufficient — the 11
  individually-deactivated rows are `status='active'` with a reason. So
  the filter needs `deactivation_reason IS NULL` as well, which means
  it is inferring provenance from the *absence* of a reason rather than
  from a positive stamp.

🔴 That is the absence-as-answer shape again. A resident stamp —
mirroring `cascade_deactivated_by_property` on `user_roles` — would be
the honest version, and the deactivate cascade would have to write it.
That is a schema change and its own arc.

Interim option worth considering when ruled: restore only
`status='active' AND deactivation_reason IS NULL`, and **report the
skipped list** the way the vehicles RPC does, so the operator sees
"31 residents were left deactivated, with reasons" rather than silence.

## Not in scope

Backfilling a stamp onto the 46. Their provenance is partly recoverable
(`deactivation_reason`, `deactivated_by`, `deactivated_at` are
populated for 11 of them) and partly not. That is a decision, not a
cleanup.

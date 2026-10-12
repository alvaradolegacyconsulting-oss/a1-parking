# Whitespace normalization on stored text — backlog

Filed 2026-10-12 (Jose: "File, don't fix now"). Nothing in here is built.

## Why this is a class, not a typo

The property-name whitespace work established the pattern: **trim on write
with a DB trigger, escape wildcards on read**. A trailing space is invisible
in every UI, so it is found only when an equality comparison fails — and the
failure surfaces somewhere unrelated to the field that holds the space.

Two consumers make it bite:
- RLS policies and app queries that compare a stored value by **equality**
  (`properties.name = ANY(ur.property)`), where `"tx "` ≠ `"tx"`.
- Client `.ilike` against a policy that uses equality — the predicate-drift
  class already recorded, where whitespace is the only trigger.

## Found

| table.column | value | found how | notes |
|---|---|---|---|
| `properties.state` | `"tx "` on id 138 "Test Legacy Property" | incidental, while auditing property columns 2026-10-12 | also lowercase; every other property should be checked, not just this row |

## Not yet surveyed

No sweep has been run. Before any fix, query the live catalog for every
`text`/`varchar` column on the tenant tables and count rows where
`value <> trim(value)` — the answer decides whether this is one row or a
systemic backfill. Candidates worth checking first, because each feeds an
equality comparison or a user-facing match:

- `properties` — `state`, `city`, `zip`, `address`, `company`, `name`
- `companies` — `name` (joined to `properties.company` by name, and the
  orphan-company check in the protected-columns verification already
  `lower(trim(...))`s both sides, which is a hint this has been papered over)
- `user_roles` — `company`, `property[]` elements
- `vehicles` — `plate` is already normalized; `state` is not
- `visitor_passes` — `plate`, `state`

## Shape of the fix, when ruled

1. **Survey first.** Report counts per column before proposing anything.
2. **Backfill** with an explicit `WHERE value <> trim(value)` so the write
   set is countable and the verification can assert it reached zero.
3. **BEFORE INSERT OR UPDATE trigger** to trim on write, per the property-name
   precedent — not application-layer trimming, which every new call path has
   to remember.
4. `state` specifically: decide whether it is also upper-cased. `"tx "` → `"TX"`
   is two changes, and only the trim is a whitespace question.

🔴 **Note the ordering constraint:** `properties.company` and
`properties.state` are now covered by
`properties_protected_columns_guard_trigger` (company is protected; state is
not). A backfill runs as a SQL session with no user JWT, so it passes the
guard's passthrough — but that passthrough is the thing the guard's G7
execution gate exists to protect, so re-run `verify:propcolumns` after any
backfill that touches a protected column.

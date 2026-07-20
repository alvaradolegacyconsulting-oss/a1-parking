# Backlog — `drivers` RLS policy-role convention is mixed

**Filed:** 2026-07-20 during subscriber-footprint drawer work.
**Priority:** LOW. House-style normalization, not a vulnerability.

## Observation

Per Jose's `pg_policies` query on `public.drivers` (2026-07-20):

| policyname | cmd | roles |
|---|---|---|
| admin_all_drivers | ALL | `{public}` |
| company_admin_insert_drivers | INSERT | `{public}` |
| company_admin_select_drivers | SELECT | `{public}` |
| company_admin_update_drivers | UPDATE | `{public}` |
| driver_read_own | SELECT | `{public}` |
| **manager_read_drivers** | **SELECT** | **`{authenticated}`** |

Five policies `TO public`, one `TO authenticated`. Inconsistent within
the same table.

## Not a vulnerability

`TO public` in Postgres RLS applies to **all** roles including
`anon` and `authenticated`. The `qual` on each policy still gates on
`get_my_role() = 'admin'` / `= 'company_admin'` / email match / etc.,
so unauthenticated requests fail closed at the qual (`get_my_role()`
returns NULL for anon → no match).

Table-level GRANTs are the layer that actually decides whether anon
can even attempt the query — covered by the already-shipped b182/b183
anon-grants hardening. Anon can't `SELECT FROM drivers` regardless of
policy `TO clause`.

Both layers say "no" to anon. The `TO public` vs `TO authenticated`
inconsistency is cosmetic.

## What house-style would be

Modern convention in this codebase (per migrations from 2026-06-11
onward) is `TO authenticated` on any policy whose qual references
`get_my_role()` or `auth.jwt()`. Signals intent: "this policy is for
signed-in users; anon never reaches it." Reduces cognitive load when
reading `pg_policies` output.

The 5 `TO public` policies on `drivers` predate that convention (2026-05
era). `manager_read_drivers` was added later and correctly uses
`{authenticated}`. Normalizing the older 5 to `{authenticated}` would
be house-style tidy but functionally identical.

## Fix (when opened)

Single migration: DROP + CREATE each of the 5 legacy policies with
`TO authenticated` instead of `TO public`. Body/qual unchanged.
Verification: `pg_policies` shows all 6 policies now `{authenticated}`.

Estimated effort: ~30 min. No behavior change; no data migration; no
smoke needed beyond `pg_policies` visual.

## Priority

**LOW.** Not blocking anything, not a security issue, not misleading
in operation. File-and-forget until either:
- (a) A broader RLS audit pass sweeps it up as part of house-style
  normalization across all tables.
- (b) The FK `property_id` migration touches driver policies for
  other reasons and this is a cheap addend.

## Cross-references

- Jose's 2026-07-20 pg_policies verification (Amendment 1 answer to
  subscriber-footprint drawer report).
- [b182/b183 anon-grants hardening] — the layer that actually keeps
  anon off `drivers` regardless of policy `TO clause`.

# `user_roles.company` is free TEXT with no foreign key

**Filed:** 2026-09-18 (out of C3 — stabilization cluster)
**Status:** FILED, NOT BUILT. C3 shipped a client-side gate at two call
sites. That gate is not this. Do not close this item because C3 shipped.

## The shape

`user_roles.company` and `drivers.company` are `TEXT`. There is no
foreign key to `companies`, and no trigger validating the value. The
only database-level write guard is the metachar CHECK from
`20260911_user_roles_metachar_check.sql`, which rejects `%`, `_` and `\`
and nothing else. Any other string — a typo, a stale name, a renamed
company, an empty-ish value — inserts silently.

## Why it is not cosmetic

`user_roles.company` is what `get_my_company()` returns, and
`get_my_company()` is what the company-scoped RLS policies compare
against. A row whose company matches no company is scoped to nothing:
every company-scoped read returns zero rows. Per the standing note, an
RLS denial comes back as `{data: [], error: null}` — so the surface
shows "empty", not "wrong", and nobody gets an error to chase.

Downstream of that, `app/driver/page.tsx:462` converts a `drivers` read
that returns no row into `assigned_properties: ['All']`, and
`fetchViolations` skips its property filter whenever the array contains
`'All'`. The chain from "company string nobody owns" to "portal shows
every property" is short and has no error anywhere along it.

## Why a rename is the sharper version

`companies.name` is the join key by value. Renaming a company does not
cascade to `user_roles.company`, `drivers.company`, or the property-name
arrays — the same class the Green Acers→Green Acres rename script
(`scripts/property_rename_greenacers_to_greenacres_DRAFT.sql`) exists to
hand-walk. Every rename is a manual multi-table sweep, and a missed
table is a silently descoped user.

## What C3 did and did not do

Did: `app/lib/company-validate.ts`, called from `addUser` and `addDriver`
in `app/admin/page.tsx`. Rejects a non-existent company before the auth
user is minted, names the supplied value in the message, and writes the
canonical stored spelling so two spellings cannot become two scopes.

Did not: constrain the column. Service-role scripts, SQL, the bulk-upload
path, the CA surface, and any future call site are all unaffected. The
gate is a client-side courtesy at two doors in a building with more doors.

## Options when picked up

1. `company_id` FK to `companies(id)`, with `company` kept as a
   denormalised display column during the transition. Cleanest, largest.
2. FK on `companies.name` via a UNIQUE constraint there, plus
   `ON UPDATE CASCADE`. Smaller, fixes renames, keeps the value join.
3. A validating trigger only. Cheapest; does not fix renames.

Pre-work either way: enumerate existing `user_roles.company` /
`drivers.company` values that match no `companies.name`, since a FK
cannot be added while violations exist. That enumeration has NOT been
run — assume it is non-empty until it has.

## Related

- `feedback_rls_denials_return_empty_not_error.md`
- `project_fk_property_id_migration.md` — the same structural close, done
  for `property_id`. That migration is the template.
- C1 / C1′ — the driver-portal fail-open this feeds.

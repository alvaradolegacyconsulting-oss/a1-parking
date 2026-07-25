# Attach endpoint listUsers timing enumeration — REVISIT before public_signup_open

**Filed:** 2026-07-25 (re-registration attach arc, commit 2)
**Trigger:** MANDATORY before `public_signup_open` flip (~4–6 weeks)
**Class:** enumeration side-channel · same structural class as property_id FK epic

## What

`/api/register/create-user` attach path calls `admin.auth.admin.listUsers()` — `O(users)`,
paginated in batches of 1000 — only when the caller's email already exists (the silent-attach
branch). The create path (new email) does NOT call `listUsers`.

Existing emails therefore respond **measurably slower** than new emails, and the gap
**grows as the user table grows.**

## Why it matters

Classic timing-enumeration side-channel:
- Success responses are byte-identical (design gate held — see [app/api/register/create-user/route.ts](../../app/api/register/create-user/route.ts) header)
- But timing distinguishes existing-vs-new
- An attacker probing the endpoint with candidate emails can enumerate which are already registered

The server-side design exists precisely to prevent enumeration (why `supabase.auth.signUp()`
obfuscates and we route through the admin API). Timing is a residual leak that inherits from
the paginated-lookup implementation, not from the API contract.

## Why not closeable cheaply today

`admin.auth.admin.listUsers()` in the SDK version in use does **not** support server-side
email filtering — probe-verified 2026-07-25, matches codebase pattern
([scripts/prelaunch-pm-driver-orphan-cleanup-ONE-TIME.ts:55](../../scripts/prelaunch-pm-driver-orphan-cleanup-ONE-TIME.ts#L55)).
Page-scan is the only mechanism.

The real fix is a non-scanning email→id lookup:
- Direct query against `auth.users` via `admin.schema('auth').from('users').select('id').eq('email', email).maybeSingle()` — requires confirming service_role has that access + establishing it as a codebase pattern (not currently used anywhere)
- OR resolve via `residents`/`user_roles` which already carry the email in indexed shape — coupling concern, but constant-time
- OR a DEFINER RPC `get_auth_user_id_by_email(email)` — controlled surface, indexed lookup

All three are structural changes rather than a targeted patch. Same class as the property_id FK
epic + the six-site name-keyed scoping group + `vehicles_authorized_plate_uidx` cross-tenant fix
— **name-keyed-tenancy / structural-lookup work that groups naturally under the pre-signup epic.**

## Latency today, latency at scale

- **A1-era** (< 100 users, single `listUsers` page): negligible — page fetch is ~50-200ms regardless
- **Signup-open** (10,000+ users, up to 10 pages): 500ms-2s difference between existing and new
- At that point the timing tell is trivially observable from any network position

## Fix trigger

**Before `public_signup_open` flips.** Not before that — A1 volume doesn't produce a
distinguishable gap. But mandatory before opening to the internet.

## Related

- [`docs/backlog/six-site-name-keyed-scoping.md`](six-site-name-keyed-scoping.md) *(filed separately)* — same structural-lookup class
- `vehicles_authorized_plate_uidx` cross-tenant finding — same class, different shape
- [`migrations/20260713_companies_name_lower_unique.sql`](../../migrations/20260713_companies_name_lower_unique.sql) — prior Bar-2 tenancy-hardening piece

## What's in the code today

- Documented in the route header ([app/api/register/create-user/route.ts](../../app/api/register/create-user/route.ts))
  "ENUMERATION BAR" block, RESIDUAL bullet, points at this file
- `resolveExistingAuthUserId` helper has a comment noting the scaling ceiling
- Ships as-is because tonight's UAT case (deactivated resident re-registers) can't produce
  the enumeration attack — A1 has no anonymous attacker, and the resident using the flow
  KNOWS their email already exists

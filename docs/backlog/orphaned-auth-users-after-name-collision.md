# Backlog — Orphaned `auth.users` after `name_taken` collision

**Filed:** 2026-07-21 during B2-1 C1 build.
**Priority:** LOW.
**Status: PROVISIONAL** — may be obsoleted by B2-5 C4 (self-serve rewrite)
if that rewrite introduces a stricter pre-flight with abandoned-session
cleanup. File it now anyway so the class of bug is recorded — the July 13
backlog omissions taught us that "conditionally filing later" turns into
"forgotten."

## Mechanism (three-step trap)

1. Prospect completes `/signup` form, verifies email, clicks Continue.
2. `/api/signup/create-checkout-session` fires the B2-1 C1 pre-flight
   RPC (`company_name_available`), detects a duplicate, 303-redirects to
   `/signup/verify?error=name_taken`.
3. Prospect sees the C1 card. If they close the tab and re-visit
   `/signup` with the same email — they hit Supabase's
   `auth.signUp` anti-enumeration branch. `signUp` returns success with
   `data.user.identities.length === 0`. `/signup` interprets this as
   `already_registered` and renders **"That email is already registered —
   reset password or sign in"** — advice that is *actively wrong* for
   this user (they have no `user_roles` row to sign into, and password
   reset just lets them into the same broken state).

The name_taken card at `/signup/verify` guides them to `support@` (the
correct path). The trap is only for a user who ignores that guidance and
retries self-serve.

## Cheap mitigation shipped

**Copy fix on the C1 name_taken card:**

> ⓘ Please don't try signing up again with this email — we'll get you set
> up. Your signup information is safely on file.

Ships in the same follow-on commit as this filing. Doesn't close the
trap mechanically; closes it socially. Enough for zero exposure today
(`public_signup_open = false`) and rare exposure post-flip.

## Why they're invisible today

Nothing in `admin_console`, `/admin`, or any API route enumerates
`auth.users` \ `user_roles`. The only visibility is a manual join:

```sql
SELECT u.id, u.email, u.email_confirmed_at, u.created_at,
       u.raw_user_meta_data
FROM auth.users u
LEFT JOIN public.user_roles ur ON lower(ur.email) = lower(u.email)
WHERE ur.id IS NULL
  AND u.email_confirmed_at IS NOT NULL;
```

Post-flip, rate of accumulation is one row per genuine name collision —
rare in B2B but each one is unrecoverable-without-support.

## Two proposed fixes (when picked up)

### Fix A — `scripts/adopt-orphan-auth-user.ts` (~1 hour)

Support runbook script. Params: `--email`, `--company-name`, `--tier`.
Resolves the existing `auth.users` row by email; atomically creates
`companies` + `user_roles` under a new name; issues a proposal-code
Stripe path so the customer can complete payment against their existing
account. Replaces hand-crafted INSERTs. Discipline: dry-run first;
`SCHEMA_ADOPT_ORPHAN` audit row; refuse if `user_roles` already exists
(idempotency guard).

### Fix B — `admin_console` "Orphaned auth users" panel (~2 hours)

Renders the JOIN above as a table. Columns: email, verified_at,
requested_company_name (from `raw_user_meta_data.intended_tier.company_name`),
"Adopt & provision" button (calls Fix A's underlying flow). Makes
accumulation visible in one glance. Requires a service-role RPC or API
endpoint since `auth.users` isn't PostgREST-exposed.

## PROVISIONAL condition

**May be obsoleted by B2-5 C4** (self-serve picker rewrite). If C4 adds
a stricter pre-flight that also handles abandoned-session cleanup
(e.g. sweep orphaned `auth.users` older than N days with a nightly
cron) OR makes the name_taken card a client-side check that runs
BEFORE `auth.signUp` is called (avoiding orphan creation entirely),
this backlog closes with no code needed here.

**Signal that it's still relevant:** post-B2-5 C4, if `auth.users` \
`user_roles` for `email_confirmed_at IS NOT NULL` accumulates any row
per week on the live prod instance, both fixes should ship.

## Related orphan class

**B2-1 C2 (2026-07-21) introduced a second orphan class**: post-payment
webhook failures leave one of two states behind — either NO company row
(companies INSERT failed) OR a companies row with no CA attached
(user_roles INSERT failed). Both are tracked in
[`provisioning_failures`](../../migrations/20260721_provisioning_failures.sql)
with email alerts to ops. Different mechanism from this auth.users
orphan class, but the same operational shape: an entity stranded
mid-provisioning, invisible until someone goes looking.

**The deferred B2-1 Commit 3 admin_console reconciliation panel should
address BOTH orphan classes in one surface** — a single "provisioning
attention needed" section covering:
- Orphaned `auth.users` (this doc's class — name collision that
  prevented a companies row from ever being created)
- `provisioning_failures` rows where `resolved = FALSE` (both
  companies_insert and user_roles_insert sub-cases)

If the two classes get addressed in separate commits/UIs, we duplicate
detection/resolution logic. Bundle them.

## Cross-references

- B2-1 C1 [eea9f61](https://github.com/alvaradolegacyconsulting-oss/a1-parking/commit/eea9f61)
  — the name_taken redirect that creates the auth.users-orphan condition.
- B2-1 C2 schema [adfc6e1](https://github.com/alvaradolegacyconsulting-oss/a1-parking/commit/adfc6e1)
  + code (this commit) — introduces the second orphan class + emails ops.
- B2-5 C4 (pending) — the /signup rewrite that could obsolete THIS
  backlog (stricter pre-flight + abandoned-session cleanup would prevent
  auth.users orphans in the first place).
- `docs/backlog/B2-8-signup-path-consent.md` — related signup-path bug
  class (no-role-row forward-path dead-end).

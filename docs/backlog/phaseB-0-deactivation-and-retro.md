# Phase B pre-items 1 and 2 — report only, nothing changed

Both executed on canaries on Test-LEGACY. A1 was never touched.

---

# Item 1 — 🔴 deactivation does not revoke access

## What deactivation does today

| path | `user_roles.is_active` | `auth.users` |
|---|---|---|
| **per-user**, from `/admin` and `/company_admin` — 4 call sites: `admin/page.tsx:500`, `:531`, `company_admin/page.tsx:3022`, `:3403` | set false | 🔴 **untouched** |
| **company-wide**, `super_admin_deactivate_company` | cascade to false | `banned_until = 2099-12-31`, best-effort inside `EXCEPTION WHEN insufficient_privilege` |
| anything | — | **nothing ever deletes the auth user.** The only `deleteUser` calls in the codebase are demo cleanup in `prospect-demo.ts` |

The per-user path is the common one, and it is pure data: four direct
PostgREST `UPDATE`s. The login keeps working.

## Measured

Canary manager on Test-LEGACY, own auth user, assigned to a property
holding 31 residents and 22 active vehicles.

```
1. ACTIVE (baseline)
   get_my_role() → "manager"   get_my_company() → "Test-LEGACY"
   get_my_properties() → ["Test Legacy Property"]
   residents readable → 5 rows      vehicles readable → 5 rows

2. DEACTIVATED exactly as the portals do it
   auth.users.banned_until → null
   session acquired → YES
   get_my_role() → "manager"   get_my_company() → "Test-LEGACY"
   get_my_properties() → ["Test Legacy Property"]
   🔴 residents readable → 5 rows   🔴 vehicles readable → 5 rows
      e.g. {"id":599,"name":"test","unit":"202","email":"test@abc.com"}

3. BANNED (what COMPANY deactivation does)
   new session → refused, "User is banned"
   🔴 a session issued BEFORE the ban, used after it → still reads rows
```

So: **per-user deactivation revokes nothing at the data layer.** The
portal gate is client-side; direct PostgREST does not pass through it.
`get_my_role()` has no `is_active` term, so every policy written as
`get_my_role() = 'manager'` still evaluates in the deactivated user's
favour.

The ban **does** stop a *new* session, so the company-wide path is
sound for new logins — but it does not revoke a session already issued.

## 🔴 A correction to my own first run

The first version of this probe used `signInWithPassword` and every
attempt was refused with `captcha protection: request disallowed` —
**including the ACTIVE baseline.** `signInWithPassword` is
captcha-gated project-wide. Reporting those refusals as "deactivation
blocks sign-in" would have been the storage-MIME mistake again: a bot
gate read as an access control. The baseline control is what caught it,
which is the reason to always have one.

The re-run uses `generateLink` + `verifyOtp`, which is ungated and is
what `/register` uses. That is also the honest test: a session is a
session however it was obtained.

Mitigating, and worth stating precisely: a deactivated user who wants a
*fresh* password login must solve a captcha. That raises the cost for a
bot and not at all for the person who was just deactivated, who may
also still hold a valid refresh token.

## Severity

This is **access revocation failing for a deactivated insider**, not an
anonymous hole. The person was legitimately a manager. But "we removed
their access" is a promise the product makes to the customer, and today
it is not kept for the per-user path.

## Why I have not touched it

`get_my_role` / `get_my_company` / `get_my_properties` sit under most
of the RLS in this system:

- **~1,199 textual occurrences across 151 migration files** (a lower
  bound — the catalog is the audit surface, not `migrations/`)
- **33 call sites in application code**, across driver, manager, QR,
  CA, admin, Stripe handlers and library code

An `is_active` term in the helper is one line that changes behaviour
everywhere at once. Per the binding lesson, the positive controls come
from a full sweep done **before** the change, not from a list in a
ruling.

**Run `docs/backlog/capture-20261015_get_my_role_surface.sql`** — it
returns, in one result set: the three helper bodies as they actually
are; the policy count per table; totals per helper; every other
function that calls them (each inherits the change); the live role
population that forms the positive-control list; exactly who an
`is_active` term would cut off today; and 🔴 a join of
`user_roles.is_active` against `auth.users.banned_until`, which lists
every deactivated row whose login is still live.

That last section is the one to read first. It is the current exposure,
by name.

## The shape I would propose after the capture

Not a recommendation yet — the capture decides it.

1. **Deactivation bans the auth user**, on the per-user path too. This
   is the smaller change and it is where the fix belongs: deactivation
   should revoke, and today it only labels. It does not touch anything
   under RLS.
2. **Then** an `is_active` term in the helpers, as defence in depth,
   sequenced behind the sweep and with the positive controls the
   capture names.
3. Session revocation for an already-issued token is a third, separate
   question (`auth.admin.signOut` / refresh-token revocation). Banning
   does not cover it, as measured.

Doing (1) first means the exposure closes without touching 151 files'
worth of policy surface.

---

# Item 2 — retro check: was the create-user hole ever used?

## The signature

Legitimate registration creates the auth user and the record in one
flow, seconds apart. Exploitation of the hole inverts nothing but the
*order of existence*: the record already exists, and an auth user
appears later. So: **auth users whose `created_at` is later than the
earliest `residents` or `user_roles` row for the same email.**

## Result

```
auth users                                        393
auth users matchable to a record                  386
auth users created AFTER their record, at all       0
largest positive gap anywhere                       0 s
```

**Zero**, and not "zero above a threshold" — not a single auth user in
the system was created after its own record by any margin. The
5-minute threshold the ruling suggested has the full 300 s of headroom
because the worst legitimate case is 0 s.

42 resident emails have no auth user at all: records nobody has
claimed, exploited or otherwise.

## What this check cannot see

Stated so the "zero" is not read as more than it is:

1. **A cleaned-up attacker.** `listUsers` shows current users; an auth
   user created and then deleted leaves no trace here.
   `auth.audit_log_entries` is the authoritative history and is not
   reachable over PostgREST — that one needs a SQL query, and I can
   write it if you want the stronger answer.
2. **An attacker who was also the resident.** Nothing distinguishes a
   resident legitimately claiming their own imported record from the
   same action by someone else; the signature is identical because the
   mechanism was.
3. It covers `residents` and `user_roles`. `drivers` has 7 rows and 0
   without an auth user, so there was nothing there to take.

## Conclusion

No evidence of use, with the caveats above. Nothing changed.

---

# Item 3 — acknowledged, folded into the claim step

Server-side record detection, returning the same byte-identical shapes,
with the 2026-07-25 per-property attach-hardening running there instead
of in a client guard that cannot fire. That is the next build, after
you have read item 1's capture.

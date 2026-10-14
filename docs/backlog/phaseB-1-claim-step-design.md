# Phase B.1 — claim step: design report, nothing built

Written for Jose and the architect. Report-first, as ruled, because it
touches `/register` and auth.

---

## 1. The finding that decides the design

The bulk import creates a category the codebase has never had:

> **a records-bearing identity with no auth account.**

Every safety property around `/register` assumes those two travel
together. Two of them are false the moment a batch loads.

### 1a. `/register`'s refusal assumes a login exists

`app/register/page.tsx:188` → *"You are already registered at this
property. Please log in instead."* It fires on a live `residents` row.
For an imported resident there is nothing to log in with. This is the
dead end already filed.

### 1b. 🔴 `create-user` is safe today only because a no-auth email owns nothing

`/api/register/create-user` hands a `token_hash` to the browser, which
`verifyOtp`s it into a session. **The email is never verified** — the
token goes straight to whoever asked.

That was deliberately made safe on 2026-09-11. The route's own comment:

> `resolveExistingAuthUserId` REMOVED. It resolved an existing
> `auth.users` id so the attach branch could mint a magic link for an
> account the caller did not own. **That was the takeover.**

So a token is minted **only when this request created the account**.
The reasoning holds because a brand-new email has no records behind it:
worst case someone creates a junk resident.

An imported resident has **no auth account and 1.6 vehicles on
average**. So `createUser` succeeds — new email — the route returns a
token, and the claimant lands in a session owning that resident's unit
and cars. The 2026-09-11 fix closed takeover of an existing *auth
account*; it does not cover an existing *record*, because until now
there was no such thing.

**Therefore: the claim step must not reuse `create-user`'s
token-to-browser path.** The only identity the import gives us is the
email address, so the claimant has to prove they control that mailbox.

---

## 2. Proposed design — `inviteUserByEmail`, and nothing new

The claim step should be built out of parts that already exist and are
already proven, because a new auth surface is the last thing this
should add.

```
resident scans the property QR
  → /register (as today), enters email + unit, captcha
  → server: is there a live residents row for (email, property)
            with NO auth user?
      yes → inviteUserByEmail(email, { redirectTo })
      no  → the existing create path, unchanged
  → Supabase sends the invite email
  → /auth/accept?type=invite          (exists, public, OTP fallback)
  → /reset-password-required          (exists, B113)
  → session → /consent               (exists, hard-gate in the layout)
  → resident portal, their imported vehicles already there
```

Everything on that path is shipped: `/auth/accept` handles
`type=invite` pre-session with an OTP fallback, the invite template is
configured, `/reset-password-required` exists, and the portal layout's
consent hard-gate catches them. **Nothing in the auth stack is new.**

### Why invite rather than recovery

`resetPasswordForEmail` is the other candidate and `/forgot-password`
already uses it. It fails for an address with no auth user, which is
exactly our population. `inviteUserByEmail` creates the account AND
emails the token, which is the shape we need. It is also what
`/api/billing/bulk-invite` and CA Add-User already use, so the template
and the landing page are exercised daily.

### 🔴 What the browser is told

The response must be **byte-identical** whether or not a record was
found, matching the bar `create-user` already holds. "We have emailed
you a link" either way. Otherwise the form becomes an oracle for
"is this person a resident at this property", which is worse than the
dead end it replaces.

That also means the refusal copy changes for everyone, not just
claimants — and that is fine, because "check your email" is true on
both branches.

### Do NOT relax the `/register` guard

Per the ruling, and for a concrete reason: the guard is what stops a
second resident silently attaching to an occupied active residency
(hardened 2026-07-25). The claim branch sits **beside** it on the same
decision, keyed on *does this record have an auth user*, and the guard
keeps refusing everything it refuses today.

---

## 3. Two decisions I need from you

### D1 — who creates the `user_roles` row?

Today the resident's own client calls `insert_user_role` **after** the
session exists. If that call fails, the resident has a password and a
blank portal — the failure mode already recorded for
`user_roles.is_active=false` sessions, reached a different way.

**Recommendation: the loader creates it,** alongside the `residents`
row, inside the same transaction. The identity is then complete before
anyone claims, and claiming only adds the auth account — which removes
the ordering trap rather than handling it.

A `user_roles` row with no auth user is inert: `get_my_role()` keys on
the JWT email, so nothing consults it until someone authenticates as
that address. 35 such residents exist today and the system is fine.

### D2 — the vehicle field on the claim branch

`/register` has a companion-vehicle field. A claimant's record already
has their cars.

**Recommendation: the claim branch ignores it,** and the screen says
their vehicles are already on file. Accepting it would either silently
drop the input — the B209/B210 class — or create a vehicle outside the
manager's approval path. After claiming they add cars through the
resident portal, which goes pending and gets approved, which is where
that authority belongs.

---

## 4. Population — measured, not estimated

### The 35 existing residents with a record and no login

| property | count |
|---|---|
| Sunset Ridge Apartments [Demo Company] | 13 |
| Willowbrook Court [Demo Company] | 9 |
| Northgate Commerce Center [Demo Company] | 7 |
| Southmore Park [Demo Company] | 4 |
| Test Legacy Property [Test-LEGACY] | 2 |

🔴 **All 35 are demo or test tenants. A1 has zero.** So covering them is
how we *prove* the mechanism, not a rescue — and they are safe to
exercise against repeatedly, which makes them the right rehearsal
population before a real batch loads.

(378 live residents, 343 with a login. One live resident has an auth
user but no `user_roles` resident row — that is the no-role-row class,
one row, filed separately rather than folded in here.)

### What Alden Park would add

228 residents, 358 vehicles, 1.6 vehicles each (max 5).

- **215 individual mailboxes**
- **13 corporate-housing mailboxes** (6%) — the invite goes to the
  leasing company, not the occupant. The customer instructions already
  warn about this; worth re-stating when the batch is approved.
- 4 units hold two residents each — two emails, two invites, correct.
- No email appears under more than one unit.

---

## 5. The risk this design does not remove

If A1 typo'd an email, the invite goes to a stranger who can then claim
a resident record and see that unit and its plates. Nothing we can
check catches it: the address is syntactically fine and we have no
other channel to the resident.

That is what the attestation is for, and it is why accuracy sits with
A1. Two things reduce the blast radius and should be built in:

1. **The invite email names the property and unit, and lists no
   plates.** A wrong recipient can then tell it is not theirs, and
   learns nothing about a vehicle.
2. **Enforcement does not depend on the resident portal.** A mistaken
   claim exposes a record; it does not authorize or de-authorize a car.

---

## 6. What I would build, in order

1. the claim branch in `/register` + the server decision (one route),
   response identical on both branches
2. the invite-email copy, naming property + unit, no plates
3. a gate: claim succeeds for a record with no auth user; is refused
   for an email with an auth user; is refused for a record at another
   property; returns an identical body in all three; and the
   `/register` guard still refuses what it refuses today
4. exercise it end-to-end against the 35 demo residents
5. only then the approval queue and the loader

Awaiting D1 and D2 before writing any of it.

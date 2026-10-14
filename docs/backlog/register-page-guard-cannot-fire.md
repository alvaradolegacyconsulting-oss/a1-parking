# 🔴 /register's duplicate-resident guard cannot fire

Found 2026-10-15, measured.

## What it looks like

`app/register/page.tsx:177-190` — the Wall A check, scoped per-property
by the 2026-07-25 attach-hardening:

```ts
const { data: existing } = await supabase
  .from('residents').select('id')
  .ilike('email', emailLower).ilike('property', escapedProperty)
  .eq('is_active', true).eq('status', 'active')
  .limit(1).maybeSingle()
if (existing) { setError('You are already registered at this property…') }
```

## Why it cannot fire

`/register` runs this **pre-session** with the shared anon client. Anon
has no SELECT grant on `residents`:

```
anon, the guard's exact query -> permission denied for table residents
anon, unfiltered select       -> permission denied for table residents
anon, vehicles                -> permission denied for table vehicles
```

That is a **table-level grant** denial, not RLS — so it comes back as an
`error`, not as empty data. The destructuring takes only `data`,
discards the error, and `data` is `null`. `if (existing)` is therefore
always false for an unauthenticated visitor.

The anon revoke is correct and should stay; the standing rule is to
REVOKE anon on every public-schema table. The defect is the guard
reading a denial as an absence.

🔴 It is the "absence must not be the failure output" class, in its
most expensive form: the thing that could not be checked was reported
as nothing to find.

## What it means

1. The **2026-07-25 per-property attach-hardening is not in force.**
   Whatever it was meant to prevent — a second resident silently
   attaching to an occupied active residency — is not being prevented
   by this guard.
2. It is why the records-bearing takeover was reachable: there was no
   live check in front of `/api/register/create-user`.
3. 🔴 **Do not fix it by granting anon SELECT on `residents`.** That
   trades a broken guard for resident PII readable by anyone with the
   anon key. The check belongs server-side, where it now is.

## Current state

The route-level check added 2026-10-15 (`residents` **and**
`user_roles`, service_role, fail-closed) is strictly stronger than this
guard and does fire. The page guard is now redundant rather than
load-bearing.

## What to decide

- **Delete the page guard**, since the route enforces it and a check
  that cannot fire invites the next reader to trust it. Deleting it also
  removes a client-side `residents` read that was never going to work.
- Or **keep it as UX only** and have it read the error — but it can
  never succeed as anon, so there is nothing for it to do.

Recommendation: delete it, in the same commit as the claim screen, so
the two decisions about that code path land together.

## Checking it

```
npm run verify:createuserguard     # the route refuses; this is the real control
```

The anon denial itself is one query:

```ts
await anonClient.from('residents').select('id').limit(1)
// → { data: null, error: 'permission denied for table residents' }
```

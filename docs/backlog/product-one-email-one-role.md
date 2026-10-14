# Product rule — one email, one role

Documented 2026-10-15. **Nothing built; this is a statement of the rule
the system already assumes.**

## The rule

**One email address carries exactly one role.** A person who is both
staff and a resident needs two addresses.

## Why it is already true, whether or not anyone decided it

`get_my_role()`, `get_my_company()` and `get_my_properties()` each read:

```sql
SELECT <column> FROM user_roles
 WHERE lower(email) = lower(auth.jwt() ->> 'email')
 LIMIT 1
```

`LIMIT 1` with no `ORDER BY`. A second row for the same address makes
the answer **arbitrary** — and these three sit under most of the RLS in
the system, so "arbitrary" means a person's entire access could differ
between two requests.

Measured 2026-10-15: **0 of 386 distinct emails have more than one
`user_roles` row.** So the system is single-role today by practice, and
deterministic by luck rather than by construction.

## What went wrong without the rule written down

`amandacanchol@gmail.com` held a manager role AND a live resident
record. One address, two identities, and they pulled in opposite
directions:

- deactivating the **manager** left the **resident** needing the login,
  so the auth ban could not be applied — the fix had to be surgery on
  the role row rather than the account;
- `get_my_role()` returned `manager` for someone whose only live
  business was being a resident;
- she signed in 11 days after being "deactivated", and nothing was
  wrong with her doing so.

Nobody made a mistake. The address was invited as a manager in July and
later used to register as a resident, and no layer objected because no
layer knew it should.

## What follows from stating it

In rough order of value, none of it built:

1. **A UNIQUE index on `lower(btrim(email))` in `user_roles`.** Already
   noted as a Bar-2 item in `get_my_role`'s own history ("single-row-
   per-email is the documented assumption; the UNIQUE constraint is a
   separate Bar-2 item"). It is 0-violation today, so it would apply
   clean — but it is a hard constraint on a table every portal writes,
   so it needs its own writer sweep.
2. **The invite path should refuse an address that already holds a
   different role**, with copy that says so: "that address is already a
   resident at Southfork Lake — invite a different address." Stating
   the fact, not asking them to guess.
3. **`/register` should refuse an address that holds a staff role** for
   the same reason, and that now happens as a side effect of the
   2026-10-15 records-bearing fix — though as a byte-identical "we
   could not set up an account here" rather than an explanation.
4. **Document it where customers see it.** The bulk-onboarding
   instructions already say "if two leaseholders in one unit each want
   their own login, give each their own email"; the staff-vs-resident
   case deserves the same sentence in the manager/CA help.

## What NOT to do

🔴 **Do not add multi-role support to make the data fit.** Two roles on
one address means every `get_my_role()` site has to decide which one
applies, and there are ~1,199 textual references to those helpers
across 151 migration files. A second address is free.

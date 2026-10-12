# Audit view: company-scoped, honestly empty — ruled arc

Ruled by Jose 2026-10-12. **Order: Piece 1 (parking tags) → Piece 2
(printable passes) → this.** Nothing here is built.

## The defect this closes

`fetchCompanyAuditLogs` (`app/company_admin/page.tsx:1034`) pulls 200 rows
and filters them client-side on:

```js
userEmails.includes(log.user_email.toLowerCase()) ||
JSON.stringify(log.new_values || {}).toLowerCase().includes(companyName)
```

Measured 2026-10-12:

- **Not a disclosure.** RLS returns **0 of 4,924 rows** to a `company_admin`
  and to a `manager`; only `admin` (super) reads rows; `anon` is refused at
  the table grant. The substring filter never receives a foreign row.
- **The view is permanently blank.** 0 rows in → 0 rows filtered → the CA
  sees an empty list that reads as "nothing happened", not "you cannot see
  this". That is the actual bug, and it is the absence-must-not-be-the-
  failure-output rule.
- **Substring matching is latent, not safe.** No current company name
  contains another (`Test-PM`, `Test-LEGACY`, `Demo Company`,
  `A1 Wrecker llc`, `Test PM Starter 2`, `Test-ENF`), but self-serve signup
  lets a tenant choose a name, so `Test-PM` + a future `Test-PM Holdings`
  collides immediately.

## Ruled shape

### 1. `audit_logs.company_id`

FK to `companies.id` — **not** the name text. Ruled explicitly because of the
whitespace and rename fragility already on record (`properties.state = "tx "`,
and the orphan-company check having to `lower(trim(...))` both sides).

### 2. Population by BEFORE INSERT trigger

Resolves the actor's company from `user_roles` by **exact lowercased email**
when the writer did not supply `company_id`. Every existing audit writer gets
it for free — no hand-placed population at ~40 call sites, nothing for a new
call site to forget.

Rows with no resolvable company (system jobs, anonymous visitor actions, cron)
stay **NULL** and are **super-admin only**.

🔴 The trigger must not *overwrite* a `company_id` the writer supplied —
resolve only when it is NULL, so a deliberate attribution wins.

### 3. Backfill

Resolve from `user_roles` by exact email. **Report counts before applying:**
how many rows resolve, how many stay unresolved, and why (no role row, actor
deleted, `user_email` NULL, system actions). No substring matching on
`new_values` anywhere, in the backfill or after.

Expect a real unresolved tail — `user_email` is NULL on some rows
(`VISITOR_TOS_ACCEPTED`), and deleted actors have no role row.

### 4. `get_company_audit_logs(limit, offset)`

`SECURITY DEFINER`, reads **`company_id` only**, paginated,
`REVOKE ... FROM anon` explicitly. The client's substring filter is deleted,
not narrowed.

🔴 **Why the column and not a `user_roles` join:** a join keys on the actor
still having a role row, so deactivating or deleting a user would erase their
history from the view. Audit history must not be erasable by removing a user.
The column also drops a join from a table already at 4,924 rows and growing,
which matters given the 57014 perf arc.

### 5. Honest empty state

The view must say what it shows. `No activity recorded yet for <Company>`,
distinct from an error state, never a silent blank. Three states, not two:
loading, empty-and-known, failed-to-load.

## Gate (execution, not a source read)

- A CA sees their own company's rows and **none** of another's.
- Fixtures must include **one company name that is a substring of another** —
  `Test-PM` and `Test-PM Holdings` — and prove no bleed. This is the exact
  case the old filter would have failed and that today's data cannot catch.
- History **stays visible** after the actor's `user_roles` row is deactivated,
  and after it is deleted.
- `anon` is refused.
- NULL-`company_id` rows are visible to super-admin and to no one else.
- Positive control: a CA with rows sees them (a function returning nothing
  passes every negative test).

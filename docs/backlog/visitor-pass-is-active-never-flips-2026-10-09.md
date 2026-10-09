# Backlog — `visitor_passes.is_active` never flips on expiry

**Date filed:** 2026-10-09 (split out of the duplicate-pass arc by Jose)

## The state

| | |
|---|---|
| total passes | 1,879 |
| `is_active = true` | 1,876 |
| **truly live** (`is_active` AND `expires_at > now()`) | **30** |
| `is_active = true` but **expired** | **1,846** |
| `is_active = false` | 3 (all revoked by hand) |

Nothing ever sets the flag to false on expiry. There is no cron, no
trigger, no scheduled sweep. `is_active` means "was not manually
revoked", which is not what its name says.

## Why it matters

**Any code reading `is_active` alone sees 1,876 active passes when 30
are valid.** That is a 62x overstatement, and it is the kind of thing
that reads as fine in review because the column name sounds
authoritative.

Already standing as a rule — `is_active = true AND expires_at > now()`,
both, always — and `issue_visitor_pass` (2026-10-09) applies it. But a
rule everyone must remember is weaker than a column that is true.

🔴 **Do NOT "fix" this by making the limit trigger read `is_active`.**
`enforce_visitor_pass_limit` deliberately counts every row created in
the last 30 days regardless of the flag: *"Do NOT re-add `is_active =
TRUE` — that reopens issue-revoke-reissue."* A sweep that flips expired
rows must not change what that trigger counts, and the trigger does not
read the flag today, so flipping is safe for it. Confirm that is still
true before shipping.

## Options

1. **A cron that flips expired rows.** Simple, makes the column honest,
   and `pg_cron`/Vercel-cron precedent exists in this repo. Downside: a
   row is wrong for up to one cron interval, so readers still cannot
   trust the flag alone — it narrows the window without closing it.
2. **A generated/stored view** — `visitor_passes_live` as a view with
   both predicates, and point every consumer at it. Closes it properly:
   there is no way to read the wrong thing. Downside: touching every
   consumer.
3. **Leave the column, rename it.** `not_revoked` would be accurate and
   would stop the next reader assuming. Cheapest honest option, but
   renaming a column means finding every reference.

My preference is (2) with (3)'s rename folded in, and no cron: a view
cannot be read wrongly, whereas a cron leaves the trap in place and
relies on timing.

## Before picking one

Audit who reads `is_active` on this table. At least:
`app/driver/page.tsx` plate lookup, `pm_plate_lookup`, the manager
at-capacity view, `get_plate_pass_status`. 🔴 The driver plate lookup is
the enforcement boundary — if it reads the flag alone it would treat
1,846 expired passes as valid authorization, so check that one first
and report before changing anything.

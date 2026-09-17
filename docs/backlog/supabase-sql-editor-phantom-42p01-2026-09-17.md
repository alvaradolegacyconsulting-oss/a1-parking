# The Supabase SQL editor can return an error naming an identifier that isn't in your statement

**Found:** 2026-09-17. Cost roughly an hour, most of it spent auditing correct SQL.

## Symptom

```
ERROR: 42P01: relation "a" does not exist
```

Returned for a statement containing **no `a`**:

```sql
SELECT prosrc FROM pg_proc
 WHERE oid = to_regprocedure('public.ca_plate_activity(TEXT, TEXT, INT)');
```

`SELECT 1;` in the same session returned `1` normally.

## How it was established

A verification file failed at its grants gate, which used
`SELECT 1 FROM unnest(v_acl) a WHERE a::text LIKE '…'`. The obvious reading
— `a` resolving as a relation rather than the function scan's implicit
column — was **wrong**, and three things disproved it in order:

1. **The identical construct had run green three times** — `20260909_tow_log_commit_4_rpcs_verification` VS2, VS4, VS6, and `20260910_..._plate_normalize_fix_verification` VS5.
2. **An isolation probe ran all three spellings and all passed** — bare alias multi-line, explicit `AS x(item)`, and the collapsed one-line shape byte-for-byte. `docs/backlog/wip-vs2-42p01-isolation-2026-09-17.sql`.
3. **A statement with no alias at all produced the same error**, in a fresh tab, while a trivial statement succeeded.

An error naming an identifier not present in the submitted text is not a
property of the text.

**Corroborating editor symptoms the same day:** results not rendering for
queries that had clearly run, queries echoing back instead of executing,
and "copy as markdown" also erroring.

## 🔴 Why this is expensive twice

The error is **specific and plausible**. `relation "a" does not exist`
reads like a real diagnosis, so the natural response is to audit the SQL —
and the SQL is fine. Every minute spent there is spent on the wrong layer.

The tell is the one that generalises: **an error that references something
not in your input is about the transport, not the input.** Check that first
and the audit never starts.

## What to do when it recurs

1. Run `SELECT 1;`. If that works and a longer statement fails, suspect the editor.
2. Submit a statement that **cannot** produce the named identifier. If the error survives, it is confirmed.
3. Hard-refresh / reopen the dashboard; try a fresh tab.
4. If it persists, use a different client entirely — see below.

## ⚠ There is no working dashboard bypass in this repo today

Checked 2026-09-17:

| Route | Status |
|---|---|
| `psql` | not installed |
| Supabase CLI | not installed |
| `pg` npm driver | not installed |
| `DATABASE_URL` / direct connection string | not in `.env.local` |
| `supabase-js` + service role | **cannot run arbitrary SQL** — PostgREST exposes tables and RPCs only |

So the existing probe scripts can read tables and call RPCs, but **none of
them can run a `.sql` file**. That is why every verification in this project
goes through the dashboard.

**Building the bypass needs two decisions, neither of them unilateral:**

- a **direct connection string** (Supabase dashboard → Settings → Database), which is a credential that would have to live somewhere, and
- adding **`pg`** as a project dependency, or installing `psql` / the Supabase CLI on the machine.

🔴 **Do NOT close this gap with an `exec_sql(text)` DEFINER function.** It is
the tempting shortcut — it needs no new credential and no new dependency —
and it is arbitrary SQL execution reachable through PostgREST by anyone who
can call an RPC. This project spent September closing a wildcard RLS hole
and an account-takeover route; that would be worse than both.

## Status

Open. Unblocked by refreshing the editor on the day. Worth deciding the
bypass question before the next multi-hour verification session, not during
one.

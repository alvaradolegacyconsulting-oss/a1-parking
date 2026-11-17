# 🔴 Supabase backups exclude Storage — violation photos are not backed up

**Filed:** 2026-11-16 · **Backlog, scope after A1 rollout** (Jose)

## The gap

Supabase's managed backups cover the **Postgres database**. They do **not** cover
**Storage objects**. Every violation photo and video lives in Storage, so today a restore
brings back the `violations` rows and their media references with **no media behind them**.

## Why it matters more here than in most products

The media *is* the evidence. `docs/help/07-tow-tickets-and-evidence.md` tells operators
that photos and videos are retained for at least seven years in line with Texas record
retention, and the platform's own value proposition to an operator facing a Chapter 2308
dispute is that the evidence package exists. A database-only backup does not deliver that
promise, and the failure is silent: the rows restore, the thumbnails break.

## Scope when it is picked up

- Confirm against the live project which buckets exist and how large they are — the
  catalog is the audit surface, not this file.
- Decide the retention target first (seven years is what the docs claim), then the
  mechanism. A nightly copy to object storage outside the Supabase project is the usual
  shape; versioning and lifecycle rules follow the retention decision.
- 🔴 Include the **restore drill**, not just the copy. A backup nobody has restored from
  is a belief, not a backup — and the thing to prove is that a restored row and its
  restored object still resolve to each other.
- Check whether the soft-delete path matters: media is soft-deleted with an audit trail
  and must stay recoverable, so a backup that silently drops hidden objects would defeat
  the chain-of-custody argument the docs make.

## Related

`docs/backlog/b26-storage-cleanup-cron.md`-era work deletes orphaned objects; that and
this must not fight each other — the cleanup's definition of "orphan" has to agree with
whatever the backup considers in scope.

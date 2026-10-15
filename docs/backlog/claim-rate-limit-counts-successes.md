# 🔴 The claim route's rate limit counts successes, so it limits the wrong thing

Found 2026-10-15, by my own gate passing for the wrong reason. Filed
the same day the route was written. **Not yet fixed — it needs a
decision about where a counter lives.**

## How it was found

`verify:claim` asserted "no 4th invite was recorded — the ceiling
held", and it passed. It passed because the **first** invite creates the
auth user, so every later request short-circuits at

```ts
if (uid) { /* already has a login */ return answer() }
```

and never reaches the ceiling at all. The ceiling was never exercised.
A confounded control: the right outcome, the wrong cause.

## The flaw that chasing it exposed

The limiter counts rows in `audit_logs`:

```ts
.eq('action', 'RESIDENT_CLAIM_INVITE').gte('created_at', since)
```

Those rows are written **only after a successful invite**. So:

| caller | audit rows written | throttled? |
|---|---|---|
| a resident asking twice for their own link | 1 (then the uid check stops it) | moot |
| 🔴 someone probing 10,000 unknown addresses | **0** | **never** |
| 🔴 someone probing 10,000 real addresses at the wrong property | **0** | **never** |

The limiter caps legitimate repeats — which the `uid` check already caps
at one per address — and does nothing at all about the traffic a rate
limit exists for.

## What actually defends this endpoint today

Stated plainly, because the rate limit should not be counted among them:

1. **Turnstile, per request.** The real per-request cost. Checked before
   any lookup, so a bot cannot probe at all without solving one.
2. **The byte-identical answer.** What defeats enumeration. A caller
   learns nothing from the response in any branch.
3. **The `uid` check.** Caps unsolicited invites at **one per address,
   ever** — which is the mail-bombing concern, and it is bounded by
   construction rather than by a counter.

That is a defensible set. The rate limit adds approximately nothing to
it, and leaving it in place while describing it as a control is the
problem — a control that does not work is worse than a missing one,
because it stops anyone looking.

## Options

**(a) Count requests, not successes.** Needs a store the route can
write on every attempt: a small `claim_attempts` table (email_hash, ip,
at) with a retention sweep. Honest, and it makes the per-IP ceiling real.
*Cost:* a migration and a new table on a public write path — which is
itself a denial-of-service surface if unbounded, so it needs the
retention job in the same change.

**(b) Drop the counter and say so.** Keep Turnstile, the identical
answer and the `uid` cap, and delete the audit-row counting with a
comment explaining why it was removed. Smaller, honest, and loses
nothing that currently works.

**(c) Leave it.** Not recommended: it reads as a rate limit in code
review and is not one.

My recommendation is **(b) now, (a) when the claim screen is public
enough to need it** — the claim entry point today is behind a property
QR link and a Turnstile solve, and the identical answer is what carries
the enumeration risk. If the claim screen ever becomes a bare public
form, (a) stops being optional.

## Not a reason to delay the claim step

None of the three real defences depends on this. The route is safe to
ship; what is not safe is calling the counter a rate limit.

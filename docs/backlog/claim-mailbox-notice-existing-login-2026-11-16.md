# Claim: tell an existing-login address something, in the mailbox

**Filed:** 2026-11-16 · **Deferred by Jose** · Not started

## The defect

`/register`'s precheck withholds the token for any address with a `residents` or
`user_roles` row, and the screen offers a claim button: *"we will email a setup link."*
Press it with an address that **already has a login** and `/api/register/claim` sends
**nothing** — correctly, because `inviteUserByEmail` would fail for an existing user and
re-inviting is how someone gets a surprise password reset. Meanwhile the screen says:

> If we have your details on file for that property, we have emailed you a link to set up
> your login.

A promise, and no mail. That is worse than a dead end, because the person stops looking.

## Why the fix has to be the mailbox

The on-screen answer can never say which case the visitor is in — that is the enumeration
delta the whole design refuses, and `SAME_ANSWER` plus the 900 ms floor exist to hold it.
**The mailbox is the one channel that can carry status safely**, because only the owner of
the address receives it.

So: when the address already has a login, send a mail that says so — "you already have an
account here; sign in, or use Forgot password" — rather than nothing.

## It also fixes the two cases nothing currently serves

Measured over the 30 days to 2026-11-16, 15 precheck refusals came from 5 people:

- one had been **declined** by the office and retried three times over nine days. Every
  route the screen names (Log in, Forgot password, claim) is irrelevant to them;
- one had just registered and was **pending approval**, and came back because nothing
  visible had happened.

A mailbox notice can state either status. The screen cannot.

## Shape

- Extend `/api/register/claim`'s `already_has_login` branch to send a "you already have an
  account" mail. Keep `SAME_ANSWER` and `FLOOR_MS` exactly as they are.
- Consider the same for a matched resident whose row is `pending` or `declined`: today the
  match predicate requires `is_active = true AND status = 'active'`, so those rows fall to
  `no_match` and get silence. Changing that predicate is a **decision**, not a tidy-up —
  it widens what the claim path will act on.
- 🔴 Do not add status to the HTTP response. Not in any branch, not behind a flag.

## How to know it worked

`verify:claimfunnel` already pins the one-write-site shape, and every branch now records
an outcome, so `RESIDENT_CLAIM_INVITE` rows with `outcome='already_has_login'` are the
population this would serve. There were **0** claim rows of any kind in the 30 days to
11-16, against 15 precheck refusals — count them again before and after.

# Claim UX: email-first — report before building

2026-10-15. **Nothing built.** There is a decision in §4 that is yours,
because the obvious implementation changes what `/register` is.

## 1. What `/register` does today

```
Step 1 of 3 — Account Info      email, password, name, unit, phone
Step 2 of 3 — Add Vehicles      plate, state, make/model/colour
Step 3 of 3 — Review & Submit    consent + Turnstile → submit
                                 ↓
                      POST /api/register/create-user
                      ↓ new email            ↓ records-bearing email
               token_hash → session    no token → the tokenless message
               → residents INSERT      → "use the setup link" card
               → insert_user_role
               → companion vehicle
```

🔴 **Jose is right that this reads as broken.** An imported resident
types their email, a password, their unit, and every vehicle they own —
three screens — and the reward is being told they are already on file.
Everything they entered is discarded, including the vehicles, which are
already in the system anyway.

## 2. Where the OTP sits today — and it is not where it is needed

There is **no email-verification step in `/register`**. Its `verifyOtp`
calls are the magic-link **token_hash** session acquisition at
`page.tsx:305`, not a code the user types.

The typed-code flows are elsewhere:

| flow | call | template |
|---|---|---|
| `/signup/verify` | `verifyOtp({email, token, type:'signup'})` | **signup** — dispatched |
| `/reset-password`, `/reset-password-required` | OTP fallback | **recovery** — dispatched |
| `/auth/accept` | OTP fallback for invite + recovery | **invite**, **recovery** — dispatched |

🔴 So "reuse the existing verify-email OTP flow" is not a drop-in. The
existing one is the **signup** template, which requires
`supabase.auth.signUp()` — a password up front, and an error for an
existing address, which is itself an enumeration signal.

What email-first needs is a code sent to *any* address, which means
`signInWithOtp`. **There is no `signInWithOtp` call site in the
codebase**, and `/auth/accept:153` says why:

> Magic-link template is **not currently dispatched** (no
> `signInWithOtp` call sites). Wired proactively… If passwordless
> sign-in ever launches, the template flips here.

The handler is already built and waiting. What is missing is one
**Supabase dashboard change** — point the Magic Link template at
`/auth/accept?token_hash={{ .TokenHash }}&type=magiclink&next={{ .RedirectTo }}&email={{ .Email }}`,
the same shape as the other four.

## 3. The proposed flow

```
QR → /register
  ① email + Turnstile  →  signInWithOtp({ email, shouldCreateUser: true })
                          "We emailed a 6-digit code to <address>."
  ② the code           →  verifyOtp({ email, token, type: 'magiclink' })
                          🔴 the mailbox is now proven
  ③ branch, server-side, with the session:
       records-bearing  → "Unit 1150 and 2 vehicles are already on file."
                          → set a password → /consent → portal
       new address      → the existing 3-step form, email prefilled
                          and already verified
```

**Why this removes the oracle rather than hiding it.**
`signInWithOtp({shouldCreateUser:true})` behaves *identically* for a
known and an unknown address — both get an email, both return success.
So step ① leaks nothing, and the branch happens only after the mailbox
is proven. That is strictly stronger than today's byte-identical
answers, because there is no longer anything to keep identical.

The refusal guard in `/api/register/create-user` and the claim route's
identical responses **stay exactly as they are** — they are the
server-side floor, and step ① does not replace them.

## 4. 🔴 THE DECISION: a session before the branch is a passwordless login

To branch on "records-bearing" *after* proving the mailbox, you need the
proof to exist client-side. `verifyOtp` gives you a **real session** —
and `signInWithOtp` is not scoped to residents.

**So a manager, a leasing agent or a company_admin who types their own
address into the QR page gets a code and a working session, bypassing
their password.**

Scoping that after the fact does not work. Signing them out on the
non-resident branch is cosmetic: the session is real from the moment
`verifyOtp` returns, and anything the page could do with it, so could
anyone. A client-side sign-out is not a control — the same reason the
portal gate is not one.

It is not a new *capability* in substance: `/forgot-password` already
lets whoever controls a mailbox take over that account. It is a new
**path**, on a public page, that skips the password for privileged
roles.

### The three ways forward

**(a) Accept it.** Passwordless sign-in becomes a platform property,
and `/register` is one of its entry points. Cheapest, and consistent
with `/forgot-password`'s existing trust model. Needs the Magic Link
template pointed at `/auth/accept` — which is already wired for it.
🔴 Worth stating out loud: this means any staff account can be signed
into from the public QR page by whoever holds the mailbox.

**(b) Our own code, no session until the branch.** A server route sends
a 6-digit code, stores its hash with an expiry, and verifies it —
returning only "verified: yes/no" plus the branch, with **no session
issued** until the claim path actually sets a password. Scoped to
residents by construction, because the route decides.
*Cost:* a `claim_codes` table with a retention sweep, our own code
generation and expiry, our own send through Resend, and a new
public write path. More surface, and it duplicates something Supabase
does.

**(c) Email-first for the LOOK, invite for the proof.** Step ① collects
the email and calls the existing claim route, which sends the invite.
No code typed, no session, no template change, nothing new. The resident
sees one screen — "check your email" — instead of three screens and a
refusal.
*Cost:* two emails if they also need recovery later, and the branch
copy ("unit N and X vehicles are on file") cannot be shown, because
without the mailbox proven, saying it IS the oracle.

### My recommendation

**(c) now, (a) or (b) when passwordless is a decision you want to
make.** (c) fixes the actual complaint — three wasted screens ending in
a refusal — with code that already exists and no new trust model. The
"unit N and X vehicles are on file" reassurance is the one thing it
cannot deliver, and that reassurance is precisely the oracle, so losing
it is the honest trade rather than a regression.

If you want the reassurance shown, that requires mailbox proof before
the branch, which means (a) or (b) — and (a) should be a deliberate
decision about passwordless sign-in for staff, not a side effect of a
resident-onboarding fix.

## 5. What I will build either way

- step ① becomes **email + Turnstile only**; the vehicle and password
  fields do not render until the branch is known, so nothing a resident
  types is ever discarded;
- the tokenless refusal card stops being a dead end and becomes the
  "check your email" screen;
- `/forgot-password` stays named on it, for anyone who already has a
  link;
- the gate asserts step ① returns the same thing for a records-bearing
  and an unknown address, and that no vehicle or password field is
  reachable before the branch.

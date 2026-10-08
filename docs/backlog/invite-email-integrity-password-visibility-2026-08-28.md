# BACKLOG — Invite-email integrity + password visibility

**Filed:** 2026-08-28
**Author:** Mateo
**Class:** *Where a value can be absent legitimately, absence must not also be the failure output* — see [`feedback_absence_must_not_be_failure_output`](../../.claude/projects/-Users-ALC-a1-parking/memory/feedback_absence_must_not_be_failure_output.md).

Three entries. The first is small enough to pull forward; the second and third are real builds. All three trace to the same complaint shape: **the system knows something the operator doesn't, and shows them nothing.**

**Origin:** A1 mistyped an email while creating an account. Workaround was deactivate and recreate. A1 asked whether the address could be corrected in place. Separately, a standing frustration about not being able to see a password while typing it.

---

## ENTRY 1 — Confirm-on-entry for email at Add-User / Add-Driver

**Priority:** P2. **Small — candidate for pulling forward.** Prevention, not repair.
**Status:** Not built. No design questions open.

### The gap

`Add-User` and `Add-Driver` in the CA portal take an email address as a single free-text field with no confirmation step. The address becomes the identity key for that account, the destination of the only invite that will ever be sent, and the join key for every downstream row. There is no second chance to notice a typo, because nothing after the submit references the address in a way an operator would read.

Confirmed writer paths (Mateo, Aug 28):

- CA Add-Driver — `company_admin/page.tsx:2067` → `api/admin/invite-user/route.ts:158`
- CA Add-User — `company_admin/page.tsx:1997` → same route

Both call `service.auth.admin.inviteUserByEmail()`. The send succeeds. Delivery is somebody else's problem, and nobody is watching it.

### Fix

A confirm-email field, or a review-before-submit step that shows the address back. Match whichever pattern the codebase already uses; don't invent a third.

Apply to **both** CA forms. Also apply to the super-admin equivalents (`admin/page.tsx:560-570` Add-User, `admin/page.tsx:820-844` Add-Driver) — same defect, different portal.

### Why this before the repair path

A1's actual ask was "let me fix the typo." The cheaper and better answer is "you won't make it." Roughly twenty lines against a repair path that has to reason about `auth.users`, `user_roles`, the `UNIQUE(lower(email))` constraint, a live-session race, and invite-token reissue. See Entry 1b for why the repair path is filed rather than built.

### Not in scope

Format validation beyond what exists. A syntactically valid address for the wrong person is the case that actually happened, and no regex catches it.

---

## ENTRY 1b — In-place email correction before first login (FILED, do not build yet)

**Priority:** P3. Filed so the reasoning survives. **Blocked on Entry 2** — bounce visibility makes most of this unnecessary.

### The distinction that makes it defensible

Email is the join key in this schema, not merely an identifier. `get_my_company()`, `get_my_role()` and `get_my_properties()` all resolve on `lower(email) = lower(auth.jwt() ->> 'email')`. 24 policy sites use the `email ~~*` variant. `residents`, `vehicles`, `spaces.assigned_to_resident_email` and `space_residents` carry the address as a value-join. Changing a live user's email means updating an unbounded set of value-joins or silently orphaning them. **That remains a no** until the FK epic lands.

But an account that has **never been signed into** has no such joins, because there has been no opportunity to create any. Correcting an unclaimed record and changing a live user's identity are different operations that happen to touch the same column.

### Shape, if it is ever built

- Gate on `last_sign_in_at IS NULL`, written in the safe shape (`IF last_sign_in_at IS NULL THEN allow ELSE reject`, never `IF NOT signed_in`), re-read inside the transaction so a login mid-operation cannot slip through.
- Update `auth.users` and `user_roles` in one transaction, service-role.
- Catch `23505` against `UNIQUE(lower(email))` — the corrected address may exist.
- Reissue the invite; the outstanding token points at the old address.

Nothing in the app currently calls `auth.admin.updateUserById` (Mateo, Aug 28), so this is net-new surface on the auth spine.

### Cost of the current workaround, for the record

Deactivating the `user_roles` row does not remove the `auth.users` row, and no in-app action does — the finding from the July 25 re-registration arc. Each typo permanently burns that address in `auth.users`, and with `UNIQUE(lower(email))` live on `user_roles`, the deactivated row holds it there too.

Harmless for a genuinely wrong address. Not harmless if the typo lands on an address someone at that company later needs, which is the "account already exists" defect the re-registration arc closed for residents. Tolerable at A1's volume, compounds at self-serve.

Sibling: `orphaned-auth-users-after-name-collision` backlog item.

---

## ENTRY 2 — 🔴 Surface bounced invites on the user row

**Priority:** P2, rising to P1 at `public_signup_open`.
**Status:** Not built. Open question RESOLVED below.
**Class:** *Where a value can be absent legitimately, absence must not also be the failure output.*

### The gap

An invite that bounced and an invite not yet opened are **indistinguishable on every surface.** Confirmed (Mateo, Aug 28): zero occurrences of `bounce`, `BOUNCED`, `delivery_failed` or `EMAIL_BOUNCED` anywhere in the app writer surface. The only reference is a comment at `resend-client.ts:102` noting that Resend keeps bounce records in its own dashboard. Nothing reads them back.

So the sequence is: `inviteUserByEmail()` returns success, because the handoff succeeded. Resend attempts delivery, fails, logs a bounce nobody reads. The user row shows **Invited**. The Resend Invite button re-sends to the same wrong address and produces the same silent failure. The operator discovers the problem when a human tells them they never got anything.

This is the exact class rule from the kickoff. "Invited" is a legitimate state and also the failure output.

### Fix shape

Resend webhook → persist delivery state on the user row → render it.

- Webhook endpoint consuming Resend's `email.bounced` and `email.delivery_delayed` events. Verify the signature; do not trust the payload.
- A delivery-state column on `user_roles` (or a small `invite_deliveries` table if we want history — lean table, since resend-after-correction produces a second attempt and the first shouldn't be overwritten).
- Badge on the user row. **Three distinct states, not two:** delivered-and-pending, bounced, and not-yet-known. A fetch failure must render as unknown, never as delivered.
- Suppress or warn on Resend Invite when the last attempt bounced — re-sending to a known-bad address is the current behaviour and it is worse than useless.

### Open question — RESOLVED (Claude, Aug 28)

**Are Resend webhooks configured at all today?** No.

Grep across `app/` for `resend.*webhook`, `email.bounced`, `email.delivery`, `/api/webhooks/resend`, `Svix-Signature`, `Webhook-Signature` returns zero hits. `find app/api -type d -iname "*webhook*"` returns only `app/api/stripe/webhook`. The B66.5 dunning work established a Stripe webhook path but not a Resend one — Supabase Auth appears to relay through Resend as SMTP, so the bounce event originates at Resend and would need a Resend-side webhook subscription pointed at a new endpoint on our side.

**So this entry is greenfield webhook infra:** endpoint route + signature verification (Resend uses Svix for webhook signing) + a Resend project configuration change (subscribe the endpoint to the relevant event types) + the persistence layer + UI.

Not enormous, but not the twenty-line change Entry 1 is.

### Why this outranks Entry 1b

Bounce visibility turns a silent failure into a five-second correction: the CA sees the badge, deactivates, recreates with the right address, done — the same workaround they already have, except they know to run it immediately instead of days later. Most of the value of in-place correction is really the value of *knowing*.

---

## ENTRY 3 — Password visibility toggle on password entry fields

**Priority:** P3. Recurring request; previously declined.
**Status:** Not built. Reopened Aug 28 on repeated user frustration.

### The reversal, and the reason for it

This was pushed back on before. Worth reopening, because the security argument runs the *other* direction from the intuition.

A hidden password field means the user cannot verify what they typed. The observed consequences are that people choose shorter and simpler passwords they can type without error, they mistype and get locked out, and they paste from somewhere less safe. NIST's digital identity guidance (SP 800-63B) explicitly recommends allowing the user to display the secret while entering it, on exactly this reasoning. Every major consumer auth surface now does it.

The residual risk is shoulder-surfing, and it is fully mitigated by the standard pattern: **default hidden, explicit user-initiated toggle, never persisted across loads.**

### Scope — user-entered fields only

Apply to fields where a person types **their own** password:

- Login
- Set-password from an invite link
- Forced password change (`must_change_password`)
- Password reset

### 🔴 Explicitly NOT this entry — and the thing to actually remove

Super-admin single-create currently **displays a generated temp password to a third party** for manual relay:

- `admin/page.tsx:820-844` (Add-Driver) — `setDriverMsg('Driver created! Temp password: …')`
- `admin/page.tsx:560-570` (Add-User) — credentials modal

That is not password visibility. That is a credential shown to someone who is not its owner, then relayed over whatever channel is at hand. It should be **removed**, not toggled — and the CA portal already proves the alternative works, since CA Add-User and Add-Driver both route through `inviteUserByEmail()` and never display a password at all.

This is the June 12 **D1** item, closed on the CA side and still open on the super-admin side. Fold it in here or file it against D1; either way it should not survive `public_signup_open`.

### Implementation notes

- `type` toggle between `password` and `text` on the input; do not build a custom reveal.
- Preserve `autocomplete` attributes so password managers keep working.
- The control needs an accessible label whose state changes with the toggle.
- No logging of the field value anywhere, in any state.

---

## Suggested handling

- **Entry 1** — small, self-contained, no open questions. Reasonable to pull forward and give A1 a concrete answer.
- **Entry 2** — greenfield webhook infra (open question resolved above); this is the one that actually fixes A1's complaint.
- **Entry 3** — small build, but it touches auth surfaces. Not before the Bar-2 auth work settles.
- **Entry 1b** — filed. Revisit only if Entry 2 ships and the complaint persists.

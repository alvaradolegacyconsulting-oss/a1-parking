# B117 Phase 2 — Acceptance Doc

**Status:** code Edited + tsc clean; templates drafted; smokes pending next session.
**Date:** 2026-06-04 (drafted) / TBD (smoked).

## Background

The B117 PKCE cross-context failure mode: signup or password-reset email links carry a `?code=` PKCE token; `supabase.auth` needs the matching `code_verifier` from localStorage to exchange it for a session. If the user clicks the email link in a different browser context than the one that ran `auth.signUp()` / `auth.resetPasswordForEmail()` / `auth.admin.inviteUserByEmail()` (common with mail apps opening system browsers, mobile-to-desktop flows, or incognito-to-regular switches), the verifier is absent, the exchange silently fails, and the 4s page-side timeout falls back to "couldn't pick up a verified session" with no recovery path.

**Phase 1** (already shipped, commit `cdd0c6f`): added OTP-paste fallback card to `/signup/verify` only.

**Phase 2** (this work): generalizes the OTP fallback to the three remaining verify-class pages — `/signup/redeem/verify` (A1's onboarding path), `/reset-password`, `/reset-password-required` — and ships matching email templates that deliver the `{{ .Token }}` code alongside the existing link.

## Phase 2 scope

### Code (3 files edited, 1 untouched-by-design)

| File | Change | OTP `verifyOtp` type |
|---|---|---|
| `app/signup/verify/page.tsx` | NO CHANGE — Phase 1 already wired | `signup` (existing) |
| `app/signup/redeem/verify/page.tsx` | Added `processVerifiedUser` extraction + OTP card + URL pre-fill | `signup` |
| `app/reset-password/page.tsx` | Added OTP card + URL pre-fill | `recovery` |
| `app/reset-password-required/page.tsx` | Added OTP card + URL pre-fill | `invite` |

### Email templates (3 in Supabase Dashboard — Jose applies)

| Template | Covers | Body |
|---|---|---|
| Confirm signup | `/signup/verify` + `/signup/redeem/verify` | see `b117_phase_2_email_templates.md` Template 1 |
| Reset Password | `/reset-password` | see `b117_phase_2_email_templates.md` Template 2 |
| Invite user | `/reset-password-required` | see `b117_phase_2_email_templates.md` Template 3 |

"Magic link or OTP" template is OUT OF SCOPE (no `signInWithOtp()` call sites in the codebase).

### Allowlist (Jose already applied)

- Added `https://shieldmylot.com/reset-password-required`
- Added `http://localhost:3000/**` (wildcard, covers all dev verification routes)

### Out of scope (filed for follow-up)

- Shared `OtpFallbackCard` component extraction (copy-pasted cards across 3 files today; DRY in a later commit if pattern repeats)
- `app/signup/verify/page.tsx` Phase 1 → Phase 2 cleanup (the `// HELD` comment in [verify/page.tsx:14-37](../app/signup/verify/page.tsx#L14-L37) describes a rollout sequence that no longer applies; Phase 2 supersedes)
- `/reset-password-required` hash-vs-PKCE discrepancy (code comment at [reset-password-required/page.tsx:56](../app/reset-password-required/page.tsx#L56) says hash-fragment; modern `@supabase/ssr` defaults to PKCE — same-context smoke will reveal which is live)

## Locked design

1. **Token-primary, link-as-convenience.** PKCE auto-exchange stays as the same-context fast path. OTP fallback is the universal recovery mechanism.
2. **Both paths fire `processVerifiedUser` / equivalent** so post-verify flow is identical regardless of which path minted the session.
3. **Email body delivers BOTH** `{{ .ConfirmationURL }}&email={{ .Email }}` link AND visible `{{ .Token }}` code block.
4. **Shared OTP token TTL = 24h** (Supabase Auth OTP Expiration = 86400s confirmed 2026-06-04). Copy honest about single shared expiry.
5. **`?email=` URL param pre-fills the OTP form** when present (template-driven). User can override.
6. **Cross-context independence:** OTP path requires no localStorage state. Works regardless of browser/device/incognito-state.

## Acceptance proofs (smokes — fill in at smoke time)

Each page gets BOTH a same-context happy-path smoke AND a cross-context smoke. 8 smokes total.

Use fresh `+alias` Gmail addresses per smoke (e.g., `alvaradolegacyconsulting+b117p2-sv-happy@gmail.com`) to keep data isolated and cleanup easy.

### Page 1 — `/signup/verify` (B66.3 self-serve)

Triggered by: filling out `/signup` (tier selection + email + password).

| Smoke | Browser combination | Expected | Result | Notes |
|---|---|---|---|---|
| Happy | Sign up in Chrome incognito → click link in same Chrome incognito | PKCE auto-verifies inside 4s → `ReadyCard` (tier summary + Continue button) renders | TBD | |
| Cross-context | Sign up in Chrome incognito → click link in Firefox | 4s timeout → OTP card renders with `?email=` pre-fill → paste `{{ .Token }}` → verifyOtp(type:'signup') → `ReadyCard` renders | TBD | |

**Acceptance:** both smokes complete to `ReadyCard`. `/api/signup/attest` fires on both paths (verify `tos_acceptances` row written with TOS + Privacy + Texas attestation versions per [verify/page.tsx:101-107](../app/signup/verify/page.tsx#L101-L107)).

### Page 2 — `/signup/redeem/verify` (B65.4 proposal-code, A1's path)

Triggered by: visiting `/signup/redeem?code=<DRYRUN-XXXX>` + filling form. Needs a fresh test code with `collection_method='charge_automatically'` (per the B66.7 dry-run pattern).

| Smoke | Browser combination | Expected | Result | Notes |
|---|---|---|---|---|
| Happy | Sign up in Chrome incognito → click link in same Chrome incognito | PKCE auto-verifies → activation form renders (validate_proposal_code re-check passes) | TBD | |
| Cross-context | Sign up in Chrome incognito → click link in Firefox | 4s timeout → OTP card with pre-fill → paste token → verifyOtp(type:'signup') → activation form renders | TBD | |

**Acceptance:** both smokes reach the activation form. User fills it. `redeem_proposal_code` RPC fires (writes `tos_acceptances` internally via auth.uid() — works for both PKCE- and OTP-minted sessions). Smoke verifies `tos_acceptances` row created with correct versions.

**THIS IS THE LOAD-BEARING TEST** — the dry-run failure mode (2026-06-04) reproduces on cross-context here. Phase 2's value is proven by this smoke flipping from "stuck on unverified card" pre-fix to "OTP card → activation" post-fix.

### Page 3 — `/reset-password` (B99)

Triggered by: filling out `/forgot-password`.

| Smoke | Browser combination | Expected | Result | Notes |
|---|---|---|---|---|
| Happy | Request reset in Chrome incognito → click link in same Chrome incognito | PKCE auto-verifies → new-password form renders | TBD | |
| Cross-context | Request reset in Chrome incognito → click link in Firefox | 4s timeout → OTP card → paste token → verifyOtp(type:'recovery') → new-password form | TBD | |

**Acceptance:** both smokes reach new-password form. User submits. `auth.updateUser({password})` succeeds. Post-success role dispatch + `gateAccountState` checks fire correctly.

### Page 4 — `/reset-password-required` (B113)

Triggered by: admin sending invite via `/api/billing/bulk-invite` or `/api/admin/resend-invite`.

| Smoke | Browser combination | Expected | Result | Notes |
|---|---|---|---|---|
| Happy | Admin sends invite → user clicks in same browser as admin sent from | PKCE/hash auto-verifies → set-password form renders | TBD | |
| Cross-context | Admin sends invite → user clicks in different browser | 4s timeout → OTP card → paste token → verifyOtp(type:'invite') → set-password form | TBD | |

**Acceptance:** both smokes reach set-password form. User submits. `auth.updateUser({password})` + `set_must_change_password` RPC (clear flag) + signOut → /login. B113 forced-ToS modal fires on next /login (preserves bulk-invited-user consent capture flow).

**Caveat to confirm:** the existing code at [reset-password-required/page.tsx:56](../app/reset-password-required/page.tsx#L56) describes the invite link as hash-fragment. Modern Supabase clients default to PKCE. The happy-path smoke reveals which is live (look at the URL the user lands on — `?code=` = PKCE, `#access_token=` = hash). Either way the OTP path works.

## Cross-context smoke runbook (reusable for future B117-class regression checks)

This procedure can be re-run anytime to verify a verify-class page is cross-context-resilient. Applies to any page using `supabase.auth.verifyOtp` as the fallback mechanism.

1. **Prepare fresh email alias** — `alvaradolegacyconsulting+<page>-<scope>-<date>@gmail.com`. Lets you find/clean test data later.
2. **Open Browser A (Chrome incognito recommended).** Drive the email-trigger flow (sign up / forgot password / receive invite). Note: if testing locally, ensure `NEXT_PUBLIC_APP_URL=http://localhost:3000` is in `.env.local` so success_url targets local.
3. **Submit; do NOT click the email link from Browser A.** Wait for email to arrive.
4. **Open the email in Browser B (Firefox / Safari / any different browser).** Click the link.
5. **Expected:** 4s timeout fires (visible as a brief delay), OTP card renders. Email field pre-fills if template includes `&email={{ .Email }}`.
6. **Copy the 6-8 digit code** from the email body (NOT from the link URL).
7. **Paste into Verification code field.** Click "Verify and continue."
8. **Expected:** session mints; page transitions to the post-verify state (ReadyCard / activation form / new-password form / set-password form depending on page).
9. **Complete the post-verify flow** to confirm end-to-end works.
10. **Cleanup:** delete the auth user (Supabase Dashboard) + any DB rows created (companies/user_roles/tos_acceptances/etc.).

## Rollback procedure

Code rollback (independent of template):
- `git revert <commit-hash>` on the Phase 2 commit (3 file edits + 2 docs = 1 commit)

Template rollback (independent of code):
- Re-paste the backed-up template bodies in Supabase Dashboard → Auth → Email Templates. Jose has all 4 originals saved.

Allowlist rollback (cosmetic — leaving the additions is harmless):
- Remove `https://shieldmylot.com/reset-password-required` from redirect URLs
- Remove `http://localhost:3000/**` from redirect URLs

Code-only rollback STILL leaves the user with a working app: the pages just revert to PKCE-only behavior, and the cross-context failure mode reappears (status quo pre-Phase 2). Not a regression.

## Open questions / things to confirm during smokes

- (P4 caveat) `/reset-password-required`: PKCE vs hash-fragment — actual live behavior to be observed.
- Cross-browser email-client rendering: confirm `{{ .Token }}` code block is legible on Gmail web, Apple Mail, Outlook.
- Behavior when user pastes a STALE token (e.g., 25+ hours old) — should see verifyOtp error "Token has expired" or similar. Documented in error UX.
- Multiple OTP entries: if user fails verifyOtp 3+ times, does Supabase rate-limit? Worth noting if encountered.

## Process

- Smokes drive: Jose (browser interaction). Mateo synthesizes results into this doc.
- Code commit + push: AFTER all 8 smokes pass. Single commit covers 3 file edits + 2 docs.
- Bar-2 follow-ups: shared `OtpFallbackCard` extraction; cleanup of Phase 1 "HELD" rollout comments in `/signup/verify`.

# B2-8 — Signup-path server-side consent + role-less forward-path

**Filed:** 2026-07-16 (at Consent Commit 5)
**Priority:** Backlog — open before Bar-2 public signup flip
**Status:** Not started

## What the arc left open

The P1 consent hard-gate arc (Commits 1–4, 2026-07-16) shipped end-to-end enforcement for every EXISTING authenticated user with a `user_roles` row:

| Commit | Ship SHA | What it did |
|---|---|---|
| 1 | `255313f` | `accept_all_pending_consents` RPC — atomic role-conditional consent write, server-derived company_id, IF NOT EXISTS idempotency |
| 2 | `da981d5` | `/consent` route + `app/lib/consent-gate.ts` (`requiredDocsForRole`, `hasCurrentConsents`, `redirectByRole`) |
| 3a | `613b045` | `/company_admin/layout.tsx` server-side gate — ENFORCEMENT LIVE for CA portal |
| 3b | `1ca8940` | Propagate gate to `/manager`, `/driver`, `/resident`, `/admin`, `/admin_console` |
| 4 | `8c2fe3b` | Retire `/login` modal + `acceptTos` handler — single enforcement path |
| 5 | (in flight) | Drop `accept_tos` overloads; keep `accept_saas_agreement` (this doc explains why) |

**What the arc DID NOT close:** the signup-path consent + role-less-user forward path.

## The gap

Every portal-layout gate (Commits 3a/3b) and the `/consent` route (Commit 2) redirect authenticated-but-role-less users to `/login`:

```typescript
// e.g. app/company_admin/layout.tsx
if (roleErr || !roleRow?.role) {
  redirect('/login')
}
```

For **existing users** (Amanda, every A1 driver/resident/manager, every Test-LEGACY seed user) this is correct — they all have `user_roles` rows. The gate works.

For a **brand-new self-serve signup**, there's a mid-signup window where the user IS authenticated (Supabase auth signup created the session) but their `user_roles` row hasn't landed yet (typically populated by `redeem_proposal_code` or a signup-completion RPC AFTER Stripe checkout).

If such a mid-signup user reaches `/company_admin/*` or hits `/consent` directly:
- Layout gate → `redirect('/login')` → they re-authenticate → still no `user_roles` → bounce back
- Or `/consent` page → shows error "Could not load your account role" → dead-end

**Result:** dead-end loop for a brand-new signup. Not currently exposed because self-serve signup is behind `public_signup_open=false`, but this class blocks the Bar-2 public flip.

## The concrete instance — `accept_saas_agreement`

The signup-path uses [`app/api/signup/accept-saas/route.ts`](../../app/api/signup/accept-saas/route.ts) to write a `document_type='saas'` row into `tos_acceptances` after the user signs the SaaS gate on `/signup/verify` but BEFORE Stripe Checkout:

```typescript
const { error: rpcErr } = await supabase.rpc('accept_saas_agreement', {
  p_saas_version: SAAS_VERSION,
  p_reviewed_at:  reviewedAt,
  p_ip_address:   ipAddress,
  p_user_agent:   userAgent,
})
```

At that moment the user has NO `user_roles` row (company + role are created at Stripe checkout completion). `company_id` on the row is `NULL` — locked as acceptable per Jose 2026-07-07.

The `accept_all_pending_consents` RPC from Commit 1 CANNOT replace this call: its body RAISEs `'no user_roles row for authenticated caller'` if the role join misses (grep-verifiable at [migrations/20260716_accept_all_pending_consents.sql:105-110](../../migrations/20260716_accept_all_pending_consents.sql)).

**So `accept_saas_agreement` (4-arg) stays live for the signup path.** Commit 5's `accept_tos` drop DELIBERATELY does not touch `accept_saas_agreement` — a deferral breadcrumb is stamped into the SCHEMA_ audit row so the reasoning is discoverable to the next reader.

## Four options for closing B2-8 (pick one or combine)

### Option 1 — Order the signup flow so role write happens BEFORE the first portal reach

If `redeem_proposal_code` (or a self-serve equivalent) atomically writes `user_roles` + all initial consents in ONE transaction, the user always has a role by the time they hit `/company_admin`. Current `/signup/redeem/verify` may already do this for the proposal-code path — verify the sequence. Self-serve path (post-Stripe-checkout) may need re-ordering.

**Pros:** No new routes, no new state. Straightforward if the signup flow already has an atomic write path.
**Cons:** Requires the atomic write to always land BEFORE the portal reach. Any race condition (redirect happens before write commits) reopens the loop.

### Option 2 — Add a signup-in-progress escape route

If the gate sees no role, redirect to `/signup/verify` (or wherever the signup completion continues) instead of `/login`. Requires detecting "user is mid-signup" — e.g., session metadata flag (`user.user_metadata.signup_pending = true`), or a specific cookie set at signup, or a `pending_signup` boolean in a small server-side table.

**Pros:** Clean forward path — mid-signup users continue where they left off.
**Cons:** Requires wiring the "mid-signup" signal at signup time + reading it in the layout gate. Cross-layer coordination.

### Option 3 — Widen the role-check tolerance

Treat "no role yet" as a specific state (redirect to a designated "complete your setup" page) distinct from "role missing" (redirect to `/login`). Requires a routing decision + the completion page.

**Pros:** Explicit "setup incomplete" affordance for the user.
**Cons:** New page + routing + copy. Bigger surface than Option 2.

### Option 4 — Gate on role-existence with a specific fallback

Same as Option 2 mechanically but read a different signal: check for a `pending_signup` cookie/session flag set by the signup flow. Redirect to signup-completion instead of `/login` if flag present.

**Pros:** Minimal cookie/session change; layout gate can inspect it easily.
**Cons:** Cookie/session state adds another moving part; needs cleanup on signup completion.

## What to check when opening B2-8

- **Trace the exact signup flow end-to-end** — proposal-code path (`/signup/redeem/verify`) and self-serve path (`/signup/verify`). Document where `user_roles` gets populated in each.
- **Test the dead-end reproducibly:** create a mid-signup user (authenticated, role-less), try to reach `/company_admin`, `/consent`, and `/signup/verify` directly. What happens on each?
- **Decide the close-strategy** — pick from options 1-4 above (or combine). Report shape, get greenlight, ship.
- **Decide the fate of `accept_saas_agreement`:**
  - Absorb into a new signup-path atomic RPC (mirror `accept_all_pending_consents` shape for role-less callers), OR
  - Keep it as the signup-scoped consent-write path.

## Cross-references

- [`scripts/reset-consent.ts`](../../scripts/reset-consent.ts) (shipped `93085f0`) — one-command consent clear by email. Useful when validating a B2-8 fix (drop the user_roles row too for a mid-signup simulation).
- [`migrations/20260716_drop_accept_tos_overloads.sql`](../../migrations/20260716_drop_accept_tos_overloads.sql) — Commit 5b.1; its SCHEMA_ audit row carries the `accept_saas_agreement` deferral breadcrumb pointing at this doc.
- Claude project memory: `project_b28_signup_path_consent_forward_path` — the same content in the assistant's cross-session memory (this git-tracked doc is the durable version).

## Do NOT re-open Commits 1-5 for this

The arc as shipped is correct for the current user base (all existing users have roles). B2-8 is the correct place to address the signup gap — same author writing signup and completing the consent story end-to-end. Filed here so it doesn't get lost between now and Bar-2 public flip.

# Smoke Test User Procedure (standard, not fallback)

**Audience:** anyone running a smoke that needs a logged-in user.
**Created:** 2026-05-30 (filed alongside B117 promotion note).

---

## The rule

> **For any smoke needing a logged-in user, create + confirm the user via Supabase Dashboard directly. Do NOT rely on the live `/signup` flow + email verification.**

This is the **standard** smoke-setup step, not a fallback discovered mid-session. The live signup flow has two known reliability issues that compound:

- **B117 (PKCE cross-context)** — clicking the verification email link in a different browser than the one used to sign up fails to complete the session exchange. Recurs across smoke sessions.
- **Email-delivery flakiness** — verification emails occasionally don't arrive at all (separate from B117; under investigation, see `b66_9_smoke_b_email_non_delivery_finding.md`).

Together, these make `/signup` unreliable enough for testing that the working practice has become "route around it." Adopting the Dashboard path as the standard removes both from the critical path of all future smoke sessions.

---

## Procedure (30 seconds)

1. **Supabase Dashboard → Authentication → Users → Add user**
2. Email: `alvaradolegacyconsulting+smoke-<scope>-<role>@gmail.com` (the `+suffix` Gmail pattern lets you filter test emails out of your inbox later).
3. Set password directly (avoids needing to do password-reset).
4. **CHECK "Auto Confirm User"** — sets `email_confirmed_at=NOW()` immediately, so the user can sign in without clicking any verification link.
5. Click **Create user**. Done.

Optional: also create the matching `user_roles` row via Supabase SQL Editor:
```sql
INSERT INTO user_roles (email, role, company, property) VALUES
  ('alvaradolegacyconsulting+smoke-<scope>-<role>@gmail.com',
   '<company_admin|driver|manager|resident|leasing_agent>',
   '<company name>', ARRAY[]::text[]);
```

For B66.5.1/B66.5.2-style multi-role smokes, repeat for each role you need.

---

## When NOT to use this procedure

Two cases where you DO want the live signup flow:

- **You're testing the signup flow itself** (e.g., signup/verify/PKCE/email-delivery work). Then the friction IS the test.
- **You're validating an end-to-end customer journey for production-confidence reasons** — e.g., final pre-launch sanity. In that case, use the live flow once after all known reliability issues are resolved, and be prepared for it to be slow.

For everything else (B66.x billing, dunning, gating, portal behavior, etc.) — Dashboard path. No exceptions.

---

## Cleanup

After smoke completes:
```sql
DELETE FROM user_roles WHERE email = 'alvaradolegacyconsulting+smoke-<scope>-<role>@gmail.com';
```
Plus Supabase Dashboard → Users → delete the auth.users row. Or leave for next smoke session (the `+suffix` pattern makes filtering trivial).

For Stripe-touching smokes: also clean the Stripe customer/subscription per the relevant arc's cleanup notes (e.g., B66.5 cleanup procedure).

---

## Cross-references

- `b117_signup_pkce_cross_context_failure.md` — the original B117 finding (May 25)
- `b117_promotion_note_may30_2026.md` — P2 → P1-for-launch reasoning + the third-session-impacted evidence
- `b66_9_smoke_b_email_non_delivery_finding.md` — the separate email-delivery issue (don't merge with B117)
- `[[project-b66-5-commit-4-2-closure]]` — case study where smoke contamination was first surfaced; this procedure prevents recurrence

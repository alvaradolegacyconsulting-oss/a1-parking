# B117 Phase 2 — Email Template Bodies (Supabase Dashboard)

**Apply via:** Supabase Dashboard → Authentication → Email Templates → [template name] → Source view (HTML).

**Backups confirmed (Jose):** Confirm signup ✓, Reset Password ✓, Magic Link or OTP ✓ (no edit needed), Invite user ✓.

**Out of scope:** "Magic link or OTP" template. We don't use `signInWithOtp()` anywhere in the codebase. Don't touch it.

**OTP Expiration setting:** 86400s = 24 hours (confirmed Jose 2026-06-04). Link and code share the token; both expire together. Copy in all three templates reflects this.

**URL append pattern:** `{{ .ConfirmationURL }}&email={{ .Email }}`. PKCE ConfirmationURL ends with `?code=<flow_code>`, so `&` is correct.
**Visual check after applying:** trigger a test email and inspect the rendered button URL — confirm it shows `?code=XXX&email=YYY`. If `{{ .ConfirmationURL }}` ever lacks query params, flip the `&` to `?`.

---

## Template 1 — Confirm signup

**Used by:** `/signup/verify` (self-serve) + `/signup/redeem/verify` (proposal-code / A1's path). Both trigger via `auth.signUp()`.

```html
<table width="100%" cellpadding="0" cellspacing="0" style="background: #1E2761; padding: 24px;">
  <tr>
    <td align="center">
      <h1 style="color: #ffffff; font-family: Arial, sans-serif; font-size: 24px; margin: 0; font-weight: bold;">ShieldMyLot</h1>
      <p style="color: #C9A227; font-family: Arial, sans-serif; font-size: 13px; margin: 4px 0 0;">Texas parking enforcement</p>
    </td>
  </tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="background: #ffffff; padding: 32px 24px;">
  <tr>
    <td>
      <h2 style="color: #1E2761; font-family: Arial, sans-serif; font-size: 22px; margin: 0 0 16px;">Confirm your account</h2>

      <p style="color: #333; font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6;">
        Click the button to confirm — works best in the same browser you used to sign up:
      </p>

      <p style="margin: 24px 0;">
        <a href="{{ .ConfirmationURL }}&email={{ .Email }}"
           style="background: #C9A227; color: #1E2761; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-family: Arial, sans-serif; font-size: 15px; font-weight: bold; display: inline-block;">
          Confirm Account
        </a>
      </p>

      <p style="color: #333; font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; margin: 24px 0 12px;">
        <strong>On a different device than where you signed up?</strong> The button may not work across browsers. Instead, enter this code on the verification page:
      </p>

      <p style="text-align: center; margin: 16px 0;">
        <span style="font-family: 'Courier New', monospace; font-size: 28px; font-weight: bold; letter-spacing: 0.15em; background: #f3f3f3; color: #1E2761; padding: 16px 24px; border-radius: 8px; display: inline-block;">
          {{ .Token }}
        </span>
      </p>

      <p style="color: #666; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.6;">
        Both the link and the code expire in 24 hours. The verification page will show <strong>{{ .Email }}</strong> at the top — make sure it matches.
      </p>

      <p style="color: #999; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.6; margin: 24px 0 0;">
        Didn't sign up for ShieldMyLot? You can safely ignore this email — no account will be created without confirmation.
      </p>
    </td>
  </tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="background: #f9f9f9; padding: 20px 24px;">
  <tr>
    <td align="center">
      <p style="color: #666; font-family: Arial, sans-serif; font-size: 12px; margin: 0;">
        Questions? <a href="mailto:support@shieldmylot.com" style="color: #1E2761;">support@shieldmylot.com</a>
      </p>
      <p style="color: #999; font-family: Arial, sans-serif; font-size: 11px; margin: 8px 0 0;">
        Alvarado Legacy Consulting LLC d/b/a ShieldMyLot™ · Houston, TX
      </p>
    </td>
  </tr>
</table>
```

**Subject line:** keep existing (likely "Confirm your ShieldMyLot account" or similar).

---

## Template 2 — Reset Password

**Used by:** `/reset-password`. Triggered via `auth.resetPasswordForEmail()` from `/forgot-password`.

```html
<table width="100%" cellpadding="0" cellspacing="0" style="background: #1E2761; padding: 24px;">
  <tr>
    <td align="center">
      <h1 style="color: #ffffff; font-family: Arial, sans-serif; font-size: 24px; margin: 0; font-weight: bold;">ShieldMyLot</h1>
      <p style="color: #C9A227; font-family: Arial, sans-serif; font-size: 13px; margin: 4px 0 0;">Texas parking enforcement</p>
    </td>
  </tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="background: #ffffff; padding: 32px 24px;">
  <tr>
    <td>
      <h2 style="color: #1E2761; font-family: Arial, sans-serif; font-size: 22px; margin: 0 0 16px;">Reset your password</h2>

      <p style="color: #333; font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6;">
        Click the button to set a new password — works best in the same browser you used to request the reset:
      </p>

      <p style="margin: 24px 0;">
        <a href="{{ .ConfirmationURL }}&email={{ .Email }}"
           style="background: #C9A227; color: #1E2761; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-family: Arial, sans-serif; font-size: 15px; font-weight: bold; display: inline-block;">
          Set new password
        </a>
      </p>

      <p style="color: #333; font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; margin: 24px 0 12px;">
        <strong>On a different device than where you requested the reset?</strong> The button may not work across browsers. Instead, enter this code on the reset page:
      </p>

      <p style="text-align: center; margin: 16px 0;">
        <span style="font-family: 'Courier New', monospace; font-size: 28px; font-weight: bold; letter-spacing: 0.15em; background: #f3f3f3; color: #1E2761; padding: 16px 24px; border-radius: 8px; display: inline-block;">
          {{ .Token }}
        </span>
      </p>

      <p style="color: #666; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.6;">
        Both the link and the code expire in 24 hours. The reset page will show <strong>{{ .Email }}</strong> at the top — make sure it matches.
      </p>

      <p style="color: #999; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.6; margin: 24px 0 0;">
        Didn't request a password reset? You can safely ignore this email — your password won't change.
      </p>
    </td>
  </tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="background: #f9f9f9; padding: 20px 24px;">
  <tr>
    <td align="center">
      <p style="color: #666; font-family: Arial, sans-serif; font-size: 12px; margin: 0;">
        Questions? <a href="mailto:support@shieldmylot.com" style="color: #1E2761;">support@shieldmylot.com</a>
      </p>
      <p style="color: #999; font-family: Arial, sans-serif; font-size: 11px; margin: 8px 0 0;">
        Alvarado Legacy Consulting LLC d/b/a ShieldMyLot™ · Houston, TX
      </p>
    </td>
  </tr>
</table>
```

**Subject line:** keep existing (likely "Reset your ShieldMyLot password" or similar).

---

## Template 3 — Invite user

**Used by:** `/reset-password-required`. Triggered via `service.auth.admin.inviteUserByEmail()` from `/api/billing/bulk-invite` and `/api/admin/resend-invite`.

```html
<table width="100%" cellpadding="0" cellspacing="0" style="background: #1E2761; padding: 24px;">
  <tr>
    <td align="center">
      <h1 style="color: #ffffff; font-family: Arial, sans-serif; font-size: 24px; margin: 0; font-weight: bold;">ShieldMyLot</h1>
      <p style="color: #C9A227; font-family: Arial, sans-serif; font-size: 13px; margin: 4px 0 0;">Texas parking enforcement</p>
    </td>
  </tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="background: #ffffff; padding: 32px 24px;">
  <tr>
    <td>
      <h2 style="color: #1E2761; font-family: Arial, sans-serif; font-size: 22px; margin: 0 0 16px;">You've been invited to ShieldMyLot</h2>

      <p style="color: #333; font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6;">
        Your administrator has set up a ShieldMyLot account for <strong>{{ .Email }}</strong>. Click the button below to accept the invitation and set your password:
      </p>

      <p style="margin: 24px 0;">
        <a href="{{ .ConfirmationURL }}&email={{ .Email }}"
           style="background: #C9A227; color: #1E2761; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-family: Arial, sans-serif; font-size: 15px; font-weight: bold; display: inline-block;">
          Accept invitation
        </a>
      </p>

      <p style="color: #333; font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; margin: 24px 0 12px;">
        <strong>On a different device than where you'll be using ShieldMyLot?</strong> The button may not work across browsers. Instead, enter this code on the activation page:
      </p>

      <p style="text-align: center; margin: 16px 0;">
        <span style="font-family: 'Courier New', monospace; font-size: 28px; font-weight: bold; letter-spacing: 0.15em; background: #f3f3f3; color: #1E2761; padding: 16px 24px; border-radius: 8px; display: inline-block;">
          {{ .Token }}
        </span>
      </p>

      <p style="color: #666; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.6;">
        Both the link and the code expire in 24 hours. The activation page will show <strong>{{ .Email }}</strong> at the top — make sure it matches.
      </p>

      <p style="color: #999; font-family: Arial, sans-serif; font-size: 12px; line-height: 1.6; margin: 24px 0 0;">
        Not expecting an invitation? Contact your administrator, or reply to this email and we'll sort it out.
      </p>
    </td>
  </tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="background: #f9f9f9; padding: 20px 24px;">
  <tr>
    <td align="center">
      <p style="color: #666; font-family: Arial, sans-serif; font-size: 12px; margin: 0;">
        Questions? <a href="mailto:support@shieldmylot.com" style="color: #1E2761;">support@shieldmylot.com</a>
      </p>
      <p style="color: #999; font-family: Arial, sans-serif; font-size: 11px; margin: 8px 0 0;">
        Alvarado Legacy Consulting LLC d/b/a ShieldMyLot™ · Houston, TX
      </p>
    </td>
  </tr>
</table>
```

**Subject line:** keep existing (likely "You've been invited to ShieldMyLot" or similar).

---

## Apply discipline

1. **Save current template body** to a local backup file before pasting (you've already done this per Jose; just confirming standard rollback path).
2. **Paste new body** in Dashboard, save.
3. **Trigger a test email** for each template (signup via `/signup`, reset via `/forgot-password`, invite via `/api/billing/bulk-invite` or `/api/admin/resend-invite` with a +alias).
4. **Visual check** on the rendered email:
   - Button URL contains both `?code=` and `&email=` (or `?email=` if no code present — flip the `&` to `?` in template if so)
   - Code block displays the 6–8 digit token clearly
   - Brand chrome (#1E2761 header, #C9A227 button) renders correctly across Gmail/Outlook/Apple Mail
5. **Rollback if anything looks broken** — restore the backed-up template body, no code change needed (the OTP card on the verify pages gracefully shows even without `?email=` pre-fill; user just types email manually).

## Rollback (if needed)

- Templates: re-paste the saved bodies (you have all 4 backed up)
- Allowlist: revert added entries (`/reset-password-required` + `localhost:3000/**`) — though leaving them is harmless
- Code: per-file `git revert` of the 3 commits (signup/redeem/verify + reset-password + reset-password-required)

Code rollback is independent of template rollback — even if templates revert, the OTP cards still work (they just require manual email entry).

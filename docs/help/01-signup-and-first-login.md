---
title: "Signup and First Login"
category: "Getting Started"
audience: ["company_admin", "manager", "leasing_agent", "driver", "resident"]
tier_required: "any"
last_updated: "2026-09-04"
related: ["account-setup", "understanding-your-tier", "account-security"]
---

# Signup and First Login

This guide walks you through getting access to ShieldMyLot™ for the first time. Your exact path depends on your role — there are three ways someone gets access to the platform.

## Three ways to get access

**1. Self-serve signup (Company Admin, PM Starter or Enforcement-Only)**

If you're the owner or operations lead of a towing company or single-community property manager and you're setting up a new account yourself, sign up at:

**https://www.shieldmylot.com/signup**

You'll pick your plan (PM Starter or Enforcement-Only), verify your email, review and sign our SaaS Agreement, and pay through Stripe Checkout — all in one session, no phone call required. Full walkthrough below under [Self-serve signup — step by step](#self-serve-signup--step-by-step).

**2. Custom quote onboarding (proposal code)**

If your operation needs multi-property PM, combined PM + enforcement, or non-standard terms, we'll send you a proposal code after a short conversation. You'll redeem it at signup, which sets up your account with your negotiated configuration.

**3. Team invitation (Manager / Driver / Leasing Agent / Resident)**

If you work for a company that already uses ShieldMyLot, your company admin or a manager invited you. You'll receive an email with a temporary password and a link to log in. Your account is already provisioned — just sign in. Residents typically get a property QR code from their manager and register through a shorter flow; see [Resident Self-Registration](11-resident-self-registration.md).

---

## Self-serve signup — step by step

The full flow from landing page to signed-in dashboard:

1. **Pick your plan** at shieldmylot.com/signup. Three cards: **PM Starter** ($149/mo flat, one property), **Enforcement-Only** ($199/mo + $15/property, unlimited properties), or **Custom quote** (contact us for a proposal). PM Starter and Enforcement-Only continue directly; Custom quote routes to a contact form.
2. **Create your account.** Enter your email, set a password, confirm your company name. You'll pass a Turnstile check (a click-through anti-bot verification) and receive a verification email.
3. **Verify your email.** Click the link in the email (or enter the 6-8 digit token if the link doesn't open). You'll land back on the signup flow.
4. **Read and sign the SaaS Subscription Agreement.** Full text is presented in-line; you scroll through, then click Sign. The date and time of your acceptance is recorded.
5. **Review and pay.** You'll see your plan summary and estimated first invoice, then click Continue to Checkout — you're handed off to Stripe's hosted checkout page to enter payment details.
6. **Post-payment.** Stripe brings you back to ShieldMyLot with a "Payment received · Setting up your account…" screen. Account provisioning happens in the background and usually completes within a few seconds.
7. **You land in the Company Admin portal** at `/company_admin` once your account is ready.

### If setup takes longer than expected

Provisioning usually completes in under 10 seconds. If it takes more than 30, the setup screen shows a "Still processing" message with a **Refresh** button — click it once to re-check. Your payment has cleared and your account exists in our system; the delay is our billing platform catching up with our account platform.

If the Refresh doesn't work, use the **Contact support** link on that screen or email hello@shieldmylot.com. Your payment is safe and we can complete the setup manually.

---

## First login (for invited team members)

Once you have your email and temporary password from your invitation, log in at:

**https://www.shieldmylot.com/login**

Enter your email and the temporary password from your welcome email.

### Forced password change

On your first login, you'll be required to change your temporary password before you can access the rest of the platform. This is a security measure — temporary passwords are intended for one-time use only.

**Password requirements:**
- Minimum 8 characters
- Mix of letters and numbers recommended
- Avoid passwords used on other sites

After saving your new password, you'll be redirected to your role's home page.

---

## Where you land after login

Different roles see different home pages:

| Your role | Home page | What you'll see |
|---|---|---|
| Company Admin | `/company_admin` | Multi-tab portal with Overview, Manage, Plan, and more |
| Property Manager | `/manager` | Property-specific dashboard for your assigned location |
| Leasing Agent | `/manager` (read-mostly) | Same as manager, but limited to viewing and assisting |
| Driver | `/driver` | Plate lookup, violations history, and submission tools |
| Resident | `/resident` | Your vehicles, violations, visitor passes |
| Super Admin | `/admin` | Platform-wide controls (Alvarado Legacy Consulting only) |

If you land on a page that doesn't match what you expected, double-check that your role is correct. Contact your company admin or hello@shieldmylot.com if something looks off.

---

## What to do in your first 5 minutes

### If you're a Company Admin

1. **Verify your plan** — Click the **Plan** tab. Confirm your plan shows correctly: **PM Starter**, **Enforcement-Only**, or your Custom quote configuration.
2. **Review your usage** — On the Plan tab, see your active properties, drivers (Enforcement-Only), or approved permit count against your 500-permit allowance (PM Starter). Usage is what drives your bill; see [Understanding Your Tier](03-understanding-your-tier.md) for the pricing model.
3. **Set up your company profile** — Head to [Account Setup](02-account-setup.md) to complete logo upload, support contact, and other settings.

### If you're a Manager

1. **Check your assigned properties** — Your home page should show the property (or properties) you've been assigned to.
2. **Review existing residents and vehicles** — Use the Residents and Vehicles tabs to see who's currently registered.
3. **Note your role's scope** — Managers see only their assigned properties; you won't see other companies or properties you're not assigned to.

### If you're a Driver

1. **Try a plate lookup** — Enter a test plate to confirm the lookup works.
2. **Review the violation submission form** — Don't submit yet; just open the form to see what fields are required.
3. **Confirm your video and photo capture works** — Try opening the camera input on your phone browser to make sure it works in field conditions.

### If you're a Leasing Agent

1. **Browse the platform** — You have read-mostly access; explore the tabs to understand what's available.
2. **Note what you can and can't do** — You can help residents with registration questions but can't approve or modify resident records yourself.

---

## If first login fails

**"Invalid credentials" error**
Double-check the email address — make sure there are no extra spaces, and that you're using the exact email the invitation was sent to. If you're sure the email is right, the temporary password may have expired or been used already.

**"Account not found" error**
The invitation may not have been processed yet, or your account may have been deactivated. Contact your company admin or hello@shieldmylot.com.

**Stuck on the password change screen**
Make sure your new password meets the requirements (8+ characters). If the screen won't submit, try refreshing the page and entering the new password again.

**Forgot the temporary password**
Check your inbox (and spam folder) for the welcome email. If you can't find it, ask your company admin to re-send the invitation — they have an option in the admin portal to regenerate a temporary password.

**Verification email didn't arrive (self-serve signup)**
Check your spam folder. If the email doesn't arrive within a few minutes, use the "Resend verification email" option on the signup verify screen, or contact hello@shieldmylot.com.

---

## A note on multi-user accounts

ShieldMyLot is designed for multiple people in your organization to have their own accounts. You should never share login credentials with coworkers. If a colleague needs access:

- **For Company Admins**: Add them through the Manage tab in your portal.
- **For Managers**: Ask your company admin to provision them.
- **For Drivers**: Ask your company admin to add a driver account for them.

Sharing accounts breaks the audit trail (we won't know who took which action) and creates security risks.

---

## Next steps

- **Company Admins:** Continue to [Account Setup](02-account-setup.md)
- **Everyone else:** Find the doc that matches your role from the [Help Center index](/help)

If you run into anything not covered here, email hello@shieldmylot.com.

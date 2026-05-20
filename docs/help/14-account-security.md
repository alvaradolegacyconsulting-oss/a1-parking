---
title: "Account Security"
category: "Shared"
audience: ["company_admin", "manager", "leasing_agent", "driver", "resident"]
tier_required: "any"
last_updated: "2026-05-20"
related: ["signup-and-first-login", "support-and-contact"]
---

# Account Security

ShieldMyLot™ handles sensitive data — vehicle ownership, parking violations, evidence records, billing information. This guide covers the security practices that protect your account and your customers' data.

## Why this matters

Your ShieldMyLot account holds:
- License plates and registered vehicles (resident PII)
- Violation evidence (photos, videos, location data)
- Audit trails of every enforcement action
- Billing information

A compromised account could result in:
- Privacy violations affecting your residents or customers
- Disputed evidence being tampered with (which has legal implications under Texas Chapter 2308)
- Financial loss from fraudulent activity
- Liability for breached data

Treating account security as routine business hygiene — not optional convenience — is essential.

---

## Password requirements

ShieldMyLot requires passwords that meet basic security thresholds:

- **Minimum 8 characters**
- Mix of letters and numbers recommended
- Special characters allowed but not required
- No common-password blocklist enforcement currently

**Beyond the minimum requirements:**

- Use a password manager (1Password, Bitwarden, LastPass, etc.) to generate and store strong unique passwords
- Avoid passwords you use on other sites
- Avoid passwords based on easy-to-find personal information (birthdays, kids' names, business name)
- The strongest passwords are random — let a password manager generate them

A weak password is the single biggest vulnerability in most account compromises. The platform can't enforce strong passwords beyond minimum requirements — it relies on you to use good ones.

---

## Changing your password

You can change your password anytime:

1. Log in to your portal
2. Find the **Settings** or **Profile** menu
3. Click **Change Password**
4. Enter your current password and your new password twice
5. Save

After saving, you stay logged in on the current device. Other devices may require a fresh login.

### How often should you change passwords?

Industry best practice has shifted: **you don't need to change passwords on a schedule.** What matters more is:

- Use a strong password
- Change it immediately if you suspect compromise
- Don't reuse it on other sites
- Use a password manager

Forced periodic password changes typically lead to weaker passwords (people increment a number or pattern). Strong-and-stable is better than frequently-changed-and-weak.

---

## Forced password change on first login

When you log in for the first time with a temporary password (whether you're a new company admin, a newly-invited user, or a manager-created resident), you're required to change the password immediately. You can't access the rest of the platform until you do.

This forced change exists because:
- Temporary passwords are typically communicated through email or text, which are less secure channels
- The person who sent you the temporary password (your company admin or property manager) shouldn't have your permanent password
- It ensures your password is something only you know

Don't try to keep the temporary password — pick a new one and use it going forward.

---

## What to do if you forgot your password

Use the **Forgot Password** link on the login page:

1. Go to https://www.shieldmylot.com/login
2. Click **Forgot Password**
3. Enter your account email
4. Check your email for a password reset link
5. Follow the link to set a new password

The reset email comes from a ShieldMyLot system address. If you don't see it within a few minutes, check your spam folder.

**If you don't have access to the registered email:**
- For drivers / managers / leasing agents: contact your company admin
- For company admins: contact support@shieldmylot.com
- For residents: contact your property manager

We can verify your identity through alternative means and reset the password manually.

---

## What to do if you suspect account compromise

If you think someone else may have accessed your account:

### Immediate steps

1. **Change your password immediately**
2. **Check the audit trail** for any suspicious activity (see "Reviewing audit trails" below)
3. **Notify ShieldMyLot** at support@shieldmylot.com with details of what you observed
4. **Review your other accounts** that might share the same password (change those too if so)

### What ShieldMyLot will do

Once notified of suspected compromise, we'll:
- Help you secure your account
- Investigate access logs for unusual patterns
- Restore any modified data if possible
- Document the incident for compliance and legal records

Time matters. The faster you report a suspected compromise, the more we can do to limit damage.

---

## Reviewing audit trails

Every action on the platform is logged in an audit trail. Reviewing these logs helps you spot unusual activity.

### What's logged

- **Logins** — When, from what device or IP, success or failure
- **Data changes** — Who modified what record, when, and (where applicable) why
- **Plate lookups** — Which user looked up which plate
- **Violation actions** — Submission, confirmation, media changes
- **User management** — Account creation, deactivation, role changes
- **Billing actions** — Tier changes, invoice events
- **Authentication events** — Password changes, password reset requests

### Who can see audit logs

- **Company Admin** can see audit logs for their company's data
- **Managers** can see audit logs scoped to their assigned properties
- **Drivers** can see audit logs of their own actions
- **Residents** can see audit logs related to their own vehicles
- **ShieldMyLot Super Admin** has access for platform-level oversight

### Where to find them

Audit logs are accessible from the **Audit** tab in each portal (visibility scoped by role). For company admins, this is a top-level tab. For other roles, it may be nested under settings or your account profile.

### What to look for

When reviewing audit logs:
- **Unusual times** — Logins at 3 AM when no one should be working
- **Unfamiliar IPs or locations** — Logins from places no one in your company is
- **Unexpected changes** — Records modified by someone who shouldn't have access
- **Permission escalations** — Roles changed in ways you didn't authorize
- **Bulk activity** — Many records modified in a short time by one user

If anything looks off, dig deeper. The audit trail is the most reliable source of truth for what happened on your account.

---

## Multiple admins per company

Most companies have more than one person who needs admin access. Best practices:

**Do have:**
- 2-3 company admins minimum (so you're not locked out if one is unavailable)
- Each admin with their own account (no shared logins)
- Clearly assigned responsibilities (who handles billing, who handles operations, etc.)

**Don't do:**
- Share login credentials between people
- Use a generic "admin@company.com" account that multiple people access
- Give admin access to people who only need partial access (use manager or driver roles instead)

Sharing accounts breaks audit trails — you can't tell who did what when two people use the same login. This becomes a real problem during disputes, investigations, or compliance reviews.

---

## Role-based access in detail

The platform uses role-based access control (RBAC) to ensure users only see what they should:

| Role | Sees | Can change |
|---|---|---|
| **Super Admin** (ShieldMyLot only) | All companies | Everything |
| **Company Admin** | Their entire company | All company data, users, billing |
| **Manager** | Properties assigned to them | Property data, residents, violations at their properties |
| **Leasing Agent** | Same as Manager | Read-mostly; can help but not approve |
| **Driver** | Plate lookups, their own violations | Submit violations, manage their own media |
| **Resident** | Their own profile, vehicles, violations | Edit vehicle details, file disputes |

This isolation is enforced at the database level — it's not just UI hiding. A user can't access data outside their role's scope even through technical workarounds.

---

## Deactivating users vs deleting accounts

When someone leaves your company or property:

**Deactivate them** (correct approach):
- Account can no longer log in
- Audit trail remains intact
- Historical data stays linked to their name
- Account doesn't count against your tier user limits
- Can be reactivated if they return

**Don't delete accounts** unless explicitly required. Deletion creates orphan records and breaks audit trails. Deactivation is the right tool for the routine case.

For the rare case where deletion is required (e.g., a GDPR-style data subject deletion request, though this isn't currently a Texas legal requirement), contact support@shieldmylot.com to discuss the right approach.

---

## Browser and device security

The platform is web-based, so device security matters:

- **Use a recent browser** — Chrome, Safari, Firefox, Edge all work. Browsers older than 2 years may have unpatched vulnerabilities.
- **Keep your devices patched** — OS and browser updates close known security holes
- **Lock devices when unattended** — Especially important for shared computers in offices or trucks
- **Log out on shared devices** — Don't leave a session open on a borrowed device
- **Avoid public Wi-Fi for sensitive work** — If you must, use a VPN

The platform uses HTTPS encryption for all communication. Network-level snooping isn't a major risk for properly-configured connections.

---

## Two-factor authentication (future)

Two-factor authentication (2FA) — where login requires both your password and a temporary code from your phone — is not currently available on ShieldMyLot. It's planned for a future release.

When 2FA ships, you'll be able to enable it from your account settings. We recommend turning it on for company admin accounts especially, as they have the most access.

Until 2FA ships, password strength is your primary defense.

---

## Common questions

**Can someone steal my password by intercepting it?**
HTTPS encryption protects passwords in transit. The most likely password-theft scenarios are: phishing emails (someone tricks you into entering your password on a fake site), keyloggers (malware on your device), or reuse from another site that was breached.

**What happens if a former employee's account is compromised after they leave?**
If you properly deactivated their account on departure, they can't log in. If you didn't deactivate them, change their password immediately and deactivate.

**Can I see who's currently logged into our account?**
Active session tracking isn't currently exposed in the UI. Audit logs show login events, which is the closest equivalent.

**Is my data encrypted at rest?**
Yes. Data in the database and in cloud storage (photos, videos) is encrypted at rest.

**What if there's a breach at ShieldMyLot's infrastructure level?**
We'd notify affected customers per Texas data breach notification laws and applicable federal requirements. We'd also coordinate with you on remediation.

---

## Next steps

- **First login if you haven't yet:** [Signup and First Login](../getting-started/01-signup-and-first-login.md)
- **Get help if you've had a security incident:** [Support and Contact](15-support-and-contact.md)
- **Review who has access to your account:** [Account Setup](../getting-started/02-account-setup.md)

Security questions? Email support@shieldmylot.com.

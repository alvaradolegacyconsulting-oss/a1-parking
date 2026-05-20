---
title: "Understanding Your Tier"
category: "Getting Started"
audience: ["company_admin", "manager"]
tier_required: "any"
last_updated: "2026-05-20"
related: ["account-setup", "billing-and-tier-changes", "adding-properties"]
---

# Understanding Your Tier

Your tier determines what your ShieldMyLot™ account can do — how many properties, how many drivers, what features are available, and what limits apply. This guide explains how to read your Plan tab and decide whether your current tier fits your needs.

## What is a tier?

A tier is your subscription level. ShieldMyLot offers tiered pricing because customer needs vary enormously — a single-property towing company and a 50-property towing company have different requirements. Lower tiers cost less and have lower limits; higher tiers cost more and unlock more capacity and more features.

You're on one of these tiers:

### Enforcement track (towing companies)

| Tier | Designed for |
|---|---|
| **Starter** | Small operations, 1-5 properties, up to 3 drivers |
| **Growth** | Mid-size operations, 6-15 properties, growing team |
| **Legacy** | Established operations, unlimited properties and drivers, all features |

### Property Management track (PM firms)

| Tier | Designed for |
|---|---|
| **Essential** | Small portfolios, 1-3 properties, basic visitor pass management |
| **Professional** | Mid-size portfolios, 4-10 properties, higher visitor pass volume |
| **Enterprise** | Large portfolios, unlimited properties, all features |

---

## Reading the Plan tab

The **Plan** tab in your Company Admin portal shows everything about your subscription in one place.

You'll see four main sections:

### 1. Tier summary

At the top, your current tier name and track type. For example: "Enforcement · Legacy" or "Property Management · Professional."

If this doesn't match what you signed up for, contact support@shieldmylot.com immediately.

### 2. Hard limits (capacity)

These are numeric caps on resources you can create:

**For Enforcement:**
- **Properties** — Maximum active properties (Starter: 5, Growth: 15, Legacy: unlimited)
- **Drivers** — Maximum active driver accounts (Starter: 3, Growth: 10, Legacy: unlimited)
- **Photos per violation** — Maximum photos a driver can attach (Starter: 3, Growth: 10, Legacy: unlimited)
- **Video duration** — Maximum length of evidence video (Starter: 30s, Growth: 60s, Legacy: 120s)

**For Property Management:**
- **Properties** — Maximum active properties (Essential: 3, Professional: 10, Enterprise: unlimited)
- **Visitor passes per property per month** — Total passes any single property can issue in a calendar month (Essential: 50, Professional: 200, Enterprise: unlimited)
- **Maximum visitor pass duration** — How long a single pass can last (Essential: 12 hours, Professional: 24 hours, Enterprise: 48 hours)

Each limit displays current usage next to the cap, e.g., "Properties: 4 of 5" or "Drivers: 7 of 10."

### 3. Feature availability

Beyond the numeric limits, your tier determines which capabilities your account has access to. These aren't settings anyone turns on or off — they're included (or not) based entirely on your tier. If a capability is part of your tier, it's available to your whole company automatically. If it's not part of your tier, upgrading is the way to unlock it.

- **Advanced analytics** — Detailed reporting beyond basic violation counts (Growth+/Professional+)
- **Towbook CSV export** — Integration with Towbook fleet management software (Growth+)
- **API access (read-only)** — Programmatic access to your data for custom integrations (Legacy/Enterprise)
- **Leasing agent role** — Additional user role for read-mostly portal access (Growth+/Professional+)
- **AI-powered docs search** — Smart search across the help center that surfaces answers in context (Growth+/Professional+)
- **Premium video tutorial library** — Curated video walkthroughs of key workflows and best practices (Legacy/Enterprise)

On the Plan tab, each capability shows green/checked if your tier includes it, gray if it doesn't. Neither you nor your managers can toggle these individually — they follow your tier. To gain a capability that's currently gray, upgrade to a tier that includes it.

### 4. Custom arrangements (if applicable)

If your account has any custom pricing or limit arrangements with ShieldMyLot, those are reflected in the limits and features above — you'll see your actual effective limits, not the default tier limits.

If you have questions about custom arrangements, contact support@shieldmylot.com.

---

## What happens when you hit a limit

ShieldMyLot enforces limits in two ways:

### Hard stops (most limits)

When you try to create a resource beyond your limit, the **+ Add** button is replaced with an upgrade prompt.

You can't add the resource until you either:
- Deactivate an existing resource (frees up the slot)
- Upgrade your tier (raises the limit)

### Soft caps (some limits)

For limits where blocking would cause operational pain (e.g., a driver in the field needing to submit a violation):

- **Photo cap per violation** — Driver can take more photos than the cap; only the first N (per tier) are saved. The driver sees a notice.
- **Video duration** — Driver can record longer than the cap; only the first N seconds (per tier) are saved. The driver sees a notice.

Soft caps prevent operational interruption while still respecting the tier boundary.

---

## When to upgrade

Common signals that you've outgrown your current tier:

**You're approaching property limits**
If you have 13 of 15 properties on Growth, you're close to needing Legacy. Wait until you actually need #16, but plan ahead.

**Your drivers are hitting photo or video caps regularly**
If drivers report "the cap is too low for tough disputes," upgrading the tier gives them more headroom.

**You want analytics you can't currently access**
Growth (advanced analytics) gives substantially more visibility than Starter. If you're flying blind on operational metrics, upgrade.

**You want Towbook integration**
Available on Growth and above. If you're using Towbook today and importing tickets manually, the upgrade pays for itself quickly.

**You want AI-powered docs search**
Available on Growth and above. If your team spends time hunting through documentation for answers, smart search gets them to relevant information faster.

**You want premium video tutorials**
Available on Legacy and Enterprise. A curated video library covering workflows, best practices, and edge cases — useful for onboarding new staff or refreshing your team's knowledge.

---

## When to downgrade

Less common, but valid:

**You closed properties and your operations shrank**
If you're at 6 properties and using Growth (limit 15), downgrading to Starter could save money. But Starter's lower limits (3 drivers, 30s video, 3 photos per violation) may not work for you operationally.

**You don't use the higher-tier features**
If you're on Legacy but never use Towbook export or the video tutorial library, you may be over-paying.

**Important:** Downgrading isn't instant. If you currently have 10 properties and downgrade to Starter (limit 5), you don't automatically lose 5 properties — but you can't add any new ones until you deactivate down to 5. Plan downgrades carefully.

See [Billing and Tier Changes](../shared/13-billing-and-tier-changes.md) for the upgrade/downgrade process.

---

## What stays the same across tiers

Regardless of tier, every customer gets:

- **Full audit trails** — Every action is logged
- **Soft-delete with audit** for evidence (photos, videos) — Enforcement only
- **Texas Chapter 2308 compliance features** — Required regardless of tier
- **Customer data security** — Same encryption, same access controls
- **Dispute workflow** — Resident dispute filing and manager response
- **Mobile-friendly portals** — All roles can use their portal on phone, tablet, or computer
- **Support access** — Email support; response time varies by tier

Tier affects capacity and advanced features, never security or core functionality.

---

## What if I'm not sure which tier is right?

If you're a new customer trying to decide:

**Starter / Essential** — If you have 1-3 properties and a small team. Test the platform with minimal commitment.

**Growth / Professional** — If you have 4-10 properties or expect to grow. This is the "real business" tier with advanced analytics.

**Legacy / Enterprise** — If you have 10+ properties or want all features unlocked. The premium tier with the full video tutorial library and priority support.

Still unsure? Talk to us at support@shieldmylot.com. We'll look at your operational size and recommend a tier that fits without over-committing.

---

## Tier comparison at a glance

### Enforcement track

| Feature | Starter | Growth | Legacy |
|---|---|---|---|
| Active properties | 5 | 15 | Unlimited |
| Active drivers | 3 | 10 | Unlimited |
| Photos per violation | 3 | 10 | Unlimited |
| Video duration | 30s | 60s | 120s |
| Advanced analytics | — | ✓ | ✓ |
| Towbook CSV export | — | ✓ | ✓ |
| Leasing agent role | — | ✓ | ✓ |
| AI-powered docs search | — | ✓ | ✓ |
| Premium video tutorial library | — | — | ✓ |
| API access | — | — | ✓ |

### Property Management track

| Feature | Essential | Professional | Enterprise |
|---|---|---|---|
| Active properties | 3 | 10 | Unlimited |
| Visitor passes / property / month | 50 | 200 | Unlimited |
| Maximum pass duration | 12h | 24h | 48h |
| Advanced analytics | — | ✓ | ✓ |
| Leasing agent role | — | ✓ | ✓ |
| AI-powered docs search | — | ✓ | ✓ |
| Premium video tutorial library | — | — | ✓ |
| API access | — | — | ✓ |

For current pricing, see your service agreement or the pricing page at shieldmylot.com.

---

## Next steps

- **Set up the rest of your account:** [Account Setup](02-account-setup.md)
- **Add your first property:** [Adding Properties](../enforcement-track/04-adding-properties.md) (Enforcement) or [Property Management Overview](../property-management-track/08-property-management-overview.md) (PM)
- **Understand billing:** [Billing and Tier Changes](../shared/13-billing-and-tier-changes.md)

Questions? Email support@shieldmylot.com.

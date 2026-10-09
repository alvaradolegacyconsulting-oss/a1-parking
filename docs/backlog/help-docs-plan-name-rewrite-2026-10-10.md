# Help docs — old plan names, for Jose to rewrite

**Prepared:** 2026-10-10 · **Owner:** Jose (per ruling — I have not edited any of these)
**Scope:** `docs/help/*.md` + the Getting Started flyer source in `docs/`

---

## 🔴 Read this before treating it as a rename

**It isn't one.** A find-and-replace would leave these docs wrong in a worse way, because they describe a **two-plan world that no longer exists**.

Checked across all 17 help docs:

| | |
|---|---|
| mention `Operator Pro` | **0** |
| mention `PM Pro` | **0** |
| mention `Operator Starter` | **0** |
| mention the 21–50 free-property band | **0** |
| mention Elite | **0** |

What they *do* describe is `PM Starter` + `Enforcement-Only` + "Custom quote", at $149 and $199 + $15. So the rename is the small half; the missing half is **two entire plans, the property band, and Elite.**

(The count below is 65 lines, not the ~51 I reported earlier — I widened the pattern to catch bare `Legacy`, not just `Legacy plan` / `Legacy tier`.)

`03-understanding-your-tier.md` is the clearest case — its plan table has two rows, and there are now four plus Elite.

---

## The mapping, including the three that aren't 1:1

| In the docs | Becomes | Note |
|---|---|---|
| `Enforcement-Only` | **Operator Starter** | Clean 1:1. Same plan, same $199 + $15/property. Most of the 51 hits. |
| `PM-Only` | — | 🔴 **Not a self-serve plan any more.** Negotiated-only since the Aug 31 rewrite; `/signup` can't reach it. Don't rename it to PM Pro — describe it as a negotiated arrangement, or cut it. |
| `Legacy` | **Operator Pro** *or* **PM Pro** | 🔴 **Depends on the track.** `legacy` is the backend key for both: on enforcement it's Operator Pro ($299 + $20), on PM it's PM Pro ($249 + $15). Each occurrence needs reading, not substituting. |

New facts the docs don't yet carry:

- **Operator Pro** — $299/mo base + $20/mo per property
- **PM Pro** — $249/mo base + $15/mo per property
- **Properties 21–50 are free on every paid plan** (the per-property rate applies to the first 20 only; 50 is the ceiling, above which it's Elite)
- **Elite** — contact-sales, above 50 properties
- Annual is **×10**, i.e. ten months for twelve — already described correctly where it appears

Pricing to re-check while you're in there: `13-billing-and-tier-changes.md` carries worked examples at `$124/mo`, `$166/mo`, `$150 per property`, `$12.50` and `$1.25`. The $1.25 permit overage and the $149/$199 bases are still right; the derived annual equivalents should be re-derived once the Pro rows exist.

---

## Where it is, line by line


### `docs/help/00a-getting-started-company-admin.md` — 3 line(s)

- **L21** · _Enforcement-Only_
  ```
  3. **Add your property.** PM Starter customers get one property. Enforcement-Only customers can add as many as they need. Every property gets its own reserved-space pool, its own residents, its own visitor-pass rules. See [Adding Properties](/help/adding-properties).
  ```
- **L23** · _Enforcement-Only_
  ```
  5. **Confirm your billing plan.** Your plan (PM Starter, Enforcement-Only, or Custom quote) determines what drives your bill: PM Starter is $149/mo flat with 500 approved permits included; Enforcement-Only is $199/mo base + $15/mo per property; Custom quote follows your proposal. See [Billing and Ti
  ```
- **L27** · _Enforcement-Only_
  ```
  - Add and manage properties (Enforcement-Only) or manage your one property (PM Starter) · Assign PMs and leasing agents · Approve escalations · Track platform-wide activity · Handle billing and account settings
  ```

### `docs/help/01-signup-and-first-login.md` — 6 line(s)

- **L16** · _Enforcement-Only_
  ```
  **1. Self-serve signup (Company Admin, PM Starter or Enforcement-Only)**
  ```
- **L22** · _Enforcement-Only_
  ```
  You'll pick your plan (PM Starter or Enforcement-Only), verify your email, review and sign our SaaS Agreement, and pay through Stripe Checkout — all in one session, no phone call required. Full walkthrough below under [Self-serve signup — step by step](#self-serve-signup--step-by-step).
  ```
- **L38** · _Enforcement-Only_
  ```
  1. **Pick your plan** at shieldmylot.com/signup. Three cards: **PM Starter** ($149/mo flat, one property), **Enforcement-Only** ($199/mo + $15/property, unlimited properties), or **Custom quote** (contact us for a proposal). PM Starter and Enforcement-Only continue directly; Custom quote routes to a
  ```
- **L86** · _Legacy_
  ```
  | Super Admin | `/admin` | Platform-wide controls (Alvarado Legacy Consulting only) |
  ```
- **L96** · _Enforcement-Only_
  ```
  1. **Verify your plan** — Click the **Plan** tab. Confirm your plan shows correctly: **PM Starter**, **Enforcement-Only**, or your Custom quote configuration.
  ```
- **L97** · _Enforcement-Only_
  ```
  2. **Review your usage** — On the Plan tab, see your active properties, drivers (Enforcement-Only), or approved permit count against your 500-permit allowance (PM Starter). Usage is what drives your bill; see [Understanding Your Tier](03-understanding-your-tier.md) for the pricing model.
  ```

### `docs/help/02-account-setup.md` — 4 line(s)

- **L119** · _Enforcement-Only, Legacy_
  ```
  - **Driver** — Field enforcement. Submits violations, scans plates, generates tow tickets. Available on Enforcement-Only and Legacy configurations that include the enforcement track.
  ```
- **L130** · _Enforcement-Only, Legacy, PM-Only_
  ```
  - **Tier name** matches what you signed up for: **PM-Only**, **Enforcement-Only**, or **Legacy**
  ```
- **L131** · _Enforcement-Only, Legacy, PM-Only_
  ```
  - **Track surfaces** are correct (Enforcement-Only shows violations/tow tickets; PM-Only shows visitor passes / Spaces / guest authorizations; Legacy shows what your proposal-code specified)
  ```
- **L133** · _Enforcement-Only_
  ```
  - **Active driver count** (Enforcement-Only) matches your operational team size
  ```

### `docs/help/03-understanding-your-tier.md` — 10 line(s)

- **L21** · _Enforcement-Only_
  ```
  | **Enforcement-Only** | Towing and enforcement operators serving one or many properties: violation intake, tow tickets, plate lookup, driver management. Self-serve signup. |
  ```
- **L46** · _Enforcement-Only_
  ```
  ### Enforcement-Only
  ```
- **L67** · _Enforcement-Only_
  ```
  - PM Starter surfaces, Enforcement-Only surfaces, or both
  ```
- **L88** · _Enforcement-Only_
  ```
  ### Enforcement-Only
  ```
- **L100** · _Enforcement-Only_
  ```
  - **Adding a property (Enforcement-Only)** raises your bill by $15/mo, immediately reflected on your next invoice.
  ```
- **L112** · _Enforcement-Only_
  ```
  - **Enforcement-Only** — $1,990 per year plus $150 per property per year (equivalent to ~$166/mo base + ~$12.50/property)
  ```
- **L120** · _Enforcement-Only_
  ```
  **14-day money back on the first month** if PM Starter or Enforcement-Only isn't the right fit. Contact hello@shieldmylot.com within 14 days of your first charge.
  ```
- **L129** · _Enforcement-Only_
  ```
  - **No driver cap** on Enforcement-Only. Add as many drivers as your operation needs.
  ```
- **L141** · _Enforcement-Only_
  ```
  - (Enforcement-Only) Active driver count
  ```
- **L174** · _Enforcement-Only_
  ```
  - **Add your first property (Enforcement-Only) or confirm your single property (PM Starter):** [Adding Properties](04-adding-properties.md)
  ```

### `docs/help/04-adding-properties.md` — 3 line(s)

- **L48** · _Enforcement-Only_
  ```
  - **Enforcement-Only** — $15/month per property, added to your $199/month base. Applied to your next invoice automatically.
  ```
- **L63** · _Enforcement-Only_
  ```
  Enforcement-Only has no property cap; add as many as your operation needs.
  ```
- **L142** · _Enforcement-Only_
  ```
  **Enforcement-Only** does not cap the number of properties. Add as many as your operation needs — the $15/mo per-property rate applies to each (see [Billing and Tier Changes](13-billing-and-tier-changes.md)).
  ```

### `docs/help/05-provisioning-drivers.md` — 2 line(s)

- **L36** · _Enforcement-Only_
  ```
  **Enforcement-Only** does not cap the number of driver accounts, and there is no per-driver charge. Invite as many drivers as your operation needs.
  ```
- **L40** · _Legacy_
  ```
  **Legacy** accounts may have driver caps as part of their proposal-code configuration. Your Plan tab reflects any cap that applies.
  ```

### `docs/help/07-tow-tickets-and-evidence.md` — 1 line(s)

- **L158** · _Enforcement-Only, Legacy_
  ```
  This feature is available on Enforcement-Only accounts and on Legacy configurations that include the enforcement track. Property-management-only accounts do not have tow tickets and therefore do not have this export. Check your Plan tab for availability.
  ```

### `docs/help/08-property-management-overview.md` — 3 line(s)

- **L123** · _Legacy, PM-Only_
  ```
  PM firms sign up on **PM-Only** (self-serve) or **Legacy** (custom-negotiated for larger deployments or hybrid needs).
  ```
- **L125** · _PM-Only_
  ```
  **PM-Only** includes:
  ```
- **L134** · _Legacy_
  ```
  **Legacy** is for property management firms with custom requirements (proposal-code onboarded). Rates, limits, and included features are set at proposal-code issue time and reflected on your Plan tab.
  ```

### `docs/help/09-visitor-passes.md` — 4 line(s)

- **L71** · _PM-Only_
  ```
  Your Plan tab shows visitor pass usage per property for the current calendar month. Usage is tracked but not tier-capped on PM-Only — issue what your operation needs.
  ```
- **L75** · _Legacy_
  ```
  Legacy accounts may have negotiated per-property monthly caps as part of their proposal-code configuration. Your Plan tab reflects any caps that apply.
  ```
- **L81** · _PM-Only_
  ```
  - **PM-Only**: 24 hours per pass
  ```
- **L82** · _Legacy_
  ```
  - **Legacy**: whatever your proposal-code specified
  ```

### `docs/help/12-spaces-and-reserved-parking.md` — 4 line(s)

- **L14** · _Enforcement-Only, Legacy, PM-Only_
  ```
  Reserved spaces are a PM-Only and Legacy feature. Enforcement-Only accounts do not have reserved-space management (enforcement operators are running the tow-and-scan workflow, not managing on-site parking assignments).
  ```
- **L150** · _Legacy, PM-Only_
  ```
  No. Reserved-space management is included on PM-Only and Legacy at no additional cost.
  ```
- **L152** · _Enforcement-Only_
  ```
  **Can Enforcement-Only accounts use Spaces?**
  ```
- **L153** · _Enforcement-Only, Legacy_
  ```
  No. Enforcement-Only doesn't have the reserved-space feature. Legacy accounts that include the PM track do have it.
  ```

### `docs/help/13-billing-and-tier-changes.md` — 9 line(s)

- **L17** · _Enforcement-Only_
  ```
  - **Enforcement-Only** — Towing and enforcement operators. **$199/mo base + $15/mo per property.** No per-permit meter. No per-driver charge. Self-serve signup.
  ```
- **L28** · _Enforcement-Only_
  ```
  - **Base fee** covers what your plan does. For PM Starter, that's your single property plus the first 500 approved permits. For Enforcement-Only, that's the platform baseline.
  ```
- **L29** · _Enforcement-Only_
  ```
  - **Adding a property (Enforcement-Only)** raises your bill by $15/mo, immediately reflected on your next invoice. PM Starter is for one property — contact us to expand.
  ```
- **L59** · _Enforcement-Only_
  ```
  - **Enforcement-Only** — $1,990 per year plus $150 per property per year (equivalent to ~$166/mo base + ~$12.50/property)
  ```
- **L67** · _Enforcement-Only_
  ```
  **14-day money back on the first month** if PM Starter or Enforcement-Only isn't the right fit. Contact hello@shieldmylot.com within 14 days of your first charge.
  ```
- **L94** · _Enforcement-Only_
  ```
  - Any combination of PM and Enforcement-Only features
  ```
- **L106** · _Enforcement-Only_
  ```
  ### Between the two self-serve plans (PM Starter ↔ Enforcement-Only)
  ```
- **L176** · _Enforcement-Only_
  ```
  - **"Why is my invoice higher than last month?"** — For PM Starter: most commonly you crossed the 500-permit allowance and are now paying $1.25 per additional permit. For Enforcement-Only: you added a property (per-property line increased). Both show on the Billing tab under current-cycle usage.
  ```
- **L199** · _Enforcement-Only_
  ```
  **Do driver invitations cost anything (Enforcement-Only)?**
  ```

### `docs/help/15-support-and-contact.md` — 7 line(s)

- **L125** · _PM-Only_
  ```
  | **PM-Only** | Email support |
  ```
- **L126** · _Enforcement-Only_
  ```
  | **Enforcement-Only** | Email support |
  ```
- **L127** · _Legacy_
  ```
  | **Legacy** | Priority email support + dedicated escalation path |
  ```
- **L131** · _Legacy_
  ```
  **What "priority email support + dedicated escalation path" means (Legacy):** Faster first-response targeting during business hours and a specific escalation contact for production-blocking issues, detailed in your service agreement.
  ```
- **L211** · _Legacy_
  ```
  We don't build custom features for individual customers as part of standard support. Legacy customers may have access to more flexibility as part of their negotiated agreement — discuss specifics with us.
  ```
- **L224** · _Legacy_
  ```
  We don't publish a general support phone number — email is the contact channel for most situations. Legacy customers with a dedicated escalation path may have alternate contact details in their service agreement. This may change as we scale.
  ```
- **L227** · _Enforcement-Only, Legacy, PM-Only_
  ```
  For Legacy customers, scheduled video calls are part of the priority-support arrangement. For PM-Only and Enforcement-Only, we'll do our best via email. If you really need a call, mention it in your request and we'll see what we can arrange.
  ```

### `docs/help/16-approval-authority-grants.md` — 4 line(s)

- **L45** · _PM-Only_
  ```
  Approving a resident vehicle on PM-Only is the point at which billing counts a permit. The grant means the person approving is someone you (the company admin) trust to make that call.
  ```
- **L47** · _Enforcement-Only, Legacy_
  ```
  On Enforcement-Only and Legacy, approval doesn't affect billing but still commits a resident vehicle to your enforcement roster — the same trust logic applies.
  ```
- **L62** · _PM-Only_
  ```
  - **PM-Only** — mentions the billing impact ("this initiates billing at the graduated permit rate")
  ```
- **L63** · _Enforcement-Only, Legacy_
  ```
  - **Enforcement-Only / Legacy** — plain authorization copy
  ```

### `docs/GettingStarted_CompanyAdmin_flyer.html` — 5 line(s)

- **L191** · _Legacy_
  ```
  <div class="row">Review enforcement Activity <span>&mdash; tow tickets (Enforcement / Legacy)</span></div>
  ```
- **L192** · _Legacy_
  ```
  <div class="row">Manage storage partners <span>&mdash; (Enforcement / Legacy)</span></div>
  ```
- **L195** · _PM-Only_
  ```
  <div class="plan"><h4>PM-Only</h4><p>Properties, people, and property-management tools &#8212; residents, visitor passes, space management. No tow tickets.</p></div>
  ```
- **L196** · _Enforcement-Only_
  ```
  <div class="plan"><h4>Enforcement-Only</h4><p>Properties, people, storage partners, and enforcement Activity &#8212; violations and tow tickets.</p></div>
  ```
- **L197** · _Legacy_
  ```
  <div class="plan"><h4>Legacy</h4><p>Everything &#8212; full enforcement plus the complete property-management toolset.</p></div>
  ```


**Total: 65 lines across 14 files.**

---

## The flyers

`docs/GettingStarted_CompanyAdmin_flyer.html` — **5 hits**, and it is its own source. Verified: no script, no package.json step and no app route references `GettingStarted` anywhere, so nothing generates these from the markdown and nothing serves them. They are hand-maintained files you distribute directly, which means editing the markdown will **not** update them — they need their own pass.

The other three flyers — Driver, Manager, Resident — are **clean**: zero occurrences. Plan names don't appear in them at all, which makes sense since neither role sees billing.

---

## One thing that is already handled

`/help` is gated (commit `136bb46`) and that is a decision, not an omission — so none of this is publicly visible today. The exposure route is the **flyers**, which are distributed directly.

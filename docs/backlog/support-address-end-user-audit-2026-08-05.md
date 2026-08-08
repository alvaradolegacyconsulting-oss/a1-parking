# Backlog — `support@shieldmylot.com` end-user leaks (deferred)

**Filed:** 2026-08-05.
**Trigger event:** a real resident emailed `support@shieldmylot.com` today about a permit issue. Jose redirected to the property manager. Support is B2B; end users contact their property. This was that boundary being crossed in the wild.
**Deferred rationale (Mateo 2026-08-05):** most surfaces are gated today. Not worth its own commit at one email in three weeks. Fix rides along with anything touching the affected file, and the whole class re-opens if `/help` gating is reconsidered.

## Audit summary

Full inventory in the Aug 5 FOR MATEO relay. Highlights:

### The one live end-user leak

- [app/auth/accept/page.tsx:418](app/auth/accept/page.tsx#L418) — invite-expired branch. Button labeled "Contact your administrator" opens `mailto:support@shieldmylot.com`. Handles invites for ALL roles (CA, manager, leasing_agent, driver, resident) — so a resident invited by their manager whose invite expired clicks this and mails our support inbox. Likely today's leak path.
- **Fix ride-along:** cheap to fix whenever `auth/accept/page.tsx` is next touched. Replacement copy needs to route by role: subscribers → company_admin; end-users → property management office. Not standalone-commit-worthy.

### 13 docs/help hits (gated behind /help access)

| File | End-user audience per frontmatter | Hit count |
|---|---|---|
| `docs/help/07-tow-tickets-and-evidence.md` | driver | 1 |
| `docs/help/09-visitor-passes.md` | resident | 1 |
| `docs/help/14-account-security.md` | driver + resident | 4 |
| `docs/help/15-support-and-contact.md` | driver + resident | 7 |

**Currently not reachable by residents or drivers** because `/help` is gated. If `/help` gating is reconsidered (public help site, resident-portal Help link, driver documentation link) this whole class re-opens.

### Supabase Auth email templates — Jose manual check

Configured in Supabase Dashboard, not in repo. `docs/b117_phase_2_email_templates.md` L71, L140, L209 is our repo copy of what Jose applied in June. If the LIVE Invite/Reset/Confirm-signup templates still carry `support@shieldmylot.com`, every invited resident or driver receives it on their invite email — and every password-resetting non-subscriber receives it too.

Jose checks Dashboard. Fix path: rewrite Invite + Reset templates to point at "your property management office" or role-aware copy.

### Kept as-is (correct)

- All subscriber-facing signup/onboarding/account-cancelled/dunning surfaces
- `docs/GettingStarted_CompanyAdmin_flyer.html` + `public/help-flyers/getting-started-company-admin.html`
- CA-audience docs (`02-account-setup`, `10-resident-management`, `16-approval-authority-grants`)
- `docs/proposal-pdf-workflow.md`
- `README.md`
- Migration-file historical/assertion hits (retired tier gates + VQ.SUPPORT_ADDRESS_ZERO — these are correctly asserting the ABSENCE of the string from function bodies)

## Reassuring finding

**Neither the resident nor the driver getting-started flyer contains the support address.** Printed material — hardest to recall once distributed — is clean. Only the CA flyer carries it (correctly). Someone was careful.

## Trigger conditions for re-opening this backlog

Any of:
1. `/help` gating is reconsidered (i.e., `/help` becomes reachable by residents or drivers)
2. Jose reports live Supabase Auth Invite/Reset templates still carry `support@shieldmylot.com`
3. A second real-world end-user email to support (indicates the leak is recurring, worth its own commit)
4. `app/auth/accept/page.tsx` is next touched for any reason (ride-along fix)

## 🔴 ADDENDUM 2026-08-08 — audit was scoped too narrowly

Jose's `/deactivated` screenshot during the §1 probe shows:

> *"If you need help reaching your CA, contact **hello@shieldmylot.com**."*

That is a **fourth** support address, on an end-user-facing surface, that this audit missed. The Aug 5 sweep grepped for `support@shieldmylot.com` only. Any address on `@shieldmylot.com` that isn't a subscriber inbox is the same class of leak; the negative result of the audit was scoped to one string, not the problem.

### Follow-on tasks

- **Re-run the audit** against `@shieldmylot.com` (not just `support@`). Enumerate every distinct local-part on `@shieldmylot.com` that appears in `app/`, `docs/help/`, `public/`, Supabase email-template docs, and the JSX-rendered surfaces.
- **Confirm / fix `/deactivated`** — the file is `app/deactivated/page.tsx` (or wherever the copy lives; grep `hello@shieldmylot`). End-user surface: reached by residents/drivers whose accounts were deactivated. Same fix shape as the audit's Item 1 (invite-expired branch) — route by role, not to a shared inbox.
- **The general discipline:** an audit answers what it queries. When the queried string is *"support@..."* and the class is *"end-user-facing shieldmylot.com address"*, a negative result on the first is not a negative result on the second. Widen queries to the class boundary, not the first known instance.

Discovered during the toggleDriverActive probe pass — see `docs/backlog/ca-msgbox-severity-derived-from-text.md`'s SECOND ESCALATION block for the surrounding arc.

## Replacement copy sketch (when built)

- **Generic:** "Please contact your property management office."
- **Per-property (v1.1):** name `pm_email`/`pm_phone` if populated. **Requires A1 confirmation** — those fields were entered as internal admin contacts, not addresses meant for residents. Sugarberry's is a personal Gmail per Jose 2026-08-05 fill-rate check. Do NOT build per-property naming into templates without explicit consent per property.

## Adjacent

- [feedback_platform_states_facts_not_permissions](../../.claude/projects/-Users-ALC-a1-parking/memory/feedback_platform_states_facts_not_permissions.md) — related standing rule
- 2026-08-03 tier-gate retirement (`1d45c02`) — first pass that scrubbed support-address from `RAISE` strings. This backlog picks up the class in end-user-facing surfaces.

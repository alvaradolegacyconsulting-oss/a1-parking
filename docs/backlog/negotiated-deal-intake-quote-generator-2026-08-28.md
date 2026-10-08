# BACKLOG — Negotiated-deal intake form + quote generator

**Filed:** 2026-08-28
**Author:** Mateo
**Status:** Unblocked. All three July 20 open items answered by today's pricing decisions.
**Updates:** `DECISION_intake_form_and_quote_generator_july20_2026.md` (off-repo, project knowledge).
**Not A1-affecting.** A1's code is already issued and catalog-independent.

---

## 1 — What changed since July 20

**Scope widened.** July 20 recorded *"only Legacy routes through the form."* Today's decision moves **multi-property PM** to negotiated as well. The form now serves two buyers with different shapes:

- a **towing operator** wanting both tracks → Legacy, $299 + $20/property
- a **PM firm with 2+ properties** → multi-property PM, $249 + $15/property

**Pricing inputs collapsed.** July 20 assumed a metered quote needing permits, units and monthly vehicle volume. Neither negotiated tier meters anything now. The quote is **base + per-property**, so the only price-determining inputs are **track** and **property count**.

Everything else on the form is qualification and fit — still worth collecting, but it doesn't compute anything.

**Round-up rule survives, simplified.** Compute metered, compare to $599 (break-even at 15 properties) or $699 (at 20). If metered lands within ~$50 **and** the growth field signals expansion, propose unlimited instead.

🔴 **Open: do we need both $599 and $699?** Two unlimited price points now have a rule, but nothing today required the second one. One price point is simpler to build and simpler to sell. Mateo recommends dropping $699 unless there's a reason to keep it.

---

## 2 — One form, not two

The prospect cannot classify themselves into our tier names, and asking them to is how a form loses people.

**First question is about them, not us:** *"Which describes your business?"* — a towing or enforcement operator, or a company that manages properties. Branch the field set from there. The tier is derived, never selected.

### Fields that drive the quote

- Track (derived from the branch above)
- Number of properties — **the only numeric input that changes the price**
- Growth trend — the input to the round-up rule. July 20 already captured this; no new field needed.

### Fields that qualify, not price

- Company name, contact, email, phone
- 🔴 **Texas confirmation.** We are Texas-only. Catching that on the form saves a call.
- Rough unit or permit scale — doesn't price anything today, but it's what tells you whether a "one property" prospect is a 40-home HOA or a 900-unit complex, which changes how you'd quote
- Timeline
- **Dropped, per July 20:** current setup. Too invasive for initial intake.

---

## 3 — Where it lands

**Decided July 20, unchanged:** a `leads` table **and** an email alert. Email alone loses the data and feeds nothing; the table is what the generator reads and what the console Leads view is later built on.

Two additions:

**🔴 Turnstile on the public form.** It's a public unauthenticated POST that writes a row and sends mail — a spam target. Turnstile is already wired for the signup path, so reuse it rather than inventing anti-abuse for this surface. Related: B213 flagged CAPTCHA gaps on auth surfaces; don't create a new one here.

**Link the lead to the code.** A `lead_id` on `proposal_codes` so an issued code traces back to the intake that produced it. Cheap now, and it's the only way to ever answer "what did we quote versus what did they sign."

---

## 4 — The generator prefills, and that fixes a live defect

The generator's job is to draft a proposal-code form with the anchor values already populated — $299/$20 or $249/$15 — for you to review and adjust before sending.

**This closes July 11 Defect 2 as a side effect.** Today a Legacy code with a blank custom-fee field is *structurally unbuildable*: Legacy has no `platform_settings` fallback by design, so blank resolves to a column that doesn't exist. The current operator rule is "never leave a field blank on Legacy," which is a rule a human has to remember at the exact moment they're thinking about a deal instead.

Prefilling makes blank impossible rather than merely discouraged. Better than the validation fix proposed in July, and it comes free with the generator.

**Still worth doing separately:** Defect 1 from that backlog, the useless error message. Prefill prevents the common path; the message covers every other one.

---

## 5 — UI changes required

**Public site**

- Published prices for **PM Starter** and **Enforcement-Only** only
- "Request a quote" route for everything else. Wording should not name internal tiers — a prospect doesn't know what Legacy means, and shouldn't.
- No price, range, or "starting at" figure anywhere near the negotiated path. A published anchor gets compared by prospects it wasn't meant for.

**`/signup` tier-picker** (already on the Bar-2 critical path)

- Two selectable tiers, per today's decision
- A third, non-selectable route to the quote form

🔴 **One property is a server-side limit on Starter, not a hidden button** — but today it isn't. Code investigation 2026-08-28 (Claude):

- Client-side enforcement EXISTS at [app/company_admin/page.tsx:1490](app/company_admin/page.tsx#L1490), [:1764](app/company_admin/page.tsx#L1764), [:5989](app/company_admin/page.tsx#L5989), [:6433](app/company_admin/page.tsx#L6433), [:8451](app/company_admin/page.tsx#L8451) via `isUnderLimit(FEATURE_FLAGS.MAX_PROPERTIES, count, ctx)` before every add-property path.
- **Server side: nothing.** No SQL trigger, no RLS clause, no DEFINER RPC gate on `MAX_PROPERTIES`. Grep of `migrations/*.sql` for `max_properties` returns only comment-only references from `20260528_b82_public_grant_retrofit_phase_2.sql` and similar (no functional enforcement).
- Proposal-code `feature_overrides` JSONB flows through the same client-side helper (`hasFeature`/`isUnderLimit` at `app/lib/tier.ts:91-140`). The override reaches the same client-only gate.

So the flag exists, is read for display, is enforced by the CA portal's own add-property paths, and is trivially bypassable by any actor calling the write path directly (raw REST insert with service-role key, or a bug in a future writer). Not a Starter-specific problem — the whole `MAX_PROPERTIES` flag lacks server-side teeth.

Server-side enforcement is a separate backlog item that this decision brings to the surface. Cheapest shape: a `BEFORE INSERT` trigger on `public.properties` that counts the tenant's active properties and rejects if over-limit. Not in scope for this filing; flag for its own preflight.

**Super-admin**

- Leads list — new submissions, status, link to generated draft
- "Generate quote" from a lead → prefilled proposal-code form
- Per the July 12 board, Leads and mini-ITSM share a console surface. Build together.

---

## 6 — Open questions

| Question | Notes |
|---|---|
| Keep $699, or one unlimited price? | Mateo recommends one |
| Public form or authenticated? | Public means Turnstile and spam handling. Almost certainly still public. |
| Does the generator draft prose, or just numbers? | July 20 called the generator "the real value build." A prefilled form is most of the value at a fraction of the cost. Worth splitting. |
| Lead status vocabulary | new / quoted / sent / won / lost, or fewer |

---

## 7 — Sequencing

This is **not** on the Bar-2 critical path, except for the tier-picker's third route, which is one link.

The rest — leads table, form, generator, console view — can follow public signup. But the **first non-A1 negotiated deal** needs it, and that deal is what removes Mateo as the bottleneck. So it's near-term growth work rather than launch work.

**One thing that should happen BEFORE any negotiated deal, independent of this build:** 🔴 **dry-run a test proposal code with a non-zero per-property fee.** A1's was $0, so the `$0-override omit` rule dropped the line and that path has never run live. Every future code produces two line items through code that has never executed against Stripe. Test-LEGACY.

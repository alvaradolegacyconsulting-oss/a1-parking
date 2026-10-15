# BACKLOG: Security Sweep #2, a systematic one replacing one-off discovery
**Filed Oct 14, 2026 · Owner: Jose (go/no-go), Architect (plan), Mateo (execution)**
**Timing:** after Phase B bulk onboarding + the deactivation/helper fixes land, and **before** the SWTOW / HAA marketing push scales the customer count.

## Why
In one day (Oct 14) feature work for A1 surfaced six security defects that a frozen codebase would have kept live:
- vehicle activation bypass;
- the storage allow-all upload policy;
- create-user account takeover on records with no auth;
- deactivation that revokes nothing;
- unpinned definer helpers ignoring `is_active`;
- a `/register` guard that can't fire for anon.

None were found by looking for them. They were found because a change touched them. The September sweep was valuable, but it was a point in time. The goal now is to **sweep by defect class** and **turn each class into a standing check** that fails automatically if it comes back.

## Defect classes seen so far (the sweep's checklist)
| # | Class | Example found | Standing check to build |
|---|---|---|---|
| 1 | **Catalog drift**: policies or grants created in the dashboard, not in migrations | storage "allow all uploads" | Nightly/CI capture: every policy + grant in prod vs migrations; fail on anything unexplained |
| 2 | **Bucket- or table-agnostic policies** | the allow-all named no bucket | Fail if any `storage.objects` policy lacks a `bucket_id` predicate |
| 3 | **Anon write surface** | `anon=arwd` on storage.objects | Fail on any anon INSERT/UPDATE/DELETE grant + permissive policy pair |
| 4 | **SECURITY DEFINER hygiene**: unpinned `search_path`, PUBLIC/anon EXECUTE | `get_my_role` unpinned; G5 PUBLIC grants | Fail on any definer function with unpinned search_path or PUBLIC/anon EXECUTE (allowlist exceptions) |
| 5 | **Identity assumptions**: records without auth users, `is_active` ignored | create-user takeover; deactivated manager still "manager" | Role × state matrix test (below) includes deactivated, banned, records-only |
| 6 | **Direct client writes that should be authority-checked** | vehicles activation via PATCH | Writer sweep per sensitive column; guard triggers + positive controls |
| 7 | **Render-side-only gating**: server routes trusting the UI | track gating; flag checks | Route audit: every `app/api/*` route lists its auth check, role, and company scoping |
| 8 | **Best-effort side effects reported as success** | ban "applied" when it failed | Grep + review: every external/admin call's failure must surface as failure |
| 9 | **Absence read as refusal**: discarded errors, null checks | `/register` guard on `null`; MIME read as RLS | Code review rule plus a lint for ignored `{ error }` on reads used in guards |
| 10 | **Edge functions / service-role routes** | `swift-handler` lookup bug | Inventory every service-role use; each must re-implement the caller's authority (mirror RLS) |
| 11 | **`LIMIT 1` with no `ORDER BY` on a table assumed unique** | `get_my_role` / `get_my_company` / `get_my_properties` | UNIQUE index where uniqueness is assumed; fail on helper `LIMIT 1` without a deterministic order. 🔴 Note 2026-10-15: `user_roles` ALREADY has `user_roles_lower_email_uidx (lower(email))` from 2026-07-04 — found by trying to violate it (23505). So for this table the class is about surviving the index being dropped, not a live ambiguity |
| 12 | **Token valid after revocation** (access token lives up to 60 min after ban + `is_active=false`) | deactivation probe | Gate asserts a revoked user's *existing* token is refused on the next query (after the helper `is_active` change) |
| 13 | **ILIKE with unescaped input**: `_` is a LIKE wildcard, common in real emails | `guardEmail` blocks `%` and `\` but not `_` | Lint/grep: every ILIKE on user input escapes `_ % \`, or uses `lower()=lower()` equality |
| 14 | **One identity carrying two roles** (staff and resident on one email) | amandacanchol | ~~UNIQUE (email) on `user_roles`~~ — already enforced since 2026-07-04. The live gap is the *sequence*: one address held a manager role and later a resident record, and no layer objected. Invite and register paths must refuse an address that already holds a different role |
| 15 | **Bulk operations whose reverse restores more than the forward took** | property cascade reactivation restores unrelated deactivations | Cascades stamp what they changed; reverses act only on their own stamps |
| 7b | **A render that MISREPORTS a control's state** (class 7 from the other side: not a render trusted as a control, but a render lying about one) | `PhysicalPassSwitches` seeded `useState` from props and was mounted without a `key` in the CA Properties panel *and* the manager portal; after viewing a tags-on property every property read ON, while the database said 1 of 28 | `verify:remountkeys` — every component that seeds `useState` from a prop, mounted where the subject changes in place, must pass a `key`; exemptions must state why. 🔴 Static: the real check (click A with the switch on, then B with it off, assert B renders B's own values) is a re-render on a retained instance and needs jsdom or Playwright, neither of which is installed |
| 17 | **A column-level REVOKE beneath a table-level grant is a NO-OP** — and `attacl IS NULL` means *writable*, not *not granted* | attempted on `user_roles`' cascade-provenance columns 2026-10-15; `authenticated` holds UPDATE on the table, so the REVOKE recorded nothing and the columns stayed open. Piece 0's header also *claimed* such a REVOKE as its "second layer" while containing no column REVOKE at all — the real control was always its trigger | 🔴 **No security claim may rest on a column REVOKE.** Grep for `REVOKE … (col)`; for each, fail unless the table-level grant has been removed first. And fail any gate that reads `attacl IS NULL` as "not granted" — it must read it as "inherits the table grant" |
| 16 | **Same operation from two portals, only the dialog shared** | `/admin` deactivating a property cascades (bans users, deactivates residents + vehicles); the CA's `togglePropertyActive` flips `properties.is_active` and nothing else — while both showed the SAME confirm dialog promising "this will suspend account access for 31 residents" | for each operation reachable from more than one portal, assert the two produce the same **end state** on canaries — not merely that they call the same helper |

*Classes 11–15 were added Oct 14 from Mateo's `security-sweep-2-candidate-classes.md`. Classes 16 and 17 accepted Oct 15; 7b added the same day.*

## The sweep, in phases
1. **Inventory (≈1 d):** one capture of all policies, grants, functions (definer, search_path, EXECUTE), storage policies, buckets, API routes with their auth, edge functions, and service-role call sites.
2. **Role × table execution matrix (≈2 d):** for each role (admin, CA, manager with/without approval flag, leasing_agent, driver, resident, **deactivated**, **banned**, **records-only/no-auth**, anon) × each sensitive table × read/insert/update/delete, compare actual against an expected matrix. **Run by execution with real sessions on canaries, never on A1.** Commit this as a re-runnable gate (`verify:rolematrix`).
3. **Route audit (≈1 d):** every `app/api/*` route: who may call it, what it scopes by, whether it trusts client input for identity/company, rate limits, captcha.
4. **Turn findings into standing gates (≈1 d):** classes 1–4 become a single `verify:securitybaseline` run on every deploy (and nightly), failing on drift.
   - **Render-test toolchain** (Playwright preferred, accepted Oct 15): it also automates Jose's five-portal smoke test, and it is what class 7b needs — click property A with a switch on, then property B with it off, and assert B renders B's own values. A static gate (`verify:remountkeys`) covers the cause until then.
   - 🔴 **Two accepted coverage gaps to close here, both needing fault injection confined to the harness.** No seam goes in production code (ruled Oct 15).
     1. **The ban-failure revert** in `setUserActive` — it bans first, reads the ban back, and restores the prior ban state if the `is_active` flip then fails. Covered by reading only: a duplicate `user_roles` row is rejected by `user_roles_lower_email_uidx`, the cascade re-plans at apply time so a pre-mutated row just yields a different plan, and deleting the auth user lands on the `no_auth_user` SUCCESS branch. `verify:cascade` control 6 asserts the verdict fields are computed, not the revert.
     2. **A mid-list cascade failure** — that earlier users stay done, later users still process, `ok` is false and the failed set lands in `retry`. Same cause: no user failure is reachable from outside the request.
5. **Optional, recommended before larger PM-firm sales:** an external penetration test. Enterprise prospects (e.g., the Greystar RFP) will ask, and an outside report is a sales asset.

**Estimate:** ≈5 days for phases 1–4. Phase 5 is external and scheduled separately.

## Process rules already adopted (keep)
- 🔴 **Gate assertions come from the code path, never from dialog or doc wording.** (Binding, 2026-10-15.) `verify:cascade` control 9 asserted "reactivation does NOT restore residents or vehicles" and **passed** — read off the *deactivate* dialog's accurate but narrow line about space **assignments**, with the reactivate branch never opened. A gate was therefore defending a regression, and a wrong assertion that passes outlives the conversation that produced it. The same error recurred within the hour on the same gate: 9e asserted a declined vehicle appears in the RPC's `skipped` list because the migration says it "reports anything it skipped" — the loop selects only `is_active=false AND status='active'` as candidates, so a declined row is never a candidate and never reported. Open the loop, the policy, the trigger body. Prose describes intent; only the code describes behaviour.
- A guard's positive controls come from a **full writer sweep done before** the guard is applied.
- Verification must **execute**, not just read `prosrc`. Every negative check needs a positive control so that "refused" can't be a misread error.
- Canary first; never prove a hole by exploiting a real customer account.
- Report-first for anything touching auth, RLS helpers, or storage.

---

## Execution note added 2026-10-15 (Mateo)

🔴 **Phase 2's matrix already has a recorded BEFORE picture for the
role × `is_active` axis**, and it is worse than class 5's example
suggests. `docs/backlog/identity-helpers-baseline.json`, captured with
real sessions on canaries before the step-3 migration:

| deactivated role | still read |
|---|---|
| admin | 423 residents · 852 vehicles · 2,079 visitor passes |
| company_admin | 32 residents · 61 passes |
| manager / leasing_agent | 31 residents · 58 passes |
| driver | 32 vehicles · 61 passes |
| resident | their own record |

Every deactivated role read **exactly** what its active counterpart
read. So "deactivation revokes nothing" was not a manager-specific
defect; it was every role, and `verify:identityhelpers` is the first
slice of `verify:rolematrix` with its baseline already in hand.

**Step 3 applied 2026-10-15. The after picture, same canaries:**

| deactivated role | before → after |
|---|---|
| admin | residents 423→0 · vehicles 852→0 · properties 28→0 · user_roles 388→**1** · passes 2079→0 · violations 134→0 |
| company_admin | residents 32→0 · vehicles 32→0 · properties 11→0 · user_roles 34→**1** · passes 61→0 |
| manager / leasing_agent | residents 31→0 · vehicles 31→0 · properties 1→0 · passes 58→0 |
| driver | vehicles 32→0 · properties 11→0 · passes 61→0 · violations 26→0 |

All six **active** roles: byte-identical, on all six tables.

🔴 **`user_roles` goes to 1, not 0, and that is required.** A
deactivated user must still read their OWN row or `/deactivated` cannot
tell them what happened — they get a login loop instead of an
explanation. The gate's first version asserted "reads nothing it read
before", which failed this correct outcome *and* would have passed a
regression where the self-row became unreadable, since 0 satisfies
"reads nothing". It now asserts both directions: no tenant data above a
declared self-allowance, and the self-row survives.

**Class 15 is now ruled** (2026-10-15): the cascade stamps every user
it deactivates with the property id and a cascade id, in the audit and
in a field reactivation can read; reactivation acts only on its own
stamps; pre-existing deactivations of unknown provenance are skipped
and listed as *"deactivated separately; reactivate individually if
intended."*

**Class 16 is in the table above** (accepted Oct 15). The confirm
helper was deliberately shared "to close the divergent-paths bypass",
but it shared the *warning* and not the *work* — which is worse than
not sharing it, because it made a confident, specific, wrong statement
about a destructive action.

**Interim fix shipped with step 3.**
`promptDeactivatePropertyConfirm` now takes a **required**
`variant: 'cascade' | 'flag_only'`. Required rather than defaulted: the
compiler named both call sites the instant it was added, and a default
would hand the next one the wrong promise silently. `/admin` declares
`cascade`; the CA declares `flag_only` and its copy now says the
property is marked inactive, that anyone assigned only to it loses
portal access, and that **no accounts, residents or vehicles are
deactivated and logins are unchanged**. Routing the CA path through the
same per-user machinery remains the cascade work item.

---

## Filed 2026-10-15 — two items from the /claim ruling

### Revocable flyer tokens (deferred by Jose, "not now")

`/claim` and every property QR today carry the property as a **plain
name** in a query param: `?property=<name>&company=<name>`. There is no
token column, no token table, nothing to rotate.

That is fine for disclosure — `/claim` answers every input identically
and mails no unknown address, so guessing a property name buys the same
blank screen. What it costs is **revocability**: once a flyer is
printed and posted, the link works forever. A property that changes
management, or one whose flyer was photographed and posted somewhere,
cannot invalidate it.

Shape if it is wanted: `properties.claim_token` (random, unique),
rotatable from the CA portal, `/claim/[token]` resolving to the
property. `?property=` kept as a deprecated alias for a window so
printed flyers keep working, then dropped.

Scope note: this is **not** `/claim`-only. The same argument applies to
`/register?property=` and `/visitor?property=`, which have the same
shape and the same non-revocability, and `/visitor` is the one that
issues something of value. Doing it for `/claim` alone would be the
smaller and less useful half.

### Invite off the request path (background send) — Sweep #2

`/api/register/claim` pads every answer to a 900ms floor, which means
nothing is distinguishably **fast**. It does not make the branches
equal: a send is a Supabase round-trip and measured 32ms slower than
the fastest send-nothing branch.

🔴 What that leaks, precisely: it is observable only for an address that
**is** a records-bearing resident at that property **and** has not yet
claimed. An observer has to have already guessed the address and the
property to learn anything, and what they learn is that the guess was
right.

The fix is structural, not a bigger floor: enqueue the invite and
return immediately, so every branch does the same amount of work on the
request path. Then the floor can come down and the timing becomes
genuinely uniform rather than merely not-fast.

Prerequisite: there is no job queue in this project today. The nearest
thing is the Vercel cron set, which is minute-granularity and wrong for
something a resident is waiting on. So this is "pick a queue" work, not
a one-file change — which is why it is Sweep #2 rather than now.

### Carried into the loader gate (not a backlog item, a binding note)

🔴 When the bulk **loader** is built, its gate must assert that the
loader cannot create a staff role — the same assertion the claim route
now carries. Confirmed today for the template (11 columns, no role
column) and for `bulk-onboarding.ts` / `bulk-validator.ts` (zero
occurrences of the string "role"), but the loader does not exist yet,
so for the loader this is *asserted by construction* and nothing more
until there is code to gate.

---

## 🔴 REQUIRED LEG — slice-2 checkout gate: the first metered subscription

Filed 2026-10-16, binding rather than suggested.

When slice 2 ships checkout creating subscriptions that carry a
`per_permit` line item, **its gate must include a real end-to-end leg
for the bulk-load billing guard**: a company with a genuinely metered
subscription, and an approve and a load against it that are both
refused, with Return still available.

**Why it cannot be done now, and why the current coverage is not a
substitute.** As of today:

- A1 Wrecker llc is the only company in the system with a
  `stripe_subscription_id`.
- No subscription anywhere carries a `per_permit` item.
  `syncOnAdd`'s own comment says why: *"Until slice 2 ships checkout
  creating subscriptions with per_permit items, this returns
  action='skipped_no_line_item'"* — and the nightly `BILLING_SYNC_CRON`
  confirms it, A1 → `skipped_no_line_item` on every consecutive run on
  record.

So `verify:billingguard` covers the metered branch as **decision
logic**: the production functions `meteredLoadReasons` and
`blockRefusesAction` are handed a metered check result and the whole
truth table is asserted. That proves the decision is right. It does
**not** prove Stripe would ever hand the guard that result, which is
the only thing the end-to-end leg can prove.

🔴 Checkout is the first place a metered subscription will exist, which
makes its gate the first place this can be exercised — and the moment
it exists is also the moment the guard stops being inert. A guard that
has never once been seen to fire on real data is a guard nobody should
rely on at the point it starts mattering.

See `docs/phaseB-billing-guard-gate-gap.md`.

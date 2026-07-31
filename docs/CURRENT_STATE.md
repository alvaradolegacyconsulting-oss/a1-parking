# CURRENT_STATE

**Rolling state file. Overwrite in place at the end of each session — never create another dated
kickoff.** Read it first; it is the source of truth for where things stand.

**Should live in the repo** (`docs/CURRENT_STATE.md`) so Mateo can read and maintain it. Jose
uploads the current copy to project knowledge when starting a new chat.

*Last updated: July 30, 2026 — bulk approve (ordered) + manager mobile approvals, both verified*

---

## Posture

**Stabilization while A1 runs.** A1 has surfaced nothing — weeks of quiet. Bar-2 is deliberately
parked. `public_signup_open` stays `false`. Nothing outstanding is urgent.

A1 is the only `production` company (3 test tenants + 1 demo). Jose **cannot log into A1's
portal** — he uses Test-LEGACY. **A1 checks must be SQL.**

**Tenant IDs:** Test-PM 87 · Test-ENF 88 · Test-LEGACY 89 · Demo 90 · **A1 Wrecker llc 91**
(production).

---

## 🔴 A1 GO-LIVE (July 26–28)

A1 went live at Green Acers on July 27. Residents self-registered against printed flyers; the go-live surfaced
a P1 gate-skip bug (residents seeing "deactivated" instead of "pending"), a 5-day CA-write regression from
the July 22 grant remediation, a `/qr` hardcoded-array vs DB drift, and a property-name typo Amanda entered at
create-time. Everything below closed within the arc.

### Properties (A1 Wrecker llc, id 91)

| id | name | notes |
|---|---|---|
| 143 | **Green Acres** | renamed 2026-07-28; alias `Green Acers` retained for printed flyers |
| 144 | Miramar Apartments | correct, not renamed |
| 145 | Sugarberry Place | correct, not renamed |

Live counts as of 2026-07-28: **18 residents (17 pending), 24 vehicles (23 pending)**, ~2 assigned managers +
2 CAs + drivers. Still climbing at roughly 10–20/day; A1's onboarding runs over the next month.

### ✅ COMPLETE — Green Acers → Green Acres (2026-07-28)

Property 143 renamed. **Verified: every `AFTER-Acers` count zero across all 11 carriers**;
`get_property_for_visitor` returns `Green Acres` for **both** the old and new names — the alias path and the
direct path. `/register` and `/visitor` both render the canonical name off the old-spelling URL.

Final counts on the new name: properties 1 · residents 18 · vehicles 24 · user_roles 19 · drivers 2 ·
visitor_passes 6.

**A1's printed flyers keep working permanently — no reprint.** Their QR encodes
`/register?property=Green%20Acers&company=A1%20Wrecker%20llc`; `property_name_aliases` maps `Green Acers` → 143
and the flyers resolve through it. The flyer *artwork* still shows the old spelling — flagged to A1 for their
next print run.

#### Why the ordering was what it was — keep this if the pattern recurs

- **Children first, parent last.** `trg_properties_name_block_rename` counts references across
  `user_roles.property`, `drivers.assigned_properties`, and `residents.property`. Updating children first means
  `v_refs = 0` when the parent runs, so the rename is permitted **and the trigger acts as a completeness check** —
  miss a carrier and the transaction aborts. Never disable it to get past it.
- **Alias INSERT last, inside the same transaction.** The no-shadow trigger rejects an alias matching a live
  property name, so it could not be inserted before the rename; doing it after, as a separate statement, would
  have left printed flyer URLs unresolvable in the gap. Same transaction, after the parent, satisfies both.
- **Array updates used an order-preserving `unnest`/`array_agg` rewrite, not `array_replace`.** `array_replace`
  is exact-match and would have missed `'green acers'` or `' Green Acers'` inside an array.

`scripts/property_rename_greenacers_to_greenacres_DRAFT.sql` stays in the repo as the template for the next
rename — header marked **APPLIED 2026-07-28, property 143**.

### Shipped July 26–29

| Commit | What |
|---|---|
| `b80db63` | Six-site Commit A — tow-path company-scope hardening (`= not ~~*`) |
| `1aa70b2` | P1 — pending residents reach Registration Pending banner (not `/deactivated`) — caught 6 real A1 users at go-live |
| `7e337ca` | Manager view no longer badges deactivated residents as Active + refetch bundle |
| `31cdfcf` | +Add Resident affordance restored to manager portal (Option B hoist, `managerCompany` guard, refetch tail) |
| `4440457` | Single `refreshCrmData()` fan-out — closes the missing-call class across ~28 manager write paths |
| `9a47464` | Feedback-before-refresh — credentials modal / alerts fire before the 5-query refresh |
| `b2645d6` | `/visitor` phantom-pass guard — refuses form when RPC doesn't resolve the property |
| `c09e9b1` | `property_name_aliases` schema (table + trigger + 2-step RPC) + canonical writes on `/visitor` + `/register` R1 pair-validation |
| `08986c6`* | Rename script — DISABLE/ENABLE + drivers.assigned_properties added (superseded by 06ab2e9) |
| `06ab2e9` | Grant-fix draft (`user_roles` UPDATE) + rename script children-first rewrite (trigger becomes completeness check) |
| `ee2c926` | Verification template — discipline 10 (VQ.POLICY_GRANT_MATCH cross-reference for grant remediation passes) |
| `cbfdeaf` | Rename script — alias INSERT moved INSIDE the transaction, after parent rename |
| `7552752` | `/register` displays canonical property name (not raw URL param) at all 3 display sites |
| `ec4493f` | Visitor pass limit — rolling-30 semantics (11 items, one commit): SQL migration + client + copy + smoke script + backlog file |
| `0a46ed5` | Rolling-30 verification+diagnostic v2 — whitespace-normalized + structural count (VQ.GATED_EXIT_COUNT) after v1's `%within%CASE WHEN v_is_anon%` false-failed a correct function |
| `35b18eb` | Rolling-30 verification+diagnostic v3 — absence checks scoped to executable-clause form + `::regprocedure` pin; VQ.NO_JWT_IS_NULL_TRAP matches assignment `:= (auth.jwt()` (bare-token match false-failed on its own anti-refactor comment) |
| `0ee2b75` | CURRENT_STATE bundle post-rolling-30 |
| `99d88a9` | `/qr` derives from `properties` table (root defect behind Green Acers/Acres divergence); role gate admin+CA; branding follows selected property's company |
| `9b73b53` | `/qr` follow-ups — print CSS, `get_my_role()` RPC (was `.ilike('email')` + `.maybeSingle()` — silent-denial + duplicate-row false-fail), `marginSize` for qrcode.react v4, gate framing corrected |
| `ec09e8f` | Manager Residents CSV export — `↓ Export CSV` on Residents header; flatten+serialize helpers reusable at CA portfolio scope; `EXPORT_RESIDENT_LIST` audit row; UTF-8 BOM + CRLF + quote-and-double CSV escaping |
| `ca658de` | CA silent-read sweep — 10 fetch handlers destructure `error` + log `[CA <handler>]` (8 more context-heavy sites deferred); root case: A1 CA-portal Activity tab investigation |
| `fea21d5` | CA Activity scope fix — `fetchViolations(propertyNames: string[])` via `.in()` portfolio-wide + tab-arrival `useEffect`; parity confirmed pre-apply (6 distinct violations.property values, all exact_match=loose_match=1); voided_at inconsistency reported not silently aligned |

Plus `20260728_user_roles_update_grant_fix.sql` applied (fixed 5-day CA-write regression from July 22
`GRANT INSERT` omission of UPDATE) and the alias schema applied to prod ahead of the rename.
Rolling-30 migration + verification v3 applied 2026-07-29; probe-verified silent on Test-LEGACY.
Grant audit closed on `authenticated` side 2026-07-29 (Jose SQL): `property_name_aliases` correctly has zero
grants — access is definer-only via `get_property_for_visitor`. **Do NOT grant SELECT there** — the table has
exactly one legitimate reader and grants would widen access. Anon-side audit still outstanding to close the item
fully.

### Shipped July 30

| Commit | What |
|---|---|
| `e0223aa` | Bulk approve — ordered combined action, residents then eligible vehicles |
| `c045416` | Allow-list eligibility gate + split skip reasons |
| `3917dff` | `buildBulkApproveSummary` extracted + denominator fix |
| `f02ce52` | Write cores + `runBulkApprove` extracted to `manager-crm-writes.ts` (−323 lines in the surface) |
| `b914fd1` | Manager mobile approvals view (`/manager/mobile`) |
| `162f562` | Naming + `friendlyWriteError()` — raw errors never reach the user |

### ✅ Visitor pass limit — rolling 30 days (2026-07-29, `ec4493f` + `35b18eb`)

`visitor_pass_limit` was labelled "per year" and counted **concurrent active passes** — neither per year nor per
month, and it did not prevent the abuse it existed for (a resident could take a fresh pass daily and never
approach the limit). Both `enforce_visitor_pass_limit()` and `get_plate_pass_status()` now count
`created_at > now() - interval '30 days'`.

**Locked decisions** (all in the migration header with reasoning — do not "fix" any of them back):
- **Count everything issued.** Revoked passes still count; `exempt_plates` is the remedy when a manager revokes
  in error. Do NOT re-add `is_active = TRUE`.
- **Quota is permanent within the window.** No UI hard-delete of a visitor pass exists (SQL only), so
  `exempt_plates` is the sole reset. Adding a hard-delete affordance means revisiting the count-everything
  decision.
- **Anon count-stripping.** The RPC omits `used`/`limit` when `auth.uid() IS NULL`, because rolling-30 turns
  `used` into visit history for an arbitrary plate on an anon page. Gated at the **two count-carrying exits**;
  the three no-count exits are untouched. **`auth.uid()`, never `auth.jwt()`** — the Supabase anon key IS a JWT,
  so a guard on `auth.jwt() IS NULL` silently never fires.
- **Guidance, not a figure.** Help docs teach how to choose rather than naming a default; "typical default: 1-2"
  was catastrophic under the new unit.

**Verified on Test-LEGACY:** anon `{"state":"at_limit"}` with no counts; authenticated `used:3, limit:3`; a
31-day-old pass present and **not** counted; all three counted passes expired or revoked — so the old predicate
would have counted zero and permitted the insert that now raises `23514`.

**Behaviourally inert for A1** — every property still has `visitor_pass_limit = NULL`, so the limit check does
not fire for them. The control is now correct and available when a property chooses to use it.

**Untested:** `/api/visitor/create-pass`'s `23514` sanitize — the UI pre-check disables submit first, so that
path only fires on a direct POST.

**Ships next on these functions:** [plate-status-company-scoping](../backlog/plate-status-company-scoping.md)
(formerly "Commit B") MUST inherit this body — 4 `VQ.INHERIT_*` guards specified in that file so the widening
can't silently revert the 30-day predicate or the anon count-strip.

### ✅ Bulk approve — ordered combined action (2026-07-30)

`Approve all pending` approves **residents first, then vehicles whose resident is now active.** Phase 2's
eligibility is an **allow-list** gated on phase-1 *results*, not the pre-phase snapshot — a deny-list would
approve vehicles whose resident was never evaluated (outside the batch, or `resident_email` matching no row),
leaving an authorized car for someone unapproved.

Skips report their reason separately: *"resident approval failed"* vs *"resident not approved."*

**Meter-once lives in exactly one place** — `approveVehiclesBatch()` in `app/lib/manager-crm-writes.ts`. Both
`runBulkApprove` phase 2 and the per-row unit cascade compose it. One `callSyncOnAdd` per batch, never per item.

**Summary denominator is the pre-eligibility count**, matching the confirmation dialog. Invariant asserted in a
comment above `buildBulkApproveSummary`: successes + failures + skips === attempted. Before the fix the
confirmation said "5 vehicles" and the summary said "3 of 4" — both correct, silently different denominators.

**Verified on Test-LEGACY**, reproduced identically after the extraction:
`1 of 1 resident · 1 of 3 vehicles · Failed: BULKAPPROVE · 1 skipped (resident not approved): ORPHAN01`.
Network trace showed **two** `approve_vehicle` calls for three pending vehicles — the skip never reaches the
network — and no read burst while the summary dialog was open, demonstrating feedback-before-refresh.

### ✅ Manager mobile approvals — `/manager/mobile` (2026-07-30)

Narrow-purpose surface: pending queue, approve/decline (per-row and bulk), and lookup by unit or plate.
**Deliberately excludes** editing, spaces, violations, visitor passes, CSV export, and deactivate — destructive
cascades stay on desktop.

- **Role gate: `manager` and `admin` only.** Leasing agents are `isReadOnly` on desktop; admitting them to an
  approve/decline surface would be a write expansion arriving via a convenience feature. **When A1 asks, the
  shape is read-only mobile** — queue and lookup visible, no action buttons.
- **Property from `get_my_properties()`** (DEFINER, equality on lowered email) — no `user_roles` read for
  property, nothing added to the 141. `can_approve_vehicles` uses the *escaped* `.ilike` form. Filed:
  `get_my_can_approve_vehicles()` DEFINER RPC would remove the last direct read.
- **Narrow reads throughout** — pending-only on load, search on demand, refetch just the pending list after a
  write. `refreshCrmData()` is never called from mobile.
- **PM-only never cascades.** Per-row resident approval on `pm_only` leaves their vehicles pending, where they
  appear in the queue — **the pending list is the confirmation.** Non-metered tiers cascade normally.
- `companyIdForSync` wired to match desktop — without it, mobile bulk approve would have metered zero permits
  and drifted the Stripe counter silently on PM-Only.

**Verified on device:** leasing agent blocked · approved plate returns via lookup with no action buttons ·
**cross-company plate returns nothing** (tenancy holds on the new queries) · decline cascade confirmed by a 10/2
split across residents and vehicles · touch targets and keyboard clean · Airplane Mode surfaces a red banner.

### Non-blocking residuals from today's arc

- **CA Activity — expect two `violations` requests on first tab visit.** `fetchAll` (L679) and the new tab-arrival
  `useEffect` (2026-07-29) both fire the first time a user clicks Activity after load. Harmless; not fixing.
  `properties` is `useState`-backed so its reference is stable — this is NOT a render loop. Cleaner shape (dropping
  `fetchViolations` from `fetchAll` and letting the tab own its own load) is a refactor for a real reason, not
  this one.
- **`fetchViolations`'s `.in('property', …)` is name-keyed — inherited, not introduced.** The query has no
  company predicate; tenancy comes from `.in()` being built from the CA's own property names + RLS as the
  backstop. Cross-company property-name collision would let a CA read another tenant's violations at that name.
  Same shape as the prior `.ilike('property', property)` — the July 29 change did NOT introduce this exposure.
  Filed at the FK epic; **higher sensitivity than most of the 141** because it's a read of another tenant's
  enforcement records on a paying-customer daily surface. Durable fix: `property_id` FK, same as everywhere.
  Latent today (zero cross-company property-name collisions verified 2026-07-27).

### Confirmed bugs (open, ranked)

- 🔴 **No pending-queue notification.** Nothing tells a manager that registrations are waiting. From outside,
  "reviewing at their own pace" and "doesn't know they're there" are indistinguishable. At 10–20/day for a
  month, that queue needs a nudge — digest email or a badge that survives logout. Mobile approvals lands
  Miriam directly in the queue when she opens the app, which partly answers this for engaged managers; a
  persistent badge or digest is still worth doing for the disengaged case.
- **Email `~~*` in RLS policies (PII disclosure).** 24 SELECT-only policy sites using `email ~~* auth.jwt`
  wildcard-match on the caller's own email. Fix: change to `lower(email) = lower(jwt->>'email')` — its own
  commit, three-file, negative control that a `_`-substituted email no longer matches victim. Ungated
  (self-signup open) but non-escalating (helper functions verified to use equality). Ahead of company-name
  work.
- **`/qr` hardcoded PROPERTIES array vs DB.** Post-A1-stabilization: derive from `properties` scoped to
  signed-in company. Root defect that created the Green Acers/Acres divergence in the first place.
- **`resetResidentPassword` gated in `!PM_CRM_ENABLED` branch.** Same class as +Add Resident before restore.
  PM_CRM_ENABLED-branch parity audit item.

### Open verifications (not blockers)

1. **Post-rename registration writes.** The five rows checked today predate the transaction, so they only
   prove the rename updated them. Jose watching for the next registration created **after** the STEP 2
   timestamp — it should read `Green Acres`.
2. **`/register` Step 3 review row and the Submitted screen** — two of the three fixed display sites the
   go-live screenshots didn't reach. Reachable with a throwaway `+probe` email on Test-LEGACY.

### Filed follow-ups (2026-07-30)

- **`get_my_can_approve_vehicles()` DEFINER RPC** — completes the helper family (`get_my_role`,
  `get_my_company`, `get_my_properties`) and removes the last direct `user_roles` read on the mobile surface.
  Small, low-risk migration.
- **Read-only mobile for leasing agents** — the shape (queue + lookup visible, no action buttons) is decided.
  **Do not ship until A1 asks** — no leasing agents are active on production today, and building it now would
  be shipping past demand.
- **`approveAllForUnit` / `approveAllPendingProperty` could adopt `approveVehiclesBatch` cheaply** — both are
  bulk-shaped and share the meter-once discipline that now lives in the primitive. **Dead-code question on
  `approveAllPendingProperty`:** with `approveAllPendingCrm` now the ordered combined action and both mobile
  and desktop callers converging there, `approveAllPendingProperty` may have no callers left. Grep + confirm
  before removing.
- **A1 comms backlog** — home-screen affordance available today · manager 7-day violation window ·
  voided rows now hidden · bulk approve live · **mobile approvals live** · collision-loser plates must be
  **declined or corrected**, never retried (unique index rejects them on every bulk run).

### Queued for next session

**[plate-status-company-scoping](../backlog/plate-status-company-scoping.md)** (formerly "Commit B" — renamed
2026-07-29 because `vehicle-state.ts` already has a "Migration B" and both touch enforcement). Follow-on
FK-epic item **`visitor-pass-trigger-scoping`** (formerly "Commit C").

Then:
1. **Anon-side grant audit** — one query, closes an item queued since the `user_roles` fix
2. **email `~~*` → equality** — the only ungated security item, 24 sites
3. **plate-status-company-scoping** — with the 4 `VQ.INHERIT_*` guards so widening can't silently revert
   the rolling-30 body
4. **Bar-2:** metacharacter validation blocker · cross-tenant cascade at `admin/page.tsx:470-509`
5. **A1:** operator-license conversation · what a tow ticket renders when the field is empty · `PM_CRM_ENABLED`-
   branch parity sweep · `resetResidentPassword` parity-audit follow-on

---

## 🔴 ACTIVE ARC — Authorized Plates

**What it is:** a per-property list of plates a manager or CA maintains. A match reads as
**Authorized** at scan time, exactly like an active resident — **and remains fully enforceable.**
Staff, vendors, contractors who park regularly.

**Origin:** replaced the Do Not Tow arc on July 23. `exempt_plates` was misread as tow protection;
DNT was then built assuming tow protection was the gap. It wasn't. Three distinct capabilities,
now named apart:

| | Capability | Meaning | Status |
|---|---|---|---|
| 1 | `properties.exempt_plates` (`text[]` column) | skips the annual visitor-pass **quota** | exists, unused, correct |
| 2 | `do_not_tow_plates` | **absolute** tow refusal, no override | **PARKED** |
| 3 | `authorized_plates` | standing authorization, **still enforceable** | ← this arc |

**Never merge or migrate between the three.**

### Commit plan — data entry ships LAST

| | Commit | State |
|---|---|---|
| ✅ | **AP-SCHEMA** `51c29f2` — table, trigger, 9 policies, grants, audit | 11 VQs silent |
| ✅ | **AP-CASCADE-DB** `59a3c4d` — `check_authorized_plate` RPC + `pm_plate_lookup` branch 1.5 | 11 VQs silent (post-apply only) |
| ✅ | **AP-CLIENT** `b02a2a5` — driver + CA branches, `authorized_plate` render on both, shared `AUTHORIZED_META`, `PLATE_STATUS_META`-derived fallback | `npm run build` clean; Vercel glance pending |
| ✅ | **AP-MANAGE-TRIGGER** `8b2024c` — `removed_at` server-clock via trigger + INSERT-branch `NULL` guard + `AP.TRIGGER_INSERT_NULL` + wrap-safe audit strings | evidence-verified via direct readout; 3 VQs post-apply-only (negative controls consumed by early first apply) |
| ✅ | **AP-MANAGE-CLIENT** `ebeab8d` — `AuthorizedPlatesManager` shared component + confirm modal + manager settings integration + CA per-property panel integration | build clean |
| ✅ | **AP-MANAGE-CLIENT fix** `d991c3c` — `ManagerAuthorizedPlatesWrapper` gained loading + explicit-error states (was silently `return null` on unresolved id) — **superseded by `b724c84` below; wrapper deleted** |
| ✅ | **AP-MANAGE-CLIENT root-cause fix** `b724c84` — manager Settings section never mounted because `manager.property` referenced a field that doesn't exist (`manager` state IS a properties-table row with `.id` + `.name`, not `.property`). Wrapper deleted entirely; `AuthorizedPlatesManager` receives `manager.id` + `manager.name` directly. **Also added missing `'authorized_plate'` render case to manager Plate Lookup** + extended `lookupResult` type/whitelist. |

### Behavioural smoke — AP arc verified end-to-end (2026-07-23)

| Test | Result |
|---|---|
| Driver at 146 scanning plate at 146 (`TESTAP`) | ✅ **Authorized** |
| Driver at 138 scanning plate at 146 (`TESTAP`) | ✅ **NO PERMIT FOUND** |
| Driver at 138 scanning plate at 138 (`TESTAP2`) | ✅ **Authorized** |
| Driver at 146 scanning plate at 138 (`TESTAP2`) | ✅ **NO PERMIT FOUND** |
| Label suppression: manager sees "Selena's Car" · driver sees no label | ✅ **PASS** |
| Manager Settings section renders (add form, boundary copy, empty state) | ✅ **PASS** |
| CA add / list / empty state | ✅ **PASS** |
| `pm_plate_lookup` viewing-property — manager viewing 138, `TESTAP` (authorized at 146) → **not** green Authorized (AP argument change) | ✅ **PASS** (2026-07-24) |
| `pm_plate_lookup` viewing-property — `LESLY` (resident of 138), viewing 138 → resident · viewing 146 → **Unauthorized** (predicate works on the silent branch) | ✅ **PASS** (2026-07-24) |
| `pm_plate_lookup` viewing-property — search plate, switch property → result clears (client fix) | ✅ **PASS** (2026-07-24) |

**Four commits of source-only verification now have behavioural evidence.** `check_authorized_plate` property predicate + role-conditional label suppression + `pm_plate_lookup` branch 1.5 + driver render + manager Settings integration + CA integration + **viewing-property scoping across all 7 branches** all confirmed working against real plates.

### Lesson worth recording (the `LESLY` defect was invisible by construction)

Five of seven `pm_plate_lookup` branches returned **no property field**, so a manager was told a
vehicle from another property was a resident of the one they were standing at — with nothing on
screen to contradict it and no way to notice.

It surfaced only because **Authorized Plates was the first branch to return a property name**, and
only because Jose pulled the thread when the AP card looked wrong. The feature that exposed it had
nothing to do with it.

Two things carry forward:

- **A response that omits the field it scoped on can't be checked by the person reading it.**
  Where a query narrows by something, the answer should say what it narrowed by. Now true of
  `pm_plate_lookup`'s audit row (`properties_in_scope` + `viewing_property`) — worth being true of
  returns as well, in a future pass.
- **Adjacent features find each other's bugs.** The DNT arc found the cross-tenant RLS hole; AP
  found this. Neither was the thing being built.

### Still open on AP arc

- **Step 4 (CA search for `TESTAP` → Authorized)** — never run
- **Step 5b (driver NOT assigned to property)** — **untestable via UI.** Second Test-LEGACY
  driver provisioned 2026-07-24, but was assigned to both properties so the run repeated 5a.
  The driver portal only offers properties the driver is assigned to, so the
  `check_authorized_plate` unassigned-property branch cannot be produced by clicking — it guards
  **direct API calls** (session hitting the RPC with an unassigned `p_property`). Source-verified,
  defence-in-depth, and no PM-track customers exist. If behavioural proof is wanted, needs a
  `sessionAs` script (the shape the old 4.5 smoke was going to use). Low priority.
- **CA count column** — deferred, trigger: the `public_signup_open` flip
- **Category editing after add** — remove-and-re-add for now; first follow-up if it annoys anyone
- **A1 feedback on CA read-only** before public signup (Jose)

Every commit before AP-MANAGE was inert because the table stays empty — but note a CA *can* write
to `authorized_plates` via PostgREST today, so "inert" means no UI path, not unreachable.

### Locked decisions

- Status value **`'authorized_plate'`** — distinct value, **identical render** to the resident card
- **One DEFINER RPC, three callers** — driver client, `pm_plate_lookup`, CA client. Drivers have
  no `authorized_plates` SELECT policy by design, so a direct client query returns empty silently.
- Cascade position: **beside** the resident branch. In `pm_plate_lookup` it's the `ELSE` of the
  resident match — resident wins by construction.
- **Driver call passes `targetProp`. CA call passes `selectedProperty?.name ?? null`** — never
  always-NULL, which reintroduces the vendor-at-two-buildings `otherproperty` misreport.
- `label` — free text, **portal-only**, 80-char cap, `NULL` for drivers **at the RPC**, not just
  the UI
- **No expiry** v1 · **not metered** · **no enforcement-code changes**
- Manager **and** CA manage the list
- Per-property count in CA + super-admin views (visibility, not a cap)

### Three plate-resolution paths — all need the branch

| Path | Where | Roles |
|---|---|---|
| Driver scan | `app/driver/page.tsx` `searchPlate()` | driver |
| Manager scan | `pm_plate_lookup` RPC | manager, leasing_agent |
| CA scan | `app/company_admin/page.tsx` `searchPlate()` | company_admin |

`/visitor` and admin need no branch. **The CA cascade has no DNT check at all** — harmless now,
but evidence the three-cascade drift is already real.

**Acceptance criterion:** add one plate; driver, manager and CA all show Authorized; a driver
assigned to a *different* Test-LEGACY property shows non-resident. Runs after AP-MANAGE.

---

## PARKED

**`do_not_tow_plates`** — absolute tow refusal with no override. Contradicts the authorized-plates
model, so it has no user. Kept pending a decision on whether the capability is ever wanted.

**Provably unpopulatable:** `INSERT`/`UPDATE` revoked from `authenticated` (`0d0a7fe`),
`COMMENT ON TABLE` documents it, B1's VQ.4 asserts it. `service_role` retains access.
**The tow guards in `set_violation_status`, `stamp_tow_ticket` and `regenerate_tow_ticket` are
LIVE and inert only because the table is empty.** Re-granting INSERT/UPDATE reactivates the
capability — a decision, not a cleanup.

**B3 (CSV export DNT filter)** — stopped. No never-towable vehicles under this model.

---

## Shipped July 23

| Commit | What |
|---|---|
| `6b4ff1d` | Commit A — dropped the DNT creation trigger (tag-not-block pivot) |
| `721ab61` | **B1** — 6 RLS policies rewritten on `do_not_tow_plates` |
| `8f13a0f` | **B2** — company scoping on 5 DNT lookups + `regenerate_tow_ticket` guard |
| `0d0a7fe` | DNT-PARK — revoke writes + extended VQ.4 |
| `51c29f2` | AP-SCHEMA — `authorized_plates` table |
| `59a3c4d` | AP-CASCADE-DB — `check_authorized_plate` + `pm_plate_lookup` branch 1.5 |
| `0e90711` | Add `docs/CURRENT_STATE.md` (rolling state file) |
| `b02a2a5` | AP-CLIENT — driver + CA branches + `authorized_plate` render + fallback |
| `8b2024c` | AP-MANAGE-TRIGGER — `removed_at` server-clock + INSERT-branch NULL guard |
| `ebeab8d` | AP-MANAGE-CLIENT — `AuthorizedPlatesManager` + confirm modal + integrations + multi-property backlog |
| `d991c3c` | AP-MANAGE-CLIENT fix — `ManagerAuthorizedPlatesWrapper` loading + error states (superseded) |
| `b724c84` | AP-MANAGE-CLIENT root-cause fix — wrapper deleted (`manager` IS a properties row); `authorized_plate` render case added to manager Plate Lookup |
| (unshipped) | AP-only client patch (viewing-property warning on `authorized_plate` render) — **HELD 2026-07-23**; correct fix is RPC-layer, silent 5 branches more urgent than visible 1 |
| `01ab566` | AP-CATEGORY — add `category` column (staff/vendor/other) + `check_authorized_plate` role-conditional return + AP.CHECKS 4→5 retrofit + template addendum on negative-controls-as-diagnostic + delete non-bug backlog |
| `d0525f3` | AP-UI-REFINE — component gains readOnly/collapsible + category (badge/filter/radio) + search + sort by plate + toolbar + unknown-category fallback + filter reset on propertyId change + console.error on mutation failure; manager tab adjacent to Authorized Guests (Settings integration removed); CA now read-only collapsible |
| `808114a` | pm_plate_lookup viewing-property SQL — signature gains `p_viewing_property TEXT DEFAULT NULL` + 6 branches gain layered predicate (portfolio scope preserved) + AP branch argument change (NULL → p_viewing_property) + B2 invariants preserved byte-identical + DROP-first + pg_proc COUNT=1 + AP.PM_CALLS updated to positive form + audit rename properties_in_scope + rollback documents client-first + 2-arg DROP |
| `b03ac58` | pm_plate_lookup viewing-property CLIENT + diagnostic file + 9th discipline — switchProperty clears lookupResult/Error/Plate; Plate Lookup call passes `p_viewing_property: manager.name`; diagnostic file ships with migration (standardize going forward); template addendum: **Diagnostics ship as files** |

**B1 and B2 closed a real cross-tenant defect and survive the re-scope.** A manager at one company
could read *and write* another company's per-property plate list through PostgREST, and
`check_dnt_plate` returned another tenant's free-text `reason` to a driver.

**All of it is source-verified only.** Every VQ is structural. Behavioral proof is still owed.

---

## Open items (none urgent)

- **C5 Order Form probe** — refactored to import the real writer; awaiting push greenlight
- **`order_forms` E2E** — closes on the first real proposal-code redemption; don't manufacture one
- **Backlog `800ff4c`** — anon sequence-defaults hole. LOW, ~30 min
- **Backlog `get_plate_pass_status` ILIKE wildcard** — `docs/backlog/`. Bundles with the Bar-2
  visitor-pass touch
- **Fast-follow:** `create_visitor_pass` write-side dedup · vehicles-branch determinism

---

## Bar-2 (parked)

See `bar2_state_of_play_july22_2026.md`. Blockers cluster into one arc: **`accept_saas_agreement`
chicken-and-egg** (keystone, blocks B2-4 + self-serve C5) → **B2-4** end-to-end signup.
**B2-3b is DONE.**

**Plus the name-keyed scoping group — 6 sites, one class.** Properties resolved by name with no
company predicate, several via `~~*`: `set_violation_status` · `regenerate_tow_ticket` ×2 ·
`stamp_tow_ticket` · `get_plate_pass_status` · `enforce_visitor_pass_limit`.

**Bypass framing:** B2's guard scopes to the caller's company; ILIKE lets a caller reach another
tenant's violation; the guard is present, correct, and irrelevant. Latent today (zero collisions),
live the moment `public_signup_open` flips. Fix shape:
`lower(trim(p.company)) = lower(trim(get_my_company()))`.

---

## Disciplines (in `docs/development/migration-verification-template.md`)

1. **`VQ.GRANTS` on every new table** — explicit table *and* sequence privileges
2. **Read the schema, don't remember it** — `information_schema.columns` first
3. **Source-inspection VQs: assert on executable syntax** — `pg_get_functiondef()` includes
   comments; keep rationale outside function bodies
4. **Negative control** — run every new VQ against the **unfixed** state before applying. *A VQ
   that has never been observed failing is untested.* Where state can't produce a failure,
   self-test the predicate.
5. **Delimiter-extracted VQs** — fixed-text delimiters, no per-site decoration, exactly-once and
   in-order assertions
6. **Set assertions** — array `=` is order-sensitive. Use `@>` both directions, report
   `missing`/`unexpected` via `EXCEPT`. An assertion that fires must say *what* differs.
7. **Ordering assertions** — `position()` returns 0 for an absent needle, so
   `position(a) < position(b)` is true when `a` is missing. Guard `= 0` explicitly first.
8. **Negative controls run as a diagnostic, not as the verification file** — `BEGIN…COMMIT`
   wrap aborts at first `RAISE`, masking every later VQ; a pre-apply run validates only the first
   assertion. Write pre-apply as a read-only jsonb readout returning each condition as a
   boolean/count; every `false`/`0` is a validated detector. Verification file stays as-is for
   post-apply (silence expected; abort-on-failure is correct there).
9. **Diagnostics ship as files** — the pre-apply negative control is a `_diagnostic.sql`
   committed with the migration, not a query in a chat message. Two consecutive negative-control
   captures were lost to chat-based diagnostics (AP-CATEGORY, pm_plate_lookup). Every new
   migration ships three files: `<date>_<name>.sql`, `<date>_<name>_diagnostic.sql`,
   `<date>_<name>_verification.sql`. Three identical pastes from VS Code, one source.
10. **Grant remediation passes cross-reference `pg_policies`** — any migration that grants or
    revokes table privileges must include the reusable `VQ.POLICY_GRANT_MATCH` block (template
    section added `ee2c926`). Catches the class where an INSERT-only grant strands a FOR UPDATE
    or FOR ALL policy silently for days until someone exercises the surface. Root case: the
    July 22 pass omitted UPDATE on `user_roles`, leaving `company_admin_update_users`
    unreachable — surfaced on A1's go-live day (5 days later, 42501/HTTP 403 on CA saves).

### From the Green Acers rename (2026-07-28)

Not template disciplines (no VQ artifact); general lessons from the rename arc worth carrying
into the next name-keyed operation:

- **A guard that prevents a bad state also constrains the order of a legitimate change.**
  Resolve it *inside* the transaction rather than sequencing around it or switching it off. The
  block-rename trigger forced children-first (and became a free completeness check); the
  no-shadow trigger forced the alias INSERT to the end of the same transaction.
- **`array_replace` is exact-match.** For name normalization inside an array, use an
  order-preserving `unnest … WITH ORDINALITY` / `array_agg` rewrite so case and whitespace
  variants are caught — otherwise the update and a `lower(trim())`-based verification query
  disagree.

### From the rolling-30 visitor pass semantics (2026-07-29)

Three cycles this week cost by tests that couldn't fail. All three apply to any negative
control / pattern VQ / absence check going forward:

- **A negative control must assert it reached the guarded path.** A `<PID>` placeholder in
  the rename probe meant the no-shadow trigger test never ran (reported syntax error, recorded
  as pass); the rolling-30 anon count assertion would have gone green against `unlimited`
  without touching the guarded branch (setup must set a limit + seed a pass to force
  count-carrying exit). **A test that cannot fail is worse than no test — it gets recorded as
  evidence.**
- **Pattern assertions must be format-robust.** `VQ.WITHIN_GATED` false-failed on a correct
  function because the two gated exits differ only in indentation. Normalize with
  `regexp_replace(…, '\s+', ' ', 'g')` and pin body fetches via `::regprocedure`. Column
  alignment is not executable syntax.
- 🔴 **Absence checks are the dangerous direction.** Documentation naturally quotes what it
  warns against — the anti-refactor comment saying *do not use `auth.jwt() IS NULL`* tripped
  the VQ banning that string. A presence check matching a comment is merely weak; an absence
  check matching a comment **fails a correct function**. Any `NOT LIKE` needs a form prose
  cannot contain: an assignment (`:= (auth.jwt()`), an operator with operands
  (`AND expires_at > now()`), a full clause. Bare tokens are documentation-fragile.

### From the CA Activity investigation (2026-07-29)

Two failure classes need different guards; they don't substitute for each other:

- **A visibility improvement makes failures visible, not incorrect successes.** The CA silent-read
  sweep (`ca658de`) surfaces errored fetches as `[CA <handler>] failed` in the console. It does
  NOT protect against a query that returns HTTP 200 with fewer rows than intended — no error,
  nothing logged. That's why the parity check (`.in()` exact-match safety on
  `violations.property` vs `properties.name`) had to run BEFORE `fea21d5` shipped: same-symptom
  outcome (empty results) but different failure mode. **Ship the sweep first so scope-change
  errors are visible; run the parity check separately so wrong results don't ship silently.**

### From the manager mobile arc (2026-07-30)

Two disciplines from the bulk-approve + mobile-approvals arc, general enough to carry into the next
user-facing surface:

- **Never render a raw error to a user, and only claim *"nothing was changed"* when the return shape proves it.**
  Airplane-Mode testing surfaced `TypeError: Load failed` to a property manager. Fixed by classifying transport
  vs server failure, and — the subtler half — distinguishing a bulk **pre-flight** failure (provably no writes)
  from a **mid-batch** drop (writes may have landed). On mid-batch the queue is refetched *before* the message,
  so *"the queue has been refreshed"* is verifiable rather than a claim. The load-bearing pattern:
  `friendlyWriteError(e, action)` returns copy chosen for what the manager needs to know, not what the runtime
  threw.
- **Name the job, not the device.** *"Mobile view"* invited managers to expect the whole portal on a phone;
  *"Mobile approvals"* sets the scope in the label. Applies to any narrow-purpose surface split off a broad one
  — the affordance name is the first thing that shapes user expectations, and a wrong name creates a support
  question every time the missing feature is looked for.

**Supabase editor:** paste verification files **whole** — the auto-RLS helper injects
`ALTER TABLE … ENABLE ROW LEVEL SECURITY` into partial pastes and breaks dollar quoting. This is
also what makes `DO`-block atomicity hold.

**Validated detectors to date: 3** — VQ.1 (B1), VQ.CANONICAL (B2), and AP.CATEGORY_COLUMN (AP-CATEGORY 2026-07-24). Each was the FIRST assertion in its verification file. **Root cause of the stuck count** (established 2026-07-24): a `BEGIN…COMMIT`-wrapped verification file aborts at the first `RAISE`, so a pre-apply run validates only its first assertion — every later VQ is masked by construction. **Fixed forward via 8th codified discipline:** Negative controls run as a read-only diagnostic (jsonb readout), not as the verification file. Every `false`/`0` in the diagnostic is a validated detector.

**pm_plate_lookup viewing-property (2026-07-24):** four flipping detectors + two preservation invariants specified — diagnostic **not captured** (Jose pasted a markdown chat message into the SQL editor, `syntax error at or near "#"`). Second consecutive miss traced to the same root: diagnostic lived in chat while migration lived in a file. **9th discipline codified this session:** Diagnostics ship as files (`_diagnostic.sql` alongside migration + verification). Post-apply verification silent across three files including B2's preservation checks, but count stays 3 — assertions unvalidated as detectors because they weren't observed against wrong state.

**Behavioural smoke (2026-07-24) — pm_plate_lookup viewing-property: 3/3 pass.** Three different
mechanisms confirmed independently — AP argument change (TESTAP branch), predicate on the silent
branch (LESLY / resident), client `switchProperty` clear. Recorded above as *predicates confirmed
non-inert*; not counted as validated detectors — it proves the assertions can return the failing
value, not that they were observed doing so against real wrong state.

**Backlog closed (2026-07-24):** `pm-plate-lookup-viewing-property-scope` (fixed + verified) ·
`manager-multi-property-settings-selector` (deleted earlier — described a non-bug; `switchProperty`
at `app/manager/page.tsx:490` handles the case).

---

## Standing rules

Report-first → eyeball → deploy → **verify by evidence, not the success toast** · separate commits
for independent rollback · **nothing on A1 without an explicit greenlight; any A1 issue → stop and
assess** · **do NOT bump `TOS_/PRIVACY_/SAAS_VERSION`** · `FOR_MATEO_*` files are messages, not
knowledge — relay and let go · **SQL sent to Jose is always a complete standalone statement;
fragments for Mateo's files are labelled as such** · **diff reports paste code verbatim, not
summaries** — three false alarms in one session came from reviewing shorthand instead of source.

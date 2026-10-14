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
| 11 | **`LIMIT 1` with no `ORDER BY` on a table assumed unique** | `get_my_role` / `get_my_company` / `get_my_properties` | UNIQUE index where uniqueness is assumed; fail on helper `LIMIT 1` without a deterministic order |
| 12 | **Token valid after revocation** (access token lives up to 60 min after ban + `is_active=false`) | deactivation probe | Gate asserts a revoked user's *existing* token is refused on the next query (after the helper `is_active` change) |
| 13 | **ILIKE with unescaped input**: `_` is a LIKE wildcard, common in real emails | `guardEmail` blocks `%` and `\` but not `_` | Lint/grep: every ILIKE on user input escapes `_ % \`, or uses `lower()=lower()` equality |
| 14 | **One identity carrying two roles** (staff and resident on one email) | amandacanchol | UNIQUE (email) on `user_roles`; invite paths refuse a second role |
| 15 | **Bulk operations whose reverse restores more than the forward took** | property cascade reactivation restores unrelated deactivations | Cascades stamp what they changed; reverses act only on their own stamps |

*Classes 11–15 were added Oct 14 from Mateo's `security-sweep-2-candidate-classes.md`.*

## The sweep, in phases
1. **Inventory (≈1 d):** one capture of all policies, grants, functions (definer, search_path, EXECUTE), storage policies, buckets, API routes with their auth, edge functions, and service-role call sites.
2. **Role × table execution matrix (≈2 d):** for each role (admin, CA, manager with/without approval flag, leasing_agent, driver, resident, **deactivated**, **banned**, **records-only/no-auth**, anon) × each sensitive table × read/insert/update/delete, compare actual against an expected matrix. **Run by execution with real sessions on canaries, never on A1.** Commit this as a re-runnable gate (`verify:rolematrix`).
3. **Route audit (≈1 d):** every `app/api/*` route: who may call it, what it scopes by, whether it trusts client input for identity/company, rate limits, captcha.
4. **Turn findings into standing gates (≈1 d):** classes 1–4 become a single `verify:securitybaseline` run on every deploy (and nightly), failing on drift.
5. **Optional, recommended before larger PM-firm sales:** an external penetration test. Enterprise prospects (e.g., the Greystar RFP) will ask, and an outside report is a sales asset.

**Estimate:** ≈5 days for phases 1–4. Phase 5 is external and scheduled separately.

## Process rules already adopted (keep)
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

**Class 15 is now ruled** (2026-10-15): the cascade stamps every user
it deactivates with the property id and a cascade id, in the audit and
in a field reactivation can read; reactivation acts only on its own
stamps; pre-existing deactivations of unknown provenance are skipped
and listed as *"deactivated separately; reactivate individually if
intended."*

**One more candidate for the table**, found while reporting on the CA
property path and not yet numbered:

| # | Class | Example | Standing check |
|---|---|---|---|
| 16? | **Two paths to one operation where only the dialog is shared** | `/admin` deactivating a property cascades (bans users, deactivates residents + vehicles); the CA's `togglePropertyActive` flips `properties.is_active` and nothing else. The confirm helper was deliberately shared "to close the divergent-paths bypass" — but it shares the *warning*, not the *work*, so the dialog promises a cascade the CA path does not perform | for each operation reachable from more than one portal, assert the two produce the same end state on canaries — not that they call the same helper |

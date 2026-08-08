# Backlog — CA portal derives banner severity from message text

**Filed:** 2026-08-05 during deactivation Task 2 diagnostic (FOR MATEO thread).
**Scope:** CA-portal contained. Verified across four axes 2026-08-05 — no shared code with any other portal.
**Priority: 🔴 RED (promoted 2026-08-08).** Was MEDIUM as "hygiene." **Actually concealed the total failure of user deactivation across three roles (manager, leasing agent, driver) for the life of the product.**

## 🔴 Escalation — 2026-08-08

`1d08135` (§1 driver deactivation with EXPLICIT severity) proved the mechanism when Jose clicked Deactivate on a Test Legacy driver:

- Red banner. Handler's response text verbatim: **`"User not found"`** (auth id `1d102989-...`, `last_sign_in_at 2026-08-08 19:18:07` — the user demonstrably exists).
- No column writes. No audit row. Ban-first ordering held.

Jose then clicked Deactivate on `legacy-leasing@test.shieldmylot.com` through the existing manager/LA path (which goes through `toggleUserActive` → `msgBox` sniffer):

- **GREEN banner** reading `"User not found"`.
- Same handler. Same failure. `banned_until` still `null`.
- One screenshot shows both banners simultaneously — green above red, same text, opposite colors.

### The consequence — not "a mislabeled banner"

- **Manager, leasing-agent, and property-cascade deactivation have never worked.** The auth ban is the load-bearing control ([:2508-2511](../../app/company_admin/page.tsx#L2508-L2511)); it has never landed.
- **Nobody knew because of this bug.** `"User not found"` matches neither `startsWith('Error')` nor `.includes('failed')`, so it renders green. Every deactivation attempt for the life of the product returned green on total failure.
- **The reference implementation we modelled §1 on was itself broken.** §1 only surfaced the underlying handler bug because it was built to bypass the sniffer.

### The general rule with teeth

> **A UI that derives severity from message text will eventually show green on failure — and when it does, it hides the failure of whatever it reports on.** The cost isn't a mislabeled banner; it's every defect downstream of that banner going unobserved.

Now in memory as `feedback_severity_from_text_hides_downstream_failures.md`.

### What's next (2026-08-08 arc)

- **Handler fix** — Jose to paste `deactivate_user` case from Supabase dashboard. Pagination hypothesis is DEAD: Jose's rank query returned 12, 29, 34 — all failing accounts sit inside the first page of 50, so `auth.admin.listUsers()` pagination doesn't explain the miss. Leading candidates now: wrong client (anon key or user JWT instead of service role), wrong project URL, or `auth.users` accessed through PostgREST. All three fail for everyone always, which matches every observation — no success has been seen at any rank.
- **Full sweep of `set*Msg` call sites** in `app/company_admin/page.tsx` — 94 msg/msgBox touchpoints per grep. `driverActionResult` pattern from `1d08135` is the shape to apply.

## 🔴 SECOND ESCALATION — 2026-08-08 (load-bearing was WRONG)

Jose asked: if swift-handler is universally broken, how does resident deactivation work?

Answer: **it doesn't use swift-handler.** `deactivateResidentWrite` writes `residents.is_active = false` through supabase-js. Portal mount reads it via `get_my_effective_active`. Residents are gated by a column read, not an auth ban.

Same mechanism has been silently gating managers, leasing agents, and drivers this entire time:

- OLD `toggleUserActive`: swift-handler ban → **failed silently** → `user_roles.is_active = false` write → **succeeded** → audit row → `get_my_effective_active` reads the column → portal mount redirects.
- The user was locked out of the portal — not by the ban, by the column.
- The comment at [`company_admin/page.tsx:2508-2511`](../../app/company_admin/page.tsx#L2508-L2511) says the ban is load-bearing and the column write is best-effort. **The evidence says the reverse.** The ban has never been the control; the column has. The ban's practical contribution is closing the window between authentication and portal mount, since login checks neither column (see relay #6 trace).

### The `activate_user` corollary

Reactivation runs through the same handler and has the same shape. So for the entire life of the product, **user deactivation and reactivation have been column-only operations that reported themselves as auth-level ones.** The reporter lied about both what happened AND what should have happened.

### `1d08135` + `db0107a` are a functional regression

Both commits inherited the wrong load-bearing comment and applied ban-first ordering: ban fails → return early → no column writes, no audit. Under that shape, deactivation does nothing at all — where the old (dishonest) code at least revoked access via the column.

**We traded dishonest-and-partially-working for honest-and-completely-broken.** The honesty is a real gain — it's how the handler bug was found — but the regression is live at Test Legacy right now.

### Correct ordering, pending Jose's `user_roles.is_active` probe

If Jose confirms column-only revocation works by setting `user_roles.is_active = false` by hand and watching the driver portal redirect to `/deactivated`, then:

1. **Reorder both handlers** — write the column first, attempt the ban after, report each outcome honestly.
2. **Three-state severity** — full success (green), **partial: access revoked, login block not applied** (amber), and failure: nothing changed (red). `driverActionResult` / `userActionResult` types grow a third value.
3. **Audit `ban_applied: false`** alongside the column outcomes so a later reader can distinguish fully-revoked from portal-blocked users. That distinction becomes the record of which users were deactivated during the broken-handler window.
4. **Fix the comment at `:2508-2511`.** Say what's actually load-bearing and what the evidence was.
5. **Same fix covers `activate_user`** — the reactivation path has had the same broken shape all along.

### `admin/page.tsx` cascade at :461

Under the corrected model, the cascade's per-user `Promise.all` bans are also non-load-bearing — the column write at [:471-474](../../app/admin/page.tsx#L471-L474) is what actually locks the affected PMs out. Cascade's aggregate-outcome design (deferred to a separate commit per relay #12) needs to reflect this: the bans are supplementary; the column write is the gate.

## The class

**A UI that derives severity from message text will eventually show green on failure.**

`app/company_admin/page.tsx:3635` picks banner tone via string sniff:

```js
const isErr = msg.startsWith('Error') || msg.includes('failed')
```

Case-sensitive. GREEN (`#4caf50`) if neither pattern matches; RED (`#f44336`) if either matches. Every caller that writes a failure message must *happen to* include one of those tokens; every failure message that doesn't renders green.

🔴 **The obvious fix is wrong.** Adding `'Failed'` to the substring list or lowercasing the comparison repairs the two known cases and leaves the mechanism intact — the next message that doesn't happen to contain a matched token renders green again. **The fix is an explicit severity on the message:**

```js
setUserMsg({ tone: 'error', text: 'Failed to update user status.' })
setUserMsg({ tone: 'ok',    text: 'User deactivated.' })
```

So a caller has to state what happened rather than hope the sniffer guesses right. Sweeping every `setXMsg('...')` call site is the tail of the fix.

## Two known instances (as of 2026-08-05)

### 1. `toggleUserActive` swift-handler failure — green banner on failure

[company_admin/page.tsx:2519](app/company_admin/page.tsx#L2519):
```js
setUserMsg(json.error || json.message || 'Failed to update user status.')
```

`'Failed to update user status.'` has capital F; `includes('failed')` is lowercase → **falls through to GREEN**. Any `json.error` that doesn't start with `"Error"` or contain lowercase `"failed"` renders as success.

### 2. `toggleUserActive` silent write swallow — audit knows, UI doesn't

[company_admin/page.tsx:2532-2538](app/company_admin/page.tsx#L2532-L2538) does `console.error` on `user_roles.is_active` update failure, then [:2553](app/company_admin/page.tsx#L2553) **optimistically flips the UI row**, and [:2551](app/company_admin/page.tsx#L2551) records `column_write_failed: true` in the audit.

**The audit knows the write didn't land; the UI doesn't.** Documented as "best-effort" because the swift-handler auth-ban is the load-bearing control — but the CRM display doesn't distinguish "user is deactivated" from "user's audit says we tried to deactivate them and the write failed."

Same intent-vs-outcome split as the `runOneDeactivate` bug on the manager side (which is the reason `deactivateResidentWrite` in Task 3 Commit 2 makes error handling a first-class deliverable).

### 3. Sibling case

[company_admin/page.tsx:1862](app/company_admin/page.tsx#L1862) `createUser` sets:
```js
setUserMsg('Could not complete resident setup: … Login account deactivated.')
```

Same class — `'Could not'` matches neither `Error`-startswith nor `failed`-contains → renders GREEN.

Probably others; every `set*Msg('failure-shaped')` call site needs review.

## Contained — verified across four axes (2026-08-05)

- No cross-imports: neither `manager/page.tsx` nor `PmResidentCrm.tsx` imports from `company_admin/*`, and vice versa.
- No shared banner/toast component: `msgBox` is a local closure defined at [:3635](app/company_admin/page.tsx#L3635); nothing else uses it.
- No shared write wrapper: CA calls `supabase.from('user_roles').update()` directly.
- No `friendlyWriteError` helper exists in `app/lib/` (grep = 0 hits).

Fix stays inside `app/company_admin/page.tsx`. Cannot affect manager or resident portals.

## Fix shape

1. **Change the `msgBox` API** — accept `{tone, text}` (or an explicit `msgKind` sidecar state) instead of a bare string.
2. **Sweep every `set*Msg('...')` call site** in `company_admin/page.tsx` — pass explicit tone. Each site should either be a known-success (`tone: 'ok'`) or a known-failure (`tone: 'error'`); if a site sets an ambiguous message today (e.g., "processing..."), consider a third `tone: 'info'`.
3. **Fix `toggleUserActive` write-swallow separately.** The write result must be checked; on failure, tone is 'error', row does NOT optimistically flip, audit row records the failure but not as if it succeeded. Same class as the Task 3 Commit 2 write-handling requirement — apply the same discipline.
4. **Anywhere in CA that logs to audit_logs after a not-error-checked write** — audit the write result first, log after success only, and note the swallowed failure separately (e.g., action='WRITE_FAILED') if worth capturing.

## Standing-rule addition proposed

Fold into disciplines:

> **Never derive UI severity from message text.** The tone must come from the caller's knowledge of what happened, not a substring sniff. A UI that infers "error" by looking for `"failed"` in a message string will eventually render green on failure because the next failure message won't happen to include the token. Every setter that displays state to a user takes an explicit tone/severity alongside the text.

## Adjacent

- Task 3 Commit 2 (Aug 5) — `deactivateResidentWrite` extraction; the manager-side twin of `toggleUserActive`'s silent swallow. Fixed by extracting the write core + destructuring `{error}` + surfacing failure. Same discipline, different portal.
- [feedback_raw_error_never_reaches_user](../../.claude/projects/-Users-ALC-a1-parking/memory/feedback_raw_error_never_reaches_user.md) — related but different: that rule says raw errors don't reach users; this rule says the derived severity must be caller-supplied, not text-inferred.
- The general form belongs in the standing disciplines alongside "audit-after-unchecked-write records intent, not outcome" (also 2026-08-05).

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

- **Handler fix** — Jose to paste `deactivate_user` case from Supabase dashboard; leading hypothesis is unpaginated `auth.admin.listUsers()` (default page size 50) which explains why it broke silently as tenant count grew.
- **Full sweep of `set*Msg` call sites** in `app/company_admin/page.tsx` — 94 msg/msgBox touchpoints per grep. `driverActionResult` pattern from `1d08135` is the shape to apply.

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

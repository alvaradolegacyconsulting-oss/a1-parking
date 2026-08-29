# SWIFT-HANDLER REWRITE — Item 2 Commit 2 of 3 (2026-08-29)

**Purpose:** Replace the `admin.listUsers().find()` scan in every branch of `swift-handler` with a deterministic `get_auth_user_id_by_email` RPC call. Fix an unescaped ILIKE in the admin guard. Deploy via the Supabase dashboard Edge Functions editor.

**Prereq:** `20260829_get_auth_user_id_by_email.sql` applied AND verification returned PASS row (7 gates including G4 grants + G7 execution). If Commit 1 is not live, the Edge Function will error `PGRST202: Could not find the function` on its first call.

**Deploy discipline:** Supabase dashboard's Edge Functions editor overwrites in place with no version history. **Copy the current source to a local file before pasting the new version.** If anything regresses, that copy is the only rollback.

---

## The three broken sites — same pattern, same fix

Every branch currently does:

```typescript
const { data: { users }, error: listError } = await supabase.auth.admin.listUsers()
if (listError) return new Response(...500...)
const user = users.find((u) => u.email?.toLowerCase() === email?.toLowerCase())
if (!user) return new Response('User not found', { status: 404, ... })
// then: supabase.auth.admin.updateUserById(user.id, {...})
```

**Root cause:** `listUsers()` default paginates to `perPage: 50, page: 1`, ordered `created_at DESC`. Anyone older than the 50th most-recent account is invisible. Jose's ranking query (2026-08-29): `auth.users` total = 185; 6 successful calls all at slots 1/19/43; 6 failing calls all at slots 85/92/102. 135 of 185 accounts (73%) unreachable.

**Rewrite each site to:**

```typescript
// 🟢 2026-08-29 Item 2 fix. Replaces listUsers().find() O(n) scan
// that silently failed for 73% of auth.users. See migration
// 20260829_get_auth_user_id_by_email.sql for the RPC + grants.
const { data: userId, error: lookupError } = await supabase
  .rpc('get_auth_user_id_by_email', { p_email: email })

if (lookupError) {
  // Lookup ERRORED (DB / network / permission). NOT the same as
  // "user doesn't exist." Return 500 with the underlying message
  // so the operator can distinguish. Collapsing this into 404 is
  // how we got a month of misleading "User not found" for users
  // who plainly existed.
  console.error('[swift-handler] get_auth_user_id_by_email failed:', lookupError)
  return new Response(
    JSON.stringify({ error: 'Lookup failed: ' + lookupError.message }),
    { status: 500, headers: { 'Content-Type': 'application/json' } }
  )
}

if (!userId) {
  // Genuine "no such user." Returns 404 as before, but now it will
  // actually be true when it fires.
  return new Response(
    JSON.stringify({ error: 'User not found' }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  )
}

// Proceed with the ban / activate / reset using userId directly.
// e.g. deactivate_user:
const { error: banError } = await supabase.auth.admin.updateUserById(userId, {
  ban_duration: '100y',
})
// (etc — everything downstream of the id lookup stays the same)
```

**Apply the identical swap at:**

1. `deactivate_user` branch — the ban path
2. `activate_user` branch — the un-ban path
3. `reset_password` branch — the admin-initiated password change path

Do NOT paginate the `listUsers()` loop. It works but is O(n) on every call and gets slower forever. This lookup is constant-time via the RPC.

## The ILIKE fix — admin guard in `reset_password`

Current shape:

```typescript
const { data: targetRole } = await supabase
  .from('user_roles')
  .select('role')
  .ilike('email', email)   // ← unescaped ILIKE on user-supplied email
  .single()
```

**Problem:** `_` is a single-character wildcard in ILIKE patterns. Real addresses in this system contain underscores — `amanda_a1wrecker+properties@gmai.com` is in `user_roles` right now. An email with `_` matches multiple rows; `.single()` then errors.

**Fix:**

```typescript
const { data: targetRole } = await supabase
  .from('user_roles')
  .select('role')
  .eq('email', email.toLowerCase().trim())   // exact match; identity lookup, not search
  .maybeSingle()
```

`.eq()` on the lowered/trimmed email is the correct shape here — this is identity resolution, not text search. Matches the discipline in `manager-crm-writes.ts:301` (B166 owner-trim) and elsewhere. `.maybeSingle()` returns null-on-no-match rather than erroring.

## 🔴 Guard-failure analysis (worth a look before ship)

The current guard shape:

```typescript
const { data: targetRole, error: guardError } = await supabase
  .from('user_roles').select('role').ilike('email', email).single()
if (targetRole?.role === 'admin') {
  return new Response('Cannot reset admin passwords via this handler', { status: 403 })
}
// proceed with reset ...
```

**Failure mode: if the ILIKE lookup errors** (e.g., multi-row `.single()` collision on an `_` in the email), `targetRole` is undefined. `targetRole?.role === 'admin'` is false. **The guard passes.** A crafted email containing `_` that matches multiple rows including a real super-admin row could route around the "cannot reset admin passwords" protection.

Reachability today:
- Requires the caller to know a `_`-containing pattern that ILIKE-matches an admin row's email
- Depends on the specific address strings present. `amanda_a1wrecker+properties@gmai.com` doesn't match any admin, but a pattern like `%_%@%.com` would match many rows including admins
- swift-handler is invoked by authenticated CA/manager sessions with the caller's JWT for the initial admin-role check (a separate guard); the ILIKE only gates the TARGET being reset
- So exploitation would require: (a) a CA/manager caller (already trusted to some degree) (b) crafting a pattern that matches an admin. Not trivially exploitable, but the guard is the LAST line and it fails-open

The `.eq()` fix above closes this by construction — exact match either finds one row or none, no wildcard behavior.

Worth noting this in the paste as its own rationale, not just as "wildcard escape hygiene."

## Deploy checklist

- [ ] Verify Commit 1 (`20260829_get_auth_user_id_by_email.sql`) is applied and verification returned PASS on 7 gates
- [ ] Confirm G4 grants: `service_role = 1`, all others = 0. If not, HALT — RPC is an identity oracle
- [ ] Copy current `swift-handler` source from Supabase dashboard to a local file (rollback insurance)
- [ ] Paste the rewritten source
- [ ] Hit Deploy
- [ ] Canary test: activate then deactivate `amanda_a1wrecker+properties@gmai.com` from the CA portal
  - Pre-fix: both calls returned `"User not found"`
  - Post-fix: both should succeed, `ban_applied: true`, `ban_error: null`
- [ ] Re-run the S1/S2 divergence sweep to confirm nothing else drifted while the bug was silent

## After deploy

Commit 3 (client-side hard error on `ban_applied: false`) is safe to push AFTER this Edge Function deploy lands. Before Commit 3, hard errors would surface on every ban attempt for the 73% of currently-unreachable users, which is a lot of red banners. After Commit 3 + this fix, hard errors would ONLY surface for genuine failures (which should be rare going forward).

Two known divergent accounts to hand-fix after Commit 3 lands:
- `amanda.a1wreckerllc+properties@gmail.com` (BANNED_BUT_SHOWS_ACTIVE)
- `amandacanchol@gmail.com` (DEACTIVATED_BUT_NOT_BANNED)

Do NOT mass-ban backfill. Only these two, only after Jose rules on which of Amanda's four manager logins to retire.

## One to note, not fix here

`create_user` writes `user_metadata: { force_password_reset: true }` while the app reads `user_roles.must_change_password`. Two sources of truth for the same fact. `create_user` doesn't have `listUsers()` so it isn't affected by THIS bug, but if the two have drifted, the forced-reset gate isn't reading what the create path wrote. Worth a query at some point.

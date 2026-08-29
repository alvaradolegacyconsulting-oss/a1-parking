# SWIFT-HANDLER REWRITE — Item 2 Commit 2 of 3 (2026-08-29, revised)

**Revised 2026-08-29** after Mateo caught three defects in the initial draft (`f98363d`). Original defects: (1) `ban_duration: '100y'` — Go `time.ParseDuration` has no year unit, `updateUserById` would silent-fail. (2) `.eq('email', email.toLowerCase().trim())` fails open on mixed-case stored emails (`user_roles.email` isn't stored lowercased; uniqueness is on `lower(email)` expression index only). (3) Guard treated lookup ERROR as "not an admin" — fail-open. All three corrected below.

**Purpose:** Replace `admin.listUsers().find()` in every branch of `swift-handler` with the deterministic `get_auth_user_id_by_email` RPC (Commit 1). Replace the reset_password admin guard's ILIKE with a `get_user_role_by_email` RPC (Commit 1.5). Fail-closed guard pattern.

**Prereqs (both must be live before the paste):**
- `20260829_get_auth_user_id_by_email.sql` applied AND verification PASS on 7 gates
- `20260829_get_user_role_by_email.sql` applied AND verification PASS on 7 gates (case-insensitive execution proof)
- G4 grants on BOTH functions: service_role=1, all others=0. If any drift, HALT.

**Deploy discipline:** Supabase dashboard's Edge Functions editor overwrites in place with no version history. **Copy the current source to a local file before pasting.** If anything regresses, that copy is the only rollback.

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

**Root cause:** `listUsers()` default paginates to `perPage: 50, page: 1`, ordered `created_at DESC`. 73% of `auth.users` unreachable per Jose's 2026-08-29 ranking query.

**Rewrite each site to:**

```typescript
// 🟢 2026-08-29 Item 2 fix. Replaces admin.listUsers().find() O(n) scan
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
```

### Ban duration — `'876600h'` verbatim, NOT `'100y'` 🔴

`updateUserById(userId, { ban_duration: '...' })` uses GoTrue's Go parser which accepts only `ns`, `us`, `ms`, `s`, `m`, `h` — plus the literal `none`. `'100y'` is a parse error → silent ban failure → we'd have swapped one silent bug for another. **Keep `'876600h'` verbatim (100 years in hours; every `2126-…` `banned_until` value in current `auth.users` was produced by this exact string).** `activate_user` keeps `'none'`, which is the valid literal.

```typescript
// deactivate_user branch
const { error: banError } = await supabase.auth.admin.updateUserById(userId, {
  ban_duration: '876600h',   // 100 years. Go time.ParseDuration — NO year unit; do NOT change to '100y'.
})

// activate_user branch
const { error: banError } = await supabase.auth.admin.updateUserById(userId, {
  ban_duration: 'none',      // valid GoTrue literal; unlifts the ban.
})
```

**Apply the id-lookup swap at all three branches:**

1. `deactivate_user` — ban duration `'876600h'`
2. `activate_user` — ban duration `'none'`
3. `reset_password` — plus the guard fix below

Do NOT paginate the `listUsers()` loop. Constant-time via the RPC.

## The admin protection guard in `reset_password` — 🔴 use the second RPC, not `.eq()`

Current shape (broken):

```typescript
const { data: targetRole } = await supabase
  .from('user_roles').select('role')
  .ilike('email', email)   // ← unescaped ILIKE; `_` is a wildcard, `.single()` errors, guard fails open
  .single()
```

**My initial handoff (2026-08-29 morning) proposed:**

```typescript
// ⛔ WRONG — filed for record, do NOT paste
.eq('email', email.toLowerCase().trim())
```

**Why that fails:** `user_roles.email` is NOT stored lowercased. `UNIQUE (lower(email))` is an expression index; case is preserved in the stored text. Live example: `Juanachavez62.jc@gmail.com` in Aug 28 audit. `.eq()` against a lowered needle misses any row stored with capitals — `targetRole` null → `targetRole?.role === 'admin'` false → guard passes on ordinary mixed-case addresses, not just crafted `_` patterns. Fail-open, same class as the bug we're closing.

**Correct fix:** Use `get_user_role_by_email` RPC (Commit 1.5). PostgREST cannot express `lower(email) = lower($1)` as a filter; functional predicates need a DEFINER RPC. Same pattern + grants discipline as Commit 1.

```typescript
// 🟢 2026-08-29 Item 2 revised — case-insensitive role lookup via
// DEFINER RPC. Migration: 20260829_get_user_role_by_email.sql.
// Fail-closed on lookup error (uncertain state = deny).
const { data: targetRole, error: guardError } = await supabase
  .rpc('get_user_role_by_email', { p_email: email })

if (guardError) {
  // Cannot determine target's role → REFUSE. A protection guard
  // that can't verify must deny, not proceed. Same fail-safe
  // direction as GATE_EXEMPT_STATUSES + COALESCE(v_in_scope,false).
  console.error('[swift-handler] get_user_role_by_email failed:', guardError)
  return new Response(
    JSON.stringify({ error: 'Role check failed: ' + guardError.message }),
    { status: 500, headers: { 'Content-Type': 'application/json' } }
  )
}
if (targetRole === 'admin') {
  return new Response(
    JSON.stringify({ error: 'Unauthorized: Cannot reset admin passwords via this handler' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } }
  )
}
// targetRole is null (no user_roles row) or a non-admin role → proceed with reset
```

**Fail-closed rationale:** the guard's uncertain state is deny, never allow. Mirrors:
- `GATE_EXEMPT_STATUSES` at `resident/page.tsx:318` (explicit allow-list)
- `COALESCE(v_in_scope, false)` in `deactivate_vehicle` scope predicate (NULL→false, refuse)
- The RPC-verification-must-include-execution-gate discipline (structural pass ≠ real pass)

## 🔴 Guard-failure analysis for the record

Even the OLD ILIKE-based guard was fail-open on error. The `.single()` multi-row collision on a `_`-containing email pattern would return no `targetRole` → guard passes. Reachability:
- Caller is already a CA/manager session (some trust)
- Requires a `_`-containing email pattern that ILIKE-matches an admin row
- Live admin emails don't currently contain `_`, but the pattern-matching hazard is real

The RPC-based fix closes this by construction — exact case-insensitive match either finds one row or none, no wildcard behavior.

## Deploy checklist

- [ ] Both migrations applied + verified PASS:
  - [ ] `20260829_get_auth_user_id_by_email.sql` (7 gates)
  - [ ] `20260829_get_user_role_by_email.sql` (7 gates including case-insensitivity proof at G7)
- [ ] G4 grants clean on BOTH functions: `service_role = 1`, all others = 0
- [ ] Copy current `swift-handler` source from Supabase dashboard to a local file
- [ ] Paste the rewritten source with `876600h` and RPC-based guards
- [ ] Hit Deploy
- [ ] Canary: activate then deactivate `amanda_a1wrecker+properties@gmai.com` from the CA portal
  - Pre-fix: both returned `"User not found"`
  - Post-fix: both succeed, `ban_applied: true`, `ban_error: null`, `banned_until` = 2126-…
- [ ] Re-run the S1/S2 divergence sweep

## After deploy

Commit 3 (client-side hard error on `ban_applied: false`) is safe to push AFTER this Edge Function deploy lands.

Two known divergent accounts to hand-fix after Commit 3:
- `amanda.a1wreckerllc+properties@gmail.com` (BANNED_BUT_SHOWS_ACTIVE)
- `amandacanchol@gmail.com` (DEACTIVATED_BUT_NOT_BANNED)

Do NOT mass-ban backfill.

## One to note, not fix here

`create_user` writes `user_metadata: { force_password_reset: true }` while the app reads `user_roles.must_change_password`. Two sources of truth for one fact. Not in scope here; worth a query at some point.

# The `ban_applied = false` accounts — all of them, with context

The CA portal carries this query in its own comments
(`company_admin/page.tsx:3390`) as the way to find accounts needing a
retroactive ban. Run and resolved 2026-10-15.

**7 audit rows, 4 distinct addresses** — activate/deactivate events
pair up on the same account, which is why the count looked like more.

🔴 **Every one failed with the same `ban_error`: `"User not found"`.**
Four different addresses, one error. That is a systematic swift-handler
lookup failure, not a one-off — and for Amanda's account the auth user
had existed since 2026-07-15, so the user was there to find.

## The one real exposure

| | |
|---|---|
| address | `amandacanchol@gmail.com` |
| last failed event | 2026-08-10 `deactivate_user` |
| auth user | 🔴 `banned_until = NULL` — live login |
| last sign-in | **2026-08-21** — 11 days after deactivation |
| user_roles | manager / **inactive** [A1 Wrecker llc] |
| also carries | 🔴 resident at Southfork Lake Apartments, **LIVE** |

Handled by `ONEOFF-20261015_amandacanchol_dead_manager_role.sql`
(replace the dead manager role with the resident role her live record
needs; the login is deliberately NOT banned).

## The other three — not exposures

The distinction is **which direction the last failed event was in**.

| address | last failed event | role now | login |
|---|---|---|---|
| `alvaradolegacyconsulting+forcee@gmail.com` | 2026-08-08 **`activate_user`** | manager / active [Test-LEGACY] | not banned |
| `legacy-leasing@test.shieldmylot.com` | 2026-08-08 **`activate_user`** | leasing_agent / active [Test-LEGACY] | not banned |
| `alvaradolegacyconsulting+drivertest@gmail.com` | 2026-08-08 **`ACTIVATE_DRIVER`** | driver / active [Test-LEGACY] | not banned |

All three last failed on an **un**ban, and all three are `is_active =
true` today. An un-ban that failed on an account which should be
unbanned, leaving `banned_until = NULL`, has arrived at the correct end
state by accident. No action needed.

🔴 But note the mirror risk, which is step 2's real hazard: the same
best-effort failure on the **reactivation** path would leave a
reactivated user banned and locked out with the UI reporting success.
That is why the ruling's positive control — reactivation must unban —
is the load-bearing half of step 2, not the courtesy half.

All three are Test-LEGACY test accounts; none belongs to a live tenant.

## Summary

- 1 exposure, handled by the one-off, on A1.
- 3 benign, all test accounts, all failed un-bans that happened to land
  correctly.
- 1 systematic bug: swift-handler's user lookup reports "User not
  found" for users that exist. Fixing it is part of step 2 — and until
  it is fixed, a ban failure must be reported as a failure rather than
  audited and swallowed.

# BACKLOG — Carry the ids you already have (rollback paths)

**Filed:** 2026-09-25
**Author:** Mateo
**Priority:** P2 — no live exposure; retires two residuals and one class of guesswork
**Status:** Filed, not built. Explicitly ruled OUT of the `_v3` commit.

---

## The pattern

Three failed-add rollback paths — manager, company_admin, admin — throw away identifiers they
are handed, then re-derive them from an email address a moment later.

**1. The ban re-resolves the user by email.**
`swift-handler`'s `create_user` returns `{ ok: true, user_id }`. Every caller discards it. The
rollback then sends `{ action: 'deactivate_user', email }`, and the handler resolves that address
back to an id through `get_auth_user_id_by_email`.

**2. The delete re-derives the row by email + property.**
The `residents` INSERT can return its own `id`. Instead, `delete_orphaned_pending_resident` is
called with `(p_email, p_property)` and finds the row by matching.

---

## What it costs today

**The `_v3` cross-tenant residual.** `_v3` blocks deletion when an *unbanned* login exists for
that email. If another tenant holds the same address with a live login, the guard blocks a delete
that should proceed and the RPC returns 0. Deleting by the row id this flow just inserted removes
the need for the guard to reason about logins at all — the row is known, not searched for.

The original design saw this coming.
`migrations/20260710_delete_orphaned_pending_resident_rpc.sql:42-51` rejected an auth-existence
guard partly because it *"would either over-block (if auth exists from another company's prior
successful create with the same email — the cross-tenant case) or under-block (race)."*

**A failed ban and a ban of the wrong row are indistinguishable.** With an id, "the ban failed"
and "the ban hit something else" become different errors. With an email, they are the same
error — which matters now that both callers surface rollback failures to the user.

**Two lookups where the flow already had the answer.** Not a performance concern at this volume;
it is that every lookup is a place the answer can come back different from the one the flow
started with.

---

## Shape of the change

- `create_user` callers keep `user_id` from the response.
- `deactivate_user` accepts a `user_id` and prefers it, keeping the email path for the callers
  that legitimately have only an address (property deactivation, the CA/driver toggles).
- The `residents` INSERT uses `.select('id').single()` and the rollback deletes by that id.
- `delete_orphaned_pending_resident` gains an id-based path, **with a recency bound** so an id
  alone cannot be used to hard-delete an arbitrary resident row.
- Role-derived scope stays exactly as it is. The id narrows *which* row; it must not widen *who*
  may delete.

One piece across `app/manager/page.tsx`, `app/company_admin/page.tsx`, `app/admin/page.tsx` and
the swift-handler edge function, plus a migration.

---

## Why it is not urgent

There is no exposure to close. The ban can only ever target an account the same flow minted:
`create_user` sits **outside** the rollback `try` in all three portals and returns early on
failure, so a pre-existing email is rejected before the catch can run (traced 2026-09-25; the
concern that a failed add might ban an innocent user was investigated and closed).

This is a correctness-and-legibility change, not a fix.

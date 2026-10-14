# Candidate defect classes for sweep 2's table

✅ **Merged 2026-10-15.** The plan is now committed beside this file at
`BACKLOG_security_sweep_2_plan_oct14_2026.md`. Five of these became
new classes **11–15**; *records-bearing identity* and *best-effort
reported as done* were already classes **5** and **8**. One further
candidate (two paths to one operation, only the dialog shared) is
appended to the plan as **16?**, unnumbered pending a ruling.

This file stays as the evidence trail — each class with the instance
that proved it. Below are the classes I have actually hit, each with the
instance that proved it and what a standing
`verify:securitybaseline` check would assert. Diff this against your
table; the ones most likely missing are marked **NEW?**.

| class | the instance | what a standing gate asserts |
|---|---|---|
| **Records-bearing identity with no auth account** — NEW? | `/api/register/create-user` minted a session for any email holding a `residents` or `user_roles` row. A manager canary's session returned `get_my_role() = "manager"` | for every table that confers identity, POSTing a known address must not return a `token_hash` |
| **A best-effort side effect reported as done** — NEW? | the swift-handler ban: `ban_applied:false` audited while the UI said "User deactivated". An A1 manager signed in 11 days after deactivation | no audit row may carry `outcome:'failed'` alongside a success-shaped response; `ban_applied` must equal the read-back |
| **A service_role route that does not re-implement RLS** — NEW? | any such route *becomes* the escalation. Swept before writing `/api/admin/user-active` | for each service_role route, a per-role probe showing it refuses exactly what RLS refuses |
| **DEFINER helper missing a liveness term** | `get_my_role()` has no `is_active`; a deactivated manager read tenant rows through direct PostgREST | every identity helper's body must test the liveness column its table carries |
| **Unpinned `search_path` on SECURITY DEFINER** | the three `get_my_*` helpers, today | `proconfig` names `public` and `pg_temp` for every `prosecdef` function |
| **`LIMIT 1` with no `ORDER BY` on a uniqueness-assumed table** — NEW? | all three `get_my_*` helpers. 0 of 386 emails violate it, so it holds by luck | the assumed-unique column has a UNIQUE index, or the query is deterministically ordered |
| **An access token still valid after revocation** — NEW? | a raw bearer returned HTTP 200 for its full 60-minute life after both `is_active=false` and the ban | measure the residual window and assert it is the one you intend |
| **A bot gate mistaken for an access control** | the storage MIME allowlist; then `signInWithPassword`'s captcha, which refused my own ACTIVE baseline | every refusal probe must carry a positive baseline that succeeds |
| **Absence reported as the answer** | anon has no SELECT grant on `residents`, so `/register`'s guard read `permission denied` into a discarded error and tested `if (existing)` on `null` — it cannot fire for any real visitor | no `const { data } = await` that drops `error` on a security-relevant read |
| **A gate that passes because its subject is absent** | a missing bucket, a missing RPC, a server the gate did not start — each makes every negative check pass | every gate asserts its subject exists and exits 2 otherwise |
| **A confounded control** — NEW? | my cross-company upload check passed while the other company's flag was off, so the refusal proved nothing | each negative check removes every cause but the one under test, and names the control that proves it |
| **One rule written twice** | the sibling predicate as `EXISTS` + a scalar subquery; preview vs submit authorization | the predicate appears exactly N times, asserted by count, not `>=` |
| **`>=` and substring assertions** | `%notes%` matched `auth_notes`; `>= 3` would have hidden the duplicated predicate | word boundaries (`\m\M`) and exact counts |
| **Bucket-agnostic storage policy** | a policy naming no `bucket_id` applies to every future bucket the moment it exists | 0 policies on `storage.objects` without a `bucket_id` term |
| **A client-side gate treated as a control** | the portal gate blocks the UI; direct PostgREST does not pass through it | for each portal gate, the equivalent raw query is also refused |
| **A dead branch behind an always-true flag** | `CA_CRM_REDESIGN` / `PM_CRM_ENABLED`; three features lost to it, and B113's only "Bulk Upload" link still sits there | `check-dead-branch-additions` over every changed file |
| **ILIKE with unescaped user input** — NEW? | `guardEmail` blocks `%` and `\` but **not `_`**, which is a LIKE wildcard and ordinary in addresses (`john_doe@…`) | every `.ilike()` whose pattern comes from input goes through `escapeIlikeValue` |
| **One identity carrying two roles** — NEW? | `amandacanchol@gmail.com`: a dead manager role and a live resident record, pulling in opposite directions | 0 emails with more than one `user_roles` row |
| **A stale copy standing in for a deployed artifact** | swift-handler lives in the dashboard; a repo copy and the live function are different things | edge-function gates call the deployed function over HTTP and read no source |
| **An unfilled placeholder in a diagnostic** | produces a plausible-wrong NULL rather than an error | every templated block hardcodes or guard-clauses its target |

## The two I would put first

Not because they are the largest, but because both were **live and
exploitable without a login**, and both were invisible to every green
check that existed:

1. **records-bearing identity** — closed 2026-10-15, now
   `verify:createuserguard`
2. **a best-effort side effect reported as done** — closed for the
   per-user path by `/api/admin/user-active`, still open for
   `/admin`'s property cascade (see the cascade proposal)

## The one that has no gate yet

**"An access token still valid after revocation."** Banning refuses a
refresh, measured — but the already-issued token keeps working for up
to 60 minutes and nothing closes that today. Step 3's `is_active` term
in the helpers is what shortens it to the next query. Worth naming in
the table even though the fix is already scheduled, because the gate
should keep asserting the window afterwards rather than assuming it
stayed shut.

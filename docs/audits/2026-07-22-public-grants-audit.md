# Public schema grant-matrix audit — 2026-07-22

**Trigger:** provisioning_failures shipped 2026-07-21 (adfc6e1) with `authenticated` retaining
`INSERT`/`UPDATE`/`DELETE` on a PII-carrying table for ~24h. Caught during order_forms VQ.H
build 2026-07-22 when the same class of hole was found pre-apply.

**Escalation:** two-for-two on the same Supabase-default-grant issue → not coincidence. The
migration template adds RLS without REVOKE'ing baseline grants, so every table created that way
has this latent. Pulling B182/B183 (anon-grants hardening backlog) off the queue per Mateo's call.

**Status:** report-first. No REVOKEs applied without triage. Grant + policy shape can be
intentional per-table; mass-REVOKE would break tables that correctly rely on scoped RLS with
standing grants.

---

## What Jose runs

**Single query, read-only, safe against any environment:**

```
scripts/audit-public-grants-2026-07-22.sql
```

Paste output into a new file at `docs/audits/2026-07-22-public-grants-audit-RESULT.md` (as a
markdown table). Mateo triages HIGH/MEDIUM rows from there.

## What the output looks like (one row per public table)

| column | meaning |
|---|---|
| `table_name` | public schema table name |
| `rls_enabled` | boolean — RLS on the table |
| `select_policy_count` | count of SELECT policies (0 = no read gating) |
| `all_policy_count` | count of FOR ALL policies |
| `write_policy_count` | count of INSERT/UPDATE/DELETE policies |
| `select_policy_summary` | `admin_only` / `scoped` / `broad` / `none` |
| `anon_select/insert/update/delete` | direct grant to anon role |
| `auth_select/insert/update/delete` | direct grant to authenticated role |
| `risk_class` | computed: **HIGH — anon read exposure** / **HIGH — RLS disabled** / **MEDIUM — anon write exposure** / **MEDIUM — auth write on admin-SELECT table** / **LOW — tight admin-only** / **REVIEW — scoped policy, verify intent** |

Rows sorted so **HIGH first, MEDIUM second**. `HIGH` = anonymous READ exposure = customer data
reachable without login. `MEDIUM` = spoofed WRITE surface (bounded by RLS but grant-layer open).
`LOW` = tight state. `REVIEW` = human triage needed.

## Risk framework

### HIGH — anon read exposure

- **What it means:** anonymous users can `SELECT` real data from the table.
- **Signals:** RLS disabled OR `select_policy_summary` = `none`/`broad` AND `anon_select = true`.
- **Action:** REVOKE `SELECT` from anon immediately. If RLS is off, enable it with a scoped
  policy or explicit deny.

### HIGH — RLS disabled

- **What it means:** RLS is off entirely on a real public-schema table. No row-level access
  control fires — every grant is unconditional.
- **Signals:** `rls_enabled = false` on a table that holds real data.
- **Action:** enable RLS + add appropriate policy. If the table is genuinely public-by-design
  (unlikely for anything in this codebase), document explicitly why in the migration header.

### MEDIUM — anon write exposure

- **What it means:** anonymous users can `INSERT`/`UPDATE`/`DELETE` — spoofed rows or destructive
  writes from off the street.
- **Signals:** any of `anon_insert`/`anon_update`/`anon_delete` = true.
- **Action:** REVOKE the grant. Unless the table is deliberately anon-writeable (audit_log-style
  from a public endpoint — unlikely and needs explicit justification), close.

### MEDIUM — auth write on admin-SELECT table

- **What it means:** an admin-SELECT-only table (SELECT policy requires `get_my_role()='admin'`)
  has `authenticated` write grants standing. Any signed-in user can attempt writes; RLS blocks
  non-admin at the qual layer, but grant-layer is open (belt is off, only suspenders left).
- **Signals:** `select_policy_summary = admin_only` AND any of `auth_insert`/`auth_update`/`auth_delete`
  = true.
- **Action:** REVOKE the auth writes. This is the exact class of hole shipped in adfc6e1 and
  fixed in the 2026-07-22 hardening migrations.

### LOW — tight admin-only

- **What it means:** RLS on + admin-only SELECT + no non-service_role write grants. Correct
  target state for ops-only tables.
- **Signals:** `select_policy_summary = admin_only` AND all `auth_insert`/`update`/`delete`
  = false.
- **Action:** none. Confirm intended shape matches; move on.

### REVIEW — scoped policy, verify intent

- **What it means:** SELECT policy is `scoped` (tenancy-gated via `get_my_company()` /
  `company_id` / `auth.uid()` etc.) and grants exist. This is the NORMAL shape for most
  tenant-facing tables (companies, user_roles, drivers, residents, etc.). Grants are usually
  intentional here — the RLS is the gate; the grant is just what allows a policy to fire.
- **Signals:** `select_policy_summary = scoped` AND non-service_role has grants.
- **Action:** per-table human triage. For each REVIEW row, ask:
  - Does the SELECT policy correctly scope to the caller's tenancy? (If yes, `auth_select`
    grant is expected and correct.)
  - Do the write policies correctly WITH CHECK the same scope? (If yes, write grants are
    expected.)
  - Is there any grant to a role whose policy doesn't exist? (That's a gap — the grant has
    nothing to gate → deny by default in RLS, but should still REVOKE for hygiene.)

## Enumeration of public tables (from migration files, for cross-reference)

**15 tables have CREATE TABLE in this migrations directory:**

| table | RLS enabled per migrations? | existing REVOKE anon in migrations? |
|---|---|---|
| flag_acknowledgments | yes | yes |
| guest_authorizations | yes | yes |
| order_forms | yes | yes (in 20260722 build) |
| proposal_codes | yes | no |
| provisioning_failures | yes | yes (in adfc6e1) — but auth not covered until 20260722 hardening |
| space_assignment_history | yes | yes |
| space_requests | yes | yes |
| space_residents | yes | yes |
| stripe_events | yes | no |
| stripe_prices | yes | no |
| tos_acceptances | yes | no |
| vehicle_plate_changes | yes | yes |
| violation_photos | yes | no |
| violation_videos | yes | no |

Also referenced in RLS ENABLE blocks (implying they exist): `spaces`, `violations`. Not
CREATE'd in this migrations directory — likely pre-migrations-directory or in an
initial-schema not tracked here.

**Additional tables known to exist** (from codebase references, not enumerable from
migrations dir): `companies`, `user_roles`, `residents`, `drivers`, `visitor_passes`,
`vehicles`, `properties`, `audit_logs`, `platform_settings`, `dispute_requests`. The audit
SQL enumerates every public schema table via `pg_class`, so the RESULT file will be the
authoritative list — this table is just for pre-triage context.

## Expected initial signals (my best guess pre-run — Jose confirms via query)

Tables I EXPECT to come back as **LOW — tight admin-only** (order_forms once hardening applies;
provisioning_failures once hardening applies; audit_logs likely):
- Admin-only ops tables. If the risk_class comes back MEDIUM auth-write, that's the same hole
  class — REVOKE same way.

Tables I EXPECT to come back as **REVIEW — scoped policy** (the normal tenancy tables):
- companies, user_roles, drivers, residents, vehicles, visitor_passes, spaces, violations,
  guest_authorizations, tos_acceptances, etc. Grants + scoped RLS is the standard combination
  here. Per-table triage confirms each policy actually scopes correctly and the grant is
  gated.

Tables I EXPECT to come back as **HIGH — anon read exposure** (concerning if so):
- I don't expect any, but this is the point of the audit — the assumption is worth testing
  by ground truth query.

Tables I EXPECT to come back as **MEDIUM — anon write exposure**:
- None expected. If any surface, they're incidents.

## Triage output → next commits

After Jose reports the RESULT file:

1. **HIGH rows** → fix same day. Additive REVOKE migration per table. Highest priority.
2. **MEDIUM (anon write) rows** → same-day fix. Additive REVOKE.
3. **MEDIUM (auth write on admin-SELECT) rows** → additive REVOKE using the pattern shipped
   in `20260722_provisioning_failures_grants_hardening.sql`.
4. **REVIEW rows** → per-table decision. For most tenant-facing tables, no action needed
   (grant + scoped RLS is correct). For any where the SELECT policy has a suspicious qual,
   file a follow-up.
5. **LOW rows** → confirm and move on.

**Then:** the migration verification template fold gets applied so no future table can ship
with this class of hole undetected.

## Migration verification template (mandatory for every new public table)

Snippet to include in every new table's `_verification.sql` file going forward. Fails silently
if the write surface is closed against baseline grants — fails LOUDLY if not.

**File:** `docs/development/migration-verification-template.md` (created 2026-07-22).

```sql
-- STANDARD GRANT-SURFACE CHECK — required in every new-table verification
-- Fails if any Supabase default grant leaked through. Adjust the
-- authenticated write assertions to false only if writes for authenticated
-- callers are intentionally allowed for this table (e.g., a
-- self-INSERT policy where authenticated can add their own rows).
DO $grants$
BEGIN
  IF has_table_privilege('authenticated','public.<TABLE_NAME>','INSERT')
  OR has_table_privilege('authenticated','public.<TABLE_NAME>','UPDATE')
  OR has_table_privilege('authenticated','public.<TABLE_NAME>','DELETE')
  OR has_table_privilege('anon',         'public.<TABLE_NAME>','SELECT')
  OR has_table_privilege('anon',         'public.<TABLE_NAME>','INSERT')
  OR has_table_privilege('anon',         'public.<TABLE_NAME>','UPDATE')
  OR has_table_privilege('anon',         'public.<TABLE_NAME>','DELETE') THEN
    RAISE EXCEPTION 'GRANTS FAIL: baseline grant present on public.<TABLE_NAME> — REVOKE required';
  END IF;
END $grants$;
```

For tables that DO intentionally allow authenticated writes (via a policy that scopes them),
the verification comments out the specific write assertion(s) and adds a comment justifying
why. Never comment out anon assertions — anon writes on a public schema table are almost
never intended.

## Cross-references

- `feedback_revoke_anon_default_on_new_tables.md` — codified 2026-06-01+ rule.
- `feedback_function_public_grant_supabase_default.md` — same class for RPCs (SECURITY
  DEFINER inherits EXECUTE to PUBLIC unless explicitly REVOKE'd).
- `feedback_revoke_from_anon_explicitly.md` — REVOKE PUBLIC alone may leave anon execute.
- [migrations/20260722_provisioning_failures_grants_hardening.sql](../../migrations/20260722_provisioning_failures_grants_hardening.sql) —
  the fix that triggered this audit.
- [migrations/20260722_order_forms.sql](../../migrations/20260722_order_forms.sql) — the
  build where VQ.H caught the same class pre-apply.
- `docs/backlog-reconciliation-2026-06-17.md:184` — B183 "Pre-flip 8-helper anon sweep"
  filed on standing queue.

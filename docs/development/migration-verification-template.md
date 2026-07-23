# Migration verification template

**Filed:** 2026-07-22 during the B182/B183 grant-matrix audit escalation.
**Trigger:** provisioning_failures shipped adfc6e1 with `authenticated` retaining `INSERT`
because the verification file only checked `anon`. Two-for-two on the same Supabase-default-grant
hole (order_forms VQ.H caught it pre-apply; provisioning_failures shipped live) → this is a
template gap, not two isolated incidents.

**Rule:** every new-table verification MUST include the standard grant-surface check block
below. Silent completion = the write surface is closed against baseline Supabase grants.
Loud failure = grants leaked through and must be REVOKE'd before apply.

## The standard block

Copy verbatim into every new `<migration>_verification.sql` file. Replace `<TABLE_NAME>` with
the actual table name. Position: as the LAST DO-block in the verification file (after all
column/RLS/policy/index checks — the grant check is the outermost gate).

```sql
-- ── VQ.GRANTS — full write surface closed against baseline grants ────
-- Standard block per docs/development/migration-verification-template.md.
-- Silent = grant surface closed correctly. Loud = REVOKE required
-- before the code half of any dependent commit deploys.
--
-- IF this table intentionally allows authenticated writes (e.g., a
-- self-INSERT policy where authenticated can add their own rows), comment
-- out the specific line with a WHY explanation. NEVER comment out any
-- anon assertion — anon writes on a public schema table are almost never
-- intended, and anon SELECT should always be a deliberate exposure
-- choice documented in the migration header.
DO $vq_grants$
BEGIN
  IF has_table_privilege('authenticated', 'public.<TABLE_NAME>', 'INSERT') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: authenticated has INSERT on <TABLE_NAME> — REVOKE required (see docs/development/migration-verification-template.md)';
  END IF;
  IF has_table_privilege('authenticated', 'public.<TABLE_NAME>', 'UPDATE') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: authenticated has UPDATE on <TABLE_NAME> — REVOKE required';
  END IF;
  IF has_table_privilege('authenticated', 'public.<TABLE_NAME>', 'DELETE') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: authenticated has DELETE on <TABLE_NAME> — REVOKE required';
  END IF;
  IF has_table_privilege('anon', 'public.<TABLE_NAME>', 'SELECT') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: anon has SELECT on <TABLE_NAME> — anonymous read exposure';
  END IF;
  IF has_table_privilege('anon', 'public.<TABLE_NAME>', 'INSERT') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: anon has INSERT on <TABLE_NAME> — anonymous write exposure';
  END IF;
  IF has_table_privilege('anon', 'public.<TABLE_NAME>', 'UPDATE') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: anon has UPDATE on <TABLE_NAME>';
  END IF;
  IF has_table_privilege('anon', 'public.<TABLE_NAME>', 'DELETE') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: anon has DELETE on <TABLE_NAME>';
  END IF;

  -- Sequence backing SERIAL/BIGSERIAL columns — REVOKE anon + authenticated USAGE
  -- unless the write path is a client-facing INSERT policy (rare).
  IF has_sequence_privilege('anon', 'public.<TABLE_NAME>_id_seq', 'USAGE') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: anon has USAGE on <TABLE_NAME>_id_seq';
  END IF;
  IF has_sequence_privilege('authenticated', 'public.<TABLE_NAME>_id_seq', 'USAGE') THEN
    RAISE EXCEPTION 'VQ.GRANTS FAIL: authenticated has USAGE on <TABLE_NAME>_id_seq (writes should be service_role only unless a self-INSERT policy exists)';
  END IF;
END $vq_grants$;
```

## Matching REVOKE block in the migration itself

Pair with these REVOKEs in the migration (before COMMIT):

```sql
-- Baseline grant closure per docs/development/migration-verification-template.md.
-- Supabase's ALTER DEFAULT PRIVILEGES grants anon + authenticated on new
-- public schema tables. Grants + RLS are independent gates; RLS default-deny
-- for missing policies is NOT equivalent to REVOKE at the ACL layer. Close
-- both.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.<TABLE_NAME> FROM authenticated;
REVOKE ALL ON public.<TABLE_NAME> FROM anon;
REVOKE ALL ON SEQUENCE public.<TABLE_NAME>_id_seq FROM anon, authenticated;
```

**KEEP `SELECT` for authenticated** — SELECT policies (admin_select, scoped_select) need a
table grant to have anything to gate. The RLS qual restricts to row-level.

**service_role bypasses grants** — writes from webhook / DEFINER RPC unaffected.

**If authenticated writes ARE intentional** for the table (self-INSERT policy, etc.), skip the
`INSERT` REVOKE and document why in the migration header. The verification block for that verb
gets commented out with a matching WHY comment.

## Explicit grants for tables that DO allow authenticated writes

For tables with a client-side write path (manager/CA/resident INSERT from their portal, gated
by RLS), the migration must **explicitly GRANT everything the table needs — including sequence
USAGE.** Inherited defaults are gone by design post-grant-remediation
([20260722_grant_remediation_deny_by_default.sql](../../migrations/20260722_grant_remediation_deny_by_default.sql)).
Not relying on inherited defaults is the discipline that never breaks: even where defaults
happen to preserve what you need today, one future migration could revoke them, and every
table would break silently. Grant explicitly.

Every new table with authenticated writes needs BOTH:

```sql
-- Table-level: whatever verbs the RLS policies allow
GRANT SELECT, INSERT, UPDATE ON public.<TABLE_NAME> TO authenticated;

-- Sequence-level: USAGE (for nextval() on BIGSERIAL default) + SELECT (for currval/RETURNING)
GRANT USAGE, SELECT ON SEQUENCE public.<TABLE_NAME>_id_seq TO authenticated;
```

And matching positive assertions in `VQ.GRANTS` (in addition to the anon negative assertions):

```sql
IF NOT has_table_privilege('authenticated', 'public.<TABLE_NAME>', 'INSERT') THEN
  RAISE EXCEPTION 'VQ.GRANTS FAIL: authenticated missing INSERT — client-side write path broken';
END IF;
IF NOT has_sequence_privilege('authenticated', 'public.<TABLE_NAME>_id_seq', 'USAGE') THEN
  RAISE EXCEPTION 'VQ.GRANTS FAIL: authenticated lacks sequence USAGE — INSERT will fail at nextval()';
END IF;
```

**The sequence-USAGE assertion is the load-bearing catch.** Without it, "granted the table but
forgot the sequence" ships and manifests only when a manager tries to use the feature — often
several commits later. First surfaced during DNT Commit 2 review (2026-07-23).

## What NOT to skip

- **Never skip anon assertions.** Anon writes on a public schema table are almost never
  intended. Anon SELECT is almost never intended.
- **Never skip the sequence check.** If a SERIAL column exists, the sequence grants need
  the same discipline — an `INSERT` grant without `USAGE` on the sequence is often a bug too.

## Behavioral probes: read the schema, don't remember it

**Three probe failures in July 2026 traced to the same pattern:** SQL written against a
remembered schema instead of a read one.

1. `audit_logs_id_seq` — assumed BIGSERIAL; sequence didn't exist (uuid PK). Migration aborted at apply.
2. `tos_acceptances.created_at` — assumed the column existed; it didn't. Query aborted.
3. `violations.driver_email` + `violations.timestamp` — both guessed; real columns are `driver_name`
   (which is the *offending vehicle's* driver, not an actor column at all — attribution lives in
   `audit_logs`) and `created_at`. Verification aborted mid-run.

Every failure was loud (Postgres 42703 UNDEFINED_COLUMN / 42P01 UNDEFINED_TABLE), but each cost a
round trip and Jose's time. The fix is trivial and mechanical.

**Rule for every migration author (human or Claude):** for any table your migration or verification
touches that you haven't read in-session, query `information_schema.columns` FIRST:

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = '<the_table>'
ORDER BY ordinal_position;
```

Then write the INSERT / UPDATE / SELECT statement against that output. Memory is not a substitute —
especially for tables whose `CREATE TABLE` predates the migrations directory (`companies`,
`user_roles`, `properties`, `violations`, `audit_logs`, `platform_settings`, `residents`,
`vehicles`, `visitor_passes`), where grep can't find the schema and only a live query has ground
truth.

**Applies especially to behavioral probes in verification files:** an incorrect column name aborts
the verification mid-run, and any state the probe INSERTed before the abort must survive txn
rollback cleanly — which requires the DO block's atomicity discipline (all probe writes in one
DO block, defensive `WHEN OTHERS` cleanup).

## Cross-references

- [scripts/audit-public-grants-2026-07-22.sql](../../scripts/audit-public-grants-2026-07-22.sql) —
  the retroactive audit that pulled B182/B183 off backlog + surfaced the pattern.
- [docs/audits/2026-07-22-public-grants-audit.md](../audits/2026-07-22-public-grants-audit.md) —
  triage doc for that audit.
- `feedback_revoke_anon_default_on_new_tables.md` (memory) — codified rule.
- `feedback_revoke_from_anon_explicitly.md` (memory) — `REVOKE PUBLIC` alone may leave anon.
- [migrations/20260722_provisioning_failures_grants_hardening.sql](../../migrations/20260722_provisioning_failures_grants_hardening.sql) —
  reference implementation of the additive REVOKE fix pattern.
- [migrations/20260722_order_forms_verification.sql](../../migrations/20260722_order_forms_verification.sql) —
  reference implementation of the VQ.GRANTS shape (as VQ.H in that file).

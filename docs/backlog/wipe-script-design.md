# Backlog — Test/demo wipe script design

**Filed:** 2026-07-20 during `company_env` console toggle work.
**Scope:** the wipe script itself does not exist yet. Column + refuse-if-live
primitive (`production_company_count()`) shipped 2026-07-08 as scaffolding.
This doc captures the design so the script + its safeguards ship together,
not in pieces.

## Context

- `companies.company_env` enum (`'production' | 'test' | 'demo'`) shipped
  2026-07-08 via
  [migrations/20260708_seed_wipe_layer1_company_env.sql](../../migrations/20260708_seed_wipe_layer1_company_env.sql).
- `production_company_count()` refuse-if-live helper shipped same migration
  (SECURITY DEFINER, service_role only). **Currently ZERO callers** across
  `app/`, `scripts/`, `docs/` — grep confirmed 2026-07-20. Scaffolding for a
  future wipe runbook that has not been written.
- **Nothing is currently blocked.** A1's presence has no effect on any live
  tooling. This is a "write the wipe" backlog item, not an "unblock the
  wipe" one.

## Design summary

**Wipe script pattern (four steps, in order):**

1. **Compute the delete-set.** `SELECT id FROM companies WHERE company_env
   = 'test'` — the intended targets. Never operates on `demo` (deny-write
   RLS) or `production` (structurally out of scope).
2. **Assert no production overlap in the delete-set.**
   `production_companies_in_delete_set(delete_ids) = 0`. Belt. Blocks the
   wrong-`company_env`-label class: if a row's env accidentally got
   flipped to test, this helper catches it — because it asks about the
   *specific delete-set*, not about production existing globally.
3. **Assert every ID in an explicit `WIPE_ALLOWLIST` array.**
   `SELECT count(*) FROM unnest(delete_ids) id WHERE id NOT IN (
   SELECT id FROM allowlist) = 0`. Suspenders. Blocks the
   single-mislabeled-row class: even if `company_env` is wrong on one row
   AND `production_companies_in_delete_set` missed it (belt bypass), the
   ID allowlist refuses because that row's ID isn't approved.
4. **Then and only then:** `DELETE FROM ... WHERE id = ANY(delete_ids)`
   cascade through downstream FKs (or per-table deletes in dependency
   order).

Belt + suspenders. A single mislabeled row can't cascade — either the
env-scoped assertion catches it OR the allowlist catches it. Both must
fail for a real customer to be affected.

## What to build (in order, when the wipe script gets written)

### Part 1 — New DEFINER helper (small migration)

```sql
CREATE OR REPLACE FUNCTION public.production_companies_in_delete_set(p_ids BIGINT[])
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $func$
  SELECT count(*)::bigint
  FROM companies
  WHERE id = ANY(p_ids) AND company_env = 'production'
$func$;

REVOKE ALL ON FUNCTION public.production_companies_in_delete_set(BIGINT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.production_companies_in_delete_set(BIGINT[]) FROM anon;
REVOKE ALL ON FUNCTION public.production_companies_in_delete_set(BIGINT[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.production_companies_in_delete_set(BIGINT[]) TO service_role;
```

Companion `SCHEMA_` audit + verification file per discipline.

**Do not drop `production_company_count()`.** Unused today but has a
shipped ACL/GRANT surface. Still useful for a status display later
("real customers on this instance: N"). Additive-not-replace.

### Part 2 — The wipe script itself

`scripts/wipe-test-data.ts` (naming TBD). Skeleton:

```typescript
#!/usr/bin/env tsx
// scripts/wipe-test-data.ts — test tenant wipe with belt+suspenders.

import { createClient } from '@supabase/supabase-js'

// 🔴 SUSPENDERS — explicit allowlist. Only IDs in this array can be
// deleted, even if their company_env = 'test'. Update this whenever
// a new test/demo tenant is created and belongs in the routine wipe.
const WIPE_ALLOWLIST: number[] = [
  // e.g. Test-PM, Test-ENF, Test-LEGACY IDs — update from Jose's
  // grouping query output before running.
]

const URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

async function main() {
  const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })

  // Step 1 — compute the delete-set.
  const { data: candidates } = await admin
    .from('companies').select('id, name, company_env')
    .eq('company_env', 'test')
  if (!candidates || candidates.length === 0) {
    console.log('No test-env companies found. Nothing to wipe.')
    return
  }
  const deleteIds = candidates.map(c => c.id)
  console.log(`Candidates (env=test): ${deleteIds.length}`)
  for (const c of candidates) console.log(`  · ${c.id} ${c.name}`)

  // 🔴 BELT — assert no production overlap in the delete-set.
  const { data: prodCheck, error: pcErr } = await admin
    .rpc('production_companies_in_delete_set', { p_ids: deleteIds })
  if (pcErr) { console.error('BELT FAILED to call:', pcErr.message); process.exit(2) }
  const prodInSet = Number(prodCheck ?? 0)
  if (prodInSet !== 0) {
    console.error(`🔴 BELT ASSERT FAILED: ${prodInSet} production row(s) in delete-set. Aborting.`)
    process.exit(3)
  }
  console.log('  ✅ belt: 0 production rows in delete-set')

  // 🔴 SUSPENDERS — assert every ID is in the allowlist.
  const unlistedIds = deleteIds.filter(id => !WIPE_ALLOWLIST.includes(id))
  if (unlistedIds.length > 0) {
    console.error(`🔴 SUSPENDERS ASSERT FAILED: ${unlistedIds.length} ID(s) not in WIPE_ALLOWLIST: ${unlistedIds.join(', ')}. Aborting.`)
    console.error('   Either add them to WIPE_ALLOWLIST intentionally, or investigate why they exist.')
    process.exit(4)
  }
  console.log(`  ✅ suspenders: all ${deleteIds.length} IDs in WIPE_ALLOWLIST`)

  // Step 4 — actual delete. Order per FK dependency chain (details TBD;
  // may require per-table wipe helpers or cascade discipline).
  // ...
}

main().catch(e => { console.error(e); process.exit(1) })
```

### Part 3 — Ops discipline

- **Never run in prod without a dry-run first.** Dry-run mode prints the
  delete-set + both assertions but does not execute DELETE.
- **The allowlist is code, not config.** Changes require a code review, not
  a runtime override. That's the point — a runtime override defeats the
  suspenders.
- **Log every wipe** to `audit_logs` with a distinct action name
  (`SCHEMA_WIPE_TEST_DATA` or similar) capturing: delete_ids array,
  allowlist snapshot, both assertion results, per-table row counts deleted.
  Forensic trail for after-the-fact review.

## What NOT to build ahead of time

- **The `production_companies_in_delete_set` helper standalone.** Building
  it before the wipe script exists = unused scaffolding, ACL/GRANT surface
  that has to be maintained, no test coverage from a real caller. Ship
  it with the script.
- **Do not modify `production_company_count()`.** Unused, harmless, has a
  shipped ACL surface, still useful for future status displays. Leave
  alone.
- **Do not remove the shipped `.eq('company_env', 'production')` filters
  in dunning cron + Stripe webhook handlers.** Those are load-bearing
  today (skip test/demo from billing paths), independent of wipe design.

## Priority

**Low — deferred to whenever Jose actually needs to run a wipe.** No
current blocker; A1's presence doesn't affect anything today. Estimated
effort when picked up: half-day for the helper migration + script + dry-run
mode + audit logging, plus whatever per-table cascade helpers are needed
(depends on how FK dependency chain wants to be structured — could be part
of the [`property_id` FK migration](project_fk_property_id_migration.md)
work if that lands first).

## Cross-references

- [migrations/20260708_seed_wipe_layer1_company_env.sql](../../migrations/20260708_seed_wipe_layer1_company_env.sql)
  — Layer 1 (column + refuse-if-live RPC)
- `cc4ffa4` — Super-admin console `company_env` filter toggle
  (2026-07-20)
- [project_fk_property_id_migration.md](../../.claude/projects/-Users-ALC-a1-parking/memory/project_fk_property_id_migration.md)
  — the FK migration retires text-keyed cascades; may affect what per-table
  delete order looks like

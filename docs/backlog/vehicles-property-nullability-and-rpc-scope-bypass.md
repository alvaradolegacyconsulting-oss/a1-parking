# Backlog — `vehicles.property` nullability + two defects surfaced by D-8

**Filed:** 2026-08-09 (deactivation-email arc D-8 probe).
**Priority:** P2 (nullability decision) · **P1 (RPC scope-gate bypass)**.

Three related items, one root cause: `vehicles.property` is nullable at
the DB level despite every code path assuming it is populated. D-8's
probe of the malformed-anchor branch found each of them.

## 1. Should `vehicles.property` be NOT NULL?

**Empirical result (2026-08-09):** `UPDATE public.vehicles SET property = NULL
WHERE plate = 'PD0004'` returned `825 | PD0004 | null` — no constraint
violation. The column is nullable.

**Convention says otherwise:**
- Every INSERT path in the app populates `property` from the manager
  session's `manager.name` or the resident's `property` string
- Every read filters on `.ilike('property', ...)` — a NULL-property
  row is filtered out
- Enforcement + CRM + plate-lookup surfaces all key on property
- The `deactivate_vehicle` RPC scope-gate joins on `lower(trim(property))`

If nothing intends to write NULL, a NOT NULL constraint is the durable
fix. Turns the "unreachable under convention" assumption into an
enforced invariant. Two prerequisites:

1. **Audit for existing NULL-property rows** (see item 3 below — same
   query surfaces the invisible-vehicle risk)
2. **Backfill or delete** any NULL rows found before adding the
   constraint

Then: `ALTER TABLE public.vehicles ALTER COLUMN property SET NOT NULL;`

After the constraint lands: delete the route's `!v.property → failed`
branch. It becomes genuinely unreachable and the correctly-labeled
schema-drift guard is no longer needed.

## 2. 🔴 `deactivate_vehicle` RPC scope-gate silently passes NULL property — **FIXED 2026-08-09**

**Status:** SHIPPED in
[migrations/20260809_deactivate_vehicle_null_property_scope_hardening.sql](../../migrations/20260809_deactivate_vehicle_null_property_scope_hardening.sql).
Two-layer fix:
- Layer 1: distinct `vehicle_property_missing` error class BEFORE the
  scope check.
- Layer 2: `IF NOT COALESCE(v_in_scope, false) THEN` on the scope
  decision (defense-in-depth belt for any future column added to the
  gate that could return NULL).

**Sibling enumeration** delivered in
[definer-rpc-scope-gate-null-audit-2026-08-09.md](definer-rpc-scope-gate-null-audit-2026-08-09.md).
One direct confirmed-vulnerable sibling (`approve_vehicle`) plus five
"needs nullability verification" RPCs keyed on `user_roles.company`
or `user_roles.property` — Jose queries included in the audit doc.

This section stays as the deactivate_vehicle-specific diagnosis record.


Discovered during D-8 diagnosis. The RPC at
[migrations/20260806_deactivate_vehicle_rpc.sql:138](../../migrations/20260806_deactivate_vehicle_rpc.sql#L138):

```sql
v_in_scope := lower(trim(v_vehicle.property)) IN (
  SELECT lower(trim(p)) FROM unnest(v_caller_properties) AS p
);
-- ...
IF NOT v_in_scope THEN
  RETURN jsonb_build_object('error', 'vehicle_out_of_scope', ...);
END IF;
```

**Postgres semantics:** `NULL IN (list of non-null values)` returns
NULL (not false). `NOT NULL` is NULL. `IF NULL THEN ...` skips the
branch. So when `v_vehicle.property IS NULL`:
- `v_in_scope` is NULL
- The scope error branch never fires
- The UPDATE proceeds

**Consequence:** A manager can deactivate a NULL-property vehicle
that RLS would otherwise hide from them. Authority-scope bypass by
NULL. The company_admin branch at :146-150 has the same shape and
same bug.

### Fix

Coalesce, or add an explicit null-check:

```sql
IF NOT COALESCE(v_in_scope, false) THEN
  RETURN jsonb_build_object('error', 'vehicle_out_of_scope', ...);
END IF;
```

Or better — reject the NULL-property case explicitly, before the
scope check:

```sql
IF v_vehicle.property IS NULL OR length(trim(v_vehicle.property)) = 0 THEN
  RETURN jsonb_build_object(
    'error', 'vehicle_property_missing',
    'hint',  'Vehicle has no property — cannot verify scope. Data-fix required.'
  );
END IF;
```

Same treatment for `approve_vehicle` — needs a check whether that RPC
has the same pattern.

### Verification when picked up
- Non-null property, in scope → success (baseline)
- Non-null property, out of scope → `vehicle_out_of_scope` (baseline)
- **NULL property → `vehicle_property_missing`** (was: silent pass)
- Same for `company_admin` branch

### Related
- [feedback_rls_denials_return_empty_not_error.md](../../../.claude/projects/-Users-ALC-a1-parking/memory/feedback_rls_denials_return_empty_not_error.md)
  — same class: absence of denial is not permission
- [feedback_platform_states_facts_not_permissions.md](../../../.claude/projects/-Users-ALC-a1-parking/memory/feedback_platform_states_facts_not_permissions.md)

## 3. NULL-`resident_email` vehicles are invisible in the manager portal — **RESOLVED**

**Status:** 2026-08-09 CLOSED by Jose audit + Mateo confirmation.

- Audit query returned ZERO NULL-`resident_email` rows across all
  properties.
- Legacy manager Add-Vehicle path (with the "Unit-level / shared"
  owner-picker option) has been **discontinued**; live users are on
  the CRM path, which requires an email.
- Historical NULL rows had been cleaned up in a prior sweep.

No invisible vehicles exist and no current producer creates them.
The `vehicles.resident_email` column remains nullable at the schema
level, but the concern that active enforceable vehicles could be
unmanageable is resolved.

Kept in this file as a resolution record; if `vehicles.resident_email`
is ever made NOT NULL as a hardening step, cite this closure.

## Related

- Deactivation-email arc D-8 (2026-08-09) — surfaced all three items
- [vehicles-status-is_active-divergence.md](vehicles-status-is_active-divergence.md)
  — the wider class of vehicle-column-consistency gaps
- [cascade-reason-stamping.md](cascade-reason-stamping.md) — sibling
  cascade-path defect

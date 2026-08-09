# DEFINER-RPC scope-gate NULL-bypass audit — 2026-08-09

**Trigger:** Mateo Aug 9 D-8 review. `deactivate_vehicle` was found to
silently pass NULL-property vehicles through its manager scope-gate
because `NULL IN (list)` returns NULL, `NOT NULL` is NULL, and
`IF NULL THEN reject END IF;` skips the branch (Postgres 3-valued
logic).

**Ask:** enumerate every `SECURITY DEFINER` RPC whose scope gate is
assigned from `IN (...)`, `EXISTS (...)`, `ANY (...)`, or any
NULL-producing operator, and say for each whether the compared column
is nullable.

**Sweep methodology:** grep every `CREATE ... FUNCTION` +
`SECURITY DEFINER` block in `migrations/*.sql`; for each latest-def
RPC, read the body; for vulnerable-shape gates, cite the compared
column's nullability from its `CREATE TABLE` or nearest
`ALTER TABLE ... NOT NULL`.

**Vulnerable-shape rubric:**
- `v_flag := <expr> IN (...)` where `<expr>` can be NULL
- `v_flag := <expr> [~~*|=] ANY(<array>)` where `<expr>` can be NULL
- Followed by `IF NOT v_flag THEN reject END IF;` (no `COALESCE`,
  no explicit `IS NULL` presence gate upstream)

Safe shapes:
- `SELECT EXISTS(...) INTO v_flag` — EXISTS is boolean-not-null
- `IF NOT COALESCE(v_flag, false) THEN reject`
- `IF v_flag IS NOT TRUE THEN reject`
- Presence gate: `IF v_expr IS NULL OR length(trim(v_expr)) = 0 THEN reject_distinct_error END IF;` **before** the scope check

## CONFIRMED VULNERABLE

| RPC | Location | Assignment | Column | Status |
|---|---|---|---|---|
| `deactivate_vehicle(BIGINT,TEXT,TEXT)` | [migrations/20260806_deactivate_vehicle_rpc.sql:138](../../migrations/20260806_deactivate_vehicle_rpc.sql#L138) | `v_in_scope := lower(trim(v_vehicle.property)) IN (SELECT lower(trim(p)) FROM unnest(v_caller_properties) AS p)` | `vehicles.property` (nullable — confirmed empirically 2026-08-09 D-8) | ✅ **FIXED** — [migrations/20260809_deactivate_vehicle_null_property_scope_hardening.sql](../../migrations/20260809_deactivate_vehicle_null_property_scope_hardening.sql) (Layer 1 + Layer 2) |
| `approve_vehicle(BIGINT,TEXT)` | [migrations/20260628_permit_door_piece1_manager_approve_authority.sql:341](../../migrations/20260628_permit_door_piece1_manager_approve_authority.sql#L341) | `v_in_scope := v_vehicle.property ~~* ANY(v_caller_properties)` | `vehicles.property` (same column) | 🔴 **PENDING** — direct copy-paste sibling; needs identical fix (presence gate + `COALESCE`). Manager branch only; company_admin branch uses `SELECT EXISTS` which is boolean-not-null. |

## NEEDS NULLABILITY VERIFICATION (Jose queries below)

If either column is nullable in production, every RPC in the group
below is confirmed-vulnerable — same fix template.

### Group A — `user_roles.company` nullable?

**Jose query (Test Legacy SQL editor):**
```sql
SELECT column_name, is_nullable, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'user_roles'
   AND column_name  = 'company';
```

| RPC | Location | Pattern |
|---|---|---|
| `set_manager_approve_permission` | [migrations/20260628_permit_door_piece1_manager_approve_authority.sql:182](../../migrations/20260628_permit_door_piece1_manager_approve_authority.sql#L182) | `IF NOT (v_target_company ~~* v_caller_company) THEN`; `v_caller_company` guarded, `v_target_company` not. NULL-target-company → gate skips → wrong-scope authority grant. |
| `assign_space`, `free_space`, `decommission_space`, `generate_spaces_from_pool` | [migrations/20260622_spaces_v1_1_multi_resident_schema.sql:319,448,569](../../migrations/20260622_spaces_v1_1_multi_resident_schema.sql), [migrations/20260621_spaces_v1_schema.sql:388,585,789](../../migrations/20260621_spaces_v1_schema.sql), [migrations/20260711_manager_bulk_add_spaces_extension.sql:111](../../migrations/20260711_manager_bulk_add_spaces_extension.sql#L111) | `IF v_space_company !~~* v_company THEN` — no `v_company IS NULL` guard. NULL-caller-company → `anything !~~* NULL` = NULL → gate skips → cross-company writes possible. |

### Group B — `user_roles.property` nullable?

**Jose query:**
```sql
SELECT column_name, is_nullable, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'user_roles'
   AND column_name  = 'property';
```

| RPC | Location | Pattern |
|---|---|---|
| `get_my_effective_active` | [migrations/20260808_get_my_effective_active_row_precedence.sql:173](../../migrations/20260808_get_my_effective_active_row_precedence.sql#L173) | `IF NOT (scope_property = ANY(v_properties)) THEN RETURN FALSE`; NULL-property-array → `scope_property = ANY(NULL)` = NULL → gate skips → returns TRUE (effectively-active) for a scope-empty manager. |

**Note:** the manager branch of `deactivate_vehicle` and `approve_vehicle`
BOTH source `v_caller_properties` from `get_my_properties()`, which
likely reads `user_roles.property` too. If that column is nullable,
`get_my_properties()` could return `NULL` or an array containing NULL,
compounding the vulnerability at a helper level.

## LIKELY SAFE (same shape, but compared column is `NOT NULL`)

Hygiene recommendation: add `COALESCE(v_flag, false)` anyway — cheap
defense against a future `ALTER TABLE ... DROP NOT NULL`.

| RPC | Location | Compared column | NOT NULL asserted at |
|---|---|---|---|
| `approve_space_request`, `decline_space_request` | [migrations/20260626_space_requests_v1.sql:356,495](../../migrations/20260626_space_requests_v1.sql) | `space_requests.property` | :91 |
| `approve_plate_change`, `decline_plate_change` | [migrations/20260703_slice4_vehicle_plate_changes.sql:316,394](../../migrations/20260703_slice4_vehicle_plate_changes.sql) | `vehicle_plate_changes.property` | :46 |
| `approve_guest_authorization_request`, `decline_guest_authorization_request` | [migrations/20260703_rt4_guest_auth_resident_submit.sql:289,382](../../migrations/20260703_rt4_guest_auth_resident_submit.sql) | `guest_authorizations.property` | 20260620_b214_guest_authorizations.sql:82 |

## NOT VULNERABLE — brief notes

- **B214 guest_authorizations write RPCs** (`create_/renew_/revoke_guest_authorization`): use `SELECT EXISTS(...)` + guarded `IS NULL` checks; `guest_authorizations.company` is NOT NULL.
- **DNT/tow guard RPCs** (`check_dnt_plate`, `pm_plate_lookup`, `set_violation_status`, `stamp_tow_ticket`, `regenerate_tow_ticket`): authorization gates use `v_authorized := EXISTS(...)` or inline `IF (NOT) EXISTS(...)` — EXISTS is boolean-not-null. Explicit `v_caller_company IS NULL` fail-closed sentinels present.
- **`set_driver_regenerate_permission`**: explicitly checks `v_driver_company IS NULL OR NOT (...)` — has the presence-gate.
- **`update_my_vehicle_cosmetic`, `mark_my_vehicle_declined_read`**: scope enforced inline in UPDATE's WHERE clause + `GET DIAGNOSTICS ROW_COUNT` + `RAISE` on 0 rows. NULL tuples never match → 0 rows → raise fires.
- **`submit_plate_change`, `submit_space_request`, `submit_guest_authorization_request`, `request_my_vehicle`**: resident-self scope derived server-side from `residents` keyed on `auth.jwt() ->> 'email'` — no client-supplied scope to bypass.
- **Spaces v1.1 read/helper RPCs** (`derive_space_allowed_plates`, `free_spaces_on_resident_deactivate`): driver-role-pin + EXISTS reads only.
- **`get_unit_occupancy_summaries`**: `IF NOT EXISTS(...)` — safe.
- **`delete_orphaned_pending_resident`**: scope encoded inline in DELETE WHERE with `p_property IS NULL OR ...` guard.
- **~90 other DEFINER RPCs**: role-only gates or scope keys resolved from `auth.jwt()` server-side.

## Priority for the follow-up commits

1. **P1 — approve_vehicle**: apply the identical Layer 1 + Layer 2 fix as `20260809_deactivate_vehicle_null_property_scope_hardening.sql`. Same file structure, same shape. Ship own commit.

2. **P1 — user_roles.company / user_roles.property nullability audit**: Jose runs both queries above. If either returns `is_nullable = YES`, immediately schedule fixes for Group A and/or Group B (5 RPCs at risk). Also may require hardening `get_my_properties()` at the helper level.

3. **P3 — LIKELY SAFE hygiene pass**: 6 RPCs. Optional `COALESCE(v_flag, false)` defense against future NOT NULL drops. Bundle as one commit.

## Related

- [vehicles-property-nullability-and-rpc-scope-bypass.md](vehicles-property-nullability-and-rpc-scope-bypass.md) — the D-8 diagnosis that surfaced this class
- Memory: [[feedback_sql_null_in_scope_gate_bypass]] · [[feedback_null_safe_operator_conflates_missing_row]]

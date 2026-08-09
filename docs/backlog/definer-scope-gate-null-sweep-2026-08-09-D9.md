# DEFINER scope-gate NULL-bypass sweep — 2026-08-09 (D-9)

**Purpose:** Mateo Aug 9 ask — comprehensive sweep classified by
**control-flow shape**, not by operator alone. Jose to size the week
from this. **Report only** — no fixes ship from this doc; triage first.

**Classifier rule (Mateo):**
> `IF NOT v_flag THEN reject` — **bypassable**: `NOT NULL` is NULL; `IF NULL THEN` skips
> `IF v_flag THEN proceed ELSE reject` — **safe**: `IF NULL THEN` skips `proceed`, falls to `ELSE reject`

Precedes the earlier narrower audit at
[definer-rpc-scope-gate-null-audit-2026-08-09.md](definer-rpc-scope-gate-null-audit-2026-08-09.md).

## Totals

| Metric | Count |
|---|---|
| DEFINER function declarations in `migrations/*.sql` | 306 |
| Unique DEFINER function names (latest-migration-wins) | 94 |
| Authorization-gated subset (has scope decision beyond bare role check) | ~40 |
| ✅ **Fixed** | 2 |
| 🔴 **Bypassable** (confirmed or suspected) | 13 |
| ⚠ **Needs data check** (nullability unverifiable from migrations tree) | 2 |
| ✅ **Safe** (all mechanisms considered) | ~19 |

## Findings — authorization-gated DEFINER functions

| # | Function | Migration:line | Gate expression | Control-flow shape | Compared column | Nullable? | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | `deactivate_vehicle(BIGINT,TEXT,TEXT)` | [migrations/20260809_deactivate_vehicle_null_property_scope_hardening.sql](../../migrations/20260809_deactivate_vehicle_null_property_scope_hardening.sql) | `COALESCE(v_in_scope,false)` + L1 presence gate | `IF NOT COALESCE(...) THEN reject` | `vehicles.property` | nullable (empirical) | ✅ **fixed 1e2e907** |
| 2 | `approve_vehicle(BIGINT,TEXT)` | [migrations/20260809_approve_vehicle_null_property_scope_hardening.sql:163](../../migrations/20260809_approve_vehicle_null_property_scope_hardening.sql#L163) | `COALESCE(v_in_scope,false)` + L1 presence gate | `IF NOT COALESCE(...) THEN reject` | `vehicles.property` | nullable (empirical) | ✅ **fixed 20260809 (this session)** |
| 3 | `set_manager_approve_permission(TEXT,BOOLEAN)` | [migrations/20260628_permit_door_piece1_manager_approve_authority.sql:182](../../migrations/20260628_permit_door_piece1_manager_approve_authority.sql#L182) | `NOT (v_target_company ~~* v_caller_company)` | `IF NOT expr THEN reject` | `user_roles.company` (target row) | ⚠ | 🔴 **bypassable** if user_roles.company nullable |
| 4 | `assign_space(BIGINT,TEXT)` | [migrations/20260622_spaces_v1_1_multi_resident_schema.sql:319](../../migrations/20260622_spaces_v1_1_multi_resident_schema.sql#L319) | `v_space_company !~~* v_company` | `IF expr THEN reject` (NULL skips) | `user_roles.company` (caller) | ⚠ | 🔴 **bypassable** if user_roles.company nullable |
| 5 | `free_space(BIGINT,TEXT,TEXT)` | [migrations/20260622_spaces_v1_1_multi_resident_schema.sql:448](../../migrations/20260622_spaces_v1_1_multi_resident_schema.sql#L448) | same | same | `user_roles.company` | ⚠ | 🔴 **bypassable** (same) |
| 6 | `decommission_space(BIGINT)` | [migrations/20260622_spaces_v1_1_multi_resident_schema.sql:569](../../migrations/20260622_spaces_v1_1_multi_resident_schema.sql#L569) | same | same | `user_roles.company` | ⚠ | 🔴 **bypassable** (same) |
| 7 | `reassign_space(BIGINT,TEXT)` | [migrations/20260621_spaces_v1_schema.sql:483](../../migrations/20260621_spaces_v1_schema.sql#L483) | `v_space_company !~~* v_company` | same | `user_roles.company` | ⚠ | 🔴 **bypassable** (same) |
| 8 | `update_space_metadata(...)` | [migrations/20260621_spaces_v1_metadata_rpc.sql:71](../../migrations/20260621_spaces_v1_metadata_rpc.sql#L71) | `v_space_company !~~* v_company` | same | `user_roles.company` | ⚠ | 🔴 **bypassable** (same) |
| 9 | `generate_spaces_from_pool(...)` | [migrations/20260711_manager_bulk_add_spaces_extension.sql:136](../../migrations/20260711_manager_bulk_add_spaces_extension.sql#L136) | `p_property <> ALL(COALESCE(v_caller_properties,ARRAY[]::TEXT[]))` | `IF expr THEN reject`; NULL element in array → ALL=NULL → skip | `user_roles.property` elements | ⚠ | 🔴 **bypassable** if array contains NULL elements (empty array protected by COALESCE) |
| 10 | `get_my_effective_active(TEXT)` @ companies-state check | [migrations/20260808_get_my_effective_active_row_precedence.sql:137](../../migrations/20260808_get_my_effective_active_row_precedence.sql#L137) | `v_company_state NOT IN ('active','past_due')` | `IF expr THEN return FALSE` — NULL skips → falls through returns TRUE | `companies.account_state` (NOT NULL at [20260520_b65_self_serve_signup_schema.sql:49](../../migrations/20260520_b65_self_serve_signup_schema.sql#L49)) BUT **variable is NULL when zero-row match** | zero-row bypass | 🔴 **bypassable** — missing / renamed companies row → grants effectively-active |
| 11 | `get_my_effective_active(TEXT)` @ property scope check | [migrations/20260808_get_my_effective_active_row_precedence.sql:173](../../migrations/20260808_get_my_effective_active_row_precedence.sql#L173) | `NOT (scope_property = ANY(v_properties))` | `IF expr THEN return FALSE` — NULL skips | `user_roles.property` (array) | ⚠ | 🔴 **bypassable** if user_roles.property nullable |
| 12 | `approve_space_request(BIGINT,BIGINT)` | [migrations/20260626_space_requests_v1.sql:356](../../migrations/20260626_space_requests_v1.sql#L356) | `NOT (v_request.property = ANY(get_my_properties()))` | `IF expr THEN reject` | `get_my_properties()` return | ⚠ | 🔴 **bypassable** if user_roles.property nullable (`space_requests.property` is NOT NULL at :91 but the helper output isn't guaranteed) |
| 13 | `decline_space_request(BIGINT,TEXT)` | [migrations/20260626_space_requests_v1.sql:495](../../migrations/20260626_space_requests_v1.sql#L495) | same | same | same | ⚠ | 🔴 **bypassable** (same) |
| 14 | `approve_plate_change(BIGINT)` | [migrations/20260703_slice4_vehicle_plate_changes.sql:316](../../migrations/20260703_slice4_vehicle_plate_changes.sql#L316) | `v_caller_role='manager' AND NOT (v_change.property ~~* ANY(get_my_properties()))` | `IF expr THEN reject` | `get_my_properties()` return | ⚠ | 🔴 **bypassable** (same) |
| 15 | `decline_plate_change(BIGINT,TEXT)` | [migrations/20260703_slice4_vehicle_plate_changes.sql:394](../../migrations/20260703_slice4_vehicle_plate_changes.sql#L394) | same | same | same | ⚠ | 🔴 **bypassable** (same) |
| 16 | `approve_guest_authorization_request(...)` | [migrations/20260703_rt4_guest_auth_resident_submit.sql:289](../../migrations/20260703_rt4_guest_auth_resident_submit.sql#L289) | `v_row.property ~~* ANY (SELECT unnest(get_my_properties()))` | `IF NOT v_property_ok THEN reject` | `get_my_properties()` elements | ⚠ | ⚠ **needs-data-check** — array-NULL element only |
| 17 | `decline_guest_authorization_request(...)` | [migrations/20260703_rt4_guest_auth_resident_submit.sql:382](../../migrations/20260703_rt4_guest_auth_resident_submit.sql#L382) | same | same | same | ⚠ | ⚠ **needs-data-check** (same) |

**~19 others**: `stamp_tow_ticket`, `set_violation_status`, `regenerate_tow_ticket`, `void_violation`, `check_dnt_plate`, `pm_plate_lookup`, `get_pm_ticket_summary`, `get_enforcement_insights`, `check_authorized_plate`, `get_unit_occupancy_summaries`, `super_admin_deactivate_company`, `super_admin_reactivate_company`, `set_driver_regenerate_permission`, `insert_user_role`, `delete_orphaned_pending_resident`, `update_my_company_tdlr`, `set_company_logo`, `get_company_admin_emails`, `create_/renew_/revoke_guest_authorization`, `update_my_vehicle_cosmetic`, `mark_my_vehicle_declined_read`, `update_my_resident_profile`, `submit_*` family — all ✅ **safe** via one of: `SELECT EXISTS(...) INTO v_flag` (bool-not-null), explicit `IS NULL` guard, `IF v_flag IS NOT TRUE THEN reject` / `IS DISTINCT FROM TRUE`, inline scope in DELETE/UPDATE WHERE with `GET DIAGNOSTICS`, admin-only role gate, or self-scoped via `auth.jwt()->'email'`.

## Nullability sources

- `vehicles.property` — no `CREATE TABLE` / no `SET NOT NULL` in migrations; core Supabase-init. Confirmed empirically nullable 2026-08-09 (D-8).
- `companies.account_state` — `NOT NULL DEFAULT 'configuring'` at [migrations/20260520_b65_self_serve_signup_schema.sql:49](../../migrations/20260520_b65_self_serve_signup_schema.sql#L49). But row-11's bypass is on the variable when zero-row match, not column-NULL — remains 🔴.
- `user_roles.company`, `user_roles.property`, `user_roles.is_active`, `residents.property` — no `CREATE TABLE` / `SET NOT NULL` in migrations tree. **Needs Jose queries below.**

## Jose queries — run in Test Legacy SQL Editor

```sql
-- Nullability of core columns the bypasses depend on
SELECT table_name, column_name, is_nullable, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND (table_name, column_name) IN (
     ('user_roles','company'),
     ('user_roles','property'),
     ('user_roles','is_active'),
     ('user_roles','can_approve_vehicles'),
     ('residents','property'),
     ('residents','is_active'),
     ('vehicles','property')
   )
 ORDER BY table_name, column_name;

-- Empirical NULL-array-element check for user_roles.property (TEXT[]):
SELECT COUNT(*) AS rows_with_null_element
  FROM public.user_roles
 WHERE property IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(property) e WHERE e IS NULL);

-- Empirical NULL-company / NULL-property counts per role:
SELECT role,
       COUNT(*) FILTER (WHERE company IS NULL)  AS null_company,
       COUNT(*) FILTER (WHERE property IS NULL) AS null_property_array,
       COUNT(*) FILTER (WHERE property IS NOT NULL AND array_length(property,1) IS NULL) AS empty_property_array,
       COUNT(*)                                 AS total
  FROM public.user_roles
 GROUP BY role
 ORDER BY role;

-- Companies-row-missing bypass surface for get_my_effective_active row 10:
SELECT COUNT(*) AS user_roles_pointing_to_missing_company
  FROM public.user_roles ur
 WHERE ur.company IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE lower(c.name) = lower(ur.company));
```

## Rough fix effort (bypassable set)

All bypassable rows share the same shape family already applied to `deactivate_vehicle` / `approve_vehicle`. Approximate LOC:

- **Rows 3–8** (`set_manager_approve_permission` + 5 spaces RPCs): `IF v_target_company IS NULL THEN raise` (or `v_company IS NULL`) before the `!~~*` / `~~*` check. ~5 LOC × 6 = ~30 LOC total, 1 commit.
- **Row 9** (`generate_spaces_from_pool` manager scope): strip NULL elements from `v_caller_properties` before `<> ALL(...)`, or `IF p_property IS NULL THEN raise`. ~5 LOC.
- **Rows 10–11** (`get_my_effective_active`): fail-CLOSED on missing companies row + on NULL/empty `v_properties`. ~6 LOC. **Highest blast radius** — every portal gate reads this.
- **Rows 12–15** (approve/decline space_request + plate_change manager branches): `COALESCE(get_my_properties(), ARRAY[]::TEXT[])` around `ANY(...)`, or `IF get_my_properties() IS NULL THEN reject`. ~4 LOC × 4 = ~16 LOC, 1 commit.
- **Rows 16–17** (approve/decline guest_authorization_request manager branches): only bypassable via NULL-element in array — if Jose's array-NULL check returns 0 rows, mark ✅ safe; else same COALESCE. ~2 LOC × 2.

**Estimate:** ~60–70 LOC across ~4 commits if Jose's `user_roles` columns come back nullable; ~10 LOC (just rows 10–11) if they come back NOT NULL. Either way `get_my_effective_active` should go first — every portal decision routes through it.

## Related

- [vehicles-property-nullability-and-rpc-scope-bypass.md](vehicles-property-nullability-and-rpc-scope-bypass.md) — the D-8 root diagnosis
- [definer-rpc-scope-gate-null-audit-2026-08-09.md](definer-rpc-scope-gate-null-audit-2026-08-09.md) — earlier narrower audit
- Memory: [[feedback_sql_null_in_scope_gate_bypass]] · [[feedback_null_safe_operator_conflates_missing_row]] · [[feedback_create_or_replace_drops_defaults]]

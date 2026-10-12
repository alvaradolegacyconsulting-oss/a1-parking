# Backlog — `properties_manager_update` has no column restriction

**Date filed:** 2026-10-12 · **Ruling:** Jose — file separately, not part of the physical-pass arc.
**Found while:** designing Piece 0's feature switches, which needed "managers read-only" and discovered the current RLS does not provide it.

## The policy

```sql
CREATE POLICY "properties_manager_update" ON public.properties
  FOR UPDATE TO authenticated
  USING      ( … ur.role = ANY (ARRAY['manager','leasing_agent'])
               AND properties.name = ANY (ur.property) )
  WITH CHECK ( … same predicate … )
```

`FOR UPDATE` with no column list, so **a manager or leasing agent can write every column on a property they are assigned to.** 32 columns today.

🔴 **`leasing_agent` is included.** That role is read-only almost everywhere else by design — the leasing-agent write-expansion trap is a named pattern in this codebase — and here it has the same write surface as a manager.

## What the WITH CHECK does and does not protect

It re-checks `properties.name = ANY (ur.property)` against the **new** row, which protects exactly one column by accident:

- **`name` — protected.** A rename to a value not in the manager's own `user_roles.property` array fails the WITH CHECK. Lucky, because `vehicles.property`, `residents.property`, `visitor_passes.property` and `guest_authorizations.property` are all text references to this name; a free rename would orphan every one of them. (This is the text-keyed fragility the `property_id` FK convention exists to close.)

- **`company` — NOT protected.** 🔴 The check never mentions it. A manager can set `company` to another company's name, which moves the property out of their own CA's portal and into a stranger's. Every `company`-scoped read — `residents_company_admin_read`, `company_admin_select_vehicles`, the CA plan card's property count, billing's `countActiveRecords` — follows it. **That is a cross-tenant data move performed by a manager**, and it is the finding I would fix first.

- **`is_active` — not protected.** A manager can deactivate their own property, or re-activate one a CA deactivated. No cascade fires from the column itself (the property cascade lives in `admin/page.tsx`, not a trigger), so the effect is scoping rather than data loss — but it is still a CA-level decision.

## The 32 columns, by who should own them

| should be **CA-only** | why |
|---|---|
| `company` | cross-tenant move, see above |
| `is_active` | property lifecycle; CA/admin decision |
| `auth_status`, `auth_document_url`, `auth_reference`, `auth_uploaded_by`, `auth_uploaded_at`, `auth_expires_at`, `auth_notes` | the property **authorization document** — legal evidence that the company may enforce there. A manager marking their own property authorized is the whole problem. |
| `authorization_pdf_path`, `authorization_expiration_date`, `authorization_notes` | same, older column set |
| `visitor_pass_limit`, `visitor_capacity` | policy caps the CA sets; a manager raising their own cap removes the control |
| `house_rules_text`, `house_rules_version`, `house_rules_effective_date` | versioned text with effective dates, shown to residents; version pinning is a legal-consent pattern here |
| `parking_tags_enabled`, `printable_visitor_passes_enabled` | **already closed** by Piece 0's trigger |

| reasonably **manager-editable** | |
|---|---|
| `address`, `city`, `state`, `zip` | day-to-day correctness |
| `pm_name`, `pm_phone`, `pm_email` | the on-site contact *is* the manager |
| `notes` | operational scratch |
| `name` | protected by the WITH CHECK already; leave it |
| `id`, `created_at`, `house_rules_updated_at`, `house_rules_updated_by_email` | system-maintained; not hand-edited either way |

## Recommended fix

Not column grants. Piece 0 already set the precedent and the reason: a narrowed `GRANT UPDATE (col, …)` works but silently makes every **future** column non-writable, with no error naming the cause — and column grants never appear in a `pg_policies` dump, so the next person auditing this table concludes managers can write everything.

**A `BEFORE UPDATE` trigger on `properties`** that refuses a change to any CA-only column unless the caller is `company_admin`/`admin`, with the same shape as `properties_feature_switch_guard` — which already exists, already handles the no-JWT (SQL/service-role) case, and would simply grow its column list. One trigger, one list, visible in `pg_trigger`.

Second, **drop `leasing_agent` from this policy** unless there is a reason for it. That is a separate, smaller decision and probably wants its own check of what leasing agents currently do on the property form.

## Gate when picked up

The positive control is the one that matters: a manager must still be able to edit `address` and `pm_phone`. A guard that refuses every manager UPDATE passes every negative test and breaks the manager portal — `verify:switches` already carries exactly that control for the two switches and is the model.

Add: a manager cannot change `company` (the cross-tenant case), cannot mark `auth_status` authorized, and cannot raise `visitor_pass_limit`.

## Related

- `migrations/20261012_piece0_property_feature_switches.sql` — the trigger to extend.
- [[feedback_leasing_agent_write_expansion_trap]]
- [[project_fk_property_id_migration]] — why `name` being protected matters.

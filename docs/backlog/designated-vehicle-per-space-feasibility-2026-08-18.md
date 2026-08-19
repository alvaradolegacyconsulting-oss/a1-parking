# Feasibility — designated vehicle per reserved space (display-only)

**Filed:** 2026-08-18. Origin: Green Acres AM Yesica Cuero via A1 (Amanda), Aug 18.
**Status:** Report only. Priority: not now — after A1 expansion (Miramar / Sugarberry / Southfork) settles.
**Scope decision (Mateo Aug 18):** DISPLAY-ONLY. Does not touch enforcement. Driver scans continue to authorize all approved vehicles at any of that resident's spaces.

## TL;DR

- Nullable `spaces.designated_vehicle_id BIGINT REFERENCES vehicles(id)` is decisively the smaller diff than an enum-add. Confirmed.
- 7 render surfaces need the chip; `derive_space_allowed_plates` stays untouched (architecturally correct per the v1.1 lock).
- Four of five lifecycle events need code — the fifth (plate change) auto-follows because the designation is id-keyed, not plate-text-keyed.
- New DEFINER RPC `set_space_designated_vehicle` for cross-table integrity, matching the tree's convention (RPC for validation, triggers for cascades).
- ~200 LOC across ~5 commits. Biggest unknown: resident-portal visibility (Mateo's preflight silent on this — decision needed).

## Q1 — Column vs enum

**Nullable column. Do not touch `spaces.type`.**

- `spaces.type` is `TEXT NOT NULL DEFAULT 'regular'` at [migrations/20260621_spaces_v1_schema.sql:103](../../migrations/20260621_spaces_v1_schema.sql#L103) — no DB CHECK; the six-value whitelist lives in `generate_spaces_from_pool` at [:691-704](../../migrations/20260621_spaces_v1_schema.sql#L691-L704) and in TS at [app/lib/spaces.ts:29](../../app/lib/spaces.ts#L29) (`SPACE_TYPES` const literal + `Record<SpaceType, …>` maps at :32, :43 — exhaustive-match sites).
- Enum-add would touch 20+ render sites: dashboard tiles ([manager/page.tsx:3875-3879](../../app/manager/page.tsx#L3875-L3879), [company_admin/page.tsx:5369-5373](../../app/company_admin/page.tsx#L5369-L5373)), filter dropdowns (:3955, :5424), add/edit selects (:4085, :4296, :5520, :5685), row cells (:3997, :4005, :5460), CA pool-generator counts (:5940, :6267, :6364, :6490). Each is "does this new value belong in the filter / dashboard / pool-gen?" — six times over.
- Nullable column adds zero exhaustive-match sites; no existing `spaces.type` reader breaks.
- Semantic separation: `type` is physical class; designation is orthogonal policy. Merging forces every render surface to distinguish two concerns from one column.

Id-keyed (`vehicles.id`), not plate-text-keyed: `approve_plate_change` UPDATEs `vehicles.plate` on the same row ([migrations/20260703_slice4_vehicle_plate_changes.sql:321](../../migrations/20260703_slice4_vehicle_plate_changes.sql#L321)) — designation follows plate rotation for free.

## Q2 — Surfaces to touch

`derive_space_allowed_plates` at [migrations/20260622_spaces_v1_1_multi_resident_schema.sql:621-691](../../migrations/20260622_spaces_v1_1_multi_resident_schema.sql#L621-L691) MUST stay untouched. It sits on the driver enforcement path only ([app/driver/page.tsx:1110-1115](../../app/driver/page.tsx#L1110-L1115)) and its locked invariant at [:5-27](../../migrations/20260622_spaces_v1_1_multi_resident_schema.sql#L5-L27) is that authorization derives from the vehicle, not the space. Manager designation is a separate read path (join `spaces.designated_vehicle_id → vehicles`); architecturally clean.

| Surface | File:line | Show designated vehicle? |
|---|---|---|
| Manager spaces list "Assigned to" cell | [app/manager/page.tsx:4005](../../app/manager/page.tsx#L4005) | Yes — chip after resident name |
| Manager `SpaceDetailModal` tied-resident cards | [app/components/SpaceDetailModal.tsx:217-269](../../app/components/SpaceDetailModal.tsx#L217-L269) | Yes — mark designated plate at :254-263 + picker in mutation section |
| Manager assign modal preamble | [app/manager/page.tsx:4126-4141](../../app/manager/page.tsx#L4126-L4141) | Yes — optional designation during add |
| CA spaces list row | [app/company_admin/page.tsx:5468](../../app/company_admin/page.tsx#L5468) | Yes (same shape) |
| CA `SpaceDetailModal` | shared component | Single change covers both portals |
| Manager PM CRM `SpacesPane`/`SpaceCard` | [app/components/PmResidentCrm.tsx:1626-1720](../../app/components/PmResidentCrm.tsx#L1626-L1720) | Yes — chip alongside Space {label} |
| Resident portal self-view | [app/resident/page.tsx:1126-1131](../../app/resident/page.tsx#L1126-L1131), [:1235-1250](../../app/resident/page.tsx#L1235-L1250) | 🔴 **Ask Mateo** — preflight silent |
| CSV export | [app/lib/residents-export.ts:89](../../app/lib/residents-export.ts#L89) | 🔴 Optional column — Miriam contract → sign-off needed |
| Driver | [app/driver/page.tsx:1110-1115](../../app/driver/page.tsx#L1110-L1115) | **No** (display-only invariant) |

Data plumbing: `CrmSpace` ([pm-crm.ts:18-26](../../app/lib/pm-crm.ts#L18-L26)) + `CrmResidentSpace` (:46-49) + `Space` ([spaces.ts:54-83](../../app/lib/spaces.ts#L54-L83)) need `designated_vehicle_id` + resolved plate/description. `fetchSpacesList` ([spaces.ts:175-250](../../app/lib/spaces.ts#L175-L250)) already round-trips for `space_residents`; add designated-plate resolve in the same pattern.

## Q3 — Lifecycle

**A. Vehicle deactivated / declined.** `deactivate_vehicle` ([migrations/20260806_deactivate_vehicle_rpc.sql:193-208](../../migrations/20260806_deactivate_vehicle_rpc.sql#L193-L208)) touches only `vehicles` — no existing cascade to `spaces`. **Recommendation: auto-clear** `designated_vehicle_id` (trigger on `vehicles.is_active` OR inside `deactivate_vehicle`). Designation pointing at a deactivated vehicle lies to the manager; NULL is graceful degradation ("any approved vehicle" = today's semantics). Cheap.

**B. Resident deactivated.** `free_spaces_on_resident_deactivate` ([migrations/20260622_spaces_v1_1_multi_resident_schema.sql:188-268](../../migrations/20260622_spaces_v1_1_multi_resident_schema.sql#L188-L268)) DELETEs `space_residents` rows and, on `v_remaining=0`, clears `assigned_to_resident_email`/`assigned_at`/`assigned_by_email` at :217-223. **Add `designated_vehicle_id = NULL` to that same UPDATE.** Note the co-resident case: `v_remaining > 0` means another resident still holds the space; if the designation was their vehicle it's fine, if it was the departing resident's it's now cross-resident stale. Options: (a) clear unconditionally, (b) clear only when the designated vehicle's `resident_email` matches the departing resident. (b) is safer, (a) is simpler.

**C. Plate change approved.** `approve_plate_change` at [migrations/20260703_slice4_vehicle_plate_changes.sql:321](../../migrations/20260703_slice4_vehicle_plate_changes.sql#L321) does `UPDATE vehicles SET plate = new_plate, status = 'active' WHERE id = vehicle_id` — same row, id preserved. **Id-keyed designation follows automatically. No code change.**

**D. Resident adds a new vehicle.** No path touches `spaces.designated_vehicle_id`. Existing designation still valid. Correct behavior. No code.

**E. Space reassigned to different resident.** 🔴 `reassign_space` was **DROPPED in v1.1** ([migrations/20260622_spaces_v1_1_multi_resident_schema.sql:159-166](../../migrations/20260622_spaces_v1_1_multi_resident_schema.sql#L159-L166)); the flow is now Free-all + Assign ([app/manager/page.tsx:4009-4023](../../app/manager/page.tsx#L4009-L4023)). `assign_space` at [:279-396](../../migrations/20260622_spaces_v1_1_multi_resident_schema.sql#L279-L396) is set-add — never clears sibling columns. Clear point is `free_space` at :465-483 (whole-space) and :493-499 (per-resident empties the set). **Add `designated_vehicle_id = NULL` in both branches AND in the trigger from B.** Missing any of these three is the cross-resident staleness landmine — worst failure mode for this feature.

## Q4 — Cross-table constraint

CHECK can't join. Convention in this tree: **cross-table integrity at the RPC layer, triggers reserved for cascades.**
- Existing `spaces` triggers: only `trg_spaces_property_trim` ([migrations/20260715_property_name_trim_triggers.sql:145](../../migrations/20260715_property_name_trim_triggers.sql#L145)), an unrelated trim guard.
- Existing RPC-layer validation examples: `assign_space` verifies resident active + at property inline ([migrations/20260622_spaces_v1_1_multi_resident_schema.sql:329-338](../../migrations/20260622_spaces_v1_1_multi_resident_schema.sql#L329-L338)); `deactivate_vehicle` verifies property scope; `approve_plate_change` verifies vehicle exists.

**Recommendation:** new DEFINER RPC `set_space_designated_vehicle(p_space_id BIGINT, p_vehicle_id BIGINT DEFAULT NULL)`. Validates: (a) caller role + scope; (b) vehicle_id resolves to a vehicle whose `resident_email` matches at least one row in `space_residents` for this space; (c) vehicle is `is_active=TRUE AND status='active'`; then UPDATEs. Passing NULL clears. Writes audit row matching the `AUTH_SPACE_ASSIGN`/`AUTH_SPACE_FREE` pattern at :382-392 / :472-482.

Single choke point. The three lifecycle events in Q3 close the cascade-staleness paths independently at their existing owners; the RPC only needs to defend the manager-write path.

## Q5 — Effort

- **Migration**: ~40 LOC column + comment + 3-line additions at three existing clear-sites + ~80 LOC for `set_space_designated_vehicle` RPC. Optional ~30 LOC trigger for vehicle-deactivate auto-clear.
- **App-side**: type extension (~5 LOC), fetch enrichment (~30 LOC across `spaces.ts` + `pm-crm.ts`), chip render at 4 sites (~30 LOC), picker component with empty-list handling (~80 LOC). ~150-200 LOC total.
- **Commit sequence (5)**: (1) migration + RPC + verification; (2) type + fetch enrichment; (3) SpaceDetailModal picker + display; (4) list-row chips (manager + CA + PM CRM); (5) CSV column + resident portal decision (or skip).
- **Biggest unknown**: resident-portal visibility. Adds a slice if yes (RLS visibility change + copy for the "not designated" empty case).

## Gaps / flags for Mateo

1. **Resident portal self-view** — preflight silent. Show designation to the resident or manager-only?
2. **CSV export column** — Miriam's export contract is documented ([app/lib/residents-export.ts:8-23](../../app/lib/residents-export.ts#L8-L23)). Adding "Designated Vehicle" needs sign-off.
3. **Vehicle-deactivate auto-clear** (Q3-A) — trigger or `deactivate_vehicle` RPC extension? Or accept the graceful-degradation path (NULL → any approved, no auto-clear)?
4. **Q3-B co-resident case** — clear designation unconditionally when the space frees, or only when the designated vehicle's owner is the departing resident? (b) is safer, (a) is simpler.
5. **Legacy `assigned_to_resident_email` is DEPRECATED** ([app/lib/spaces.ts:63-70](../../app/lib/spaces.ts#L63-L70), migration header [20260622...:57-66](../../migrations/20260622_spaces_v1_1_multi_resident_schema.sql#L57-L66)). Read the resident set via `space_residents`, NOT this column — critical for the picker and the constraint validation.
6. **Enum-path rejection rationale in migration header** — mirror the "reassign_space DROPPED" documentation pattern at [20260622...:159-166](../../migrations/20260622_spaces_v1_1_multi_resident_schema.sql#L159-L166) so a future maintainer doesn't re-litigate.
7. **Empty-list problem in the picker** — the resident-has-no-approved-vehicles branch already has a display precedent at [app/components/SpaceDetailModal.tsx:249-250](../../app/components/SpaceDetailModal.tsx#L249-L250). The picker copy must match Mateo's spec: "Don't see the vehicle? It needs to be registered to this resident first," + link to add-vehicle flow. This is the requirement most likely to be dropped in build.

## Related

- [spaces_v1_locked_design_june21_2026.md] — §3 assignment model, §5 enforcement stays plate-level
- v2 PM-space-resident-vehicle linkage backlog — add this as observed evidence for the roster-driven middle tier
- BACKLOG paid-visitor-parking feasibility Aug 9 — second signal in the same direction (finer space-level control)
- The R-1 workaround incident (C90247V not registered; four Dodges/Jeeps authorized; F-150 tow risk) — the concrete instance that surfaced this

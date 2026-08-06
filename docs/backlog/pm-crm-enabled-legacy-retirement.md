# Backlog — Retire `!PM_CRM_ENABLED` legacy render branches

**Filed:** 2026-08-04 during deactivation preflight (FOR MATEO thread).
**Priority:** MEDIUM. Reframed from "dead-code sweep" to a decision about giving up the legacy rollback path.

## The real question

**Retiring the `!PM_CRM_ENABLED` branches is a decision to give up the legacy CRM rollback path** — not just a dead-code sweep.

`PM_CRM_ENABLED = true` is hardcoded at [manager/page.tsx:83](app/manager/page.tsx#L83) as the lever. Every `!PM_CRM_ENABLED` block is dead code TODAY but survives so someone can flip the const to `false` and get the legacy Vehicles-tab / Residents-tab UI back.

## 🔴 The rollback lever isn't safe to pull

Flipping `PM_CRM_ENABLED` to `false` restores a UI that includes `removeVehicle` ([manager/page.tsx:2037](app/manager/page.tsx#L2037)) as the sole vehicle-deactivation surface, reachable via two "Remove" buttons at [:3152](app/manager/page.tsx#L3152) and [:4004](app/manager/page.tsx#L4004). `removeVehicle` writes `is_active=false` without touching `status` — the exact write pattern that generated the 8 divergent rows filed in [vehicles-status-is_active-divergence.md](./vehicles-status-is_active-divergence.md).

A rollback path that regenerates enforcement/display mismatches is not a safety net. **Pulling this lever would produce new tow risk within one manager session.**

The rollback-path failure mode inverts the safety argument: the branches exist to make an emergency fallback possible, and the fallback ships a known-defective UI. Either the fallback isn't emergency-safe (delete it), or it must be fixed to enforcement-parity first (rewrite the legacy buttons before ever flipping — bigger scope than the CRM they'd fall back from).

## Recommendation

**Delete both `!PM_CRM_ENABLED` branches + `removeVehicle` function + the `PM_CRM_ENABLED` const.** ~200 lines of legacy render + one unreachable function. The CRM has been the production path since B231 shipped; the fallback has never been exercised, and the one time we might exercise it, it makes things worse.

If a future fallback UI is wanted, build it against the current enforcement predicate — don't preserve an old one whose writers predate `check_resident_plate`.

## Scope

- Delete `activeTab === 'vehicles' && !PM_CRM_ENABLED` branch — [manager/page.tsx:2857](app/manager/page.tsx#L2857) through its close (~L3170)
- Delete `activeTab === 'residents' && !PM_CRM_ENABLED` branch — [manager/page.tsx:3777](app/manager/page.tsx#L3777) through its close (~L4200)
- Delete `removeVehicle` function — [manager/page.tsx:2037](app/manager/page.tsx#L2037)
- Delete the `PM_CRM_ENABLED` const at [:83](app/manager/page.tsx#L83) + the comment lines above it explaining the rollback ([:77-82](app/manager/page.tsx#L77-L82))
- Grep for other `PM_CRM_ENABLED` references in the tree; delete any conditional/comment that only exists to support the fallback

## Verification

Manual: manager portal Residents tab + Vehicles tab render identically to before (they were already using the `PM_CRM_ENABLED === true` branch); no behavioural change for any user. Build passes.

## Adjacent

- [vehicles-status-is_active-divergence.md](./vehicles-status-is_active-divergence.md) — the class of bug the legacy fallback would regenerate.
- Deactivation preflight FOR MATEO 2026-08-04 — the diagnostic that surfaced this. Consolidation commit 0 excludes `removeVehicle` because it's dead; this entry closes the loop.
- Note: `PM_CRM_ENABLED` still guards the `residents` and `vehicles` tabs' *conditional* mounts at [:3630](app/manager/page.tsx#L3630) and [:3710](app/manager/page.tsx#L3710) too. Those mount the CRM under `PM_CRM_ENABLED = true` — the code path we keep. Simplification is: remove the conditional (always mount) + delete the `!PM_CRM_ENABLED` else-branches.

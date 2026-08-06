// ══════════════════════════════════════════════════════════════════════
// app/lib/deactivation-reasons.ts
// Single source of truth for deactivation reason codes + labels +
// notification behaviour. SQL columns store the code as opaque text;
// TS is authoritative — do not add a CHECK constraint on
// residents.deactivation_reason or vehicles.deactivation_reason.
// See 20260805_deactivation_reason_columns.sql header for rationale.
// ══════════════════════════════════════════════════════════════════════
//
// ── DESIGN LOCKS ─────────────────────────────────────────────────────
//
// 1. Every entry carries `notifies: boolean`. The type system requires
//    it — a new reason cannot be added without deciding notify behaviour.
//
// 2. Resident and Vehicle reason SETS may share code strings with
//    DIFFERENT labels (`moved_out` = "Moved out / lease ended" for a
//    resident, "Resident moved out / lease ended" for a vehicle). All
//    lookup helpers are ENTITY-SCOPED. Do NOT reintroduce a flat
//    `Record<string, DeactivationReason>` — `Object.fromEntries` would
//    make it last-wins and the CRM would render a resident a vehicle's
//    label. Enforced at module load (see assertion below).
//
// 3. System reasons are in a SEPARATE constant, never surfaced in a
//    manager dropdown. Filtered defensively at runtime via
//    `isSystemReason()`. Cascade / trim / admin-cascade rows stamp
//    these codes so an audit reader can tell an automated action from
//    a human decision.
//
// 4. When `notifies: false`, the deactivation is bookkeeping (duplicate
//    merge, registered-in-error, self-request) and MUST NOT send an
//    email to the affected party. Unknown codes default to false
//    (default-deny) — better to skip a notification than send one on
//    an unrecognized code.
//
// ── LITERAL UNION TYPES ──────────────────────────────────────────────
//
// Codes are typed as literal unions, not `string`. A typo in a dropdown
// value or a write helper fails to COMPILE rather than fails to
// validate at runtime. Cheap on a list this stable.
// ══════════════════════════════════════════════════════════════════════

export type ResidentReasonCode =
  | 'moved_out'
  | 'lease_terminated'
  | 'not_authorized'
  | 'never_resided'
  | 'duplicate_record'
  | 'registered_in_error'
  | 'resident_requested'
  | 'other'

// Populated in Commit 3. Kept as a real union so the type checker
// already knows the vocabulary — a Commit 3 helper referencing a
// vehicle code that isn't in this union fails to compile.
export type VehicleReasonCode =
  | 'moved_out'
  | 'vehicle_sold'
  | 'plate_superseded'
  | 'registered_in_error'
  | 'not_permitted'
  | 'exceeds_allowance'
  | 'violation'
  | 'other'

export type SystemReasonCode =
  | 'cascade_resident_deactivated'
  | 'owner_trim'
  | 'admin_cascade'

export interface DeactivationReason<Code extends string = string> {
  readonly code:     Code
  readonly label:    string
  readonly notifies: boolean
}

// ── Resident-facing reasons (manager dropdown, ordered) ──────────────
export const RESIDENT_DEACTIVATION_REASONS: readonly DeactivationReason<ResidentReasonCode>[] = [
  { code: 'moved_out',             label: 'Moved out / lease ended',                          notifies: true  },
  { code: 'lease_terminated',      label: 'Lease terminated',                                 notifies: true  },
  { code: 'not_authorized',        label: 'No longer authorized by property',                 notifies: true  },
  { code: 'never_resided',         label: 'Never resided at this unit / invalid registration', notifies: true  },
  { code: 'duplicate_record',      label: 'Duplicate record — merged',                        notifies: false },
  { code: 'registered_in_error',   label: 'Registered in error',                              notifies: false },
  { code: 'resident_requested',    label: 'Requested by resident',                            notifies: false },
  { code: 'other',                 label: 'Other — note required',                            notifies: true  },
]

// ── Vehicle-facing reasons (Commit 3, 2026-08-06) ────────────────────
// SHARED CODES WITH RESIDENT LIST — DIFFERENT LABELS:
//   moved_out           resident: "Moved out / lease ended"
//                       vehicle:  "Resident moved out / lease ended"
//   registered_in_error resident: "Registered in error"
//                       vehicle:  "Registered in error / duplicate"
//   other               resident: "Other — note required"
//                       vehicle:  "Other — note required"
// Both `notifies` values MUST match across shared codes; module-load
// assertion below throws at import if they diverge. This commit is
// the first time that assertion does real work — verify it passes.
export const VEHICLE_DEACTIVATION_REASONS: readonly DeactivationReason<VehicleReasonCode>[] = [
  { code: 'moved_out',           label: 'Resident moved out / lease ended',           notifies: true  },
  { code: 'vehicle_sold',        label: 'Vehicle sold or no longer owned',            notifies: true  },
  { code: 'plate_superseded',    label: 'Plate changed — superseded by new registration', notifies: false },
  { code: 'registered_in_error', label: 'Registered in error / duplicate',            notifies: false },
  { code: 'not_permitted',       label: 'Not permitted under property rules',         notifies: true  },
  { code: 'exceeds_allowance',   label: 'Exceeds unit vehicle allowance',             notifies: true  },
  { code: 'violation',           label: 'Lease or parking violation',                 notifies: true  },
  { code: 'other',               label: 'Other — note required',                      notifies: true  },
]

// ── System reasons (NEVER manager-selectable) ─────────────────────────
export const SYSTEM_DEACTIVATION_REASONS: readonly DeactivationReason<SystemReasonCode>[] = [
  { code: 'cascade_resident_deactivated', label: '[system] cascade from resident deactivation', notifies: false },
  { code: 'owner_trim',                    label: '[system] B166 owner-trim',                    notifies: false },
  { code: 'admin_cascade',                 label: '[system] admin property/company cascade',     notifies: false },
]

// ── Precomputed per-entity lookups ───────────────────────────────────
const RESIDENT_BY_CODE: ReadonlyMap<ResidentReasonCode, DeactivationReason<ResidentReasonCode>> =
  new Map(RESIDENT_DEACTIVATION_REASONS.map(r => [r.code, r]))
const VEHICLE_BY_CODE: ReadonlyMap<VehicleReasonCode, DeactivationReason<VehicleReasonCode>> =
  new Map(VEHICLE_DEACTIVATION_REASONS.map(r => [r.code, r]))
const SYSTEM_BY_CODE: ReadonlyMap<SystemReasonCode, DeactivationReason<SystemReasonCode>> =
  new Map(SYSTEM_DEACTIVATION_REASONS.map(r => [r.code, r]))

// ── Module-load assertion ────────────────────────────────────────────
// A shared code across entities is fine (see design lock #2), but
// a shared code MUST NOT have differing `notifies`. If the resident
// list says `moved_out` notifies and the vehicle list ever says it
// doesn't, that's a divergence bug that would surface in a lookup
// only after the two lists were both consulted. Fail at module load
// instead — impossible state.
{
  const seen = new Map<string, { notifies: boolean; entity: string }>()
  const check = (entity: string, list: readonly DeactivationReason[]) => {
    for (const r of list) {
      const prior = seen.get(r.code)
      if (prior && prior.notifies !== r.notifies) {
        throw new Error(
          `deactivation-reasons: code "${r.code}" appears in both ${prior.entity} and ${entity} ` +
          `lists with differing notifies (${prior.notifies} vs ${r.notifies}). ` +
          `Shared codes may have different labels but MUST agree on notify behaviour.`
        )
      }
      seen.set(r.code, { notifies: r.notifies, entity })
    }
  }
  check('resident', RESIDENT_DEACTIVATION_REASONS)
  check('vehicle',  VEHICLE_DEACTIVATION_REASONS)
  check('system',   SYSTEM_DEACTIVATION_REASONS)

  // System codes must not overlap with resident/vehicle codes — they
  // exist precisely because they should never be manager-selectable.
  const humanCodes = new Set<string>([
    ...RESIDENT_DEACTIVATION_REASONS.map(r => r.code),
    ...VEHICLE_DEACTIVATION_REASONS.map(r => r.code),
  ])
  for (const r of SYSTEM_DEACTIVATION_REASONS) {
    if (humanCodes.has(r.code)) {
      throw new Error(
        `deactivation-reasons: system code "${r.code}" collides with a resident/vehicle code. ` +
        `System codes exist to be non-selectable — collision would let a manager pick it via a hand-crafted request.`
      )
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// Guards + lookups — ALL entity-scoped
// ══════════════════════════════════════════════════════════════════════

export function isValidResidentReason(code: string | null | undefined): code is ResidentReasonCode {
  return typeof code === 'string' && RESIDENT_BY_CODE.has(code as ResidentReasonCode)
}

export function isValidVehicleReason(code: string | null | undefined): code is VehicleReasonCode {
  return typeof code === 'string' && VEHICLE_BY_CODE.has(code as VehicleReasonCode)
}

export function isSystemReason(code: string | null | undefined): code is SystemReasonCode {
  return typeof code === 'string' && SYSTEM_BY_CODE.has(code as SystemReasonCode)
}

// Entity-scoped label lookup. Callers pass the entity because a code
// can appear on both lists with different labels — see design lock #2.
// Unknown code returns null so callers fall back to "No reason recorded"
// rather than rendering a raw code.
export function reasonLabel(
  entity: 'resident' | 'vehicle' | 'system',
  code: string | null | undefined,
): string | null {
  if (!code) return null
  switch (entity) {
    case 'resident': return RESIDENT_BY_CODE.get(code as ResidentReasonCode)?.label ?? null
    case 'vehicle':  return VEHICLE_BY_CODE.get(code as VehicleReasonCode)?.label ?? null
    case 'system':   return SYSTEM_BY_CODE.get(code as SystemReasonCode)?.label ?? null
  }
}

// Entity-scoped notifies lookup. Default-deny on unknown code. Callers
// pass the entity so `moved_out` on residents and `moved_out` on
// vehicles are looked up independently — no ambiguity even if the two
// lists later diverge on notify behaviour (the module-load assertion
// would catch that anyway, but the API keeps the boundary explicit).
export function reasonNotifies(
  entity: 'resident' | 'vehicle' | 'system',
  code: string | null | undefined,
): boolean {
  if (!code) return false
  switch (entity) {
    case 'resident': return RESIDENT_BY_CODE.get(code as ResidentReasonCode)?.notifies ?? false
    case 'vehicle':  return VEHICLE_BY_CODE.get(code as VehicleReasonCode)?.notifies ?? false
    case 'system':   return SYSTEM_BY_CODE.get(code as SystemReasonCode)?.notifies ?? false
  }
}

// `other` is the only reason with a required note; same rule on both
// entities. Doesn't need an entity scope because the semantics are
// keyed on the string 'other' itself, not on a label.
export function reasonRequiresNote(code: string | null | undefined): boolean {
  return code === 'other'
}

// Cap on manager-supplied note length. 256 chars is plenty for the
// intended use ("Moved out — forwarding address on file"). Enforced
// at the helper via slice + a friendly error; not enforced at the
// SQL layer (see COMMENT ON residents.deactivation_note).
export const DEACTIVATION_NOTE_MAX_LENGTH = 256

'use client'
import { useState, useEffect, useRef, useMemo } from 'react'
import { QRCodeCanvas } from 'qrcode.react'
import { QRLinkAffordance } from '../components/QRLinkAffordance'
import { printQRSign } from '../lib/qr-print'
import { supabase } from '../supabase'
import { logAudit } from '../lib/audit'
import { displayTowReason } from '../lib/tow-reasons'
// B70 → B75: manual plate lookup tab. hasFeature(MANAGER_PLATE_LOOKUP)
// gates visibility; the pm_plate_lookup RPC enforces role + property
// scoping server-side regardless. Flag is true on every tier across
// both tracks (B75 expanded from PM-only).
import { hasFeature, getCompanyContext } from '../lib/tier'
// Permit-Door Piece 1 §1/§2 — centralized vehicle-insert state helper
// (PM-Only → pending → approval is the metering chokepoint; all other
// tiers → active, preserving today's behavior).
import { initialVehicleState } from '../lib/vehicle-state'
import { eligibleAgainAt } from '../lib/visitor-pass-cap'
import { FEATURE_FLAGS } from '../lib/feature-flags'
import { PLATE_STATUS_META, type PlateStatus } from '../lib/plate-status'
import { escapeIlikeValue } from '../lib/supabase-query-escape'
import { formatTimestamp, formatDate, formatTime } from '../lib/format-time'
import { buildBulkApproveSummary } from '../lib/bulk-approve-summary'
import {
  callSyncOnAdd,
  trimDepartedResidentVehicles,
  listPendingVehiclesForUnit,
  approveVehiclesBatch,
  approveResidentWrite,
  approveVehicleWrite,
  declineResidentWrite,
  undeclineResidentWrite,
  declineVehicleWrite,
  runBulkApprove,
  deactivateResidentWrite,
  deactivateVehicleWrite,
} from '../lib/manager-crm-writes'
import SupportContact from '../components/SupportContact'
// AP-MANAGE-CLIENT (2026-07-23): standing authorization per-property manager.
// `manager` state IS a properties row (has .id + .name), so the component
// receives them directly. Multi-property gap inherited from exempt-plates
// pattern; see docs/backlog/manager-multi-property-settings-selector.md.
import AuthorizedPlatesManager from '../components/AuthorizedPlatesManager'
import {
  type GuestAuth,
  GUEST_AUTH_MAX_DAYS,
  todayIso,
  addDays,
  daysUntilExpiry,
  isExpiringSoon,
  findOverlappingActiveAuth,
  fetchActiveGuestAuths,
  guestAuthDisplayStatus,
} from '../lib/guest-auth'
// Spaces v1 — dashboard-primary architecture with filtered/paginated list.
// All mutations route through the 6 DEFINER RPCs (assign/reassign/free/
// generate/decommission/update_space_metadata). NO direct table writes
// (the legacy saveSpace() direct UPDATE has been removed; B225-class
// write closed by construction).
import {
  type Space,
  type SpaceType,
  type ListFilters,
  type ResidentOption,
  SPACE_TYPES,
  TYPE_LABELS,
  PAGE_SIZE_MOBILE,
  PAGE_SIZE_DESKTOP,
  fetchOccupancyDashboard,
  fetchSpacesList,
  fetchActiveResidentsAtProperty,
  residentDisplay,     // legacy single-email helper; still used for pre-v1.1 callers (none after this commit)
  residentDisplayList, // v1.1 multi-resident list-version (the 3 reader sites in this file migrate to this)
} from '../lib/spaces'
import SearchableResidentPicker, { type SearchableResidentPickerResult } from '../components/SearchableResidentPicker'
import DeactivateResidentModal, { type CoResident } from '../components/DeactivateResidentModal'
import DeactivateVehicleModal from '../components/DeactivateVehicleModal'
import ReapprovalOrphansModal, { type OrphanPlate, type ReapprovalOrphansConfirmArgs } from '../components/ReapprovalOrphansModal'
import AddVehicleForResidentModal, { type AddVehiclePayload, type AddVehicleSubmitResult } from '../components/AddVehicleForResidentModal'
import PropertyWarningsPanel from '../components/PropertyWarningsPanel'
import { computePropertyWarnings } from '../lib/property-warnings'
import SpaceDetailModal from '../components/SpaceDetailModal'
import HouseRulesRenderer from '../components/HouseRulesRenderer'
import CredentialsModal from '../components/CredentialsModal'
// PM Resident CRM (slice 1) — replaces the Residents tab with a unified
// list + detail surface. Read-only in slice 1; actions land in slices
// 2–6. Toggle: flip PM_CRM_ENABLED to false to fall back to the legacy
// render below (kept intact for rollback until slice 2 retires it).
import PmResidentCrm from '../components/PmResidentCrm'
import { buildCrmResidents, isVehicleUnauthorizedForRestore, type CrmResident, type CrmSpace, type CrmSpaceResidentTie, type CrmSpaceRequest, type CrmPendingPlateChange } from '../lib/pm-crm'
import { fetchUnitOccupancy, buildOccupancyStamp, type UnitOccupancyMap } from '../lib/unit-occupancy'

const PM_CRM_ENABLED = true
import { getCachedLogoUrl, getPlatformLogoUrl } from '../lib/logo'
import { normalizePlate, assertPlateUniqueAtProperty } from '../lib/plate'
import { TOWED_CAR_LOOKUP_URL } from '../lib/towed-car-lookup'
import { generateTempPassword } from '../lib/temp-password'
import { BarChart, Bar, LineChart, Line, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
// B66.5 commit 4.3: account-state gate (past_due banner + suspended/cancelled redirects).
import { evaluatePortalGate } from '../lib/portal-account-gate'
import PastDueBanner, { type PastDueBannerProps } from '../components/PastDueBanner'

// callSyncOnAdd, notifyResidentDecision, trimDepartedResidentVehicles, and the
// five write cores + runBulkApprove now live in app/lib/manager-crm-writes.ts
// (Phase B1, 2026-07-30) so the mobile view (app/manager/mobile, Build 2)
// reuses them without a third resident-approve path. See the doc block on
// the lib for the split of "what's extracted" vs "what stays in the surface"
// and for the PM-only-cascade-on-mobile rule.

export default function ManagerPortal() {
  const [manager, setManager] = useState<any>(null)
  // AP-UI-REFINE (2026-07-24): authorized_plates count for the tab badge.
  // Init fetch on manager.id change fires before user visits the tab; the
  // AuthorizedPlatesManager component's onCountChange keeps it fresh while
  // the user is on the tab (add/remove mutations). One state variable, one
  // owner (Mateo).
  const [apCount, setApCount] = useState<number>(0)
  // Slice 1 Commit 4b — companyIdForSync resolved from manager.company
  // (the company NAME string on the properties row) → companies.id.
  // Used by the 3 vehicle-approval call sites to fire syncOnAdd('permit')
  // after a real approve (action='approved' from the approve_vehicle RPC).
  // Re-resolves on switchProperty (admin route may switch across companies).
  // Stays null on resolution failure → sync is silently skipped (safe;
  // reconcileAtRenewal is the backstop).
  const [companyIdForSync, setCompanyIdForSync] = useState<number | null>(null)
  // Permit-Door Piece 1 §3 — manager's approval authority. Universal:
  // gates the approve button(s) regardless of company tier. Sourced
  // from user_roles.can_approve_vehicles at loadManager time.
  //   admin route        → true unconditionally (admin owns it all)
  //   manager role       → roleData.can_approve_vehicles === true
  //   leasing_agent role → false unconditionally (no approve path)
  const [canApproveVehicles, setCanApproveVehicles] = useState<boolean>(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // B66.5 commit 4.3: past_due banner state.
  const [pastDueBanner, setPastDueBanner] = useState<PastDueBannerProps | null>(null)
  const [activeTab, setActiveTab] = useState('overview')
  const [vehicles, setVehicles] = useState<any[]>([])
  const [violations, setViolations] = useState<any[]>([])
  const [passes, setPasses] = useState<any[]>([])
  // 2026-08-08 — visitor-pass at-cap V1 (read-only). Populated by
  // fetchAtCapData; null when the property has no visitor_pass_limit
  // configured (render nothing at all in the Visitors tab). Non-null
  // with empty `entries` = limit set but no plates at cap (render
  // nothing — minimal). Non-null with entries = render list. See the
  // fetchAtCapData comment for the predicate contract (mirrors the
  // enforce_visitor_pass_limit trigger exactly).
  type AtCapPass = {
    plate: string
    visiting_unit: string | null
    visitor_name: string | null
    is_active: boolean
    created_at: string
    expires_at: string
  }
  type AtCapEntry = {
    normalizedPlate: string
    displayPlate: string
    count: number
    limit: number
    eligibleAt: string  // ISO timestamp
    passes: AtCapPass[] // oldest-first
  }
  const [atCapList, setAtCapList] = useState<{ limit: number; entries: AtCapEntry[] } | null>(null)
  const [expandedAtCapPlate, setExpandedAtCapPlate] = useState<string | null>(null)
  const [residents, setResidents] = useState<any[]>([])
  const [stats, setStats] = useState({ total_vehicles: 0, active_passes: 0, violations_today: 0, violations_week: 0 })
  const [showAddVehicle, setShowAddVehicle] = useState(false)
  const [newVehicle, setNewVehicle] = useState({ plate: '', state: 'TX', make: '', model: '', year: '', color: '', unit: '', space: '', permit_expiry: '' })
  // B166 — owner-picker state for manager addVehicle. residentsAtUnit
  // populates when user enters/changes the unit in Modal A, or when
  // Modal B opens (unit is fixed = editingResident.unit). Pre-select
  // when exactly one active resident; force pick at 2+; "Unit-level"
  // fallback at 0.
  const [residentsAtUnit, setResidentsAtUnit] = useState<Array<{ email: string; name: string }>>([])
  const [vehicleOwnerEmail, setVehicleOwnerEmail] = useState('')
  const [violationFilter, setViolationFilter] = useState('today')
  const [showAddResident, setShowAddResident] = useState(false)
  // B167 — optional vehicle fields on PM Add Resident. Plate empty
  // string => skip vehicle insert (resident-only path).
  const [newResident, setNewResident] = useState({ name: '', email: '', phone: '', unit: '', space: '', lease_end: '', vehicle_plate: '', vehicle_state: 'TX', vehicle_make: '', vehicle_model: '', vehicle_year: '', vehicle_color: '' })
  const [editingResident, setEditingResident] = useState<any>(null)
  const [allProperties, setAllProperties] = useState<any[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [isReadOnly, setIsReadOnly] = useState(false)
  // C2: post-confirmation media edit modal
  // ── Spaces v1 (commit 3) — dashboard-primary state ──
  // Old saveSpace()/editingSpace/hoveredSpaceId state DELETED — all writes
  // now flow through the 6 DEFINER RPCs (assign/reassign/free/generate/
  // decommission/update_space_metadata) via the modal handlers below.
  const [occupancy, setOccupancy] = useState<Awaited<ReturnType<typeof fetchOccupancyDashboard>> | null>(null)
  const [spacesList, setSpacesList] = useState<Space[]>([])
  const [spacesListTotal, setSpacesListTotal] = useState(0)
  const [spacesListLoading, setSpacesListLoading] = useState(false)
  const [spacesFilters, setSpacesFilters] = useState<ListFilters>({
    type: null,                  // null = All
    status: 'available',         // default per Jose lock — answers "what can I assign?" zero-click
    showInactive: false,
    search: '',
  })
  const [spacesPage, setSpacesPage] = useState(0)
  const [spacesPageSize, setSpacesPageSize] = useState<number>(PAGE_SIZE_DESKTOP)
  const [spacesResidents, setSpacesResidents] = useState<ResidentOption[]>([])
  const [spacesError, setSpacesError] = useState('')
  const [flaggedMigrationCount, setFlaggedMigrationCount] = useState(0)
  // B217 — double-click submit guards. One state per handler so a
  // concurrent submit doesn't lock unrelated buttons. Inline pattern
  // matches driver.submitViolation. (submitGuestAuth already uses
  // the existing guestAuthSubmitting state — not duplicated here.)
  const [addVehicleSubmitting,    setAddVehicleSubmitting]    = useState(false)
  const [addResidentSubmitting,   setAddResidentSubmitting]   = useState(false)
  // B212 — per-queue "Last updated" timestamps for the three pending
  // queues (vehicles, space requests, resident registrations). Refresh
  // button next to each header re-fetches that queue only.
  // refreshTicker forces a re-render every 30s so "N min ago" stays
  // accurate without polling the data itself (data refresh = on click).
  const [vehiclesPendingRefreshedAt,      setVehiclesPendingRefreshedAt]      = useState<number>(Date.now())
  const [spaceRequestsPendingRefreshedAt, setSpaceRequestsPendingRefreshedAt] = useState<number>(Date.now())
  const [residentsPendingRefreshedAt,     setResidentsPendingRefreshedAt]     = useState<number>(Date.now())
  // Silent-read reveal (2026-08-01) — fetchResidents state so the UI can
  // surface transport-error vs unexpectedly-empty vs ok. RLS denials
  // return {data: [], error: null} — they FILTER, they don't ERROR —
  // so "unexpectedly empty" is its own signal, distinct from a query
  // error. See feedback_rls_denials_return_empty_not_error.md.
  const [residentsFetchState, setResidentsFetchState] = useState<
    { status: 'ok' | 'error' | 'unexpectedly_empty' | 'idle'; at: number }
  >({ status: 'idle', at: Date.now() })
  // Last-write-wins race guard (2026-08-01) — bumps on every
  // fetchResidents call; the resolving response only sets state if it
  // still holds the latest token. Root-cause fix for A1's "list goes
  // empty after approve" incident: Amanda has 4 assigned properties;
  // rapid switchProperty / mount races caused a slow response for one
  // property to overwrite state with the wrong data (usually zero
  // rows). See feedback_last_write_wins_race_on_state_fetch.md.
  const fetchResidentsToken = useRef(0)
  const [, setRefreshTicker] = useState(0)
  // Per-modal target + form state — one slot per RPC, matches B214 pattern
  const [targetAdd, setTargetAdd] = useState(false)
  const [addForm, setAddForm] = useState<{ type: SpaceType; quantity: number }>({ type: 'carport', quantity: 1 })
  const [targetAssign, setTargetAssign] = useState<Space | null>(null)
  // v1.1: assignFormEmail is set by SearchableResidentPicker's onSelect
  // callback (picker writes the picked resident's email; submit reads it).
  const [assignFormEmail, setAssignFormEmail] = useState('')
  // v1.1 multi-resident: targetReassign / reassignFormEmail DROPPED.
  // "Reassign" is ambiguous in set-world; manager UX = 2 explicit clicks
  // (remove old via free-modal per-resident, add new via assign-modal).
  const [targetFree, setTargetFree] = useState<Space | null>(null)
  // v1.1: optional per-resident free target. When set, the free modal
  // operates in per-resident mode and calls free_space(id, reason, email).
  // When null, free modal operates in whole-space mode (legacy behavior).
  const [freeResidentEmail, setFreeResidentEmail] = useState<string | null>(null)
  // v1.1: deactivate-resident modal state. Replaces the old confirm()
  // at deactivateResident entry. When set, opens DeactivateResidentModal
  // with co-residents at the target's unit pre-loaded for opt-in cascade.
  const [targetDeactivate, setTargetDeactivate] = useState<{
    id: string
    email: string
    name: string
    unit: string
    coResidents: CoResident[]
  } | null>(null)
  const [deactivateBusy, setDeactivateBusy] = useState(false)
  // Task 3 Commit 3 (2026-08-06): vehicle-deactivate modal state.
  // Replaces the native window.confirm() at deactivateVehicleCrm entry.
  // Context (plate/ymm/resident) captured at click time from the
  // VehicleCard's vehicle object — no fetch round-trip needed.
  const [targetDeactivateVehicle, setTargetDeactivateVehicle] = useState<{
    id:            string | number
    plate:         string
    ymm?:          string
    residentName?: string
    residentUnit?: string
    property:      string   // for audit new_values shape
  } | null>(null)
  const [deactivateVehicleBusy, setDeactivateVehicleBusy] = useState(false)
  // 2026-08-07 reapproval-orphans intercept state. When approveResident
  // finds unauthorized plates on file for the resident's email at the
  // property, we set this and open ReapprovalOrphansModal. The
  // pendingApproveResident callback holds the resident so we can
  // resume the approve after the manager makes their choice (restore
  // some / approve without restoring / cancel).
  const [reapprovalOrphans, setReapprovalOrphans] = useState<{
    resident:      any                    // CrmResident from approve caller
    orphans:       OrphanPlate[]
  } | null>(null)
  const [reapprovalBusy, setReapprovalBusy] = useState(false)
  // 2026-08-08 — Manager Add Vehicle for an existing resident.
  // State holds the resident being added-to (null = modal closed).
  // Opened via PmResidentCrm's onOpenAddVehicle prop; closed by the
  // modal's onCancel or by handleAddVehicleSubmit on success.
  const [addVehicleFor, setAddVehicleFor] = useState<CrmResident | null>(null)
  const [targetDecommission, setTargetDecommission] = useState<Space | null>(null)
  // v1.1 commit 6 — SpaceDetailModal opens via the "View" affordance on each
  // space row. The modal handles its own data loading, mutations, and busy
  // state; this state just controls mount/unmount + which space is in focus.
  const [targetSpaceDetail, setTargetSpaceDetail] = useState<Space | null>(null)
  const [targetEdit, setTargetEdit] = useState<Space | null>(null)
  const [editForm, setEditForm] = useState<{ label: string; description: string; type: SpaceType; is_bundled: boolean }>({
    label: '', description: '', type: 'carport', is_bundled: false,
  })
  // ── Resident-approval optional assign-space dropdowns (commit 4) ──
  // Optional per Jose lock 2026-06-21: "approval ≠ assignment; most
  // residents hold zero spaces." Pool refetched alongside the spaces
  // dashboard data (status='available' filter, top 100).
  const [availableSpacesForAssign, setAvailableSpacesForAssign] = useState<Space[]>([])
  const [pendingResidentAssignSpaceId, setPendingResidentAssignSpaceId] = useState<Record<string, string>>({})
  const [newResidentAssignSpaceId, setNewResidentAssignSpaceId] = useState<string>('')
  const [vehicleSearch, setVehicleSearch] = useState('')
  const [residentSearch, setResidentSearch] = useState('')
  const [violationSearch, setViolationSearch] = useState('')
  const [pendingVehicles, setPendingVehicles] = useState<any[]>([])
  const [pendingNotes, setPendingNotes] = useState<Record<string, string>>({})
  const [unitNotes, setUnitNotes] = useState<Record<string, string>>({})
  // Space Requests v1 — manager approval queue + per-row decision state.
  // Approve modal reuses the existing availableSpacesForAssign pool (loaded
  // once at portal init from fetchSpacesList(... status:'available' ...)).
  // Per-row decision UI lives inline — approveSelections holds the picked
  // space_id per request_id; declineReasons holds the optional reason.
  const [pendingSpaceRequests, setPendingSpaceRequests] = useState<any[]>([])
  const [approveSelections, setApproveSelections] = useState<Record<number, string>>({})
  const [declineReasons, setDeclineReasons] = useState<Record<number, string>>({})
  const [decidingRequestId, setDecidingRequestId] = useState<number | null>(null)
  const [spaceRequestError, setSpaceRequestError] = useState<string>('')
  const [passLimit, setPassLimit] = useState('')
  const [exemptPlates, setExemptPlates] = useState<string[]>([])
  const [newExemptPlate, setNewExemptPlate] = useState('')
  // 2026-08-20 house-rules arc Commit 2 — Settings-tab form state.
  // Mirrors the passLimit / exemptPlates pattern above. Server-side
  // trigger (20260820_property_house_rules_v1.sql) is the sole
  // authority for version bump + normalized text-change detection —
  // this form just writes house_rules_text + house_rules_effective_date.
  // Whitespace-only saves and effective-date-only edits are handled
  // correctly by the trigger; client-side we don't try to duplicate the
  // logic (Mateo Aug 20 rule: trigger is the authority).
  const [houseRulesDraft, setHouseRulesDraft] = useState('')
  const [houseRulesEffectiveDate, setHouseRulesEffectiveDate] = useState('')
  const [houseRulesMsg, setHouseRulesMsg] = useState('')
  const [houseRulesBusy, setHouseRulesBusy] = useState(false)

  // ── B214: Guest Authorizations state ──
  // List, create-form, renew-modal, and revoke-modal state isolated to this
  // tab. Loaded lazily when the tab activates (see useEffect below) so
  // the active-list query doesn't run on every manager-portal mount.
  const [guestAuths, setGuestAuths] = useState<GuestAuth[]>([])
  const [showAddGuestAuth, setShowAddGuestAuth] = useState(false)
  const [newGuestAuth, setNewGuestAuth] = useState({
    guest_name: '', plate: '', state: 'TX', make: '', model: '', color: '',
    visiting_type: 'resident' as 'resident' | 'non_resident',
    visiting_unit: '', resident_email: '', non_resident_reason: '',
    start_date: todayIso(), end_date: addDays(todayIso(), 14),
  })
  const [guestAuthOverlapWarning, setGuestAuthOverlapWarning] = useState<GuestAuth | null>(null)
  const [guestAuthSubmitting, setGuestAuthSubmitting] = useState(false)
  const [guestAuthError, setGuestAuthError] = useState('')
  // Revoke modal target + reason; null when closed.
  const [revokeGuestAuthTarget, setRevokeGuestAuthTarget] = useState<GuestAuth | null>(null)
  const [revokeReason, setRevokeReason] = useState('')
  // Renew modal target + dates; null when closed. Defaults set to continuous
  // coverage (new_start = source.end_date) per Jose lock 2026-06-20.
  const [renewGuestAuthTarget, setRenewGuestAuthTarget] = useState<GuestAuth | null>(null)
  const [renewDates, setRenewDates] = useState({ start_date: '', end_date: '' })
  // B222 (2026-06-26): search box on the active guest-auth list — filters
  // by plate, guest name, visiting unit, or resident email. Pattern
  // mirrors the existing violations search in this file.
  const [guestAuthSearch, setGuestAuthSearch] = useState('')
  const [settingsMsg, setSettingsMsg] = useState('')
  const [auditLogs, setAuditLogs] = useState<any[]>([])
  const [auditDateFilter, setAuditDateFilter] = useState('week')
  const [auditSearch, setAuditSearch] = useState('')
  const [auditLoaded, setAuditLoaded] = useState(false)
  const [pendingResidents, setPendingResidents] = useState<any[]>([])
  // Unit occupancy batch payload — single source of truth for the four
  // PmResidentCrm surfaces (list-row badge, amber panel line, vehicle
  // context, bulk aggregate) AND the audit stamp on approvals. Fetched
  // on refresh via useEffect once residents/vehicles state settles.
  // Null = fetch failed OR not yet loaded; UI renders NOTHING on null
  // (fail-quiet contract; see app/lib/unit-occupancy.ts).
  const [unitOccupancy, setUnitOccupancy] = useState<UnitOccupancyMap | null>(null)
  const [residentNotes, setResidentNotes] = useState<Record<string, string>>({})
  // PM Resident CRM slice 1 — property-scoped batch loads. Grouped
  // client-side in buildCrmResidents (app/lib/pm-crm.ts). Zero per-
  // resident queries. Fetched from fetchAll(property) alongside vehicles/
  // passes/residents; already property-scoped so no extra RLS load.
  const [crmSpacesAtProperty, setCrmSpacesAtProperty] = useState<CrmSpace[]>([])
  const [crmSpaceResidentTies, setCrmSpaceResidentTies] = useState<CrmSpaceResidentTie[]>([])
  const [crmGuestAuthsAtProperty, setCrmGuestAuthsAtProperty] = useState<GuestAuth[]>([])
  // RT-4 — resident-submitted guest requests awaiting PM approve/decline.
  // Separate from crmGuestAuthsAtProperty (status='active') so approve/decline
  // handlers can pop rows here without touching the active-list on hot render.
  const [crmPendingGuestRequestsAtProperty, setCrmPendingGuestRequestsAtProperty] = useState<GuestAuth[]>([])
  const [crmSpaceRequestsAtProperty, setCrmSpaceRequestsAtProperty] = useState<CrmSpaceRequest[]>([])
  // Slice 4 — pending plate changes at property. Manager sees property-
  // scoped rows via RLS (manager_own_plate_changes). Attached onto each
  // vehicle via buildCrmResidents's Phase-3 enrichment.
  const [crmPendingPlateChanges, setCrmPendingPlateChanges] = useState<CrmPendingPlateChange[]>([])
  // 2026-08-08 — Property warnings (V1: manager-portal only). Memoized
  // so the Insights tab badge (count) and the panel body (list) share
  // one compute pass. Rebuild only when the composing state changes.
  // Six predicates in app/lib/property-warnings.ts. Empty array when
  // the manager hasn't loaded yet — badge renders no number, panel
  // renders nothing (silence, not "all clear").
  const propertyWarnings = useMemo(() => {
    if (!manager) return []
    const crmResidentsForWarnings = buildCrmResidents({
      residents,
      pendingResidents,
      vehicles: [...vehicles, ...pendingVehicles],
      spaces: crmSpacesAtProperty,
      spaceResidentTies: crmSpaceResidentTies,
      guestAuths: crmGuestAuthsAtProperty,
      spaceRequests: crmSpaceRequestsAtProperty,
      pendingPlateChanges: crmPendingPlateChanges,
      pendingGuestRequests: crmPendingGuestRequestsAtProperty,
    })
    return computePropertyWarnings({ crmResidents: crmResidentsForWarnings })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- manager.id is the identity anchor; the state arrays are the real deps
  }, [
    manager,
    residents, pendingResidents, vehicles, pendingVehicles,
    crmSpacesAtProperty, crmSpaceResidentTies, crmGuestAuthsAtProperty,
    crmSpaceRequestsAtProperty, crmPendingPlateChanges, crmPendingGuestRequestsAtProperty,
  ])
  // B70: Plate Lookup tab state. Distinct name from the Spaces-tab
  // `plateQuery` further down to avoid the variable collision.
  const [lookupPlate, setLookupPlate] = useState('')
  const [lookupBusy, setLookupBusy] = useState(false)
  // B220 (2026-06-26): widened result_type union to include 'guest_authorized'
  // + added guest_name/valid_through fields (populated only on guest_authorized;
  // NULL on resident/visitor/unauthorized per the pm_plate_lookup RPC contract).
  // B230 Part B (2026-07-09): widened again to include 'pending' + 'plate_under_review'
  // (Part A RPC changes now surface them; previously the manager's whitelist
  // rejected them as "Unexpected response" and users saw "not authorized"
  // instead of the actual under-review state).
  const [lookupResult, setLookupResult] = useState<{ result_type: 'resident' | 'visitor' | 'unauthorized' | 'guest_authorized' | 'pending' | 'plate_under_review' | 'authorized_plate'; unit_number: string | null; queriedPlate: string; guest_name?: string | null; valid_through?: string | null; ap_property_name?: string | null; ap_label?: string | null } | null>(null)
  const [lookupError, setLookupError] = useState('')
  const [managerCompany, setManagerCompany] = useState('')
  const [managerEmail, setManagerEmail] = useState('')
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null)
  const [resetPwTarget, setResetPwTarget] = useState<string | null>(null)
  const [resetPwForm, setResetPwForm] = useState({ newPw: '', confirmPw: '' })
  const [resetPwMsg, setResetPwMsg] = useState('')
  // ── plateQuery/plateSuggestions/plateMsg DELETED (Spaces v1 commit 3) ──
  // These were the old saveSpace() per-modal plate-search state — only used
  // by the deleted editingSpace modal. The Plate Lookup tab uses its own
  // distinctly-named lookupPlate/lookupBusy/lookupResult/lookupError state
  // (see L118-121) and is unaffected.
  const [showActiveResidents, setShowActiveResidents] = useState(true)
  const [showActiveVehicles, setShowActiveVehicles] = useState(true)
  // B210 (2026-06-24): disputes / pendingDisputeCount / disputeNotes
  // state removed alongside the disputes tab UI + handlers.
  const [insightsLoaded, setInsightsLoaded] = useState(false)
  const [mgAnalytics, setMgAnalytics] = useState<any>(null)

  useEffect(() => { loadManager(); getPlatformLogoUrl() }, [])

  // Slice 1 Commit 4b — resolve companyIdForSync from manager.company
  // (text) → companies.id. Re-fires on manager change (admin route may
  // switch properties across companies via switchProperty). Single
  // 1-query lookup; null on miss (sync calls silently skip; safe).
  useEffect(() => {
    if (!manager?.company) { setCompanyIdForSync(null); return }
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('companies').select('id')
        .ilike('name', manager.company).maybeSingle()
      if (!cancelled) setCompanyIdForSync(data?.id ? Number(data.id) : null)
    })()
    return () => { cancelled = true }
  }, [manager?.company])
  useEffect(() => { if (activeTab === 'activity' && manager) fetchActivityLogs() }, [activeTab, manager])
  // B210: disputes-tab useEffect removed
  useEffect(() => { if (activeTab === 'insights' && manager) fetchInsights() }, [activeTab, manager])
  // B214: lazy-load guest auths on tab activation. Re-fetches when the manager
  // switches properties (manager.name change) so the list always reflects the
  // currently-viewed property's scope.
  useEffect(() => { if (activeTab === 'guest-auth' && manager) refetchGuestAuths() }, [activeTab, manager])
  // ── Spaces v1 (commit 3) effects ──
  // 1. Adaptive page size — 25 mobile / 50 desktop. Matches the locked
  //    UX requirement; resets pagination to page 0 on size change.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 768px)')
    const apply = (matches: boolean) => { setSpacesPageSize(matches ? PAGE_SIZE_MOBILE : PAGE_SIZE_DESKTOP); setSpacesPage(0) }
    apply(mq.matches)
    const handler = (e: MediaQueryListEvent) => apply(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  // 2. Dashboard refetch on tab activation. Aggregate queries; no row data.
  useEffect(() => { if (activeTab === 'spaces' && manager) refetchSpacesDashboard() }, [activeTab, manager])
  // B212 — 30s ticker so "Last updated N min ago" labels stay accurate
  // without polling the data. Data refetch happens only on Refresh
  // click; this tick just forces fmtAgo's Date.now() read to advance.
  useEffect(() => {
    const id = setInterval(() => setRefreshTicker(t => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])
  // 3. List refetch on tab activation OR filter/page change. SERVER-SIDE
  //    filtered + LIMIT-paginated. NEVER fetches all rows.
  useEffect(() => {
    if (activeTab !== 'spaces' || !manager) return
    refetchSpacesList()
  }, [activeTab, manager, spacesFilters, spacesPage, spacesPageSize])
  // 4. Residents-at-property for assign/reassign dropdowns + resident-search.
  //    Loaded once on tab activation.
  useEffect(() => {
    if (activeTab !== 'spaces' || !manager) return
    fetchActiveResidentsAtProperty(supabase, manager.name).then(setSpacesResidents)
  }, [activeTab, manager])
  useEffect(() => {
    if (manager) {
      setPassLimit(manager.visitor_pass_limit != null ? String(manager.visitor_pass_limit) : '')
      setExemptPlates(manager.exempt_plates || [])
      // House rules (Commit 2). Draft mirrors persisted; effective-date
      // defaults to today when unpublished, otherwise mirrors persisted.
      // The manager can then optionally push the date forward — Ch. 94
      // notice-friendly workflow — without needing to type today's date.
      setHouseRulesDraft(manager.house_rules_text ?? '')
      setHouseRulesEffectiveDate(
        manager.house_rules_effective_date
          ?? new Date().toISOString().slice(0, 10)   // YYYY-MM-DD
      )
      setHouseRulesMsg('')
    }
  }, [manager])

  // Unit occupancy — single-batch fetch keyed on the loaded residents +
  // vehicles state for the current property. One RPC round trip feeds
  // all four PmResidentCrm surfaces + the audit stamp. Fires on
  // refreshCrmData settling, on property switch via manager.name, and
  // any downstream mutation that updates residents/vehicles state.
  // Fail-quiet: null on error, UI renders nothing. Cancellation guard
  // prevents a slow response from a prior property blanking the new
  // one.
  useEffect(() => {
    if (!manager?.name) { setUnitOccupancy(null); return }
    const units = new Set<string>()
    for (const r of residents)         if (r?.unit != null) units.add(String(r.unit))
    for (const r of pendingResidents)  if (r?.unit != null) units.add(String(r.unit))
    for (const v of vehicles)          if (v?.unit != null) units.add(String(v.unit))
    for (const v of pendingVehicles)   if (v?.unit != null) units.add(String(v.unit))
    let cancelled = false
    fetchUnitOccupancy(supabase, manager.name, Array.from(units)).then(map => {
      if (!cancelled) setUnitOccupancy(map)
    })
    return () => { cancelled = true }
  }, [manager?.name, residents, pendingResidents, vehicles, pendingVehicles])

  async function loadManager() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { window.location.href = '/login'; return }
    setManagerEmail(user.email || '')

    const { data: roleData } = await supabase
      .from('user_roles')
      .select('*')
      .ilike('email', user.email!)
      .single()

    if (!roleData) {
      setError('No role assigned. Contact your administrator.')
      setLoading(false)
      return
    }

    // B66.5 commit 4.3: account-state gate. Skip for admin (no company
    // association). Manager/leasing_agent roles get gated by their
    // company's state per the Q6 lock (same gating as driver portal).
    if (roleData.role === 'manager' || roleData.role === 'leasing_agent') {
      if (roleData.company) {
        // B66.5.1: pass role for role-gated CTA rendering in PastDueBanner.
        // manager + leasing_agent both → non-CA copy (only CA + admin see Update Payment).
        const gateResult = await evaluatePortalGate(roleData.company, roleData.role)
        if (gateResult.redirected) return
        if (gateResult.pastDueBanner) setPastDueBanner(gateResult.pastDueBanner)
      }
    }

    // Permit-Door Piece 1 §3 — surface the authority gate state alongside
    // the role branch. admin = always allowed; manager = per the column;
    // leasing_agent = never (no approve path at all).
    if (roleData.role === 'admin') {
      setCanApproveVehicles(true)
    } else if (roleData.role === 'manager') {
      setCanApproveVehicles(roleData.can_approve_vehicles === true)
    } else {
      setCanApproveVehicles(false)
    }

    if (roleData.role === 'admin') {
      setIsAdmin(true)
      const { data: props } = await supabase.from('properties').select('*').order('name')
      setAllProperties(props || [])
      if (props && props.length > 0) {
        setManager(props[0])
        fetchAll(props[0].name)
      }
      setLoading(false)
    } else if (roleData.role === 'manager' || roleData.role === 'leasing_agent') {
      if (roleData.role === 'leasing_agent') setIsReadOnly(true)
      setManagerCompany(roleData.company || '')

      // Multi-property support. user_roles.property is text[]; the client
      // must fetch by array (server RPCs already use ANY(user_roles.property[])).
      // Reference impl: login/page.tsx:275. Reuses the existing
      // allProperties + switchProperty plumbing that the admin branch uses,
      // so the switcher UI at :2629 renders automatically when N > 1.
      const propNames: string[] = Array.isArray(roleData.property)
        ? roleData.property
        : (roleData.property ? [roleData.property] : [])

      if (propNames.length === 0) {
        setLoading(false)
        setError('No property assigned to your role. Contact your administrator.')
        return
      }

      const { data, error } = await supabase
        .from('properties')
        .select('*')
        .in('name', propNames)
        .order('name')
      setLoading(false)
      if (error || !data || data.length === 0) {
        setError(`No property found matching "${propNames.join(', ')}". Check your user_roles table.`)
      } else {
        // Drift guard: .in() is exact-match to mirror the server's
        // = ANY(user_roles.property[]) invariant. If a case/whitespace
        // mismatch drops one, log it (invisible-in-dropdown is worse
        // than diagnosable). Free-text vector: admin/page.tsx:566 +
        // bulk-upload.
        if (data.length !== propNames.length) {
          const missing = propNames.filter(n => !data.some((p: any) => p.name === n))
          console.error('[manager] assigned properties not found:', missing)
        }
        setAllProperties(data)
        setManager(data[0])
        fetchAll(data[0].name)
      }
    } else {
      setError('You do not have manager access.')
      setLoading(false)
    }
  }

  async function switchProperty(name: string) {
    const prop = allProperties.find(p => p.name === name)
    if (prop) {
      setManager(prop); fetchAll(prop.name)
      // AP-VIEWING (2026-07-24): clear stale plate-lookup state on
      // property switch. Without this a manager sees a lookup result
      // computed under the previous viewing property. Same class as the
      // AP filter reset on propertyId change (AP-UI-REFINE d0525f3).
      setLookupResult(null); setLookupError(''); setLookupPlate('')
    }
  }

  // AP-UI-REFINE (2026-07-24): initial apCount fetch when property changes.
  // Fires before user visits the Authorized Plates tab — badge shows the
  // correct count on tab bar without requiring a tab visit. Component's
  // onCountChange updates the same state when user is on the tab.
  useEffect(() => {
    if (!manager?.id) { setApCount(0); return }
    let cancelled = false
    supabase.from('authorized_plates')
      .select('*', { count: 'exact', head: true })
      .eq('property_id', manager.id)
      .is('removed_at', null)
      .then(({ count }) => { if (!cancelled) setApCount(count ?? 0) })
    return () => { cancelled = true }
  }, [manager?.id])

  async function fetchAll(property: string) {
    fetchVehicles(property)
    fetchViolations(property)
    fetchPasses(property)
    fetchAtCapData(property)  // 2026-08-08 — visitor-pass at-cap V1
    fetchResidents(property)
    fetchPendingSpaceRequests(property)
    // Spaces fixes 2026-06-28 — load-on-manager-load for Bug 1 + Bug 2.
    // Bug 1: tab-activation useEffect raced manager-loading and could
    //   capture stale closure → dashboard 0/0 until an add-space action
    //   forced a refetch. Eagerly priming here means the dashboard is
    //   correct on first Spaces-tab open regardless of effect timing.
    // Bug 2: availableSpacesForAssign (used by approve-space-request
    //   modal in the Approvals tab) only populated via the same
    //   tab-activation effect. Opening a request without first visiting
    //   Spaces tab → empty pool → "no available spaces". This call
    //   primes the pool at manager-load so it's present regardless of
    //   navigation order.
    // Note: PROPERTY ARG IS LOAD-BEARING. setManager has not yet been
    //   React-committed when fetchAll is invoked, so closure-`manager`
    //   inside the refetch functions would be stale. The optional arg
    //   bypasses that race.
    refetchSpacesDashboard(property)
    refetchSpacesList(property)
    // fetchSpaces removed (Spaces v1 commit 3) — Spaces tab loads its own
    // data lazily on tab activation via refetchSpacesDashboard/List
    // (dashboard aggregate + filtered paginated list). Removed from the
    // mount-time fetch fan-out so cold load doesn't pull 126+ rows.
    // B210 (2026-06-24): fetchDisputes call removed alongside the
    // resident dispute flow retirement.
    // PM Resident CRM slice 1 — batch loads for the Residents tab's
    // unified surface. Fired unconditionally (fast post-Commit-2 RLS
    // sweep ba122ab); grouped client-side, zero per-resident queries.
    fetchCrmDataForProperty(property)
  }

  async function fetchCrmDataForProperty(property: string) {
    // Spaces + guest auths + pending space requests + pending guest
    // requests — four property-scoped batch queries, all fast under
    // Commit 2 RLS. space_residents ties fetched once we know the space
    // IDs (one more batch).
    const [spacesRes, gaList, spaceReqsRes, pendingGuestRes] = await Promise.all([
      supabase.from('spaces').select('id, label, type, status, is_active, assigned_to_resident_email, property, designated_vehicle_id').ilike('property', property),
      fetchActiveGuestAuths(supabase, { property }),
      // Slice 3.5 — correct columns. Actual schema has no requested_space_id
      // / requested_space_label (resident submits generically; PM picks the
      // space at approval time via a dropdown of available spaces).
      supabase.from('space_requests').select('id, resident_email, property, note, status, requested_at, decline_reason, assigned_space_id').ilike('property', property).eq('status', 'pending'),
      // RT-4 — pending guest requests at this property. Manager RLS
      // (manager_own_guest_auths) admits by property scope.
      supabase.from('guest_authorizations').select('*').ilike('property', property).eq('status', 'pending').order('created_at', { ascending: true }),
    ])
    // Slice 4 — pending plate changes at property. Property-scoped by
    // RLS (manager_own_plate_changes). Fires alongside the rest so the
    // CRM VehicleCard renders the Do-Not-Tow banner on first paint.
    const platesRes = await supabase
      .from('vehicle_plate_changes')
      .select('id, vehicle_id, old_plate, new_plate, submitted_by, submitted_at, property, status')
      .ilike('property', property)
      .eq('status', 'pending')
    // BUG-1 fix (2026-07-04): fetch space_residents ties BEFORE the
    // state batch so spaces + ties transition atomically. Prior order
    // set spaces first, then awaited ties, then set ties — creating a
    // render window where the CRM builder ran with spaces populated
    // but ties empty. buildCrmResidents' legacy fallback then treated
    // the roommate-shared space (assigned_to_resident_email = NULL by
    // v1.1 design) as unassigned for the roommate. Making the ties
    // fetch part of the atomic setState eliminates the window.
    const spaces = (spacesRes.data ?? []) as CrmSpace[]
    let ties: CrmSpaceResidentTie[] = []
    if (spaces.length > 0) {
      const spaceIds = spaces.map(s => s.id)
      const tiesRes = await supabase.from('space_residents').select('space_id, resident_email').in('space_id', spaceIds)
      if (tiesRes.error) {
        // Loud failure — the CRM builder's legacy fallback would otherwise
        // silently reproduce the pre-v1.1 assignment shape, hiding roommate
        // ties. Log so the same-class regression can't ship unnoticed.
        console.error('[BUG-1-ties-fetch-failed]', {
          property, spaceCount: spaceIds.length, error: tiesRes.error.message,
        })
      }
      ties = (tiesRes.data ?? []) as CrmSpaceResidentTie[]
    }
    setCrmPendingPlateChanges((platesRes.data ?? []) as CrmPendingPlateChange[])
    setCrmSpacesAtProperty(spaces)
    setCrmSpaceResidentTies(ties)
    setCrmGuestAuthsAtProperty(gaList)
    setCrmPendingGuestRequestsAtProperty((pendingGuestRes.data ?? []) as GuestAuth[])
    setCrmSpaceRequestsAtProperty((spaceReqsRes.data ?? []) as CrmSpaceRequest[])
  }

  // B210 (2026-06-24): fetchDisputes / upholdDispute / resolveDispute
  // removed. The resident→PM dispute concept is retired; the only
  // remaining dispute concept is the CA manual status='disputed' flag
  // on violations (B219). Historical DISPUTE_* audit_logs rows preserved.

  // ── B214: Guest Authorizations handlers ──────────────────────────────
  async function refetchGuestAuths() {
    if (!manager?.name) return
    const list = await fetchActiveGuestAuths(supabase, { property: manager.name })
    setGuestAuths(list)
  }

  // Pre-submit overlap check (Finding 2). Returns true if the form may
  // proceed; surfaces the warning (non-blocking) if an overlap exists.
  // Caller decides whether to short-circuit based on user confirm.
  async function checkGuestAuthOverlap(): Promise<GuestAuth | null> {
    if (!manager?.name || !newGuestAuth.plate || !newGuestAuth.start_date || !newGuestAuth.end_date) return null
    const overlap = await findOverlappingActiveAuth(supabase, {
      plate: newGuestAuth.plate,
      property: manager.name,
      startDate: newGuestAuth.start_date,
      endDate: newGuestAuth.end_date,
    })
    setGuestAuthOverlapWarning(overlap)
    return overlap
  }

  async function submitGuestAuth() {
    setGuestAuthError('')
    setGuestAuthSubmitting(true)
    try {
      if (!newGuestAuth.guest_name.trim()) { setGuestAuthError('Guest name required'); return }
      const normalized = normalizePlate(newGuestAuth.plate)
      if (!normalized) { setGuestAuthError('Plate required'); return }
      if (newGuestAuth.visiting_type === 'resident' && !newGuestAuth.visiting_unit.trim()) {
        setGuestAuthError('Visiting unit required for resident-guest authorization'); return
      }
      if (newGuestAuth.visiting_type === 'non_resident' && !newGuestAuth.non_resident_reason.trim()) {
        setGuestAuthError('Reason required for non-resident authorization'); return
      }
      if (!newGuestAuth.start_date || !newGuestAuth.end_date) { setGuestAuthError('Start and end dates required'); return }
      if (newGuestAuth.end_date < newGuestAuth.start_date) { setGuestAuthError('End date must be on or after start date'); return }
      const span = daysUntilExpiry(newGuestAuth.end_date) - daysUntilExpiry(newGuestAuth.start_date) + 1
      if (span > GUEST_AUTH_MAX_DAYS) { setGuestAuthError(`Maximum ${GUEST_AUTH_MAX_DAYS} days per grant`); return }

      // Named params (Jose lock 2026-06-20: positional 12-arg create is a
      // transposition trap; keys must match the RPC signature exactly).
      const { error } = await supabase.rpc('create_guest_authorization', {
        p_plate: normalized,
        p_state: newGuestAuth.state || 'TX',
        p_vehicle_make: newGuestAuth.make.trim() || null,
        p_vehicle_model: newGuestAuth.model.trim() || null,
        p_vehicle_color: newGuestAuth.color.trim() || null,
        p_guest_name: newGuestAuth.guest_name.trim(),
        p_visiting_unit: newGuestAuth.visiting_type === 'resident' ? newGuestAuth.visiting_unit.trim() : null,
        p_resident_email: newGuestAuth.visiting_type === 'resident' ? (newGuestAuth.resident_email.trim().toLowerCase() || null) : null,
        p_non_resident_reason: newGuestAuth.visiting_type === 'non_resident' ? newGuestAuth.non_resident_reason.trim() : null,
        p_property: manager.name,
        p_start_date: newGuestAuth.start_date,
        p_end_date: newGuestAuth.end_date,
      })
      if (error) { setGuestAuthError(error.message); return }
      // Reset form + refresh list
      setNewGuestAuth({
        guest_name: '', plate: '', state: 'TX', make: '', model: '', color: '',
        visiting_type: 'resident', visiting_unit: '', resident_email: '', non_resident_reason: '',
        start_date: todayIso(), end_date: addDays(todayIso(), 14),
      })
      setGuestAuthOverlapWarning(null)
      setShowAddGuestAuth(false)
      await refetchGuestAuths()
    } finally {
      setGuestAuthSubmitting(false)
    }
  }

  async function submitRenewGuestAuth() {
    if (!renewGuestAuthTarget) return
    if (!renewDates.start_date || !renewDates.end_date) { setGuestAuthError('Both renewal dates required'); return }
    if (renewDates.end_date < renewDates.start_date) { setGuestAuthError('End must be on or after start'); return }
    const span = daysUntilExpiry(renewDates.end_date) - daysUntilExpiry(renewDates.start_date) + 1
    if (span > GUEST_AUTH_MAX_DAYS) { setGuestAuthError(`Maximum ${GUEST_AUTH_MAX_DAYS} days per renewal`); return }
    const { error } = await supabase.rpc('renew_guest_authorization', {
      p_source_id: renewGuestAuthTarget.id,
      p_new_start_date: renewDates.start_date,
      p_new_end_date: renewDates.end_date,
    })
    if (error) { setGuestAuthError(error.message); return }
    setRenewGuestAuthTarget(null)
    setRenewDates({ start_date: '', end_date: '' })
    setGuestAuthError('')
    await refetchGuestAuths()
  }

  async function submitRevokeGuestAuth() {
    if (!revokeGuestAuthTarget) return
    const { error } = await supabase.rpc('revoke_guest_authorization', {
      p_id: revokeGuestAuthTarget.id,
      p_reason: revokeReason.trim() || null,
    })
    if (error) { setGuestAuthError(error.message); return }
    setRevokeGuestAuthTarget(null)
    setRevokeReason('')
    setGuestAuthError('')
    await refetchGuestAuths()
  }

  // ── RT-4: Approve / decline resident-submitted guest requests ──────
  // Client just calls the DEFINER RPC; role gate + property scope +
  // 60-day CHECK all enforced server-side. Optional dates let the PM
  // trim a resident-proposed window at approve time.
  async function approveGuestAuthRequestCrm(id: number, dates?: { start_date?: string; end_date?: string }) {
    const { data, error } = await supabase.rpc('approve_guest_authorization_request', {
      p_id: id,
      p_start_date: dates?.start_date || null,
      p_end_date: dates?.end_date || null,
    })
    if (error) { alert(`Approve failed: ${error.message}`); return }
    const err = (data as any)?.error
    if (err) { alert(`Approve failed: ${err}${(data as any)?.hint ? ' — ' + (data as any).hint : ''}`); return }
    await refreshCrmData()
  }

  async function declineGuestAuthRequestCrm(id: number, reason: string) {
    const { data, error } = await supabase.rpc('decline_guest_authorization_request', {
      p_id: id,
      p_reason: reason || null,
    })
    if (error) { alert(`Decline failed: ${error.message}`); return }
    const err = (data as any)?.error
    if (err) { alert(`Decline failed: ${err}`); return }
    await refreshCrmData()
  }

  async function savePassLimit() {
    const val = passLimit === '' ? null : parseInt(passLimit)
    const { error } = await supabase.from('properties').update({ visitor_pass_limit: val }).eq('id', manager.id)
    if (error) { setSettingsMsg('Error: ' + error.message) }
    else {
      await logAudit({ action: 'SET_PASS_LIMIT', table_name: 'properties', record_id: manager.id, new_values: { visitor_pass_limit: val, property: manager.name } })
      setSettingsMsg('Pass limit saved.'); setManager({ ...manager, visitor_pass_limit: val })
    }
  }

  async function addExemptPlate() {
    const plate = normalizePlate(newExemptPlate)
    if (!plate || exemptPlates.includes(plate)) { setNewExemptPlate(''); return }
    const updated = [...exemptPlates, plate]
    const { error } = await supabase.from('properties').update({ exempt_plates: updated }).eq('id', manager.id)
    if (error) { setSettingsMsg('Error: ' + error.message) }
    else {
      await logAudit({ action: 'ADD_EXEMPT_PLATE', table_name: 'properties', record_id: manager.id, new_values: { plate, property: manager.name } })
      setExemptPlates(updated); setManager({ ...manager, exempt_plates: updated }); setNewExemptPlate(''); setSettingsMsg('')
    }
  }

  async function removeExemptPlate(plate: string) {
    const updated = exemptPlates.filter(p => p !== plate)
    const { error } = await supabase.from('properties').update({ exempt_plates: updated }).eq('id', manager.id)
    if (error) { setSettingsMsg('Error: ' + error.message) }
    else {
      await logAudit({ action: 'REMOVE_EXEMPT_PLATE', table_name: 'properties', record_id: manager.id, new_values: { plate, property: manager.name } })
      setExemptPlates(updated); setManager({ ...manager, exempt_plates: updated })
    }
  }

  // 2026-08-20 house-rules arc Commit 2 — save handler. Mirrors
  // savePassLimit's shape: direct .update() on properties, RLS-gated
  // (manager owns the property scope), audit row on success.
  //
  // 🔴 Server-side trigger is the authority for version bump +
  // normalized text-change detection. Client doesn't try to detect
  // "no change" (Mateo Aug 20: populated-by-every-writer is not a
  // constraint; keep the client dumb, let the trigger decide).
  //
  //   - text nulls out on empty/whitespace-only → trigger stores NULL
  //     and inserts a "unpublish" history row when previously published
  //   - effective_date sent verbatim; PM sets it or leaves today's default
  //   - version + updated_at + updated_by are TRIGGER-SET, not sent
  //
  // Post-save: refetch the manager row so version + updated_at +
  // updated_by come back from the DB (state-truth, not optimistic).
  async function saveHouseRules() {
    if (!manager?.id) return
    setHouseRulesBusy(true); setHouseRulesMsg('')
    try {
      const normalizedText = houseRulesDraft.trim().length === 0 ? null : houseRulesDraft
      const effectiveForSubmit = normalizedText === null
        ? null                                     // unpublish clears the date too (mirrors trigger's clear-on-null)
        : (houseRulesEffectiveDate || null)       // empty string → null; trigger defaults to CURRENT_DATE
      const { error } = await supabase
        .from('properties')
        .update({
          house_rules_text:           normalizedText,
          house_rules_effective_date: effectiveForSubmit,
        })
        .eq('id', manager.id)
      if (error) {
        setHouseRulesMsg('Error: ' + error.message)
        return
      }
      // Audit row. Trigger writes the history table itself; this row
      // records manager intent + which portal action fired.
      await logAudit({
        action:     normalizedText === null ? 'UNPUBLISH_HOUSE_RULES' : 'SAVE_HOUSE_RULES',
        table_name: 'properties',
        record_id:  manager.id,
        new_values: {
          property:       manager.name,
          text_length:    normalizedText === null ? 0 : normalizedText.length,
          effective_date: effectiveForSubmit,
        },
      })
      // Refetch the row so the UI reflects trigger-set fields
      // (version, updated_at, updated_by).
      const { data: refreshed } = await supabase
        .from('properties')
        .select('*')
        .eq('id', manager.id)
        .maybeSingle()
      if (refreshed) setManager(refreshed)
      setHouseRulesMsg(normalizedText === null ? 'House rules unpublished.' : 'House rules saved.')
    } finally {
      setHouseRulesBusy(false)
    }
  }

  // ── Spaces v1 (commit 3) handlers ──────────────────────────────────
  // The 4 old handlers (fetchSpaces / handlePlateSearch / selectPlate /
  // saveSpace) DELETED. The saveSpace() direct UPDATE was the B225-class
  // write — every mutation now flows through one of the 6 DEFINER RPCs:
  //   • generate_spaces_from_pool  (submitAddSingleSpace, count=1)
  //   • assign_space               (submitAssignSpace)
  //   • reassign_space             (submitReassignSpace)
  //   • free_space                 (submitFreeSpace)
  //   • decommission_space         (submitDecommissionSpace)
  //   • update_space_metadata      (submitEditMetadata)

  // B212 — "Last updated N min ago" relative-time formatter for the
  // 3 pending-queue headers. Plain helper, no library. Used by all
  // three Refresh widgets. fmtAgo reads Date.now() at call-time, so
  // re-renders driven by refreshTicker (30s interval) keep it accurate.
  function fmtAgo(ts: number): string {
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
    if (sec < 30)  return 'just now'
    if (sec < 60)  return `${sec}s ago`
    const min = Math.floor(sec / 60)
    if (min < 60)  return `${min} min ago`
    const hr = Math.floor(min / 60)
    return `${hr}h ago`
  }

  // B212 — per-queue refresh helpers. Each refetches ONLY that queue's
  // data + stamps its own timestamp. No cross-queue refresh so manager
  // sees exactly which queue they just refreshed.
  async function refreshVehiclesPending() {
    if (!manager?.name) return
    await fetchVehicles(manager.name)
    setVehiclesPendingRefreshedAt(Date.now())
  }
  async function refreshSpaceRequestsPending() {
    if (!manager?.name) return
    await fetchPendingSpaceRequests(manager.name)
    setSpaceRequestsPendingRefreshedAt(Date.now())
  }
  async function refreshResidentsPending() {
    if (!manager?.name) return
    await fetchResidents(manager.name)
    setResidentsPendingRefreshedAt(Date.now())
  }

  // Spaces fixes 2026-06-28 (Bug 1 + Bug 2):
  //   Optional `property` arg lets callers pass the property name
  //   directly instead of reading the closure-captured `manager` state.
  //   This is the load-on-manager-load fix: fetchAll(property) calls
  //   these BEFORE React commits setManager, so closure-`manager` is
  //   still stale; passing `property` explicitly avoids the race.
  //
  //   Pre-fix: refetchSpacesDashboard ran ONLY when Spaces tab activated
  //   AND when manager?.name happened to be populated. If the useEffect
  //   captured a stale closure, the fetch silently returned empty
  //   (dashboard 0/0) and never re-fired until an add-space action.
  //   The available-spaces pool used by the Approvals-tab modal had the
  //   same gap: opening a space-request before ever visiting Spaces tab
  //   → empty pool → "no available spaces" even when spaces exist.
  //
  //   With this change, fetchAll(property) primes BOTH the dashboard
  //   (Bug 1) and the available pool (Bug 2) at manager-load time. The
  //   existing tab-activation useEffects still call with no arg (default
  //   to manager?.name) and are now defensive refreshers, not the sole
  //   path.
  // 2026-07-27 — single-fan-out CRM refresh, called after every write
  // path. Individual sites previously picked hand-selected subsets of
  // the refetch functions and drifted apart:
  //   • refetchSpacesDashboard / refetchSpacesList update the SPACES-TAB
  //     state (setOccupancy, setSpacesList, setAvailableSpacesForAssign).
  //   • fetchCrmDataForProperty updates the CRM state that
  //     PmResidentCrm actually reads: crmSpacesAtProperty,
  //     crmSpaceResidentTies, crmGuestAuthsAtProperty,
  //     crmPendingGuestRequestsAtProperty, crmSpaceRequestsAtProperty,
  //     crmPendingPlateChanges.
  //   • fetchResidents / fetchVehicles update the residents / vehicles /
  //     pendingVehicles state consumed by both surfaces.
  // Nobody's mental list included all three groups; R-10 didn't clear
  // and R-12 didn't appear because the CRM axis was never on any write
  // path. Every write now calls THIS — the decision of what to refresh
  // is made once, so adding a new CRM axis means one file changes not
  // ten. Promise.all keeps added latency to one round trip.
  async function refreshCrmData() {
    if (!manager?.name) return
    await Promise.all([
      fetchResidents(manager.name),
      fetchVehicles(manager.name),
      fetchCrmDataForProperty(manager.name),
      refetchSpacesDashboard(),
      refetchSpacesList(),
    ])
  }

  async function refetchSpacesDashboard(property?: string) {
    const prop = property ?? manager?.name
    if (!prop) return
    const dash = await fetchOccupancyDashboard(supabase, prop)
    setOccupancy(dash)
    // Inert defensive banner count (commit 1 produced 0 flagged rows in v1;
    // future per-customer rollouts may flag multi-residency unit assignments)
    const { count: flagged } = await supabase
      .from('spaces').select('*', { count: 'exact', head: true })
      .ilike('property', prop).not('migration_note', 'is', null)
    setFlaggedMigrationCount(flagged ?? 0)
    // Available-spaces pool for the resident-approval assign-on-approve
    // dropdowns (commit 4). Top 100 available spaces; manager-level property
    // unlikely to have more available at once.
    const { rows: available } = await fetchSpacesList(
      supabase, prop,
      { type: null, status: 'available', showInactive: false, search: '' },
      0, 100,
    )
    setAvailableSpacesForAssign(available)
  }

  // Returns the fresh rows so callers can use them BEFORE React commits
  // the setSpacesList dispatch. The prior shape (void return + closure
  // read of spacesList) was the root cause of Finding B v3 (Mateo Aug
  // 20 evening): onMutate's `spacesList.find(...)` after
  // `await refetchSpacesList()` reads the pre-dispatch closure, gets
  // the stale space (designated_vehicle_id=null on first designation),
  // hands it back to setTargetSpaceDetail — modal's reload deps see
  // no change on the null→value transition. Returning the rows here
  // sidesteps the closure entirely.
  async function refetchSpacesList(property?: string): Promise<Space[]> {
    const prop = property ?? manager?.name
    if (!prop) return []
    setSpacesListLoading(true)
    try {
      const { rows, totalCount } = await fetchSpacesList(supabase, prop, spacesFilters, spacesPage, spacesPageSize)
      setSpacesList(rows)
      setSpacesListTotal(totalCount)
      return rows
    } finally {
      setSpacesListLoading(false)
    }
  }

  async function submitAddSingleSpace() {
    setSpacesError('')
    // 2026-07-11 — quantity added. Non-approve managers are UI-capped at
    // quantity=1 (input hidden via canApproveVehicles below); server
    // enforces regardless (generate_spaces_from_pool: bulk >1 requires
    // can_approve_vehicles; cap 100 for manager callers). Client clamps
    // to [1,100] as belt-and-suspenders — server is the real boundary.
    const rawQty = Number(addForm.quantity) || 1
    const qty = Math.max(1, Math.min(100, Math.floor(rawQty)))
    const { error } = await supabase.rpc('generate_spaces_from_pool', {
      p_property: manager.name,
      p_type: addForm.type,
      p_count: qty,
      p_label_prefix: null,        // null → RPC auto-derives from type
    })
    if (error) { setSpacesError(error.message); return }
    const typeLabel = TYPE_LABELS[addForm.type]
    setTargetAdd(false)
    setAddForm({ type: 'carport', quantity: 1 })
    // 2026-07-27 — feedback before refresh (multi-space adds only).
    if (qty > 1) alert(`Added ${qty} ${typeLabel} spaces`)
    await refreshCrmData()
  }

  // v1.1 multi-resident: submitAssignSpace adds one resident to the
  // target space's tie set via assign_space RPC (set-add semantics,
  // server-side cap=2 enforced). Picker-driven — callers set both
  // targetAssign + assignFormEmail before invoking.
  async function submitAssignSpace() {
    if (!targetAssign) return
    setSpacesError('')
    const { error } = await supabase.rpc('assign_space', {
      p_space_id: targetAssign.id,
      p_resident_email: assignFormEmail,
    })
    if (error) { setSpacesError(error.message); return }
    setTargetAssign(null)
    setAssignFormEmail('')
    await refreshCrmData()
  }

  // v1.1 multi-resident: submitReassignSpace DROPPED. Manager UX is
  // 2 explicit clicks (remove via free-modal per-resident; add via
  // assign-modal). Set-world makes "reassign" ambiguous; explicit
  // remove + add matches the explicit-tying philosophy.

  // v1.1 multi-resident: submitFreeSpace gains optional p_resident_email
  // routing. Whole-space mode (freeResidentEmail=null) calls the RPC
  // with NULL email → DELETE all ties + status='available'. Per-resident
  // mode (freeResidentEmail set) calls with the email → DELETE one tie;
  // auto-free only if last. INVARIANT: never touches vehicles or
  // residents.is_active — space tie removal is independent of resident
  // authorization (whose vehicle stays authorized regardless).
  async function submitFreeSpace() {
    if (!targetFree) return
    setSpacesError('')
    // v1.1: optional p_resident_email routing.
    //   freeResidentEmail=null → whole-space free (DELETE all ties)
    //   freeResidentEmail set  → per-resident remove (DELETE that one tie;
    //                            auto-free only if last)
    const { error } = await supabase.rpc('free_space', {
      p_space_id:       targetFree.id,
      p_reason:         'manual_free',
      p_resident_email: freeResidentEmail,
    })
    if (error) { setSpacesError(error.message); return }
    setTargetFree(null)
    setFreeResidentEmail(null)
    await refreshCrmData()
  }

  async function submitDecommissionSpace() {
    if (!targetDecommission) return
    setSpacesError('')
    const { error } = await supabase.rpc('decommission_space', {
      p_space_id: targetDecommission.id,
    })
    if (error) { setSpacesError(error.message); return }
    setTargetDecommission(null)
    await refreshCrmData()
  }

  async function submitEditMetadata() {
    if (!targetEdit) return
    setSpacesError('')
    const { error } = await supabase.rpc('update_space_metadata', {
      p_space_id: targetEdit.id,
      p_label: editForm.label,
      p_description: editForm.description || null,
      p_type: editForm.type,
      p_is_bundled: editForm.is_bundled,
    })
    if (error) { setSpacesError(error.message); return }
    setTargetEdit(null)
    await refreshCrmData()
  }

  // B70: Plate Lookup — calls the SECURITY DEFINER pm_plate_lookup RPC.
  // RPC handles property scoping + audit write server-side; we just
  // surface the narrow {result_type, unit_number} response.
  async function runPlateLookup() {
    const raw = lookupPlate.trim()
    if (!raw) { setLookupError('Enter a plate to look up.'); return }
    setLookupBusy(true)
    setLookupError('')
    setLookupResult(null)
    try {
      // AP-VIEWING (2026-07-24): pass viewing property so pm_plate_lookup
      // scopes to the currently-viewed property. NULL default in the RPC
      // preserves back-compat for other callers (none today); the manager
      // client always passes it — see migration header.
      const { data, error } = await supabase.rpc('pm_plate_lookup', {
        p_plate: raw,
        p_viewing_property: manager?.name ?? null,
      })
      if (error) {
        setLookupError(error.message || 'Lookup failed. Please try again.')
        return
      }
      const result = (data || {}) as Record<string, unknown>
      const kind = String(result.result_type || '')
      // B230 Part B (2026-07-09): 'pending' + 'plate_under_review' added
      // to the whitelist. B220 added 'guest_authorized'. AP-CASCADE
      // (2026-07-23) added 'authorized_plate' — standing authorization
      // via branch 1.5. Any new pm_plate_lookup RPC return type must
      // land here or renders will silently degrade to "Unexpected
      // response from server."
      if (kind !== 'resident' && kind !== 'visitor' && kind !== 'unauthorized' && kind !== 'guest_authorized' && kind !== 'pending' && kind !== 'plate_under_review' && kind !== 'authorized_plate') {
        setLookupError('Unexpected response from server.')
        return
      }
      // Display the normalized plate (uppercase, no separators) so the
      // user sees exactly what got searched + logged in the audit row.
      const normalized = normalizePlate(raw)
      setLookupResult({
        result_type: kind as 'resident' | 'visitor' | 'unauthorized' | 'guest_authorized' | 'pending' | 'plate_under_review' | 'authorized_plate',
        unit_number: (result.unit_number as string | null) ?? null,
        queriedPlate: normalized,
        guest_name:  (result.guest_name  as string | null) ?? null,
        valid_through: (result.valid_through as string | null) ?? null,
        ap_property_name: (result.ap_property_name as string | null) ?? null,
        ap_label: (result.ap_label as string | null) ?? null,
      })
    } finally {
      setLookupBusy(false)
    }
  }

  async function fetchVehicles(property: string) {
    const { data } = await supabase.from('vehicles').select('*').ilike('property', property).order('unit')
    const all = data || []
    const pending = all.filter(v => v.status === 'pending')
    const rest = all.filter(v => v.status !== 'pending')
    setPendingVehicles(pending)
    setVehicles(rest)
    setStats(s => ({ ...s, total_vehicles: rest.length }))
  }

  // Space Requests v1 — fetch pending requests for this manager's
  // property. RLS scopes by property = ANY(get_my_properties()) so we
  // only see in-scope rows. Joined to residents on email for display
  // (name + unit) since space_requests denormalizes just resident_email.
  async function fetchPendingSpaceRequests(property: string) {
    const { data } = await supabase
      .from('space_requests')
      .select('*')
      .eq('status', 'pending')
      .ilike('property', property)
      .order('requested_at', { ascending: true })
    setPendingSpaceRequests(data || [])
  }

  async function approveSpaceRequest(requestId: number) {
    const spaceIdStr = approveSelections[requestId]
    if (!spaceIdStr) {
      setSpaceRequestError('Pick a space from the dropdown before approving.')
      return
    }
    setDecidingRequestId(requestId)
    setSpaceRequestError('')
    const { data, error } = await supabase.rpc('approve_space_request', {
      p_request_id: requestId,
      p_space_id:   Number(spaceIdStr),
    })
    setDecidingRequestId(null)
    if (error) {
      setSpaceRequestError(`Approve failed: ${error.message}`)
      return
    }
    const result = data as { ok?: boolean; error?: string; hint?: string }
    if (!result?.ok) {
      setSpaceRequestError(`Approve failed: ${result?.hint || result?.error || 'unknown error'}`)
      return
    }
    // Success: refresh queue + spaces pool (the approved space leaves
    // the available pool — refetch so the dropdown stays accurate).
    setApproveSelections(s => { const c = {...s}; delete c[requestId]; return c })
    fetchPendingSpaceRequests(manager.name)
    refetchSpacesList()
    // Also refresh the available-spaces pool for any later approval modal
    const { rows: available } = await fetchSpacesList(
      supabase, manager.name,
      { type: null, status: 'available', showInactive: false, search: '' },
      0, 100,
    )
    setAvailableSpacesForAssign(available)
  }

  async function declineSpaceRequest(requestId: number) {
    setDecidingRequestId(requestId)
    setSpaceRequestError('')
    const reason = (declineReasons[requestId] || '').trim()
    const reasonToSend = reason.length > 0 ? reason : null
    const { data, error } = await supabase.rpc('decline_space_request', {
      p_request_id:     requestId,
      p_decline_reason: reasonToSend,
    })
    setDecidingRequestId(null)
    if (error) {
      setSpaceRequestError(`Decline failed: ${error.message}`)
      return
    }
    const result = data as { ok?: boolean; error?: string; hint?: string }
    if (!result?.ok) {
      setSpaceRequestError(`Decline failed: ${result?.hint || result?.error || 'unknown error'}`)
      return
    }
    setDeclineReasons(r => { const c = {...r}; delete c[requestId]; return c })
    fetchPendingSpaceRequests(manager.name)
  }

  async function approveVehicle(id: string) {
    // Permit-Door Piece 1 §3 — billing-conversion prompt (PM-Only ONLY).
    // Non-PM tiers: no prompt (no permit meter; approval just fires).
    // CA on PM-Only sees the prompt too (informed, not gated).
    const ctx = getCompanyContext()
    if (ctx.tier === 'pm_only') {
      if (!window.confirm('Approve this vehicle as a billable permit?')) return
    }
    // Write core owns: approve_vehicle RPC + audit + sync-on-approve
    // (per-row semantics — one sync per approve). Bulk BYPASSES this
    // wrapper via runBulkApprove / approveVehiclesBatch to meter once
    // per batch instead of N times.
    // 2026-08-04 — occupancy stamp read from state at click time; the
    // manager sees the same figure the audit records. Look up the
    // vehicle's unit from pending / active vehicle state; buildOccupancyStamp
    // returns null when the map or unit is missing, and the writer
    // then omits the key rather than writing zeros.
    const vRow = [...pendingVehicles, ...vehicles].find((row: any) => String(row.id) === String(id))
    const vUnit: string | null = vRow?.unit ?? null
    const result = await approveVehicleWrite(supabase, {
      vehicleId: id,
      property: manager.name,
      managerNote: pendingNotes[id] || null,
      companyIdForSync,
      occupancyStamp: buildOccupancyStamp(unitOccupancy, vUnit),
    })
    if (!result.ok) return
    setPendingNotes(n => { const c = {...n}; delete c[id]; return c })
    // B231 parity — same refresh discipline as approveAllPendingCrm.
    // Approving one vehicle can flip its resident's needsApproval when
    // this was the resident's last pending item; the CRM display can't
    // recompute that until pendingVehicles + the other CRM dimensions
    // are current.
    await refreshCrmData()
  }

  async function declineVehicle(id: string) {
    // Write core owns: vehicles UPDATE + audit + residents-back-to-active
    // cascade at same (unit, property).
    await declineVehicleWrite(supabase, {
      vehicleId: id,
      property: manager.name,
      managerNote: pendingNotes[id] || null,
    })
    setPendingNotes(n => { const c = {...n}; delete c[id]; return c })
    await refreshCrmData()
  }

  async function approveAllForUnit(unitVehicles: any[], unit: string) {
    const note = unitNotes[unit] || null
    // Permit-Door Piece 1 §3 — billing-conversion prompt (PM-Only ONLY).
    // Batch shows the full count so the operator knows the scale of the
    // billing event they're authorizing.
    const ctxBulk = getCompanyContext()
    if (ctxBulk.tier === 'pm_only') {
      if (!window.confirm(`Approve ${unitVehicles.length} vehicles as billable permits?`)) return
    }
    // Slice 1 Commit 4b — loop the approve_vehicle RPC per vehicle (each
    // gets the unified scope-check + idempotency + uniform resident_read=true
    // from commit 4a). Collect approval actions; fire ONE permit sync
    // after the whole batch if any actually approved (the permit count
    // is ABSOLUTE, not delta — N syncs would be redundant Stripe calls
    // for the same final quantity).
    const results = await Promise.all(unitVehicles.map(async v => {
      const { data, error } = await supabase.rpc('approve_vehicle', {
        p_vehicle_id:   v.id,
        p_manager_note: note,
      })
      if (error) {
        console.error('[approve_vehicle] RPC error in bulk:', error.message, { vehicleId: v.id })
        return 'error'
      }
      const r = data as { ok?: boolean; action?: string } | null
      if (r?.ok) {
        console.info('[approve_vehicle]', { site: 'approveAllForUnit', vehicleId: v.id, action: r.action })
        await logAudit({ action: 'APPROVE_VEHICLE', table_name: 'vehicles', record_id: v.id, new_values: { status: 'active', property: manager.name } })
        return r.action ?? 'unknown'
      }
      return 'rpc_error'
    }))
    const bulkApprovedCount = results.filter(a => a === 'approved').length
    console.info('[B147-sync-batch-summary]', { site: 'approveAllForUnit', unit, batchSize: unitVehicles.length, approvedCount: bulkApprovedCount, willFireSync: bulkApprovedCount > 0 })
    if (bulkApprovedCount > 0 && companyIdForSync) {
      const syncRes = await callSyncOnAdd(companyIdForSync, 'permit')
      console.info('[B147-sync-result]', { site: 'approveAllForUnit', kind: 'permit', result: syncRes.ok ? syncRes.action : `failed:${syncRes.reason}` })
      if (!syncRes.ok) console.warn('[B147-sync-failed]', { context: 'approveAllForUnit', approvedCount: bulkApprovedCount, reason: syncRes.reason })
    }
    setUnitNotes(n => { const c = {...n}; delete c[unit]; return c })
    // B231 — same refresh discipline as approveVehicle + approveResident +
    // approveAllPendingCrm. Prior fire-and-forget on vehicles alone left
    // the CRM's Needs-approval lane stale (needsApproval derives from 5
    // dimensions; refreshing 1 is insufficient). Await both fetches so
    // the queue reflects the mutation before the button re-enables.
    await refreshCrmData()
  }

  // Permit-Door Piece 1 §5 — property-wide Approve-All Pending Vehicles.
  // Bulk-invite of N residents creates N pending vehicles (PM-Only via
  // initialVehicleState helper); a 500-resident upload would otherwise
  // need 500 per-unit clicks via approveAllForUnit. This action approves
  // every pending vehicle for the manager's property in one batch.
  //
  // Reuses the proven 4b batch-sync pattern: loop approve_vehicle RPC
  // per row, fire ONE permit sync after the batch if any actually
  // approved (count is absolute, not delta; N syncs would be redundant).
  // Billing prompt PM-Only only with the full count.
  async function approveAllPendingProperty() {
    const { data: pendingAll } = await supabase
      .from('vehicles').select('id')
      .ilike('property', manager.name).eq('status', 'pending')
    const ids = (pendingAll ?? []).map(p => p.id)
    if (ids.length === 0) {
      alert('No pending vehicles to approve.')
      return
    }
    const ctxAll = getCompanyContext()
    if (ctxAll.tier === 'pm_only') {
      if (!window.confirm(`Approve ${ids.length} vehicles as billable permits?`)) return
    }
    const results = await Promise.all(ids.map(async id => {
      const { data, error } = await supabase.rpc('approve_vehicle', {
        p_vehicle_id:   id,
        p_manager_note: null,
      })
      if (error) {
        console.error('[approve_vehicle] RPC error in approveAllPendingProperty:', error.message, { vehicleId: id })
        return 'error'
      }
      const r = data as { ok?: boolean; action?: string } | null
      if (r?.ok) {
        console.info('[approve_vehicle]', { site: 'approveAllPendingProperty', vehicleId: id, action: r.action })
        await logAudit({ action: 'APPROVE_VEHICLE', table_name: 'vehicles', record_id: id, new_values: { status: 'active', property: manager.name } })
        return r.action ?? 'unknown'
      }
      return 'rpc_error'
    }))
    const approvedCount = results.filter(a => a === 'approved').length
    console.info('[B147-sync-batch-summary]', { site: 'approveAllPendingProperty', property: manager.name, batchSize: ids.length, approvedCount, willFireSync: approvedCount > 0 })
    if (approvedCount > 0 && companyIdForSync) {
      const syncRes = await callSyncOnAdd(companyIdForSync, 'permit')
      console.info('[B147-sync-result]', { site: 'approveAllPendingProperty', kind: 'permit', result: syncRes.ok ? syncRes.action : `failed:${syncRes.reason}` })
      if (!syncRes.ok) console.warn('[B147-sync-failed]', { context: 'approveAllPendingProperty', approvedCount, reason: syncRes.reason })
    }
    // B231 — same refresh discipline as approveAllForUnit +
    // approveAllPendingCrm. Refetch both vehicles + CRM dimensions so
    // needsApproval recomputes against the authoritative post-mutation
    // truth (not just the vehicles dimension).
    await refreshCrmData()
  }

  async function declineAllForUnit(unitVehicles: any[], unit: string) {
    const note = unitNotes[unit] || null
    await Promise.all(unitVehicles.map(v =>
      supabase.from('vehicles').update({ is_active: false, status: 'declined', manager_note: note }).eq('id', v.id)
        .then(() => logAudit({ action: 'DECLINE_VEHICLE', table_name: 'vehicles', record_id: v.id, new_values: { status: 'declined', property: manager.name } }))
    ))
    // 2026-07-10 — escape ILIKE wildcards (pre-B166 vestige).
    await supabase.from('residents')
      .update({ status: 'active', is_active: true })
      .ilike('unit', escapeIlikeValue(unit))
      .ilike('property', escapeIlikeValue(manager.name))
      .eq('status', 'pending')
    setUnitNotes(n => { const c = {...n}; delete c[unit]; return c })
    await refreshCrmData()
  }

  async function fetchViolations(property: string) {
    const week = new Date(); week.setDate(week.getDate() - 7)
    // 2026-07-29 — hide voided tickets from the manager's working
    // queue (A1 request via Jose). Display-only: the row stays,
    // voided_at stays stamped, audit_logs stays immutable. `status`
    // deliberately NOT touched by the void action (Gate 6 orthogonality
    // — 'void' is NOT a status value; see app/company_admin/page.tsx:112).
    //
    // Reachability preserved by architectural split, not by a filter
    // chip here: manager portal shows a rolling 7-day working queue;
    // CA portal Activity is the 6-month system of record and DOES
    // render voided rows with a red "Voided · date · reason" badge.
    // A manager who needs to find a voided tow after the fact asks
    // their CA — or the record is queryable in the DB.
    //
    // Side effect worth noting: the violations_week KPI at L2629 already
    // filters .is('voided_at', null); this list did not. Adding the
    // predicate here brings the two into agreement — one voided
    // violation used to make the count read N while the list showed
    // N+1. Managers noticed and didn't report.
    //
    // Silent-read discipline (same pattern as ca658de CA sweep): error
    // destructured + logged so a grant/RLS denial doesn't render as
    // "no violations" identically to the legitimate zero-rows case.
    const { data, error } = await supabase.from('violations')
      .select('*, photo_rows:violation_photos(id, photo_url, removed_at), video_rows:violation_videos(id, video_url, removed_at)')
      .eq('is_confirmed', true)
      .ilike('property', property)
      .is('voided_at', null)
      .gte('created_at', week.toISOString())
      .order('created_at', { ascending: false })
    if (error) {
      console.error('[Manager fetchViolations] failed', { property, error })
      setViolations([])
      return
    }
    // B13/B18 Commit A: flatten photo_rows → v.photos filtered active.
    // C1: same flatten for video_rows → v.video_url filtered active.
    const flattened = (data || []).map(v => {
      const activeVideos = ((v.video_rows as { id: number; video_url: string; removed_at: string | null }[] | null) || [])
        .filter(vid => !vid.removed_at)
      return {
        ...v,
        photos: ((v.photo_rows as { id: number; photo_url: string; removed_at: string | null }[] | null) || [])
          .filter(p => !p.removed_at)
          .map(p => p.photo_url),
        video_url: activeVideos[0]?.video_url ?? null,
      }
    })
    setViolations(flattened)
    const today = new Date(); today.setHours(0,0,0,0)
    const todayCount = (data || []).filter(v => new Date(v.created_at) >= today).length
    setStats(s => ({ ...s, violations_today: todayCount, violations_week: data?.length || 0 }))
  }

  async function fetchPasses(property: string) {
    const now = new Date().toISOString()
    const { data } = await supabase
      .from('visitor_passes')
      .select('*')
      .ilike('property', property)
      .gte('expires_at', now)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
    setPasses(data || [])
    setStats(s => ({ ...s, active_passes: data?.length || 0 }))
  }

  // ── Visitor-pass at-cap V1 (2026-08-08) ──────────────────────────────
  //
  // Mirrors the enforce_visitor_pass_limit trigger EXACTLY. Diverging
  // means the manager reads a count on this page that disagrees with
  // the error text the visitor sees at the QR:
  //
  //   "This vehicle has already been issued % visitor passes at this
  //    property in the last 30 days."
  //
  // Predicate contract — from migrations/20260729_visitor_pass_rolling_30_semantics.sql:
  //   - property match: EXACT (=) — trigger uses `WHERE property = NEW.property`
  //   - time window:    created_at > now() - interval '30 days'
  //   - is_active:      NOT READ (count-everything-issued; revoked passes count)
  //   - plate:          UPPER(regexp_replace(plate, '[^A-Z0-9]', '', 'gi'))
  //   - exempt list:    matched with the SAME plate normalization; exempt
  //                     plates NEVER appear at cap (trigger short-circuits
  //                     before the count runs). Excluded here entirely.
  //   - "at cap":       count >= limit (>=, not >)
  //
  // Eligible-again formula (general form for over-cap cases):
  //   With N passes against limit L (N >= L), sorted oldest-first,
  //   count drops below L when the (N - L + 1)th oldest ages out.
  //   → eligible_at = passes[N - L].created_at + 30 days (0-indexed).
  //   N = L exactly → oldest + 30d (naive case).
  //   N > L (limit was lowered, or plate un-exempted) → later pass than
  //     the oldest. `min() + 30d` would be wrong; use the general form.
  //
  // Property source of truth: fetched fresh from `properties` here
  // (not read from stale `manager` state), so a limit change reflects
  // on next data refresh without needing a full manager re-fetch.
  async function fetchAtCapData(property: string) {
    // Read limit + exempt list fresh from properties (avoid stale
    // manager-state race).
    const { data: propRow } = await supabase
      .from('properties')
      .select('visitor_pass_limit, exempt_plates')
      .eq('name', property)
      .maybeSingle()

    // No limit configured → no enforcement → render nothing at all
    // in the Visitors tab. This is not "0 plates at cap" — it's
    // "the trigger is not enforcing anything here."
    if (!propRow || propRow.visitor_pass_limit == null) {
      setAtCapList(null)
      return
    }
    const L = propRow.visitor_pass_limit as number

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: passesInWindow } = await supabase
      .from('visitor_passes')
      .select('plate, visiting_unit, visitor_name, is_active, created_at, expires_at')
      .eq('property', property)          // EXACT — mirrors trigger
      .gte('created_at', cutoff)         // rolling-30
      .order('created_at', { ascending: true })  // oldest-first — feeds eligible-at calc

    const normalize = (s: string | null | undefined): string =>
      (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const exemptSet = new Set(
      ((propRow.exempt_plates as string[] | null) || []).map(p => normalize(p))
    )

    // Group by normalized plate; exclude exempt entirely.
    const byPlate = new Map<string, AtCapPass[]>()
    for (const p of (passesInWindow as AtCapPass[] | null) || []) {
      const n = normalize(p.plate)
      if (!n || exemptSet.has(n)) continue
      let bucket = byPlate.get(n)
      if (!bucket) { bucket = []; byPlate.set(n, bucket) }
      bucket.push(p)
    }

    // Filter to at-cap and compute eligible-at.
    // 2026-08-08 — eligible-at computation extracted to
    // app/lib/visitor-pass-cap.ts (eligibleAgainAt). Same formula the
    // resident portal uses for the pass-limit message — one place, one
    // implementation. Note: helper uses CALENDAR arithmetic in
    // PROPERTY_TIME_ZONE (not fixed 30*86400000 ms) to avoid an
    // off-by-one-day error near the fall-back DST transition. See the
    // helper's header for the divergence-risk note.
    //
    // Probe 8 (Mateo relay): ATCAP03 must still read 8/17 after this
    // refactor — anchor regression test.
    const entries: AtCapEntry[] = []
    for (const [normalizedPlate, rows] of byPlate) {
      if (rows.length < L) continue
      const N = rows.length
      const eligibleAt = eligibleAgainAt(rows, L)
      if (!eligibleAt) continue  // defensive; N >= L guaranteed by the check above
      entries.push({
        normalizedPlate,
        // Display the most recent pass's plate string (case/formatting
        // as issued). Underlying identity is normalizedPlate.
        displayPlate: rows[N - 1].plate,
        count: N,
        limit: L,
        eligibleAt: eligibleAt.toISOString(),
        passes: rows,
      })
    }
    // Sort: highest count first (surfaces worst abuse); tiebreaker by
    // soonest-eligible (most actionable). Empty list stays empty.
    entries.sort((a, b) =>
      (b.count - a.count) ||
      (new Date(a.eligibleAt).getTime() - new Date(b.eligibleAt).getTime())
    )

    setAtCapList({ limit: L, entries })
  }

  // Silent-read reveal (2026-08-01) — the ORIGINAL shape swallowed
  // errors AND blanked state on empty responses. Both bugs stack:
  //   1. `const { data }` (no error destructure) — transport / auth
  //      / SQL errors set data=null; the `data || []` fallthrough
  //      then nuked both lists to [].
  //   2. Even with error captured, RLS denials return
  //      {data: [], error: null} — they FILTER, they don't ERROR
  //      (see feedback_rls_denials_return_empty_not_error.md).
  //      A property-scope drift, deactivated user_roles row, or
  //      wrong session presents as zero rows with no error at all.
  //
  // Reveal shape:
  //   • Destructure {data, error}. On error: preserve prior state,
  //     log with tag, set fetchState to 'error'.
  //   • On empty: if prior state HAD rows, treat as suspicious
  //     ('unexpectedly_empty' — likely RLS/scope drift); preserve
  //     prior state; log; set fetchState. If prior state was also
  //     empty, accept as genuinely empty and pass through.
  //   • Always console.info the row count on every call. When
  //     someone reports "blank," the console tells you instantly
  //     whether the query returned nothing or the render dropped it.
  //   • Return {ok, reason?} so callers can decide whether to
  //     bail. Not currently used by refreshCrmData (Promise.all
  //     doesn't inspect), but stable for future callers.
  async function fetchResidents(
    property: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'error' | 'unexpectedly_empty' | 'superseded' }> {
    // Bump the token BEFORE the await. On return, compare — if another
    // fetchResidents call bumped it in the meantime, the response we
    // just got belongs to a prior request the user is no longer looking
    // at. Discarding avoids overwriting state with stale (usually
    // zero-row) data from a property they've since switched away from.
    const token = ++fetchResidentsToken.current
    const { data, error } = await supabase
      .from('residents').select('*').ilike('property', property).order('unit')
    if (token !== fetchResidentsToken.current) {
      console.info('[Manager fetchResidents] superseded — discarding', {
        property, token, current: fetchResidentsToken.current,
      })
      // Prior state PRESERVED. A later call is in flight or already
      // landed; letting this response through would overwrite whatever
      // that call sets (or is about to set).
      return { ok: false, reason: 'superseded' }
    }
    if (error) {
      console.error('[Manager fetchResidents] query failed', { property, error })
      setResidentsFetchState({ status: 'error', at: Date.now() })
      // Prior state PRESERVED — do NOT nuke pendingResidents/residents.
      return { ok: false, reason: 'error' }
    }
    const all = data ?? []
    console.info('[Manager fetchResidents] result', { property, count: all.length })
    // "Unexpectedly empty" branch — closure-reads current state at fetch-call
    // time. React closures snapshot at render, so this sees the state as it
    // was when refreshCrmData was invoked (which is what we want — before
    // any of the parallel Promise.all fetches mutate state).
    const hadRowsInState = pendingResidents.length + residents.length > 0
    if (all.length === 0 && hadRowsInState) {
      console.warn('[Manager fetchResidents] zero rows where rows existed in state', {
        property,
        prev_pending: pendingResidents.length,
        prev_active: residents.length,
      })
      setResidentsFetchState({ status: 'unexpectedly_empty', at: Date.now() })
      // Prior state PRESERVED — do NOT blank the manager's last-known view
      // on a suspicious empty. This is the load-bearing line: blanking
      // destroys the only evidence the manager has about what USED to be
      // visible.
      return { ok: false, reason: 'unexpectedly_empty' }
    }
    setPendingResidents(all.filter(r => r.status === 'pending'))
    setResidents(all.filter(r => r.status !== 'pending'))
    setResidentsFetchState({ status: 'ok', at: Date.now() })
    return { ok: true }
  }

  async function resetResidentPassword() {
    if (!resetPwTarget) return
    if (resetPwForm.newPw.length < 8) { setResetPwMsg('Password must be at least 8 characters.'); return }
    if (resetPwForm.newPw !== resetPwForm.confirmPw) { setResetPwMsg('Passwords do not match.'); return }
    const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL || ''
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(fnBase + '/swift-handler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
      body: JSON.stringify({ action: 'reset_password', email: resetPwTarget, new_password: resetPwForm.newPw }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { setResetPwMsg(json.error || json.message || 'Failed to reset password.'); return }
    setResetPwMsg('Password reset successfully.')
    setTimeout(() => { setResetPwTarget(null); setResetPwForm({ newPw:'', confirmPw:'' }); setResetPwMsg('') }, 2000)
  }

  // notifyResidentDecision moved to app/lib/manager-crm-writes.ts (Phase B1)
  // — same pure-fetch shape, imported at top of file. Callers unchanged.

  async function approveResident(r: any) {
    // 2026-08-07 reapproval-orphans intercept. Before firing the write,
    // check whether this resident has plates on file that aren't
    // currently authorized — deactivated, declined, expired, etc.
    // (isVehicleUnauthorizedForRestore excludes pending, which is in
    // the approval queue with its own surface). If any, open the
    // ReapprovalOrphansModal and let the manager decide restore /
    // approve-without-restoring / cancel. On approve-with-restore,
    // the modal handler routes restores through approveVehiclesBatch
    // (meter-once) then falls through to runApproveResident.
    //
    // Fail-quiet: if r.vehicles is missing, absent, or unreadable,
    // treat as "no orphans" and approve as today. Never invent zeros
    // to reassure — same rule as the unit-occupancy panel.
    const vehiclesOnFile: any[] = Array.isArray(r?.vehicles) ? r.vehicles : []
    const orphans: OrphanPlate[] = vehiclesOnFile
      .filter(v => isVehicleUnauthorizedForRestore(v))
      .map(v => ({
        id:                  v.id,
        plate:               v.plate ?? '',
        ymm:                 [v.year, v.make, v.model].filter(Boolean).join(' ') || null,
        status:              v.status ?? null,
        deactivation_reason: v.deactivation_reason ?? null,
        deactivation_note:   v.deactivation_note ?? null,
        deactivated_at:      v.deactivated_at ?? null,
      }))

    if (orphans.length > 0) {
      // Open modal; resume via handleReapprovalOrphansConfirm below.
      setReapprovalOrphans({ resident: r, orphans })
      return
    }
    // No orphans → approve as today, no intercept.
    await runApproveResident(r, null)
  }

  // The actual approve — extracted from approveResident so both the
  // no-orphans direct path AND the modal-confirmed path can call it.
  // reapprovalOrphansDecision is threaded into the audit when the
  // modal was surfaced (null when there were no orphans to show).
  async function runApproveResident(
    r: any,
    reapprovalOrphansDecision: {
      shownPlateIds:    Array<string | number>
      restoredPlateIds: Array<string | number>
      skippedPlateIds:  Array<string | number>
    } | null,
  ) {
    // Write core owns: residents UPDATE + notify + audit. See historical
    // header comment (silent-write reveal 2026-08-01, ordering rewire,
    // friendlyWriteError inline) for context.
    const write = await approveResidentWrite(supabase, {
      resident: { id: r.id, name: r.name, unit: r.unit, email: r.email },
      property: manager.name,
      managerNote: residentNotes[r.id] || null,
      occupancyStamp: buildOccupancyStamp(unitOccupancy, r.unit ?? null),
      reapprovalOrphansDecision,
    })
    if (!write.ok) {
      console.error('[Manager approveResident] write failed', { residentId: r.id, error: write.error })
      const errObj = write.error as Error | undefined
      const msg = errObj?.message || ''
      const isNetwork = errObj instanceof TypeError
        || /Load failed|Failed to fetch|NetworkError|network|ECONNREFUSED|timeout/i.test(msg)
      alert(isNetwork
        ? "Couldn't reach the server. Check your connection and try again."
        : "Couldn't approve. Try again — if this keeps happening, contact your company administrator.")
      return
    }
    // Cascade vehicle approval for this resident's unit. Uses the shared
    // batch primitive (approveVehiclesBatch) — same meter-once discipline
    // as runBulkApprove phase-2, scoped to one unit. PM-only prompt lives
    // in the surface (mobile per-row will skip this whole block on
    // pm_only per feedback_mobile_pending_list_is_the_confirmation.md).
    const pendingCascade = await listPendingVehiclesForUnit(supabase, { unit: r.unit, property: manager.name })
    let shouldCascade = pendingCascade.length > 0
    const ctxCascade = getCompanyContext()
    if (shouldCascade && ctxCascade.tier === 'pm_only') {
      if (!window.confirm(`Approve ${pendingCascade.length} vehicles as billable permits?`)) {
        console.info('[approve_vehicle]', { site: 'approveResident-cascade', skipped: 'billing-prompt-cancelled', count: pendingCascade.length })
        shouldCascade = false
      }
    }
    if (shouldCascade) {
      await approveVehiclesBatch(supabase, {
        vehicles: pendingCascade.map(v => ({ id: v.id, plate: v.plate, unit: (v as any).unit ?? r.unit ?? null })),
        property: manager.name,
        companyIdForSync,
        logSite: 'approveResident-cascade',
        unitOccupancy,
      })
    }
    // Spaces v1 commit 4 — OPTIONAL assign-space step. Manager picked a
    // space in the pending-row dropdown → call assign_space RPC after the
    // resident UPDATE succeeds. NON-FATAL per Jose 2026-06-21 lock:
    // "approval ≠ assignment, most residents hold zero spaces" — if the
    // assign fails (e.g., space taken between dropdown-load and submit),
    // resident approval stays; manager can assign via the Spaces tab.
    // Mobile per-row surface omits this block entirely (mobile has no
    // space picker — spaces stay per-row on desktop only).
    const pickedSpaceId = pendingResidentAssignSpaceId[r.id]
    if (pickedSpaceId) {
      const { error: assignErr } = await supabase.rpc('assign_space', {
        p_space_id: parseInt(pickedSpaceId),
        p_resident_email: (r.email ?? '').toLowerCase(),
      })
      if (assignErr) {
        // Soft alert — resident approval already committed; assign failed.
        alert(`Resident approved, but space assignment failed: ${assignErr.message}\n\nYou can assign a space later via the Spaces tab.`)
      }
      setPendingResidentAssignSpaceId(prev => { const c = { ...prev }; delete c[r.id]; return c })
    }
    setResidentNotes(n => { const c = {...n}; delete c[r.id]; return c })
    // B231 parity — approveResident cascades vehicle approval (see the
    // approveVehiclesBatch call above), so pendingVehicles state gets
    // stale too if not refetched. Also refresh the CRM dimensions so
    // needsApproval recomputes against the authoritative post-mutation
    // truth (see approveAllPendingCrm comment).
    await refreshCrmData()
    // Refresh spaces dashboard + available-pool so the freshly-assigned
    // space disappears from the assign dropdowns for other pending rows.
    if (pickedSpaceId) await refetchSpacesDashboard()
  }

  // 2026-08-07 — handles the ReapprovalOrphansModal's confirm event.
  // Three shapes:
  //   - choice='restore', restorePlateIds.length > 0:
  //       restore the checked plates via approveVehiclesBatch (one
  //       sync per batch — snapshot semantics; see 2026-08-07 §1
  //       report to Mateo), then fire runApproveResident with the
  //       decision recorded in the audit.
  //   - choice='approve_without_restore':
  //       approve the resident, record all shown plates as skipped.
  //       Plates stay unauthorized.
  //   - The audit thread carries shown/restored/skipped so the
  //     evidentiary record shows what the manager was shown AND
  //     what they chose. Skipped is the more interesting fact in a
  //     later dispute.
  //
  // Cancel closes the modal without approving. Manager can click
  // Approve again — same intercept fires. No state is lost.
  async function handleReapprovalOrphansConfirm(args: ReapprovalOrphansConfirmArgs) {
    if (!reapprovalOrphans) return
    const { resident } = reapprovalOrphans
    setReapprovalBusy(true)
    try {
      if (args.choice === 'restore' && args.restorePlateIds.length > 0) {
        // Route restore through approveVehiclesBatch — meter-once
        // discipline. Idempotent on already-active (noop_already_active
        // return). Failures per-plate are surfaced in the batch result
        // but not fatal to the resident approve.
        const restoreVehicles = reapprovalOrphans.orphans
          .filter(o => args.restorePlateIds.some(id => String(id) === String(o.id)))
          .map(o => ({ id: String(o.id), plate: o.plate, unit: resident.unit ?? null }))
        const batchResult = await approveVehiclesBatch(supabase, {
          vehicles: restoreVehicles,
          property: manager.name,
          companyIdForSync,
          logSite: 'reapproval-orphans-restore',
          managerNote: null,
          unitOccupancy,
        })
        if (batchResult.failed.length > 0) {
          console.warn('[reapproval-orphans] some restores failed', { failed: batchResult.failed })
          // Non-fatal — proceed with resident approve. Manager sees the
          // per-plate failures in the CRM refresh (still is_active=false).
        }
      }
      await runApproveResident(resident, {
        shownPlateIds:    args.shownPlateIds,
        restoredPlateIds: args.restorePlateIds,
        skippedPlateIds:  args.skippedPlateIds,
      })
    } finally {
      setReapprovalOrphans(null)
      setReapprovalBusy(false)
    }
  }

  // Bulk approve is orchestrated by runBulkApprove in
  // app/lib/manager-crm-writes.ts (Phase B1) — full 2-phase ordered
  // combined action + allow-list gate + meter-once sync all live there
  // with the anti-optimization comment. Mobile view (Build 2) reuses
  // the same lib. Bulk lane must be gated on canApproveVehicles at the
  // render site; this surface handler assumes caller has checked.
  async function approveAllPendingCrm(pendingResidentsForBulk: any[]) {
    if (!manager?.name) return

    // Widened SELECT (id + plate + resident_email + unit) so failures
    // can be named by plate in the summary, the phase-2 eligibility gate
    // can match resident_email against the active-resident allow set,
    // AND the phase-2 audit can attach occupancy_at_decision keyed by
    // the vehicle's own unit (2026-08-04). Surface fetches this once
    // for the confirmation dialog count and passes it to runBulkApprove
    // (avoids double-query).
    const { data: allPendingVehicles, error: vehListErr } = await supabase
      .from('vehicles').select('id, plate, resident_email, unit')
      .ilike('property', manager.name).eq('status', 'pending')
    if (vehListErr) {
      console.error('[Manager approveAllPendingCrm] pending-vehicles list fetch failed', vehListErr)
      alert(`Could not load pending vehicles: ${vehListErr.message}\n\nNo approvals were attempted.`)
      return
    }
    const rCount = pendingResidentsForBulk.length
    const vCount = (allPendingVehicles ?? []).length
    if (rCount === 0 && vCount === 0) {
      alert('No pending approvals.')
      return
    }
    const ctx = getCompanyContext()
    const parts: string[] = []
    if (rCount > 0) parts.push(`${rCount} resident${rCount === 1 ? '' : 's'}`)
    if (vCount > 0) parts.push(`${vCount} vehicle${vCount === 1 ? '' : 's'}`)
    const scope = parts.join(' · ')
    const suffix = ctx.tier === 'pm_only' && vCount > 0 ? ' as billable permits' : ''
    if (!window.confirm(`Approve ${scope}${suffix}?\n\nResidents are approved first. Vehicles are approved only for residents whose approval succeeds.`)) return

    // Delegate all phases to the lib. Returns the summary input shape
    // for buildBulkApproveSummary (Phase A helper); surface renders alert.
    // 2026-08-04 — unitOccupancy is threaded through so both phase-1
    // residents and phase-2 vehicles get the occupancy_at_decision
    // stamp from the same batch payload the UI showed. Fail-quiet:
    // null map means no stamps written (audit falls back to base shape).
    const result = await runBulkApprove(supabase, {
      property: manager.name,
      companyIdForSync,
      pendingResidentsForBulk,
      allPendingVehicles: allPendingVehicles ?? [],
      unitOccupancy,
    })
    if (!result.ok) {
      alert(`Bulk approve failed: ${(result.error as any)?.message ?? String(result.error)}\n\nSome approvals may have partially completed. Refresh to see current state.`)
      await refreshCrmData()
      return
    }
    // Summary FIRST (feedback-before-refresh, 9a47464), then refresh.
    alert(buildBulkApproveSummary(result.summary).text)
    await refreshCrmData()
  }

  // PM CRM slice 3 — space-write handlers. Route through the existing
  // DEFINER RPCs (assign_space / free_space / approve_space_request /
  // decline_space_request). Server enforces role (manager|CA) + property/
  // company scope; client hides affordances on isReadOnly (leasing_agent).
  // Every RPC writes its own audit_logs row internally — no extra logAudit
  // needed here.
  //
  // Release semantics: free_space(space_id, 'manual_free', resident_email)
  // is the PER-TIE path (v1.1 multi-resident) — deletes ONLY the caller's
  // tie from space_residents. Co-residents survive. Whole-space free is
  // reserved for deactivation cascade.
  async function releaseSpaceForResident(spaceId: number, residentEmail: string) {
    if (!manager?.name) return
    if (!window.confirm('Release this space for reassignment?\n\nCo-residents (if any) retain their tie. Assignment history is kept.')) return
    const { data, error } = await supabase.rpc('free_space', {
      p_space_id: spaceId,
      p_reason: 'manual_free',
      p_resident_email: residentEmail,
    })
    if (error) {
      alert(`Release failed: ${error.message}`)
      console.error('[free_space] RPC error:', error)
      return
    }
    console.info('[free_space]', { site: 'crm-release', spaceId, residentEmail, result: data })
    // Refresh CRM data + spaces dashboard so the released space returns to
    // the available pool visible on the Spaces tab.
    await refreshCrmData()
  }

  async function assignSpaceForRequest(requestId: number, spaceId: number) {
    if (!manager?.name) return
    const { data, error } = await supabase.rpc('approve_space_request', {
      p_request_id: requestId,
      p_space_id: spaceId,
    })
    if (error) {
      alert(`Assign failed: ${error.message}`)
      console.error('[approve_space_request] RPC error:', error)
      return
    }
    const result = data as { error?: string } | null
    if (result?.error) {
      alert(`Assign failed: ${result.error}`)
      console.error('[approve_space_request] RPC returned error:', result.error)
      return
    }
    console.info('[approve_space_request]', { site: 'crm-assign', requestId, spaceId, result })
    await refreshCrmData()
    fetchPendingSpaceRequests(manager.name)
    refetchSpacesDashboard()
  }

  async function declineSpaceRequestFromCrm(requestId: number) {
    if (!manager?.name) return
    const reason = window.prompt('Decline reason (optional — surfaced to the resident):', '')
    // null = user hit Cancel → abort; empty string = declined without reason
    if (reason === null) return
    const { data, error } = await supabase.rpc('decline_space_request', {
      p_request_id: requestId,
      p_decline_reason: reason.trim() || null,
    })
    if (error) {
      alert(`Decline failed: ${error.message}`)
      console.error('[decline_space_request] RPC error:', error)
      return
    }
    const result = data as { error?: string } | null
    if (result?.error) {
      alert(`Decline failed: ${result.error}`)
      console.error('[decline_space_request] RPC returned error:', result.error)
      return
    }
    console.info('[decline_space_request]', { site: 'crm-decline', requestId, result })
    await refreshCrmData()
    fetchPendingSpaceRequests(manager.name)
  }

  // PM CRM slice 4 — plate-change handlers. Route through DEFINER RPCs:
  //   approve_plate_change (gated on can_approve_vehicles; substitution,
  //     NO callSyncOnAdd — permit count unchanged, meter untouched)
  //   decline_plate_change (role gate only; old plate stays valid)
  // The RPCs write their own audit_logs rows internally.
  //
  // METER-ZERO: neither handler nor RPC invokes callSyncOnAdd. A plate
  // change is a substitution, not a new permit. Firing the meter here
  // would double-count the existing permit — the exact bug Jose called
  // out for the guardrail. Verified by the probe scanning audit_logs for
  // any permit-sync row in the approve window (there should be none).
  async function approvePlateChange(changeId: number) {
    if (!manager?.name) return
    const { data, error } = await supabase.rpc('approve_plate_change', { p_change_id: changeId })
    if (error) {
      alert(`Approve plate change failed: ${error.message}`)
      console.error('[approve_plate_change] RPC error:', error)
      return
    }
    const result = data as { ok?: boolean; error?: string; old_plate?: string; new_plate?: string } | null
    if (!result?.ok) {
      alert(`Approve plate change failed: ${result?.error ?? 'unknown'}`)
      console.error('[approve_plate_change] RPC returned error:', result?.error)
      return
    }
    console.info('[approve_plate_change]', { site: 'crm', changeId, old_plate: result.old_plate, new_plate: result.new_plate, meter_fired: false })
    await refreshCrmData()
  }

  async function declinePlateChange(changeId: number) {
    if (!manager?.name) return
    const reason = window.prompt('Decline reason (optional — surfaced to the resident):', '')
    if (reason === null) return  // Cancel pressed
    const { data, error } = await supabase.rpc('decline_plate_change', {
      p_change_id: changeId,
      p_decline_reason: reason.trim() || null,
    })
    if (error) {
      alert(`Decline plate change failed: ${error.message}`)
      console.error('[decline_plate_change] RPC error:', error)
      return
    }
    const result = data as { ok?: boolean; error?: string } | null
    if (!result?.ok) {
      alert(`Decline plate change failed: ${result?.error ?? 'unknown'}`)
      console.error('[decline_plate_change] RPC returned error:', result?.error)
      return
    }
    console.info('[decline_plate_change]', { site: 'crm', changeId })
    await refreshCrmData()
  }

  // PM CRM slice 5 — vehicle deactivate/reactivate.
  // Deactivate: role-gated (manager|CA + !isReadOnly). Removing enforcement
  //   protection is NOT permit-granting, so no can_approve_vehicles gate.
  //   Direct client UPDATE — RLS admits managers at own properties. Record
  //   kept, is_active=false, status='deactivated' distinguishes from
  //   'declined' (declined = never approved; deactivated = was approved,
  //   protection removed).
  // Reactivate: routes through approve_vehicle wrapper — permit-granting,
  //   so can_approve_vehicles gate applies (at the CRM render level). RPC
  //   flips is_active=true, status='active', client fires callSyncOnAdd.
  //   Same-cycle deactivate+reactivate = noop_within_floor (item.quantity
  //   was never decremented at the meter — decrement happens at cycle
  //   close via reconcileAtRenewal). Net-zero, guaranteed by ratchet.
  // Task 3 Commit 3 (2026-08-06). Opens DeactivateVehicleModal — the
  // native window.confirm() had no place to collect a structured
  // reason + note. Actual write routes through
  // deactivateVehicleWrite → deactivate_vehicle DEFINER RPC, which
  // closes the render-side-only authority gap from Task 1 (1c1ce5a).
  //
  // Context passed in from the VehicleCard so the modal can render
  // plate + ymm + resident + unit without a fetch round-trip.
  function deactivateVehicleCrm(v: any) {
    if (!manager?.name) return
    if (!v?.id) return
    // Look up owning resident for display context (from already-loaded
    // residents state; no fetch round-trip).
    const ownerEmail = (v.resident_email ?? '').toLowerCase()
    const owner = residents.find((r: any) => (r.email ?? '').toLowerCase() === ownerEmail)
    const ymmParts = [v.year, v.make, v.model].filter(Boolean).join(' ')
    setTargetDeactivateVehicle({
      id:            v.id,
      plate:         v.plate ?? '',
      ymm:           ymmParts || undefined,
      residentName:  owner?.name,
      residentUnit:  v.unit ?? owner?.unit,
      property:      manager.name,
    })
  }

  // Called when the modal's Deactivate button is clicked. Runs the
  // write core → shows friendly error on failure → refreshes on success.
  async function runOneDeactivateVehicle(args: { reason: string; note: string | null }) {
    if (!targetDeactivateVehicle) return
    const { id, property } = targetDeactivateVehicle
    setDeactivateVehicleBusy(true)
    try {
      const result = await deactivateVehicleWrite({
        supabase,
        vehicleId: id,
        reason:    args.reason,
        note:      args.note,
        actor:     managerEmail,
        property,
        // 2026-08-09 Commit D — manager-initiated single-vehicle
        // deactivation. Every cascade path (trim / unit-vacant / admin
        // property) bypasses the writer entirely and is exempt-by-
        // construction; the deactivateVehicleWrite writer sees only
        // this call site, so notify=true is the only sensible value.
        // Reason code's `notifies` field is the final gate:
        // plate_superseded / registered_in_error suppress even here.
        notify:    true,
      })
      if (!result.ok) {
        alert(`Deactivate failed: ${result.message ?? 'The database rejected the deactivation.'}`)
        console.error('[deactivateVehicleWrite]', result)
        return
      }
      console.info('[deactivate_vehicle]', { site: 'crm', vehicleId: id, reason: args.reason, meter_fired: false })
    } finally {
      setTargetDeactivateVehicle(null)
      setDeactivateVehicleBusy(false)
      await refreshCrmData()
    }
  }

  async function reactivateVehicleCrm(id: string | number) {
    // Reuse the existing approve_vehicle wrapper — same wrapper the per-
    // vehicle Approve button uses. It fires callSyncOnAdd on action=
    // 'approved'. In the deactivate+reactivate same-cycle case,
    // syncOnAdd's ratchet returns 'noop_within_floor' (item.quantity was
    // never dropped). Cross-cycle case, syncOnAdd correctly ratchets up
    // because item.quantity dropped at cycle close.
    if (!manager?.name) return
    if (!window.confirm('Reactivate this vehicle?\n\nThe plate will be re-authorized. This routes through the same approval flow used for new vehicles.')) return
    await approveVehicle(String(id))
    console.info('[reactivate_vehicle]', { site: 'crm', vehicleId: id, note: 'routes through approve_vehicle wrapper — meter sync fires; noop_within_floor if same-cycle' })
  }

  // ═════════════════════════════════════════════════════════════════
  // PM CRM Slice 6 — inline edit + audit
  //
  // Cosmetic fields save inline; plate NEVER via this path — routes
  // through submit_plate_change (Slice 4). The save allowlists below
  // are the enforcement boundary: even if a future dev adds a plate
  // input to the form, the handler's Object.entries filter drops it
  // before the UPDATE builds. Belt: DB-level partial unique index
  // (Slice-5 hardening) would 23505 any smuggled plate collision.
  //
  // Gate discipline: manager|CA + !isReadOnly (per standing rule —
  // no permit granted, so no can_approve_vehicles).
  //
  // Audit: EDIT_VEHICLE / EDIT_RESIDENT with only the fields that
  // actually changed. Empty diff → skip audit write.
  // ═════════════════════════════════════════════════════════════════

  const VEHICLE_EDITABLE_FIELDS = ['color', 'make', 'model', 'year', 'state'] as const
  // HOTFIX 2026-07-04 — `tags` removed. `residents` has no tags column;
  // the read at editResidentCosmetic named it, causing every edit
  // (phone/lease_end/manager_note) to fail before any diff/write. A
  // future tags feature = additive slice (column + input + probe).
  const RESIDENT_EDITABLE_FIELDS = ['phone', 'lease_end', 'manager_note'] as const
  type VehicleField = typeof VEHICLE_EDITABLE_FIELDS[number]
  type ResidentField = typeof RESIDENT_EDITABLE_FIELDS[number]

  async function editVehicleCosmetic(vehicleId: string | number, patch: Partial<Record<VehicleField, any>>) {
    if (!manager?.name) return
    // Allowlist enforcement — drop anything not in VEHICLE_EDITABLE_FIELDS.
    // Explicitly named for grepability. `plate` is INTENTIONALLY EXCLUDED —
    // it routes through submit_plate_change (Slice 4). If a caller passes
    // a plate value here, this filter drops it silently and the underlying
    // vehicle row is never touched at the plate column.
    const clean: Record<string, any> = {}
    for (const [k, v] of Object.entries(patch)) {
      if ((VEHICLE_EDITABLE_FIELDS as readonly string[]).includes(k)) clean[k] = v
    }
    if (Object.keys(clean).length === 0) return  // no-op
    // Load current values so we can compute a diff for the audit row.
    const { data: current, error: readErr } = await supabase.from('vehicles')
      .select('id, color, make, model, year, state')
      .eq('id', vehicleId).single()
    if (readErr || !current) {
      alert(`Edit failed: could not read current vehicle: ${readErr?.message ?? 'unknown'}`)
      return
    }
    const oldVals: Record<string, any> = {}
    const newVals: Record<string, any> = {}
    for (const k of Object.keys(clean)) {
      const oldV = (current as any)[k]
      const newV = clean[k]
      // JSON stringify comparison catches obj/array + primitive alike;
      // string-only handler here (no nested types) so === is enough,
      // JSON.stringify is defensive against edge cases.
      if (JSON.stringify(oldV) !== JSON.stringify(newV)) {
        oldVals[k] = oldV
        newVals[k] = newV
      }
    }
    if (Object.keys(newVals).length === 0) return  // no actual change → no audit
    const { error: updErr } = await supabase.from('vehicles').update(clean).eq('id', vehicleId)
    if (updErr) {
      alert(`Edit failed: ${updErr.message}`)
      return
    }
    await logAudit({
      action: 'EDIT_VEHICLE',
      table_name: 'vehicles',
      record_id: String(vehicleId),
      old_values: oldVals,
      new_values: newVals,
    })
    await refreshCrmData()
  }

  async function editResidentCosmetic(residentId: string | number, patch: Partial<Record<ResidentField, any>>) {
    if (!manager?.name) return
    const clean: Record<string, any> = {}
    for (const [k, v] of Object.entries(patch)) {
      if ((RESIDENT_EDITABLE_FIELDS as readonly string[]).includes(k)) clean[k] = v
    }
    if (Object.keys(clean).length === 0) return
    const { data: current, error: readErr } = await supabase.from('residents')
      .select('id, phone, lease_end, manager_note')
      .eq('id', residentId).single()
    if (readErr || !current) {
      alert(`Edit failed: could not read current resident: ${readErr?.message ?? 'unknown'}`)
      return
    }
    const oldVals: Record<string, any> = {}
    const newVals: Record<string, any> = {}
    for (const k of Object.keys(clean)) {
      const oldV = (current as any)[k]
      const newV = clean[k]
      if (JSON.stringify(oldV) !== JSON.stringify(newV)) {
        oldVals[k] = oldV
        newVals[k] = newV
      }
    }
    if (Object.keys(newVals).length === 0) return
    const { error: updErr } = await supabase.from('residents').update(clean).eq('id', residentId)
    if (updErr) {
      alert(`Edit failed: ${updErr.message}`)
      return
    }
    await logAudit({
      action: 'EDIT_RESIDENT',
      table_name: 'residents',
      record_id: String(residentId),
      old_values: oldVals,
      new_values: newVals,
    })
    await refreshCrmData()
  }

  async function declineResident(r: any) {
    // Write core bundles: residents UPDATE + pending-vehicle UPDATE +
    // notify + audit + B166 owner-trim. All cascades are invariants of
    // the decline shape and travel together in one call.
    await declineResidentWrite(supabase, {
      resident: { id: r.id, name: r.name, unit: r.unit, email: r.email },
      property: manager.name,
      managerNote: residentNotes[r.id] || null,
    })
    setResidentNotes(n => { const c = {...n}; delete c[r.id]; return c })
    await refreshCrmData()
  }

  // B166 — fetch active residents at (unit, property) so the addVehicle
  // picker can pre-select / force-pick / fall back to Unit-level. Called
  // on Modal A Unit-input blur and on Modal B open.
  async function fetchResidentsAtUnit(unit: string | null | undefined) {
    if (!unit || !manager?.name) { setResidentsAtUnit([]); setVehicleOwnerEmail(''); return }
    const trimmed = unit.trim()
    if (!trimmed) { setResidentsAtUnit([]); setVehicleOwnerEmail(''); return }
    // B166 — escape ILIKE wildcards on the user-entered unit. Non-
    // destructive SELECT (lower stakes than the owner-trim UPDATE) but
    // applied for consistency with the trim predicate.
    const { data } = await supabase
      .from('residents')
      .select('email, name')
      .ilike('unit', escapeIlikeValue(trimmed))
      .ilike('property', escapeIlikeValue(manager.name))
      .eq('is_active', true)
    const list = (data || []).filter(r => r.email)
    setResidentsAtUnit(list)
    // Pre-select sole resident; force pick at 2+ (empty); empty at 0 → Unit-level.
    setVehicleOwnerEmail(list.length === 1 ? list[0].email : '')
  }

  async function addVehicle(unit?: string) {
    if (!newVehicle.plate) { alert('Plate is required'); return }
    // B217 — double-click guard. Vehicle add is one of the highest-
    // blast-radius dup paths: a second INSERT lands a duplicate plate
    // row, then a second permit-meter sync fires under Piece 1, etc.
    setAddVehicleSubmitting(true)
    try {
      const normalizedPlate = normalizePlate(newVehicle.plate)
      // B166 — normalize picked owner email at the stamp site. Empty
      // string → null = Unit-level / shared (B150 cascade handles vacancy).
      const ownerEmail = vehicleOwnerEmail.trim().toLowerCase() || null
      // permit_expiry coercion: form holds '' when blank; Postgres rejects
      // '' on a DATE column with `invalid input syntax for type date`.
       // Coerce explicitly (same family as the residents.lease_end fix).
      // Permit-Door Piece 1 §1/§2 — vehicle insert state via the centralized
      // helper (PM-Only → pending → approval is the metering chokepoint;
      // all other tiers → active, preserving today's behavior).
      // Slice-4 close-out (Jose 2026-07-03) — enforcement-integrity guard.
      // Reject if this plate is already active on another vehicle at
      // this property. Same-property scope; deactivated plates OK to
      // reuse. Server-side backstop would be a partial unique index —
      // flagged as future hardening after the TEST1 duplicate at Bayou
      // Heights gets cleaned up.
      const collisionErr = await assertPlateUniqueAtProperty(supabase, normalizedPlate, manager.name)
      if (collisionErr) { alert(collisionErr); return }

      const initState = initialVehicleState(getCompanyContext().tier)
      const { error } = await supabase.from('vehicles').insert([{
        ...newVehicle,
        plate: normalizedPlate,
        unit: unit || newVehicle.unit,
        property: manager.name,
        // 🟢 2026-08-28 vehicles.company arc Commit 2 — manager.company
        // is the properties row's company field (populated in the
        // manager-bootstrap fetch at L465). Already in scope, no
        // additional lookup.
        company: manager.company,
        resident_email: ownerEmail,
        status: initState.status,
        is_active: initState.is_active,
        year: parseInt(newVehicle.year) || null,
        permit_expiry: newVehicle.permit_expiry || null,
      }])
      if (error) { alert('Error: ' + error.message) }
      else {
        await logAudit({ action: 'ADD_VEHICLE', table_name: 'vehicles', new_values: { plate: normalizedPlate, make: newVehicle.make, model: newVehicle.model, unit: unit || newVehicle.unit, property: manager.name, resident_email: ownerEmail } })
        alert('Vehicle added!')
        setShowAddVehicle(false)
        setNewVehicle({ plate:'', state:'TX', make:'', model:'', year:'', color:'', unit:'', space:'', permit_expiry:'' })
        setVehicleOwnerEmail('')
        setResidentsAtUnit([])
        await refreshCrmData()
      }
    } finally {
      setAddVehicleSubmitting(false)
    }
  }

  // ── Manager Add Vehicle for existing resident (2026-08-08) ──────────
  //
  // Closes the "second vehicle" dead end: Add Resident takes exactly
  // one vehicle, so a manager adding a second car for the same resident
  // has had no move today. Also usable when the pre-e5369f8 companion-
  // vehicle proxy dropped a car and the plate needs to land now.
  //
  // ── Shape (mirrors legacy addVehicle at :2260 ± tier discipline) ──
  //   1. Collision — assertPlateUniqueAtProperty; enhanced 2026-08-08
  //      to name the owning resident + unit (per-property scope makes
  //      it safe within the manager's RLS reach)
  //   2. Insert — status/is_active from initialVehicleState(tier).
  //      PM-Only → pending; Enforcement/Legacy → active. Unit from the
  //      DETAIL-VIEW resident row (never re-queried — same class as
  //      the resident_row_precedence lock)
  //   3. If PM-Only: call approveVehicleWrite inline to fire
  //      approve_vehicle → callSyncOnAdd('permit'). One manager click,
  //      right billing. The RPC server-side gates on can_approve_vehicles
  //      per 20260628_permit_door_piece1_manager_approve_authority
  //      (my earlier report cited a superseded migration; corrected
  //      by grep across all CREATE OR REPLACE sites — recorded as an
  //      extension in feedback_reading_vs_looking.md).
  //   4. Audit — MANAGER_ADD_VEHICLE_FOR_RESIDENT (new action) with
  //      tier_at_creation, auto_approved, approve_action so a later
  //      billing question is answerable.
  //
  // ── Partial-state note ──
  //   If insert succeeds but the PM-Only inline approve fails, the row
  //   is a benign PENDING vehicle in the approval queue — visible to
  //   the manager, one click to finish. Contrast with the deactivation
  //   cascades where a partial state produced a towable car; no
  //   ordering ceremony needed on this path.
  //
  // ── Client gate (defense-in-depth) ──
  //   PmResidentCrm's VehiclesPane already gates the button on
  //   canApproveVehicles && residentDisplayStatus(resident) === 'active'.
  //   This handler assumes the caller passed those gates but does not
  //   re-check — a crafted call from a compromised client would still
  //   land at the server-side approve_vehicle gate (for PM-Only) and
  //   the RLS on vehicles INSERT (for both tiers). Same defense-in-
  //   depth pattern as approveVehicleWrite's caller sites.
  async function handleAddVehicleSubmit(
    resident: CrmResident,
    payload: AddVehiclePayload,
  ): Promise<AddVehicleSubmitResult> {
    if (!manager?.name) {
      return { ok: false, friendlyMessage: 'Property context missing. Refresh and try again.' }
    }
    const propertyName = manager.name
    const residentEmail = resident.email.toLowerCase()
    const residentUnit = resident.unit  // detail-view attribution; NEVER re-query

    // 1. Collision check (per-property, friendly message names owner)
    const collisionErr = await assertPlateUniqueAtProperty(supabase, payload.plate, propertyName)
    if (collisionErr) {
      return { ok: false, friendlyMessage: collisionErr }
    }

    // 2. Determine initial state from tier
    const ctx = getCompanyContext()
    const initState = initialVehicleState(ctx.tier)

    // 3. Insert vehicle
    const { data: insertData, error: insertErr } = await supabase
      .from('vehicles')
      .insert([{
        plate:          payload.plate,
        state:          payload.state,
        make:           payload.make,
        model:          payload.model,
        year:           payload.year,
        color:          payload.color,
        unit:           residentUnit,
        property:       propertyName,
        resident_email: residentEmail,
        status:         initState.status,
        is_active:      initState.is_active,
      }])
      .select('id')
      .single()

    if (insertErr || !insertData?.id) {
      console.error('[MANAGER_ADD_VEHICLE_FOR_RESIDENT] insert failed:', insertErr?.message, { propertyName, residentEmail, plate: payload.plate })
      return { ok: false, friendlyMessage: `Could not add vehicle: ${insertErr?.message ?? 'unknown error'}` }
    }
    const vehicleId = String(insertData.id)

    // 4. PM-Only: auto-approve inline so the permit meter fires
    let approveAction: string | null = null
    if (initState.status === 'pending') {
      const companyIdForSync = await (async () => {
        const { data } = await supabase.from('companies').select('id').ilike('name', managerCompany || '').maybeSingle()
        return (data?.id as number | undefined) ?? null
      })()
      const approve = await approveVehicleWrite(supabase, {
        vehicleId,
        property: propertyName,
        managerNote: null,
        companyIdForSync,
      })
      approveAction = approve.action
      if (!approve.ok) {
        // Partial state — insert landed, approve failed. Vehicle is a
        // benign PENDING row in the approval queue. Audit the intent
        // (below) with auto_approved=false; UI surfaces success with
        // a note the manager can finish the approval manually.
        console.warn('[MANAGER_ADD_VEHICLE_FOR_RESIDENT] inline approve failed; vehicle left pending', {
          vehicleId, propertyName, residentEmail, plate: payload.plate,
          approveError: approve.error,
        })
      }
    }

    // 5. Audit
    await logAudit({
      action: 'MANAGER_ADD_VEHICLE_FOR_RESIDENT',
      table_name: 'vehicles',
      record_id: vehicleId,
      new_values: {
        plate:              payload.plate,
        state:              payload.state,
        make:               payload.make,
        model:              payload.model,
        year:               payload.year,
        color:              payload.color,
        unit:               residentUnit,
        property:           propertyName,
        resident_id:        resident.id,
        resident_email:     residentEmail,
        tier_at_creation:   ctx.tier,
        initial_status:     initState.status,
        auto_approved:      initState.status === 'pending' && approveAction === 'approved',
        approve_action:     approveAction,
      },
    })

    // 6. Close modal + refresh
    setAddVehicleFor(null)
    await refreshCrmData()
    return { ok: true }
  }

  // 🔴 2026-08-20 Finding A follow-up (Aug 4 backlog vehicles-status-
  // is_active-divergence.md "removeVehicle exception" fold-in).
  //
  // Manager-initiated permanent removal. This is the SUBTRACTIVE
  // manager action symmetric with deactivateVehicleCrm's approach:
  // it should write BOTH is_active AND status (like the DEACTIVATE_
  // VEHICLE RPC flip) so display + enforcement + noAuthorizedBucket
  // divergence-check agree on the row's classification.
  //
  // Pre-Aug-20 shape wrote is_active=false but left status='active',
  // producing the exact `is_active=false AND status='active'`
  // divergence the Aug 4 backlog documented. Not one of the six
  // Green Acres rows (those came from cascade paths that are CORRECT
  // to write is_active only — cascades preserve status so
  // reactivation can restore it), but same visible-count class:
  // manager clicks Remove, tile still says "approved."
  //
  // Fix — write both fields explicitly, mirroring the RPC's flip
  // pattern:
  //   is_active = false
  //   status    = 'deactivated'
  //
  // Deliberately does NOT route through the deactivate_vehicle DEFINER
  // RPC because that RPC requires a reason from the closed-set enum
  // + a confirmation modal; this legacy Remove button is a bare
  // confirm() with no reason UI. Route consolidation would need a
  // separate UX pass. For now, the direct .update() writes both
  // fields so the divergence class doesn't reappear here even if the
  // route stays.
  //
  // AUDIT: extends new_values to record status too, so a future
  // audit-log query can distinguish direct-Remove writes from
  // cascade writes.
  async function removeVehicle(id: string) {
    if (!confirm('Remove this vehicle?')) return
    await supabase.from('vehicles').update({
      is_active: false,
      status:    'deactivated',
    }).eq('id', id)
    await logAudit({
      action:     'REMOVE_VEHICLE',
      table_name: 'vehicles',
      record_id:  id,
      new_values: {
        is_active: false,
        status:    'deactivated',
        property:  manager.name,
      },
    })
    await refreshCrmData()
  }

  async function addResident() {
    if (!newResident.name || !newResident.unit || !newResident.email) { alert('Name, email and unit are required'); return }
    // 2026-07-27 — fail-loud guard on company scoping. managerCompany
    // is useState('') and populates async from user_roles; if it hasn't
    // landed OR the manager genuinely has no company, the insert would
    // otherwise write company=null (the RPC signature accepts null),
    // creating a resident that company-scoped predicates treat
    // inconsistently. The Add Resident button is separately gated on
    // managerCompany so this alert essentially never fires on the load
    // race; it exists as a backstop for the genuine no-company case.
    if (!managerCompany) {
      alert('Could not determine your company. Refresh and try again, or contact support.')
      return
    }
    // B217 — double-click guard. Highest-blast-radius dup path on this
    // page: a second cascade would attempt to create another auth user
    // (rejected by swift-handler as duplicate), then a second
    // residents INSERT (rejected by RLS/dup), and could mis-fire the
    // companion-vehicle insert. Outer try/finally so EVERY exit path
    // (early-return, swift-handler fail, inner catch rollback, optional
    // assign-space step) resets the flag.
    setAddResidentSubmitting(true)
    try {

    const targetEmail = newResident.email.trim().toLowerCase()
    const tempPassword = generateTempPassword()
    const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL || ''

    // Step 1: Create the auth user via swift-handler (service-role bridge).
    const swiftRes = await fetch(fnBase + '/swift-handler', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ action: 'create_user', email: targetEmail, password: tempPassword }),
    })
    if (!swiftRes.ok) {
      const j = await swiftRes.json().catch(() => ({}))
      alert('Could not create login account: ' + (j.error || j.message || 'unknown error'))
      return
    }

    // Steps 2 + 3: Insert residents row + user_role with must_change_password.
    // If either fails, deactivate the orphan auth user and surface a clear
    // error — do NOT show the credentials modal.
    let residentInserted = false
    try {
      // B197 — explicit residents-column enumeration (was: spread of
      // newResident, which carried vehicle_plate/state/make/model/year/color
      // form fields into the residents insert and tripped PostgREST's
      // schema-cache check on the first vehicle_* column). Vehicle fields
      // are written to the `vehicles` table at the B167 step below, never
      // here. Matches the CA-portal precedent (app/company_admin/page.tsx
      // createUser resident-branch) + the B182 explicit-enumeration
      // discipline (server-side projection over CSS-hiding).
      const { error: rErr } = await supabase.from('residents').insert([{
        name:      newResident.name,
        email:     targetEmail,
        phone:     newResident.phone || null,
        unit:      newResident.unit,
        space:     newResident.space || null,
        lease_end: newResident.lease_end || null,
        property:  manager.name,
        // 2026-08-09 — Was missing. Every resident created via this path
        // shipped with residents.company = NULL, discovered when two
        // Test Legacy seed rows (627, 628 — Jose's July 27 throwaways)
        // classified as `anchor-missed` under the deactivation-email
        // gate. Zero A1 exposure (sweep query returned NULL rows only
        // at Test Legacy; A1 residents arrive via bulk-invite + /register
        // which both set company). Latent bug — would have bitten the
        // moment any A1 manager used Add Resident.
        //
        // The B197 explicit-enumeration discipline (see comment above)
        // enumerates cosmetic fields; company was omitted from that
        // enumeration. The `:2510-2517` guard prevents managerCompany
        // from being empty at call time, so passing it here can't write
        // NULL under normal operation.
        //
        // Companion vehicle insert at :2618 does NOT need this — the
        // `vehicles` table has no `company` column (documented at
        // app/api/billing/bulk-invite/route.ts:319-320: "B203 — `company`
        // column does NOT exist on `vehicles`; ownership scope is via
        // (property, unit) + resident_email").
        company:   managerCompany,
        is_active: true,
      }])
      if (rErr) throw new Error('residents INSERT failed: ' + rErr.message)
      residentInserted = true

      const { error: roleErr } = await supabase.rpc('insert_user_role', {
        p_email: targetEmail,
        p_role: 'resident',
        p_company: managerCompany || null,
        p_property: manager.name ? [manager.name] : [],
      })
      if (roleErr) throw new Error('user_role INSERT failed: ' + roleErr.message)

      const { error: flagErr } = await supabase.rpc('set_must_change_password', {
        p_email: targetEmail,
        p_value: true,
      })
      if (flagErr) throw new Error('must_change_password set failed: ' + flagErr.message)

      // B167 — step 4: optional vehicle insert with INLINE error
      // boundary. Last in the try; failure must NOT bubble to the
      // outer catch (which would roll back the resident). Pattern
      // matches bulk-invite/route.ts:307 — resident commit stands;
      // customer can add the vehicle later via the Edit Resident
      // modal or /resident if this insert fails.
      if (newResident.vehicle_plate.trim()) {
        // Permit-Door Piece 1 §1/§2 — vehicle insert state via the
        // centralized helper. PM-Only → pending (approval is the
        // metering chokepoint); all other tiers → active (preserves
        // today's behavior since this is the manager-trusted
        // resident-create cascade, not a self-register).
        // Slice-4 close-out (Jose 2026-07-03) — enforcement-integrity
        // guard on the addResident cascade insert. Same rule + helper
        // as the addVehicle path above. Cascade-fatal: if the plate is
        // duped, the whole resident-add flow rolls back (resident insert
        // has already committed; caller handles rollback / message via
        // its existing try/finally). Instead of hard-throwing, surface
        // a soft alert and skip only the vehicle insert — the resident
        // stays, they can add the vehicle later via Edit Resident.
        const cascadePlateNormalized = normalizePlate(newResident.vehicle_plate)
        const cascadeCollisionErr = await assertPlateUniqueAtProperty(supabase, cascadePlateNormalized, manager.name)
        if (cascadeCollisionErr) {
          alert(cascadeCollisionErr + '\n\nThe resident record was created without the vehicle. Add it later via Edit Resident.')
        } else {

        const cascadeInitState = initialVehicleState(getCompanyContext().tier)
        const { error: vehErr } = await supabase.from('vehicles').insert([{
          plate: normalizePlate(newResident.vehicle_plate),
          state: newResident.vehicle_state || 'TX',
          make: newResident.vehicle_make.trim() || null,
          model: newResident.vehicle_model.trim() || null,
          year: parseInt(newResident.vehicle_year) || null,
          color: newResident.vehicle_color.trim() || null,
          unit: newResident.unit,
          property: manager.name,
          // 🟢 2026-08-28 vehicles.company arc Commit 2 — same
          // manager.company source as the Add-Vehicle path above.
          company: manager.company,
          // B166 — owner stamp. targetEmail already lowercased at L522.
          resident_email: targetEmail,
          is_active: cascadeInitState.is_active,
          status:    cascadeInitState.status,
        }])
        if (vehErr) {
          // Inline boundary — log + soft alert + CONTINUE. Do NOT throw.
          console.error('[B167-vehicle-insert-failed]', { residentEmail: targetEmail, plate: newResident.vehicle_plate, error: vehErr.message })
          alert('Resident created successfully, but the vehicle could not be added: ' + vehErr.message + '\n\nYou can add the vehicle later via the Edit Resident → Vehicles section.')
        } else {
          await logAudit({ action: 'ADD_VEHICLE', table_name: 'vehicles', new_values: { plate: normalizePlate(newResident.vehicle_plate), source: 'ADD_RESIDENT', unit: newResident.unit, property: manager.name, resident_email: targetEmail } })
        }
        }  // end else — collision guard passed
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      // Roll back the auth user (and the residents row if it landed).
      await fetch(fnBase + '/swift-handler', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ action: 'deactivate_user', email: targetEmail }),
      }).catch(() => { /* best-effort */ })
      if (residentInserted) {
        // 2026-07-10 fix — swap direct .delete().ilike() for DEFINER RPC.
        // Prior shape had no DELETE policy for manager on residents; every
        // rollback silently 0-rowed and left orphan rows. RPC enforces
        // manager-property scope server-side (p_property required for
        // manager callers). Best-effort surfacing preserved: on failure,
        // log and continue with the cascade + user-facing alert.
        const { error: rollbackErr } = await supabase.rpc('delete_orphaned_pending_resident', {
          p_email: targetEmail,
          p_property: manager.name,
        })
        if (rollbackErr) {
          console.error('[orphan-rollback-manager]', { email: targetEmail, property: manager.name, error: rollbackErr.message })
        }
        // B150 — same lifecycle cascade as deactivateResident. Gate-check
        // ensures we only archive vehicles if NO other active resident
        // remains at the tuple (handles roommate case).
        await cascadeVehiclesIfUnitVacant(newResident.unit, manager.name, 'ADD_RESIDENT_ROLLBACK')
      }
      alert('Could not complete resident setup: ' + msg + '\n\nThe login account has been deactivated. Try again or contact support.')
      return
    }

    // Spaces v1 commit 4 — OPTIONAL assign-space on resident-add. Same
    // non-fatal pattern as approveResident. Resident is already committed
    // at this point; assign failure surfaces a soft alert, manager can
    // assign later via the Spaces tab.
    if (newResidentAssignSpaceId) {
      const { error: assignErr } = await supabase.rpc('assign_space', {
        p_space_id: parseInt(newResidentAssignSpaceId),
        p_resident_email: targetEmail,
      })
      if (assignErr) {
        alert(`Resident created, but space assignment failed: ${assignErr.message}\n\nYou can assign a space later via the Spaces tab.`)
      } else {
        await refreshCrmData()
      }
      setNewResidentAssignSpaceId('')
    }
    await logAudit({
      action: 'RESIDENT_CREATED_WITH_AUTH',
      table_name: 'residents',
      new_values: {
        email: targetEmail,
        created_by_role: isReadOnly ? 'leasing_agent' : 'manager',
        created_by_email: managerEmail,
        property: manager.name,
      },
    })

    setShowAddResident(false)
    setNewResident({ name:'', email:'', phone:'', unit:'', space:'', lease_end:'', vehicle_plate:'', vehicle_state:'TX', vehicle_make:'', vehicle_model:'', vehicle_year:'', vehicle_color:'' })
    // 2026-07-27 — feedback before refresh. The manager is on the phone
    // with the resident, waiting to read out the temp password; fire the
    // credentials modal first so it appears immediately, then run the
    // CRM refresh in the background. Reverse order would delay the modal
    // behind five parallel refetches.
    setCredentials({ email: targetEmail, password: tempPassword })
    await refreshCrmData()
    } finally {
      // B217 outer guard reset — covers all exit paths (swift-handler
      // fail return, inner-catch rollback return, normal completion).
      setAddResidentSubmitting(false)
    }
  }

  async function saveResident() {
    const { error } = await supabase.from('residents').update({
      name: editingResident.name,
      email: editingResident.email,
      phone: editingResident.phone,
      unit: editingResident.unit,
      space: editingResident.space,
      lease_end: editingResident.lease_end || null,
    }).eq('id', editingResident.id)
    if (error) { alert('Error: ' + error.message) }
    else {
      await logAudit({ action: 'EDIT_RESIDENT', table_name: 'residents', record_id: editingResident.id, new_values: { name: editingResident.name, email: editingResident.email, unit: editingResident.unit, property: manager.name } })
      alert('Resident updated!'); setEditingResident(null); fetchResidents(manager.name)
    }
  }

  // v1.1 multi-resident: deactivateResident now opens DeactivateResidentModal
  // (replaces the old confirm()) so the manager can opt-in to deactivate
  // co-residents at the same unit in one orchestrated action. The actual
  // per-resident deactivation work lives in runOneDeactivate (called by
  // runDeactivateBatch, one call per chosen email). The space-tie cleanup
  // is handled by the residents_deactivate_free_spaces DB trigger
  // (commit-1 migration) — not the client.
  async function deactivateResident(id: string) {
    // Lookup the target's (email, unit, property) first; we need unit to
    // load co-residents and we need email/property for the trigger to fire
    // cleanly when runOneDeactivate writes residents.is_active=false.
    const { data: r } = await supabase.from('residents').select('email, name, unit, property').eq('id', id).maybeSingle()
    if (!r?.email || !r?.unit) {
      alert('Could not load resident details. Refresh and try again.')
      return
    }
    // Co-residents at the same unit (active only; exclude the target itself).
    const { data: coRows } = await supabase
      .from('residents')
      .select('email, name')
      .ilike('unit', escapeIlikeValue(r.unit.trim()))
      .ilike('property', escapeIlikeValue(r.property?.trim() || manager.name))
      .eq('is_active', true)
      .neq('id', id)
    const coResidents: CoResident[] = (coRows ?? [])
      .filter(c => c.email && c.email.toLowerCase() !== r.email.toLowerCase())
      .map(c => ({ email: c.email.toLowerCase(), name: c.name ?? '' }))

    setTargetDeactivate({
      id,
      email: r.email.toLowerCase(),
      name: r.name ?? '',
      unit: r.unit,
      coResidents,
    })
    setDeactivateBusy(false)
  }

  // Per-resident deactivation (the work that used to live in
  // deactivateResident's body). Called once per email by runDeactivateBatch
  // — target first, then any opted-in co-residents. Each invocation fires
  // the residents_deactivate_free_spaces DB trigger which handles space-tie
  // cleanup atomically; the client only handles vehicle owner-trim + the
  // B150 unit-vacancy cascade as it did before v1.1.
  //
  // 🔴 2026-08-05 rewrite (Task 3 Commit 2): the old inline shape did not
  // check {error} on residents.update, so all four cascades ran even
  // when the update silently failed. Route through deactivateResidentWrite
  // which enforces error-check → audit → cascade ordering. On failure,
  // NOTHING runs after — no audit, no cascades, no space-request/guest-
  // auth declines. Returns { ok, error? } so the batch driver can stop
  // on first fail and surface which residents were already committed.
  async function runOneDeactivate(residentId: string, reason: string, note: string | null): Promise<{ ok: boolean; error?: string; residentLabel?: string }> {
    const result = await deactivateResidentWrite({
      supabase, residentId,
      reason, note,
      actor: managerEmail,
      property: manager.name,
      // 2026-08-09 Commit C — required, no default (Mateo lock).
      // Manager-initiated call site → notify. The reason's `notifies`
      // field is the final gate; suppressed reasons (duplicate_record,
      // registered_in_error, resident_requested) don't send even with
      // notify=true. Admin cascade at admin/page.tsx:481 does NOT go
      // through this writer — it's a bulk .update() — so it's exempt
      // by construction; parameter exists so that stays enforced by
      // the type system if someone ever routes the cascade here.
      notify: true,
    })
    if (!result.ok) {
      const label = result.message ?? 'The database rejected the deactivation.'
      console.error('[runOneDeactivate] deactivateResidentWrite failed', { residentId, reason: result.reason, error: result.error })
      return { ok: false, error: label }
    }
    const snap = result.residentSnapshot!  // ok=true guarantees snapshot
    const residentLabel = snap.name || snap.email || `resident ${residentId}`
    // B166 owner-trim + B150 cascade — now run only AFTER a successful
    // write. Trim carries excludeResidentId=residentId so the ownership
    // guard filters the just-deactivated row out of the sibling count
    // regardless of ordering (was implicit-via-flip before; now explicit).
    // Space-tie cleanup is DB-trigger-driven (residents_deactivate_free_spaces).
    await trimDepartedResidentVehicles(supabase, snap.email, snap.unit, snap.property, 'DEACTIVATE_RESIDENT', residentId)
    await cascadeVehiclesIfUnitVacant(snap.unit, snap.property, 'DEACTIVATE_RESIDENT')
    // RT-D — F2/F3 cascade: cancel this resident's PENDING space_requests
    // and PENDING guest_authorizations so nothing dangles under an
    // inactive resident. Auto-declined requests are terminal and NOT
    // auto-restored on reactivate (same class as B150 unit-cascade
    // casualties — reactivated resident must re-submit).
    const lowerEmail = (snap.email ?? '').toLowerCase()
    if (lowerEmail) {
      // space_requests_decided_consistency_chk requires decided_by_email
      // + decided_at on any pending → decided transition. Stamp both.
      const { data: srDecl } = await supabase.from('space_requests')
        .update({
          status: 'declined',
          decline_reason: 'resident_deactivated',
          decided_by_email: managerEmail,
          decided_at: new Date().toISOString(),
        })
        .ilike('resident_email', lowerEmail).eq('status', 'pending')
        .select('id')
      const declinedSrIds = (srDecl ?? []).map(x => x.id)
      if (declinedSrIds.length > 0) {
        await logAudit({
          action: 'DECLINE_SPACE_REQUEST_CASCADE', table_name: 'space_requests',
          record_id: declinedSrIds.join(','),
          new_values: { status: 'declined', reason: 'resident_deactivated',
                        cascade_source: 'DEACTIVATE_RESIDENT',
                        resident_id: residentId, count: declinedSrIds.length },
        })
      }
      const { data: gaDecl } = await supabase.from('guest_authorizations')
        .update({ status: 'declined', declined_reason: 'resident_deactivated' })
        .ilike('resident_email', lowerEmail).eq('status', 'pending')
        .select('id')
      const declinedGaIds = (gaDecl ?? []).map(x => x.id)
      if (declinedGaIds.length > 0) {
        await logAudit({
          action: 'DECLINE_GUEST_AUTH_CASCADE', table_name: 'guest_authorizations',
          record_id: declinedGaIds.join(','),
          new_values: { status: 'declined', reason: 'resident_deactivated',
                        cascade_source: 'DEACTIVATE_RESIDENT',
                        resident_id: residentId, count: declinedGaIds.length },
        })
      }
    }
    return { ok: true, residentLabel }
  }

  // Orchestrates: target + any opted-in co-residents. Sequential (a manager
  // rarely cascades more than 2-3) so individual failures are isolated and
  // the trigger fires once per call. After all done, refetch + close modal.
  //
  // 🔴 Stop-on-first-fail (Mateo Aug 5): at a typical batch of 2-3, a
  // mid-batch failure almost certainly means something systemic (RLS,
  // network) that the next row will hit too. Better mental model:
  // "the batch stopped at step 2, here's what's already committed."
  // Reason applies to the whole batch (co-residents move out for the
  // same reason as the target — stated in modal copy).
  async function runDeactivateBatch(args: { reason: string; note: string | null; alsoEmails: string[] }) {
    if (!targetDeactivate) return
    const { reason, note, alsoEmails } = args
    setDeactivateBusy(true)
    const deactivated: string[] = []  // labels of residents already committed
    try {
      // 1. Target first.
      const targetResult = await runOneDeactivate(targetDeactivate.id, reason, note)
      if (!targetResult.ok) {
        alert(`Deactivation failed for ${targetDeactivate.name || targetDeactivate.email}. ${targetResult.error ?? ''} Nothing was changed.`)
        return
      }
      deactivated.push(targetResult.residentLabel ?? (targetDeactivate.name || targetDeactivate.email))
      // 2. Each opted-in co-resident — stop on first failure so the
      //    manager knows the exact partial state to reconcile.
      const remainingEmails = [...alsoEmails]
      while (remainingEmails.length > 0) {
        const email = remainingEmails.shift()!
        const { data: co } = await supabase.from('residents')
          .select('id, name, email').eq('email', email).eq('is_active', true).maybeSingle()
        if (!co?.id) {
          // Silently skip a co-resident that flipped inactive between
          // modal open and batch — nothing to deactivate.
          continue
        }
        const coResult = await runOneDeactivate(co.id, reason, note)
        if (!coResult.ok) {
          const alreadyDone = deactivated.join(', ')
          const notAttempted = remainingEmails.length
          alert(
            `Deactivation stopped mid-batch.\n\n` +
            `Committed: ${alreadyDone}.\n` +
            `Failed on ${co.name || co.email}: ${coResult.error ?? 'database rejected the deactivation'}.\n` +
            (notAttempted > 0 ? `${notAttempted} other${notAttempted === 1 ? '' : 's'} not attempted.` : '')
          )
          return
        }
        deactivated.push(coResult.residentLabel ?? (co.name || co.email))
      }
    } finally {
      setTargetDeactivate(null)
      setDeactivateBusy(false)
      await refreshCrmData()
    }
  }

  async function reactivateResident(id: string) {
    // B206 — accidental-deactivation undo path. Manager-portal only; same
    // RLS as deactivateResident (residents_manager_update +
    // manager_update_vehicles, both symmetric on is_active value).
    //
    // Cascade choice: option (iii) owner-trim-symmetric. Restores ONLY
    // vehicles where (resident_email, unit, property) matches this
    // resident — mirrors B166's trim shape, opposite direction. Does NOT
    // touch B150-cascade-swept un-owned vehicles (a roommate's
    // independently-deactivated car must not silently come back).
    //
    // Surface the gap: count un-owned cascade-swept vehicles on this
    // (unit, property) so the confirm + the audit row both expose the
    // side-effect honestly. The manager can review the Vehicles tab to
    // restore a unit-cascade casualty if needed.
    const { data: r } = await supabase.from('residents').select('email, unit, property').eq('id', id).maybeSingle()
    if (!r?.email || !r?.unit || !r?.property) {
      alert('Could not load resident details. Refresh and try again.')
      return
    }
    const email = r.email.trim().toLowerCase()
    const unit = r.unit.trim()
    const property = r.property.trim()
    if (!email || !unit || !property) {
      alert('Resident has incomplete data. Cannot reactivate safely.')
      return
    }

    // Pre-confirm counts. Cheap; informational only. Real numbers for the
    // audit row come from the post-UPDATE result (handles TOCTOU drift if
    // a vehicle gets touched between SELECT and UPDATE).
    const escUnit = escapeIlikeValue(unit)
    const escProperty = escapeIlikeValue(property)
    const { count: ownerStampedCount } = await supabase
      .from('vehicles')
      .select('id', { count: 'exact', head: true })
      .eq('resident_email', email)
      .ilike('unit', escUnit)
      .ilike('property', escProperty)
      .eq('is_active', false)
    const { count: totalInactiveOnUnit } = await supabase
      .from('vehicles')
      .select('id', { count: 'exact', head: true })
      .ilike('unit', escUnit)
      .ilike('property', escProperty)
      .eq('is_active', false)
    const willRestore = ownerStampedCount ?? 0
    const wontRestore = Math.max(0, (totalInactiveOnUnit ?? 0) - willRestore)

    // 🔴 Copy honesty (Mateo Aug 6): the old wording attributed
    // wontRestore vehicles to "a unit-vacancy cascade" without
    // checking the audit log. What the code actually knows is that
    // those rows are currently inactive on this unit — the CAUSE
    // (cascade / owner-trim / manual removal / a mix) is unknowable
    // from a simple count. Say what's known, not what's presumed.
    // Same discipline as not returning zeros for out-of-scope.
    const confirmMsg = wontRestore > 0
      ? `Reactivate this resident? Their own previously-deactivated vehicle${willRestore === 1 ? '' : 's'} (${willRestore}) will be reactivated. ${wontRestore} other vehicle${wontRestore === 1 ? '' : 's'} on this unit ${wontRestore === 1 ? 'is' : 'are'} currently inactive and will NOT be restored — review the Vehicles tab if needed.`
      : `Reactivate this resident? Their own previously-deactivated vehicle${willRestore === 1 ? '' : 's'} (${willRestore}) will be reactivated.`
    if (!confirm(confirmMsg)) return

    // 1. Flip residents.is_active=true (single row by id — same shape as deactivate).
    await supabase.from('residents').update({ is_active: true }).eq('id', id)

    // 2. Owner-trim-symmetric vehicle restore. Mirrors B166's
    // trimDepartedResidentVehicles predicate exactly, opposite direction.
    // Wildcard-escape discipline matches the deactivate path. Does NOT
    // touch un-owned vehicles (B150 cascade casualties stay deactivated).
    let restoredVehicles: { id: number; plate: string }[] = []
    if (willRestore > 0) {
      const { data: restored, error: vErr } = await supabase
        .from('vehicles')
        .update({ is_active: true })
        .eq('resident_email', email)
        .ilike('unit', escUnit)
        .ilike('property', escProperty)
        .eq('is_active', false)
        .select('id, plate')
      if (vErr) {
        console.error('[B206-reactivate-vehicles-restore-failed]', { id, email, unit, property, error: vErr.message })
      } else {
        restoredVehicles = (restored as { id: number; plate: string }[]) || []
      }
    }

    // 3. Audit with BOTH halves of the picture so forensic trace shows
    // what came back AND what didn't. SCREAMING_SNAKE matches the
    // adjacent DEACTIVATE_RESIDENT precedent in this same file (manager-
    // portal convention; do NOT drift to CA's snake_case here — B60).
    //
    // Action label: REACTIVATE_RESIDENT (not ACTIVATE_RESIDENT) keeps
    // this specifically about UNDOING a prior deactivation — stays
    // distinct from the first-time approval path (APPROVE_RESIDENT)
    // when querying audit_logs later.
    //
    // Note on vehicles_not_restored: this count may include NULL-owner
    // vehicles (rows where vehicles.resident_email is NULL — possible
    // from forward-only stamp history or B166 pre-migration duplicates).
    // No owner-scoped restore can recover those; they need manual
    // Vehicles-tab review regardless. Near-zero for A1 (post-wipe data
    // is freshly stamped). Documentation only — not a fix.
    await logAudit({
      action: 'REACTIVATE_RESIDENT',
      table_name: 'residents',
      record_id: id,
      new_values: {
        is_active: true,
        property: manager.name,
        vehicles_restored: restoredVehicles.length,
        vehicles_not_restored: wontRestore,
        restored_plates: restoredVehicles.map(v => v.plate),
      },
    })
    await refreshCrmData()
  }

  // 🟢 2026-08-28 A1-cluster Item 3 Commit 3 — un-decline surface handler.
  //
  // Return-to-pending affordance for accidentally-declined residents.
  // Wired to the CRM affordance in Commit 4; this commit lands the
  // handler so the wiring in Commit 4 has a target.
  //
  // 🔴 UN-DECLINE IS NOT REACTIVATE — DO NOT MERGE THE TWO PATHS.
  //   REACTIVATE_RESIDENT (:3094 above) is the undo-deactivation
  //   path — resident was previously approved, all restore semantics
  //   assume that history. Writes is_active=true, restores plates
  //   owner-scoped.
  //   UNDECLINE_RESIDENT (this handler) is the undo-decline path —
  //   resident was NEVER approved; they were rejected. Writes
  //   is_active=false, status='pending', moves their pending queue
  //   position back. Vehicles restore to PENDING (not approved),
  //   awaiting a manager decision alongside their owner.
  // Cross-wiring these two would silently grant portal + protection
  // to a rejected resident. Full rationale in
  // undeclineResidentWrite's header at manager-crm-writes.ts.
  async function undeclineResident(r: { id: string; name?: string | null; email?: string | null }) {
    if (!manager?.name) return
    const property = manager.name
    const label = r.name || r.email || '(this resident)'
    const confirmMsg = `Return ${label} to the pending queue?\n\n`
      + `They will show as awaiting approval again, and their previously-`
      + `declined vehicles at this property will move to pending alongside `
      + `them. You'll still need to decide Approve or Decline before they `
      + `get portal access.`
    if (!window.confirm(confirmMsg)) return

    const result = await undeclineResidentWrite(supabase, { resident: r, property })
    if (!result.ok) {
      alert('Un-decline failed: ' + ((result.error as { message?: string })?.message ?? String(result.error)))
      return
    }
    const plateSuffix = result.vehiclesRestored > 0
      ? ` ${result.vehiclesRestored} vehicle${result.vehiclesRestored === 1 ? '' : 's'} moved back to pending${result.restoredPlates.length > 0 ? ` (${result.restoredPlates.join(', ')})` : ''}.`
      : ' No declined vehicles to restore for this resident.'
    alert(`Resident returned to the pending queue.${plateSuffix}`)
    await refreshCrmData()
  }

  // trimDepartedResidentVehicles moved to app/lib/manager-crm-writes.ts
  // (Phase B1) — same B166 owner-trim shape. Call sites in this file now
  // prepend `supabase` and pass positional args (email, unit, property,
  // sourceAction) verbatim.

  // B150 — vehicle-lifecycle cascade. Fires when the LAST active resident
  // at a (unit, property) tuple leaves. Roommate-safe: gate-check counts
  // active residents remaining at the tuple; cascade only runs when 0.
  // No schema change — flips vehicles.is_active=false, which the resident-
  // portal fetchVehicles filter (now explicit .eq('is_active', true))
  // honors, hiding archived vehicles from the next resident at the unit.
  //
  // 🔴 PER-VEHICLE OWNERSHIP GUARD (added 2026-08-05 after resident 690):
  // Before archiving, gather each candidate vehicle's resident_email and
  // check whether that email still owns an ACTIVE residency at the same
  // property (regardless of unit spelling). Skip the vehicles whose owner
  // is still active elsewhere at that property. Same reasoning as the
  // trim guard — keyed on (email, property), never on unit, because unit
  // is unreliable text (`136` / `Apt 136` / `#67`).
  //
  // 🔴 NULL email = UNKNOWN ownership = SKIP and log. Do NOT treat NULL
  // as "orphan and archive." Orphan plates exist (manager-entered per
  // b167, plates whose resident row was hard-deleted). Ownership is
  // unknowable, not absent. Archiving is destructive and its failure
  // mode is a towed car, so unknown ownership must fail toward LEAVING
  // THE PLATE AUTHORIZED. Do NOT "complete" this by adding a
  // NULL-is-orphan branch — that repeats the class of bug this guard
  // was written to prevent.
  async function cascadeVehiclesIfUnitVacant(unit: string | null | undefined, property: string | null | undefined, sourceAction: string) {
    if (!unit || !property) return
    const escUnit = escapeIlikeValue(unit)
    const escProperty = escapeIlikeValue(property)
    const { count: othersStillActive } = await supabase
      .from('residents')
      .select('id', { count: 'exact', head: true })
      .ilike('unit', escUnit)
      .ilike('property', escProperty)
      .eq('is_active', true)
    if (othersStillActive !== 0) return  // roommate still occupies unit

    // Gather candidates BEFORE the destructive UPDATE so we can gate
    // per-vehicle by ownership.
    const { data: candidates, error: candidatesErr } = await supabase
      .from('vehicles')
      .select('id, plate, resident_email')
      .ilike('unit', escUnit)
      .ilike('property', escProperty)
      .eq('is_active', true)
    if (candidatesErr) {
      console.error('[cascade-vehicles-fetch-failed]', { sourceAction, unit, property, error: candidatesErr.message })
      return
    }
    if (!candidates || candidates.length === 0) return

    // Bucket by ownership.
    //   NULL email → unknown ownership → skip (safe fail toward
    //     leaving the plate authorized).
    //   Non-NULL AND still-active-at-property → duplicate-identity case,
    //     skip (owner still needs their car under the other residency).
    //   Non-NULL AND NOT still-active-at-property → archive-eligible.
    // The third bucket is NOT called "orphan" — that name would invite
    // treating NULL as orphan, which is the exact class of bug this
    // guard was written to prevent.
    const unknownOwnership: typeof candidates = []
    const stillOwned:       typeof candidates = []
    const archiveEligible:  typeof candidates = []

    // Distinct non-null emails to check
    const emails = Array.from(new Set(
      candidates
        .filter(v => v.resident_email && v.resident_email.trim().length > 0)
        .map(v => (v.resident_email as string).trim().toLowerCase())
    ))
    // Ownership map — { lowered_email → true if still-active-at-property }
    const stillActiveByEmail = new Map<string, boolean>()
    if (emails.length > 0) {
      const { data: activeRows, error: ownersErr } = await supabase
        .from('residents')
        .select('email')
        .in('email', emails)
        .ilike('property', escProperty)
        .eq('is_active', true)
      if (ownersErr) {
        console.error('[cascade-vehicles-owners-fetch-failed]', { sourceAction, unit, property, error: ownersErr.message })
        return  // Fail safe — don't archive if we can't verify ownership
      }
      for (const row of activeRows ?? []) {
        const em = (row.email as string ?? '').trim().toLowerCase()
        if (em) stillActiveByEmail.set(em, true)
      }
    }
    for (const v of candidates) {
      const em = (v.resident_email ?? '').trim().toLowerCase()
      if (!em) {
        unknownOwnership.push(v)
      } else if (stillActiveByEmail.get(em)) {
        stillOwned.push(v)
      } else {
        archiveEligible.push(v)
      }
    }

    if (unknownOwnership.length > 0) {
      console.warn('[cascade-vehicles-skipped-unknown-owner]', {
        sourceAction, unit, property,
        skipped_plates: unknownOwnership.map(v => v.plate),
        reason: 'resident_email IS NULL — ownership unknowable, not absent. Not archived. Manager can retire manually via Vehicles tab if truly orphaned.',
      })
      await logAudit({
        action: 'CASCADE_DEACTIVATE_VEHICLES_SKIPPED',
        table_name: 'vehicles',
        new_values: {
          source: sourceAction,
          reason: 'unknown_ownership_null_email',
          unit, property,
          skipped_count: unknownOwnership.length,
          plates: unknownOwnership.map(v => v.plate),
        },
      })
    }
    if (stillOwned.length > 0) {
      console.warn('[cascade-vehicles-skipped-duplicate-identity]', {
        sourceAction, unit, property,
        skipped_plates: stillOwned.map(v => v.plate),
        reason: 'Vehicle owner still has an active residency at this property (possibly under a different unit spelling). Not archived.',
      })
      await logAudit({
        action: 'CASCADE_DEACTIVATE_VEHICLES_SKIPPED',
        table_name: 'vehicles',
        new_values: {
          source: sourceAction,
          reason: 'owner_still_active_at_property',
          unit, property,
          skipped_count: stillOwned.length,
          plates: stillOwned.map(v => v.plate),
        },
      })
    }
    if (archiveEligible.length === 0) return

    const { data: archived } = await supabase
      .from('vehicles')
      .update({ is_active: false })
      .in('id', archiveEligible.map(v => v.id))
      .eq('is_active', true)
      .select('id, plate')
    if (archived && archived.length > 0) {
      await logAudit({
        action: 'CASCADE_DEACTIVATE_VEHICLES',
        table_name: 'vehicles',
        new_values: { reason: 'B150_lifecycle_cascade', source: sourceAction, unit, property, vehicle_count: archived.length, plates: archived.map(v => v.plate) },
      })
    }
  }

  async function fetchActivityLogs() {
    if (!manager) return
    setAuditLoaded(false)
    const { data } = await supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    const propName = manager.name.toLowerCase()
    const filtered = (data || []).filter(log =>
      JSON.stringify(log.new_values || {}).toLowerCase().includes(propName) ||
      JSON.stringify(log.old_values || {}).toLowerCase().includes(propName) ||
      (log.notes || '').toLowerCase().includes(propName)
    )
    setAuditLogs(filtered)
    setAuditLoaded(true)
  }

  function filteredVehicles() {
    let list = vehicles
    if (showActiveVehicles) list = list.filter(v => v.is_active)
    if (!vehicleSearch) return list
    const q = vehicleSearch.toLowerCase()
    const qPlate = normalizePlate(vehicleSearch)
    return list.filter(v =>
      (qPlate && normalizePlate(v.plate).includes(qPlate)) ||
      v.unit?.toLowerCase().includes(q) ||
      v.make?.toLowerCase().includes(q) ||
      v.model?.toLowerCase().includes(q) ||
      v.color?.toLowerCase().includes(q)
    )
  }

  function filteredResidents() {
    let list = residents
    if (showActiveResidents) list = list.filter(r => r.is_active)
    if (!residentSearch) return list
    const q = residentSearch.toLowerCase()
    return list.filter(r =>
      r.name?.toLowerCase().includes(q) ||
      r.email?.toLowerCase().includes(q) ||
      r.unit?.toLowerCase().includes(q) ||
      r.phone?.toLowerCase().includes(q)
    )
  }

  function filteredViolations() {
    const today = new Date(); today.setHours(0,0,0,0)
    const week = new Date(); week.setDate(week.getDate()-7)
    const sixmo = new Date(); sixmo.setMonth(sixmo.getMonth()-6)
    return violations.filter(v => {
      const d = new Date(v.created_at)
      const inPeriod = violationFilter === 'today' ? d >= today : violationFilter === 'week' ? d >= week : d >= sixmo
      if (!inPeriod) return false
      if (!violationSearch) return true
      const q = violationSearch.toLowerCase()
      const qPlate = normalizePlate(violationSearch)
      return (qPlate && normalizePlate(v.plate).includes(qPlate)) || displayTowReason(v.violation_type).toLowerCase().includes(q) || v.location?.toLowerCase().includes(q)
    })
  }

  async function fetchInsights() {
    if (!manager) return
    setInsightsLoaded(false)
    const now = new Date()
    const sixMoAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1)
    const mk = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`

    // B210 (2026-06-24): dispute_requests count query removed from
    // the insights Promise.all; the disputeRate metric is gone (dispute
    // flow retired). drData no longer destructured.
    const [{ data: vData }, { data: vehData }] = await Promise.all([
      // B175 — analytics counter excludes voided violations.
      supabase.from('violations').select('created_at,tow_ticket_generated').eq('is_confirmed', true).is('voided_at', null).ilike('property', manager.name).gte('created_at', sixMoAgo.toISOString()),
      supabase.from('vehicles').select('status,is_active').ilike('property', manager.name),
    ])
    const viols = vData || []

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const byDay = Array(7).fill(0)
    const byHour = Array(24).fill(0)
    viols.forEach((v: any) => { const d = new Date(v.created_at); byDay[d.getDay()]++; byHour[d.getHours()]++ })

    const monthLabels: { label: string; key: string }[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      // TODO: custom format — chart month-short label; needs formatDate variant with month:short only
      monthLabels.push({ label: d.toLocaleString('en-US', { month: 'short' }), key: mk(d) })
    }
    const byMonth: Record<string, number> = {}
    viols.forEach((v: any) => { const k = mk(new Date(v.created_at)); byMonth[k] = (byMonth[k] || 0) + 1 })

    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const thisMonthCount = viols.filter((v: any) => new Date(v.created_at) >= thisMonthStart).length
    const lastMonthCount = viols.filter((v: any) => { const d = new Date(v.created_at); return d >= lastMonthStart && d < thisMonthStart }).length

    const vehs = vehData || []
    const complianceRate = vehs.length > 0 ? Math.round((vehs.filter((v: any) => v.is_active).length / vehs.length) * 100) : 100
    // B210 (2026-06-24): disputeRate metric removed (dispute flow retired)

    const peakDayIdx = byDay.indexOf(Math.max(...byDay))
    const peakHourIdx = byHour.indexOf(Math.max(...byHour))
    const fmtH = (h: number) => h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`
    const insight = viols.length > 0 && byDay[peakDayIdx] > 0
      ? `Peak enforcement: ${dayNames[peakDayIdx]}s around ${fmtH(peakHourIdx)}. Schedule driver patrols during these hours.`
      : 'Not enough data yet to identify peak enforcement times.'

    setMgAnalytics({
      dayChartData: dayNames.map((name, i) => ({ name, count: byDay[i] })),
      monthData: monthLabels.map(m => ({ month: m.label, count: byMonth[m.key] || 0 })),
      byHour, thisMonthCount, lastMonthCount, complianceRate, insight,
    })
    setInsightsLoaded(true)
  }

  const tabStyle = (tab: string) => ({
    padding:'8px 10px', border:'none', borderRadius:'6px',
    cursor:'pointer', fontWeight:'bold' as const, fontSize:'11px',
    background: activeTab === tab ? '#C9A227' : '#1e2535',
    color: activeTab === tab ? '#0f1117' : '#888',
    fontFamily:'Arial, sans-serif', whiteSpace:'nowrap' as const
  })

  const inputStyle: React.CSSProperties = {
    display:'block', width:'100%', marginTop:'6px', marginBottom:'10px',
    padding:'9px 10px', background:'#1e2535', border:'1px solid #3a4055',
    borderRadius:'6px', color:'white', fontSize:'12px', boxSizing:'border-box'
  }

  if (loading) return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif' }}>
      <p style={{ color:'#888' }}>Loading...</p>
    </main>
  )

  if (error) return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ textAlign:'center' }}>
        <p style={{ color:'#f44336', fontSize:'14px', marginBottom:'16px' }}>{error}</p>
        <a href="/login" style={{ color:'#C9A227', fontSize:'13px' }}>← Back to Login</a>
      </div>
    </main>
  )

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      {/* Desktop responsive Wave 2 (2026-06-26): swap inline
          maxWidth:600px+margin:auto for .portal-container utility class.
          Mobile (<1024px) byte-identical at 540px (the base value in
          globals.css; matches CA); lg+ widens to 1280px so managers
          working at a desk see the full queue grid without dead margin.
          New Approvals queue + space-request controls inherit the
          width — eyeball after first desktop view, follow up with
          per-section .reading-container caps if any controls look
          stretched. */}
      <div className="portal-container">

        {/* B66.5 commit 4.3: past_due banner */}
        {pastDueBanner && <PastDueBanner {...pastDueBanner} />}

        <div style={{ marginBottom:'16px', textAlign:'center' }}>
          <h1 style={{ color:'#C9A227', fontSize:'22px', fontWeight:'bold', margin:'0' }}>{managerCompany || 'ShieldMyLot'}</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'4px 0 0' }}>Property Manager Portal · <a href="/manager/mobile" style={{ color:'#C9A227' }}>📱 Mobile approvals</a></p>
        </div>

        {allProperties.length > 1 && (
          <div style={{ marginBottom:'12px' }}>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Viewing Property</label>
            <select onChange={e => switchProperty(e.target.value)} style={{ ...inputStyle, marginTop:'6px', fontSize:'13px' }}>
              {allProperties.map((p,i) => <option key={i} value={p.name}>{p.name}</option>)}
            </select>
          </div>
        )}

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px 16px', marginBottom:'14px' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'15px', margin:'0' }}>{manager?.name}</p>
              <p style={{ color:'#aaa', fontSize:'12px', margin:'4px 0 0' }}>{manager?.address || ''} · {manager?.pm_name || ''}</p>
              {/* B51a: view-only authorization display. Manager can see whether
                  the property has an authorization PDF on file + the expiration
                  date, but cannot edit (per RLS + UI scope decision). View PDF
                  button hits the server-signed-URL endpoint; RLS on the bucket
                  re-checks manager has SELECT rights before signing. */}
              {manager?.authorization_pdf_path ? (
                <p style={{ color:'#555', fontSize:'11px', margin:'6px 0 0' }}>
                  📄 Authorization on file · <button
                    onClick={async () => {
                      const res = await fetch(`/api/properties/${manager.id}/authorization-pdf-url`)
                      if (!res.ok) {
                        const j = await res.json().catch(() => ({}))
                        alert('Could not load PDF: ' + (j.error || res.statusText))
                        return
                      }
                      const { url } = await res.json()
                      window.open(url, '_blank')
                    }}
                    style={{ background:'none', border:'none', color:'#C9A227', fontSize:'11px', textDecoration:'underline', cursor:'pointer', padding:0, fontFamily:'inherit' }}>
                    View PDF
                  </button>
                  {manager?.authorization_expiration_date && ` · Expires ${manager.authorization_expiration_date}`}
                </p>
              ) : manager?.authorization_expiration_date ? (
                <p style={{ color:'#555', fontSize:'11px', margin:'6px 0 0', fontStyle:'italic' }}>📄 No PDF on file · Expires {manager.authorization_expiration_date}</p>
              ) : (
                <p style={{ color:'#555', fontSize:'11px', margin:'6px 0 0', fontStyle:'italic' }}>📄 No authorization document on file</p>
              )}
            </div>
            <button onClick={async () => { await supabase.auth.signOut(); window.location.href = '/login' }}
              style={{ padding:'6px 12px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
              Sign Out
            </button>
          </div>
        </div>

        {isReadOnly && (
          <div style={{ background:'#1a1a2a', border:'1px solid #3a4055', borderRadius:'8px', padding:'10px 14px', marginBottom:'14px', display:'flex', alignItems:'center', gap:'8px' }}>
            <span style={{ color:'#C9A227', fontSize:'13px' }}>⚠</span>
            <p style={{ color:'#aaa', fontSize:'12px', margin:'0' }}>Read-Only Access — Contact your Property Manager to make changes.</p>
          </div>
        )}

        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'8px', marginBottom:'14px' }}>
          {[
            { label:'Vehicles', value: stats.total_vehicles, color:'#C9A227' },
            { label:'Today', value: stats.violations_today, color:'#f44336' },
            { label:'This Week', value: stats.violations_week, color:'#ff9800' },
            { label:'Visitors', value: stats.active_passes, color:'#4caf50' },
          ].map((s,i) => (
            <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', textAlign:'center' }}>
              <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0' }}>{s.label}</p>
              <p style={{ color:s.color, fontSize:'24px', fontWeight:'bold', margin:'4px 0 0', fontFamily:'Courier New' }}>{s.value}</p>
            </div>
          ))}
        </div>

        <div style={{ display:'flex', flexWrap:'wrap', gap:'6px', background:'#1e2535', borderRadius:'8px', padding:'6px', marginBottom:'16px' }}>
          <button style={tabStyle('overview')} onClick={() => setActiveTab('overview')}>Overview</button>
          {/* CRM slice 2 — Approvals/Vehicles tab retired; approvals live on
              the Residents CRM. Kept behind !PM_CRM_ENABLED so the legacy
              route + render still work when the flag is flipped for rollback.
              The 'vehicles' route key + state + all approve/decline
              functions stay wired in the file so PM_CRM_ENABLED=false
              produces the original behaviour byte-for-byte. */}
          {!PM_CRM_ENABLED && (
            <button style={tabStyle('vehicles')} onClick={() => setActiveTab('vehicles')}>
              Approvals{(pendingVehicles.length + pendingSpaceRequests.length) > 0 && <span style={{ background:'#B71C1C', color:'white', borderRadius:'10px', fontSize:'9px', padding:'1px 6px', marginLeft:'4px', fontWeight:'bold' }}>{pendingVehicles.length + pendingSpaceRequests.length}</span>}
            </button>
          )}
          <button style={tabStyle('spaces')} onClick={() => setActiveTab('spaces')}>Spaces</button>
          <button style={tabStyle('residents')} onClick={() => setActiveTab('residents')}>
            Residents{pendingResidents.length > 0 && <span style={{ background:'#a16207', color:'white', borderRadius:'10px', fontSize:'9px', padding:'1px 6px', marginLeft:'4px', fontWeight:'bold' }}>{pendingResidents.length}</span>}
          </button>
          <button style={tabStyle('violations')} onClick={() => setActiveTab('violations')}>Violations</button>
          <button style={tabStyle('visitors')} onClick={() => setActiveTab('visitors')}>Visitors</button>
          {/* B214 — manager-vetted multi-week guest authorizations. Sits next
              to Visitors because both surface "who is allowed on the property
              right now beyond the registered residents" — but different
              record type: visitor passes are anon/24h, guest auths are
              manager-vetted/multi-week. */}
          <button style={tabStyle('guest-auth')} onClick={() => setActiveTab('guest-auth')}>Authorized Guests</button>
          {/* AP-UI-REFINE (2026-07-24): Authorized Plates tab. Adjacent to
              Authorized Guests — same category (who is allowed on the
              property beyond registered residents), different record type
              (guest auths are manager-vetted multi-week; authorized plates
              are standing staff/vendor/other). Badge shows count from
              apCount (init-fetched on manager.id change, kept fresh by
              component's onCountChange). */}
          <button style={tabStyle('authorized-plates')} onClick={() => setActiveTab('authorized-plates')}>
            Authorized Plates{apCount > 0 && <span style={{ background:'#4caf50', color:'#0f1117', borderRadius:'10px', fontSize:'9px', padding:'1px 6px', marginLeft:'4px', fontWeight:'bold' }}>{apCount}</span>}
          </button>
          {/* B75 (was B70 PM_PLATE_LOOKUP): Plate Lookup tab — visible on
              every tier across both tracks (manual lookup is a baseline
              utility). Admin always sees it (parity with other tier-gated
              surfaces in the codebase). */}
          {(isAdmin || hasFeature(FEATURE_FLAGS.MANAGER_PLATE_LOOKUP, getCompanyContext()) === true) && (
            <button style={tabStyle('plate-lookup')} onClick={() => setActiveTab('plate-lookup')}>Plate Lookup</button>
          )}
          <button style={tabStyle('settings')} onClick={() => setActiveTab('settings')}>Settings</button>
          {/* B210 (2026-06-24): Disputes tab button removed */}
          <button style={tabStyle('insights')} onClick={() => setActiveTab('insights')}>
            Insights
            {propertyWarnings.length > 0 && (
              // 2026-08-08 — Warnings count. Separate from pendCount
              // (pending approvals are queued work; warnings are
              // exceptions — one number can't mean both, per Mateo).
              <span style={{
                display: 'inline-block',
                marginLeft: '6px',
                padding: '1px 6px',
                background: propertyWarnings.some(w => w.severity === 'red') ? '#b71c1c' : '#a16207',
                color: 'white',
                borderRadius: '10px',
                fontSize: '10px',
                fontWeight: 'bold',
                fontFamily: 'Arial',
              }}>
                {propertyWarnings.length}
              </span>
            )}
          </button>
          <button style={tabStyle('activity')} onClick={() => setActiveTab('activity')}>Activity</button>
        </div>

        {/* OVERVIEW */}
        {activeTab === 'overview' && (
          <div>
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Recent Violations</p>
              {violations.slice(0,3).length === 0 ? <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No recent violations</p>
              : violations.slice(0,3).map((v,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid #1e2535' }}>
                  <span style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'13px', fontWeight:'bold' }}>{v.plate}</span>
                  <span style={{ color:'#aaa', fontSize:'12px' }}>{displayTowReason(v.violation_type)}</span>
                  <span style={{ color:'#555', fontSize:'11px' }}>{formatDate(v.created_at)}</span>
                </div>
              ))}
            </div>
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Active Visitor Passes</p>
              {passes.length === 0 ? <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No active visitor passes</p>
              : passes.map((p,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid #1e2535' }}>
                  <span style={{ color:'#f59e0b', fontFamily:'Courier New', fontSize:'13px', fontWeight:'bold' }}>{p.plate}</span>
                  <span style={{ color:'#aaa', fontSize:'12px' }}>{p.visiting_unit}</span>
                  <span style={{ color:'#4caf50', fontSize:'11px' }}>Expires {formatTime(p.expires_at)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* VEHICLES */}
        {activeTab === 'vehicles' && !PM_CRM_ENABLED && (
          <div>
            {pendingVehicles.length > 0 && (() => {
              const grouped = pendingVehicles.reduce((acc, v) => {
                const key = v.unit || 'Unknown Unit'
                if (!acc[key]) acc[key] = []
                acc[key].push(v)
                return acc
              }, {} as Record<string, any[]>)
              return (
                <div style={{ marginBottom:'16px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', margin:'0 0 12px', gap:'8px', flexWrap:'wrap' as const }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', textTransform:'uppercase', letterSpacing:'0.08em', margin:0 }}>
                      Pending Vehicle Requests ({pendingVehicles.length})
                    </p>
                    <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                      {/* B212 — Refresh + last-updated for this queue. */}
                      <span style={{ color:'#666', fontSize:'10px' }}>Updated {fmtAgo(vehiclesPendingRefreshedAt)}</span>
                      <button onClick={refreshVehiclesPending}
                        title="Refresh pending vehicles"
                        style={{ padding:'4px 10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                        ↻ Refresh
                      </button>
                      {/* Permit-Door Piece 1 §5 — property-wide Approve-All.
                          Visible to managers with can_approve_vehicles (universal).
                          Reuses the batch-sync pattern: N approvals → 1 sync. */}
                      {!isReadOnly && canApproveVehicles && pendingVehicles.length > 1 && (
                        <button onClick={approveAllPendingProperty}
                          style={{ padding:'6px 12px', background:'#1a3a1a', color:'#4caf50', border:'1px solid #2e7d32', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial' }}>
                          Approve All Pending ({pendingVehicles.length})
                        </button>
                      )}
                    </div>
                  </div>
                  {(Object.entries(grouped) as [string, any[]][]).map(([unit, unitVehicles]) => {
                    const resident = residents.find((r: any) => r.unit?.toLowerCase() === unit.toLowerCase())
                    return (
                      <div key={unit} style={{ marginBottom:'16px' }}>
                        <div style={{ background:'#1a1500', border:'1px solid #C9A227', borderRadius:'8px', padding:'8px 12px', marginBottom:'8px' }}>
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: !isReadOnly ? '8px' : '0' }}>
                            <div>
                              <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0' }}>
                                Unit {unit} — {unitVehicles.length} vehicle{unitVehicles.length !== 1 ? 's' : ''} pending
                              </p>
                              {resident && <p style={{ color:'#888', fontSize:'11px', margin:'2px 0 0' }}>{resident.name}</p>}
                            </div>
                            {!isReadOnly && (
                              <div style={{ display:'flex', gap:'6px' }}>
                                {/* Permit-Door Piece 1 §3 — Approve gated
                                    on can_approve_vehicles (universal:
                                    appears for any tier's manager with
                                    authority). Decline always visible. */}
                                {canApproveVehicles && (
                                  <button onClick={() => approveAllForUnit(unitVehicles, unit)}
                                    style={{ padding:'5px 10px', background:'#1a3a1a', color:'#4caf50', border:'1px solid #2e7d32', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial' }}>
                                    Approve All
                                  </button>
                                )}
                                <button onClick={() => declineAllForUnit(unitVehicles, unit)}
                                  style={{ padding:'5px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial' }}>
                                  Decline All
                                </button>
                              </div>
                            )}
                          </div>
                          {!isReadOnly && (
                            <input
                              value={unitNotes[unit] || ''}
                              onChange={e => setUnitNotes(n => ({...n, [unit]: e.target.value}))}
                              placeholder="Shared note for all vehicles in this unit (optional)"
                              style={{ ...inputStyle, marginTop:'0', marginBottom:'0' }}
                            />
                          )}
                        </div>
                        {unitVehicles.map((v: any) => (
                          <div key={v.id} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', marginBottom:'8px', marginLeft:'12px' }}>
                            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                              <div>
                                <p style={{ color:'white', fontFamily:'Courier New', fontSize:'16px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                                <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{[v.color, v.make, v.model, v.year].filter(Boolean).join(' ') || '—'}</p>
                              </div>
                              <span style={{ background:'#2a1e00', color:'#C9A227', border:'1px solid #C9A227', padding:'2px 7px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold' }}>Pending</span>
                            </div>
                            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px', fontSize:'11px', marginBottom:'10px' }}>
                              <div><span style={{ color:'#555' }}>Space</span><br/><span style={{ color:'#aaa' }}>{v.space || '—'}</span></div>
                              <div><span style={{ color:'#555' }}>State</span><br/><span style={{ color:'#aaa' }}>{v.state || '—'}</span></div>
                            </div>
                            <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Note for resident (optional)</label>
                            <input
                              value={pendingNotes[v.id] || ''}
                              onChange={e => setPendingNotes(n => ({...n, [v.id]: e.target.value}))}
                              placeholder="e.g. Welcome! or Plate already registered."
                              style={{ ...inputStyle, marginTop:'4px', marginBottom:'10px' }}
                            />
                            {!isReadOnly && (
                              <div style={{ display:'flex', gap:'8px' }}>
                                {/* Permit-Door Piece 1 §3 — Approve gated
                                    on can_approve_vehicles. Decline always
                                    visible (managers should still be able
                                    to decline regardless of billing authority). */}
                                {canApproveVehicles && (
                                  <button onClick={() => approveVehicle(v.id)}
                                    style={{ flex:1, padding:'8px', background:'#1a3a1a', color:'#4caf50', border:'1px solid #2e7d32', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                                    Approve
                                  </button>
                                )}
                                <button onClick={() => declineVehicle(v.id)}
                                  style={{ flex: canApproveVehicles ? 1 : undefined, padding:'8px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                                  Decline
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )
            })()}

            {/* Space Requests v1 — pending queue, parallels the Pending
                Vehicle Requests block above. Each row exposes inline
                approve/decline controls: approve REQUIRES picking a space
                from the dropdown (assignment IS the approval — atomic
                via approve_space_request RPC, no double-assign). Decline
                takes an optional reason (matches vehicle-decline pattern;
                does not gate the decline). availableSpacesForAssign pool
                is shared with the resident-approval flow (single load at
                manager init; refetched on every successful approve). */}
            {pendingSpaceRequests.length > 0 && (
              <div style={{ marginBottom:'16px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', margin:'0 0 12px', gap:'8px', flexWrap:'wrap' as const }}>
                  <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', textTransform:'uppercase', letterSpacing:'0.08em', margin:0 }}>
                    Pending Space Requests ({pendingSpaceRequests.length})
                  </p>
                  {/* B212 — Refresh + last-updated for this queue. */}
                  <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                    <span style={{ color:'#666', fontSize:'10px' }}>Updated {fmtAgo(spaceRequestsPendingRefreshedAt)}</span>
                    <button onClick={refreshSpaceRequestsPending}
                      title="Refresh pending space requests"
                      style={{ padding:'4px 10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                      ↻ Refresh
                    </button>
                  </div>
                </div>
                {spaceRequestError && (
                  <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}>
                    <p style={{ color:'#f44336', fontSize:'12px', margin:0 }}>{spaceRequestError}</p>
                  </div>
                )}
                {pendingSpaceRequests.map((req: any) => {
                  const resident = residents.find((r: any) => r.email && req.resident_email && r.email.toLowerCase() === req.resident_email.toLowerCase())
                  const isThisDeciding = decidingRequestId === req.id
                  return (
                    <div key={req.id} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', marginBottom:'10px' }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'10px', flexWrap:'wrap', gap:'6px' }}>
                        <div>
                          <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0' }}>
                            {resident?.name || req.resident_email}
                            {resident?.unit && <span style={{ color:'#888', fontWeight:'normal', fontSize:'12px' }}> · Unit {resident.unit}</span>}
                          </p>
                          <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>Requested {formatTimestamp(req.requested_at)}</p>
                        </div>
                        <span style={{ background:'#2a1e00', color:'#C9A227', border:'1px solid #C9A227', padding:'2px 7px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold' }}>Pending</span>
                      </div>
                      {req.note && (
                        <div style={{ background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}>
                          <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 3px' }}>Resident Note</p>
                          <p style={{ color:'#aaa', fontSize:'12px', margin:0 }}>{req.note}</p>
                        </div>
                      )}
                      {!isReadOnly && (
                        <div style={{ display:'grid', gridTemplateColumns:'1fr', gap:'8px' }}>
                          <div>
                            <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.05em', display:'block', marginBottom:'4px' }}>
                              Pick available space to assign
                            </label>
                            <select
                              value={approveSelections[req.id] || ''}
                              onChange={e => setApproveSelections(s => ({...s, [req.id]: e.target.value}))}
                              disabled={isThisDeciding || availableSpacesForAssign.length === 0}
                              style={{ ...inputStyle, marginTop:0, marginBottom:0 }}>
                              <option value="">
                                {availableSpacesForAssign.length === 0 ? '— no available spaces (create one first) —' : '— select a space —'}
                              </option>
                              {availableSpacesForAssign.map(s => (
                                <option key={s.id} value={String(s.id)}>{s.label}{s.type && s.type !== 'regular' ? ` (${s.type})` : ''}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.05em', display:'block', marginBottom:'4px' }}>
                              Decline reason <span style={{ color:'#555', textTransform:'none', letterSpacing:0 }}>(optional)</span>
                            </label>
                            <input
                              value={declineReasons[req.id] || ''}
                              onChange={e => setDeclineReasons(r => ({...r, [req.id]: e.target.value.slice(0, 500)}))}
                              disabled={isThisDeciding}
                              placeholder="e.g. no available spaces at this time"
                              style={{ ...inputStyle, marginTop:0, marginBottom:0 }}
                            />
                          </div>
                          <div style={{ display:'flex', gap:'6px' }}>
                            <button onClick={() => approveSpaceRequest(req.id)}
                              disabled={isThisDeciding || !approveSelections[req.id]}
                              style={{ flex:1, padding:'8px', background:isThisDeciding ? '#3a4055' : (approveSelections[req.id] ? '#1a3a1a' : '#1a1f2e'), color:approveSelections[req.id] ? '#4caf50' : '#555', border:`1px solid ${approveSelections[req.id] ? '#2e7d32' : '#333'}`, borderRadius:'6px', cursor:(isThisDeciding || !approveSelections[req.id]) ? 'not-allowed' : 'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                              {isThisDeciding ? '…' : 'Approve + Assign'}
                            </button>
                            <button onClick={() => declineSpaceRequest(req.id)}
                              disabled={isThisDeciding}
                              style={{ flex:1, padding:'8px', background:isThisDeciding ? '#3a4055' : '#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:isThisDeciding ? 'not-allowed' : 'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                              {isThisDeciding ? '…' : 'Decline'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            <div style={{ display:'flex', gap:'8px', marginBottom:'12px', alignItems:'center' }}>
              <input value={vehicleSearch} onChange={e => setVehicleSearch(e.target.value)} placeholder="Search plate, unit, make, model, color..." style={{ ...inputStyle, flex:1, marginTop:0, marginBottom:0 }} />
              <button onClick={() => setShowActiveVehicles(s => !s)} style={{ padding:'4px 10px', background: showActiveVehicles ? '#1a1f2e' : '#111', color: showActiveVehicles ? '#C9A227' : '#555', border:`1px solid ${showActiveVehicles ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial', whiteSpace:'nowrap' as const }}>{showActiveVehicles ? '● Active Only' : '○ Show All'}</button>
            </div>
            {!isReadOnly && (
              // Spaces fixes 2026-06-28 (Bug 3) — fire fetchResidentsAtUnit
              // on Modal A open, mirroring Modal B at L2895. Covers the
              // case where newVehicle.unit was typed in a prior open and
              // persisted (residentsAtUnit may be stale). The onFocus on
              // the Vehicle Owner select below covers the "type-without-
              // blurring" case for fresh sessions.
              <button onClick={async () => {
                const willOpen = !showAddVehicle
                setShowAddVehicle(willOpen)
                if (willOpen) await fetchResidentsAtUnit(newVehicle.unit)
              }}
                style={{ width:'100%', padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', marginBottom:'12px' }}>
                + Add Vehicle
              </button>
            )}
            {showAddVehicle && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Add New Vehicle</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Plate *</label><input value={newVehicle.plate} onChange={e => setNewVehicle({...newVehicle, plate: normalizePlate(e.target.value)})} placeholder="ABC1234" style={{ ...inputStyle, fontFamily:'Courier New', fontSize:'14px', fontWeight:'bold' }} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>State</label><select value={newVehicle.state} onChange={e => setNewVehicle({...newVehicle, state: e.target.value})} style={inputStyle}>{['TX','CA','FL','NY','GA','OH','IL','PA','NC','AZ'].map(s => <option key={s}>{s}</option>)}</select></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Make</label><input value={newVehicle.make} onChange={e => setNewVehicle({...newVehicle, make: e.target.value})} placeholder="Toyota" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Model</label><input value={newVehicle.model} onChange={e => setNewVehicle({...newVehicle, model: e.target.value})} placeholder="Camry" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Year</label><input value={newVehicle.year} onChange={e => setNewVehicle({...newVehicle, year: e.target.value})} placeholder="2022" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Color</label><input value={newVehicle.color} onChange={e => setNewVehicle({...newVehicle, color: e.target.value})} placeholder="Black" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Unit *</label><input value={newVehicle.unit} onChange={e => setNewVehicle({...newVehicle, unit: e.target.value})} onBlur={() => fetchResidentsAtUnit(newVehicle.unit)} placeholder="Apt 214" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Space</label><input value={newVehicle.space} onChange={e => setNewVehicle({...newVehicle, space: e.target.value})} placeholder="A-12" style={inputStyle} /></div>
                  <div style={{ gridColumn:'span 2' }}><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Permit Expiry</label><input type="date" value={newVehicle.permit_expiry} onChange={e => setNewVehicle({...newVehicle, permit_expiry: e.target.value})} style={inputStyle} /></div>
                  {/* B166 — owner picker. Auto-populates on Unit blur via fetchResidentsAtUnit. */}
                  <div style={{ gridColumn:'span 2' }}>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Vehicle Owner</label>
                    {/* Spaces fixes 2026-06-28 (Bug 3) — onFocus lazy-fetch
                        covers the "user typed unit then clicked directly
                        into Owner without blurring Unit" case. Cheap: the
                        fetch early-returns if unit is empty + already-loaded
                        state just gets re-set with the same data. */}
                    <select value={vehicleOwnerEmail} onChange={e => setVehicleOwnerEmail(e.target.value)}
                            onFocus={() => { if (newVehicle.unit && residentsAtUnit.length === 0) fetchResidentsAtUnit(newVehicle.unit) }}
                            style={inputStyle}>
                      <option value="">Unit-level / shared (no owner)</option>
                      {residentsAtUnit.map(r => (
                        <option key={r.email} value={r.email}>{r.name} ({r.email})</option>
                      ))}
                    </select>
                    {newVehicle.unit && residentsAtUnit.length === 0 && (
                      <p style={{ color:'#777', fontSize:'10px', margin:'4px 0 0' }}>No active residents at this unit; vehicle will be unit-level.</p>
                    )}
                    {residentsAtUnit.length >= 2 && !vehicleOwnerEmail && (
                      <p style={{ color:'#C9A227', fontSize:'10px', margin:'4px 0 0' }}>Multiple residents — pick the owner.</p>
                    )}
                  </div>
                </div>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={() => addVehicle()} disabled={addVehicleSubmitting} style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor: addVehicleSubmitting ? 'not-allowed' : 'pointer', opacity: addVehicleSubmitting ? 0.6 : 1 }}>{addVehicleSubmitting ? 'Adding…' : 'Add Vehicle'}</button>
                  <button onClick={() => setShowAddVehicle(false)} style={{ padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                </div>
              </div>
            )}
            {filteredVehicles().map((v,i) => (
              <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                  <div>
                    <p style={{ color:'white', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                    <p style={{ color:'#aaa', fontSize:'12px', margin:'3px 0 0' }}>{v.color} {v.make} {v.model} {v.year}</p>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <span style={{ background: v.is_active ? '#1a3a1a' : '#3a1a1a', color: v.is_active ? '#4caf50' : '#f44336', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold', display:'block', marginBottom:'6px' }}>{v.is_active ? 'Active' : 'Inactive'}</span>
                    {!isReadOnly && <button onClick={() => removeVehicle(v.id)} style={{ padding:'4px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Remove</button>}
                  </div>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'6px', fontSize:'11px' }}>
                  <div><span style={{ color:'#555' }}>Unit</span><br/><span style={{ color:'#aaa' }}>{v.unit}</span></div>
                  <div><span style={{ color:'#555' }}>Space</span><br/><span style={{ color:'#aaa' }}>{v.space || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Permit Expiry</span><br/><span style={{ color:'#aaa' }}>{formatDate(v.permit_expiry)}</span></div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* SPACES */}
        {/* SPACES v1 (commit 3) — dashboard-primary + filtered/paginated list.
            Architecture: NEVER renders all N spaces in one grid. Default
            fetch returns ≤ pageSize rows (25 mobile / 50 desktop). All
            mutations route through the 6 DEFINER RPCs via the modal
            handlers above. */}
        {activeTab === 'spaces' && (
          <div>
            {/* ① OCCUPANCY DASHBOARD — visually dominant, primary read.
                Cards are clickable: clicking "3 open" filters the list
                below to that type+status; clicking "47 assigned" filters
                to that type+status. Zero-click drill-down. */}
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
              <p style={{ color:'#888', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 10px' }}>Reserved spaces</p>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(100px, 1fr))', gap:'8px' }}>
                {SPACE_TYPES.map(t => {
                  const c = occupancy?.byType[t] ?? { total:0, assigned:0, available:0 }
                  return (
                    <div key={t} style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'10px' }}>
                      <p style={{ color:'#aaa', fontSize:'11px', margin:'0 0 4px', textTransform:'uppercase', letterSpacing:'0.05em' }}>{TYPE_LABELS[t]}</p>
                      <p style={{ color:'white', fontSize:'18px', fontWeight:'bold', margin:'0 0 2px' }}>{c.assigned}/{c.total}</p>
                      <p style={{ color:'#666', fontSize:'10px', margin:'0 0 6px' }}>assigned</p>
                      {c.total > 0 && (
                        <>
                          <button onClick={() => { setSpacesFilters({ ...spacesFilters, type:t, status:'assigned' }); setSpacesPage(0) }}
                            style={{ display:'block', width:'100%', padding:'4px 0', background:'transparent', color:'#3b82f6', border:'none', cursor:'pointer', fontSize:'10px', textAlign:'left' }}>
                            {c.assigned} assigned ↓
                          </button>
                          <button onClick={() => { setSpacesFilters({ ...spacesFilters, type:t, status:'available' }); setSpacesPage(0) }}
                            style={{ display:'block', width:'100%', padding:'4px 0', background:'transparent', color:c.available > 0 ? '#4caf50' : '#555', border:'none', cursor:'pointer', fontSize:'10px', textAlign:'left' }}>
                            {c.available} open ↓
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* ② VISITOR — one number, never rows (per locked design) */}
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'12px 14px', marginBottom:'14px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div>
                <p style={{ color:'#888', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 4px' }}>Visitor</p>
                <p style={{ color:'white', fontSize:'15px', margin:'0' }}>
                  <strong>{occupancy?.activeVisitorPasses ?? 0}</strong>
                  <span style={{ color:'#888' }}> / {occupancy?.visitorCapacity ?? '—'} in use</span>
                  {occupancy?.visitorCapacity != null && occupancy.visitorCapacity > 0 && (
                    <span style={{ color:'#666', fontSize:'11px', marginLeft:'8px' }}>({Math.round((occupancy.activeVisitorPasses / occupancy.visitorCapacity) * 100)}%)</span>
                  )}
                </p>
              </div>
              <button onClick={() => setActiveTab('visitors')}
                style={{ padding:'6px 12px', background:'transparent', color:'#3b82f6', border:'1px solid #3b82f6', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold' }}>
                Visitors tab →
              </button>
            </div>

            {/* ⚠ Migration banner — inert in v1 (commit 1 backfill produced 0
                flagged rows); kept as defensive scaffolding for future
                per-customer rollouts that import legacy assignments */}
            {flaggedMigrationCount > 0 && (
              <div style={{ background:'#3a2a08', border:'1px solid #f59e0b', borderRadius:'10px', padding:'10px 14px', marginBottom:'14px' }}>
                <p style={{ color:'#fbbf24', fontSize:'12px', margin:'0', fontWeight:'bold' }}>
                  ⚠ {flaggedMigrationCount} spaces need manual assignment — migration flagged multi-residency units that couldn&apos;t auto-assign.
                  {' '}<button onClick={() => { setSpacesFilters({ ...spacesFilters, type:null, status:null, search:'' }); setSpacesPage(0) }}
                    style={{ background:'transparent', color:'#fbbf24', border:'none', textDecoration:'underline', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Show only flagged →</button>
                </p>
              </div>
            )}

            {/* ③ FILTERED LIST — search + filters + dense table + pagination.
                Default filter (status=Available) cuts the typical 150 → ~9
                on tab open. LIMIT is structural (pageSize constant, NOT a
                user-toggleable input — Jose Check 2 lock 2026-06-21). */}
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px' }}>
              <div style={{ display:'flex', gap:'8px', marginBottom:'10px', alignItems:'center', flexWrap:'wrap' }}>
                <input
                  value={spacesFilters.search}
                  onChange={e => { setSpacesFilters({ ...spacesFilters, search: e.target.value }); setSpacesPage(0) }}
                  placeholder="🔍 Search label or resident name..."
                  style={{ ...inputStyle, marginBottom:0, flex:'1 1 200px' }} />
                {!isReadOnly && (
                  <button onClick={() => { setTargetAdd(true); setSpacesError('') }}
                    style={{ padding:'8px 14px', background:'#C9A227', color:'#0f1117', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', whiteSpace:'nowrap' }}>
                    + New space
                  </button>
                )}
              </div>
              <div style={{ display:'flex', gap:'8px', marginBottom:'12px', alignItems:'center', flexWrap:'wrap', fontSize:'12px' }}>
                <span style={{ color:'#666', fontSize:'10px', textTransform:'uppercase' }}>Type:</span>
                <select value={spacesFilters.type ?? ''}
                  onChange={e => { setSpacesFilters({ ...spacesFilters, type: (e.target.value || null) as SpaceType | null }); setSpacesPage(0) }}
                  style={{ ...inputStyle, marginBottom:0, padding:'5px 8px', width:'auto' }}>
                  <option value=''>All</option>
                  {SPACE_TYPES.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                </select>
                <span style={{ color:'#666', fontSize:'10px', textTransform:'uppercase', marginLeft:'8px' }}>Status:</span>
                <select value={spacesFilters.status ?? ''}
                  onChange={e => { setSpacesFilters({ ...spacesFilters, status: (e.target.value || null) as 'available'|'assigned'|null }); setSpacesPage(0) }}
                  style={{ ...inputStyle, marginBottom:0, padding:'5px 8px', width:'auto' }}>
                  <option value=''>All</option>
                  <option value='available'>Available</option>
                  <option value='assigned'>Assigned</option>
                </select>
                <label style={{ display:'flex', alignItems:'center', gap:'5px', marginLeft:'8px', cursor:'pointer' }}>
                  <input type='checkbox' checked={spacesFilters.showInactive}
                    onChange={e => { setSpacesFilters({ ...spacesFilters, showInactive: e.target.checked }); setSpacesPage(0) }} />
                  <span style={{ color:'#aaa', fontSize:'11px' }}>Show inactive</span>
                </label>
              </div>

              {/* Dense table — no tiles. Cards reflow on mobile via the CSS grid. */}
              {spacesListLoading ? (
                <p style={{ color:'#555', fontSize:'12px', textAlign:'center', padding:'24px' }}>Loading spaces…</p>
              ) : spacesList.length === 0 ? (
                <p style={{ color:'#555', fontSize:'12px', textAlign:'center', padding:'24px' }}>
                  No spaces match the current filter.
                  {spacesFilters.search && <span style={{ display:'block', marginTop:'4px', fontSize:'11px' }}>Try clearing the search or widening the type/status filters.</span>}
                </p>
              ) : (
                <>
                  <div style={{ overflowX:'auto' }}>
                    <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'12px' }}>
                      <thead>
                        <tr style={{ background:'#0f1117', color:'#666', textTransform:'uppercase', fontSize:'10px', letterSpacing:'0.05em' }}>
                          <th style={{ padding:'8px', textAlign:'left' }}>Label</th>
                          <th style={{ padding:'8px', textAlign:'left' }}>Type</th>
                          <th style={{ padding:'8px', textAlign:'left' }}>Status</th>
                          <th style={{ padding:'8px', textAlign:'left' }}>Assigned to</th>
                          <th style={{ padding:'8px', textAlign:'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {spacesList.map(s => (
                          <tr key={s.id} style={{ borderTop:'1px solid #2a2f3d', opacity: s.is_active ? 1 : 0.55 }}>
                            <td style={{ padding:'8px', fontFamily:'Courier New', color:'#C9A227', fontWeight:'bold' }}>{s.label}</td>
                            <td style={{ padding:'8px', color:'#aaa' }}>{TYPE_LABELS[s.type] ?? s.type}</td>
                            <td style={{ padding:'8px' }}>
                              <span style={{ fontSize:'10px', fontWeight:'bold', padding:'2px 7px', borderRadius:'8px',
                                background: s.status === 'assigned' ? '#0a1e3a' : s.status === 'available' ? '#0a3a1e' : '#1a1a1a',
                                color: s.status === 'assigned' ? '#3b82f6' : s.status === 'available' ? '#4caf50' : '#888',
                              }}>{s.status}</span>
                              {!s.is_active && <span style={{ marginLeft:'4px', fontSize:'10px', color:'#666' }}>(inactive)</span>}
                            </td>
                            <td style={{ padding:'8px', color:'#aaa' }}>
                              {residentDisplayList(s.residents)}
                              {/* 2026-08-19 designated-vehicle Commit 3 — chip after resident
                                  name when a designation is set. Reference data only; the
                                  in-modal display carries the "does not affect enforcement"
                                  caveat. Chip is intentionally lower-key than an alert color
                                  so a manager scanning the list reads it as info, not warning. */}
                              {s.designated_vehicle_plate && (
                                <span title="Designated vehicle (for your records — does not affect enforcement)" style={{
                                  marginLeft:'8px', fontSize:'10px', padding:'2px 6px',
                                  borderRadius:'8px', background:'#1a1400', color:'#C9A227',
                                  border:'1px solid #3a2a00', fontFamily:'Courier New', fontWeight:'bold',
                                }}>
                                  ★ {s.designated_vehicle_plate}
                                </span>
                              )}
                            </td>
                            <td style={{ padding:'8px', textAlign:'right' }}>
                              {!isReadOnly && (
                                <>
                                  {/* v1.1: Assign available whenever set < cap (not just when status='available').
                                      Server-side cap=2 enforced in assign_space; render-side hides at cap as advisory.
                                      Reassign button DROPPED — manager UX is 2 explicit clicks (per-resident Free + Assign). */}
                                  {s.residents.length < 2 && s.is_active && (
                                    <button onClick={() => { setTargetAssign(s); setAssignFormEmail(''); setSpacesError('') }}
                                      style={{ padding:'4px 8px', background:'#3b82f6', color:'white', border:'none', borderRadius:'5px', cursor:'pointer', fontSize:'10px', fontWeight:'bold', marginLeft:'4px' }}>
                                      {s.residents.length === 0 ? 'Assign' : '+ Add resident'}
                                    </button>
                                  )}
                                  {s.residents.length > 0 && s.is_active && (
                                    <button onClick={() => { setTargetFree(s); setFreeResidentEmail(null); setSpacesError('') }}
                                      style={{ padding:'4px 8px', background:'#1e2535', color:'#f59e0b', border:'1px solid #f59e0b', borderRadius:'5px', cursor:'pointer', fontSize:'10px', fontWeight:'bold', marginLeft:'4px' }}>
                                      Free
                                    </button>
                                  )}
                                  {/* v1.1 commit 6: View opens SpaceDetailModal — anchored on the
                                      space, shows tied residents + their vehicles + 3 actions in one
                                      place. Available on every row (incl. 0-resident + decommissioned)
                                      so managers can read space history regardless of state. */}
                                  <button onClick={() => setTargetSpaceDetail(s)}
                                    style={{ padding:'4px 8px', background:'#0a1e3a', color:'#3b82f6', border:'1px solid #3b82f6', borderRadius:'5px', cursor:'pointer', fontSize:'10px', fontWeight:'bold', marginLeft:'4px' }}>
                                    View
                                  </button>
                                  <button onClick={() => { setTargetEdit(s); setEditForm({ label:s.label, description:s.description ?? '', type:s.type, is_bundled:s.is_bundled }); setSpacesError('') }}
                                    style={{ padding:'4px 8px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'5px', cursor:'pointer', fontSize:'10px', fontWeight:'bold', marginLeft:'4px' }}>
                                    Edit
                                  </button>
                                  {s.status === 'available' && s.is_active && (
                                    <button onClick={() => { setTargetDecommission(s); setSpacesError('') }}
                                      style={{ padding:'4px 8px', background:'#1e2535', color:'#f44336', border:'1px solid #991b1b', borderRadius:'5px', cursor:'pointer', fontSize:'10px', fontWeight:'bold', marginLeft:'4px' }}>
                                      Decommission
                                    </button>
                                  )}
                                </>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {/* Pagination — adaptive page size (25 mobile / 50 desktop) */}
                  {spacesListTotal > spacesPageSize && (
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:'12px', fontSize:'11px' }}>
                      <span style={{ color:'#888' }}>
                        Page {spacesPage + 1} of {Math.max(1, Math.ceil(spacesListTotal / spacesPageSize))} · {spacesListTotal} total
                      </span>
                      <div style={{ display:'flex', gap:'6px' }}>
                        <button onClick={() => setSpacesPage(Math.max(0, spacesPage - 1))} disabled={spacesPage === 0}
                          style={{ padding:'5px 10px', background:'#1e2535', color: spacesPage === 0 ? '#444' : '#aaa', border:'1px solid #3a4055', borderRadius:'5px', cursor: spacesPage === 0 ? 'not-allowed' : 'pointer', fontSize:'11px' }}>
                          ← Prev
                        </button>
                        <button onClick={() => setSpacesPage(spacesPage + 1)} disabled={(spacesPage + 1) * spacesPageSize >= spacesListTotal}
                          style={{ padding:'5px 10px', background:'#1e2535', color: (spacesPage + 1) * spacesPageSize >= spacesListTotal ? '#444' : '#aaa', border:'1px solid #3a4055', borderRadius:'5px', cursor: (spacesPage + 1) * spacesPageSize >= spacesListTotal ? 'not-allowed' : 'pointer', fontSize:'11px' }}>
                          Next →
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* ──────────────────────────────────────────────────────────
                Modals — 6 mutation surfaces, each wired to one RPC
                (assign / reassign / free / generate / decommission /
                update_space_metadata). No direct table writes.
                ────────────────────────────────────────────────────────── */}

            {/* ADD modal — single ad-hoc, count=1, auto-named */}
            {targetAdd && (
              <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                <div className="modal-card" style={{ background:'#161b26', border:'1px solid #C9A227', borderRadius:'14px', padding:'22px', maxWidth:'400px', width:'100%' }}>
                  <p style={{ color:'#C9A227', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 12px', fontWeight:'bold' }}>Add new space</p>
                  <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase' }}>Type *</label>
                  <select value={addForm.type} onChange={e => setAddForm({ ...addForm, type: e.target.value as SpaceType })} style={inputStyle}>
                    {SPACE_TYPES.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                  </select>
                  {canApproveVehicles && (
                    <>
                      <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', marginTop:'8px', display:'block' }}>Quantity *</label>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        value={addForm.quantity}
                        onChange={e => {
                          const n = Number(e.target.value)
                          setAddForm({ ...addForm, quantity: Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : 1 })
                        }}
                        style={inputStyle}
                      />
                    </>
                  )}
                  <p style={{ color:'#666', fontSize:'11px', margin:'0 0 14px', lineHeight:'1.4' }}>
                    Labels auto-generate as the next sequential numbers for this type. You can rename via the Edit modal after.{canApproveVehicles ? ' Bulk add is capped at 100.' : ''}
                  </p>
                  {spacesError && <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}><p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{spacesError}</p></div>}
                  <div style={{ display:'flex', gap:'8px' }}>
                    <button onClick={() => { setTargetAdd(false); setSpacesError('') }}
                      style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Cancel</button>
                    <button onClick={submitAddSingleSpace}
                      style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Add space</button>
                  </div>
                </div>
              </div>
            )}

            {/* ASSIGN modal — v1.1 multi-resident: searchable picker + chips
                for existing ties (cap=2 advisory; server enforces).
                INVARIANT: assigning a resident only adds a tie; it does
                NOT touch the resident's vehicles or authorization. */}
            {targetAssign && (
              <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                <div className="modal-card" style={{ background:'#161b26', border:'1px solid #3b82f6', borderRadius:'14px', padding:'22px', maxWidth:'460px', width:'100%' }}>
                  <p style={{ color:'#3b82f6', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px', fontWeight:'bold' }}>{targetAssign.residents.length === 0 ? 'Assign space' : '+ Add resident to space'}</p>
                  <p style={{ color:'white', fontSize:'14px', margin:'0 0 12px' }}><strong style={{ fontFamily:'Courier New', color:'#C9A227' }}>{targetAssign.label}</strong> · {TYPE_LABELS[targetAssign.type] ?? targetAssign.type}</p>

                  {/* Existing-ties chips — show who's already on the space */}
                  {targetAssign.residents.length > 0 && (
                    <div style={{ marginBottom:'14px' }}>
                      <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.05em', margin:'0 0 6px' }}>Currently tied ({targetAssign.residents.length}/2)</p>
                      <div style={{ display:'flex', flexWrap:'wrap', gap:'6px' }}>
                        {targetAssign.residents.map(r => (
                          <span key={r.email} style={{ background:'#0a1e3a', color:'#3b82f6', padding:'4px 8px', borderRadius:'12px', fontSize:'11px', display:'inline-flex', alignItems:'center', gap:'5px' }}>
                            {r.name || r.email}{r.unit ? ` · ${r.unit}` : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {targetAssign.residents.length >= 2 ? (
                    <p style={{ color:'#fbbf24', fontSize:'12px', margin:'0 0 14px', padding:'10px', background:'#1a1400', border:'1px solid #a16207', borderRadius:'6px' }}>
                      This space is at the 2-resident cap. Remove one resident before adding another (via the row&apos;s Free button → per-resident).
                    </p>
                  ) : (
                    <>
                      <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase' }}>{targetAssign.residents.length === 0 ? 'Resident *' : 'Add another resident *'}</label>
                      <SearchableResidentPicker
                        property={targetAssign.property}
                        excludeEmails={targetAssign.residents.map(r => r.email)}
                        onSelect={(r: SearchableResidentPickerResult) => setAssignFormEmail(r.email)}
                        placeholder="Search name, unit, or plate…"
                        autoFocus
                      />
                      {assignFormEmail && (
                        <p style={{ color:'#4caf50', fontSize:'11px', margin:'8px 0 0' }}>
                          Selected: <strong>{assignFormEmail}</strong>
                        </p>
                      )}
                    </>
                  )}

                  {spacesError && <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 10px', marginTop:'10px', marginBottom:'10px' }}><p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{spacesError}</p></div>}
                  <div style={{ display:'flex', gap:'8px', marginTop:'14px' }}>
                    <button onClick={() => { setTargetAssign(null); setAssignFormEmail(''); setSpacesError('') }}
                      style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>{targetAssign.residents.length >= 2 ? 'Close' : 'Cancel'}</button>
                    {targetAssign.residents.length < 2 && (
                      <button onClick={submitAssignSpace} disabled={!assignFormEmail}
                        style={{ flex:1, padding:'10px', background: assignFormEmail ? '#3b82f6' : '#555', color:'white', border:'none', borderRadius:'6px', cursor: assignFormEmail ? 'pointer' : 'not-allowed', fontSize:'12px', fontWeight:'bold' }}>Add</button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* REASSIGN modal — DROPPED (v1.1 multi-resident). Manager UX
                is now 2 explicit clicks: remove old via per-resident free,
                add new via assign-modal. */}

            {/* FREE modal — v1.1 multi-resident: whole-space OR per-resident.
                INVARIANT: removing a tie NEVER touches vehicles or the
                resident's authorization — only the space-tie relationship. */}
            {targetFree && (
              <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                <div className="modal-card" style={{ background:'#161b26', border:'1px solid #f59e0b', borderRadius:'14px', padding:'22px', maxWidth:'440px', width:'100%' }}>
                  <p style={{ color:'#f59e0b', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px', fontWeight:'bold' }}>Free space</p>
                  <p style={{ color:'white', fontSize:'14px', margin:'0 0 12px' }}><strong style={{ fontFamily:'Courier New', color:'#C9A227' }}>{targetFree.label}</strong></p>

                  {targetFree.residents.length === 0 ? (
                    <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 14px' }}>This space already has no residents tied.</p>
                  ) : targetFree.residents.length === 1 ? (
                    <>
                      <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 14px' }}>
                        Free this space from <strong style={{ color:'white' }}>{targetFree.residents[0].name || targetFree.residents[0].email}</strong>?
                        Space returns to available. Resident&apos;s vehicles + authorization are untouched.
                      </p>
                    </>
                  ) : (
                    <>
                      <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 10px' }}>This space has multiple residents tied. Pick one to remove, or free the whole space.</p>
                      <div style={{ marginBottom:'14px' }}>
                        {targetFree.residents.map(r => (
                          <label key={r.email} style={{ display:'flex', alignItems:'center', gap:'8px', padding:'7px 10px', background: freeResidentEmail === r.email ? '#1e3a5f' : '#0f1117', border: `1px solid ${freeResidentEmail === r.email ? '#3b82f6' : '#2a2f3d'}`, borderRadius:'6px', marginBottom:'4px', cursor:'pointer' }}>
                            <input type="radio" name="free-resident" checked={freeResidentEmail === r.email} onChange={() => setFreeResidentEmail(r.email)} />
                            <span style={{ color:'white', fontSize:'13px' }}>{r.name || r.email}</span>
                            {r.unit && <span style={{ color:'#666', fontSize:'11px' }}>· Unit {r.unit}</span>}
                          </label>
                        ))}
                        <label style={{ display:'flex', alignItems:'center', gap:'8px', padding:'7px 10px', background: freeResidentEmail === null ? '#3a2a08' : '#0f1117', border: `1px solid ${freeResidentEmail === null ? '#f59e0b' : '#2a2f3d'}`, borderRadius:'6px', marginTop:'6px', cursor:'pointer' }}>
                          <input type="radio" name="free-resident" checked={freeResidentEmail === null} onChange={() => setFreeResidentEmail(null)} />
                          <span style={{ color:'#fbbf24', fontSize:'13px', fontWeight:'bold' }}>Free entire space (remove all {targetFree.residents.length} residents)</span>
                        </label>
                      </div>
                    </>
                  )}

                  {spacesError && <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}><p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{spacesError}</p></div>}
                  <div style={{ display:'flex', gap:'8px' }}>
                    <button onClick={() => { setTargetFree(null); setFreeResidentEmail(null); setSpacesError('') }}
                      style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Cancel</button>
                    {targetFree.residents.length > 0 && (
                      <button
                        onClick={() => {
                          // 1-resident state: auto-pick that resident for per-resident free
                          // (UX equivalent to "free outright" but writes the per-resident audit
                          // for clarity). N-resident state: respect the radio selection.
                          if (targetFree.residents.length === 1 && freeResidentEmail === null) {
                            setFreeResidentEmail(targetFree.residents[0].email)
                          }
                          submitFreeSpace()
                        }}
                        style={{ flex:1, padding:'10px', background:'#f59e0b', color:'#0f1117', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                        {freeResidentEmail === null && targetFree.residents.length > 1 ? 'Free entire space' : 'Remove'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* DEACTIVATE-RESIDENT modal — INTENTIONALLY NOT MOUNTED HERE.
                Moved out of the Spaces-tab gate after the regression where
                the Residents-tab Deactivate button set state but the mount
                only rendered when activeTab === 'spaces'. The mount now
                lives next to <CredentialsModal /> at the tab-independent
                slot near the end of this return tree. Do not move it back. */}

            {/* SPACE-DETAIL modal (v1.1 commit 6) — INTENTIONALLY inside
                the Spaces-tab gate: its trigger (the per-row "View" button
                on the spaces list) only exists on this tab, so gating the
                mount here is correct. If a future commit ever surfaces a
                View affordance from another tab, move this mount to the
                tab-independent slot too. onMutate refetches BOTH the
                dashboard and the list so the parent's `s.residents`
                cap-aware buttons stay in sync. */}
            {targetSpaceDetail && (
              <SpaceDetailModal
                space={targetSpaceDetail}
                property={manager.name}
                onClose={() => setTargetSpaceDetail(null)}
                onMutate={async () => {
                  await refetchSpacesDashboard()
                  // 🔴 Finding B v3 root-cause fix (Mateo Aug 20):
                  // read the fresh rows from refetchSpacesList's
                  // return value, NOT from the `spacesList` state
                  // closure (which is stale until React commits the
                  // dispatch). On the first designation set (null →
                  // value transition), the closure returned the
                  // pre-save space with designated_vehicle_id=null;
                  // setTargetSpaceDetail(oldSpace) then triggered no
                  // dep change in the modal's reload useEffect and
                  // left designatedInfo unrefreshed → amber on a
                  // valid designation. Reading the returned rows
                  // sidesteps the closure entirely.
                  const freshRows = await refetchSpacesList()
                  const refreshed = freshRows.find(s => s.id === targetSpaceDetail.id)
                  if (refreshed) setTargetSpaceDetail(refreshed)
                }}
                // 2026-08-19 designated-vehicle Commit 3 — enable the
                // picker for managers. Leasing agents get chip + copy
                // only (no picker) via canEditDesignation=false. CA is
                // Commit 4 (separate mount site in company_admin).
                showDesignation={true}
                canEditDesignation={!isReadOnly}
              />
            )}

            {/* DECOMMISSION modal — confirm only */}
            {targetDecommission && (
              <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                <div className="modal-card" style={{ background:'#161b26', border:'1px solid #991b1b', borderRadius:'14px', padding:'22px', maxWidth:'400px', width:'100%' }}>
                  <p style={{ color:'#f44336', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px', fontWeight:'bold' }}>Decommission space</p>
                  <p style={{ color:'white', fontSize:'14px', margin:'0 0 4px' }}><strong style={{ fontFamily:'Courier New', color:'#C9A227' }}>{targetDecommission.label}</strong></p>
                  <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 14px' }}>Mark this space as inactive (history-only). It disappears from the active operational view but the row + audit trail remain.</p>
                  {spacesError && <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}><p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{spacesError}</p></div>}
                  <div style={{ display:'flex', gap:'8px' }}>
                    <button onClick={() => { setTargetDecommission(null); setSpacesError('') }}
                      style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Cancel</button>
                    <button onClick={submitDecommissionSpace}
                      style={{ flex:1, padding:'10px', background:'#991b1b', color:'white', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Decommission</button>
                  </div>
                </div>
              </div>
            )}

            {/* EDIT METADATA modal — all-fields-required contract */}
            {targetEdit && (
              <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                <div className="modal-card" style={{ background:'#161b26', border:'1px solid #C9A227', borderRadius:'14px', padding:'22px', maxWidth:'440px', width:'100%' }}>
                  <p style={{ color:'#C9A227', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 12px', fontWeight:'bold' }}>Edit space metadata</p>
                  <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase' }}>Label *</label>
                  <input value={editForm.label} onChange={e => setEditForm({ ...editForm, label: e.target.value })} style={inputStyle} placeholder="e.g. CP-12" />
                  <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase' }}>Type *</label>
                  <select value={editForm.type} onChange={e => setEditForm({ ...editForm, type: e.target.value as SpaceType })} style={inputStyle}>
                    {SPACE_TYPES.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                  </select>
                  <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase' }}>Description (location + reference-only price)</label>
                  <textarea value={editForm.description} onChange={e => setEditForm({ ...editForm, description: e.target.value })}
                    placeholder="e.g. North lot row 3 · ref $50/mo (not billed)"
                    style={{ ...inputStyle, minHeight:'50px', resize:'vertical', fontFamily:'Arial' }} />
                  <label style={{ display:'flex', alignItems:'center', gap:'6px', cursor:'pointer', margin:'4px 0 12px' }}>
                    <input type='checkbox' checked={editForm.is_bundled} onChange={e => setEditForm({ ...editForm, is_bundled: e.target.checked })} />
                    <span style={{ color:'#aaa', fontSize:'12px' }}>Bundled / paid (reference flag)</span>
                  </label>
                  {spacesError && <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}><p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{spacesError}</p></div>}
                  <div style={{ display:'flex', gap:'8px' }}>
                    <button onClick={() => { setTargetEdit(null); setSpacesError('') }}
                      style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Cancel</button>
                    <button onClick={submitEditMetadata}
                      style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Save</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* RESIDENTS — hoisted +Add Resident affordance (2026-07-27).
            Renders above whichever residents view is active (CRM by
            default, legacy under !PM_CRM_ENABLED). Gate on managerCompany
            prevents the addResident() no-company alert from firing on
            the cold-load race; the alert stays inside addResident as a
            genuine-no-company backstop. */}
        {activeTab === 'residents' && manager && managerCompany && !isReadOnly && (
          <>
            <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:'8px' }}>
              <button onClick={() => setShowAddResident(!showAddResident)}
                style={{ padding:'8px 14px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'12px', border:'none', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>
                + Add Resident
              </button>
            </div>
            {showAddResident && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Add New Resident</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div style={{ gridColumn:'span 2' }}><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Full Name *</label><input value={newResident.name} onChange={e => setNewResident({...newResident, name: e.target.value})} placeholder="John Smith" style={inputStyle} /></div>
                  <div style={{ gridColumn:'span 2' }}><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Email *</label><input value={newResident.email} onChange={e => setNewResident({...newResident, email: e.target.value})} placeholder="john@email.com" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Phone</label><input value={newResident.phone} onChange={e => setNewResident({...newResident, phone: e.target.value})} placeholder="713-555-0100" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Unit *</label><input value={newResident.unit} onChange={e => setNewResident({...newResident, unit: e.target.value})} placeholder="Apt 214" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Space</label><input value={newResident.space} onChange={e => setNewResident({...newResident, space: e.target.value})} placeholder="A-12" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Lease End</label><input type="date" value={newResident.lease_end} onChange={e => setNewResident({...newResident, lease_end: e.target.value})} style={inputStyle} /></div>
                  {/* B167 — optional vehicle fields. Plate empty => resident-only. */}
                  <div style={{ gridColumn:'span 2', borderTop:'1px solid #2a2f3d', paddingTop:'10px', marginTop:'4px' }}>
                    <p style={{ color:'white', fontSize:'12px', fontWeight:'bold', margin:'0 0 6px' }}>Vehicle (optional)</p>
                    <p style={{ color:'#777', fontSize:'10px', margin:'0' }}>Leave Plate empty to add the resident without a vehicle.</p>
                  </div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Plate</label><input value={newResident.vehicle_plate} onChange={e => setNewResident({...newResident, vehicle_plate: normalizePlate(e.target.value)})} placeholder="ABC1234" style={{ ...inputStyle, fontFamily:'Courier New', fontSize:'14px', fontWeight:'bold' }} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>State</label><select value={newResident.vehicle_state} onChange={e => setNewResident({...newResident, vehicle_state: e.target.value})} style={inputStyle}>{['TX','CA','FL','NY','GA','OH','IL','PA','NC','AZ'].map(s => <option key={s}>{s}</option>)}</select></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Make</label><input value={newResident.vehicle_make} onChange={e => setNewResident({...newResident, vehicle_make: e.target.value})} placeholder="Toyota" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Model</label><input value={newResident.vehicle_model} onChange={e => setNewResident({...newResident, vehicle_model: e.target.value})} placeholder="Camry" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Year</label><input value={newResident.vehicle_year} onChange={e => setNewResident({...newResident, vehicle_year: e.target.value})} placeholder="2022" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Color</label><input value={newResident.vehicle_color} onChange={e => setNewResident({...newResident, vehicle_color: e.target.value})} placeholder="Black" style={inputStyle} /></div>
                </div>
                {/* Spaces v1 commit 4 — OPTIONAL assign-space step on add.
                    Empty = add resident without space; same "approval ≠
                    assignment" lock. Dropdown sourced from the available-
                    spaces pool refreshed alongside the dashboard. */}
                {availableSpacesForAssign.length > 0 && (
                  <div style={{ borderTop:'1px solid #2a2f3d', paddingTop:'10px', marginTop:'10px' }}>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Assign space (optional)</label>
                    <select value={newResidentAssignSpaceId}
                      onChange={e => setNewResidentAssignSpaceId(e.target.value)}
                      style={{ ...inputStyle, marginTop:'4px' }}>
                      <option value=''>— No space assignment —</option>
                      {availableSpacesForAssign.map(s => (
                        <option key={s.id} value={String(s.id)}>{s.label} · {TYPE_LABELS[s.type] ?? s.type}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={addResident} disabled={addResidentSubmitting} style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor: addResidentSubmitting ? 'not-allowed' : 'pointer', opacity: addResidentSubmitting ? 0.6 : 1 }}>{addResidentSubmitting ? 'Adding…' : 'Add Resident'}</button>
                  <button onClick={() => { setShowAddResident(false); setNewResidentAssignSpaceId('') }} style={{ padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                </div>
              </div>
            )}
          </>
        )}

        {/* RESIDENTS — silent-read reveal banners (2026-08-01). See
            fetchResidents comment block for the two-branch shape.
            Prior state PRESERVED underneath; banners inform the
            manager that what they're seeing may be stale so they
            don't act on it as truth. */}
        {activeTab === 'residents' && manager && residentsFetchState.status === 'error' && (
          <div style={{ background:'#2a1015', border:'1px solid #7f1d1d', borderRadius:'8px', padding:'12px 14px', marginBottom:'12px' }}>
            <p style={{ color:'#fca5a5', fontSize:'13px', margin:0, lineHeight:1.5 }}>
              Couldn&apos;t refresh the resident list. Showing the last version — try again in a moment.
            </p>
          </div>
        )}
        {activeTab === 'residents' && manager && residentsFetchState.status === 'unexpectedly_empty' && (
          <div style={{ background:'#2a1015', border:'1px solid #7f1d1d', borderRadius:'8px', padding:'12px 14px', marginBottom:'12px' }}>
            <p style={{ color:'#fca5a5', fontSize:'13px', margin:'0 0 6px', lineHeight:1.5, fontWeight:600 }}>
              No residents came back for this property.
            </p>
            <p style={{ color:'#fca5a5', fontSize:'12px', margin:0, lineHeight:1.5, opacity:0.85 }}>
              You may not have access to this property, or your account may have been deactivated. Contact your company administrator. Showing the last version below.
            </p>
          </div>
        )}

        {/* RESIDENTS — PM CRM (slice 1) */}
        {activeTab === 'residents' && PM_CRM_ENABLED && manager && (
          <PmResidentCrm
            crmResidents={buildCrmResidents({
              residents,
              pendingResidents,
              // Union both slices — fetchVehicles splits state into
              // `pendingVehicles` (status='pending') vs `vehicles` (rest).
              // The CRM needs BOTH to render pending-vehicle badges and to
              // cascade-approve correctly in slice 2. countVehicles sorts
              // by status downstream, so passing the union yields the
              // right approved/pending/underReview counts.
              vehicles: [...vehicles, ...pendingVehicles],
              spaces: crmSpacesAtProperty,
              spaceResidentTies: crmSpaceResidentTies,
              guestAuths: crmGuestAuthsAtProperty,
              spaceRequests: crmSpaceRequestsAtProperty,
              pendingPlateChanges: crmPendingPlateChanges,
              pendingGuestRequests: crmPendingGuestRequestsAtProperty,
            })}
            propertyName={manager.name}
            managerEmail={managerEmail}
            availableSpaces={crmSpacesAtProperty.filter(s => s.status === 'available' && s.is_active).map(s => ({ id: s.id, label: s.label, type: s.type }))}
            unitOccupancy={unitOccupancy}
            canApproveVehicles={canApproveVehicles}
            isReadOnly={isReadOnly}
            onApproveVehicle={(id) => approveVehicle(String(id))}
            onDeclineVehicle={(id) => declineVehicle(String(id))}
            onApproveResident={(r) => approveResident(r)}
            onDeclineResident={(r) => declineResident(r)}
            onApproveAllPending={(rs) => approveAllPendingCrm(rs)}
            onReleaseSpace={(spaceId, email) => releaseSpaceForResident(spaceId, email)}
            onAssignSpaceRequest={(reqId, spaceId) => assignSpaceForRequest(reqId, spaceId)}
            onDeclineSpaceRequest={(reqId) => declineSpaceRequestFromCrm(reqId)}
            onApprovePlateChange={(changeId) => approvePlateChange(changeId)}
            onDeclinePlateChange={(changeId) => declinePlateChange(changeId)}
            onDeactivateVehicle={(id) => deactivateVehicleCrm(id)}
            onReactivateVehicle={(id) => reactivateVehicleCrm(id)}
            onEditVehicle={(id, patch) => editVehicleCosmetic(id, patch)}
            onEditResident={(id, patch) => editResidentCosmetic(id, patch)}
            onApproveGuestAuthRequest={(id, dates) => approveGuestAuthRequestCrm(id, dates)}
            onDeclineGuestAuthRequest={(id, reason) => declineGuestAuthRequestCrm(id, reason)}
            onDeactivateResident={(r) => deactivateResident(String(r.id))}
            onReactivateResident={(r) => reactivateResident(String(r.id))}
            onUndeclineResident={(r) => undeclineResident({ id: String(r.id), name: r.name, email: r.email })}
            onOpenAddVehicle={(r) => setAddVehicleFor(r)}
            onExportLogged={async ({ propertyName, residentCount, vehicleCount, filterUsed, searchUsed }) => {
              // 2026-07-29 — resident+vehicle CSV export audit trail.
              // The CSV contains resident PII (name/email/phone/plates)
              // leaving the system onto someone's laptop; audit_logs
              // records who exported what, from what property, and how
              // it was filtered so a later "who accessed my data" ask
              // has an answer.
              await logAudit({
                action: 'EXPORT_RESIDENT_LIST',
                table_name: 'residents',
                new_values: {
                  property: propertyName,
                  resident_count: residentCount,
                  vehicle_count: vehicleCount,
                  filter: filterUsed,
                  search: searchUsed || null,
                  exported_by: managerEmail,
                },
              })
            }}
          />
        )}

        {/* RESIDENTS — legacy render (kept behind !PM_CRM_ENABLED for rollback until slice 2) */}
        {activeTab === 'residents' && !PM_CRM_ENABLED && (
          <div>
            {pendingResidents.length > 0 && (
              <div style={{ background:'#1a1400', border:'1px solid #a16207', borderRadius:'10px', padding:'14px', marginBottom:'16px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', margin:'0 0 12px', gap:'8px', flexWrap:'wrap' as const }}>
                  <p style={{ color:'#fbbf24', fontWeight:'bold', fontSize:'12px', textTransform:'uppercase', letterSpacing:'0.08em', margin:0 }}>
                    Pending Resident Registrations ({pendingResidents.length})
                  </p>
                  {/* B212 — Refresh + last-updated for this queue. */}
                  <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                    <span style={{ color:'#666', fontSize:'10px' }}>Updated {fmtAgo(residentsPendingRefreshedAt)}</span>
                    <button onClick={refreshResidentsPending}
                      title="Refresh pending residents"
                      style={{ padding:'4px 10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                      ↻ Refresh
                    </button>
                  </div>
                </div>
                {pendingResidents.map(r => (
                  <div key={r.id} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', marginBottom:'10px' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                      <div>
                        <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'0' }}>{r.name}</p>
                        <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{r.unit} · {r.email}</p>
                        {r.phone && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>{r.phone}</p>}
                      </div>
                      <span style={{ background:'#2a1e00', color:'#fbbf24', border:'1px solid #a16207', padding:'2px 7px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold', whiteSpace:'nowrap' }}>Pending</span>
                    </div>
                    {(() => {
                      const unitVehicles = vehicles.filter(v => v.unit?.toLowerCase() === r.unit?.toLowerCase() && v.status === 'pending')
                      return unitVehicles.length > 0 ? (
                        <div style={{ marginBottom:'10px' }}>
                          <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 6px' }}>Pending Vehicles</p>
                          {unitVehicles.map((v, i) => (
                            <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 8px', background:'#0f1117', borderRadius:'6px', marginBottom:'4px' }}>
                              <span style={{ color:'white', fontFamily:'Courier New', fontSize:'13px', fontWeight:'bold' }}>{v.plate}</span>
                              <span style={{ color:'#888', fontSize:'11px' }}>{[v.color, v.make, v.model].filter(Boolean).join(' ')}</span>
                            </div>
                          ))}
                        </div>
                      ) : null
                    })()}
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Note (optional)</label>
                    <input
                      value={residentNotes[r.id] || ''}
                      onChange={e => setResidentNotes(n => ({...n, [r.id]: e.target.value}))}
                      placeholder="e.g. Welcome! or Missing documentation."
                      style={{ ...inputStyle, marginTop:'4px', marginBottom:'10px' }}
                    />
                    {/* Spaces v1 commit 4 — OPTIONAL assign-space dropdown.
                        Empty selection = approve without space assignment
                        (the default; "approval ≠ assignment" per Jose lock).
                        Dropdown populated from available-spaces pool refreshed
                        alongside the spaces dashboard data. */}
                    {availableSpacesForAssign.length > 0 && (
                      <>
                        <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Assign space (optional)</label>
                        <select
                          value={pendingResidentAssignSpaceId[r.id] || ''}
                          onChange={e => setPendingResidentAssignSpaceId(prev => ({ ...prev, [r.id]: e.target.value }))}
                          style={{ ...inputStyle, marginTop:'4px', marginBottom:'10px' }}>
                          <option value=''>— No space assignment —</option>
                          {availableSpacesForAssign.map(s => (
                            <option key={s.id} value={String(s.id)}>{s.label} · {TYPE_LABELS[s.type] ?? s.type}</option>
                          ))}
                        </select>
                      </>
                    )}
                    {!isReadOnly && (
                      <div style={{ display:'flex', gap:'8px' }}>
                        {/* Permit-Door Piece 1 §3 — Resident approval gated
                            on can_approve_vehicles. The cascade vehicle
                            approvals trigger the billing prompt; gating
                            here is consistent — managers without authority
                            don't approve residents (which would otherwise
                            leave vehicles in pending with no path to
                            approval). Decline always visible. */}
                        {canApproveVehicles && (
                          <button onClick={() => approveResident(r)}
                            style={{ flex:1, padding:'8px', background:'#1a3a1a', color:'#4caf50', border:'1px solid #2e7d32', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                            Approve
                          </button>
                        )}
                        <button onClick={() => declineResident(r)}
                          style={{ flex:1, padding:'8px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                          Decline
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div style={{ display:'flex', gap:'8px', marginBottom:'12px', alignItems:'center' }}>
              <input value={residentSearch} onChange={e => setResidentSearch(e.target.value)} placeholder="Search name, email, unit, phone..." style={{ ...inputStyle, flex:1, marginTop:0, marginBottom:0 }} />
              <button onClick={() => setShowActiveResidents(s => !s)} style={{ padding:'4px 10px', background: showActiveResidents ? '#1a1f2e' : '#111', color: showActiveResidents ? '#C9A227' : '#555', border:`1px solid ${showActiveResidents ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial', whiteSpace:'nowrap' as const }}>{showActiveResidents ? '● Active Only' : '○ Show All'}</button>
            </div>
            {/* 2026-07-27 — +Add Resident affordance hoisted OUT of this
                branch to render above whichever residents view is active
                (CRM or legacy fallback). See the hoisted block at the
                RESIDENTS — PM CRM comment. */}
            {editingResident && (
              /* Bible-view mobile scroll-lock fix — Fix A / Option A2
                 (2026-07-17). Wraps the resident-detail panel in the
                 drawer shape proven at app/admin_console/page.tsx:822
                 so the panel has its OWN viewport-bounded scroll
                 context. Without this, the panel is inline in document
                 flow and depends on page scroll — which is broken on
                 mobile (Jose's real-phone repro: portrait shows only
                 the list, landscape shows ~25% of detail, rest is
                 cut off and unreachable). The drawer shape works
                 regardless of page-scroll behavior.

                 The load-bearing rules: outer position:fixed inset:0
                 (viewport-bounded flex container) + inner maxHeight:
                 100vh (bounds the inner region to viewport height) +
                 inner overflowY:auto (scrolls the panel content inside
                 that bound). Backdrop onClick closes; inner
                 stopPropagation keeps the panel open on internal clicks.

                 Panel content wrapped verbatim per Mateo directive —
                 no field/grid/logic changes. The gridTemplateColumns:
                 '1fr 1fr' inside stays cramped in a 380px drawer;
                 that's Fix B (responsive pass), a separate later
                 commit. "Usable but ugly" is the intended end state
                 of A2.

                 The underlying root-layout page-scroll issue (html
                 .h-full likely blocking page scroll on mobile) is
                 filed as Fix A1 in docs/backlog/ — same commit set
                 as this one. That's the structural close; this is
                 the scoped safety fix for the highest-visibility
                 instance. */
              <div onClick={() => setEditingResident(null)}
                   style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:2000, display:'flex', justifyContent:'flex-end' }}>
                <div onClick={e => e.stopPropagation()}
                     style={{ background:'#161b26', borderLeft:'1px solid #C9A227', width:380, maxWidth:'90vw', maxHeight:'100vh', padding:18, overflowY:'auto' }}>
              <div style={{ background:'#161b26', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Editing — {editingResident.unit}</p>
                {/* Fix B (2026-07-20) — .pm-drawer-grid collapses to 1-col
                    on phone (~301px drawer content) and stays 2-col on
                    desktop (~344px). See globals.css header for math.
                    .pm-drawer-grid-full replaces inline gridColumn:'span 2'
                    — spans whatever the current column count is (2 on
                    desktop, 1 on phone), which is exactly what we want. */}
                <div className="pm-drawer-grid">
                  <div className="pm-drawer-grid-full"><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Full Name</label><input value={editingResident.name || ''} onChange={e => setEditingResident({...editingResident, name: e.target.value})} style={inputStyle} /></div>
                  <div className="pm-drawer-grid-full"><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Email</label><input value={editingResident.email || ''} onChange={e => setEditingResident({...editingResident, email: e.target.value})} style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Phone</label><input value={editingResident.phone || ''} onChange={e => setEditingResident({...editingResident, phone: e.target.value})} style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Unit</label><input value={editingResident.unit || ''} onChange={e => setEditingResident({...editingResident, unit: e.target.value})} style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Space</label><input value={editingResident.space || ''} onChange={e => setEditingResident({...editingResident, space: e.target.value})} style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Lease End</label><input type="date" value={editingResident.lease_end || ''} onChange={e => setEditingResident({...editingResident, lease_end: e.target.value})} style={inputStyle} /></div>
                </div>
                {/* Fix B — primary action buttons bumped to padding:12px so tap
                    target ≥40px on phone touch surfaces. */}
                <div style={{ display:'flex', gap:'8px', marginTop:'4px', marginBottom:'16px' }}>
                  <button onClick={saveResident} style={{ flex:1, padding:'12px 14px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>Save Changes</button>
                  <button onClick={() => setEditingResident(null)} style={{ padding:'12px 16px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                </div>
                <div style={{ borderTop:'1px solid #2a2f3d', paddingTop:'14px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'10px' }}>
                    <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0' }}>Vehicles — {editingResident.unit}</p>
                    <button onClick={async () => { setShowAddVehicle(true); await fetchResidentsAtUnit(editingResident.unit); setVehicleOwnerEmail(editingResident.email || '') }} style={{ padding:'5px 10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'11px', border:'none', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>+ Add Vehicle</button>
                  </div>
                  {showAddVehicle && (
                    <div style={{ background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', padding:'12px', marginBottom:'10px' }}>
                      {/* Fix B (2026-07-20) — .pm-drawer-grid collapses to
                          1-col on phone drawer (~301px content), 2-col on
                          desktop drawer (~344px). Preserves the desktop
                          2-col add-vehicle form. */}
                      <div className="pm-drawer-grid">
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Plate *</label><input value={newVehicle.plate} onChange={e => setNewVehicle({...newVehicle, plate: normalizePlate(e.target.value)})} placeholder="ABC1234" style={{ ...inputStyle, fontFamily:'Courier New', fontSize:'14px', fontWeight:'bold' }} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>State</label><select value={newVehicle.state} onChange={e => setNewVehicle({...newVehicle, state: e.target.value})} style={inputStyle}>{['TX','CA','FL','NY','GA','OH','IL','PA','NC','AZ'].map(s => <option key={s}>{s}</option>)}</select></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Make</label><input value={newVehicle.make} onChange={e => setNewVehicle({...newVehicle, make: e.target.value})} placeholder="Toyota" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Model</label><input value={newVehicle.model} onChange={e => setNewVehicle({...newVehicle, model: e.target.value})} placeholder="Camry" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Year</label><input value={newVehicle.year} onChange={e => setNewVehicle({...newVehicle, year: e.target.value})} placeholder="2022" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Color</label><input value={newVehicle.color} onChange={e => setNewVehicle({...newVehicle, color: e.target.value})} placeholder="Black" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Space</label><input value={newVehicle.space} onChange={e => setNewVehicle({...newVehicle, space: e.target.value})} placeholder="A-12" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Permit Expiry</label><input type="date" value={newVehicle.permit_expiry} onChange={e => setNewVehicle({...newVehicle, permit_expiry: e.target.value})} style={inputStyle} /></div>
                        {/* B166 — owner picker. Pre-loaded with editingResident on modal open. */}
                        <div className="pm-drawer-grid-full">
                          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Vehicle Owner</label>
                          <select value={vehicleOwnerEmail} onChange={e => setVehicleOwnerEmail(e.target.value)} style={inputStyle}>
                            <option value="">Unit-level / shared (no owner)</option>
                            {residentsAtUnit.map(r => (
                              <option key={r.email} value={r.email}>{r.name} ({r.email})</option>
                            ))}
                          </select>
                          {residentsAtUnit.length >= 2 && !vehicleOwnerEmail && (
                            <p style={{ color:'#C9A227', fontSize:'10px', margin:'4px 0 0' }}>Multiple residents — pick the owner.</p>
                          )}
                        </div>
                      </div>
                      {/* Fix B — add-vehicle action buttons bumped from 9px
                          padding → 11px so tap target ≥40px on phone. */}
                      <div style={{ display:'flex', gap:'8px' }}>
                        <button onClick={() => addVehicle(editingResident.unit)} disabled={addVehicleSubmitting} style={{ flex:1, padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'12px', border:'none', borderRadius:'6px', cursor: addVehicleSubmitting ? 'not-allowed' : 'pointer', opacity: addVehicleSubmitting ? 0.6 : 1 }}>{addVehicleSubmitting ? 'Adding…' : 'Add Vehicle'}</button>
                        <button onClick={() => setShowAddVehicle(false)} style={{ padding:'11px 14px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {vehicles.filter(v => v.unit?.toLowerCase() === editingResident.unit?.toLowerCase()).length === 0
                    ? <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No vehicles for this unit</p>
                    : vehicles.filter(v => v.unit?.toLowerCase() === editingResident.unit?.toLowerCase()).map((v,i) => (
                      <div key={i} style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', marginBottom:'8px' }}>
                        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'6px' }}>
                          <div>
                            <p style={{ color:'white', fontFamily:'Courier New', fontSize:'16px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                            <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{v.color} {v.make} {v.model} {v.year}</p>
                          </div>
                          <span style={{ background: v.is_active ? '#1a3a1a' : '#3a1a1a', color: v.is_active ? '#4caf50' : '#f44336', padding:'2px 7px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold', alignSelf:'flex-start' }}>{v.is_active ? 'Active' : 'Inactive'}</span>
                        </div>
                        {/* Fix B — per-vehicle mini-grid (read-only) switched to
                            .pm-drawer-grid. Was 3-col-everywhere (cramped on
                            phone at ~95px per column); now 2-col desktop /
                            1-col phone. Read-only display, no touch-target
                            concerns; fontSize + marginBottom preserved inline. */}
                        <div className="pm-drawer-grid" style={{ fontSize:'11px', marginBottom:'8px' }}>
                          <div><span style={{ color:'#555' }}>Space</span><br/><span style={{ color:'#aaa' }}>{v.space || '—'}</span></div>
                          <div><span style={{ color:'#555' }}>State</span><br/><span style={{ color:'#aaa' }}>{v.state}</span></div>
                          <div><span style={{ color:'#555' }}>Permit Expiry</span><br/><span style={{ color:'#aaa' }}>{formatDate(v.permit_expiry)}</span></div>
                        </div>
                        <div style={{ display:'flex', gap:'6px' }}>
                          <button onClick={async () => { const space = prompt('Update space:', v.space || ''); if (space === null) return; await supabase.from('vehicles').update({ space }).eq('id', v.id); fetchVehicles(manager.name) }}
                            style={{ flex:1, padding:'6px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial', fontWeight:'bold' }}>Edit Space</button>
                          <button onClick={async () => { const plate = prompt('Update plate:', v.plate); if (plate === null) return; await supabase.from('vehicles').update({ plate: normalizePlate(plate) }).eq('id', v.id); fetchVehicles(manager.name) }}
                            style={{ flex:1, padding:'6px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Edit Plate</button>
                          <button onClick={() => removeVehicle(v.id)}
                            style={{ padding:'6px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Remove</button>
                        </div>
                        <a href={TOWED_CAR_LOOKUP_URL} target="_blank" rel="noopener noreferrer"
                          style={{ color:'#C9A227', fontSize:'11px', textDecoration:'underline', padding:'6px 0 2px', display:'block' }}>
                          🔍 Search FindMyTowedCar.org
                        </a>
                      </div>
                    ))
                  }
                </div>
              </div>
                {/* Bible-view A2 — drawer inner close (overflowY:auto + maxHeight:100vh) */}
                </div>
                {/* Bible-view A2 — drawer outer/backdrop close (position:fixed inset:0) */}
              </div>
            )}
            {filteredResidents().map((r,i) => (
              <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                  <div>
                    <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'0' }}>{r.name}</p>
                    <p style={{ color:'#aaa', fontSize:'12px', margin:'3px 0 0' }}>{r.unit} · {r.email}</p>
                  </div>
                  <span style={{ background: r.is_active ? '#1a3a1a' : '#3a1a1a', color: r.is_active ? '#4caf50' : '#f44336', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold' }}>{r.is_active ? 'Active' : 'Inactive'}</span>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'6px', fontSize:'11px', marginBottom:'10px' }}>
                  <div><span style={{ color:'#555' }}>Phone</span><br/><span style={{ color:'#aaa' }}>{r.phone || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Space</span><br/><span style={{ color:'#aaa' }}>{r.space || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Lease End</span><br/><span style={{ color:'#aaa' }}>{formatDate(r.lease_end)}</span></div>
                </div>
                <div style={{ display:'flex', gap:'6px', flexWrap:'wrap' }}>
                  {!isReadOnly && (
                    <>
                      <button onClick={() => { setEditingResident(r); setShowAddVehicle(false) }}
                        style={{ flex:1, padding:'7px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial', fontWeight:'bold' }}>Edit</button>
                      {r.is_active && <button onClick={() => deactivateResident(r.id)}
                        style={{ padding:'7px 12px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Deactivate</button>}
                      {!r.is_active && <button onClick={() => reactivateResident(r.id)}
                        style={{ padding:'7px 12px', background:'#1a3a1a', color:'#4caf50', border:'1px solid #2e7d32', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Reactivate</button>}
                    </>
                  )}
                  <button onClick={() => { setResetPwTarget(resetPwTarget === r.email ? null : r.email); setResetPwForm({ newPw:'', confirmPw:'' }); setResetPwMsg('') }}
                    style={{ padding:'7px 10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                    {resetPwTarget === r.email ? 'Cancel' : 'Reset Password'}
                  </button>
                </div>
                {resetPwTarget === r.email && (
                  <div style={{ marginTop:'10px', borderTop:'1px solid #2a2f3d', paddingTop:'10px' }}>
                    <input type="password" value={resetPwForm.newPw} onChange={e => setResetPwForm(f => ({...f, newPw: e.target.value}))}
                      placeholder="New password (min 8 chars)" style={{ ...inputStyle, marginBottom:'8px' }} />
                    <input type="password" value={resetPwForm.confirmPw} onChange={e => setResetPwForm(f => ({...f, confirmPw: e.target.value}))}
                      placeholder="Confirm new password" style={{ ...inputStyle, marginBottom:'8px' }} />
                    {resetPwMsg && (
                      <p style={{ color: resetPwMsg.includes('success') ? '#4caf50' : '#f44336', fontSize:'12px', margin:'0 0 8px' }}>{resetPwMsg}</p>
                    )}
                    <button onClick={resetResidentPassword}
                      style={{ width:'100%', padding:'8px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'12px', border:'none', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>
                      Save New Password
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* VIOLATIONS */}
        {activeTab === 'violations' && (
          <div>
            <div style={{ background:'#1a2a1a', border:'1px solid #2e7d32', borderRadius:'8px', padding:'12px 14px', marginBottom:'12px' }}>
              <p style={{ color:'#4caf50', fontWeight:'bold', fontSize:'12px', margin:'0 0 2px' }}>View Only</p>
              <p style={{ color:'#aaa', fontSize:'12px', margin:'0', lineHeight:'1.5' }}>Violations are filed by enforcement drivers. Contact your company administrator to report an issue.</p>
            </div>
            <input value={violationSearch} onChange={e => setViolationSearch(e.target.value)} placeholder="Search plate, violation type, location..." style={{ ...inputStyle, marginBottom:'10px' }} />
            <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'12px' }}>
              {[{k:'today',l:'Today'},{k:'week',l:'This Week'},{k:'sixmonths',l:'6 Months'}].map(f => (
                <button key={f.k} onClick={() => setViolationFilter(f.k)}
                  style={{ flex:1, padding:'8px', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', background: violationFilter === f.k ? '#C9A227' : 'transparent', color: violationFilter === f.k ? '#0f1117' : '#888', fontFamily:'Arial' }}>
                  {f.l}
                </button>
              ))}
            </div>
            {filteredViolations().length === 0
              ? <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}><p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No violations for this period</p></div>
              : filteredViolations().map((v,i) => (
                <div key={i} style={{ background:'#161b26', border: v.voided_at ? '1px solid #b71c1c' : '1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px', opacity: v.voided_at ? 0.78 : 1 }}>
                  {/* B175 — voided marker. Manager + admin keep voided rows
                      visible+marked for forensic clarity (operators need to
                      see what was voided; resident view filters them out,
                      analytics excludes from counts). The opacity dim + red
                      border + badge communicate "not in effect" without
                      hiding the audit-relevant data. */}
                  {v.voided_at && (
                    <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'6px 10px', marginBottom:'10px', display:'flex', alignItems:'center', gap:'8px' }}>
                      <span style={{ fontSize:'14px' }}>🚫</span>
                      <span style={{ color:'#f44336', fontSize:'11px', fontWeight:'bold', textTransform:'uppercase', letterSpacing:'0.06em' }}>VOIDED</span>
                      <span style={{ color:'#888', fontSize:'10px', marginLeft:'auto' }}>
                        {formatDate(v.voided_at as string)}
                        {v.void_reason ? ` · ${v.void_reason}` : ''}
                      </span>
                    </div>
                  )}
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'8px' }}>
                    <p style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                    <p style={{ color:'#555', fontSize:'11px', margin:'0' }}>{formatDate(v.created_at)}</p>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px', fontSize:'12px' }}>
                    <div><span style={{ color:'#555' }}>Type</span><br/><span style={{ color:'#aaa' }}>{displayTowReason(v.violation_type)}</span></div>
                    <div><span style={{ color:'#555' }}>Location</span><br/><span style={{ color:'#aaa' }}>{v.location || '—'}</span></div>
                    {v.notes && <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555' }}>Notes</span><br/><span style={{ color:'#aaa' }}>{v.notes}</span></div>}
                  </div>
                  {(v.vehicle_color || v.vehicle_make || v.vehicle_model) && (
                    <p style={{ color:'#555', fontSize:'11px', margin:'8px 0 0' }}>🚗 {[v.vehicle_color, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')}</p>
                  )}
                  {v.photos && v.photos.length > 0 && (
                    <div style={{ marginTop:'8px' }}>
                      <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', margin:'0 0 6px' }}>Photos</p>
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'6px' }}>
                        {v.photos.map((url: string, pi: number) => (
                          <a key={pi} href={url} target="_blank" rel="noopener noreferrer">
                            <img src={url} alt={`Photo ${pi+1}`} style={{ width:'100%', aspectRatio:'4/3', objectFit:'cover', borderRadius:'6px', border:'1px solid #2a2f3d' }} />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                  {v.video_url && (
                    <button onClick={() => window.open(v.video_url, '_blank')}
                      style={{ width:'100%', padding:'7px', background:'#0f1620', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial', marginTop:'8px' }}>
                      ▶ Play Video
                    </button>
                  )}
                  {v.tow_ticket_generated && (
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:'10px', paddingTop:'10px', borderTop:'1px solid #2a2f3d' }}>
                      <span style={{ background:'#1a1500', border:'1px solid #C9A227', color:'#C9A227', fontSize:'10px', fontWeight:'bold', padding:'3px 8px', borderRadius:'4px', letterSpacing:'0.05em' }}>🎫 TOW TICKET ISSUED</span>
                      {/* B182 — manager / leasing_agent see the price-free PM view
                          via /ticket/pm/[id]. The route's RPC enforces property-
                          scope + voided + role gates, returning a payload that
                          NEVER contains tow_fee or tow_storage_*. The prior
                          Reprint button used the manager portal's local template
                          which carried prices — removed in favor of this. */}
                      <a href={`/ticket/pm/${v.id}`} target="_blank" rel="noopener noreferrer"
                        style={{ padding:'6px 12px', background:'#0f1620', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial', textDecoration:'none', display:'inline-block' }}>
                        View Ticket
                      </a>
                    </div>
                  )}
                  {/* B182 #2 — "Manage Media" button removed. PMs view evidence
                      but must not delete it. Server-side closure: dropped
                      violation_photos_manager_update + violation_videos_manager_update
                      policies (migrations/20260615_b182_2_media_authz_close.sql).
                      Resolution + deletion authority stays with company_admin via
                      its existing PostConfirmationEditModal entry in
                      app/company_admin/page.tsx. */}
                  <a href={TOWED_CAR_LOOKUP_URL} target="_blank" rel="noopener noreferrer"
                    style={{ color:'#C9A227', fontSize:'11px', textDecoration:'underline', padding:'6px 0 2px', display:'block' }}>
                    🔍 Search FindMyTowedCar.org
                  </a>
                </div>
              ))
            }
          </div>
        )}

        {/* SETTINGS */}
        {activeTab === 'settings' && (
          <div>
            {/* Section A — Visitor Pass Limit */}
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'14px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 4px' }}>Visitor Pass Limit</p>
              <p style={{ color:'#555', fontSize:'12px', margin:'0 0 14px', lineHeight:'1.5' }}>How many times the same vehicle can be issued a visitor pass at this property within a rolling 30-day period. Leave blank for unlimited. Add regular visitors — caregivers, family, service providers — to the exempt list below so they&apos;re never counted.</p>
              <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Max Visitor Passes Per Plate Per 30 Days</label>
              <input
                type="number"
                min="0"
                value={passLimit}
                onChange={e => { setPassLimit(e.target.value); setSettingsMsg('') }}
                placeholder="Unlimited"
                disabled={isReadOnly}
                style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'12px', padding:'9px 10px', background: isReadOnly ? '#1a1a2a' : '#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color: isReadOnly ? '#555' : 'white', fontSize:'13px', boxSizing:'border-box', outline:'none' }}
              />
              {!isReadOnly && (
                <button onClick={savePassLimit}
                  style={{ width:'100%', padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>
                  Save Pass Limit
                </button>
              )}
              {settingsMsg && (
                <p style={{ color: settingsMsg.startsWith('Error') ? '#f44336' : '#4caf50', fontSize:'12px', margin:'10px 0 0' }}>{settingsMsg}</p>
              )}
            </div>

            {/* 2026-08-20 house-rules arc Commit 2 — Section A.5 (House Rules).
                Positioned above Registration QR because it's a policy-authoring
                surface, more consequential than a display QR. Section shape
                mirrors Visitor Pass Limit above:
                - Header + descriptive copy
                - Persisted-state readout (version + effective + last saved)
                - Textarea + effective-date input + Ch. 94 help text
                - Save button, disabled during in-flight save
                - Status message

                🔴 Non-goals reminder (see migration header):
                - Not an enforcement input
                - Free text — not a plate concept
                - Not merged with resident bulletins
                No acknowledgment gate; no driver surface. */}
            {manager && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'14px' }}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 4px' }}>House Rules</p>
                <p style={{ color:'#555', fontSize:'12px', margin:'0 0 12px', lineHeight:'1.5' }}>
                  Property policy visible to residents in their portal and to your company admin.
                  Free text — describe what your team wants residents to know
                  (parking rules, tow zones, quiet hours, guest policy, etc.).
                  Leave blank to unpublish. Does not affect enforcement — all approved vehicles remain
                  authorized regardless of what&apos;s written here.
                </p>

                {/* Persisted-state readout. Only render when there IS a
                    published version — an empty draft with no history reads
                    as "no rules yet" via the placeholder in the textarea. */}
                {manager.house_rules_version > 0 && (
                  <div style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}>
                    {manager.house_rules_text ? (
                      <p style={{ color:'#aaa', fontSize:'11px', margin:0, lineHeight:'1.5' }}>
                        <strong style={{ color:'#C9A227' }}>Version {manager.house_rules_version}</strong>
                        {' · effective '}
                        <strong style={{ color:'white' }}>{manager.house_rules_effective_date}</strong>
                        {manager.house_rules_updated_by_email && (
                          <>{' · last saved by '}<span style={{ color:'#888' }}>{manager.house_rules_updated_by_email}</span></>
                        )}
                      </p>
                    ) : (
                      <p style={{ color:'#fbbf24', fontSize:'11px', margin:0, lineHeight:'1.5' }}>
                        <strong>Currently unpublished.</strong> Previous version {manager.house_rules_version} is in history.
                      </p>
                    )}
                  </div>
                )}

                <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Rules Text</label>
                <textarea
                  value={houseRulesDraft}
                  onChange={e => { setHouseRulesDraft(e.target.value); setHouseRulesMsg('') }}
                  placeholder={`Parking Rules\n- Each unit is assigned one parking space.\n- Visitor passes required for overnight guests.\n- Tow zone is the north lot (marked).\n\nVehicle Requirements\n- All vehicles must have current registration and insurance.\n- No commercial vehicles over 1 ton.\n\nQuiet Hours\n- 10pm to 7am daily.`}
                  disabled={isReadOnly || houseRulesBusy}
                  rows={10}
                  style={{
                    display:'block', width:'100%', marginTop:'6px', marginBottom:'6px',
                    padding:'9px 10px',
                    background: (isReadOnly || houseRulesBusy) ? '#1a1a2a' : '#1e2535',
                    border:'1px solid #3a4055', borderRadius:'6px',
                    color: (isReadOnly || houseRulesBusy) ? '#555' : 'white',
                    fontSize:'13px', fontFamily:'inherit', lineHeight:'1.5',
                    boxSizing:'border-box', outline:'none', resize:'vertical',
                  }}
                />
                {/* 2026-08-20 Commit 2b — help text under the textarea.
                    The paste-from-Word/PDF warning is the load-bearing
                    part: the Aug 20 finding was a manager pasting from
                    a rendered document (visual line breaks were layout,
                    not \n characters) and the resident view showed a
                    wall of text. The preview pane below is the durable
                    fix; this copy is the advisory version. */}
                <p style={{ color:'#7a8394', fontSize:'11px', margin:'0 0 12px', lineHeight:'1.5', fontStyle:'italic' }}>
                  Plain text — press Enter for a new line, blank lines separate sections. Text pasted from Word or a PDF may
                  lose its line breaks; check the preview below before saving.
                </p>

                <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Effective Date</label>
                <input
                  type="date"
                  value={houseRulesEffectiveDate}
                  onChange={e => { setHouseRulesEffectiveDate(e.target.value); setHouseRulesMsg('') }}
                  disabled={isReadOnly || houseRulesBusy}
                  style={{
                    display:'block', width:'100%', marginTop:'6px', marginBottom:'6px',
                    padding:'9px 10px',
                    background: (isReadOnly || houseRulesBusy) ? '#1a1a2a' : '#1e2535',
                    border:'1px solid #3a4055', borderRadius:'6px',
                    color: (isReadOnly || houseRulesBusy) ? '#555' : 'white',
                    fontSize:'13px', boxSizing:'border-box', outline:'none',
                  }}
                />
                <p style={{ color:'#7a8394', fontSize:'11px', margin:'0 0 12px', lineHeight:'1.5', fontStyle:'italic' }}>
                  If your property is subject to notice-of-change requirements, set the effective date to
                  give residents advance notice per your lease terms and applicable law. Defaults to today.
                </p>

                {/* 🔴 2026-08-20 Commit 2b — LIVE PREVIEW.
                    The durable fix for the paste-lost-line-breaks class
                    (Mateo Aug 20 finding). A manager pastes from a PDF,
                    immediately sees a wall of text in this preview,
                    adds breaks, saves something readable. Self-corrects
                    at authoring time.

                    Shares the render treatment with the resident view
                    via HouseRulesRenderer — if they drift, the preview
                    stops being a preview (Mateo). No metadata line and
                    no reference caveat here — the manager already sees
                    the effective-date input + caveat above and doesn't
                    need to be told what they're writing isn't
                    ShieldMyLot policy. Collapsible=false so the manager
                    sees the WHOLE thing (wall of text signals a problem
                    only if you can see the whole wall). */}
                {houseRulesDraft.trim().length > 0 && (
                  <div style={{
                    background:'#0f1117', border:'1px solid #2a2f3d',
                    borderRadius:'8px', padding:'12px', marginBottom:'12px',
                  }}>
                    <p style={{ color:'#7a8394', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 8px', fontWeight:'bold' }}>
                      Preview — as residents will see it
                    </p>
                    <HouseRulesRenderer text={houseRulesDraft} />
                  </div>
                )}

                {!isReadOnly && (
                  <button
                    onClick={saveHouseRules}
                    disabled={houseRulesBusy}
                    style={{
                      width:'100%', padding:'10px',
                      background: houseRulesBusy ? '#333' : '#C9A227',
                      color: houseRulesBusy ? '#666' : '#0f1117',
                      fontWeight:'bold', fontSize:'13px',
                      border:'none', borderRadius:'8px',
                      cursor: houseRulesBusy ? 'wait' : 'pointer',
                    }}>
                    {houseRulesBusy
                      ? 'Saving…'
                      : (houseRulesDraft.trim().length === 0 && manager.house_rules_text
                        ? 'Save (unpublishes rules)'
                        : 'Save House Rules')}
                  </button>
                )}
                {houseRulesMsg && (
                  <p style={{ color: houseRulesMsg.startsWith('Error') ? '#f44336' : '#4caf50', fontSize:'12px', margin:'10px 0 0' }}>{houseRulesMsg}</p>
                )}
              </div>
            )}

            {/* Section B — Registration QR */}
            {manager && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'14px' }}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 4px' }}>New Resident Registration Link</p>
                <p style={{ color:'#555', fontSize:'12px', margin:'0 0 16px', lineHeight:'1.5' }}>Share this QR code or link with new residents to allow them to self-register. Their account will require your approval before they can log in.</p>
                {(() => {
                  const regUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'}/register?property=${encodeURIComponent(manager.name)}${managerCompany ? `&company=${encodeURIComponent(managerCompany)}` : ''}`
                  return (
                    <>
                      <div id="qr-registration" style={{ display:'flex', justifyContent:'center', marginBottom:'12px' }}>
                        <QRCodeCanvas value={regUrl} size={160} level="H" />
                      </div>
                      <QRLinkAffordance url={regUrl} />
                      {/* 2026-07-16 QR consolidation — was an inline
                          tw.document.write template. Now shares printQRSign
                          with the CA portal via app/lib/qr-print.ts. Manager
                          gets identical branded resident-signup sign
                          (Resident Registration header, no tow-warning,
                          fallback URL). */}
                      <button onClick={() => printQRSign({
                        canvasId: 'qr-registration',
                        title: manager.name,
                        subtitle: 'New resident self-registration',
                        kind: 'resident',
                        url: regUrl,
                        company: managerCompany || undefined,
                      })} style={{ width:'100%', padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                        Print QR Code
                      </button>
                    </>
                  )
                })()}
              </div>
            )}

            {/* 2026-07-02 (per-screen polish #6) — Visitor-Pass QR
                for the property manager to print and post on-site.
                Reuses the CA QR pattern (QRCodeCanvas + print-window
                open) property-scoped to the manager's assigned
                property. Points at /visitor?property=<name> — the
                same URL a CA would generate for the same property. */}
            {manager && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'14px' }}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 4px' }}>Visitor Pass QR</p>
                <p style={{ color:'#555', fontSize:'12px', margin:'0 0 16px', lineHeight:'1.5' }}>Print this and post it on-site so visitors can self-issue a pass at your property. Property-scoped — passes generated here land on this property.</p>
                {(() => {
                  const visitorUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'}/visitor?property=${encodeURIComponent(manager.name)}`
                  return (
                    <>
                      <div id="qr-visitor-pass" style={{ display:'flex', justifyContent:'center', marginBottom:'12px' }}>
                        <QRCodeCanvas value={visitorUrl} size={160} level="H" />
                      </div>
                      <QRLinkAffordance url={visitorUrl} />
                      {/* 2026-07-16 QR consolidation — shared printQRSign.
                          Same branded visitor sign the CA portal prints
                          (Visitor Parking header + "Valid up to 24 hours"
                          note + tow-warning + fallback URL). */}
                      <button onClick={() => printQRSign({
                        canvasId: 'qr-visitor-pass',
                        title: manager.name,
                        subtitle: 'Print this and post on-site',
                        kind: 'visitor',
                        url: visitorUrl,
                        company: managerCompany || undefined,
                      })} style={{ width:'100%', padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                        Print QR Code
                      </button>
                    </>
                  )
                })()}
              </div>
            )}

            {/* Section C — Visitor Pass Quota Exemptions
                Formerly labeled "Exempt Plates" — that name misled property
                owners into thinking these plates were protected from
                towing. They are NOT — this feature only skips the annual
                visitor-pass cap. See "Do Not Tow" (separate feature) for
                actual tow protection. Column name exempt_plates preserved
                for backwards-compat; UI reframed 2026-07-23 to remove
                ambiguity that caused wrongful-tow risk. */}
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 4px' }}>Visitor Pass Quota Exemptions</p>
              <p style={{ color:'#555', fontSize:'12px', margin:'0 0 14px', lineHeight:'1.5' }}>Plates on this list are never counted against the visitor pass limit — use it for regular visitors (caregivers, family, service providers) who would otherwise exceed the rolling 30-day cap. <strong style={{ color:'#f59e0b' }}>This does NOT protect the vehicle from being towed.</strong> Vehicles still need an active visitor pass, resident registration, or guest authorization to avoid enforcement.</p>

              {exemptPlates.length === 0 ? (
                <p style={{ color:'#555', fontSize:'12px', margin:'0 0 14px' }}>No quota exemptions configured yet.</p>
              ) : (
                <div style={{ marginBottom:'14px' }}>
                  {exemptPlates.map(plate => (
                    <div key={plate} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 10px', background:'#1e2535', borderRadius:'6px', marginBottom:'6px' }}>
                      <span style={{ color:'white', fontFamily:'Courier New', fontSize:'14px', fontWeight:'bold', letterSpacing:'0.08em' }}>{plate}</span>
                      {!isReadOnly && (
                        <button onClick={() => removeExemptPlate(plate)}
                          style={{ padding:'3px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'5px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {!isReadOnly && (
                <div style={{ display:'flex', gap:'8px' }}>
                  <input
                    value={newExemptPlate}
                    onChange={e => setNewExemptPlate(e.target.value.toUpperCase())}
                    onKeyDown={e => e.key === 'Enter' && addExemptPlate()}
                    placeholder="ABC1234"
                    style={{ flex:1, padding:'9px 10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px', fontFamily:'Courier New', fontWeight:'bold', outline:'none', boxSizing:'border-box' as const }}
                  />
                  <button onClick={addExemptPlate}
                    style={{ padding:'9px 16px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>
                    Add
                  </button>
                </div>
              )}
            </div>

            {/* AP-UI-REFINE (2026-07-24): Authorized Plates section
                REMOVED from Settings tab — moved to its own tab
                adjacent to Authorized Guests. Two entry points to one
                list is how they drift (Mateo). */}
          </div>
        )}

        {/* ACTIVITY LOG */}
        {activeTab === 'activity' && (() => {
          const today = new Date(); today.setHours(0,0,0,0)
          const week = new Date(); week.setDate(week.getDate()-7)
          const filtered = auditLogs.filter(log => {
            const d = new Date(log.created_at)
            const inPeriod = auditDateFilter === 'today' ? d >= today : auditDateFilter === 'week' ? d >= week : true
            if (!inPeriod) return false
            if (!auditSearch) return true
            const q = auditSearch.toLowerCase()
            return (log.user_email || '').toLowerCase().includes(q) ||
              (log.action || '').toLowerCase().includes(q) ||
              JSON.stringify(log.new_values || {}).toLowerCase().includes(q)
          })
          return (
            <div>
              <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'10px' }}>
                {[{k:'today',l:'Today'},{k:'week',l:'This Week'},{k:'all',l:'All'}].map(f => (
                  <button key={f.k} onClick={() => setAuditDateFilter(f.k)}
                    style={{ flex:1, padding:'7px', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', background: auditDateFilter === f.k ? '#C9A227' : 'transparent', color: auditDateFilter === f.k ? '#0f1117' : '#888', fontFamily:'Arial' }}>
                    {f.l}
                  </button>
                ))}
              </div>
              <input value={auditSearch} onChange={e => setAuditSearch(e.target.value)} placeholder="Search email, action..." style={{ ...inputStyle, marginBottom:'10px' }} />
              {!auditLoaded ? (
                <p style={{ color:'#555', fontSize:'13px', textAlign:'center', margin:'32px 0' }}>Loading...</p>
              ) : filtered.length === 0 ? (
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                  <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No activity for this period</p>
                </div>
              ) : filtered.map((log, i) => {
                const vals = log.new_values ? Object.entries(log.new_values).filter(([k]) => k !== 'property').map(([k,v]) => `${k}: ${v}`).join(' · ') : ''
                return (
                  <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', marginBottom:'8px' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'6px' }}>
                      <span style={{ background:'#1e1800', color:'#C9A227', padding:'2px 8px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold', letterSpacing:'0.04em' }}>{log.action}</span>
                      <span style={{ color:'#888', fontSize:'10px' }}>{formatTimestamp(log.created_at)}</span>
                    </div>
                    <p style={{ color:'#aaa', fontSize:'11px', margin:'0 0 2px' }}>{log.user_email}</p>
                    {vals && <p style={{ color:'#888', fontSize:'11px', margin:'0', fontFamily:'Courier New' }}>{vals}</p>}
                  </div>
                )
              })}
            </div>
          )
        })()}

        {/* B70: PLATE LOOKUP tab — read-only plate search scoped to the
            caller's properties. The RPC enforces scoping + audit write
            server-side; UI just surfaces the minimum-leak response. */}
        {activeTab === 'plate-lookup' && (
          <div>
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0 0 4px' }}>Look up a plate</p>
              <p style={{ color:'#888', fontSize:'12px', margin:'0 0 14px', lineHeight:'1.5' }}>
                Search for a license plate against active residents and visitor passes on your property. Read-only — no enforcement actions from this surface.
              </p>
              <div style={{ display:'flex', gap:'8px' }}>
                <input
                  value={lookupPlate}
                  onChange={e => setLookupPlate(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !lookupBusy) runPlateLookup() }}
                  placeholder="ABC-123 or ABC 123"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  style={{ ...inputStyle, flex:1, fontFamily:'Courier New', textTransform:'uppercase' }}
                />
                <button
                  onClick={runPlateLookup}
                  disabled={lookupBusy || !lookupPlate.trim()}
                  style={{ padding:'10px 18px', background: (lookupBusy || !lookupPlate.trim()) ? '#555' : '#C9A227', color: (lookupBusy || !lookupPlate.trim()) ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor: (lookupBusy || !lookupPlate.trim()) ? 'not-allowed' : 'pointer', fontFamily:'Arial' }}>
                  {lookupBusy ? 'Looking up…' : 'Look up'}
                </button>
              </div>
              {lookupError && (
                <p style={{ color:'#f44336', fontSize:'12px', margin:'10px 0 0' }}>{lookupError}</p>
              )}
            </div>

            {lookupResult && lookupResult.result_type === 'resident' && (
              <div style={{ background:'#0f2218', border:'1px solid #1f5938', borderRadius:'10px', padding:'18px' }}>
                <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px' }}>Result for</p>
                <p style={{ color:'#86efac', fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0 0 14px' }}>{lookupResult.queriedPlate}</p>
                <div style={{ display:'flex', alignItems:'center', gap:'12px' }}>
                  <div style={{ width:'40px', height:'40px', borderRadius:'50%', background:'#1a3a1a', border:'1px solid #4caf50', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'18px' }}>✓</div>
                  <div>
                    <p style={{ color:'#4caf50', fontSize:'14px', fontWeight:'bold', margin:'0' }}>Active resident</p>
                    <p style={{ color:'#aaa', fontSize:'13px', margin:'2px 0 0' }}>Unit {lookupResult.unit_number || '—'}</p>
                  </div>
                </div>
              </div>
            )}

            {/* AP-CASCADE branch 1.5 result — standing authorization
                (staff/vendor). Mirrors resident card shape per Jose's spec
                ("behaves like a resident"). Label is portal-only (RPC
                returns ap_label for manager/CA/admin; NULL for driver).
                Missing this render case leaves forcee@ (multi-property
                manager) with a blank card when a plate is authorized at
                one of their assigned properties. */}
            {lookupResult && lookupResult.result_type === 'authorized_plate' && (
              <div style={{ background:'#0f2218', border:'1px solid #1f5938', borderRadius:'10px', padding:'18px' }}>
                <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px' }}>Result for</p>
                <p style={{ color:'#86efac', fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0 0 14px' }}>{lookupResult.queriedPlate}</p>
                <div style={{ display:'flex', alignItems:'center', gap:'12px' }}>
                  <div style={{ width:'40px', height:'40px', borderRadius:'50%', background:'#1a3a1a', border:'1px solid #4caf50', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'18px' }}>✓</div>
                  <div>
                    <p style={{ color:'#4caf50', fontSize:'14px', fontWeight:'bold', margin:'0' }}>Authorized</p>
                    {lookupResult.ap_property_name && (
                      <p style={{ color:'#aaa', fontSize:'13px', margin:'2px 0 0' }}>{lookupResult.ap_property_name}</p>
                    )}
                  </div>
                </div>
                {lookupResult.ap_label && (
                  <div style={{ marginTop:'12px', padding:'10px 12px', background:'#0a1a0a', border:'1px solid #1e3a1e', borderRadius:'8px' }}>
                    <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 3px' }}>Label (portal-only)</p>
                    <p style={{ color:'#aaa', fontSize:'13px', fontStyle:'italic', margin:'0', wordBreak:'break-word' }}>{lookupResult.ap_label}</p>
                  </div>
                )}
              </div>
            )}

            {lookupResult && lookupResult.result_type === 'visitor' && (
              <div style={{ background:'#1f1a00', border:'1px solid #5a4a00', borderRadius:'10px', padding:'18px' }}>
                <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px' }}>Result for</p>
                <p style={{ color:'#f59e0b', fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0 0 14px' }}>{lookupResult.queriedPlate}</p>
                <div style={{ display:'flex', alignItems:'center', gap:'12px' }}>
                  <div style={{ width:'40px', height:'40px', borderRadius:'50%', background:'#3a2a00', border:'1px solid #f59e0b', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'18px' }}>🎫</div>
                  <div>
                    <p style={{ color:'#f59e0b', fontSize:'14px', fontWeight:'bold', margin:'0' }}>Active visitor pass</p>
                    {lookupResult.unit_number && (
                      <p style={{ color:'#aaa', fontSize:'13px', margin:'2px 0 0' }}>Visiting Unit {lookupResult.unit_number}</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* B220 (2026-06-26) — guest_authorized result. Blue tone to
                distinguish from green (resident) / gold (visitor) / red
                (unauthorized). Oversight, not enforcement — info card
                with date + guest + unit; no DO-NOT-TOW banner (that's
                the driver surface). guest_name + valid_through come from
                the pm_plate_lookup RPC's new return fields. */}
            {lookupResult && lookupResult.result_type === 'guest_authorized' && (
              <div style={{ background:'#0a1628', border:'1px solid #1e3a5f', borderRadius:'10px', padding:'18px' }}>
                <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px' }}>Result for</p>
                <p style={{ color:'#7ab1ff', fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0 0 14px' }}>{lookupResult.queriedPlate}</p>
                <div style={{ display:'flex', alignItems:'center', gap:'12px', marginBottom:'12px' }}>
                  <div style={{ width:'40px', height:'40px', borderRadius:'50%', background:'#1e3a5f', border:'1px solid #3b82f6', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'18px' }}>✓</div>
                  <div>
                    <p style={{ color:'#7ab1ff', fontSize:'14px', fontWeight:'bold', margin:'0' }}>Authorized guest</p>
                    {lookupResult.valid_through && (
                      <p style={{ color:'#cbd5e1', fontSize:'13px', margin:'2px 0 0' }}>
                        Valid through <strong>{formatDate(lookupResult.valid_through)}</strong>
                      </p>
                    )}
                  </div>
                </div>
                {(lookupResult.guest_name || lookupResult.unit_number) && (
                  <div style={{ background:'#0f1f3a', border:'1px solid #1e3a5f', borderRadius:'8px', padding:'10px 12px' }}>
                    {lookupResult.guest_name && (
                      <p style={{ color:'#94a3b8', fontSize:'11px', margin:'0' }}>
                        <span style={{ color:'#64748b', textTransform:'uppercase', letterSpacing:'0.06em', fontSize:'10px' }}>Authorized for</span><br />
                        <span style={{ color:'#cbd5e1', fontSize:'13px' }}>{lookupResult.guest_name}</span>
                      </p>
                    )}
                    {lookupResult.unit_number && (
                      <p style={{ color:'#94a3b8', fontSize:'11px', margin: lookupResult.guest_name ? '8px 0 0' : '0' }}>
                        <span style={{ color:'#64748b', textTransform:'uppercase', letterSpacing:'0.06em', fontSize:'10px' }}>Visiting Unit</span><br />
                        <span style={{ color:'#cbd5e1', fontSize:'13px' }}>{lookupResult.unit_number}</span>
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* B230 Part B — pending permit (do-not-tow oversight).
                Same shared amber palette as plate_under_review; distinct
                copy: this is a resident whose permit approval is pending,
                not a plate change. Load-bearing invariant: MUST NOT be
                bucketed under "not authorized" or PMs verbally relay the
                wrong state to the tow operator. */}
            {lookupResult && lookupResult.result_type === 'pending' && (() => {
              const meta = PLATE_STATUS_META['pending' as PlateStatus]
              return (
                <div style={{ background: meta.bg, border: `1px solid ${meta.border}`, borderRadius:'10px', padding:'18px' }}>
                  <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px' }}>Result for</p>
                  <p style={{ color: meta.color, fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0 0 14px' }}>{lookupResult.queriedPlate}</p>
                  <div style={{ display:'flex', alignItems:'center', gap:'12px', marginBottom:'12px' }}>
                    <div style={{ width:'40px', height:'40px', borderRadius:'50%', background: meta.bg, border:`1px solid ${meta.border}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'18px' }}>⏳</div>
                    <div>
                      <p style={{ color: meta.color, fontSize:'14px', fontWeight:'bold', margin:'0' }}>{meta.pmHeadline}</p>
                      {lookupResult.unit_number && (
                        <p style={{ color:'#aaa', fontSize:'13px', margin:'2px 0 0' }}>Unit {lookupResult.unit_number}</p>
                      )}
                    </div>
                  </div>
                  <p style={{ color:'#fef3c7', fontSize:'12.5px', margin:'0', lineHeight:'1.5' }}>{meta.pmSubtitle}</p>
                </div>
              )
            })()}

            {/* B230 Part B — plate change under review (do-not-tow
                oversight). Resident has submitted a plate change that's
                awaiting your decision. Same amber palette as pending;
                different copy focuses on the plate-change context. */}
            {lookupResult && lookupResult.result_type === 'plate_under_review' && (() => {
              const meta = PLATE_STATUS_META['plate_under_review' as PlateStatus]
              return (
                <div style={{ background: meta.bg, border: `1px solid ${meta.border}`, borderRadius:'10px', padding:'18px' }}>
                  <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px' }}>Result for</p>
                  <p style={{ color: meta.color, fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0 0 14px' }}>{lookupResult.queriedPlate}</p>
                  <div style={{ display:'flex', alignItems:'center', gap:'12px', marginBottom:'12px' }}>
                    <div style={{ width:'40px', height:'40px', borderRadius:'50%', background: meta.bg, border:`1px solid ${meta.border}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'18px' }}>🔁</div>
                    <div>
                      <p style={{ color: meta.color, fontSize:'14px', fontWeight:'bold', margin:'0' }}>{meta.pmHeadline}</p>
                      {lookupResult.unit_number && (
                        <p style={{ color:'#aaa', fontSize:'13px', margin:'2px 0 0' }}>Unit {lookupResult.unit_number}</p>
                      )}
                    </div>
                  </div>
                  <p style={{ color:'#fef3c7', fontSize:'12.5px', margin:'0', lineHeight:'1.5' }}>{meta.pmSubtitle}</p>
                </div>
              )
            })()}

            {lookupResult && lookupResult.result_type === 'unauthorized' && (
              <div style={{ background:'#2a1a1a', border:'1px solid #7a2222', borderRadius:'10px', padding:'18px' }}>
                <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px' }}>Result for</p>
                <p style={{ color:'#f87171', fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0 0 14px' }}>{lookupResult.queriedPlate}</p>
                <div style={{ display:'flex', alignItems:'center', gap:'12px' }}>
                  <div style={{ width:'40px', height:'40px', borderRadius:'50%', background:'#3a1a1a', border:'1px solid #f44336', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'18px' }}>⚠️</div>
                  <div>
                    <p style={{ color:'#f44336', fontSize:'14px', fontWeight:'bold', margin:'0' }}>Unauthorized</p>
                    <p style={{ color:'#888', fontSize:'12px', margin:'2px 0 0' }}>No active resident or visitor pass on your property.</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* VISITORS */}
        {activeTab === 'visitors' && (
          <div>
            {/* 2026-08-08 — Visitor-pass at-cap V1 (read-only).
                Rendered ONLY when the property has a visitor_pass_limit
                configured AND at least one plate is at cap. Zero-state
                (limit set but no plates at cap) and no-limit-set both
                render nothing — the manager only sees this section when
                there's something to look at. The trigger's short-circuit
                on exempt plates is mirrored in fetchAtCapData; a plate
                the trigger will let through is never surfaced here. */}
            {atCapList && atCapList.entries.length > 0 && (
              <div style={{ background:'#161b26', border:'1px solid #a16207', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                <p style={{ color:'#fbbf24', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 4px', fontWeight:'bold' }}>
                  Plates at visitor pass cap
                </p>
                <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 12px', lineHeight:'1.5' }}>
                  Limit: <strong style={{ color:'#fbbf24' }}>{atCapList.limit}</strong> passes per plate per 30 days at {manager?.name}.
                  Visitors on these plates see: <em>&ldquo;This vehicle has already been issued N visitor passes at this property in the last 30 days. Contact the property manager if you need access.&rdquo;</em>
                </p>
                {atCapList.entries.map(e => {
                  const isExpanded = expandedAtCapPlate === e.normalizedPlate
                  const overCap = e.count > e.limit
                  return (
                    <div key={e.normalizedPlate} style={{ background:'#0f1620', border:'1px solid #2a2f3d', borderRadius:'8px', marginBottom:'8px' }}>
                      <button
                        type="button"
                        onClick={() => setExpandedAtCapPlate(isExpanded ? null : e.normalizedPlate)}
                        style={{ width:'100%', textAlign:'left', background:'transparent', border:'none', color:'inherit', cursor:'pointer', padding:'12px 14px', fontFamily:'Arial', display:'block' }}
                      >
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'4px' }}>
                          <p style={{ color:'#fbbf24', fontFamily:'Courier New', fontSize:'17px', fontWeight:'bold', margin:'0', letterSpacing:'0.08em' }}>{e.displayPlate}</p>
                          <span style={{ color:'#888', fontSize:'11px' }}>{isExpanded ? '▼' : '▸'}</span>
                        </div>
                        <p style={{ color:'#aaa', fontSize:'12px', margin:'0' }}>
                          <strong style={{ color:'white' }}>{e.count} of {e.limit}</strong>
                          {overCap && <span style={{ color:'#f59e0b', marginLeft:'6px' }}>· over the limit</span>}
                          <span style={{ color:'#555', margin:'0 6px' }}>·</span>
                          Eligible again <strong style={{ color:'#4caf50' }}>{formatDate(e.eligibleAt)}</strong>
                        </p>
                      </button>
                      {isExpanded && (
                        <div style={{ borderTop:'1px solid #2a2f3d', padding:'10px 14px' }}>
                          <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 8px' }}>
                            Passes in the last 30 days · oldest first
                          </p>
                          {e.passes.map((p, i) => (
                            <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom: i === e.passes.length - 1 ? 'none' : '1px solid #1e2535' }}>
                              <div style={{ minWidth:0, flex:1 }}>
                                <p style={{ color:'white', fontSize:'12px', margin:'0' }}>
                                  {formatTimestamp(p.created_at)}
                                  {!p.is_active && <span style={{ color:'#888', marginLeft:'8px', fontStyle:'italic' }}>(revoked)</span>}
                                </p>
                                <p style={{ color:'#888', fontSize:'11px', margin:'2px 0 0' }}>
                                  Unit: <span style={{ color:'#aaa' }}>{p.visiting_unit || '—'}</span>
                                  {p.visitor_name && <><span style={{ color:'#555', margin:'0 6px' }}>·</span>Visitor: <span style={{ color:'#aaa' }}>{p.visitor_name}</span></>}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                <p style={{ color:'#555', fontSize:'11px', margin:'12px 0 0', lineHeight:'1.5', fontStyle:'italic' }}>
                  To grant additional visits sooner, add the plate to your Visitor Pass Quota Exemptions in Settings.
                  Exemptions are <strong>permanent and uncounted</strong> — a plate you exempt once is exempt from all future cap enforcement at this property. A per-conversation reset is planned for a future release.
                </p>
              </div>
            )}
            {passes.length === 0
              ? <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}><p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No active visitor passes</p></div>
              : passes.map((p,i) => (
                <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'8px' }}>
                    <p style={{ color:'#f59e0b', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{p.plate}</p>
                    <span style={{ background:'#1a3a1a', color:'#4caf50', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold' }}>Active</span>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px', fontSize:'12px' }}>
                    <div><span style={{ color:'#555' }}>Visiting</span><br/><span style={{ color:'#aaa' }}>{p.visiting_unit}</span></div>
                    <div><span style={{ color:'#555' }}>Visitor</span><br/><span style={{ color:'#aaa' }}>{p.visitor_name || '—'}</span></div>
                    <div><span style={{ color:'#555' }}>Vehicle</span><br/><span style={{ color:'#aaa' }}>{p.vehicle_desc || '—'}</span></div>
                    <div><span style={{ color:'#555' }}>Duration</span><br/><span style={{ color:'#aaa' }}>{p.duration_hours} hours</span></div>
                    <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555' }}>Expires</span><br/><span style={{ color:'#f59e0b' }}>{formatTimestamp(p.expires_at)}</span></div>
                  </div>
                </div>
              ))
            }
          </div>
        )}


        {/* AUTHORIZED PLATES (AP-UI-REFINE 2026-07-24) — standing
            authorization for staff, vendors, and contractors. Tab lives
            adjacent to Authorized Guests. Component owns search + sort
            + category filter + add/remove; page provides property scope
            via manager.id / manager.name from the VIEWING PROPERTY
            selector. onCountChange keeps the tab badge in sync. */}
        {activeTab === 'authorized-plates' && manager?.id && manager?.name && (
          <AuthorizedPlatesManager
            propertyId={manager.id}
            propertyName={manager.name}
            onCountChange={setApCount}
          />
        )}

        {/* AUTHORIZED GUESTS (B214) — manager-vetted multi-week vehicle authorizations.
            Two visible sub-sections: (1) collapsible "+ New" create form with overlap
            soft-warning, (2) active list with renew/revoke per card. */}
        {activeTab === 'guest-auth' && (
          <div>
            {/* HEADER + NEW BUTTON */}
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'10px' }}>
              <p style={{ color:'#888', fontSize:'12px', margin:'0' }}>Multi-week guest authorizations for {manager?.name}. Auto-expire on end date.</p>
              <button onClick={() => setShowAddGuestAuth(s => !s)}
                style={{ padding:'7px 13px', background:'#C9A227', color:'#0f1117', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                {showAddGuestAuth ? '× Close' : '+ New Authorization'}
              </button>
            </div>

            {/* CREATE FORM */}
            {showAddGuestAuth && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                <p style={{ color:'#C9A227', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 12px', fontWeight:'bold' }}>New guest authorization</p>

                <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>Guest name *</label>
                <input value={newGuestAuth.guest_name} onChange={e => setNewGuestAuth({ ...newGuestAuth, guest_name: e.target.value })} style={inputStyle} placeholder="Sarah Chen" />

                <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:'10px' }}>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>Plate *</label>
                    <input value={newGuestAuth.plate}
                      onChange={e => setNewGuestAuth({ ...newGuestAuth, plate: e.target.value.toUpperCase() })}
                      onBlur={() => { setNewGuestAuth(n => ({ ...n, plate: normalizePlate(n.plate) })); checkGuestAuthOverlap() }}
                      style={{ ...inputStyle, fontFamily:'Courier New' }} placeholder="ABC1234" />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>State</label>
                    <input value={newGuestAuth.state} onChange={e => setNewGuestAuth({ ...newGuestAuth, state: e.target.value.toUpperCase().slice(0, 2) })} style={inputStyle} maxLength={2} />
                  </div>
                </div>

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'10px' }}>
                  <div><label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>Make</label><input value={newGuestAuth.make} onChange={e => setNewGuestAuth({ ...newGuestAuth, make: e.target.value })} style={inputStyle} placeholder="Toyota" /></div>
                  <div><label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>Model</label><input value={newGuestAuth.model} onChange={e => setNewGuestAuth({ ...newGuestAuth, model: e.target.value })} style={inputStyle} placeholder="Camry" /></div>
                  <div><label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>Color</label><input value={newGuestAuth.color} onChange={e => setNewGuestAuth({ ...newGuestAuth, color: e.target.value })} style={inputStyle} placeholder="Silver" /></div>
                </div>

                {/* Visiting type toggle */}
                <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>Authorization type</label>
                <div style={{ display:'flex', gap:'8px', marginTop:'6px', marginBottom:'10px' }}>
                  <button type="button" onClick={() => setNewGuestAuth({ ...newGuestAuth, visiting_type: 'resident' })}
                    style={{ flex:1, padding:'8px', background: newGuestAuth.visiting_type === 'resident' ? '#C9A227' : '#1e2535', color: newGuestAuth.visiting_type === 'resident' ? '#0f1117' : '#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                    Resident's guest
                  </button>
                  <button type="button" onClick={() => setNewGuestAuth({ ...newGuestAuth, visiting_type: 'non_resident' })}
                    style={{ flex:1, padding:'8px', background: newGuestAuth.visiting_type === 'non_resident' ? '#C9A227' : '#1e2535', color: newGuestAuth.visiting_type === 'non_resident' ? '#0f1117' : '#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                    Non-resident (vendor / contractor)
                  </button>
                </div>

                {newGuestAuth.visiting_type === 'resident' && (
                  <>
                    <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>Visiting unit *</label>
                    <select value={newGuestAuth.visiting_unit}
                      onChange={e => {
                        const u = e.target.value
                        // Auto-pick the resident's email if there's exactly one at this unit.
                        const atUnit = residents.filter(r => r.unit === u && r.is_active !== false)
                        const email = atUnit.length === 1 ? atUnit[0].email : ''
                        setNewGuestAuth({ ...newGuestAuth, visiting_unit: u, resident_email: email })
                      }}
                      style={inputStyle}>
                      <option value=''>— Select unit —</option>
                      {/* Unique active-resident units, sorted */}
                      {/* B221 (2026-06-26): natural-numeric sort so unit "10"
                          doesn't sort before "2". Inline Intl.Collator-equivalent
                          via localeCompare with numeric:true; null-safe via ?? ''.
                          Sister site: company_admin/page.tsx (CA guest-auth form). */}
                      {Array.from(new Set(residents.filter(r => r.is_active !== false).map(r => r.unit))).sort((a, b) => (a ?? '').localeCompare(b ?? '', undefined, { numeric: true, sensitivity: 'base' })).map(u => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                    </select>
                    {/* If multiple residents at the chosen unit, force a pick */}
                    {newGuestAuth.visiting_unit && residents.filter(r => r.unit === newGuestAuth.visiting_unit && r.is_active !== false).length > 1 && (
                      <>
                        <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>Hosting resident *</label>
                        <select value={newGuestAuth.resident_email}
                          onChange={e => setNewGuestAuth({ ...newGuestAuth, resident_email: e.target.value })} style={inputStyle}>
                          <option value=''>— Select resident —</option>
                          {residents.filter(r => r.unit === newGuestAuth.visiting_unit && r.is_active !== false).map(r => (
                            <option key={r.email} value={r.email}>{r.name || r.email} ({r.email})</option>
                          ))}
                        </select>
                      </>
                    )}
                  </>
                )}

                {newGuestAuth.visiting_type === 'non_resident' && (
                  <>
                    <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>Reason *</label>
                    <textarea value={newGuestAuth.non_resident_reason} onChange={e => setNewGuestAuth({ ...newGuestAuth, non_resident_reason: e.target.value })}
                      placeholder="e.g., HVAC contractor — weekly service; Property landscaper — May-July contract"
                      style={{ ...inputStyle, minHeight:'60px', resize:'vertical', fontFamily:'Arial' }} />
                  </>
                )}

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px' }}>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>Start date *</label>
                    <input type="date" value={newGuestAuth.start_date}
                      min={todayIso()}
                      onChange={e => { setNewGuestAuth({ ...newGuestAuth, start_date: e.target.value }); setGuestAuthOverlapWarning(null) }}
                      onBlur={checkGuestAuthOverlap}
                      style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>End date *</label>
                    <input type="date" value={newGuestAuth.end_date}
                      min={newGuestAuth.start_date || todayIso()}
                      max={newGuestAuth.start_date ? addDays(newGuestAuth.start_date, GUEST_AUTH_MAX_DAYS) : undefined}
                      onChange={e => { setNewGuestAuth({ ...newGuestAuth, end_date: e.target.value }); setGuestAuthOverlapWarning(null) }}
                      onBlur={checkGuestAuthOverlap}
                      style={inputStyle} />
                  </div>
                </div>
                <p style={{ color:'#555', fontSize:'10px', margin:'0 0 10px' }}>Maximum {GUEST_AUTH_MAX_DAYS} days per grant. Use Renew for longer stays (preserves audit chain).</p>

                {/* OVERLAP SOFT-WARNING (Finding 2 from B214 preflight). Non-blocking;
                    surfaces an existing active auth so the manager confirms intent.
                    Does NOT prevent submit — overlap can be legit (a guest's car at
                    the same plate has a new owner mid-stay, etc.). */}
                {guestAuthOverlapWarning && (
                  <div style={{ background:'#3a2a08', border:'1px solid #f59e0b', borderRadius:'8px', padding:'10px 12px', marginBottom:'10px' }}>
                    <p style={{ color:'#fbbf24', fontSize:'12px', margin:'0 0 4px', fontWeight:'bold' }}>⚠ Overlapping active authorization</p>
                    <p style={{ color:'#fde68a', fontSize:'11px', margin:'0', lineHeight:'1.5' }}>
                      An active authorization for plate <strong>{guestAuthOverlapWarning.plate}</strong> at this property already exists (guest: {guestAuthOverlapWarning.guest_name}, through {guestAuthOverlapWarning.end_date}). Submitting this form will create a second authorization alongside it.
                    </p>
                  </div>
                )}

                {guestAuthError && (
                  <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'8px', padding:'10px 12px', marginBottom:'10px' }}>
                    <p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{guestAuthError}</p>
                  </div>
                )}

                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={() => { setShowAddGuestAuth(false); setGuestAuthError(''); setGuestAuthOverlapWarning(null) }}
                    style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                    Cancel
                  </button>
                  <button onClick={submitGuestAuth} disabled={guestAuthSubmitting}
                    style={{ flex:1, padding:'10px', background: guestAuthSubmitting ? '#555' : '#C9A227', color: guestAuthSubmitting ? '#888' : '#0f1117', border:'none', borderRadius:'6px', cursor: guestAuthSubmitting ? 'not-allowed' : 'pointer', fontSize:'12px', fontWeight:'bold' }}>
                    {guestAuthSubmitting ? 'Creating…' : 'Create authorization'}
                  </button>
                </div>
              </div>
            )}

            {/* ACTIVE LIST */}
            {/* B222 (2026-06-26): search box — filters by plate, guest name,
                visiting unit, or resident email. Mirrors the existing
                violations search pattern in this file. Empty query = no filter. */}
            {guestAuths.length > 0 && (
              <input
                value={guestAuthSearch}
                onChange={e => setGuestAuthSearch(e.target.value)}
                placeholder="Search plate, guest, unit, resident…"
                style={{ ...inputStyle, marginBottom:'10px', fontSize:'13px' }}
              />
            )}
            {(() => {
              const q = guestAuthSearch.trim().toLowerCase()
              const filteredGuestAuths = q
                ? guestAuths.filter(g => (
                    g.plate?.toLowerCase().includes(q) ||
                    g.guest_name?.toLowerCase().includes(q) ||
                    g.visiting_unit?.toLowerCase().includes(q) ||
                    g.resident_email?.toLowerCase().includes(q)
                  ))
                : guestAuths
              if (guestAuths.length === 0) {
                return (
                  <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                    <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No active guest authorizations</p>
                  </div>
                )
              }
              if (filteredGuestAuths.length === 0) {
                return (
                  <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'24px', textAlign:'center' }}>
                    <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No matches for &ldquo;{guestAuthSearch}&rdquo;</p>
                  </div>
                )
              }
              return filteredGuestAuths.map(g => {
              const expSoon = isExpiringSoon(g.end_date)
              const daysLeft = daysUntilExpiry(g.end_date)
              // COPY-1 (2026-07-04): window-aware label. This panel shows
              // fetchActiveGuestAuths() = status='active' only, so the
              // relevant sub-states are upcoming (future start), active
              // (in window), expired (past — only visible until the
              // fetch refreshes if end_date crosses today mid-session),
              // plus expSoon-in-window highlight.
              const display = guestAuthDisplayStatus(g)
              const pillLabel = expSoon && display.key === 'active'
                ? `Expires in ${daysLeft}d`
                : display.label
              const pillBg = expSoon || display.key === 'upcoming' ? '#3a2a08' : '#0a1628'
              const pillColor = expSoon || display.key === 'upcoming' ? '#fbbf24' : '#3b82f6'
              return (
                <div key={g.id} style={{ background:'#161b26', border:`1px solid ${expSoon ? '#f59e0b' : '#2a2f3d'}`, borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                    <p style={{ color:'#3b82f6', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{g.plate}</p>
                    <span style={{ background: pillBg, color: pillColor, padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold' }}>
                      {pillLabel}
                    </span>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px', fontSize:'12px', marginBottom:'10px' }}>
                    <div><span style={{ color:'#555' }}>Guest</span><br/><span style={{ color:'#aaa' }}>{g.guest_name}</span></div>
                    <div><span style={{ color:'#555' }}>{g.visiting_unit ? 'Visiting Unit' : 'Type'}</span><br/><span style={{ color:'#aaa' }}>{g.visiting_unit || g.non_resident_reason}</span></div>
                    <div><span style={{ color:'#555' }}>From</span><br/><span style={{ color:'#aaa' }}>{g.start_date}</span></div>
                    <div><span style={{ color:'#555' }}>Through</span><br/><span style={{ color: expSoon ? '#fbbf24' : '#3b82f6', fontWeight:'bold' }}>{g.end_date}</span></div>
                    <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555' }}>Approved by</span><br/><span style={{ color:'#888', fontSize:'11px' }}>{g.created_by_email}</span></div>
                  </div>
                  <div style={{ display:'flex', gap:'8px' }}>
                    <button onClick={() => {
                        // Renew default per Jose lock 2026-06-20: new_start = source.end_date
                        // (continuous coverage — no gap where guest is unauthorized).
                        // new_end = new_start + 14 (sensible default, capped at +60 by RPC).
                        setRenewGuestAuthTarget(g)
                        setRenewDates({ start_date: g.end_date, end_date: addDays(g.end_date, 14) })
                        setGuestAuthError('')
                      }}
                      style={{ flex:1, padding:'8px', background:'#1e2535', color:'#3b82f6', border:'1px solid #3b82f6', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                      Renew
                    </button>
                    <button onClick={() => { setRevokeGuestAuthTarget(g); setRevokeReason(''); setGuestAuthError('') }}
                      style={{ flex:1, padding:'8px', background:'#1e2535', color:'#f44336', border:'1px solid #991b1b', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                      Revoke
                    </button>
                  </div>
                </div>
              )
            })
            })()}

            {/* RENEW MODAL — new linked record (preserves audit chain).
                Defaults: new_start = source.end_date (continuous coverage,
                Jose lock 2026-06-20); new_end = source.end_date + 14d. */}
            {renewGuestAuthTarget && (
              <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                <div className="modal-card" style={{ background:'#161b26', border:'1px solid #3b82f6', borderRadius:'14px', padding:'22px', maxWidth:'440px', width:'100%' }}>
                  <p style={{ color:'#3b82f6', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px', fontWeight:'bold' }}>Renew authorization</p>
                  <p style={{ color:'white', fontSize:'14px', margin:'0 0 4px' }}>
                    <strong style={{ fontFamily:'Courier New', color:'#3b82f6' }}>{renewGuestAuthTarget.plate}</strong> — {renewGuestAuthTarget.guest_name}
                  </p>
                  <p style={{ color:'#888', fontSize:'12px', margin:'0 0 14px' }}>Current: {renewGuestAuthTarget.start_date} → {renewGuestAuthTarget.end_date}</p>

                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px' }}>
                    <div>
                      <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>New start *</label>
                      <input type="date" value={renewDates.start_date}
                        onChange={e => setRenewDates({ ...renewDates, start_date: e.target.value })}
                        style={inputStyle} />
                    </div>
                    <div>
                      <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>New end *</label>
                      <input type="date" value={renewDates.end_date}
                        min={renewDates.start_date}
                        max={renewDates.start_date ? addDays(renewDates.start_date, GUEST_AUTH_MAX_DAYS) : undefined}
                        onChange={e => setRenewDates({ ...renewDates, end_date: e.target.value })}
                        style={inputStyle} />
                    </div>
                  </div>
                  <p style={{ color:'#555', fontSize:'10px', margin:'0 0 10px' }}>Defaults to continuous coverage from current end. Max {GUEST_AUTH_MAX_DAYS} days per renewal.</p>

                  {guestAuthError && (
                    <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'8px', padding:'8px 10px', marginBottom:'10px' }}>
                      <p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{guestAuthError}</p>
                    </div>
                  )}

                  <div style={{ display:'flex', gap:'8px' }}>
                    <button onClick={() => { setRenewGuestAuthTarget(null); setGuestAuthError('') }}
                      style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                      Cancel
                    </button>
                    <button onClick={submitRenewGuestAuth}
                      style={{ flex:1, padding:'10px', background:'#3b82f6', color:'white', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                      Renew
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* REVOKE MODAL — soft-required reason (optional in RPC, but
                ergonomically prompted; nothing prevents an empty reason). */}
            {revokeGuestAuthTarget && (
              <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                <div className="modal-card" style={{ background:'#161b26', border:'1px solid #991b1b', borderRadius:'14px', padding:'22px', maxWidth:'440px', width:'100%' }}>
                  <p style={{ color:'#f44336', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px', fontWeight:'bold' }}>Revoke authorization</p>
                  <p style={{ color:'white', fontSize:'14px', margin:'0 0 4px' }}>
                    <strong style={{ fontFamily:'Courier New', color:'#f59e0b' }}>{revokeGuestAuthTarget.plate}</strong> — {revokeGuestAuthTarget.guest_name}
                  </p>
                  <p style={{ color:'#888', fontSize:'12px', margin:'0 0 14px' }}>This immediately strips the vehicle&apos;s authorization. Re-instatement requires a new create or renew.</p>

                  <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.05em' }}>Reason (optional, recorded in audit log)</label>
                  <textarea value={revokeReason} onChange={e => setRevokeReason(e.target.value)}
                    placeholder="e.g., Guest left early; Resident relocated; Vehicle no longer at property"
                    style={{ ...inputStyle, minHeight:'60px', resize:'vertical', fontFamily:'Arial' }} />

                  {guestAuthError && (
                    <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'8px', padding:'8px 10px', marginBottom:'10px' }}>
                      <p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{guestAuthError}</p>
                    </div>
                  )}

                  <div style={{ display:'flex', gap:'8px' }}>
                    <button onClick={() => { setRevokeGuestAuthTarget(null); setRevokeReason(''); setGuestAuthError('') }}
                      style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                      Cancel
                    </button>
                    <button onClick={submitRevokeGuestAuth}
                      style={{ flex:1, padding:'10px', background:'#991b1b', color:'white', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                      Revoke
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}


        {/* B210 (2026-06-24): DISPUTES tab block removed (resident→PM
            dispute flow retired). Historical DISPUTE_* audit_logs rows
            preserved; dispute_requests table intentionally left intact. */}

        {activeTab === 'insights' && (
          <div>
            {/* 2026-08-08 — Warnings panel (V1: manager portal only).
                Detection predicates + copy live in
                app/lib/property-warnings.ts. Empty state = silence
                (no "all clear" — panel becomes furniture if it
                always renders).
                Uses the memoized propertyWarnings (also drives the
                tab badge above).
                CA-portal parity is V2 — CA has no per-property
                residents/vehicles state today (aggregate-only), and
                doubling the fetch shape here would recreate the
                divergence class this panel exists to detect. */}
            <PropertyWarningsPanel
              warnings={propertyWarnings}
              onOpenAddVehicle={(r) => setAddVehicleFor(r)}
              onScrollToPending={(_unit) => setActiveTab('residents')}
            />
            {/* Scroll-to-pending remedy: V1 just switches to the
                Residents tab. The warning row's unit tells the
                manager where to look; scrolling to a specific
                resident within the CRM would require exposing a
                scroll target from PmResidentCrm — deferred to V2 if
                Jose asks for it. */}
            {!insightsLoaded ? (
              <p style={{ color:'#555', textAlign:'center', padding:'40px' }}>Loading insights...</p>
            ) : !mgAnalytics ? null : (
              <>
                {/* Metric cards */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px', marginBottom:'14px' }}>
                  {[
                    { label:'This Month', val:mgAnalytics.thisMonthCount, sub: mgAnalytics.lastMonthCount > 0 ? `${mgAnalytics.thisMonthCount > mgAnalytics.lastMonthCount ? '↑' : '↓'} ${Math.abs(mgAnalytics.thisMonthCount - mgAnalytics.lastMonthCount)} vs last mo` : '—', subColor: mgAnalytics.thisMonthCount > mgAnalytics.lastMonthCount ? '#E24B4A' : '#1D9E75' },
                    { label:'Last Month', val:mgAnalytics.lastMonthCount, sub:'violations', subColor:'#555' },
                    { label:'Vehicle Compliance', val:`${mgAnalytics.complianceRate}%`, sub:'of vehicles registered', subColor:'#555', valColor: mgAnalytics.complianceRate >= 80 ? '#1D9E75' : '#E24B4A' },
                    // B210 (2026-06-24): Dispute Rate insights chip removed (dispute flow retired)
                  ].map((c, i) => (
                    <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px' }}>
                      <p style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 4px' }}>{c.label}</p>
                      <p style={{ color:(c as any).valColor || 'white', fontSize:'26px', fontWeight:'bold', margin:'0', fontFamily:'Arial' }}>{c.val}</p>
                      <p style={{ color:c.subColor, fontSize:'11px', margin:'4px 0 0', fontWeight:c.subColor !== '#555' ? 'bold' : 'normal' }}>{c.sub}</p>
                    </div>
                  ))}
                </div>

                {/* Violations by day of week */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                  <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 12px' }}>Violations by Day of Week</p>
                  <ResponsiveContainer width="100%" height={170}>
                    <BarChart data={mgAnalytics.dayChartData} margin={{ top:4, right:0, left:-20, bottom:0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="name" tick={{ fill:'#888', fontSize:10 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill:'#888', fontSize:10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={{ background:'#1e2535', border:'1px solid #2a2f3d', borderRadius:'8px', fontSize:'11px' }} labelStyle={{ color:'#aaa' }} itemStyle={{ color:'#C9A227' }} />
                      <Bar dataKey="count" name="Violations" radius={[4,4,0,0]}>
                        {mgAnalytics.dayChartData.map((entry: any, i: number) => (
                          <Cell key={i} fill={entry.name === 'Fri' || entry.name === 'Sat' ? '#C9A227' : '#546E7A'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Monthly trend */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                  <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 12px' }}>Monthly Trend (6 Months)</p>
                  <ResponsiveContainer width="100%" height={170}>
                    <LineChart data={mgAnalytics.monthData} margin={{ top:4, right:4, left:-20, bottom:0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="month" tick={{ fill:'#888', fontSize:10 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill:'#888', fontSize:10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={{ background:'#1e2535', border:'1px solid #2a2f3d', borderRadius:'8px', fontSize:'11px' }} labelStyle={{ color:'#aaa' }} itemStyle={{ color:'#C9A227' }} />
                      <Line type="monotone" dataKey="count" stroke="#C9A227" strokeWidth={2} dot={{ fill:'#C9A227', strokeWidth:0, r:3 }} activeDot={{ r:5 }} name="Violations" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Hourly heatmap */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                  <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 12px' }}>Violations by Hour of Day</p>
                  {(() => {
                    const maxH = Math.max(...mgAnalytics.byHour, 1)
                    return (
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(12,1fr)', gap:'3px' }}>
                        {mgAnalytics.byHour.map((count: number, hour: number) => {
                          const intensity = count / maxH
                          const lbl = hour === 0 ? '12a' : hour < 12 ? `${hour}a` : hour === 12 ? '12p' : `${hour - 12}p`
                          return (
                            <div key={hour} title={`${lbl}: ${count} violations`}
                              style={{ background:`rgba(201,162,39,${Math.max(0.07, intensity)})`, borderRadius:'4px', padding:'5px 2px', textAlign:'center' }}>
                              <span style={{ color: intensity > 0.4 ? 'white' : '#555', fontSize:'8px', display:'block', lineHeight:'1.2' }}>{lbl}</span>
                              {count > 0 && <span style={{ color:'white', fontSize:'9px', fontWeight:'bold', display:'block' }}>{count}</span>}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}
                </div>

                {/* Patrol insight */}
                <div style={{ background:'#1a1f2e', border:'1px solid rgba(201,162,39,0.2)', borderRadius:'10px', padding:'14px' }}>
                  <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 8px' }}>📍 Patrol Insight</p>
                  <p style={{ color:'#aaa', fontSize:'13px', margin:'0', lineHeight:'1.6' }}>{mgAnalytics.insight}</p>
                </div>
              </>
            )}
          </div>
        )}

        {!isAdmin && managerCompany && (
          <div style={{ marginTop: 24 }}>
            <SupportContact role={isReadOnly ? 'leasing_agent' : 'manager'} company={managerCompany} />
          </div>
        )}

      </div>
      {credentials && (
        <CredentialsModal email={credentials.email} password={credentials.password} onClose={() => setCredentials(null)} />
      )}
      {/* DEACTIVATE-RESIDENT modal (v1.1) — replaces the old confirm() at
          deactivateResident entry. Pre-loaded co-residents at the target's
          unit; default unchecked. MOUNT MUST BE TAB-INDEPENDENT — its
          trigger (Deactivate button) lives on the Residents tab; the
          earlier mount-inside-spaces-gate was a regression caught
          pre-smoke 2026-06-22. Keep alongside CredentialsModal. */}
      {targetDeactivate && (
        <DeactivateResidentModal
          targetResidentName={targetDeactivate.name}
          targetResidentEmail={targetDeactivate.email}
          targetResidentUnit={targetDeactivate.unit}
          coResidents={targetDeactivate.coResidents}
          isBusy={deactivateBusy}
          onCancel={() => setTargetDeactivate(null)}
          onConfirm={({ reason, note, alsoEmails }) => runDeactivateBatch({ reason, note, alsoEmails })}
        />
      )}
      {targetDeactivateVehicle && (
        <DeactivateVehicleModal
          vehiclePlate={targetDeactivateVehicle.plate}
          vehicleYmm={targetDeactivateVehicle.ymm}
          residentName={targetDeactivateVehicle.residentName}
          residentUnit={targetDeactivateVehicle.residentUnit}
          isBusy={deactivateVehicleBusy}
          onCancel={() => setTargetDeactivateVehicle(null)}
          onConfirm={({ reason, note }) => runOneDeactivateVehicle({ reason, note })}
        />
      )}
      {reapprovalOrphans && (
        <ReapprovalOrphansModal
          residentName={reapprovalOrphans.resident.name ?? ''}
          residentEmail={reapprovalOrphans.resident.email ?? ''}
          residentUnit={reapprovalOrphans.resident.unit ?? ''}
          orphans={reapprovalOrphans.orphans}
          isBusy={reapprovalBusy}
          onCancel={() => setReapprovalOrphans(null)}
          onConfirm={handleReapprovalOrphansConfirm}
        />
      )}
      {addVehicleFor && manager?.name && (
        <AddVehicleForResidentModal
          residentName={addVehicleFor.name ?? ''}
          residentEmail={addVehicleFor.email ?? ''}
          residentUnit={addVehicleFor.unit ?? ''}
          propertyName={manager.name}
          onCancel={() => setAddVehicleFor(null)}
          onSubmit={(payload) => handleAddVehicleSubmit(addVehicleFor, payload)}
        />
      )}
    </main>
  )
}
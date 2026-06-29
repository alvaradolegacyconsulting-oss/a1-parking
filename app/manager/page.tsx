'use client'
import { useState, useEffect } from 'react'
import { QRCodeCanvas } from 'qrcode.react'
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
import { FEATURE_FLAGS } from '../lib/feature-flags'
import SupportContact from '../components/SupportContact'
import {
  type GuestAuth,
  GUEST_AUTH_MAX_DAYS,
  todayIso,
  addDays,
  daysUntilExpiry,
  isExpiringSoon,
  findOverlappingActiveAuth,
  fetchActiveGuestAuths,
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
import SpaceDetailModal from '../components/SpaceDetailModal'
import CredentialsModal from '../components/CredentialsModal'
import { getCachedLogoUrl, getPlatformLogoUrl } from '../lib/logo'
import { normalizePlate } from '../lib/plate'
import { TOWED_CAR_LOOKUP_URL } from '../lib/towed-car-lookup'
import { generateTempPassword } from '../lib/temp-password'
import { BarChart, Bar, LineChart, Line, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
// B66.5 commit 4.3: account-state gate (past_due banner + suspended/cancelled redirects).
import { evaluatePortalGate } from '../lib/portal-account-gate'
import PastDueBanner, { type PastDueBannerProps } from '../components/PastDueBanner'

// B166 — escape PostgREST ILIKE wildcards so user-entered values
// (unit/property) can't over-match via embedded % or _. Email uses
// .eq() instead (forward stamps are all-lowercase; underscore in the
// local-part would otherwise be interpreted as ILIKE wildcard and
// over-match on a destructive UPDATE).
function escapeIlikeValue(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}

// Slice 1 Commit 4b — client wrapper for the /api/billing/sync-on-add
// route. Duplicated from app/company_admin/page.tsx (small DRY violation,
// limited blast radius — both files own their copy + share the same
// route contract; extracting to a shared lib is a future-cleanup item
// if a third call site appears). Non-throwing per the same contract:
// network errors degrade to {ok:false; reason}, the caller logs and
// continues — the DB write (here: approve_vehicle RPC) already committed.
async function callSyncOnAdd(
  companyId: number,
  kind: 'property' | 'driver' | 'permit',
): Promise<{ ok: true; action: string } | { ok: false; reason: string }> {
  try {
    const res = await fetch('/api/billing/sync-on-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_id: companyId, kind }),
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok && json.ok) {
      return { ok: true, action: String(json.action ?? 'unknown') }
    }
    return { ok: false, reason: String(json.reason ?? json.error ?? `HTTP ${res.status}`) }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}

export default function ManagerPortal() {
  const [manager, setManager] = useState<any>(null)
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
  // Per-modal target + form state — one slot per RPC, matches B214 pattern
  const [targetAdd, setTargetAdd] = useState(false)
  const [addForm, setAddForm] = useState<{ type: SpaceType }>({ type: 'carport' })
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
  const [residentNotes, setResidentNotes] = useState<Record<string, string>>({})
  // B70: Plate Lookup tab state. Distinct name from the Spaces-tab
  // `plateQuery` further down to avoid the variable collision.
  const [lookupPlate, setLookupPlate] = useState('')
  const [lookupBusy, setLookupBusy] = useState(false)
  // B220 (2026-06-26): widened result_type union to include 'guest_authorized'
  // + added guest_name/valid_through fields (populated only on guest_authorized;
  // NULL on resident/visitor/unauthorized per the pm_plate_lookup RPC contract).
  const [lookupResult, setLookupResult] = useState<{ result_type: 'resident' | 'visitor' | 'unauthorized' | 'guest_authorized'; unit_number: string | null; queriedPlate: string; guest_name?: string | null; valid_through?: string | null } | null>(null)
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
    }
  }, [manager])

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
      const { data, error } = await supabase
        .from('properties')
        .select('*')
        .ilike('name', roleData.property)
      setLoading(false)
      if (error || !data || data.length === 0) {
        setError(`No property found matching "${roleData.property}". Check your user_roles table.`)
      } else {
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
    if (prop) { setManager(prop); fetchAll(prop.name) }
  }

  async function fetchAll(property: string) {
    fetchVehicles(property)
    fetchViolations(property)
    fetchPasses(property)
    fetchResidents(property)
    fetchPendingSpaceRequests(property)
    // fetchSpaces removed (Spaces v1 commit 3) — Spaces tab loads its own
    // data lazily on tab activation via refetchSpacesDashboard/List
    // (dashboard aggregate + filtered paginated list). Removed from the
    // mount-time fetch fan-out so cold load doesn't pull 126+ rows.
    // B210 (2026-06-24): fetchDisputes call removed alongside the
    // resident dispute flow retirement.
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

  async function refetchSpacesDashboard() {
    if (!manager?.name) return
    const dash = await fetchOccupancyDashboard(supabase, manager.name)
    setOccupancy(dash)
    // Inert defensive banner count (commit 1 produced 0 flagged rows in v1;
    // future per-customer rollouts may flag multi-residency unit assignments)
    const { count: flagged } = await supabase
      .from('spaces').select('*', { count: 'exact', head: true })
      .ilike('property', manager.name).not('migration_note', 'is', null)
    setFlaggedMigrationCount(flagged ?? 0)
    // Available-spaces pool for the resident-approval assign-on-approve
    // dropdowns (commit 4). Top 100 available spaces; manager-level property
    // unlikely to have more available at once.
    const { rows: available } = await fetchSpacesList(
      supabase, manager.name,
      { type: null, status: 'available', showInactive: false, search: '' },
      0, 100,
    )
    setAvailableSpacesForAssign(available)
  }

  async function refetchSpacesList() {
    if (!manager?.name) return
    setSpacesListLoading(true)
    try {
      const { rows, totalCount } = await fetchSpacesList(supabase, manager.name, spacesFilters, spacesPage, spacesPageSize)
      setSpacesList(rows)
      setSpacesListTotal(totalCount)
    } finally {
      setSpacesListLoading(false)
    }
  }

  async function submitAddSingleSpace() {
    setSpacesError('')
    // Named params per Jose lock — single ad-hoc add, count pinned at 1.
    // Auto-name from type prefix. NOT a bulk path (that lives in CA commit 4).
    const { error } = await supabase.rpc('generate_spaces_from_pool', {
      p_property: manager.name,
      p_type: addForm.type,
      p_count: 1,
      p_label_prefix: null,        // null → RPC auto-derives from type
    })
    if (error) { setSpacesError(error.message); return }
    setTargetAdd(false)
    setAddForm({ type: 'carport' })
    await refetchSpacesDashboard()
    await refetchSpacesList()
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
    await refetchSpacesDashboard()
    await refetchSpacesList()
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
    await refetchSpacesDashboard()
    await refetchSpacesList()
  }

  async function submitDecommissionSpace() {
    if (!targetDecommission) return
    setSpacesError('')
    const { error } = await supabase.rpc('decommission_space', {
      p_space_id: targetDecommission.id,
    })
    if (error) { setSpacesError(error.message); return }
    setTargetDecommission(null)
    await refetchSpacesDashboard()
    await refetchSpacesList()
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
    await refetchSpacesDashboard()
    await refetchSpacesList()
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
      const { data, error } = await supabase.rpc('pm_plate_lookup', { p_plate: raw })
      if (error) {
        setLookupError(error.message || 'Lookup failed. Please try again.')
        return
      }
      const result = (data || {}) as Record<string, unknown>
      const kind = String(result.result_type || '')
      if (kind !== 'resident' && kind !== 'visitor' && kind !== 'unauthorized') {
        setLookupError('Unexpected response from server.')
        return
      }
      // Display the normalized plate (uppercase, no separators) so the
      // user sees exactly what got searched + logged in the audit row.
      const normalized = normalizePlate(raw)
      setLookupResult({
        result_type: kind as 'resident' | 'visitor' | 'unauthorized',
        unit_number: (result.unit_number as string | null) ?? null,
        queriedPlate: normalized,
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
    // Slice 1 Commit 4b — route through approve_vehicle RPC (commit 4a).
    // The RPC re-enforces scope (DEFINER bypasses RLS; the scope-check
    // is the security property), runs the UPDATE atomically, and returns
    // {ok, action, vehicle}. Fire the permit sync ONLY on action='approved'
    // (not 'noop_already_active'); the RPC's idempotency design exists
    // exactly so a re-approve doesn't redundantly trigger Stripe.
    const { data: rpcResult, error: rpcErr } = await supabase.rpc('approve_vehicle', {
      p_vehicle_id:   id,
      p_manager_note: pendingNotes[id] || null,
    })
    if (rpcErr) {
      console.error('[approve_vehicle] RPC error:', rpcErr.message)
      return
    }
    const result = rpcResult as { ok?: boolean; action?: string; error?: string; hint?: string } | null
    if (!result?.ok) {
      console.error('[approve_vehicle] RPC returned error:', result?.error, result?.hint)
      return
    }
    console.info('[approve_vehicle]', { site: 'approveVehicle', vehicleId: id, action: result.action })
    await logAudit({ action: 'APPROVE_VEHICLE', table_name: 'vehicles', record_id: id, new_values: { status: 'active', property: manager.name } })
    if (result.action === 'approved' && companyIdForSync) {
      const syncRes = await callSyncOnAdd(companyIdForSync, 'permit')
      console.info('[B147-sync-result]', { site: 'approveVehicle', kind: 'permit', result: syncRes.ok ? syncRes.action : `failed:${syncRes.reason}` })
      if (!syncRes.ok) console.warn('[B147-sync-failed]', { context: 'approveVehicle', reason: syncRes.reason })
    } else if (result.action === 'noop_already_active') {
      console.info('[B147-sync-skipped]', { site: 'approveVehicle', reason: 'noop_already_active — vehicle was already approved; no quantity change' })
    }
    setPendingNotes(n => { const c = {...n}; delete c[id]; return c })
    fetchVehicles(manager.name)
  }

  async function declineVehicle(id: string) {
    await supabase.from('vehicles').update({ is_active: false, status: 'declined', manager_note: pendingNotes[id] || null }).eq('id', id)
    await logAudit({ action: 'DECLINE_VEHICLE', table_name: 'vehicles', record_id: id, new_values: { status: 'declined', property: manager.name } })
    const { data: veh } = await supabase.from('vehicles').select('unit, property').eq('id', id).single()
    if (veh) {
      await supabase.from('residents')
        .update({ status: 'active', is_active: true })
        .ilike('unit', veh.unit)
        .ilike('property', veh.property)
        .eq('status', 'pending')
    }
    setPendingNotes(n => { const c = {...n}; delete c[id]; return c })
    fetchVehicles(manager.name)
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
    fetchVehicles(manager.name)
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
    fetchVehicles(manager.name)
  }

  async function declineAllForUnit(unitVehicles: any[], unit: string) {
    const note = unitNotes[unit] || null
    await Promise.all(unitVehicles.map(v =>
      supabase.from('vehicles').update({ is_active: false, status: 'declined', manager_note: note }).eq('id', v.id)
        .then(() => logAudit({ action: 'DECLINE_VEHICLE', table_name: 'vehicles', record_id: v.id, new_values: { status: 'declined', property: manager.name } }))
    ))
    await supabase.from('residents')
      .update({ status: 'active', is_active: true })
      .ilike('unit', unit)
      .ilike('property', manager.name)
      .eq('status', 'pending')
    setUnitNotes(n => { const c = {...n}; delete c[unit]; return c })
    fetchVehicles(manager.name)
  }

  async function fetchViolations(property: string) {
    const week = new Date(); week.setDate(week.getDate() - 7)
    const { data } = await supabase.from('violations')
      .select('*, photo_rows:violation_photos(id, photo_url, removed_at), video_rows:violation_videos(id, video_url, removed_at)')
      .eq('is_confirmed', true)
      .ilike('property', property)
      .gte('created_at', week.toISOString())
      .order('created_at', { ascending: false })
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

  async function fetchResidents(property: string) {
    const { data } = await supabase.from('residents').select('*').ilike('property', property).order('unit')
    const all = data || []
    setPendingResidents(all.filter(r => r.status === 'pending'))
    setResidents(all.filter(r => r.status !== 'pending'))
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

  // Notify the resident of an approve/decline decision via the
  // /api/manager/notify-resident-decision endpoint. NON-BLOCKING on
  // failure — the DB writes are already committed; the email is the
  // secondary channel. Returns { ok, message_id } so callers can
  // stamp the audit log with email_sent + message_id for forensic
  // visibility.
  async function notifyResidentDecision(args: {
    residentId: string
    decision: 'approved' | 'declined'
    note: string | null
  }): Promise<{ ok: boolean; message_id: string | null }> {
    try {
      const res = await fetch('/api/manager/notify-resident-decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      })
      const j = await res.json().catch(() => ({}))
      if (res.ok && j.ok) {
        return { ok: true, message_id: j.message_id || null }
      }
      console.error('[resident-decision-email] failed:', j.error || res.statusText)
      return { ok: false, message_id: null }
    } catch (e) {
      console.error('[resident-decision-email] threw:', e)
      return { ok: false, message_id: null }
    }
  }

  async function approveResident(r: any) {
    const note = residentNotes[r.id] || null
    await supabase.from('residents').update({ is_active: true, status: 'active', manager_note: note }).eq('id', r.id)
    // Slice 1 Commit 4b — cascade vehicle approval: SELECT pending vehicle
    // ids for this unit at this property, then loop the approve_vehicle
    // RPC per row. Each gets the unified scope-check + resident_read=true
    // (commit 4a normalizes L895's prior omission). p_manager_note=NULL
    // per the locked decision (the note belongs to the resident approval,
    // not the auto-cascaded vehicles). One permit sync after the batch if
    // any actually approved.
    const { data: pendingCascadeRaw } = await supabase
      .from('vehicles').select('id')
      .ilike('unit', r.unit).ilike('property', manager.name).eq('status', 'pending')
    // Permit-Door Piece 1 §3 — billing-conversion prompt (PM-Only ONLY).
    // Prompt fires ONLY when there's actually something to cascade
    // (count > 0) so a no-vehicle resident-approval doesn't surface a
    // confusing "Approve 0 vehicles?" prompt. If operator cancels:
    // resident stays approved (L1033 already committed) but the vehicle
    // cascade is skipped — operator can approve vehicles individually
    // later. Resident-approval and vehicle-approval are separate
    // billing events. Skip mechanism: empty the cascade array so the
    // loop below runs over 0 items + the email/audit block still runs.
    let pendingCascade = pendingCascadeRaw ?? []
    const ctxCascade = getCompanyContext()
    if (pendingCascade.length > 0 && ctxCascade.tier === 'pm_only') {
      if (!window.confirm(`Approve ${pendingCascade.length} vehicles as billable permits?`)) {
        console.info('[approve_vehicle]', { site: 'approveResident-cascade', skipped: 'billing-prompt-cancelled', count: pendingCascade.length })
        pendingCascade = []
      }
    }
    let cascadeApprovedCount = 0
    for (const v of pendingCascade) {
      const { data, error } = await supabase.rpc('approve_vehicle', {
        p_vehicle_id:   v.id,
        p_manager_note: null,
      })
      if (error) {
        console.error('[approve_vehicle] RPC error in cascade:', error.message, { vehicleId: v.id })
        continue
      }
      const r = data as { ok?: boolean; action?: string } | null
      console.info('[approve_vehicle]', { site: 'approveResident-cascade', vehicleId: v.id, action: r?.action })
      if (r?.action === 'approved') cascadeApprovedCount++
    }
    console.info('[B147-sync-batch-summary]', { site: 'approveResident-cascade', unit: r.unit, batchSize: (pendingCascade ?? []).length, approvedCount: cascadeApprovedCount, willFireSync: cascadeApprovedCount > 0 })
    if (cascadeApprovedCount > 0 && companyIdForSync) {
      const syncRes = await callSyncOnAdd(companyIdForSync, 'permit')
      console.info('[B147-sync-result]', { site: 'approveResident-cascade', kind: 'permit', result: syncRes.ok ? syncRes.action : `failed:${syncRes.reason}` })
      if (!syncRes.ok) console.warn('[B147-sync-failed]', { context: 'approveResident-cascade', approvedCount: cascadeApprovedCount, reason: syncRes.reason })
    }
    // Send the approval email + capture outcome for the audit. Email
    // failure is non-fatal — approval is already committed.
    const emailResult = await notifyResidentDecision({ residentId: r.id, decision: 'approved', note: null })
    await logAudit({
      action: 'APPROVE_RESIDENT',
      table_name: 'residents',
      record_id: r.id,
      new_values: {
        name: r.name,
        unit: r.unit,
        property: manager.name,
        email_sent: emailResult.ok,
        message_id: emailResult.message_id,
      },
    })
    // Spaces v1 commit 4 — OPTIONAL assign-space step. Manager picked a
    // space in the pending-row dropdown → call assign_space RPC after the
    // resident UPDATE succeeds. NON-FATAL per Jose 2026-06-21 lock:
    // "approval ≠ assignment, most residents hold zero spaces" — if the
    // assign fails (e.g., space taken between dropdown-load and submit),
    // resident approval stays; manager can assign via the Spaces tab.
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
    fetchResidents(manager.name)
    // Refresh spaces dashboard + available-pool so the freshly-assigned
    // space disappears from the assign dropdowns for other pending rows.
    if (pickedSpaceId) await refetchSpacesDashboard()
  }

  async function declineResident(r: any) {
    const note = residentNotes[r.id] || null
    await supabase.from('residents').update({ is_active: false, status: 'declined', manager_note: note }).eq('id', r.id)
    await supabase.from('vehicles').update({ is_active: false, status: 'declined' }).ilike('unit', r.unit).ilike('property', manager.name).eq('status', 'pending')
    // Send the decline email (with optional manager note) + capture
    // outcome for the audit. Email failure is non-fatal.
    const emailResult = await notifyResidentDecision({ residentId: r.id, decision: 'declined', note })
    await logAudit({
      action: 'DECLINE_RESIDENT',
      table_name: 'residents',
      record_id: r.id,
      new_values: {
        name: r.name,
        unit: r.unit,
        property: manager.name,
        email_sent: emailResult.ok,
        message_id: emailResult.message_id,
      },
    })
    // B166 — owner-trim. Defensive against any historical active vehicle
    // owned by this email at this tuple (the pending-status filter above
    // only catches pending-status rows; an active row owned by a re-
    // appearing email would survive without this).
    await trimDepartedResidentVehicles(r.email, r.unit, manager.name, 'DECLINE_RESIDENT')
    setResidentNotes(n => { const c = {...n}; delete c[r.id]; return c })
    fetchResidents(manager.name)
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
    const initState = initialVehicleState(getCompanyContext().tier)
    const { error } = await supabase.from('vehicles').insert([{
      ...newVehicle,
      plate: normalizedPlate,
      unit: unit || newVehicle.unit,
      property: manager.name,
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
      fetchVehicles(manager.name)
    }
  }

  async function removeVehicle(id: string) {
    if (!confirm('Remove this vehicle?')) return
    await supabase.from('vehicles').update({ is_active: false }).eq('id', id)
    await logAudit({ action: 'REMOVE_VEHICLE', table_name: 'vehicles', record_id: id, new_values: { is_active: false, property: manager.name } })
    fetchVehicles(manager.name)
  }

  async function addResident() {
    if (!newResident.name || !newResident.unit || !newResident.email) { alert('Name, email and unit are required'); return }

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
        // Best-effort. Supabase queries return { error } rather than
        // throwing, so an explicit catch isn't needed; we just don't
        // surface the result.
        await supabase.from('residents').delete().ilike('email', targetEmail).ilike('property', manager.name)
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
        await refetchSpacesDashboard()
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
    fetchResidents(manager.name)
    setCredentials({ email: targetEmail, password: tempPassword })
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
  async function runOneDeactivate(residentId: string) {
    const { data: r } = await supabase.from('residents').select('email, unit, property').eq('id', residentId).maybeSingle()
    await supabase.from('residents').update({ is_active: false }).eq('id', residentId)
    await logAudit({ action: 'DEACTIVATE_RESIDENT', table_name: 'residents', record_id: residentId, new_values: { is_active: false, property: manager.name } })
    // B166 owner-trim + B150 cascade (unchanged from pre-v1.1).
    // Space-tie cleanup is now DB-trigger-driven (commit-1 migration);
    // no free_space client call needed.
    await trimDepartedResidentVehicles(r?.email, r?.unit, r?.property, 'DEACTIVATE_RESIDENT')
    await cascadeVehiclesIfUnitVacant(r?.unit, r?.property, 'DEACTIVATE_RESIDENT')
  }

  // Orchestrates: target + any opted-in co-residents. Sequential (a manager
  // rarely cascades more than 2-3) so individual failures are isolated and
  // the trigger fires once per call. After all done, refetch + close modal.
  async function runDeactivateBatch(alsoEmails: string[]) {
    if (!targetDeactivate) return
    setDeactivateBusy(true)
    try {
      // 1. Target first.
      await runOneDeactivate(targetDeactivate.id)
      // 2. Each opted-in co-resident — look up their id by email to call runOneDeactivate.
      for (const email of alsoEmails) {
        const { data: co } = await supabase.from('residents')
          .select('id').eq('email', email).eq('is_active', true).maybeSingle()
        if (co?.id) await runOneDeactivate(co.id)
      }
    } finally {
      setTargetDeactivate(null)
      setDeactivateBusy(false)
      fetchResidents(manager.name)
      await refetchSpacesDashboard()
      await refetchSpacesList()
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

    const confirmMsg = wontRestore > 0
      ? `Reactivate this resident? Their own previously-deactivated vehicle${willRestore === 1 ? '' : 's'} (${willRestore}) will be reactivated. ${wontRestore} other vehicle${wontRestore === 1 ? '' : 's'} on this unit ${wontRestore === 1 ? 'was' : 'were'} removed by a unit-vacancy cascade and will NOT be auto-restored — review the Vehicles tab if needed.`
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
    fetchResidents(manager.name)
  }

  // B166 — owner-trim. Flips vehicles.is_active=false for the departed
  // resident's vehicles, scoped to (resident_email, property, unit). One
  // field flip covers both halves of the defect: privacy (resident-portal
  // fetchVehicles filters on is_active=true) AND enforcement (pm_plate_
  // lookup / check_resident_plate / driver-side query all filter on
  // is_active=TRUE → departed car returns "not authorized" → tow-eligible).
  // Composes with B150 cascadeVehiclesIfUnitVacant which runs after.
  async function trimDepartedResidentVehicles(
    rawEmail: string | null | undefined,
    rawUnit: string | null | undefined,
    rawProperty: string | null | undefined,
    sourceAction: string
  ) {
    if (!rawEmail || !rawUnit || !rawProperty) return
    const email = rawEmail.trim().toLowerCase()
    const unit = rawUnit.trim()
    const property = rawProperty.trim()
    if (!email || !unit || !property) return
    // Email: .eq() on the lowercased value — forward stamps are all
    // lowercase; historical mixed-case rows wiped pre-launch; .eq()
    // avoids ILIKE wildcard injection (underscores in email local-parts
    // would otherwise over-match on a destructive UPDATE).
    // Unit/property: keep ILIKE for case-insensitivity but escape
    // any embedded % or _ in the user-entered values so 'Apt_214'
    // doesn't match 'Apt1214' etc.
    const { data: matched, error } = await supabase
      .from('vehicles')
      .update({ is_active: false })
      .eq('resident_email', email)
      .ilike('unit', escapeIlikeValue(unit))
      .ilike('property', escapeIlikeValue(property))
      .eq('is_active', true)
      .select('id, plate')
    if (error) {
      console.error('[B166-owner-trim-failed]', { sourceAction, email, property, unit, error: error.message })
      return
    }
    const affected = matched?.length || 0
    if (affected > 0) {
      // F6 verify-after-write: re-SELECT the matched ids and confirm
      // is_active=false. Non-fatal; log mismatch.
      const { data: verify } = await supabase
        .from('vehicles')
        .select('id, is_active')
        .in('id', matched!.map(v => v.id))
      const mismatched = (verify || []).filter(v => v.is_active !== false)
      if (mismatched.length > 0) {
        console.error('[B166-owner-trim-verify-mismatch]', { sourceAction, email, property, unit, affected, mismatchedCount: mismatched.length })
      }
      await logAudit({
        action: 'B166_OWNER_TRIM',
        table_name: 'vehicles',
        new_values: {
          source: sourceAction,
          resident_email: email,
          property,
          unit,
          vehicles_affected: affected,
          plates: matched!.map(v => v.plate),
        },
      })
    }
  }

  // B150 — vehicle-lifecycle cascade. Fires when the LAST active resident
  // at a (unit, property) tuple leaves. Roommate-safe: gate-check counts
  // active residents remaining at the tuple; cascade only runs when 0.
  // No schema change — flips vehicles.is_active=false, which the resident-
  // portal fetchVehicles filter (now explicit .eq('is_active', true))
  // honors, hiding archived vehicles from the next resident at the unit.
  async function cascadeVehiclesIfUnitVacant(unit: string | null | undefined, property: string | null | undefined, sourceAction: string) {
    if (!unit || !property) return
    // B166 escape bundle — apply the same ILIKE wildcard escape used by
    // trimDepartedResidentVehicles. The vehicles UPDATE arm below is
    // destructive (is_active=false) so embedded %/_ in unit/property
    // values must be treated as literals, not wildcards. The residents
    // count arm is non-destructive but escaped for consistency so the
    // gate-check counts the right tuple.
    const escUnit = escapeIlikeValue(unit)
    const escProperty = escapeIlikeValue(property)
    const { count: othersStillActive } = await supabase
      .from('residents')
      .select('id', { count: 'exact', head: true })
      .ilike('unit', escUnit)
      .ilike('property', escProperty)
      .eq('is_active', true)
    if (othersStillActive !== 0) return  // roommate still occupies unit
    const { data: archived } = await supabase
      .from('vehicles')
      .update({ is_active: false })
      .ilike('unit', escUnit)
      .ilike('property', escProperty)
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
          <p style={{ color:'#888', fontSize:'13px', margin:'4px 0 0' }}>Property Manager Portal</p>
        </div>

        {isAdmin && allProperties.length > 1 && (
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
          <button style={tabStyle('vehicles')} onClick={() => setActiveTab('vehicles')}>
            {/* Space Requests v1 — tab renamed to "Approvals"; badge is
                the combined count of pending vehicles + pending space
                requests. The route key 'vehicles' is preserved so deep-
                links and prior muscle memory still work; only the label
                changes. */}
            Approvals{(pendingVehicles.length + pendingSpaceRequests.length) > 0 && <span style={{ background:'#B71C1C', color:'white', borderRadius:'10px', fontSize:'9px', padding:'1px 6px', marginLeft:'4px', fontWeight:'bold' }}>{pendingVehicles.length + pendingSpaceRequests.length}</span>}
          </button>
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
          {/* B75 (was B70 PM_PLATE_LOOKUP): Plate Lookup tab — visible on
              every tier across both tracks (manual lookup is a baseline
              utility). Admin always sees it (parity with other tier-gated
              surfaces in the codebase). */}
          {(isAdmin || hasFeature(FEATURE_FLAGS.MANAGER_PLATE_LOOKUP, getCompanyContext()) === true) && (
            <button style={tabStyle('plate-lookup')} onClick={() => setActiveTab('plate-lookup')}>Plate Lookup</button>
          )}
          <button style={tabStyle('settings')} onClick={() => setActiveTab('settings')}>Settings</button>
          {/* B210 (2026-06-24): Disputes tab button removed */}
          <button style={tabStyle('insights')} onClick={() => setActiveTab('insights')}>Insights</button>
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
                  <span style={{ color:'#555', fontSize:'11px' }}>{new Date(v.created_at).toLocaleDateString()}</span>
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
                  <span style={{ color:'#4caf50', fontSize:'11px' }}>Expires {new Date(p.expires_at).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* VEHICLES */}
        {activeTab === 'vehicles' && (
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
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', margin:'0 0 12px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', textTransform:'uppercase', letterSpacing:'0.08em', margin:0 }}>
                      Pending Vehicle Requests ({pendingVehicles.length})
                    </p>
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
                <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 12px' }}>
                  Pending Space Requests ({pendingSpaceRequests.length})
                </p>
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
                          <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>Requested {new Date(req.requested_at).toLocaleString()}</p>
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
              <button onClick={() => setShowAddVehicle(!showAddVehicle)}
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
                    <select value={vehicleOwnerEmail} onChange={e => setVehicleOwnerEmail(e.target.value)} style={inputStyle}>
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
                  <button onClick={() => addVehicle()} style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>Add Vehicle</button>
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
                  <div><span style={{ color:'#555' }}>Permit Expiry</span><br/><span style={{ color:'#aaa' }}>{v.permit_expiry ? new Date(v.permit_expiry).toLocaleDateString() : '—'}</span></div>
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
                            <td style={{ padding:'8px', color:'#aaa' }}>{residentDisplayList(s.residents)}</td>
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
                <div style={{ background:'#161b26', border:'1px solid #C9A227', borderRadius:'14px', padding:'22px', maxWidth:'400px', width:'100%' }}>
                  <p style={{ color:'#C9A227', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 12px', fontWeight:'bold' }}>Add new space</p>
                  <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase' }}>Type *</label>
                  <select value={addForm.type} onChange={e => setAddForm({ type: e.target.value as SpaceType })} style={inputStyle}>
                    {SPACE_TYPES.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                  </select>
                  <p style={{ color:'#666', fontSize:'11px', margin:'0 0 14px', lineHeight:'1.4' }}>
                    Label will auto-generate as the next sequential number for this type. You can rename via the Edit modal after.
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
                <div style={{ background:'#161b26', border:'1px solid #3b82f6', borderRadius:'14px', padding:'22px', maxWidth:'460px', width:'100%' }}>
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
                <div style={{ background:'#161b26', border:'1px solid #f59e0b', borderRadius:'14px', padding:'22px', maxWidth:'440px', width:'100%' }}>
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
                  await refetchSpacesList()
                }}
              />
            )}

            {/* DECOMMISSION modal — confirm only */}
            {targetDecommission && (
              <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                <div style={{ background:'#161b26', border:'1px solid #991b1b', borderRadius:'14px', padding:'22px', maxWidth:'400px', width:'100%' }}>
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
                <div style={{ background:'#161b26', border:'1px solid #C9A227', borderRadius:'14px', padding:'22px', maxWidth:'440px', width:'100%' }}>
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

        {/* RESIDENTS */}
        {activeTab === 'residents' && (
          <div>
            {pendingResidents.length > 0 && (
              <div style={{ background:'#1a1400', border:'1px solid #a16207', borderRadius:'10px', padding:'14px', marginBottom:'16px' }}>
                <p style={{ color:'#fbbf24', fontWeight:'bold', fontSize:'12px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 12px' }}>
                  Pending Resident Registrations ({pendingResidents.length})
                </p>
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
            {!isReadOnly && (
              <button onClick={() => setShowAddResident(!showAddResident)}
                style={{ width:'100%', padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', marginBottom:'12px' }}>
                + Add Resident
              </button>
            )}
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
                  <button onClick={addResident} style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>Add Resident</button>
                  <button onClick={() => { setShowAddResident(false); setNewResidentAssignSpaceId('') }} style={{ padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                </div>
              </div>
            )}
            {editingResident && (
              <div style={{ background:'#161b26', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Editing — {editingResident.unit}</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div style={{ gridColumn:'span 2' }}><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Full Name</label><input value={editingResident.name || ''} onChange={e => setEditingResident({...editingResident, name: e.target.value})} style={inputStyle} /></div>
                  <div style={{ gridColumn:'span 2' }}><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Email</label><input value={editingResident.email || ''} onChange={e => setEditingResident({...editingResident, email: e.target.value})} style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Phone</label><input value={editingResident.phone || ''} onChange={e => setEditingResident({...editingResident, phone: e.target.value})} style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Unit</label><input value={editingResident.unit || ''} onChange={e => setEditingResident({...editingResident, unit: e.target.value})} style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Space</label><input value={editingResident.space || ''} onChange={e => setEditingResident({...editingResident, space: e.target.value})} style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Lease End</label><input type="date" value={editingResident.lease_end || ''} onChange={e => setEditingResident({...editingResident, lease_end: e.target.value})} style={inputStyle} /></div>
                </div>
                <div style={{ display:'flex', gap:'8px', marginTop:'4px', marginBottom:'16px' }}>
                  <button onClick={saveResident} style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>Save Changes</button>
                  <button onClick={() => setEditingResident(null)} style={{ padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                </div>
                <div style={{ borderTop:'1px solid #2a2f3d', paddingTop:'14px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'10px' }}>
                    <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0' }}>Vehicles — {editingResident.unit}</p>
                    <button onClick={async () => { setShowAddVehicle(true); await fetchResidentsAtUnit(editingResident.unit); setVehicleOwnerEmail(editingResident.email || '') }} style={{ padding:'5px 10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'11px', border:'none', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>+ Add Vehicle</button>
                  </div>
                  {showAddVehicle && (
                    <div style={{ background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', padding:'12px', marginBottom:'10px' }}>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Plate *</label><input value={newVehicle.plate} onChange={e => setNewVehicle({...newVehicle, plate: normalizePlate(e.target.value)})} placeholder="ABC1234" style={{ ...inputStyle, fontFamily:'Courier New', fontSize:'14px', fontWeight:'bold' }} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>State</label><select value={newVehicle.state} onChange={e => setNewVehicle({...newVehicle, state: e.target.value})} style={inputStyle}>{['TX','CA','FL','NY','GA','OH','IL','PA','NC','AZ'].map(s => <option key={s}>{s}</option>)}</select></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Make</label><input value={newVehicle.make} onChange={e => setNewVehicle({...newVehicle, make: e.target.value})} placeholder="Toyota" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Model</label><input value={newVehicle.model} onChange={e => setNewVehicle({...newVehicle, model: e.target.value})} placeholder="Camry" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Year</label><input value={newVehicle.year} onChange={e => setNewVehicle({...newVehicle, year: e.target.value})} placeholder="2022" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Color</label><input value={newVehicle.color} onChange={e => setNewVehicle({...newVehicle, color: e.target.value})} placeholder="Black" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Space</label><input value={newVehicle.space} onChange={e => setNewVehicle({...newVehicle, space: e.target.value})} placeholder="A-12" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Permit Expiry</label><input type="date" value={newVehicle.permit_expiry} onChange={e => setNewVehicle({...newVehicle, permit_expiry: e.target.value})} style={inputStyle} /></div>
                        {/* B166 — owner picker. Pre-loaded with editingResident on modal open. */}
                        <div style={{ gridColumn:'span 2' }}>
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
                      <div style={{ display:'flex', gap:'8px' }}>
                        <button onClick={() => addVehicle(editingResident.unit)} style={{ flex:1, padding:'9px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'12px', border:'none', borderRadius:'6px', cursor:'pointer' }}>Add Vehicle</button>
                        <button onClick={() => setShowAddVehicle(false)} style={{ padding:'9px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
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
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'6px', fontSize:'11px', marginBottom:'8px' }}>
                          <div><span style={{ color:'#555' }}>Space</span><br/><span style={{ color:'#aaa' }}>{v.space || '—'}</span></div>
                          <div><span style={{ color:'#555' }}>State</span><br/><span style={{ color:'#aaa' }}>{v.state}</span></div>
                          <div><span style={{ color:'#555' }}>Permit Expiry</span><br/><span style={{ color:'#aaa' }}>{v.permit_expiry ? new Date(v.permit_expiry).toLocaleDateString() : '—'}</span></div>
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
                  <div><span style={{ color:'#555' }}>Lease End</span><br/><span style={{ color:'#aaa' }}>{r.lease_end ? new Date(r.lease_end).toLocaleDateString() : '—'}</span></div>
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
                        {new Date(v.voided_at as string).toLocaleDateString()}
                        {v.void_reason ? ` · ${v.void_reason}` : ''}
                      </span>
                    </div>
                  )}
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'8px' }}>
                    <p style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                    <p style={{ color:'#555', fontSize:'11px', margin:'0' }}>{new Date(v.created_at).toLocaleDateString()}</p>
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
              <p style={{ color:'#555', fontSize:'12px', margin:'0 0 14px', lineHeight:'1.5' }}>Max visitor passes per plate per year. Leave blank for unlimited. Applies to all visitors at this property.</p>
              <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Max Passes Per Plate Per Year</label>
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
                      <p style={{ color:'#444', fontSize:'10px', margin:'0 0 14px', wordBreak:'break-all', fontFamily:'Courier New', textAlign:'center' }}>{regUrl}</p>
                      <button onClick={() => {
                        const canvas = document.querySelector('#qr-registration canvas') as HTMLCanvasElement
                        if (!canvas) return
                        const tw = window.open('', '_blank')!
                        tw.document.write(`<html><head><title>Registration QR - ${manager.name}</title><style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#fff;font-family:Arial,sans-serif;padding:40px}img{width:220px;height:220px}h2{color:#1A1F2E;font-size:22px;margin:16px 0 8px}p{color:#555;font-size:13px;text-align:center;max-width:320px;margin:4px 0}a{color:#C9A227;font-size:11px;word-break:break-all}</style></head><body><img src="${canvas.toDataURL()}" /><h2>${manager.name}</h2><p>Scan to register as a new resident</p><p>Your account requires manager approval before login</p><a>${regUrl}</a><script>window.print();window.close();</script></body></html>`)
                        tw.document.close()
                      }} style={{ width:'100%', padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                        Print QR Code
                      </button>
                    </>
                  )
                })()}
              </div>
            )}

            {/* Section C — Exempt Plates */}
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 4px' }}>Exempt Plates</p>
              <p style={{ color:'#555', fontSize:'12px', margin:'0 0 14px', lineHeight:'1.5' }}>These plates bypass the annual visitor pass limit entirely.</p>

              {exemptPlates.length === 0 ? (
                <p style={{ color:'#555', fontSize:'12px', margin:'0 0 14px' }}>No exempt plates yet.</p>
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
                      <span style={{ color:'#888', fontSize:'10px' }}>{new Date(log.created_at).toLocaleString()}</span>
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
                        Valid through <strong>{new Date(lookupResult.valid_through).toLocaleDateString()}</strong>
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
                    <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555' }}>Expires</span><br/><span style={{ color:'#f59e0b' }}>{new Date(p.expires_at).toLocaleString()}</span></div>
                  </div>
                </div>
              ))
            }
          </div>
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
              return (
                <div key={g.id} style={{ background:'#161b26', border:`1px solid ${expSoon ? '#f59e0b' : '#2a2f3d'}`, borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                    <p style={{ color:'#3b82f6', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{g.plate}</p>
                    <span style={{ background: expSoon ? '#3a2a08' : '#0a1628', color: expSoon ? '#fbbf24' : '#3b82f6', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold' }}>
                      {expSoon ? `Expires in ${daysLeft}d` : 'Active'}
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
                <div style={{ background:'#161b26', border:'1px solid #3b82f6', borderRadius:'14px', padding:'22px', maxWidth:'440px', width:'100%' }}>
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
                <div style={{ background:'#161b26', border:'1px solid #991b1b', borderRadius:'14px', padding:'22px', maxWidth:'440px', width:'100%' }}>
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
          onConfirm={(alsoEmails) => runDeactivateBatch(alsoEmails)}
        />
      )}
    </main>
  )
}
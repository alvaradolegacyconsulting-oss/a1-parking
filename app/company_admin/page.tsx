'use client'
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../supabase'
import { getThemeColor } from '../lib/theme'
import { QRCodeCanvas } from 'qrcode.react'
import SupportContact from '../components/SupportContact'
import { useResolvedLogo, getCachedLogoUrl, getPlatformLogoUrl } from '../lib/logo'
import { getCompanyContext, getLimit, isUnderLimit, getUpgradePrompt, hasFeature, getCachedCompanyId } from '../lib/tier'

// B147 3b.1 — client-side wrapper for the server-only syncOnAdd helper.
// Calls /api/billing/sync-on-add which enforces auth + ownership server-
// side. Returns the same shape syncOnAdd does, so the 4 CA-portal call
// sites don't change their caller pattern (skip-no-companyid +
// [B147-sync-failed]). Non-throwing — network errors degrade to
// { ok: false; reason } so the DB-write-stays-committed semantics hold.
async function callSyncOnAdd(
  companyId: number,
  kind: 'property' | 'driver',
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
import { TIER_DISPLAY_NAME, type TierType } from '../lib/tier-config'
// B65.2: account_state gate (spec §3.4) — defense in depth with login dispatch.
// B66.5 commit 4.3: extended for past_due banner + suspended redirect era shift.
import { gateAccountState, AccountState } from '../lib/account-state'
import PastDueBanner, { type PastDueBannerProps } from '../components/PastDueBanner'
import { FEATURE_FLAGS } from '../lib/feature-flags'
import { normalizePlate } from '../lib/plate'
import { TOW_REASONS, RESTRICTED_ON_OVERRIDE, displayTowReason, type TowReasonCode } from '../lib/tow-reasons'
// B214 — guest_authorizations shared helpers (anti-drift; same source of
// truth as manager portal). CA form's property dropdown sources from CA's
// own company's active properties only (Jose lock 2026-06-20).
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
// Spaces v1 commit 4 — same dashboard-primary architecture as manager portal.
// CA variant: property selector at top; per-property single-view (NOT a
// cross-property aggregate per Jose 2026-06-21 #1 lock). All mutations route
// through the 6 DEFINER RPCs.
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
  residentDisplay,     // legacy single-email helper; kept for any remaining legacy reader
  residentDisplayList, // v1.1 multi-resident list-version (CA reader sites migrate to this)
} from '../lib/spaces'
import SearchableResidentPicker, { type SearchableResidentPickerResult } from '../components/SearchableResidentPicker'
import { uploadVideoResumable } from '../lib/video-upload'
import { TOWED_CAR_LOOKUP_URL } from '../lib/towed-car-lookup'
import { generateTempPassword } from '../lib/temp-password'
import CredentialsModal from '../components/CredentialsModal'
import ViolationReviewScreen, { ReviewViolation } from '../components/ViolationReviewScreen'
// B71: decline-and-proceed interstitial — symmetric to driver portal.
import DeclineReasonModal, { DeclineReason, DECLINE_REASON_LABELS } from '../components/DeclineReasonModal'
import PostConfirmationEditModal from '../components/PostConfirmationEditModal'
import { TierUpgradeModal, type TierUpgradeContext, nextWithinTrackTier } from '../components/TierUpgradeModal'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'

export default function CompanyAdminPortal() {
  const [user, setUser] = useState<any>(null)
  const [role, setRole] = useState<any>(null)
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null)
  const [loading, setLoading] = useState(true)
  // B66.5 commit 4.3: past_due banner state (REPLACES the prior B65.2-era
  // accountSuspended boolean). Era shift: suspended is now a hard redirect
  // (cron makes it reachable; banner-only is no longer correct posture);
  // past_due is now the "warn but allow" lifecycle stage that the banner
  // renders for. See [[project-b66-5-commit-4-2-closure]] sibling
  // [[project-b66-5-commit-4-3-closure]] for the timeline.
  const [pastDueBanner, setPastDueBanner] = useState<PastDueBannerProps | null>(null)
  // B66.5.1: track current company's account_state for Q4 defense-in-depth
  // disable of B144 Resend button on Drivers tab. undefined for admin role
  // (no company association) → button stays enabled. suspended/cancelled
  // → button hidden (these states already redirect via gateAccountState;
  // this is belt-and-suspenders against race/stale-state edge cases).
  const [companyAccountState, setCompanyAccountState] = useState<string | null>(null)
  // B144 (B66.5 commit 4.3): invite status map (email → 'activated'|'invited'|'unknown')
  // populated after fetchCompanyUsers via POST /api/admin/invite-status.
  const [inviteStatuses, setInviteStatuses] = useState<Record<string, 'activated' | 'invited' | 'unknown'>>({})
  // B165 — forced-upgrade modal state. Populated at cap-hit moments.
  // pendingRetry holds the action the customer was trying to take when
  // they hit the cap; runs after the modal reports success so the
  // original add resumes.
  const [tierUpgradeCtx, setTierUpgradeCtx] = useState<TierUpgradeContext | null>(null)
  const [pendingTierUpgradeRetry, setPendingTierUpgradeRetry] = useState<(() => void) | null>(null)
  // B144: per-email 60s resend disable (timestamp when disable expires).
  const [resendDisabledUntil, setResendDisabledUntil] = useState<Record<string, number>>({})
  const [resendingEmail, setResendingEmail] = useState<string | null>(null)
  const resolvedLogo = useResolvedLogo(typeof window !== 'undefined' ? localStorage.getItem('company_logo') : null)

  const [properties, setProperties] = useState<any[]>([])
  const [selectedProperty, setSelectedProperty] = useState<any>(null)
  const [stats, setStats] = useState({ total_vehicles: 0, violations_today: 0, violations_week: 0, active_passes: 0 })
  const [activeTab, setActiveTab] = useState('overview')

  // B66.4 — Billing tab state. billingData populated on tab activate
  // (loadBillingData); portalLoading guards the "Manage Billing" button.
  const [billingData, setBillingData] = useState<{
    stripe_customer_id: string | null
    stripe_subscription_id: string | null
    subscription_status: string | null
    current_period_end: string | null
    cancel_at_period_end: boolean | null
    address: string | null
    billing_city: string | null
    billing_state: string | null
    billing_postal_code: string | null
    billing_country: string | null
  } | null>(null)
  const [billingLoading, setBillingLoading] = useState(false)
  const [portalLoading, setPortalLoading] = useState(false)
  const [portalError, setPortalError] = useState<string>('')

  const [plate, setPlate] = useState('')
  const [result, setResult] = useState<any>(null)
  const [searching, setSearching] = useState(false)

  // Camera scan
  const [showCamera, setShowCamera] = useState(false)
  const [scanStatus, setScanStatus] = useState('Point camera at license plate')
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [showViolation, setShowViolation] = useState(false)
  const [violation, setViolation] = useState({ type: '', location: '', notes: '', property: '', vehicle_color: '', vehicle_make: '', vehicle_model: '', vehicle_year: '' })
  // B71: decline-and-proceed state. Mirrors driver/page.tsx semantics.
  // B214: 'guest' added for guest_authorized plate scans (manager-vetted
  // multi-week authorizations). Same B71 override path as resident/visitor.
  const [declineModal, setDeclineModal] = useState<{ authorizedAs: 'resident' | 'visitor' | 'guest'; detail: string } | null>(null)
  const [pendingDecline, setPendingDecline] = useState<{ reason: DeclineReason; note: string | null } | null>(null)
  const [photos, setPhotos] = useState<File[]>([])
  const [violationVideo, setViolationVideo] = useState<File|null>(null)
  const [videoDuration, setVideoDuration] = useState<number|null>(null)
  const [uploadingVideo, setUploadingVideo] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  // B18 two-step submission state — mirrors the driver page.
  const [violationStage, setViolationStage] = useState<'form' | 'review'>('form')
  const [reviewViolation, setReviewViolation] = useState<ReviewViolation | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [unconfirmedDrafts, setUnconfirmedDrafts] = useState<ReviewViolation[]>([])
  // C2: post-confirmation media edit modal
  const [editMediaViolationId, setEditMediaViolationId] = useState<number | null>(null)
  // Phase 2a: Plan tab state — current calendar-month visitor-pass counts
  // per property. Populated by loadPlanData() when the Plan tab activates.
  const [visitorPassesThisMonth, setVisitorPassesThisMonth] = useState<Record<string, number>>({})
  const [planLoading, setPlanLoading] = useState(false)

  const [storageFacilities, setStorageFacilities] = useState<any[]>([])
  const [ticketTarget, setTicketTarget] = useState<any>(null)
  const [selectedStorage, setSelectedStorage] = useState('')
  const [towFee, setTowFee] = useState('')
  const [mileage, setMileage] = useState('')
  const [vin, setVin] = useState('')
  const [expandedTicketId, setExpandedTicketId] = useState<string | null>(null)

  const [violations, setViolations] = useState<any[]>([])
  const [violationDisputes, setViolationDisputes] = useState<any[]>([])
  const [violationFilter, setViolationFilter] = useState('today')
  const [violationSearch, setViolationSearch] = useState('')
  const [passes, setPasses] = useState<any[]>([])

  // Manage tab
  const [manageSection, setManageSection] = useState<'properties' | 'users' | 'drivers' | 'storage' | 'company' | 'auditlog'>('properties')
  // B120 Part 2 — CA-side TDLR capture state. Loaded on demand when
  // the Company sub-tab is opened; saved via update_my_company_tdlr RPC.
  const [companyTdlrInput, setCompanyTdlrInput] = useState<string>('')
  const [companyTdlrLoaded, setCompanyTdlrLoaded] = useState<boolean>(false)
  const [companyTdlrSaving, setCompanyTdlrSaving] = useState<boolean>(false)
  const [companyTdlrMsg, setCompanyTdlrMsg] = useState<string>('')
  const [manageLoaded, setManageLoaded] = useState(false)

  const [editingProperty, setEditingProperty] = useState<any>(null)
  const [showAddProperty, setShowAddProperty] = useState(false)
  // B51a: new properties can optionally land with expiration date + notes at
  // create time. PDF upload deferred to the Edit form because Storage paths
  // depend on the property_id, which doesn't exist until after INSERT.
  const [newProperty, setNewProperty] = useState({ name: '', address: '', city: '', state: '', zip: '', visitor_capacity: '', pm_name: '', pm_phone: '', pm_email: '', authorization_expiration_date: '', authorization_notes: '' })
  const [propMsg, setPropMsg] = useState('')
  const [logoUploadMsg, setLogoUploadMsg] = useState<Record<string,string>>({})

  const [companyUsers, setCompanyUsers] = useState<any[]>([])
  const [resetPwTarget, setResetPwTarget] = useState<string | null>(null)
  const [resetPwForm, setResetPwForm] = useState({ newPw: '', confirmPw: '' })
  const [resetPwMsg, setResetPwMsg] = useState('')
  const [showAddUser, setShowAddUser] = useState(false)
  // D2: name field added. Single-column "Full Name" capture matches the
  // existing drivers.name / residents.name pattern (no first/last split).
  // D1 Commit 2: password field removed — non-resident roles invite via
  // email (no temp password to capture), residents auto-generate via
  // generateTempPassword() inside createUser's resident branch.
  const [newUser, setNewUser] = useState({ name: '', email: '', role: 'manager', property: '' })
  const [userMsg, setUserMsg] = useState('')
  const [togglingUser, setTogglingUser] = useState<string | null>(null)

  const [companyDrivers, setCompanyDrivers] = useState<any[]>([])
  const [showAddDriver, setShowAddDriver] = useState(false)
  const [editingDriver, setEditingDriver] = useState<any>(null)
  const [newDriver, setNewDriver] = useState({ name: '', email: '', phone: '', operator_license: '', assigned_properties: [] as string[] })
  const [driverMsg, setDriverMsg] = useState('')

  const [allFacilities, setAllFacilities] = useState<any[]>([])
  const [showAddFacility, setShowAddFacility] = useState(false)
  // B120: vsf_license_number captured on CA add (display via Manage>Storage list).
  // CA edit of facilities is a pre-existing scope gap; admin portal handles edits.
  const [newFacility, setNewFacility] = useState({ name: '', address: '', phone: '', email: '', vsf_license_number: '' })
  const [facilityMsg, setFacilityMsg] = useState('')
  const [companyAuditLogs, setCompanyAuditLogs] = useState<any[]>([])
  const [auditDateFilter, setAuditDateFilter] = useState('week')
  const [auditSearch, setAuditSearch] = useState('')
  const [auditLoaded, setAuditLoaded] = useState(false)
  const [showActiveProps, setShowActiveProps] = useState(true)
  const [showActiveCompanyUsers, setShowActiveCompanyUsers] = useState(true)
  const [collapsedCAGroups, setCollapsedCAGroups] = useState<Set<string>>(new Set())
  function toggleCAGroup(role: string) {
    setCollapsedCAGroups(prev => { const next = new Set(prev); if (next.has(role)) next.delete(role); else next.add(role); return next })
  }
  const [showActiveCompanyDrivers, setShowActiveCompanyDrivers] = useState(true)
  const [exportMsg, setExportMsg] = useState('')

  // ── B214: Guest Authorizations state (CA portal — cross-property scope) ──
  // List spans ALL company properties; form has a property dropdown sourced
  // from CA's own company's active properties only (Jose lock 2026-06-20).
  // Residents are loaded on-demand when the form's property dropdown changes
  // (CA portal doesn't preload all residents like manager does).
  const [guestAuths, setGuestAuths] = useState<GuestAuth[]>([])
  const [showAddGuestAuth, setShowAddGuestAuth] = useState(false)
  const [newGuestAuth, setNewGuestAuth] = useState({
    property: '', guest_name: '', plate: '', state: 'TX', make: '', model: '', color: '',
    visiting_type: 'resident' as 'resident' | 'non_resident',
    visiting_unit: '', resident_email: '', non_resident_reason: '',
    start_date: todayIso(), end_date: addDays(todayIso(), 14),
  })
  const [caGuestAuthResidents, setCaGuestAuthResidents] = useState<any[]>([])
  const [guestAuthOverlapWarning, setGuestAuthOverlapWarning] = useState<GuestAuth | null>(null)
  const [guestAuthSubmitting, setGuestAuthSubmitting] = useState(false)
  const [guestAuthError, setGuestAuthError] = useState('')
  const [revokeGuestAuthTarget, setRevokeGuestAuthTarget] = useState<GuestAuth | null>(null)
  const [revokeReason, setRevokeReason] = useState('')
  const [renewGuestAuthTarget, setRenewGuestAuthTarget] = useState<GuestAuth | null>(null)
  const [renewDates, setRenewDates] = useState({ start_date: '', end_date: '' })
  // CA-only loading flag for the on-demand residents fetch (per Jose
  // 2026-06-20 carry-forward 2: "loading" state prevents the empty unit list
  // mid-fetch from being read as "this property has no residents").
  const [caGuestAuthResidentsLoading, setCaGuestAuthResidentsLoading] = useState(false)
  // B214 commit 4: renewal-patterns oversight (Q6 cheap insurance). Lazy-
  // loaded only when the collapsible section opens; chain-aware view filters
  // to >= 2 renewals so single renewals don't surface as noise.
  const [longChains, setLongChains] = useState<any[]>([])
  const [longChainsLoading, setLongChainsLoading] = useState(false)
  const [longChainsLoaded, setLongChainsLoaded] = useState(false)
  const [showRenewalPatterns, setShowRenewalPatterns] = useState(false)

  // ── Spaces v1 (commit 4) — CA cross-property dashboard + per-property single-view ──
  // Property form's per-type space-pool counts. Single shared state used by
  // BOTH create + edit forms (whichever is open). Add-only / additive per
  // Jose lock #3 — RPC skips existing labels; lowered counts silently no-op.
  const [spacePoolCounts, setSpacePoolCounts] = useState<Record<SpaceType, string>>({
    regular: '', carport: '', garage: '', covered: '', handicap: '', employee: '',
  })
  const [spacePoolSubmitting, setSpacePoolSubmitting] = useState(false)
  // Promise.allSettled results modal — surfaces per-type outcome after the
  // properties write succeeds. Atomic-feel without forcing N sequential calls.
  const [spacePoolResults, setSpacePoolResults] = useState<{
    property: string
    results: Array<{ type: SpaceType; status: 'success' | 'skipped' | 'failed'; count?: number; error?: string }>
  } | null>(null)

  // CA Spaces tab state (mirrors manager Spaces tab; property selector
  // gates everything else). Single-property view per Jose lock #1.
  const [caSelectedSpacesProperty, setCaSelectedSpacesProperty] = useState<string>('')
  const [caOccupancy, setCaOccupancy] = useState<Awaited<ReturnType<typeof fetchOccupancyDashboard>> | null>(null)
  const [caSpacesList, setCaSpacesList] = useState<Space[]>([])
  const [caSpacesListTotal, setCaSpacesListTotal] = useState(0)
  const [caSpacesListLoading, setCaSpacesListLoading] = useState(false)
  const [caSpacesFilters, setCaSpacesFilters] = useState<ListFilters>({
    type: null, status: 'available', showInactive: false, search: '',
  })
  const [caSpacesPage, setCaSpacesPage] = useState(0)
  const [caSpacesPageSize, setCaSpacesPageSize] = useState<number>(PAGE_SIZE_DESKTOP)
  const [caSpacesResidents, setCaSpacesResidents] = useState<ResidentOption[]>([])
  const [caSpacesError, setCaSpacesError] = useState('')
  const [caFlaggedMigrationCount, setCaFlaggedMigrationCount] = useState(0)
  const [caTargetAdd, setCaTargetAdd] = useState(false)
  const [caAddForm, setCaAddForm] = useState<{ type: SpaceType }>({ type: 'carport' })
  const [caTargetAssign, setCaTargetAssign] = useState<Space | null>(null)
  // v1.1: caAssignFormEmail is set by SearchableResidentPicker's onSelect.
  const [caAssignFormEmail, setCaAssignFormEmail] = useState('')
  // v1.1 multi-resident: caTargetReassign / caReassignFormEmail DROPPED.
  // "Reassign" is ambiguous in set-world; manager UX = 2 explicit clicks.
  const [caTargetFree, setCaTargetFree] = useState<Space | null>(null)
  // v1.1: per-resident free target. null = whole-space mode.
  const [caFreeResidentEmail, setCaFreeResidentEmail] = useState<string | null>(null)
  const [caTargetDecommission, setCaTargetDecommission] = useState<Space | null>(null)
  const [caTargetEdit, setCaTargetEdit] = useState<Space | null>(null)
  const [caEditForm, setCaEditForm] = useState<{ label: string; description: string; type: SpaceType; is_bundled: boolean }>({
    label: '', description: '', type: 'carport', is_bundled: false,
  })

  const [analyticsRange, setAnalyticsRange] = useState('6mo')
  const [analyticsLoaded, setAnalyticsLoaded] = useState(false)
  const [caAnalytics, setCAAnalytics] = useState<any>(null)

  useEffect(() => { loadUser() }, [])
  useEffect(() => { if (activeTab === 'analytics') fetchCAAnalytics() }, [activeTab, analyticsRange])

  // B66.4 — Billing tab data loader. Fires on tab activate; also re-
  // fires when the user returns from Stripe Portal (?from=portal in
  // the URL) so post-Portal changes surface immediately.
  useEffect(() => { if (activeTab === 'billing') loadBillingData() }, [activeTab])

  // B66.4 — URL-param tab restore for the Stripe Portal return-trip.
  // /api/billing/portal-session sets return_url to
  // /company_admin?tab=billing&from=portal so the customer lands back
  // on the Billing tab after making changes (vs the default Overview).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const tabParam = params.get('tab')
    if (tabParam === 'billing') setActiveTab('billing')
  }, [])
  // Phase 2a: Plan tab is standalone — fetches its own counts on activation
  // rather than depending on Manage tab's lifecycle.
  useEffect(() => { if (activeTab === 'plan') loadPlanData() }, [activeTab, selectedProperty])
  // B214: lazy-load guest auths on tab activation. CA scope = all active
  // company properties (cross-property; manager portal is single-property).
  useEffect(() => { if (activeTab === 'guest-auth' && properties.length > 0) refetchGuestAuths() }, [activeTab, properties])
  // ── Spaces v1 (commit 4) CA effects ──
  // Adaptive pageSize (25 mobile / 50 desktop) — same constants as manager.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 768px)')
    const apply = (m: boolean) => { setCaSpacesPageSize(m ? PAGE_SIZE_MOBILE : PAGE_SIZE_DESKTOP); setCaSpacesPage(0) }
    apply(mq.matches)
    const h = (e: MediaQueryListEvent) => apply(e.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [])
  // Property selector default — when the spaces tab activates AND no property
  // is yet selected, default to the first active company property so the
  // dashboard renders immediately. CA can switch via the dropdown.
  useEffect(() => {
    if (activeTab !== 'spaces' || caSelectedSpacesProperty) return
    const firstActive = properties.find(p => p.is_active)
    if (firstActive) setCaSelectedSpacesProperty(firstActive.name)
  }, [activeTab, properties, caSelectedSpacesProperty])
  // Dashboard refetch on property selection
  useEffect(() => {
    if (activeTab !== 'spaces' || !caSelectedSpacesProperty) return
    caRefetchSpacesDashboard()
  }, [activeTab, caSelectedSpacesProperty])
  // List refetch on filter/page/property change
  useEffect(() => {
    if (activeTab !== 'spaces' || !caSelectedSpacesProperty) return
    caRefetchSpacesList()
  }, [activeTab, caSelectedSpacesProperty, caSpacesFilters, caSpacesPage, caSpacesPageSize])
  // Residents pool for assign/reassign dropdowns
  useEffect(() => {
    if (activeTab !== 'spaces' || !caSelectedSpacesProperty) { setCaSpacesResidents([]); return }
    fetchActiveResidentsAtProperty(supabase, caSelectedSpacesProperty).then(setCaSpacesResidents)
  }, [activeTab, caSelectedSpacesProperty])
  // When the form's property dropdown changes, refetch residents at that
  // property to populate the unit dropdown options. caGuestAuthResidentsLoading
  // prevents the empty unit list mid-fetch from being read as "this property
  // has no residents" (Jose carry-forward 2 2026-06-20).
  useEffect(() => {
    if (!newGuestAuth.property) { setCaGuestAuthResidents([]); setCaGuestAuthResidentsLoading(false); return }
    let cancelled = false
    setCaGuestAuthResidentsLoading(true)
    ;(async () => {
      try {
        const { data } = await supabase.from('residents').select('email, name, unit, is_active').ilike('property', newGuestAuth.property).order('unit')
        if (!cancelled) setCaGuestAuthResidents(data || [])
      } finally {
        if (!cancelled) setCaGuestAuthResidentsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [newGuestAuth.property])

  useEffect(() => {
    if (showCamera && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
      videoRef.current.play().catch(() => {})
    }
  }, [showCamera])

  async function loadUser() {
    setLoading(true)
    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser) { window.location.href = '/login'; return }

    const { data: roleData } = await supabase
      .from('user_roles').select('*').ilike('email', authUser.email!).single()

    if (!roleData || (roleData.role !== 'company_admin' && roleData.role !== 'admin')) {
      window.location.href = '/login'; return
    }

    setUser(authUser)
    setRole(roleData)

    // B66.5 commit 4.3: account_state gate (extended from B65.2 baseline).
    // Admin role has no company, so it skips the gate entirely. For
    // company_admin, fetch the lifecycle state + route accordingly:
    //   active      → fall through, normal portal
    //   configuring → /signup/redeem/verify (finish activation; stays authed)
    //   past_due    → render banner above portal, allow normal use
    //   suspended   → /account-suspended (hard redirect; can re-auth to pay)
    //   cancelled   → /account-cancelled (signOut + hard redirect)
    //   null row    → fail CLOSED to /account-cancelled (covers RLS-blocked
    //                 SELECT + orphaned user_roles + cancelled+is_active=false
    //                 legacy soft-delete edge case)
    if (roleData.role !== 'admin' && roleData.company) {
      const { data: companyRow } = await supabase
        .from('companies')
        .select('id, name, display_name, account_state, past_due_grace_until')
        .ilike('name', roleData.company)
        .maybeSingle()
      // Defensive null-check — fail closed. See app/lib/portal-account-gate.ts
      // header for the same pattern applied to the 3 customer portals.
      if (!companyRow || !companyRow.account_state) {
        window.location.href = '/account-cancelled'
        return
      }
      // B66.5.1: persist account_state for downstream Q4 defense-in-depth
      // (Drivers tab Resend button disable on suspended/cancelled).
      setCompanyAccountState(companyRow.account_state as string)
      const gate = gateAccountState(companyRow.account_state as AccountState)
      if (gate.kind === 'redirect') {
        if (gate.reason === 'cancelled') await supabase.auth.signOut()
        window.location.href = gate.href
        return
      }
      if (gate.kind === 'allow_with_banner' && gate.banner === 'past_due') {
        const daysRemaining = companyRow.past_due_grace_until
          ? Math.max(0, Math.ceil(
              (new Date(companyRow.past_due_grace_until).getTime() - Date.now()) /
              (24 * 60 * 60 * 1000)
            ))
          : 0
        const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'
        // B66.5.1: pass roleData.role so CA + admin see Update Payment CTA.
        // (Non-CA viewers would only see this banner from the 3 customer
        //  portals, which already pass their own role via the helper.)
        setPastDueBanner({
          companyName: companyRow.display_name ?? companyRow.name,
          daysRemainingUntilSuspension: daysRemaining,
          updatePaymentUrl: `${APP_URL}/company_admin?tab=billing`,
          companyId: companyRow.id,
          userRole: roleData.role,
        })
      }
    }

    let props: any[] = []
    if (roleData.role === 'admin') {
      const { data } = await supabase.from('properties').select('*').order('name')
      props = data || []
    } else {
      const { data } = await supabase.from('properties').select('*').ilike('company', roleData.company).order('name')
      props = data || []
    }

    setProperties(props)
    if (props.length > 0) {
      setSelectedProperty(props[0])
      await fetchAll(props[0])
    }
    setLoading(false)
    fetchStorageFacilities()
    loadUnconfirmedDrafts()
  }

  async function switchProperty(name: string) {
    const prop = properties.find(p => p.name === name)
    if (!prop) return
    setSelectedProperty(prop)
    setResult(null); setTicketTarget(null); setExpandedTicketId(null)
    await fetchAll(prop)
  }

  async function fetchAll(prop: any) {
    await Promise.all([fetchViolations(prop.name), fetchStats(prop.name), fetchPasses(prop.name)])
  }

  async function fetchStats(property: string) {
    const sixmo = new Date(); sixmo.setMonth(sixmo.getMonth() - 6)
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const week = new Date(); week.setDate(week.getDate() - 7)
    const [{ data: vehicles }, { data: viol }] = await Promise.all([
      supabase.from('vehicles').select('id').ilike('property', property).eq('is_active', true),
      // B175 — analytics counter excludes voided violations.
      supabase.from('violations').select('created_at').eq('is_confirmed', true).is('voided_at', null).ilike('property', property).gte('created_at', sixmo.toISOString()),
    ])
    const todayCount = (viol || []).filter(v => new Date(v.created_at) >= today).length
    const weekCount = (viol || []).filter(v => new Date(v.created_at) >= week).length
    setStats(s => ({ ...s, total_vehicles: vehicles?.length || 0, violations_today: todayCount, violations_week: weekCount }))
  }

  async function fetchStorageFacilities() {
    // B154 — defensive .eq('company', ...) alongside company-scoped RLS.
    // RLS gates functionally; the explicit filter makes scope legible
    // in the code (Class-B defensive-legibility; same principle as B150).
    const { data } = await supabase
      .from('storage_facilities')
      .select('*')
      .eq('is_active', true)
      .ilike('company', role?.company ?? '')
      .order('name')
    setStorageFacilities(data || [])
  }

  async function fetchViolations(property: string) {
    const sixmo = new Date(); sixmo.setMonth(sixmo.getMonth() - 6)
    const { data } = await supabase.from('violations')
      .select('*, photo_rows:violation_photos(id, photo_url, removed_at), video_rows:violation_videos(id, video_url, removed_at)')
      .eq('is_confirmed', true)
      .ilike('property', property).gte('created_at', sixmo.toISOString())
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
    const { data: ddata } = await supabase.from('dispute_requests').select('*').ilike('property', property)
    setViolationDisputes(ddata || [])
  }

  async function fetchPasses(property: string) {
    const now = new Date().toISOString()
    const { data } = await supabase.from('visitor_passes').select('*')
      .ilike('property', property).gte('expires_at', now).eq('is_active', true)
      .order('created_at', { ascending: false })
    setPasses(data || [])
    setStats(s => ({ ...s, active_passes: data?.length || 0 }))
  }

  async function auditLog(action: string, table_name: string, record_id: string, new_values: any) {
    // B155.2 F4 — audit_logs WITH CHECK enforces self-attribution.
    // Helper closes over `user?.email` (always self-attributing by
    // construction), but guard against a null user race.
    if (!user?.email) return
    await supabase.from('audit_logs').insert([{
      user_email: user.email, action, table_name,
      record_id: String(record_id), new_values,
      created_at: new Date().toISOString()
    }])
  }

  async function fetchCompanyAuditLogs() {
    setAuditLoaded(false)
    const userEmails = companyUsers.map(u => (u.email || '').toLowerCase())
    const companyName = (role?.company || '').toLowerCase()
    const { data } = await supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    const filtered = (data || []).filter(log =>
      userEmails.includes((log.user_email || '').toLowerCase()) ||
      JSON.stringify(log.new_values || {}).toLowerCase().includes(companyName)
    )
    setCompanyAuditLogs(filtered)
    setAuditLoaded(true)
  }

  // B66.4 — Billing tab loader. Reads the companies row for the
  // current user's company; populates billingData. Uses the same
  // ilike(name, company) match that the auth-gate at line 174 uses.
  async function loadBillingData() {
    setBillingLoading(true)
    setPortalError('')
    const { data: { user } } = await supabase.auth.getUser()
    if (!user?.email) { setBillingLoading(false); return }
    const { data: roleRow } = await supabase
      .from('user_roles')
      .select('company')
      .ilike('email', user.email)
      .single()
    if (!roleRow?.company) { setBillingLoading(false); return }
    const { data: companyRow, error } = await supabase
      .from('companies')
      .select('stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end, cancel_at_period_end, address, billing_city, billing_state, billing_postal_code, billing_country')
      .ilike('name', roleRow.company)
      .single()
    setBillingLoading(false)
    if (error || !companyRow) return
    setBillingData(companyRow)
  }

  // B66.4 — opens Stripe Customer Portal session. POSTs to the
  // /api/billing/portal-session route, which returns { url } on
  // success; we redirect the same tab. Pre-flight ask D.3 + D.4:
  // disabled button + spinner while loading; error inline if
  // creation fails (don't 500 the page).
  async function openBillingPortal() {
    setPortalLoading(true)
    setPortalError('')
    try {
      const res = await fetch('/api/billing/portal-session', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setPortalError(body.error || `Couldn't open the billing portal (HTTP ${res.status}).`)
        setPortalLoading(false)
        return
      }
      const body = await res.json()
      if (!body.url) {
        setPortalError('Portal session created but no URL returned.')
        setPortalLoading(false)
        return
      }
      window.location.href = body.url
    } catch (e) {
      setPortalError('Network error opening billing portal: ' + (e as Error).message)
      setPortalLoading(false)
    }
  }

  async function loadManageData() {
    await Promise.all([fetchCompanyUsers(), fetchCompanyDrivers(), fetchAllFacilitiesManage()])
    setManageLoaded(true)
  }

  async function fetchCompanyUsers() {
    if (!role?.company) return
    const { data } = await supabase.from('user_roles').select('*').ilike('company', role.company).neq('role', 'admin').order('email')
    setCompanyUsers(data || [])

    // B144 (B66.5 c4.3): fetch activation status for driver + resident
    // emails (the two roles where Resend Invite is offered). Other roles
    // (manager/leasing_agent) use the existing Active/Inactive badge.
    const inviteScopedEmails = (data || [])
      .filter((u: any) => u.role === 'driver' || u.role === 'resident')
      .map((u: any) => String(u.email).toLowerCase())
    if (inviteScopedEmails.length > 0) {
      try {
        const res = await fetch('/api/admin/invite-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emails: inviteScopedEmails }),
        })
        if (res.ok) {
          const body = await res.json()
          setInviteStatuses(body.statusByEmail ?? {})
        }
      } catch (e) {
        console.error('[invite-status] fetch failed', e)
      }
    }
  }

  // B144 (B66.5 c4.3): per-row resend handler. Disables button for 60s
  // client-side (server has its own audit-based was_rapid_resend flag).
  async function resendInviteForUser(targetEmail: string) {
    const lc = targetEmail.toLowerCase()
    if (resendingEmail || (resendDisabledUntil[lc] ?? 0) > Date.now()) return
    setResendingEmail(lc)
    try {
      const res = await fetch('/api/admin/resend-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_email: lc }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert('Resend failed: ' + (body.error || res.statusText))
      } else {
        // 60s disable window (matches server-side rapid-resend window).
        setResendDisabledUntil(prev => ({ ...prev, [lc]: Date.now() + 60_000 }))
        if (body.warning) alert(body.warning)
      }
    } catch (e) {
      alert('Resend failed: ' + (e as Error).message)
    } finally {
      setResendingEmail(null)
    }
  }

  async function fetchCompanyDrivers() {
    if (!role?.company) return
    const { data } = await supabase.from('drivers').select('*').ilike('company', role.company).order('name')
    setCompanyDrivers(data || [])

    // B66.5.1 (Item 2): extend invite-status fetch to cover the Drivers tab
    // surface. Same /api/admin/invite-status endpoint as fetchCompanyUsers;
    // results merged into the shared inviteStatuses Map via spread (order-
    // independent — fetchCompanyUsers + fetchCompanyDrivers can complete in
    // either order without losing entries, per Q5 lock).
    const driverEmails = (data || [])
      .map((d: any) => String(d.email).toLowerCase())
      .filter((e: string) => e.length > 0)
    if (driverEmails.length > 0) {
      try {
        const res = await fetch('/api/admin/invite-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emails: driverEmails }),
        })
        if (res.ok) {
          const body = await res.json()
          setInviteStatuses(prev => ({ ...prev, ...(body.statusByEmail ?? {}) }))
        }
      } catch (e) {
        console.error('[invite-status] drivers fetch failed', e)
      }
    }
  }

  // ── B214: Guest Authorizations handlers (CA portal) ────────────────
  // Same shape as manager portal but with CA's cross-property scope:
  // list spans all company properties; form has a property dropdown.
  // Property dropdown sources from CA's own company's ACTIVE properties
  // only (Jose lock 2026-06-20: RPC rejects out-of-company properties,
  // but UI shouldn't offer one it'll then reject).
  async function refetchGuestAuths() {
    if (properties.length === 0) return
    const propertyList = properties.map(p => p.name)
    const list = await fetchActiveGuestAuths(supabase, { propertyList })
    setGuestAuths(list)
  }

  async function checkGuestAuthOverlap(): Promise<GuestAuth | null> {
    if (!newGuestAuth.property || !newGuestAuth.plate || !newGuestAuth.start_date || !newGuestAuth.end_date) return null
    const overlap = await findOverlappingActiveAuth(supabase, {
      plate: newGuestAuth.plate,
      property: newGuestAuth.property,
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
      if (!newGuestAuth.property) { setGuestAuthError('Property required'); return }
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

      // Named params (Jose lock 2026-06-20).
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
        p_property: newGuestAuth.property,
        p_start_date: newGuestAuth.start_date,
        p_end_date: newGuestAuth.end_date,
      })
      if (error) { setGuestAuthError(error.message); return }
      setNewGuestAuth({
        property: '', guest_name: '', plate: '', state: 'TX', make: '', model: '', color: '',
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

  // B214 commit 4: Q6 oversight report — chains with >= 2 renewals (i.e.,
  // 3+ grants total). Chain-aware via the guest_auth_long_chains view's
  // recursive renewed_from_id walk (Jose lock 2026-06-20: a normal renewal
  // creates one chain, not multiple overlapping grants — the view treats it
  // as one logical chain so legit renewals don't read as duplicates).
  //
  // Lazy: fires only when the manager actually expands the section. No
  // pre-fetch on tab activation (saves a query for the common case where
  // no one cares about renewal patterns on a given visit).
  async function loadLongChains() {
    setLongChainsLoading(true)
    try {
      const { data } = await supabase.from('guest_auth_long_chains').select('*')
      setLongChains(data || [])
      setLongChainsLoaded(true)
    } finally {
      setLongChainsLoading(false)
    }
  }

  // ── Spaces v1 commit 4 — property-form per-type pool helper ───────
  // Fires Promise.allSettled over the non-zero type counts. Builds the
  // results-modal payload (per-type status + count or error). NON-FATAL —
  // properties write has already succeeded; this is the secondary phase.
  // Idempotent (RPC skips existing labels), safe to retry the failed types.
  async function runSpacePoolGenerate(propertyName: string, retryTypes?: SpaceType[]) {
    setSpacePoolSubmitting(true)
    try {
      const typesToRun = (retryTypes ?? SPACE_TYPES).filter(t => {
        const v = parseInt(spacePoolCounts[t] || '0', 10)
        return Number.isFinite(v) && v > 0
      })
      // Parallel — N ≤ 6, no concurrency issue. Each generate_spaces_from_pool
      // call is atomic (its own transaction).
      const settled = await Promise.allSettled(typesToRun.map(t =>
        supabase.rpc('generate_spaces_from_pool', {
          p_property: propertyName,
          p_type: t,
          p_count: parseInt(spacePoolCounts[t] || '0', 10),
          p_label_prefix: null,
        }).then(({ data, error }) => ({ type: t, data, error }))
      ))
      // Build per-type results
      const results: Array<{ type: SpaceType; status: 'success'|'skipped'|'failed'; count?: number; error?: string }> = []
      // Include skipped (count=0) for all 6 types when not retrying — the
      // results modal shows the full picture, not just what was attempted.
      if (!retryTypes) {
        for (const t of SPACE_TYPES) {
          const v = parseInt(spacePoolCounts[t] || '0', 10)
          if (!Number.isFinite(v) || v <= 0) {
            results.push({ type: t, status: 'skipped' })
          }
        }
      }
      settled.forEach((r, idx) => {
        const t = typesToRun[idx]
        if (r.status === 'fulfilled') {
          if (r.value.error) {
            results.push({ type: t, status: 'failed', error: r.value.error.message })
          } else {
            results.push({ type: t, status: 'success', count: (r.value.data as number) ?? 0 })
          }
        } else {
          results.push({ type: t, status: 'failed', error: r.reason?.message ?? 'Unknown error' })
        }
      })
      setSpacePoolResults({ property: propertyName, results })
    } finally {
      setSpacePoolSubmitting(false)
    }
  }

  // ── Spaces v1 commit 4 — CA Spaces tab fetchers + 6 RPC submitters ──
  // Same shape as the manager Spaces tab handlers; parameterized by
  // caSelectedSpacesProperty (from the property selector dropdown).
  // Single-property view per Jose lock #1 (no cross-property aggregate).
  async function caRefetchSpacesDashboard() {
    if (!caSelectedSpacesProperty) return
    const dash = await fetchOccupancyDashboard(supabase, caSelectedSpacesProperty)
    setCaOccupancy(dash)
    const { count: flagged } = await supabase
      .from('spaces').select('*', { count: 'exact', head: true })
      .ilike('property', caSelectedSpacesProperty).not('migration_note', 'is', null)
    setCaFlaggedMigrationCount(flagged ?? 0)
  }

  async function caRefetchSpacesList() {
    if (!caSelectedSpacesProperty) return
    setCaSpacesListLoading(true)
    try {
      const { rows, totalCount } = await fetchSpacesList(supabase, caSelectedSpacesProperty, caSpacesFilters, caSpacesPage, caSpacesPageSize)
      setCaSpacesList(rows)
      setCaSpacesListTotal(totalCount)
    } finally {
      setCaSpacesListLoading(false)
    }
  }

  async function caSubmitAddSingleSpace() {
    setCaSpacesError('')
    const { error } = await supabase.rpc('generate_spaces_from_pool', {
      p_property: caSelectedSpacesProperty, p_type: caAddForm.type, p_count: 1, p_label_prefix: null,
    })
    if (error) { setCaSpacesError(error.message); return }
    setCaTargetAdd(false); setCaAddForm({ type: 'carport' })
    await caRefetchSpacesDashboard(); await caRefetchSpacesList()
  }

  async function caSubmitAssignSpace() {
    if (!caTargetAssign) return
    setCaSpacesError('')
    const { error } = await supabase.rpc('assign_space', {
      p_space_id: caTargetAssign.id, p_resident_email: caAssignFormEmail,
    })
    if (error) { setCaSpacesError(error.message); return }
    setCaTargetAssign(null); setCaAssignFormEmail('')
    await caRefetchSpacesDashboard(); await caRefetchSpacesList()
  }

  // v1.1: caSubmitReassignSpace DROPPED. Manager UX = 2 explicit clicks
  // (per-resident free + assign). Same as the manager portal in commit 3.

  // v1.1: caSubmitFreeSpace gains optional p_resident_email routing.
  //   caFreeResidentEmail=null → whole-space free
  //   caFreeResidentEmail set  → per-resident remove
  // INVARIANT: never touches vehicles or residents.is_active.
  async function caSubmitFreeSpace() {
    if (!caTargetFree) return
    setCaSpacesError('')
    const { error } = await supabase.rpc('free_space', {
      p_space_id:       caTargetFree.id,
      p_reason:         'manual_free',
      p_resident_email: caFreeResidentEmail,
    })
    if (error) { setCaSpacesError(error.message); return }
    setCaTargetFree(null); setCaFreeResidentEmail(null)
    await caRefetchSpacesDashboard(); await caRefetchSpacesList()
  }

  async function caSubmitDecommissionSpace() {
    if (!caTargetDecommission) return
    setCaSpacesError('')
    const { error } = await supabase.rpc('decommission_space', {
      p_space_id: caTargetDecommission.id,
    })
    if (error) { setCaSpacesError(error.message); return }
    setCaTargetDecommission(null)
    await caRefetchSpacesDashboard(); await caRefetchSpacesList()
  }

  async function caSubmitEditMetadata() {
    if (!caTargetEdit) return
    setCaSpacesError('')
    const { error } = await supabase.rpc('update_space_metadata', {
      p_space_id: caTargetEdit.id,
      p_label: caEditForm.label,
      p_description: caEditForm.description || null,
      p_type: caEditForm.type,
      p_is_bundled: caEditForm.is_bundled,
    })
    if (error) { setCaSpacesError(error.message); return }
    setCaTargetEdit(null)
    await caRefetchSpacesDashboard(); await caRefetchSpacesList()
  }

  // Phase 2a: standalone fetch for the Plan tab. Refreshes driver count
  // (so usage doesn't depend on whether the user visited Manage) and
  // computes per-property visitor-pass usage for the current calendar
  // month (PM-only signal, but the query is cheap on enforcement too).
  async function loadPlanData() {
    if (!role?.company) return
    setPlanLoading(true)
    // Drivers — same query as fetchCompanyDrivers, decoupled so the Plan
    // tab works even if Manage was never opened.
    const { data: drvData } = await supabase.from('drivers').select('*')
      .ilike('company', role.company).order('name')
    setCompanyDrivers(drvData || [])
    // Visitor passes this calendar month, scoped to the company's
    // properties. Aggregated client-side into a property-name → count map.
    const propNames = (properties || []).map(p => p.name).filter(Boolean)
    if (propNames.length > 0) {
      const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
      const { data: passData } = await supabase.from('visitor_passes')
        .select('property')
        .in('property', propNames)
        .gte('created_at', monthStart)
      const counts: Record<string, number> = {}
      for (const p of propNames) counts[p] = 0
      for (const row of passData || []) {
        const key = String(row.property || '')
        if (key in counts) counts[key]++
      }
      setVisitorPassesThisMonth(counts)
    } else {
      setVisitorPassesThisMonth({})
    }
    setPlanLoading(false)
  }

  async function fetchAllFacilitiesManage() {
    // B154 — defensive .eq('company', ...) alongside company-scoped RLS.
    // Manage > Storage tab — CA's own company's facilities only.
    const { data } = await supabase
      .from('storage_facilities')
      .select('*')
      .eq('is_active', true)
      .ilike('company', role?.company ?? '')
      .order('name')
    setAllFacilities(data || [])
  }

  async function reloadProperties() {
    const { data } = await supabase.from('properties').select('*').ilike('company', role?.company || '').order('name')
    setProperties(data || [])
  }

  // B165 — open the forced-upgrade modal at a cap-hit moment. Pre-fills
  // the next within-track tier; if customer's already at the top tier,
  // shows the legacy "limit reached" message instead (no upgrade path).
  function offerForcedUpgrade(triggerReason: string, retry: () => void): boolean {
    const ctx = getCompanyContext()
    const currentTier = (ctx.tier || '').toLowerCase()
    const currentTrack = (ctx.tier_type === 'pm' ? 'property_management' : ctx.tier_type) as 'enforcement' | 'property_management'
    const nextTier = nextWithinTrackTier(currentTier, currentTrack)
    const companyId = getCachedCompanyId()
    if (!nextTier || !companyId) return false
    setTierUpgradeCtx({
      companyId,
      currentTier,
      targetTier: nextTier,
      targetTrack: currentTrack,
      triggerReason,
    })
    setPendingTierUpgradeRetry(() => retry)
    return true
  }

  async function saveProperty() {
    if (!newProperty.name) { setPropMsg('Property name is required'); return }
    const ctx = getCompanyContext()
    const activeCount = properties.filter(p => p.is_active).length
    if (!isUnderLimit(FEATURE_FLAGS.MAX_PROPERTIES, activeCount, ctx)) {
      const limit = getLimit(FEATURE_FLAGS.MAX_PROPERTIES, ctx)
      const opened = offerForcedUpgrade(
        `You're at your ${limit}-property limit. Upgrade to continue.`,
        () => { setPropMsg(''); saveProperty() },
      )
      if (!opened) {
        setPropMsg(`Property limit reached (${limit}). Contact support to expand your account.`)
      }
      return
    }
    setPropMsg('')
    const { data, error: insErr } = await supabase.from('properties').insert([{
      name: newProperty.name, address: newProperty.address || null,
      city: newProperty.city || null, state: newProperty.state || null,
      zip: newProperty.zip || null,
      visitor_capacity: newProperty.visitor_capacity ? parseInt(newProperty.visitor_capacity) : null,
      pm_name: newProperty.pm_name || null, pm_phone: newProperty.pm_phone || null,
      pm_email: newProperty.pm_email || null, company: role?.company, is_active: true,
      // B51a: optional auth fields at create time. PDF upload deferred to Edit form.
      authorization_expiration_date: newProperty.authorization_expiration_date || null,
      authorization_notes: newProperty.authorization_notes || null,
    }]).select().single()
    if (insErr) { setPropMsg('Error: ' + insErr.message); return }
    await auditLog('create_property', 'properties', data.id, { name: newProperty.name, company: role?.company })

    // B147 3b — sync to Stripe AFTER DB write succeeds. Non-throwing per
    // helper contract; UX path is uninterrupted regardless of outcome.
    // Helper handles all skip cases (no-sub, send_invoice, etc); silent
    // on success / expected-skip actions.
    const companyIdForSync = getCachedCompanyId()
    if (companyIdForSync === null) {
      console.warn('[B147-sync-skipped-no-companyid]', { site: 'saveProperty', propertyId: data.id })
    } else {
      const r = await callSyncOnAdd(companyIdForSync,'property')
      if (!r.ok) console.warn('[B147-sync-failed]', { site: 'saveProperty', companyId: companyIdForSync, propertyId: data.id, reason: r.reason })
    }

    setPropMsg('Property added!')
    setNewProperty({ name: '', address: '', city: '', state: '', zip: '', visitor_capacity: '', pm_name: '', pm_phone: '', pm_email: '', authorization_expiration_date: '', authorization_notes: '' })
    setShowAddProperty(false)
    await reloadProperties()

    // Spaces v1 commit 4 — fire per-type space pool generation if any
    // non-zero counts were entered. Promise.allSettled inside the helper
    // surfaces per-type results in a modal. Property is already saved;
    // pool generation is the secondary phase (non-fatal if any type fails).
    const anyPoolCount = SPACE_TYPES.some(t => parseInt(spacePoolCounts[t] || '0', 10) > 0)
    if (anyPoolCount) {
      await runSpacePoolGenerate(newProperty.name)
      setSpacePoolCounts({ regular: '', carport: '', garage: '', covered: '', handicap: '', employee: '' })
    }
  }

  async function updateProperty() {
    if (!editingProperty) return
    setPropMsg('')
    const { id, company, created_at, ...fields } = editingProperty
    // B51a: normalize empty strings to null for the auth fields so DATE
    // doesn't choke on '' and notes don't store empty strings as data.
    const normalizedFields = {
      ...fields,
      visitor_capacity: fields.visitor_capacity ? parseInt(fields.visitor_capacity) : null,
      authorization_expiration_date: fields.authorization_expiration_date || null,
      authorization_notes: fields.authorization_notes || null,
    }
    const { error: updErr } = await supabase.from('properties').update(normalizedFields).eq('id', id)
    if (updErr) { setPropMsg('Error: ' + updErr.message); return }

    // B51a granular audit: detect auth-field changes against the pre-edit
    // cached state in `properties` and emit per-field actions. Other changes
    // continue to emit the existing 'update_property' action.
    const oldProp = properties.find(p => p.id === id) as any
    const oldExpiration = oldProp?.authorization_expiration_date ?? null
    const newExpiration = normalizedFields.authorization_expiration_date ?? null
    const oldNotes = oldProp?.authorization_notes ?? null
    const newNotes = normalizedFields.authorization_notes ?? null
    // PDF column is mutated by uploadAuthPdf / removeAuthPdf / replaceAuthPdf
    // directly, not through this form — no PDF diff to log here.

    const nonAuthFields: Record<string, any> = { ...normalizedFields }
    delete nonAuthFields.authorization_expiration_date
    delete nonAuthFields.authorization_notes
    delete nonAuthFields.authorization_pdf_path
    // Compare any non-auth field against old to decide whether to log update_property.
    const nonAuthChanged = Object.keys(nonAuthFields).some(k => (oldProp?.[k] ?? null) !== (nonAuthFields[k] ?? null))
    if (nonAuthChanged) {
      await auditLog('update_property', 'properties', String(id), nonAuthFields)
    }
    if (oldExpiration !== newExpiration) {
      await auditLog('update_authorization_expiration', 'properties', String(id), { old_date: oldExpiration, new_date: newExpiration })
    }
    if (oldNotes !== newNotes) {
      // Per B51a decision 2: log only "changed: true" — never capture
      // notes content, length, or any content-shape metadata.
      await auditLog('update_authorization_notes', 'properties', String(id), { changed: true })
    }

    setPropMsg('Property updated!')
    const editedPropertyName = editingProperty.name  // capture for pool gen below
    setEditingProperty(null)
    await reloadProperties()

    // Spaces v1 commit 4 — same per-type pool generation as create path.
    // Additive (RPC skips existing labels per Jose lock #3). If CA entered
    // 50 carports on a property already at 30, the RPC generates CP-31..CP-80
    // (50 new). Lowered counts no-op silently. NO decrement path; removal
    // is per-space decommission via the Spaces tab.
    const anyPoolCount = SPACE_TYPES.some(t => parseInt(spacePoolCounts[t] || '0', 10) > 0)
    if (anyPoolCount) {
      await runSpacePoolGenerate(editedPropertyName)
      setSpacePoolCounts({ regular: '', carport: '', garage: '', covered: '', handicap: '', employee: '' })
    }
  }

  // B51a: standalone PDF handlers. Each does its own DB UPDATE + audit log,
  // independent of the Save Changes flow. Eager-write model means orphan
  // bucket files possible if user cancels mid-flow — accepted for MVP; the
  // file lives in storage but properties.authorization_pdf_path is what the
  // app considers authoritative. Phase 2 storage cleanup cron (B26) will
  // sweep orphans if/when it ships.
  async function uploadAuthPdf(propertyId: number, file: File, replaceOldPath: string | null = null) {
    if (file.size > 10 * 1024 * 1024) { setPropMsg('PDF exceeds 10MB limit'); return }
    if (file.type !== 'application/pdf') { setPropMsg('Only PDF files accepted'); return }
    const path = `${propertyId}/${Date.now()}.pdf`
    const { error: upErr } = await supabase.storage
      .from('property-authorizations')
      .upload(path, file, { contentType: 'application/pdf' })
    if (upErr) { setPropMsg('Upload failed: ' + upErr.message); return }
    const { error: updErr } = await supabase.from('properties').update({ authorization_pdf_path: path }).eq('id', propertyId)
    if (updErr) { setPropMsg('Update failed: ' + updErr.message); return }
    if (replaceOldPath) {
      await auditLog('replace_authorization_pdf', 'properties', String(propertyId), { old_path: replaceOldPath, new_path: path, filename: file.name, file_size: file.size })
    } else {
      await auditLog('upload_authorization_pdf', 'properties', String(propertyId), { path, filename: file.name, file_size: file.size })
    }
    // Reflect locally so the edit form re-renders with the new path.
    setEditingProperty((p: any) => p && p.id === propertyId ? { ...p, authorization_pdf_path: path } : p)
    await reloadProperties()
    setPropMsg(replaceOldPath ? 'PDF replaced.' : 'PDF uploaded.')
  }

  async function removeAuthPdf(propertyId: number, oldPath: string) {
    if (!confirm('Remove the authorization PDF? The file stays in storage for audit retention, but the property no longer references it.')) return
    const { error } = await supabase.from('properties').update({ authorization_pdf_path: null }).eq('id', propertyId)
    if (error) { setPropMsg('Remove failed: ' + error.message); return }
    await auditLog('remove_authorization_pdf', 'properties', String(propertyId), { old_path: oldPath })
    setEditingProperty((p: any) => p && p.id === propertyId ? { ...p, authorization_pdf_path: null } : p)
    await reloadProperties()
    setPropMsg('PDF removed.')
  }

  async function viewAuthPdf(propertyId: number) {
    const res = await fetch(`/api/properties/${propertyId}/authorization-pdf-url`)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert('Could not load PDF: ' + (json.error || res.statusText))
      return
    }
    const { url } = await res.json()
    window.open(url, '_blank')
  }

  async function uploadLogo(file: File, pathPrefix: string, slot: string, onSuccess: (url: string) => void) {
    if (file.size > 2 * 1024 * 1024) {
      setLogoUploadMsg(m => ({ ...m, [slot]: 'File exceeds 2MB limit' }))
      return
    }
    setLogoUploadMsg(m => ({ ...m, [slot]: 'Uploading...' }))
    const ext = file.name.split('.').pop() || 'png'
    const filePath = `${pathPrefix}-${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('logos').upload(filePath, file, { upsert: true })
    if (error) {
      setLogoUploadMsg(m => ({ ...m, [slot]: 'Upload failed: ' + error.message }))
      return
    }
    const { data: urlData } = supabase.storage.from('logos').getPublicUrl(filePath)
    onSuccess(urlData.publicUrl)
    setLogoUploadMsg(m => ({ ...m, [slot]: 'Logo uploaded!' }))
    setTimeout(() => setLogoUploadMsg(m => ({ ...m, [slot]: '' })), 3000)
  }

  async function togglePropertyActive(prop: any) {
    const wasActive = prop.is_active

    // B147 3b — tier-gate reactivation symmetrically with saveProperty.
    // Without this gate, a customer at cap could reactivate a
    // deactivated unit to push active count over cap, then syncOnAdd
    // would charge for the over-cap unit. The cap is the UI's source
    // of truth; syncOnAdd trusts it was enforced before the DB write.
    if (!wasActive) {
      const ctx = getCompanyContext()
      const currentActiveCount = properties.filter(p => p.is_active).length
      if (!isUnderLimit(FEATURE_FLAGS.MAX_PROPERTIES, currentActiveCount, ctx)) {
        const limit = getLimit(FEATURE_FLAGS.MAX_PROPERTIES, ctx)
        const opened = offerForcedUpgrade(
          `You're at your ${limit}-property limit. Upgrade to reactivate this property.`,
          () => { setPropMsg(''); togglePropertyActive(prop) },
        )
        if (!opened) {
          setPropMsg(`Property limit reached (${limit}). Contact support to expand your account.`)
        }
        return
      }
    }

    const { error: updErr } = await supabase.from('properties').update({ is_active: !wasActive }).eq('id', prop.id)
    if (updErr) { setPropMsg('Error: ' + updErr.message); return }
    await auditLog(wasActive ? 'deactivate_property' : 'activate_property', 'properties', prop.id, { is_active: !wasActive })

    // B147 3b — sync ONLY on reactivation (false→true). Deactivation
    // defers to renewal trim per locked decision; no Stripe call on
    // toggle-off. Reactivation within prepaid floor returns
    // 'noop_within_floor' from the helper (reactivation-by-construction).
    if (!wasActive) {
      const companyIdForSync = getCachedCompanyId()
      if (companyIdForSync === null) {
        console.warn('[B147-sync-skipped-no-companyid]', { site: 'togglePropertyActive', propertyId: prop.id })
      } else {
        const r = await callSyncOnAdd(companyIdForSync,'property')
        if (!r.ok) console.warn('[B147-sync-failed]', { site: 'togglePropertyActive', companyId: companyIdForSync, propertyId: prop.id, reason: r.reason })
      }
    }

    await reloadProperties()
  }

  async function createUser() {
    const isResident = newUser.role === 'resident'
    if (!newUser.email || !newUser.role) { setUserMsg('Email and role are required'); return }
    setUserMsg('Creating...')

    const targetEmail = newUser.email.trim().toLowerCase()
    const propertyArray = newUser.property
      ? newUser.property.split('|').map(p => p.trim()).filter(Boolean)
      : []

    if (isResident) {
      // Resident path — UNCHANGED from D2. CA hands the temp password
      // to the resident manually (typically on the phone at creation
      // time). See app/api/admin/invite-user/route.ts header for why
      // residents weren't folded into the invite-by-email arc.
      const passwordToUse = generateTempPassword()
      const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL
      const { data: { session } } = await supabase.auth.getSession()
      const swiftUrl = (fnBase ?? '') + '/swift-handler'
      try {
        const res = await fetch(swiftUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
          body: JSON.stringify({ action: 'create_user', email: newUser.email, password: passwordToUse })
        })
        const json = await res.json()
        if (!res.ok) { setUserMsg('Error: ' + (json.error || 'Failed to create auth account')); return }
      } catch (e: any) { setUserMsg('Error: ' + e.message); return }
      // Wrap post-auth steps in try/catch with rollback so the manager
      // never sees "success + temp password" when the user can't actually
      // log in.
      let residentInserted = false
      try {
        // D2: pass p_name through to user_roles.name. RPC's 5-arg signature
        // (post-2026-06-13 migration) accepts p_name with DEFAULT NULL; passing
        // null when the form was left blank preserves the prior empty-string-
        // means-fallback semantics at the residents-branch insert below.
        const { error: insErr } = await supabase.rpc('insert_user_role', {
          p_email: targetEmail,
          p_role: 'resident',
          p_company: role?.company || '',
          p_property: propertyArray.length > 0 ? propertyArray : [],
          p_name: newUser.name.trim() || null,
        })
        if (insErr) throw new Error('user_role INSERT failed: ' + insErr.message)

        const { error: rErr } = await supabase.from('residents').insert([{
          email: targetEmail,
          // D2: prefer the typed Full Name; fall back to email (the pre-D2
          // behavior) so legacy CAs who don't type a name still get a
          // non-null residents.name row.
          name: newUser.name.trim() || newUser.email.trim(),
          property: propertyArray[0] || null,
          company: role?.company || null,
          unit: '',
          is_active: true
        }])
        if (rErr) throw new Error('residents INSERT failed: ' + rErr.message)
        residentInserted = true

        const { error: flagErr } = await supabase.rpc('set_must_change_password', {
          p_email: targetEmail,
          p_value: true,
        })
        if (flagErr) throw new Error('must_change_password set failed: ' + flagErr.message)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        await fetch(swiftUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
          body: JSON.stringify({ action: 'deactivate_user', email: targetEmail }),
        }).catch(() => {})
        if (residentInserted) {
          await supabase.from('residents').delete().ilike('email', targetEmail)
          // B150 — vehicle-lifecycle cascade on rollback delete. Gate-check
          // counts active residents remaining at the tuple; cascade only
          // fires when 0 (roommate-safe). For CA-created residents, unit
          // is hardcoded '' (line 764) so this is usually a no-op, but
          // applying for spec consistency + future-proofing if the form
          // gains a unit input.
          const cascadeUnit = ''
          const cascadeProperty = propertyArray[0] || null
          if (cascadeProperty) {
            const { count: othersStillActive } = await supabase
              .from('residents')
              .select('id', { count: 'exact', head: true })
              .ilike('unit', cascadeUnit)
              .ilike('property', cascadeProperty)
              .eq('is_active', true)
            if (othersStillActive === 0) {
              const { data: archived } = await supabase
                .from('vehicles')
                .update({ is_active: false })
                .ilike('unit', cascadeUnit)
                .ilike('property', cascadeProperty)
                .eq('is_active', true)
                .select('id, plate')
              if (archived && archived.length > 0) {
                await auditLog('CASCADE_DEACTIVATE_VEHICLES', 'vehicles', '', {
                  reason: 'B150_lifecycle_cascade', source: 'CA_ADD_RESIDENT_ROLLBACK',
                  unit: cascadeUnit, property: cascadeProperty,
                  vehicle_count: archived.length, plates: archived.map(v => v.plate),
                })
              }
            }
          }
        }
        setUserMsg('Could not complete resident setup: ' + msg + '. Login account deactivated.')
        return
      }

      await auditLog('RESIDENT_CREATED_WITH_AUTH', 'residents', targetEmail, {
        email: targetEmail, created_by_role: 'company_admin', created_by_email: user?.email, company: role?.company,
      })
      setUserMsg('Resident created successfully!')
      setNewUser({ name: '', email: '', role: 'manager', property: '' })
      setShowAddUser(false)
      fetchCompanyUsers()
      setCredentials({ email: targetEmail, password: passwordToUse })
      return
    }

    // Non-resident path — D1 Commit 2. Server-side route handles
    // inviteUserByEmail + insert_user_role (JWT-carrying, so D2's
    // caller-role / company-scope guards fire) + set_must_change_
    // password + drivers entity row + audit log. The CA gets a single
    // success/failure response; no temp password to share, no swift-
    // handler URL construction (B187 root-cause routed around).
    try {
      const res = await fetch('/api/admin/invite-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: targetEmail,
          role: newUser.role,
          name: newUser.name.trim() || null,
          property: propertyArray,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setUserMsg('Error: ' + (json.error || 'Failed to send invite'))
        return
      }
      setUserMsg(json.warning
        ? `Invite sent — partial: ${json.warning}`
        : `Invite email sent to ${targetEmail}`)
    } catch (e: any) {
      setUserMsg('Error: ' + e.message)
      return
    }

    setNewUser({ name: '', email: '', role: 'manager', property: '' })
    setShowAddUser(false)
    fetchCompanyUsers()
  }

  async function createDriver() {
    if (!newDriver.name || !newDriver.email) { setDriverMsg('Name and email are required'); return }
    // Phase 2a: race-guard before creating the auth user, so a tier-blocked
    // attempt doesn't leave an orphaned auth account. Admin bypasses (Q3).
    if (role?.role !== 'admin') {
      const ctx = getCompanyContext()
      const activeCount = companyDrivers.filter(d => d.is_active).length
      if (!isUnderLimit(FEATURE_FLAGS.MAX_DRIVERS, activeCount, ctx)) {
        const limit = getLimit(FEATURE_FLAGS.MAX_DRIVERS, ctx)
        const opened = offerForcedUpgrade(
          `You're at your ${limit}-driver limit. Upgrade to continue.`,
          () => { setDriverMsg(''); createDriver() },
        )
        if (!opened) {
          setDriverMsg(`Driver limit reached (${limit}). Contact support to expand your account.`)
        }
        return
      }
    }
    setDriverMsg('Sending invite...')

    // D1 Commit 2 extension — route the auth user creation + role
    // assignment + drivers entity insert through /api/admin/invite-user
    // (the same JWT-carrying server route the Add User form uses). This
    // eliminates the client-side swift-handler URL construction that
    // triggers B187 (Safari DOMException) and replaces the temp-password
    // pattern with email-link invitation.
    try {
      const res = await fetch('/api/admin/invite-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newDriver.email,
          role: 'driver',
          name: newDriver.name,
          property: newDriver.assigned_properties,
          phone: newDriver.phone || null,
          operator_license: newDriver.operator_license || null,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json?.ok) {
        setDriverMsg('Error: ' + (json?.error || 'Failed to invite driver'))
        return
      }
      if (json.warning) {
        // Route returned ok:true with a non-fatal warning (e.g. drivers entity
        // insert failed but auth + role landed — B188 partial-state class).
        // Surface friendly copy to the CA; raw warning stays in console for
        // debugging without leaking RLS / DB error text into the UI.
        console.warn('[createDriver] route warning:', json.warning)
        setDriverMsg(`Invite sent to ${newDriver.email}, but the driver record didn't fully save — contact support if the driver doesn't appear in your list.`)
      } else {
        setDriverMsg(`Invite email sent to ${newDriver.email}`)
      }
    } catch (e) {
      setDriverMsg('Error: ' + (e instanceof Error ? e.message : String(e)))
      return
    }

    // B147 3b — sync to Stripe AFTER the route's DB writes succeed. PM-track
    // companies have no per_driver line item; helper returns
    // 'skipped_no_line_item' for those — silent.
    const companyIdForSync = getCachedCompanyId()
    if (companyIdForSync === null) {
      console.warn('[B147-sync-skipped-no-companyid]', { site: 'createDriver', email: newDriver.email })
    } else {
      const r = await callSyncOnAdd(companyIdForSync, 'driver')
      if (!r.ok) console.warn('[B147-sync-failed]', { site: 'createDriver', companyId: companyIdForSync, email: newDriver.email, reason: r.reason })
    }

    setNewDriver({ name: '', email: '', phone: '', operator_license: '', assigned_properties: [] })
    setShowAddDriver(false)
    fetchCompanyDrivers()
  }

  async function updateDriver() {
    if (!editingDriver) return
    setDriverMsg('Saving...')
    const { error } = await supabase.from('drivers').update({
      name: editingDriver.name,
      phone: editingDriver.phone || null,
      operator_license: editingDriver.operator_license || null,
      assigned_properties: editingDriver.assigned_properties || [],
    }).eq('id', editingDriver.id)
    if (error) { setDriverMsg('Error: ' + error.message); return }
    await auditLog('update_driver', 'drivers', editingDriver.id, { name: editingDriver.name, company: role?.company })
    setDriverMsg('Driver updated!')
    setEditingDriver(null)
    fetchCompanyDrivers()
  }

  async function toggleDriverActive(driver: any) {
    const wasActive = driver.is_active

    // B147 3b — tier-gate reactivation symmetrically with createDriver
    // (admin-bypass preserved). Same exploit class as togglePropertyActive
    // without this gate.
    if (!wasActive) {
      if (role?.role !== 'admin') {
        const ctx = getCompanyContext()
        const currentActiveCount = companyDrivers.filter(d => d.is_active).length
        if (!isUnderLimit(FEATURE_FLAGS.MAX_DRIVERS, currentActiveCount, ctx)) {
          const limit = getLimit(FEATURE_FLAGS.MAX_DRIVERS, ctx)
          const opened = offerForcedUpgrade(
            `You're at your ${limit}-driver limit. Upgrade to reactivate this driver.`,
            () => { setDriverMsg(''); toggleDriverActive(driver) },
          )
          if (!opened) {
            setDriverMsg(`Driver limit reached (${limit}). Contact support to expand your account.`)
          }
          return
        }
      }
    }

    const { error: updErr } = await supabase.from('drivers').update({ is_active: !wasActive }).eq('id', driver.id)
    if (updErr) { setDriverMsg('Error: ' + updErr.message); return }
    await auditLog(wasActive ? 'deactivate_driver' : 'activate_driver', 'drivers', driver.id, { is_active: !wasActive })

    // B147 3b — sync ONLY on reactivation. Same rationale as
    // togglePropertyActive — deactivation defers to renewal trim.
    if (!wasActive) {
      const companyIdForSync = getCachedCompanyId()
      if (companyIdForSync === null) {
        console.warn('[B147-sync-skipped-no-companyid]', { site: 'toggleDriverActive', driverId: driver.id })
      } else {
        const r = await callSyncOnAdd(companyIdForSync,'driver')
        if (!r.ok) console.warn('[B147-sync-failed]', { site: 'toggleDriverActive', companyId: companyIdForSync, driverId: driver.id, reason: r.reason })
      }
    }

    fetchCompanyDrivers()
  }

  async function createFacility() {
    if (!newFacility.name || !newFacility.address) { setFacilityMsg('Name and address are required'); return }
    setFacilityMsg('Creating...')
    // B154 — set company = caller's company explicitly. Required by the
    // new company_admin_own_facilities WITH CHECK clause; without this,
    // the INSERT would land with company=NULL, which fails the policy
    // (NULL ~~* anything → NULL, treated as false). Closes the CA-INSERT
    // gap that was a silent RLS block before this commit.
    const { data, error: insErr } = await supabase.from('storage_facilities').insert([{
      name: newFacility.name, address: newFacility.address,
      phone: newFacility.phone || null, email: newFacility.email || null,
      vsf_license_number: newFacility.vsf_license_number || null,
      company: role?.company || null,
      is_active: true
    }]).select().single()
    if (insErr) { setFacilityMsg('Error: ' + insErr.message); return }
    await auditLog('create_facility', 'storage_facilities', data.id, newFacility)
    setFacilityMsg('Facility added!')
    setNewFacility({ name: '', address: '', phone: '', email: '', vsf_license_number: '' })
    setShowAddFacility(false)
    fetchAllFacilitiesManage()
    fetchStorageFacilities()
  }

  async function toggleUserActive(email: string, activate: boolean) {
    setTogglingUser(email)
    const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL || ''
    const { data: { session } } = await supabase.auth.getSession()
    // ── Step 1: swift-handler auth ban/unban (LOAD-BEARING) ────────
    // This is the real access control — bans the auth.users record so
    // the user can't log in. If it fails, do NOT proceed to step 2:
    // a column write without an auth ban would leave the user able to
    // log in despite the UI showing them as deactivated.
    const res = await fetch(fnBase + '/swift-handler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
      body: JSON.stringify({ action: activate ? 'activate_user' : 'deactivate_user', email }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      setUserMsg(json.error || json.message || 'Failed to update user status.')
      setTogglingUser(null)
      return
    }
    // ── Step 2: user_roles.is_active write (BEST-EFFORT) ───────────
    // Deactivation arc — drives the new get_my_effective_active gate.
    // Without this, the gate reads the column's default (true) and
    // doesn't fire on stale-session PMs. The auth ban from step 1 is
    // the real control; this column drives the derived-access chain.
    // Best-effort: if this fails, the auth ban is still in place
    // (load-bearing), and the engineer-side log captures the gap.
    // Don't surface the column-write failure to the operator (the
    // intent was already executed at the auth layer).
    const { error: urErr } = await supabase
      .from('user_roles')
      .update({ is_active: activate })
      .ilike('email', email)
    if (urErr) {
      console.error('[toggleUserActive] user_roles.is_active write failed (auth ban remains intact):', urErr.message, { email, activate })
    }
    // ── Step 3: audit log (deactivation arc follow-up) ──────────────
    // Auth ban + column write attempted at this point. Log the intent
    // regardless of the (best-effort) column write — the load-bearing
    // ban happened. Matches CA portal convention exactly: snake_case
    // action label (`deactivate_user` / `activate_user`) mirrors the
    // adjacent `deactivate_property` / `deactivate_driver` precedents
    // in this file. Do NOT use SCREAMING_SNAKE here — that's the B60
    // drift; matching local convention is the discipline. The
    // column_write_failed field lets later audits detect the gap
    // class (intent logged but column never reflected).
    await auditLog(activate ? 'activate_user' : 'deactivate_user', 'user_roles', email, {
      email, is_active: activate,
      column_write_failed: !!urErr,
    })
    setCompanyUsers(prev => prev.map(u => u.email === email ? { ...u, is_active: activate } : u))
    setTogglingUser(null)
  }

  async function resetUserPassword() {
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


  async function openCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      streamRef.current = stream
      setScanStatus('Point camera at license plate')
      setScanning(false)
      setShowCamera(true)
    } catch (e: any) {
      const msg = e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
        ? 'Camera access denied. Please type the plate manually.'
        : 'Camera not available. Please type the plate manually.'
      alert(msg)
    }
  }

  function closeCamera() {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setShowCamera(false)
    setScanning(false)
    setScanStatus('Point camera at license plate')
  }

  async function captureAndScan() {
    if (!videoRef.current || scanning) return
    setScanning(true)
    setScanStatus('Reading plate...')
    const video = videoRef.current

    // Crop to center targeting region (60% wide, 40% tall) at 2x scale
    const srcX = Math.floor(video.videoWidth * 0.20)
    const srcY = Math.floor(video.videoHeight * 0.30)
    const srcW = Math.floor(video.videoWidth * 0.60)
    const srcH = Math.floor(video.videoHeight * 0.40)
    const canvas = document.createElement('canvas')
    canvas.width = srcW * 2
    canvas.height = srcH * 2
    const ctx = canvas.getContext('2d')
    if (!ctx) { setScanStatus('Could not read plate. Please type manually.'); setScanning(false); return }
    ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height)

    const base64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1]

    try {
      const res = await fetch('/api/scan-plate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        setScanStatus(json.error === 'Plate scanning not configured' ? 'Plate scanning not configured. Please type manually.' : 'Could not read plate. Please type manually.')
        setScanning(false)
        return
      }
      const cleaned = (json.plate || '').replace(/[^A-Z0-9]/g, '').toUpperCase().slice(0, 8)
      if (cleaned.length >= 4) {
        setPlate(cleaned)
        setScanMsg('📋 AI Scan Result — please visually verify this plate before taking any enforcement action. AI results may contain errors.')
        closeCamera()
        setTimeout(() => searchPlate(cleaned), 50)
      } else {
        setScanStatus('Could not read plate clearly. Please try again or type manually.')
        setScanning(false)
      }
    } catch {
      setScanStatus('Could not read plate. Please type manually.')
      setScanning(false)
    }
  }

  async function searchPlate(plateVal?: string) {
    const val = plateVal ?? plate
    if (!val || searching) return
    setSearching(true); setScanMsg(''); setResult(null); setShowViolation(false); setPendingDecline(null); setTicketTarget(null)
    const clean = val.toUpperCase().replace(/\s/g, '').trim()
    const companyPropNames = properties.map(p => (p.name || '').toLowerCase())

    const { data: activeVeh } = await supabase.from('vehicles').select('*').ilike('plate', clean).eq('is_active', true).single()
    if (activeVeh) {
      const inCompany = companyPropNames.includes((activeVeh.property || '').toLowerCase())
      if (inCompany) {
        if (selectedProperty && activeVeh.property?.toLowerCase() !== selectedProperty.name?.toLowerCase()) {
          setSearching(false); setResult({ status: 'otherproperty', data: activeVeh }); return
        }
        setSearching(false); setResult({ status: 'authorized', data: activeVeh }); return
      }
    }

    const { data: expiredVeh } = await supabase.from('vehicles').select('*').ilike('plate', clean).eq('is_active', false).single()
    if (expiredVeh) {
      const inCompany = companyPropNames.includes((expiredVeh.property || '').toLowerCase())
      if (inCompany) { setSearching(false); setResult({ status: 'expired', data: expiredVeh }); return }
    }

    const propNames = properties.map((p: any) => p.name)

    // B214 — guest_authorizations stage 2.5 of the enforcement cascade.
    // CA-portal variant: scoped via .in('property', propNames) to ALL of the
    // CA's company's properties (CA scans cross-property; driver's variant
    // is single-property). Date predicate matches the table's primary index.
    // .order(end_date desc).limit(1).maybeSingle() handles the overlap case
    // (Finding 2) — surfaces the longer-running auth if two are simultaneously
    // active for the same plate.
    const todayIso = new Date().toISOString().split('T')[0]
    const { data: guestAuth } = await supabase
      .from('guest_authorizations').select('*')
      .ilike('plate', clean).in('property', propNames)
      .eq('is_active', true).eq('status', 'active')
      .lte('start_date', todayIso).gte('end_date', todayIso)
      .order('end_date', { ascending: false })
      .limit(1).maybeSingle()
    if (guestAuth) {
      setSearching(false); setResult({ status: 'guest_authorized', data: guestAuth }); return
    }

    const { data: passData } = await supabase.from('visitor_passes').select('*')
      .ilike('plate', clean).eq('is_active', true).gte('expires_at', new Date().toISOString())
      .in('property', propNames).single()

    setSearching(false)
    if (passData) setResult({ status: 'visitor', data: passData })
    else setResult({ status: 'notfound' })
  }

  async function submitViolation() {
    if (!violation.type || !violation.property) { alert('Violation type and property are required'); return }
    setSubmitting(true)
    // B18 Commit B: upload media first, then INSERT violation row with
    // is_confirmed=false, then INSERT photo rows into violation_photos.
    // The legacy violations.photos array is no longer written; reader
    // sites pull from violation_photos via the Commit A embed.
    const photoUrls: string[] = []
    for (const photo of photos) {
      const fileName = `${Date.now()}-${photo.name}`
      const { error: upErr } = await supabase.storage.from('violation-photos').upload(fileName, photo)
      if (!upErr) {
        const { data: urlData } = supabase.storage.from('violation-photos').getPublicUrl(fileName)
        photoUrls.push(urlData.publicUrl)
      }
    }
    let videoUrl: string | null = null
    if (violationVideo) {
      setUploadingVideo(true)
      setUploadProgress(0)
      const fileName = `${Date.now()}-${violationVideo.name}`
      const result = await uploadVideoResumable(
        'violation-videos',
        fileName,
        violationVideo,
        (pct) => setUploadProgress(pct),
      )
      if ('error' in result) {
        console.error('[video upload] failed:', result.error, 'file size:', violationVideo.size, 'mime:', violationVideo.type)
        alert(`Video upload failed: ${result.error}. Violation will be saved without video.`)
      } else {
        videoUrl = result.publicUrl
      }
      setUploadingVideo(false)
      setUploadProgress(0)
    }
    const normalizedPlate = normalizePlate(plate)
    const { data: newV, error: insErr } = await supabase.from('violations').insert([{
      plate: normalizedPlate, violation_type: violation.type,
      location: violation.location, notes: violation.notes,
      property: violation.property, driver_name: role?.email,
      video_url: videoUrl,
      vehicle_color: violation.vehicle_color || null,
      vehicle_make: violation.vehicle_make || null,
      vehicle_model: violation.vehicle_model || null,
      // B78: optional year capture. Mirrors driver portal.
      vehicle_year: violation.vehicle_year ? (parseInt(violation.vehicle_year) || null) : null,
      is_confirmed: false,
      // B71: authorized-plate override fields.
      was_authorized_at_time: pendingDecline !== null,
      decline_reason: pendingDecline?.reason || null,
      decline_reason_note: pendingDecline?.note || null,
    }]).select().single()
    if (insErr) {
      setSubmitting(false)
      alert('Error: ' + insErr.message); return
    }
    let insertedPhotoIds: number[] = []
    if (photoUrls.length > 0 && newV) {
      const photoRows = photoUrls.map(url => ({ violation_id: newV.id, photo_url: url }))
      // C1: .select('id, photo_url') so we can pair IDs with URLs for
      // the review screen's per-photo X buttons. Supabase returns rows
      // in insertion order, so insertedPhotoIds[i] pairs with photoUrls[i].
      const { data: photoData, error: phErr } = await supabase.from('violation_photos')
        .insert(photoRows).select('id, photo_url')
      if (phErr) {
        console.error('[violation_photos INSERT] failed:', phErr.message)
        alert('Some photos failed to attach: ' + phErr.message + '\nYou can still confirm; a manager can add photos later.')
      } else {
        insertedPhotoIds = (photoData || []).map(p => p.id)
      }
    }
    // C1: write video metadata to violation_videos alongside the
    // legacy violations.video_url (safety net per locked decision).
    let insertedVideoId: number | null = null
    if (videoUrl && newV) {
      const { data: videoData, error: vidErr } = await supabase.from('violation_videos')
        .insert([{ violation_id: newV.id, video_url: videoUrl }])
        .select('id').single()
      if (vidErr) {
        console.error('[violation_videos INSERT] failed:', vidErr.message)
        alert('Video metadata failed to attach: ' + vidErr.message + '\nYou can still confirm; a manager can re-attach the video later.')
      } else if (videoData) {
        insertedVideoId = videoData.id
      }
    }
    await auditLog('ADD_VIOLATION', 'violations', newV?.id, { plate: normalizedPlate, property: violation.property, violation_type: violation.type })
    setSubmitting(false)
    setReviewViolation({
      id: newV.id,
      plate: newV.plate,
      violation_type: newV.violation_type,
      property: newV.property,
      location: newV.location,
      notes: newV.notes,
      photos: photoUrls,
      photo_ids: insertedPhotoIds,
      video_url: newV.video_url,
      video_id: insertedVideoId,
      driver_name: newV.driver_name,
      created_at: newV.created_at,
      // B78 Path A — mirrors driver portal.
      vehicle_color: newV.vehicle_color,
      vehicle_make: newV.vehicle_make,
      vehicle_model: newV.vehicle_model,
      vehicle_year: newV.vehicle_year,
    })
    setViolationStage('review')
  }

  // C1: re-query the violation after a soft-delete on the review screen.
  async function refetchReviewViolation() {
    if (!reviewViolation) return
    // B78 Path A: SELECT widened + ReviewViolation construction carries vehicle_*.
    const { data, error } = await supabase.from('violations')
      .select('id, plate, violation_type, property, location, notes, video_url, driver_name, created_at, vehicle_color, vehicle_make, vehicle_model, vehicle_year, photo_rows:violation_photos(id, photo_url, removed_at), video_rows:violation_videos(id, video_url, removed_at)')
      .eq('id', reviewViolation.id)
      .single()
    if (error || !data) { console.error('[refetchReviewViolation] failed:', error?.message); return }
    const activePhotos = ((data.photo_rows as { id: number; photo_url: string; removed_at: string | null }[] | null) || [])
      .filter(p => !p.removed_at)
    const activeVideos = ((data.video_rows as { id: number; video_url: string; removed_at: string | null }[] | null) || [])
      .filter(v => !v.removed_at)
    setReviewViolation({
      id: data.id, plate: data.plate, violation_type: data.violation_type,
      property: data.property, location: data.location, notes: data.notes,
      photos: activePhotos.map(p => p.photo_url),
      photo_ids: activePhotos.map(p => p.id),
      video_url: activeVideos[0]?.video_url ?? null,
      video_id: activeVideos[0]?.id ?? null,
      driver_name: data.driver_name, created_at: data.created_at,
      vehicle_color: data.vehicle_color,
      vehicle_make: data.vehicle_make,
      vehicle_model: data.vehicle_model,
      vehicle_year: data.vehicle_year,
    })
  }

  async function confirmReviewedViolation() {
    if (!reviewViolation) return
    setReviewBusy(true)
    const { error } = await supabase.from('violations')
      .update({ is_confirmed: true })
      .eq('id', reviewViolation.id)
    setReviewBusy(false)
    if (error) { alert('Confirm failed: ' + error.message); return }
    await auditLog('VIOLATION_CONFIRMED', 'violations', String(reviewViolation.id), { plate: reviewViolation.plate, property: reviewViolation.property })
    const confirmed = reviewViolation
    setReviewViolation(null)
    setViolationStage('form')
    setShowViolation(false)
    setViolation({ type: '', location: '', notes: '', property: '', vehicle_color: '', vehicle_make: '', vehicle_model: '', vehicle_year: '' })
    setPendingDecline(null)
    setPhotos([])
    setViolationVideo(null)
    setVideoDuration(null)
    await loadUnconfirmedDrafts()
    if (selectedProperty) fetchViolations(selectedProperty.name)
    setTicketTarget(confirmed); setSelectedStorage(''); setTowFee(''); setMileage('')
  }

  async function editFromReview() {
    // Discard the unconfirmed row entirely so the user submits cleanly on
    // the next round. CASCADE drops photo rows. Storage objects orphan
    // until a Phase 2 cleanup cron. Form state is preserved so they don't
    // have to re-type everything.
    if (!reviewViolation) return
    setReviewBusy(true)
    await supabase.from('violations').delete().eq('id', reviewViolation.id)
    setReviewBusy(false)
    setReviewViolation(null)
    setViolationStage('form')
  }

  // Resume banner: drafts created by this CA within 24h that haven't been
  // confirmed. driver_name == role.email since that's what we wrote at
  // submit time.
  async function loadUnconfirmedDrafts() {
    if (!role?.email) { setUnconfirmedDrafts([]); return }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    // B78 Path A: SELECT widened + draft array carries vehicle_*.
    const { data } = await supabase.from('violations')
      .select('id, plate, violation_type, property, location, notes, driver_name, created_at, vehicle_color, vehicle_make, vehicle_model, vehicle_year, photo_rows:violation_photos(id, photo_url, removed_at), video_rows:violation_videos(id, video_url, removed_at)')
      .eq('is_confirmed', false)
      .ilike('driver_name', role.email)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
    const drafts = (data || []).map(v => {
      const activePhotos = ((v.photo_rows as { id: number; photo_url: string; removed_at: string | null }[] | null) || [])
        .filter(p => !p.removed_at)
      const activeVideos = ((v.video_rows as { id: number; video_url: string; removed_at: string | null }[] | null) || [])
        .filter(vid => !vid.removed_at)
      return {
        id: v.id, plate: v.plate, violation_type: v.violation_type,
        property: v.property, location: v.location, notes: v.notes,
        photos: activePhotos.map(p => p.photo_url),
        photo_ids: activePhotos.map(p => p.id),
        video_url: activeVideos[0]?.video_url ?? null,
        video_id: activeVideos[0]?.id ?? null,
        driver_name: v.driver_name, created_at: v.created_at,
        vehicle_color: v.vehicle_color,
        vehicle_make: v.vehicle_make,
        vehicle_model: v.vehicle_model,
        vehicle_year: v.vehicle_year,
      }
    }) as ReviewViolation[]
    setUnconfirmedDrafts(drafts)
  }

  async function reviewOldestDraft() {
    if (unconfirmedDrafts.length === 0) return
    setReviewViolation(unconfirmedDrafts[0])
    setShowViolation(true)
    setViolationStage('review')
  }

  async function discardAllUnconfirmedDrafts() {
    if (unconfirmedDrafts.length === 0) return
    if (!confirm(`Discard ${unconfirmedDrafts.length} unfinished violation${unconfirmedDrafts.length === 1 ? '' : 's'}? This cannot be undone.`)) return
    const ids = unconfirmedDrafts.map(d => d.id)
    await supabase.from('violations').delete().in('id', ids)
    setUnconfirmedDrafts([])
    setReviewViolation(null)
    setViolationStage('form')
    setShowViolation(false)
    setPendingDecline(null)
  }

  // B38: explicit discard from the review screen. Same DELETE as
  // editFromReview, but ALSO clears the form state and closes the
  // form so the user returns to portal home rather than the form.
  // Kept deliberately separate from editFromReview — 1 line of DELETE
  // duplication is cheaper than the indirection of a shared helper.
  async function discardFromReview() {
    if (!reviewViolation) return
    if (!confirm('Discard this draft? Cannot be undone.')) return
    setReviewBusy(true)
    await supabase.from('violations').delete().eq('id', reviewViolation.id)
    setReviewBusy(false)
    setReviewViolation(null)
    setViolationStage('form')
    setShowViolation(false)
    setViolation({ type: '', location: '', notes: '', property: '', vehicle_color: '', vehicle_make: '', vehicle_model: '', vehicle_year: '' })
    setPendingDecline(null)
    setPhotos([])
    setViolationVideo(null)
    setVideoDuration(null)
    await loadUnconfirmedDrafts()
  }

  // B38: discard a specific draft from the per-draft resume banner.
  async function discardSingleDraft(id: number) {
    if (!confirm('Discard this draft? Cannot be undone.')) return
    await supabase.from('violations').delete().eq('id', id)
    await loadUnconfirmedDrafts()
  }

  // B38: review a specific draft (not just the oldest).
  async function reviewDraft(d: ReviewViolation) {
    setReviewViolation(d)
    setShowViolation(true)
    setViolationStage('review')
  }

  // B38: relative-time formatter for resume banner per-draft rows.
  function timeAgo(iso: string | null): string {
    if (!iso) return ''
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    return `${Math.floor(mins / 60)}h ago`
  }

  function filteredViolations() {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const week = new Date(); week.setDate(week.getDate() - 7)
    const sixmo = new Date(); sixmo.setMonth(sixmo.getMonth() - 6)
    return violations.filter(v => {
      const d = new Date(v.created_at)
      const inPeriod = violationFilter === 'today' ? d >= today : violationFilter === 'week' ? d >= week : d >= sixmo
      if (!inPeriod) return false
      if (!violationSearch) return true
      const q = violationSearch.toLowerCase()
      return v.plate?.toLowerCase().includes(q) || displayTowReason(v.violation_type).toLowerCase().includes(q) || v.location?.toLowerCase().includes(q)
    })
  }

  function escapeCsv(val: any): string {
    const s = (val == null ? '' : String(val)).replace(/"/g, '""')
    return `"${s}"`
  }

  function exportTowbook() {
    const towRecords = filteredViolations().filter((v: any) => v.tow_ticket_generated)
    if (towRecords.length === 0) {
      setExportMsg('No tow ticket records found in current filter. Apply a date filter and try again.')
      return
    }
    setExportMsg(`Exporting ${towRecords.length} tow record${towRecords.length !== 1 ? 's' : ''}...`)
    setTimeout(() => setExportMsg(''), 4000)
    // B78: vehicle_year added between State and Color (mirrors history CSV).
    const headers = ['Date','Time','Plate','State','Year','Color','Make','Model','Violation Type','Location','Property','Storage Facility','Storage Address','Storage Phone','Tow Fee','Driver Name','Driver License','Notes']
    const rows = towRecords.map((v: any) => {
      const d = new Date(v.created_at)
      const date = d.toLocaleDateString('en-US', { month:'2-digit', day:'2-digit', year:'numeric' })
      const time = d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12: true })
      return [
        date, time, v.plate, v.state || '', v.vehicle_year || '', v.vehicle_color || '', v.vehicle_make || '', v.vehicle_model || '',
        displayTowReason(v.violation_type), v.location || '', v.property || '',
        v.tow_storage_name || '', v.tow_storage_address || '', v.tow_storage_phone || '',
        v.tow_fee || '', v.driver_name || '', v.driver_license || '', v.notes || '',
      ].map(escapeCsv).join(',')
    })
    const csv = [headers.map(escapeCsv).join(','), ...rows].join('\n')
    const today = new Date().toISOString().slice(0, 10)
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tow_records_${today}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function fetchCAAnalytics() {
    setAnalyticsLoaded(false)
    const propNames = properties.map((p: any) => p.name)
    if (propNames.length === 0) { setCAAnalytics(null); setAnalyticsLoaded(true); return }
    const now = new Date()
    const mk = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`
    const numMonths = analyticsRange === '30d' ? 1 : analyticsRange === '3mo' ? 3 : analyticsRange === '1yr' ? 12 : 6
    const startDate = new Date(now.getFullYear(), now.getMonth() - numMonths, analyticsRange === '30d' ? now.getDate() - 30 : 1)

    const [{ data: vData }, { data: drData }] = await Promise.all([
      // B175 — analytics counter excludes voided violations.
      supabase.from('violations').select('property,created_at,tow_ticket_generated,violation_type,driver_name').eq('is_confirmed', true).is('voided_at', null).in('property', propNames).gte('created_at', startDate.toISOString()),
      supabase.from('dispute_requests').select('id').in('property', propNames).eq('status', 'pending'),
    ])

    let passCount = 0
    const passMonthMap: Record<string, number> = {}
    const { data: pData } = await supabase.from('visitor_passes').select('created_at').in('property', propNames).gte('created_at', startDate.toISOString())
    passCount = pData?.length || 0
    ;(pData || []).forEach((p: any) => { const k = mk(new Date(p.created_at)); passMonthMap[k] = (passMonthMap[k] || 0) + 1 })

    const viols = vData || []
    const byProp: Record<string, { violations: number; tows: number }> = {}
    const byMonthMap: Record<string, number> = {}
    const byType: Record<string, number> = {}
    // B58: removed byDriver aggregate — was computed but never rendered.
    // Driver-performance UI was the orphan consumer of the now-deleted
    // DRIVER_PERFORMANCE_REPORTS flag. If a real driver-performance chart
    // gets built later, re-introduce the aggregate as part of that work.
    viols.forEach((v: any) => {
      const p = v.property || 'Unknown'
      byProp[p] = byProp[p] || { violations: 0, tows: 0 }
      byProp[p].violations++
      if (v.tow_ticket_generated) byProp[p].tows++
      const k = mk(new Date(v.created_at)); byMonthMap[k] = (byMonthMap[k] || 0) + 1
      // Analytics groupby — bucket by LABEL so old freetext "Fire Lane"
      // rows + new code "fire_lane" rows aggregate together (both resolve
      // to label "Fire Lane" via displayTowReason).
      const t = displayTowReason(v.violation_type); byType[t] = (byType[t] || 0) + 1
    })

    const monthLabels: { label: string; key: string }[] = []
    for (let i = numMonths - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      monthLabels.push({ label: d.toLocaleString('en-US', { month: 'short' }), key: mk(d) })
    }

    const propertyChartData = Object.entries(byProp).map(([name, d]) => ({ name: name.length > 16 ? name.slice(0, 16) + '…' : name, violations: d.violations, tows: d.tows }))
    const trendData = monthLabels.map(m => ({ month: m.label, violations: byMonthMap[m.key] || 0, passes: passMonthMap[m.key] || 0 }))
    const typeChartData = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name: name.length > 22 ? name.slice(0, 22) + '…' : name, count }))

    const totalViolations = viols.length
    const totalTows = viols.filter((v: any) => v.tow_ticket_generated).length
    const avgTowRate = totalViolations > 0 ? Math.round((totalTows / totalViolations) * 100) : 0
    const pendingDisputes = drData?.length || 0
    const avgPerProp = totalViolations / Math.max(propertyChartData.length, 1)

    const insights: string[] = []
    propertyChartData.forEach(p => {
      if (propertyChartData.length > 1 && p.violations >= avgPerProp * 2)
        insights.push(`⚠ ${p.name} has ${Math.round(p.violations / avgPerProp)}x more violations than average. Consider adding driver coverage.`)
    })
    if (trendData.length >= 2) {
      const last = trendData[trendData.length - 1], prev = trendData[trendData.length - 2]
      if (prev.passes > 0 && last.passes >= prev.passes * 1.2)
        insights.push(`📈 Visitor traffic up ${Math.round(((last.passes - prev.passes) / prev.passes) * 100)}% — review pass limits.`)
      const lastKey = monthLabels[monthLabels.length - 1]?.key, prevKey = monthLabels[monthLabels.length - 2]?.key
      const lv = viols.filter((v: any) => mk(new Date(v.created_at)) === lastKey)
      const pv = viols.filter((v: any) => mk(new Date(v.created_at)) === prevKey)
      const ltr = lv.length > 0 ? lv.filter((v: any) => v.tow_ticket_generated).length / lv.length : null
      const ptr = pv.length > 0 ? pv.filter((v: any) => v.tow_ticket_generated).length / pv.length : null
      if (ltr !== null && ptr !== null && ptr > 0 && ltr < ptr * 0.9) insights.push('✅ Tow rate declining — enforcement is working!')
    }
    if (pendingDisputes > 0 && totalViolations > 0 && pendingDisputes / totalViolations > 0.05)
      insights.push('⚖ Dispute rate elevated. Review violation accuracy.')
    if (insights.length === 0) insights.push('✅ Everything looks normal. No anomalies detected.')

    setCAAnalytics({ propertyChartData, trendData, typeChartData, totalViolations, avgTowRate, passCount, pendingDisputes, insights })
    setAnalyticsLoaded(true)
  }

  function openTicketFor(v: any) {
    setTicketTarget(v); setExpandedTicketId(v.id)
    setSelectedStorage(''); setTowFee(''); setMileage(''); setVin('')
  }

  // B182 — replaces the legacy reprintTicket() that rendered a divergent
  // CA-portal popup (price-carrying) with a thin wrapper around the
  // canonical public capability URL. Mints a fresh 90-day token via
  // set_violation_view_token (B178 SECURITY DEFINER RPC) and either
  // opens the URL in a new tab (view) or copies it to the clipboard
  // (copy). The capability URL is the priced motorist + facility view —
  // same data the operator shared at issue time. PMs see the price-
  // stripped view at /ticket/pm/[id] (different route, different RPC,
  // separate auth path).
  async function viewOrCopyPublicTicket(v: { id: number }, mode: 'view' | 'copy') {
    try {
      const { data: tokenResult, error: tokenErr } = await supabase.rpc('set_violation_view_token', { p_violation_id: v.id })
      if (tokenErr) {
        alert('Failed to mint ticket link: ' + tokenErr.message)
        return
      }
      const result = tokenResult as { ok?: boolean; token?: string; error?: string } | null
      if (!result || !result.ok || !result.token) {
        alert('Failed to mint ticket link: ' + (result?.error ?? 'unknown'))
        return
      }
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'
      const url = `${appUrl}/ticket/view/${result.token}`
      if (mode === 'view') {
        window.open(url, '_blank', 'noopener,noreferrer')
      } else {
        try {
          await navigator.clipboard.writeText(url)
        } catch {
          alert('Copy unavailable — public ticket URL: ' + url)
        }
      }
    } catch (e) {
      alert('Failed to mint ticket link: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  async function generateTicket() {
    if (!ticketTarget) return
    const storage = storageFacilities.find(s => String(s.id) === selectedStorage)
    const tw = window.open('', '_blank')
    if (!tw) return
    const v = ticketTarget
    const total = (parseFloat(towFee || '0') + parseFloat(mileage || '0')).toFixed(2)

    // B120 — resolve company TDLR for the licensing block. VSF comes
    // directly from the selected storage (already in scope).
    // driver_license: snapshot is set by the driver portal at insert;
    // for CA-issued tickets it's typically null → renders nothing.
    let companyTdlr: string | null = null
    try {
      if (role?.company) {
        const { data: c } = await supabase
          .from('companies')
          .select('tdlr_license_number')
          .ilike('name', role.company)
          .maybeSingle()
        companyTdlr = (c?.tdlr_license_number as string | null) || null
      }
    } catch (e) {
      console.error('[B120 live-ticket TDLR fetch]', (e as Error).message)
    }
    const facilityVsf: string | null = (storage?.vsf_license_number as string | null) || null
    // Capability-URL ticket view (mirrors driver/page.tsx generateTicket).
    // 90-day expiry; recipient clicks URL → /ticket/view/<token> →
    // sees rich hosted view. Failure non-fatal: Share / Copy buttons
    // and the mailto body's "View online" line are skipped.
    let viewUrl = ''
    if (ticketTarget?.id) {
      const { data: tokenResult, error: tokenErr } = await supabase.rpc('set_violation_view_token', { p_violation_id: ticketTarget.id })
      if (tokenErr) {
        console.error('[tow-ticket-view] set_violation_view_token failed:', tokenErr.message)
      } else if (tokenResult && typeof tokenResult === 'object' && 'token' in tokenResult) {
        viewUrl = `https://shieldmylot.com/ticket/view/${(tokenResult as { token: string }).token}`
      } else if (tokenResult && typeof tokenResult === 'object' && 'error' in tokenResult) {
        console.error('[tow-ticket-view] set_violation_view_token returned error:', (tokenResult as { error: string }).error)
      }
    }
    const storageEmail = storage?.email ? encodeURIComponent(storage.email) : ''
    const mailSubject = encodeURIComponent(`Tow Ticket - ${v.plate}`)
    const mailBody = encodeURIComponent([
      `TOW TICKET — ${role?.company || ''}`,
      `Date/Time: ${new Date(v.created_at).toLocaleString()}`,
      `Ticket #: ${String(v.id).substring(0, 8).toUpperCase()}`,
      ``,`VEHICLE`,`Plate: ${v.plate}`,
      // B78: Family-2 source + graceful omission, matches the HTML template
      // above. VIN line removed (never captured; the `vin` identifier wasn't
      // even a state var in CA portal — line was a latent ReferenceError).
      `Vehicle: ${[v.vehicle_year, v.vehicle_make, v.vehicle_model, v.vehicle_color].filter(Boolean).join(' ') || '—'}`,
      ``,`VIOLATION`,
      `Type: ${displayTowReason(v.violation_type)}`,`Location: ${v.location || '—'}`,
      `Property: ${v.property || '—'}`,`Notes: ${v.notes || 'None'}`,
      ``,`STORAGE / IMPOUND`,`Facility: ${storage?.name || '—'}`,
      `Address: ${storage?.address || '—'}`,`Phone: ${storage?.phone || '—'}`,
      ``,`AUTHORIZED BY`,`Company: ${role?.company || '—'}`,
      ``,`FEES`,`Tow Fee: $${parseFloat(towFee || '0').toFixed(2)}`,
      `Mileage Fee: $${parseFloat(mileage || '0').toFixed(2)}`,`Total Due: $${total}`,
      // Capability-URL link (skipped if viewUrl empty — RPC failure).
      ...(viewUrl ? [``, `VIEW FULL TICKET ONLINE (with photos):`, viewUrl] : []),
    ].join('\n'))
    const photosHtml = v.photos?.length
      ? `<div style="margin-top:20px"><p style="font-weight:bold;margin-bottom:8px">EVIDENCE PHOTOS</p><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${v.photos.map((u: string) => `<img src="${u}" style="width:100%;border-radius:4px;border:1px solid #ddd" onerror="this.style.display='none'">`).join('')}</div></div>`
      : ''
    tw.document.write(`<!DOCTYPE html><html><head><title>Tow Ticket — ${v.plate}</title><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;padding:28px;max-width:680px;margin:0 auto;color:#111;font-size:13px}
      .hdr{display:flex;align-items:center;gap:14px;margin-bottom:22px;padding-bottom:14px;border-bottom:3px solid #C9A227}
      .logo{width:64px;height:64px;border-radius:8px;border:2px solid #C9A227;object-fit:contain}
      .sec{margin-bottom:18px}.sh{font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#777;margin-bottom:8px;padding-bottom:3px;border-bottom:1px solid #eee}
      .g2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .f label{font-size:10px;font-weight:bold;color:#555;text-transform:uppercase;letter-spacing:.05em;display:block}
      .f span{font-size:13px;color:#111;display:block;margin-top:1px}
      .plate{font-family:"Courier New",monospace;font-size:22px;font-weight:bold}
      .warn{background:#fff3cd;border:1px solid #e6b800;border-radius:5px;padding:9px 12px;font-size:11px;margin-bottom:16px}
      .sig-wrap{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:28px}
      .sig-line{border-top:1px solid #555;padding-top:5px;font-size:10px;color:#666;margin-top:36px}
      .ftr{margin-top:20px;padding-top:10px;border-top:2px solid #C9A227;font-size:10px;color:#888;text-align:center}
      @media print{.no-print{display:none}body{padding:18px}}
    </style></head><body>
      <div class="hdr">
        <img src="${getCachedLogoUrl(localStorage.getItem('company_logo'))}" class="logo" alt="" onerror="this.style.display='none'">
        <div>
          <div style="font-size:20px;font-weight:bold">${role?.company || 'Tow Service'}</div>
          <div style="font-size:15px;font-weight:bold;color:#C9A227;margin-top:3px">OFFICIAL TOW TICKET</div>
        </div>
        <div style="margin-left:auto;text-align:right">
          <div style="font-size:10px;color:#888">Date / Time</div>
          <div style="font-weight:bold">${new Date(v.created_at).toLocaleString()}</div>
          <div style="font-size:10px;color:#888;margin-top:4px">Ticket #</div>
          <div style="font-weight:bold">${String(v.id).substring(0, 8).toUpperCase()}</div>
        </div>
      </div>
      <div class="warn">⚠ This vehicle has been towed pursuant to Texas Transportation Code §683. Contact the storage facility below to recover your vehicle.</div>
      <div class="sec"><div class="sh">Vehicle Information</div><div class="g2">
        <div class="f"><label>License Plate</label><span class="plate">${v.plate}</span></div>
        <div class="f"><label>State</label><span>${v.state || '—'}</span></div>
        ${v.vehicle_year ? `<div class="f"><label>Year</label><span>${v.vehicle_year}</span></div>` : ''}
        ${[v.vehicle_make, v.vehicle_model, v.vehicle_color].filter(Boolean).length ? `<div class="f"><label>Make / Model / Color</label><span>${[v.vehicle_make, v.vehicle_model, v.vehicle_color].filter(Boolean).join('  ·  ')}</span></div>` : ''}
      </div></div>
      <div class="sec"><div class="sh">Violation</div><div class="g2">
        <div class="f"><label>Type</label><span>${displayTowReason(v.violation_type)}</span></div>
        <div class="f"><label>Location / Space</label><span>${v.location || '—'}</span></div>
        <div class="f" style="grid-column:span 2"><label>Notes</label><span>${v.notes || 'No additional notes.'}</span></div>
      </div></div>
      <div class="sec"><div class="sh">Property</div><div class="g2">
        <div class="f"><label>Authorized By</label><span>${v.property || '—'}</span></div>
        <div class="f"><label>Company</label><span>${role?.company || '—'}</span></div>
      </div></div>
      <div class="sec"><div class="sh">Tow Operator</div><div class="g2">
        <div class="f"><label>Name</label><span>${v.driver_name || '—'}</span></div>
        ${v.driver_license ? `<div class="f"><label>License #</label><span>${v.driver_license}</span></div>` : ''}
        ${companyTdlr ? `<div class="f"><label>TDLR #</label><span>${companyTdlr}</span></div>` : ''}
      </div></div>
      <div class="sec"><div class="sh">Storage / Impound</div><div class="g2">
        <div class="f"><label>Facility</label><span>${storage?.name || '—'}</span></div>
        <div class="f"><label>Phone</label><span>${storage?.phone || '—'}</span></div>
        <div class="f" style="grid-column:span 2"><label>Address</label><span>${storage?.address || '—'}</span></div>
        ${facilityVsf ? `<div class="f" style="grid-column:span 2"><label>VSF #</label><span>${facilityVsf}</span></div>` : ''}
      </div></div>
      ${(parseFloat(towFee || '0') > 0 || parseFloat(mileage || '0') > 0) ? `
      <div class="sec"><div class="sh">Fees</div><div class="g2">
        ${parseFloat(towFee || '0') > 0 ? `<div class="f"><label>Tow Fee</label><span>$${parseFloat(towFee).toFixed(2)}</span></div>` : ''}
        ${parseFloat(mileage || '0') > 0 ? `<div class="f"><label>Mileage Fee</label><span>$${parseFloat(mileage).toFixed(2)}</span></div>` : ''}
        <div class="f"><label>Total Due</label><span style="font-size:16px;font-weight:bold">$${total}</span></div>
      </div></div>` : ''}
      ${photosHtml}
      <div class="sig-wrap"><div><div class="sig-line">Authorized Signature</div></div><div><div class="sig-line">Date</div></div></div>
      <div class="ftr">${role?.company || ''}<br>Generated ${new Date().toLocaleString()}</div>
      <div class="no-print" style="margin-top:20px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button onclick="window.print()" style="padding:11px 22px;background:#C9A227;color:#0f1117;font-weight:bold;font-size:13px;border:none;border-radius:7px;cursor:pointer">Print Ticket</button>
        <a href="mailto:${storageEmail}?subject=${mailSubject}&body=${mailBody}" style="padding:11px 22px;background:#1e3a5f;color:#fff;font-weight:bold;font-size:13px;border-radius:7px;text-decoration:none;display:inline-flex;align-items:center">Email Ticket</a>
        ${viewUrl ? `<button onclick="if(navigator.share){navigator.share({title:'Tow Ticket',text:'Tow ticket for plate ${v.plate}',url:'${viewUrl}'}).catch(()=>{})}else{alert('Sharing not supported on this device. Use Email or Copy Link.')}" style="padding:11px 22px;background:#2e7d32;color:#fff;font-weight:bold;font-size:13px;border:none;border-radius:7px;cursor:pointer">Share</button>` : ''}
        ${viewUrl ? `<button onclick="navigator.clipboard.writeText('${viewUrl}').then(()=>{var b=event.target;var t=b.textContent;b.textContent='Copied!';setTimeout(function(){b.textContent=t},1500)})" style="padding:11px 22px;background:#555;color:#fff;font-weight:bold;font-size:13px;border:none;border-radius:7px;cursor:pointer">Copy Link</button>` : ''}
        <button onclick="window.close()" style="padding:11px 22px;background:#333;color:#fff;font-size:13px;border:none;border-radius:7px;cursor:pointer">Close</button>
      </div>
    </body></html>`)
    tw.document.close()
    if (ticketTarget?.id && storage) {
      // B178 — direct UPDATE of tow_* columns on a confirmed violation
      // is now denied by the tightened RLS (USING is_confirmed = false).
      // Route through stamp_tow_ticket SECURITY DEFINER RPC (mirrors
      // the driver-portal refactor; same body gate + canonical facility
      // lookup).
      const { data: stampResult, error: stampErr } = await supabase.rpc('stamp_tow_ticket', {
        p_violation_id: ticketTarget.id,
        p_storage_facility_id: storage.id,
        p_tow_fee: parseFloat(towFee || '0') || null,
      })
      if (stampErr) {
        console.error('[B178 stamp_tow_ticket] RPC error:', stampErr.message)
      } else {
        const result = stampResult as { ok?: boolean; violation?: Record<string, unknown>; error?: string }
        if (!result?.ok || !result.violation) {
          console.error('[B178 stamp_tow_ticket] refused:', result?.error)
        } else {
          const updated = result.violation as Record<string, unknown>
          setViolations((prev: any[]) => prev.map((v: any) => v.id === ticketTarget.id ? { ...v, ...updated } : v))
          setTicketTarget((prev: any) => prev ? { ...prev, ...updated } : null)
        }
      }
    }
  }

  function renderTicketForm() {
    if (!ticketTarget) return null
    return (
      <div style={{ background:'#0d1520', border:'2px solid #C9A227', borderRadius:'10px', padding:'16px', marginTop:'12px' }}>
        <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'14px', margin:'0 0 14px' }}>
          Generate Tow Ticket — <span style={{ fontFamily:'Courier New' }}>{ticketTarget.plate}</span>
        </p>
        <label style={lbl}>Storage Facility *</label>
        <select value={selectedStorage} onChange={e => setSelectedStorage(e.target.value)} style={inp}>
          <option value=''>Select storage facility...</option>
          {storageFacilities.map((s, i) => <option key={i} value={s.id}>{s.name} — {s.address}</option>)}
        </select>
        <label style={lbl}>VIN</label>
        <input value={vin} onChange={e => setVin(e.target.value)} placeholder="17-character VIN" style={inp} />
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
          <div>
            <label style={lbl}>Tow Fee ($)</label>
            <input type="number" value={towFee} onChange={e => setTowFee(e.target.value)} placeholder="0.00" style={inp} />
          </div>
          <div>
            <label style={lbl}>Mileage Fee ($)</label>
            <input type="number" value={mileage} onChange={e => setMileage(e.target.value)} placeholder="0.00" style={inp} />
          </div>
        </div>
        {(towFee || mileage) && (
          <p style={{ color:'#C9A227', fontSize:'12px', margin:'-6px 0 10px', textAlign:'right', fontWeight:'bold' }}>
            Total: ${(parseFloat(towFee || '0') + parseFloat(mileage || '0')).toFixed(2)}
          </p>
        )}
        <div style={{ display:'flex', gap:'8px' }}>
          <button onClick={generateTicket} disabled={!selectedStorage}
            style={{ flex:1, padding:'11px', background:!selectedStorage ? '#2a2f3d' : '#C9A227', color:!selectedStorage ? '#555' : '#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:!selectedStorage ? 'not-allowed' : 'pointer', fontFamily:'Arial' }}>
            Print Tow Ticket
          </button>
          <button onClick={() => { setTicketTarget(null); setExpandedTicketId(null) }}
            style={{ padding:'11px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
            Close
          </button>
        </div>
      </div>
    )
  }

  function printQRSign(canvasId: string, title: string, subtitle: string) {
    const container = document.getElementById(canvasId)
    const canvas = container?.querySelector('canvas') as HTMLCanvasElement | null
    const dataUrl = canvas?.toDataURL('image/png') || ''
    const tw = window.open('', '_blank')
    if (!tw) return
    tw.document.write(`<!DOCTYPE html><html><head><title>Visitor Parking Sign</title><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;background:white;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
      .card{max-width:380px;width:100%;text-align:center;border:3px solid #C9A227;border-radius:16px;padding:32px;margin:0 auto}
      .hdr{background:#0f1117;border-radius:8px;padding:12px;margin-bottom:20px}
      .note{background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:10px;margin-top:14px}
      .warn{background:#f8d7da;border:1px solid #f5c6cb;border-radius:6px;padding:10px;margin-top:10px}
      @media print{body{min-height:auto}}
    </style></head><body>
      <div class="card">
        <div class="hdr">
          <p style="color:#C9A227;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:.1em">${role?.company || 'Visitor Parking'}</p>
        </div>
        <p style="font-size:22px;font-weight:bold;color:#111;margin-bottom:4px">Visitor Parking</p>
        <p style="font-size:14px;color:#333;margin-bottom:20px">Scan to get your parking pass</p>
        <img src="${dataUrl}" style="width:200px;height:200px;display:block;margin:0 auto 16px" />
        <p style="font-size:15px;font-weight:bold;color:#111;margin-bottom:4px">${title}</p>
        <p style="font-size:11px;color:#555;margin-bottom:0">${subtitle}</p>
        <div class="note"><p style="color:#856404;font-size:12px;font-weight:bold;margin-bottom:2px">Required before parking</p><p style="color:#856404;font-size:11px">Valid up to 24 hours · No app download needed</p></div>
        <div class="warn"><p style="color:#721c24;font-size:12px;font-weight:bold;margin-bottom:2px">⚠ Unregistered vehicles will be towed</p><p style="color:#721c24;font-size:11px">without notice at owner's expense</p></div>
      </div>
      <script>window.onload=function(){window.print()}</script>
    </body></html>`)
    tw.document.close()
  }

  const tab = (t: string): React.CSSProperties => ({
    flex:1, padding:'8px', border:'none', borderRadius:'6px',
    cursor:'pointer', fontWeight:'bold', fontSize:'11px',
    background: activeTab === t ? '#C9A227' : '#1e2535',
    color: activeTab === t ? '#0f1117' : '#888',
    fontFamily:'Arial, sans-serif'
  })

  const inp: React.CSSProperties = {
    display:'block', width:'100%', marginTop:'6px', marginBottom:'10px',
    padding:'9px 10px', background:'#1e2535', border:'1px solid #3a4055',
    borderRadius:'6px', color:'white', fontSize:'12px', boxSizing:'border-box'
  }

  const lbl: React.CSSProperties = {
    color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em'
  }

  const msgBox = (msg: string) => {
    const isErr = msg.startsWith('Error') || msg.includes('failed')
    return (
      <div style={{ background: isErr ? '#3a1a1a' : '#1a3a1a', border: `1px solid ${isErr ? '#b71c1c' : '#2e7d32'}`, borderRadius:'8px', padding:'10px 12px', marginBottom:'10px' }}>
        <p style={{ color: isErr ? '#f44336' : '#4caf50', fontSize:'12px', margin:'0', whiteSpace:'pre-wrap', wordBreak:'break-all' }}>{msg}</p>
      </div>
    )
  }

  const addBtn = (label: string, onClick: () => void) => (
    <button onClick={onClick}
      style={{ width:'100%', padding:'11px', background:'#1e2535', color:'#C9A227', border:'1px dashed #C9A227', borderRadius:'8px', cursor:'pointer', fontSize:'13px', fontWeight:'bold', fontFamily:'Arial', marginBottom:'12px' }}>
      {label}
    </button>
  )

  const logoUploadBtnStyle: React.CSSProperties = { background:'#1a1f2e', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'8px', padding:'8px 14px', fontSize:'12px', cursor:'pointer', whiteSpace:'nowrap', flexShrink:0, fontFamily:'Arial' }
  const logoField = (value: string, onChange: (url: string) => void, pathPrefix: string, slot: string) => (
    <div>
      <label style={lbl}>Logo URL — paste a URL or upload an image file</label>
      <div style={{ display:'flex', gap:'6px', alignItems:'center', marginTop:'6px', marginBottom:'4px' }}>
        <input value={value} onChange={e => onChange(e.target.value)} placeholder="https://..." style={{ ...inp, marginTop:0, marginBottom:0, flex:1 }} />
        <label style={logoUploadBtnStyle}>
          ↑ Upload Logo
          <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" style={{ display:'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) uploadLogo(f, pathPrefix, slot, onChange); e.target.value = '' }} />
        </label>
      </div>
      {logoUploadMsg[slot] && <p style={{ color: logoUploadMsg[slot].includes('fail') || logoUploadMsg[slot].includes('exceed') ? '#f44336' : logoUploadMsg[slot] === 'Uploading...' ? '#C9A227' : '#4caf50', fontSize:'11px', margin:'2px 0 4px' }}>{logoUploadMsg[slot]}</p>}
      {value && <img src={value} alt="Logo preview" style={{ maxHeight:'60px', objectFit:'contain', display:'block', marginTop:'6px', marginBottom:'10px', borderRadius:'4px', border:'1px solid #2a2f3d' }} />}
      {!value && <div style={{ marginBottom:'10px' }} />}
    </div>
  )

  if (loading) return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif' }}>
      <p style={{ color:'#888' }}>Loading...</p>
    </main>
  )


  const fvs = filteredViolations()
  const isCA = role?.role === 'company_admin'

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'540px', margin:'0 auto' }}>

        {/* B66.5 commit 4.3: past_due banner (REPLACES the prior B65.2-era
            inline accountSuspended banner — suspended is now a hard redirect
            handled in mount logic; past_due is the new banner-only stage). */}
        {pastDueBanner && <PastDueBanner {...pastDueBanner} />}

        <div style={{ marginBottom:'16px', textAlign:'center' }}>
          <img src={resolvedLogo} alt={role?.company || 'ShieldMyLot'}
            style={{ width:'60px', height:'60px', borderRadius:'10px', border:'2px solid #C9A227', display:'block', margin:'0 auto 8px' }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
          <h1 style={{ color:'#C9A227', fontSize:'22px', fontWeight:'bold', margin:'0' }}>{role?.company || 'ShieldMyLot'}</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'4px 0 0' }}>Company Admin Portal</p>
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'12px 16px', marginBottom:'14px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0' }}>{role?.company || 'Company Admin'}</p>
            <p style={{ color:'#aaa', fontSize:'11px', margin:'2px 0 0' }}>{user?.email}</p>
            {(() => {
              const tierType = typeof window !== 'undefined' ? localStorage.getItem('company_tier_type') : null
              const tier = typeof window !== 'undefined' ? localStorage.getItem('company_tier') : null
              if (!tierType && !tier) return null
              const showTheme = (tierType === 'enforcement' && (tier === 'growth' || tier === 'legacy')) ||
                                (tierType === 'property_management' && (tier === 'professional' || tier === 'enterprise'))
              const themeColor = showTheme ? getThemeColor() : null
              return (
                <div style={{ display:'flex', gap:'4px', marginTop:'5px', flexWrap:'wrap' as const, alignItems:'center' }}>
                  {tierType && <span style={{ fontSize:'9px', padding:'1px 6px', borderRadius:'10px', background: tierType === 'enforcement' ? '#1a1230' : '#0e1a2a', color: tierType === 'enforcement' ? '#b39ddb' : '#4fc3f7', border:`1px solid ${tierType === 'enforcement' ? '#7c4dff' : '#0288d1'}`, textTransform:'uppercase' as const, letterSpacing:'0.05em', fontWeight:'bold' }}>{tierType === 'enforcement' ? 'Enforcement' : 'Property Mgmt'}</span>}
                  {tier && <span style={{ fontSize:'9px', padding:'1px 6px', borderRadius:'10px', background:'#1a1f0e', color:'#C9A227', border:'1px solid #C9A227', textTransform:'uppercase' as const, letterSpacing:'0.05em', fontWeight:'bold' }}>{tier}</span>}
                  {themeColor && <span title="Theme color" style={{ width:'12px', height:'12px', borderRadius:'50%', background:themeColor, display:'inline-block', border:'1px solid rgba(255,255,255,0.25)', flexShrink:0 }} />}
                </div>
              )
            })()}
          </div>
          <button onClick={async () => { await supabase.auth.signOut(); window.location.href = '/login' }}
            style={{ padding:'6px 12px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
            Sign Out
          </button>
        </div>

        {properties.length > 1 && (
          <div style={{ marginBottom:'14px' }}>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Viewing Property</label>
            <select onChange={e => switchProperty(e.target.value)} value={selectedProperty?.name || ''} style={{ ...inp, marginTop:'6px', fontSize:'13px' }}>
              {properties.map((p, i) => <option key={i} value={p.name}>{p.name}</option>)}
            </select>
          </div>
        )}

        {selectedProperty && (
          <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'12px 16px', marginBottom:'14px' }}>
            <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0' }}>{selectedProperty.name}</p>
            <p style={{ color:'#aaa', fontSize:'12px', margin:'3px 0 0' }}>{selectedProperty.address || ''}{selectedProperty.pm_name ? ` · ${selectedProperty.pm_name}` : ''}</p>
          </div>
        )}

        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'8px', marginBottom:'14px' }}>
          {[
            { label:'Vehicles', value:stats.total_vehicles, color:'#C9A227' },
            { label:'Today', value:stats.violations_today, color:'#f44336' },
            { label:'This Week', value:stats.violations_week, color:'#ff9800' },
            { label:'Visitors', value:stats.active_passes, color:'#4caf50' },
          ].map((s, i) => (
            <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', textAlign:'center' }}>
              <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0' }}>{s.label}</p>
              <p style={{ color:s.color, fontSize:'24px', fontWeight:'bold', margin:'4px 0 0', fontFamily:'Courier New' }}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* B18 resume banner — unfinished drafts from prior tab-closes.
            B38: per-draft Review + Discard controls when N > 1; the
            original two-button shape stays for N == 1. */}
        {unconfirmedDrafts.length > 0 && violationStage !== 'review' && (
          <div style={{ background: '#1a1f2e', border: '1px solid #C9A227', borderRadius: '10px', padding: '12px 14px', marginBottom: '12px' }}>
            <p style={{ color: '#C9A227', fontWeight: 'bold', fontSize: '13px', margin: '0 0 4px' }}>
              {unconfirmedDrafts.length} unfinished violation{unconfirmedDrafts.length === 1 ? '' : 's'}
            </p>
            <p style={{ color: '#aaa', fontSize: '11px', margin: '0 0 10px', lineHeight: '1.5' }}>
              You submitted but didn&apos;t confirm. Review or discard before they expire (24h).
            </p>
            {unconfirmedDrafts.length === 1 ? (
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={reviewOldestDraft}
                  style={{ flex: 1, padding: '8px 12px', background: '#C9A227', color: '#0f1117', fontWeight: 'bold', fontSize: '12px', border: 'none', borderRadius: '6px', cursor: 'pointer', fontFamily: 'Arial' }}>
                  Review oldest
                </button>
                <button onClick={discardAllUnconfirmedDrafts}
                  style={{ padding: '8px 12px', background: '#3a1a1a', color: '#f44336', fontSize: '12px', border: '1px solid #b71c1c', borderRadius: '6px', cursor: 'pointer', fontFamily: 'Arial' }}>
                  Discard all
                </button>
              </div>
            ) : (
              <>
                <div style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: '6px', padding: '4px', marginBottom: '8px' }}>
                  {unconfirmedDrafts.map(d => (
                    <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', borderBottom: '1px solid #1e2535' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ color: '#C9A227', fontFamily: 'Courier New', fontSize: '12px', fontWeight: 'bold', letterSpacing: '0.06em' }}>{d.plate || '—'}</span>
                        <span style={{ color: '#555', fontSize: '11px', marginLeft: '8px' }}>{timeAgo(d.created_at)}</span>
                      </div>
                      <button onClick={() => reviewDraft(d)}
                        style={{ padding: '4px 10px', background: '#C9A227', color: '#0f1117', fontWeight: 'bold', fontSize: '11px', border: 'none', borderRadius: '5px', cursor: 'pointer', fontFamily: 'Arial' }}>
                        Review
                      </button>
                      <button onClick={() => discardSingleDraft(d.id)}
                        style={{ padding: '4px 10px', background: '#3a1a1a', color: '#f44336', fontSize: '11px', border: '1px solid #b71c1c', borderRadius: '5px', cursor: 'pointer', fontFamily: 'Arial' }}>
                        Discard
                      </button>
                    </div>
                  ))}
                </div>
                <button onClick={discardAllUnconfirmedDrafts}
                  style={{ width: '100%', padding: '8px 12px', background: '#3a1a1a', color: '#f44336', fontSize: '12px', border: '1px solid #b71c1c', borderRadius: '6px', cursor: 'pointer', fontFamily: 'Arial' }}>
                  Discard all {unconfirmedDrafts.length}
                </button>
              </>
            )}
          </div>
        )}

        {/* B18 review screen — replaces tabs when active */}
        {violationStage === 'review' && reviewViolation && (
          <ViolationReviewScreen
            violation={reviewViolation}
            videoFileName={violationVideo?.name || null}
            videoDuration={videoDuration}
            busy={reviewBusy}
            onEdit={editFromReview}
            onConfirm={confirmReviewedViolation}
            onDiscard={discardFromReview}
            userRole="company_admin"
            userEmail={role?.email || user?.email || ''}
            onMediaRemoved={refetchReviewViolation}
          />
        )}

        {/* Tabs + tab content — hidden in review mode so the review screen owns focus */}
        {violationStage !== 'review' && (<>
        <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'14px' }}>
          <button style={tab('overview')} onClick={() => setActiveTab('overview')}>Overview</button>
          <button style={tab('lookup')} onClick={() => setActiveTab('lookup')}>Plate Lookup</button>
          <button style={tab('violations')} onClick={() => setActiveTab('violations')}>Violations</button>
          <button style={tab('visitors')} onClick={() => setActiveTab('visitors')}>Visitors</button>
          {/* B214 — manager-vetted multi-week guest authorizations. CA-portal
              variant scans cross-property (all company properties). Form's
              property dropdown sources from CA's own company's ACTIVE
              properties only (Jose lock 2026-06-20). */}
          <button style={tab('guest-auth')} onClick={() => setActiveTab('guest-auth')}>Authorized Guests</button>
          {/* Spaces v1 commit 4 — CA cross-property single-view tab with
              property selector. Sibling to manager Spaces tab; uses the same
              app/lib/spaces.ts helpers + same 6 RPC mutation surfaces. */}
          <button style={tab('spaces')} onClick={() => setActiveTab('spaces')}>Spaces</button>
          <button style={tab('qrcodes')} onClick={() => setActiveTab('qrcodes')}>QR Codes</button>
          <button style={tab('manage')} onClick={() => { setActiveTab('manage'); if (!manageLoaded) loadManageData() }}>Manage</button>
          {/* Phase 2a: Analytics tab tier-gated (Growth+ / Professional+). Admin always sees it. */}
          {(role?.role === 'admin' || hasFeature(FEATURE_FLAGS.ADVANCED_ANALYTICS, getCompanyContext()) === true) && (
            <button style={tab('analytics')} onClick={() => setActiveTab('analytics')}>Analytics</button>
          )}
          <button style={tab('plan')} onClick={() => setActiveTab('plan')}>Plan</button>
          <button style={tab('billing')} onClick={() => setActiveTab('billing')}>Billing</button>
          {/* B113: Bulk Upload nav. Tier-gated (Growth+/Professional+) via
              hasFeature; navigates to the standalone /company_admin/bulk-upload
              page rather than setting a tab (the upload flow is a heavier
              interaction that doesn't fit the always-visible tab content
              pattern). Locked at greenlight per Jose's "separate page"
              recommendation.
              B122: styled as a navigation link (gold outline + arrow) rather
              than tab('') which always rendered as a permanently-inactive
              tab and read as "disabled" beside real tab toggles. */}
          {hasFeature(FEATURE_FLAGS.BULK_UPLOAD, getCompanyContext()) === true && (
            <button
              onClick={() => { window.location.href = '/company_admin/bulk-upload' }}
              style={{
                flex: 1, padding: '8px', border: '1px solid #C9A227', borderRadius: '6px',
                cursor: 'pointer', fontWeight: 'bold', fontSize: '11px',
                background: 'transparent', color: '#C9A227', fontFamily: 'Arial, sans-serif',
              }}>
              Bulk Upload →
            </button>
          )}
        </div>

        {/* ── OVERVIEW ── */}
        {activeTab === 'overview' && (
          <div>
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Recent Violations</p>
              {violations.slice(0, 5).length === 0
                ? <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No violations found</p>
                : violations.slice(0, 5).map((v, i) => (
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom:'1px solid #1e2535' }}>
                    <span style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'13px', fontWeight:'bold' }}>{v.plate}</span>
                    <span style={{ color:'#aaa', fontSize:'12px' }}>{displayTowReason(v.violation_type)}</span>
                    <span style={{ color:'#555', fontSize:'11px' }}>{new Date(v.created_at).toLocaleDateString()}</span>
                  </div>
                ))
              }
            </div>
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Active Visitor Passes</p>
              {passes.length === 0
                ? <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No active visitor passes</p>
                : passes.map((p, i) => (
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom:'1px solid #1e2535' }}>
                    <span style={{ color:'#f59e0b', fontFamily:'Courier New', fontSize:'13px', fontWeight:'bold' }}>{p.plate}</span>
                    <span style={{ color:'#aaa', fontSize:'12px' }}>{p.visiting_unit}</span>
                    <span style={{ color:'#4caf50', fontSize:'11px' }}>Exp {new Date(p.expires_at).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}</span>
                  </div>
                ))
              }
            </div>
          </div>
        )}

        {/* ── PLATE LOOKUP ── */}
        {activeTab === 'lookup' && (
          <div>
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'22px', marginBottom:'14px' }}>
              <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.1em' }}>License Plate</label>
              <button onClick={openCamera}
                style={{ width:'100%', padding:'12px', background:'#1a1f2e', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'8px', cursor:'pointer', fontSize:'14px', fontWeight:'bold', marginTop:'8px', marginBottom:'8px', display:'flex', alignItems:'center', justifyContent:'center', gap:'8px', fontFamily:'Arial' }}>
                📷 Scan License Plate
              </button>
              <input value={plate} onChange={e => { setPlate(normalizePlate(e.target.value)); setResult(null); setTicketTarget(null); setScanMsg('') }}
                onKeyDown={e => e.key === 'Enter' && searchPlate()} placeholder="ABC1234" maxLength={10}
                style={{ display:'block', width:'100%', padding:'16px', fontSize:'28px', fontFamily:'Courier New', fontWeight:'bold', letterSpacing:'0.12em', background:'#1e2535', border:'2px solid #3a4055', borderRadius:'10px', color:'white', textAlign:'center', outline:'none', boxSizing:'border-box', textTransform:'uppercase' }}
              />
              {scanMsg && (
                <p style={{ color:'#C9A227', fontSize:'12px', margin:'4px 0 0', fontStyle:'italic' }}>{scanMsg}</p>
              )}
              <button onClick={() => searchPlate()} disabled={searching || !plate}
                style={{ marginTop:'12px', width:'100%', padding:'14px', background:!plate ? '#2a2f3d' : '#C9A227', color:!plate ? '#555' : '#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'8px', cursor:!plate ? 'not-allowed' : 'pointer', fontFamily:'Arial' }}>
                {searching ? 'Searching...' : 'Search Plate'}
              </button>

              {result && (
                <div style={{ marginTop:'16px', padding:'16px', borderRadius:'10px',
                  // B214: guest_authorized = blue (parity with driver portal).
                  // LOUD distinction per Jose 2026-06-20 — newest status, no
                  // muscle memory, tow-by-default risk is highest here.
                  background: result.status === 'authorized' ? '#061406' : result.status === 'visitor' ? '#150f00' : result.status === 'guest_authorized' ? '#0a1628' : '#140404',
                  border:`1px solid ${result.status === 'authorized' ? '#2e7d32' : result.status === 'visitor' ? '#a16207' : result.status === 'guest_authorized' ? '#3b82f6' : '#991b1b'}`
                }}>
                  {result.status === 'authorized' && (
                    <>
                      {/* Spaces v1 PII sweep (Jose 2026-06-21): Unit REMOVED
                          for CA parity with driver. CA users access PII via
                          dedicated tabs (Residents, Manage); the plate-lookup
                          surface is consistent across portals — space and
                          vehicle, not identity. Modal detail emptied. */}
                      <p style={{ color:'#4caf50', fontWeight:'bold', fontSize:'16px', margin:'0 0 12px' }}>✓ AUTHORIZED</p>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px', marginBottom:'14px' }}>
                        <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Space</span><br /><span style={{ color:'white', fontSize:'13px' }}>{result.data.space || '—'}</span></div>
                        <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Property</span><br /><span style={{ color:'#4caf50', fontSize:'13px' }}>{result.data.property}</span></div>
                        <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Vehicle</span><br /><span style={{ color:'white', fontSize:'13px' }}>{[result.data.year, result.data.color, result.data.make, result.data.model].filter(Boolean).join(' ') || '—'}</span></div>
                      </div>
                      {/* B71: authorized-plate override. Same flow as driver portal. */}
                      <button onClick={() => setDeclineModal({ authorizedAs:'resident', detail: '' })}
                        style={{ width:'100%', padding:'11px', background:'#1e2535', color:'#f59e0b', fontWeight:'bold', fontSize:'13px', border:'1px solid #f59e0b', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                        Issue Violation (location/manner override)
                      </button>
                    </>
                  )}
                  {result.status === 'guest_authorized' && (
                    <>
                      {/* B214: vetted multi-week guest authorization. LOUD
                          "DO NOT TOW" banner per Jose 2026-06-20 — same shape
                          as driver portal so CA + driver see identical
                          unambiguous copy when a guest-authorized plate is
                          scanned. */}
                      <p style={{ color:'#3b82f6', fontWeight:'bold', fontSize:'17px', margin:'0 0 8px' }}>✓ AUTHORIZED GUEST</p>
                      <div style={{ background:'#1e3a5f', borderLeft:'4px solid #3b82f6', padding:'12px 14px', borderRadius:'6px', marginBottom:'14px' }}>
                        <p style={{ color:'white', fontSize:'16px', fontWeight:'bold', margin:'0 0 4px', letterSpacing:'0.02em' }}>DO NOT TOW</p>
                        <p style={{ color:'#bfdbfe', fontSize:'12px', margin:'0', lineHeight:'1.5' }}>Manager-authorized guest. Valid through <strong style={{ color:'white' }}>{result.data.end_date}</strong>.</p>
                      </div>
                      {/* Spaces v1 PII sweep (Jose 2026-06-21, STRICT): CA
                          mirror of driver block — Guest name + Visiting Unit
                          + Approved-by REMOVED. non_resident_reason KEPT
                          (why-authorized context). Property kept (operational,
                          not PII). Dates kept. Modal detail keeps only
                          non_resident_reason. */}
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px', marginBottom:'14px' }}>
                        {result.data.non_resident_reason && (
                          <div style={{ gridColumn:'span 2' }}>
                            <span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Type</span><br />
                            <span style={{ color:'white', fontSize:'13px' }}>{result.data.non_resident_reason}</span>
                          </div>
                        )}
                        <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Property</span><br /><span style={{ color:'#3b82f6', fontSize:'13px', fontWeight:'bold' }}>{result.data.property}</span></div>
                        <div></div>
                        <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Authorized From</span><br /><span style={{ color:'white', fontSize:'13px' }}>{result.data.start_date}</span></div>
                        <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Authorized Through</span><br /><span style={{ color:'#3b82f6', fontSize:'13px', fontWeight:'bold' }}>{result.data.end_date}</span></div>
                      </div>
                      <button onClick={() => setDeclineModal({ authorizedAs:'guest', detail: result.data.non_resident_reason ? `(${result.data.non_resident_reason})` : '' })}
                        style={{ width:'100%', padding:'11px', background:'#1e2535', color:'#f59e0b', fontWeight:'bold', fontSize:'13px', border:'1px solid #f59e0b', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                        Issue Violation (location/manner override)
                      </button>
                    </>
                  )}
                  {result.status === 'expired' && (
                    <>
                      <p style={{ color:'#ff9800', fontWeight:'bold', fontSize:'16px', margin:'0 0 12px' }}>⚠ PERMIT EXPIRED</p>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px', marginBottom:'14px' }}>
                        <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Unit</span><br /><span style={{ color:'white', fontSize:'13px' }}>{result.data.unit}</span></div>
                        <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Space</span><br /><span style={{ color:'white', fontSize:'13px' }}>{result.data.space || '—'}</span></div>
                        <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Vehicle</span><br /><span style={{ color:'white', fontSize:'13px' }}>{[result.data.year, result.data.color, result.data.make, result.data.model].filter(Boolean).join(' ') || '—'}</span></div>
                      </div>
                      <button onClick={() => setShowViolation(true)}
                        style={{ width:'100%', padding:'11px', background:'#991b1b', color:'white', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                        Issue Violation
                      </button>
                    </>
                  )}
                  {result.status === 'visitor' && (
                    <>
                      {/* Spaces v1 PII sweep (Jose 2026-06-21): Visiting Unit
                          + Visitor Name REMOVED for CA parity with driver.
                          Modal detail emptied. */}
                      <p style={{ color:'#f59e0b', fontWeight:'bold', fontSize:'16px', margin:'0 0 12px' }}>✓ VISITOR PASS ACTIVE</p>
                      <div style={{ marginBottom:'14px' }}>
                        <span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Expires</span><br />
                        <span style={{ color:'#f59e0b', fontWeight:'bold', fontSize:'13px' }}>{new Date(result.data.expires_at).toLocaleString()}</span>
                      </div>
                      <p style={{ color:'#f59e0b', fontSize:'11px', margin:'0 0 12px', fontWeight:'bold' }}>Do not tow for unauthorized status — active visitor pass.</p>
                      {/* B71: location/manner override on active visitor pass. */}
                      <button onClick={() => setDeclineModal({ authorizedAs:'visitor', detail: '' })}
                        style={{ width:'100%', padding:'11px', background:'#1e2535', color:'#f59e0b', fontWeight:'bold', fontSize:'13px', border:'1px solid #f59e0b', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                        Issue Violation (location/manner override)
                      </button>
                    </>
                  )}
                  {result.status === 'otherproperty' && (
                    <>
                      <p style={{ color:'#ff9800', fontWeight:'bold', fontSize:'16px', margin:'0 0 6px' }}>⚠ DIFFERENT PROPERTY</p>
                      <p style={{ color:'#aaa', fontSize:'13px', margin:'0' }}>This plate is registered to <strong style={{ color:'white' }}>{result.data.property}</strong>, not the currently selected property.</p>
                    </>
                  )}
                  {result.status === 'notfound' && (
                    <>
                      <p style={{ color:'#f44336', fontWeight:'bold', fontSize:'16px', margin:'0 0 6px' }}>✗ NO PERMIT FOUND</p>
                      <p style={{ color:'#aaa', fontSize:'13px', margin:'0 0 12px' }}>Plate is not registered. Vehicle may be towed.</p>
                      <button onClick={() => setShowViolation(true)}
                        style={{ width:'100%', padding:'11px', background:'#991b1b', color:'white', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                        Issue Violation
                      </button>
                    </>
                  )}
                </div>
              )}

              {showViolation && (
                <div style={{ marginTop:'14px', background:'#0f0505', border:'1px solid #991b1b', borderRadius:'10px', padding:'16px' }}>
                  <p style={{ color:'#f44336', fontWeight:'bold', fontSize:'14px', margin:'0 0 14px' }}>
                    Issue Violation — <span style={{ fontFamily:'Courier New' }}>{plate}</span>
                  </p>
                  <label style={lbl}>Property *</label>
                  <select value={violation.property} onChange={e => setViolation({ ...violation, property: e.target.value })} style={inp}>
                    <option value=''>Select property...</option>
                    {properties.map((p, i) => <option key={i} value={p.name}>{p.name}</option>)}
                  </select>
                  {/* B71: locked decline-reason banner — symmetric to driver portal. */}
                  {pendingDecline && (
                    <div style={{ background:'#1e1800', border:'1px solid #C9A227', borderRadius:'8px', padding:'10px 12px', marginBottom:'12px' }}>
                      <p style={{ color:'#C9A227', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 4px', fontWeight:'bold' }}>Authorized-plate override</p>
                      <p style={{ color:'#fbbf24', fontSize:'12px', margin:'0', lineHeight:'1.5' }}>
                        {DECLINE_REASON_LABELS[pendingDecline.reason]}
                      </p>
                      {pendingDecline.note && (
                        <p style={{ color:'#aaa', fontSize:'11px', margin:'4px 0 0', lineHeight:'1.5' }}>“{pendingDecline.note}”</p>
                      )}
                    </div>
                  )}

                  <label style={lbl}>Violation Type *</label>
                  {/* Tow-reason standardization (2026-06-22): inline list
                      REMOVED; renders from app/lib/tow-reasons.ts. Option
                      value = code. RESTRICTED_ON_OVERRIDE filter replaces
                      the old !pendingDecline conditional. */}
                  <select value={violation.type} onChange={e => setViolation({ ...violation, type: e.target.value })} style={inp}>
                    <option value=''>Select type...</option>
                    {TOW_REASONS
                      .filter(r => !(pendingDecline && RESTRICTED_ON_OVERRIDE.has(r.code as TowReasonCode)))
                      .map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
                  </select>
                  <label style={lbl}>Space / Location</label>
                  <input value={violation.location} onChange={e => setViolation({ ...violation, location: e.target.value })} placeholder="e.g. Space A-14, North lot" style={inp} />
                  <label style={lbl}>Notes</label>
                  <textarea value={violation.notes} onChange={e => setViolation({ ...violation, notes: e.target.value })}
                    placeholder="Additional details..." style={{ ...inp, minHeight:'60px', resize:'vertical' as const }} />
                  <label style={lbl}>Vehicle Color (optional)</label>
                  <input value={violation.vehicle_color} onChange={e => setViolation({ ...violation, vehicle_color: e.target.value })} placeholder="e.g. White, Black, Red" style={inp} />
                  <label style={lbl}>Vehicle Make (optional)</label>
                  <input value={violation.vehicle_make} onChange={e => setViolation({ ...violation, vehicle_make: e.target.value })} placeholder="e.g. Toyota, Honda" style={inp} />
                  <label style={lbl}>Vehicle Model (optional)</label>
                  <input value={violation.vehicle_model} onChange={e => setViolation({ ...violation, vehicle_model: e.target.value })} placeholder="e.g. Camry, Civic" style={inp} />
                  <label style={lbl}>Vehicle Year (optional)</label>
                  <input type="number" min={1900} max={new Date().getFullYear() + 1} step={1} value={violation.vehicle_year} onChange={e => setViolation({ ...violation, vehicle_year: e.target.value })} placeholder="e.g. 2020" style={inp} />
                  {(() => {
                    // B42: photo count cap from tier. -1 = unlimited.
                    // Fallback: Starter (3) when localStorage tier is empty — same
                    // asymmetric most-restrictive policy as the driver portal. See
                    // driver/page.tsx for the full rationale.
                    const hasLocalStorageTier = typeof window !== 'undefined' && !!localStorage.getItem('company_tier')
                    const rawCap = Number(getLimit(FEATURE_FLAGS.MAX_PHOTOS_PER_VIOLATION, getCompanyContext()))
                    const photoCap = (hasLocalStorageTier && !isNaN(rawCap)) ? rawCap : 3
                    const photoLabel = photoCap < 0
                      ? 'Photos (optional) — 10MB each'
                      : `Photos (optional) — max ${photoCap} photos, 10MB each`
                    return (
                      <>
                        <label style={lbl}>{photoLabel}</label>
                        <input type="file" accept="image/*" multiple
                          onChange={e => {
                            const newFiles = Array.from(e.target.files || [])
                            for (const f of newFiles) {
                              if (f.size > 10 * 1024 * 1024) { alert(`Photo "${f.name}" exceeds 10MB limit. Please use standard camera mode.`); e.target.value = ''; return }
                            }
                            // B42: batch-reject if adding this batch would exceed the cap.
                            if (photoCap >= 0 && photos.length + newFiles.length > photoCap) {
                              alert(`Photo limit: ${photoCap} max per violation. You have ${photos.length} attached; this batch of ${newFiles.length} would exceed the cap.`)
                              e.target.value = ''
                              return
                            }
                            setPhotos(prev => [...prev, ...newFiles])
                            e.target.value = ''
                          }}
                          style={{ display:'block', width:'100%', marginBottom:'8px', color:'#aaa', fontSize:'12px' }} />
                      </>
                    )
                  })()}
                  {photos.length > 0 && (
                    <div style={{ display:'flex', flexWrap:'wrap', gap:'6px', marginBottom:'10px' }}>
                      {photos.map((f, i) => (
                        <span key={i} style={{ position: 'relative', display: 'inline-block' }}>
                          <img src={URL.createObjectURL(f)} alt={f.name}
                            style={{ width:'60px', height:'60px', objectFit:'cover', borderRadius:'6px', border:'1px solid #3a4055', display:'block' }} />
                          <button onClick={() => setPhotos(prev => prev.filter((_, idx) => idx !== i))}
                            aria-label={`Remove photo ${f.name}`}
                            style={{ position:'absolute', top:'2px', right:'2px', width:'18px', height:'18px', background:'rgba(15,17,23,0.85)', border:'1px solid #3a4055', borderRadius:'50%', color:'#f44336', cursor:'pointer', fontSize:'11px', padding:'0', lineHeight:'1', display:'flex', alignItems:'center', justifyContent:'center' }}>
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {(() => {
                    // Phase 2a: video duration cap pulled from tier.
                    const videoMaxSec = Number(getLimit(FEATURE_FLAGS.VIDEO_MAX_DURATION_SECONDS, getCompanyContext())) || 60
                    return (
                      <>
                        <label style={lbl}>Video (optional) — max {videoMaxSec} sec, 150MB</label>
                        <input type="file" accept="video/*"
                          onChange={e => {
                            const file = e.target.files?.[0]
                            if (!file) { setViolationVideo(null); setVideoDuration(null); return }
                            if (file.size > 150 * 1024 * 1024) { alert('Video exceeds 150MB limit. Please use standard camera mode or reduce video quality in camera settings.'); setViolationVideo(null); e.target.value = ''; return }
                            const url = URL.createObjectURL(file)
                            const vid = document.createElement('video')
                            vid.src = url
                            vid.onloadedmetadata = () => {
                              URL.revokeObjectURL(url)
                              if (vid.duration > videoMaxSec) { alert(`Video must be ${videoMaxSec} seconds or less`); setViolationVideo(null); setVideoDuration(null); e.target.value = ''; return }
                              setViolationVideo(file)
                              setVideoDuration(Math.round(vid.duration))
                            }
                          }}
                          style={{ display:'block', width:'100%', marginBottom:'8px', color:'#aaa', fontSize:'12px' }} />
                      </>
                    )
                  })()}
                  {violationVideo && (
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'5px', padding:'6px 10px', marginBottom:'10px' }}>
                      <span style={{ color:'#aaa', fontSize:'11px' }}>🎥 {violationVideo.name.length > 22 ? violationVideo.name.substring(0, 22) + '…' : violationVideo.name}{videoDuration !== null ? ` (${videoDuration}s)` : ''}</span>
                      <button onClick={() => setViolationVideo(null)} style={{ background:'none', border:'none', color:'#f44336', cursor:'pointer', fontSize:'12px', padding:'0 2px' }}>✕</button>
                    </div>
                  )}
                  <div style={{ display:'flex', gap:'8px' }}>
                    <button onClick={submitViolation} disabled={submitting}
                      style={{ flex:1, padding:'11px', background:submitting ? '#555' : '#991b1b', color:'white', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:submitting ? 'not-allowed' : 'pointer', fontFamily:'Arial' }}>
                      {submitting ? (uploadingVideo ? `Uploading video... ${uploadProgress}%` : 'Submitting...') : 'Submit Violation'}
                    </button>
                    <button onClick={() => { setShowViolation(false); setPendingDecline(null) }}
                      style={{ padding:'11px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
            {ticketTarget && activeTab === 'lookup' && renderTicketForm()}
          </div>
        )}

        {/* ── VIOLATIONS ── */}
        {activeTab === 'violations' && (
          <div>
            <input value={violationSearch} onChange={e => setViolationSearch(e.target.value)}
              placeholder="Search plate, violation type, location..."
              style={{ ...inp, fontSize:'13px', padding:'11px 12px', marginBottom:'10px' }}
            />
            <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'12px' }}>
              {[{k:'today',l:'Today'},{k:'week',l:'This Week'},{k:'sixmonths',l:'6 Months'}].map(f => (
                <button key={f.k} onClick={() => setViolationFilter(f.k)}
                  style={{ flex:1, padding:'8px', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', background:violationFilter === f.k ? '#C9A227' : 'transparent', color:violationFilter === f.k ? '#0f1117' : '#888', fontFamily:'Arial' }}>
                  {f.l}
                </button>
              ))}
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'10px' }}>
              <p style={{ color:'#444', fontSize:'11px', margin:'0' }}>{fvs.length} result{fvs.length !== 1 ? 's' : ''}</p>
              <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:'4px' }}>
                {/* Phase 2a: tow records CSV export tier-gated (Growth+ on enforcement; not
                    available on PM). Admin always sees it. Internal flag name kept
                    (TOWBOOK_CSV_EXPORT) to minimize churn; user-facing surfaces de-branded
                    2026-06-17 — see comment header on tier-display.ts. */}
                {(role?.role === 'admin' || hasFeature(FEATURE_FLAGS.TOWBOOK_CSV_EXPORT, getCompanyContext()) === true) && (
                  <button onClick={exportTowbook} style={{ background:'#1a1f2e', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'8px', padding:'8px 14px', fontSize:'12px', cursor:'pointer', fontFamily:'Arial' }}>
                    ↓ Export tow records (CSV)
                  </button>
                )}
                {exportMsg && (
                  <p style={{ color: exportMsg.startsWith('No') ? '#f44336' : '#C9A227', fontSize:'11px', margin:'0' }}>{exportMsg}</p>
                )}
              </div>
            </div>
            {fvs.length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No violations found for this period</p>
              </div>
            ) : fvs.map((v, i) => (
              <div key={i} style={{ background:'#161b26', border: v.voided_at ? '1px solid #b71c1c' : '1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px', opacity: v.voided_at ? 0.78 : 1 }}>
                {/* B175 — voided marker (CA sees same visible+marked as
                    manager/admin/driver for forensic clarity). */}
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
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'10px' }}>
                  <div>
                    <p style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                    <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{displayTowReason(v.violation_type)}</p>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <p style={{ color:'#555', fontSize:'11px', margin:'0' }}>{new Date(v.created_at).toLocaleDateString()}</p>
                    <p style={{ color:'#444', fontSize:'10px', margin:'2px 0 0' }}>{new Date(v.created_at).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}</p>
                  </div>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px', fontSize:'12px', marginBottom:'10px' }}>
                  <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Location</span><br /><span style={{ color:'#aaa' }}>{v.location || '—'}</span></div>
                  {v.driver_name && <div><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Issued By</span><br /><span style={{ color:'#aaa' }}>{v.driver_name}</span></div>}
                  {v.notes && <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555', fontSize:'10px', textTransform:'uppercase' }}>Notes</span><br /><span style={{ color:'#aaa' }}>{v.notes}</span></div>}
                </div>
                {(v.vehicle_color || v.vehicle_make || v.vehicle_model) && (
                  <p style={{ color:'#555', fontSize:'11px', margin:'0 0 10px' }}>🚗 {[v.vehicle_color, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')}</p>
                )}
                {v.photos && v.photos.length > 0 && (
                  <div style={{ marginBottom:'10px' }}>
                    <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', margin:'0 0 6px' }}>Evidence Photos</p>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'6px' }}>
                      {v.photos.map((url: string, pi: number) => (
                        <a key={pi} href={url} target="_blank" rel="noopener noreferrer">
                          <img src={url} alt={`Photo ${pi + 1}`} style={{ width:'100%', aspectRatio:'4/3', objectFit:'cover', borderRadius:'6px', border:'1px solid #2a2f3d' }} />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
                {v.video_url && (
                  <button onClick={() => window.open(v.video_url, '_blank')}
                    style={{ width:'100%', padding:'7px', background:'#0f1620', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial', marginBottom:'10px' }}>
                    ▶ Play Video
                  </button>
                )}
                {v.tow_ticket_generated && !v.voided_at && (
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', paddingBottom:'8px', borderBottom:'1px solid #2a2f3d', marginBottom:'6px' }}>
                    <span style={{ background:'#1a1500', border:'1px solid #C9A227', color:'#C9A227', fontSize:'10px', fontWeight:'bold', padding:'3px 8px', borderRadius:'4px', letterSpacing:'0.05em' }}>🎫 TOW TICKET ISSUED</span>
                    {/* B182 — replaces the divergent CA reprint template (which
                        carried prices) with the canonical public capability URL.
                        View opens it in a new tab; Copy puts the URL on the
                        clipboard for forwarding. Each click mints a fresh 90-day
                        token via set_violation_view_token. */}
                    <div style={{ display:'flex', gap:'6px' }}>
                      <button onClick={() => viewOrCopyPublicTicket(v, 'view')}
                        style={{ padding:'6px 10px', background:'#0f1620', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial' }}>
                        🌐 View
                      </button>
                      <button onClick={() => viewOrCopyPublicTicket(v, 'copy')}
                        style={{ padding:'6px 10px', background:'#0f1620', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial' }}>
                        📋 Copy Link
                      </button>
                    </div>
                  </div>
                )}
                {v.voided_at && (
                  <div style={{ display:'flex', alignItems:'center', paddingBottom:'8px', borderBottom:'1px solid #2a2f3d', marginBottom:'6px' }}>
                    <span style={{ background:'#3a1a1a', border:'1px solid #b71c1c', color:'#f44336', fontSize:'10px', fontWeight:'bold', padding:'3px 8px', borderRadius:'4px', letterSpacing:'0.05em' }}>🚫 TICKET VOIDED</span>
                  </div>
                )}
                <a href={TOWED_CAR_LOOKUP_URL} target="_blank" rel="noopener noreferrer"
                  style={{ color:'#C9A227', fontSize:'11px', textDecoration:'underline', padding:'2px 0', display:'block', marginBottom:'8px' }}>
                  🔍 Search FindMyTowedCar.org
                </a>
                {(() => {
                  const d = violationDisputes.find(d => d.violation_id === v.id)
                  if (!d) return null
                  const badge = d.status === 'pending'
                    ? { text:'⚖ Dispute Pending', bg:'#1a1200', color:'#f59e0b' }
                    : d.status === 'upheld'
                      ? { text:'⚖ Tow Upheld', bg:'#3a1a1a', color:'#f44336' }
                      : { text:'⚖ Resolved in Resident\'s Favor', bg:'#1a3a1a', color:'#4caf50' }
                  return (
                    <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'10px', padding:'7px 10px', background:badge.bg, borderRadius:'6px', border:`1px solid ${badge.color}44` }}>
                      <span style={{ color:badge.color, fontSize:'11px', fontWeight:'bold' }}>{badge.text}</span>
                      <span style={{ color:'#555', fontSize:'10px', marginLeft:'auto' }}>{d.resident_email}</span>
                    </div>
                  )
                })()}
                <button onClick={() => setEditMediaViolationId(v.id)}
                  style={{ width:'100%', padding:'9px', background:'#0f1620', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'7px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial', marginBottom:'6px' }}>
                  Manage Media
                </button>
                <button onClick={() => expandedTicketId === v.id ? (setExpandedTicketId(null), setTicketTarget(null)) : openTicketFor(v)}
                  style={{ width:'100%', padding:'9px', background:expandedTicketId === v.id ? '#1a1200' : '#0f1620', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'7px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                  {expandedTicketId === v.id ? '▲ Close Ticket' : 'Generate Tow Ticket'}
                </button>
                {expandedTicketId === v.id && renderTicketForm()}
              </div>
            ))}
          </div>
        )}

        {/* ── VISITORS ── */}
        {activeTab === 'visitors' && (
          <div>
            {passes.length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No active visitor passes</p>
              </div>
            ) : passes.map((p, i) => (
              <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'10px' }}>
                  <p style={{ color:'#f59e0b', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{p.plate}</p>
                  <span style={{ background:'#1a3a1a', color:'#4caf50', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold' }}>Active</span>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px', fontSize:'12px' }}>
                  <div><span style={{ color:'#555' }}>Visiting</span><br /><span style={{ color:'#aaa' }}>{p.visiting_unit}</span></div>
                  <div><span style={{ color:'#555' }}>Visitor</span><br /><span style={{ color:'#aaa' }}>{p.visitor_name || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Vehicle</span><br /><span style={{ color:'#aaa' }}>{p.vehicle_desc || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Duration</span><br /><span style={{ color:'#aaa' }}>{p.duration_hours} hours</span></div>
                  <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555' }}>Expires</span><br /><span style={{ color:'#f59e0b' }}>{new Date(p.expires_at).toLocaleString()}</span></div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* AUTHORIZED GUESTS (B214) — CA cross-property variant. List spans
            ALL company properties; form's property dropdown sources from the
            CA's own company's active properties only (Jose lock 2026-06-20:
            RPC rejects out-of-company properties, but the UI shouldn't offer
            one it'll then reject). */}
        {activeTab === 'guest-auth' && (
          <div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'10px' }}>
              <p style={{ color:'#888', fontSize:'12px', margin:'0' }}>Multi-week guest authorizations across all properties. Auto-expire on end date.</p>
              <button onClick={() => setShowAddGuestAuth(s => !s)}
                style={{ padding:'7px 13px', background:'#C9A227', color:'#0f1117', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                {showAddGuestAuth ? '× Close' : '+ New Authorization'}
              </button>
            </div>

            {showAddGuestAuth && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                <p style={{ color:'#C9A227', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 12px', fontWeight:'bold' }}>New guest authorization</p>

                <label style={lbl}>Property *</label>
                <select value={newGuestAuth.property}
                  onChange={e => setNewGuestAuth({ ...newGuestAuth, property: e.target.value, visiting_unit: '', resident_email: '' })}
                  style={inp}>
                  <option value=''>— Select property —</option>
                  {/* CA-company active properties only (Jose lock 2 2026-06-20) */}
                  {properties.filter(p => p.is_active).map(p => (
                    <option key={p.id} value={p.name}>{p.name}</option>
                  ))}
                </select>

                <label style={lbl}>Guest name *</label>
                <input value={newGuestAuth.guest_name} onChange={e => setNewGuestAuth({ ...newGuestAuth, guest_name: e.target.value })} style={inp} placeholder="Sarah Chen" />

                <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:'10px' }}>
                  <div>
                    <label style={lbl}>Plate *</label>
                    <input value={newGuestAuth.plate}
                      onChange={e => setNewGuestAuth({ ...newGuestAuth, plate: e.target.value.toUpperCase() })}
                      onBlur={() => { setNewGuestAuth(n => ({ ...n, plate: normalizePlate(n.plate) })); checkGuestAuthOverlap() }}
                      style={{ ...inp, fontFamily:'Courier New' }} placeholder="ABC1234" />
                  </div>
                  <div>
                    <label style={lbl}>State</label>
                    <input value={newGuestAuth.state} onChange={e => setNewGuestAuth({ ...newGuestAuth, state: e.target.value.toUpperCase().slice(0, 2) })} style={inp} maxLength={2} />
                  </div>
                </div>

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'10px' }}>
                  <div><label style={lbl}>Make</label><input value={newGuestAuth.make} onChange={e => setNewGuestAuth({ ...newGuestAuth, make: e.target.value })} style={inp} placeholder="Toyota" /></div>
                  <div><label style={lbl}>Model</label><input value={newGuestAuth.model} onChange={e => setNewGuestAuth({ ...newGuestAuth, model: e.target.value })} style={inp} placeholder="Camry" /></div>
                  <div><label style={lbl}>Color</label><input value={newGuestAuth.color} onChange={e => setNewGuestAuth({ ...newGuestAuth, color: e.target.value })} style={inp} placeholder="Silver" /></div>
                </div>

                <label style={lbl}>Authorization type</label>
                <div style={{ display:'flex', gap:'8px', marginTop:'6px', marginBottom:'10px' }}>
                  <button type="button" onClick={() => setNewGuestAuth({ ...newGuestAuth, visiting_type: 'resident' })}
                    style={{ flex:1, padding:'8px', background: newGuestAuth.visiting_type === 'resident' ? '#C9A227' : '#1e2535', color: newGuestAuth.visiting_type === 'resident' ? '#0f1117' : '#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                    Resident&apos;s guest
                  </button>
                  <button type="button" onClick={() => setNewGuestAuth({ ...newGuestAuth, visiting_type: 'non_resident' })}
                    style={{ flex:1, padding:'8px', background: newGuestAuth.visiting_type === 'non_resident' ? '#C9A227' : '#1e2535', color: newGuestAuth.visiting_type === 'non_resident' ? '#0f1117' : '#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                    Non-resident (vendor / contractor)
                  </button>
                </div>

                {newGuestAuth.visiting_type === 'resident' && (
                  <>
                    <label style={lbl}>Visiting unit *</label>
                    <select value={newGuestAuth.visiting_unit}
                      onChange={e => {
                        const u = e.target.value
                        const atUnit = caGuestAuthResidents.filter((r: any) => r.unit === u && r.is_active !== false)
                        const email = atUnit.length === 1 ? atUnit[0].email : ''
                        setNewGuestAuth({ ...newGuestAuth, visiting_unit: u, resident_email: email })
                      }}
                      disabled={!newGuestAuth.property || caGuestAuthResidentsLoading}
                      style={inp}>
                      <option value=''>
                        {!newGuestAuth.property ? 'Select a property first'
                          : caGuestAuthResidentsLoading ? 'Loading residents…'
                          : '— Select unit —'}
                      </option>
                      {Array.from(new Set(caGuestAuthResidents.filter((r: any) => r.is_active !== false).map((r: any) => r.unit))).sort().map((u: any) => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                    </select>
                    {newGuestAuth.visiting_unit && caGuestAuthResidents.filter((r: any) => r.unit === newGuestAuth.visiting_unit && r.is_active !== false).length > 1 && (
                      <>
                        <label style={lbl}>Hosting resident *</label>
                        <select value={newGuestAuth.resident_email}
                          onChange={e => setNewGuestAuth({ ...newGuestAuth, resident_email: e.target.value })} style={inp}>
                          <option value=''>— Select resident —</option>
                          {caGuestAuthResidents.filter((r: any) => r.unit === newGuestAuth.visiting_unit && r.is_active !== false).map((r: any) => (
                            <option key={r.email} value={r.email}>{r.name || r.email} ({r.email})</option>
                          ))}
                        </select>
                      </>
                    )}
                  </>
                )}

                {newGuestAuth.visiting_type === 'non_resident' && (
                  <>
                    <label style={lbl}>Reason *</label>
                    <textarea value={newGuestAuth.non_resident_reason} onChange={e => setNewGuestAuth({ ...newGuestAuth, non_resident_reason: e.target.value })}
                      placeholder="e.g., HVAC contractor — weekly service; Property landscaper — May-July contract"
                      style={{ ...inp, minHeight:'60px', resize:'vertical', fontFamily:'Arial' }} />
                  </>
                )}

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px' }}>
                  <div>
                    <label style={lbl}>Start date *</label>
                    <input type="date" value={newGuestAuth.start_date}
                      min={todayIso()}
                      onChange={e => { setNewGuestAuth({ ...newGuestAuth, start_date: e.target.value }); setGuestAuthOverlapWarning(null) }}
                      onBlur={checkGuestAuthOverlap}
                      style={inp} />
                  </div>
                  <div>
                    <label style={lbl}>End date *</label>
                    <input type="date" value={newGuestAuth.end_date}
                      min={newGuestAuth.start_date || todayIso()}
                      max={newGuestAuth.start_date ? addDays(newGuestAuth.start_date, GUEST_AUTH_MAX_DAYS) : undefined}
                      onChange={e => { setNewGuestAuth({ ...newGuestAuth, end_date: e.target.value }); setGuestAuthOverlapWarning(null) }}
                      onBlur={checkGuestAuthOverlap}
                      style={inp} />
                  </div>
                </div>
                <p style={{ color:'#555', fontSize:'10px', margin:'0 0 10px' }}>Maximum {GUEST_AUTH_MAX_DAYS} days per grant. Use Renew for longer stays (preserves audit chain).</p>

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

            {/* ACTIVE LIST — cross-property; each card shows the property name */}
            {guestAuths.length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No active guest authorizations across your company&apos;s properties</p>
              </div>
            ) : guestAuths.map(g => {
              const expSoon = isExpiringSoon(g.end_date)
              const daysLeft = daysUntilExpiry(g.end_date)
              return (
                <div key={g.id} style={{ background:'#161b26', border:`1px solid ${expSoon ? '#f59e0b' : '#2a2f3d'}`, borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                    <div>
                      <p style={{ color:'#3b82f6', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{g.plate}</p>
                      <p style={{ color:'#888', fontSize:'11px', margin:'2px 0 0' }}>{g.property}</p>
                    </div>
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
                        // Continuous coverage default (Jose lock 2026-06-20)
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
            })}

            {/* ── RENEWAL PATTERNS (B214 commit 4, Q6 oversight) ──
                Collapsible CA-only sub-section. Surfaces plates that have
                been renewed 2+ times (3+ grants total = 90+ days possible).
                Chain-aware: a single plate renewed 3x reads as ONE chain
                with renewal_count_excl_root=3, NOT as 4 overlapping grants
                (the intentional renewal-window overlap that the cascade
                handles via order-by-end-date-desc).

                Manager portal does NOT show this — it's a cross-property
                oversight tool, belongs at company-admin altitude. Lazy fetch
                on first expand. */}
            <div style={{ marginTop:'16px', borderTop:'1px solid #2a2f3d', paddingTop:'14px' }}>
              <button onClick={() => {
                  const nextOpen = !showRenewalPatterns
                  setShowRenewalPatterns(nextOpen)
                  if (nextOpen && !longChainsLoaded) loadLongChains()
                }}
                style={{ width:'100%', padding:'10px 14px', background:'#1e2535', color:'#aaa', border:'1px solid #2a2f3d', borderRadius:'8px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', textAlign:'left' }}>
                {showRenewalPatterns ? '▼' : '▸'} Renewal patterns (oversight)
                {longChainsLoaded && longChains.length > 0 && (
                  <span style={{ marginLeft:'8px', background:'#3a2a08', color:'#fbbf24', padding:'2px 8px', borderRadius:'10px', fontSize:'10px' }}>
                    {longChains.length}
                  </span>
                )}
              </button>

              {showRenewalPatterns && (
                <div style={{ marginTop:'10px', background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px' }}>
                  <p style={{ color:'#888', fontSize:'11px', margin:'0 0 12px', lineHeight:'1.5' }}>
                    Plates with <strong>3+ total grants</strong> (root + 2 or more renewals) across all your company&apos;s properties. Chain-aware — a single guest renewed multiple times reads as one chain, not multiple overlapping grants. Surfaces the &quot;guest authorization as fake residency&quot; pattern if it ever happens.
                  </p>

                  {longChainsLoading ? (
                    <p style={{ color:'#555', fontSize:'12px', margin:'0', textAlign:'center', padding:'14px' }}>Loading renewal chains…</p>
                  ) : longChains.length === 0 ? (
                    <p style={{ color:'#555', fontSize:'12px', margin:'0', textAlign:'center', padding:'14px' }}>No long renewal chains found. Clean.</p>
                  ) : (
                    <div style={{ overflowX:'auto' }}>
                      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'12px' }}>
                        <thead>
                          <tr style={{ background:'#0f1117', color:'#888', textTransform:'uppercase', fontSize:'10px', letterSpacing:'0.05em' }}>
                            <th style={{ padding:'8px', textAlign:'left' }}>Plate</th>
                            <th style={{ padding:'8px', textAlign:'left' }}>Property</th>
                            <th style={{ padding:'8px', textAlign:'left' }}>Current guest</th>
                            <th style={{ padding:'8px', textAlign:'right' }}>Renewals</th>
                            <th style={{ padding:'8px', textAlign:'right' }}>Total days</th>
                            <th style={{ padding:'8px', textAlign:'left' }}>Window</th>
                            <th style={{ padding:'8px', textAlign:'left' }}>Approved by</th>
                          </tr>
                        </thead>
                        <tbody>
                          {longChains.map((c: any) => (
                            <tr key={c.root_id} style={{ borderTop:'1px solid #2a2f3d' }}>
                              <td style={{ padding:'8px', fontFamily:'Courier New', color:'#3b82f6', fontWeight:'bold' }}>{c.plate}</td>
                              <td style={{ padding:'8px', color:'#aaa' }}>{c.property}</td>
                              <td style={{ padding:'8px', color:'#aaa' }}>{c.current_guest_name}</td>
                              <td style={{ padding:'8px', color:'#fbbf24', fontWeight:'bold', textAlign:'right' }}>{c.renewal_count_excl_root}</td>
                              <td style={{ padding:'8px', color:'#aaa', textAlign:'right' }}>{c.total_days_authorized}</td>
                              <td style={{ padding:'8px', color:'#888', fontSize:'11px' }}>{c.first_grant_start} → {c.latest_end}</td>
                              <td style={{ padding:'8px', color:'#888', fontSize:'11px' }}>
                                {(c.creator_emails as string[]).join(', ')}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* RENEW MODAL */}
            {renewGuestAuthTarget && (
              <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                <div style={{ background:'#161b26', border:'1px solid #3b82f6', borderRadius:'14px', padding:'22px', maxWidth:'440px', width:'100%' }}>
                  <p style={{ color:'#3b82f6', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px', fontWeight:'bold' }}>Renew authorization</p>
                  <p style={{ color:'white', fontSize:'14px', margin:'0 0 4px' }}>
                    <strong style={{ fontFamily:'Courier New', color:'#3b82f6' }}>{renewGuestAuthTarget.plate}</strong> — {renewGuestAuthTarget.guest_name}
                  </p>
                  <p style={{ color:'#888', fontSize:'12px', margin:'0 0 14px' }}>{renewGuestAuthTarget.property} · Current: {renewGuestAuthTarget.start_date} → {renewGuestAuthTarget.end_date}</p>

                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px' }}>
                    <div>
                      <label style={lbl}>New start *</label>
                      <input type="date" value={renewDates.start_date}
                        onChange={e => setRenewDates({ ...renewDates, start_date: e.target.value })}
                        style={inp} />
                    </div>
                    <div>
                      <label style={lbl}>New end *</label>
                      <input type="date" value={renewDates.end_date}
                        min={renewDates.start_date}
                        max={renewDates.start_date ? addDays(renewDates.start_date, GUEST_AUTH_MAX_DAYS) : undefined}
                        onChange={e => setRenewDates({ ...renewDates, end_date: e.target.value })}
                        style={inp} />
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

            {/* REVOKE MODAL */}
            {revokeGuestAuthTarget && (
              <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                <div style={{ background:'#161b26', border:'1px solid #991b1b', borderRadius:'14px', padding:'22px', maxWidth:'440px', width:'100%' }}>
                  <p style={{ color:'#f44336', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px', fontWeight:'bold' }}>Revoke authorization</p>
                  <p style={{ color:'white', fontSize:'14px', margin:'0 0 4px' }}>
                    <strong style={{ fontFamily:'Courier New', color:'#f59e0b' }}>{revokeGuestAuthTarget.plate}</strong> — {revokeGuestAuthTarget.guest_name}
                  </p>
                  <p style={{ color:'#888', fontSize:'12px', margin:'0 0 14px' }}>{revokeGuestAuthTarget.property} · This immediately strips the vehicle&apos;s authorization. Re-instatement requires a new create or renew.</p>

                  <label style={lbl}>Reason (optional, recorded in audit log)</label>
                  <textarea value={revokeReason} onChange={e => setRevokeReason(e.target.value)}
                    placeholder="e.g., Guest left early; Resident relocated; Vehicle no longer at property"
                    style={{ ...inp, minHeight:'60px', resize:'vertical', fontFamily:'Arial' }} />

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

        {/* ── SPACES v1 commit 4 — CA cross-property single-view ── */}
        {activeTab === 'spaces' && (
          <div>
            {/* Property selector (CA's company's active properties only) */}
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'12px 14px', marginBottom:'14px' }}>
              <label style={lbl}>Property</label>
              <select value={caSelectedSpacesProperty}
                onChange={e => { setCaSelectedSpacesProperty(e.target.value); setCaSpacesPage(0) }}
                style={inp}>
                <option value=''>— Select a property —</option>
                {properties.filter(p => p.is_active).map(p => (
                  <option key={p.id} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>

            {!caSelectedSpacesProperty ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>Select a property above to view its spaces.</p>
              </div>
            ) : (
              <>
                {/* Dashboard cards */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                  <p style={{ color:'#888', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 10px' }}>Reserved spaces</p>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(100px, 1fr))', gap:'8px' }}>
                    {SPACE_TYPES.map(t => {
                      const c = caOccupancy?.byType[t] ?? { total:0, assigned:0, available:0 }
                      return (
                        <div key={t} style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'10px' }}>
                          <p style={{ color:'#aaa', fontSize:'11px', margin:'0 0 4px', textTransform:'uppercase', letterSpacing:'0.05em' }}>{TYPE_LABELS[t]}</p>
                          <p style={{ color:'white', fontSize:'18px', fontWeight:'bold', margin:'0 0 2px' }}>{c.assigned}/{c.total}</p>
                          <p style={{ color:'#666', fontSize:'10px', margin:'0 0 6px' }}>assigned</p>
                          {c.total > 0 && (
                            <>
                              <button onClick={() => { setCaSpacesFilters({ ...caSpacesFilters, type:t, status:'assigned' }); setCaSpacesPage(0) }}
                                style={{ display:'block', width:'100%', padding:'4px 0', background:'transparent', color:'#3b82f6', border:'none', cursor:'pointer', fontSize:'10px', textAlign:'left' }}>{c.assigned} assigned ↓</button>
                              <button onClick={() => { setCaSpacesFilters({ ...caSpacesFilters, type:t, status:'available' }); setCaSpacesPage(0) }}
                                style={{ display:'block', width:'100%', padding:'4px 0', background:'transparent', color:c.available > 0 ? '#4caf50' : '#555', border:'none', cursor:'pointer', fontSize:'10px', textAlign:'left' }}>{c.available} open ↓</button>
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Visitor metric */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'12px 14px', marginBottom:'14px' }}>
                  <p style={{ color:'#888', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 4px' }}>Visitor</p>
                  <p style={{ color:'white', fontSize:'15px', margin:'0' }}>
                    <strong>{caOccupancy?.activeVisitorPasses ?? 0}</strong>
                    <span style={{ color:'#888' }}> / {caOccupancy?.visitorCapacity ?? '—'} in use</span>
                    {caOccupancy?.visitorCapacity != null && caOccupancy.visitorCapacity > 0 && (
                      <span style={{ color:'#666', fontSize:'11px', marginLeft:'8px' }}>({Math.round((caOccupancy.activeVisitorPasses / caOccupancy.visitorCapacity) * 100)}%)</span>
                    )}
                  </p>
                </div>

                {/* Migration banner (inert in v1) */}
                {caFlaggedMigrationCount > 0 && (
                  <div style={{ background:'#3a2a08', border:'1px solid #f59e0b', borderRadius:'10px', padding:'10px 14px', marginBottom:'14px' }}>
                    <p style={{ color:'#fbbf24', fontSize:'12px', margin:'0', fontWeight:'bold' }}>⚠ {caFlaggedMigrationCount} spaces need manual assignment.</p>
                  </div>
                )}

                {/* Filters + list */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px' }}>
                  <div style={{ display:'flex', gap:'8px', marginBottom:'10px', alignItems:'center', flexWrap:'wrap' }}>
                    <input value={caSpacesFilters.search}
                      onChange={e => { setCaSpacesFilters({ ...caSpacesFilters, search: e.target.value }); setCaSpacesPage(0) }}
                      placeholder="🔍 Search label or resident name..." style={{ ...inp, marginBottom:0, flex:'1 1 200px' }} />
                    <button onClick={() => { setCaTargetAdd(true); setCaSpacesError('') }}
                      style={{ padding:'8px 14px', background:'#C9A227', color:'#0f1117', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', whiteSpace:'nowrap' }}>+ New space</button>
                  </div>
                  <div style={{ display:'flex', gap:'8px', marginBottom:'12px', alignItems:'center', flexWrap:'wrap', fontSize:'12px' }}>
                    <span style={{ color:'#666', fontSize:'10px', textTransform:'uppercase' }}>Type:</span>
                    <select value={caSpacesFilters.type ?? ''}
                      onChange={e => { setCaSpacesFilters({ ...caSpacesFilters, type: (e.target.value || null) as SpaceType | null }); setCaSpacesPage(0) }}
                      style={{ ...inp, marginBottom:0, padding:'5px 8px', width:'auto' }}>
                      <option value=''>All</option>
                      {SPACE_TYPES.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                    </select>
                    <span style={{ color:'#666', fontSize:'10px', textTransform:'uppercase', marginLeft:'8px' }}>Status:</span>
                    <select value={caSpacesFilters.status ?? ''}
                      onChange={e => { setCaSpacesFilters({ ...caSpacesFilters, status: (e.target.value || null) as 'available'|'assigned'|null }); setCaSpacesPage(0) }}
                      style={{ ...inp, marginBottom:0, padding:'5px 8px', width:'auto' }}>
                      <option value=''>All</option><option value='available'>Available</option><option value='assigned'>Assigned</option>
                    </select>
                    <label style={{ display:'flex', alignItems:'center', gap:'5px', marginLeft:'8px', cursor:'pointer' }}>
                      <input type='checkbox' checked={caSpacesFilters.showInactive}
                        onChange={e => { setCaSpacesFilters({ ...caSpacesFilters, showInactive: e.target.checked }); setCaSpacesPage(0) }} />
                      <span style={{ color:'#aaa', fontSize:'11px' }}>Show inactive</span>
                    </label>
                  </div>

                  {caSpacesListLoading ? (
                    <p style={{ color:'#555', fontSize:'12px', textAlign:'center', padding:'24px' }}>Loading spaces…</p>
                  ) : caSpacesList.length === 0 ? (
                    <p style={{ color:'#555', fontSize:'12px', textAlign:'center', padding:'24px' }}>No spaces match the current filter.</p>
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
                            {caSpacesList.map(s => (
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
                                  {/* v1.1: cap-aware Assign (set < 2). Reassign DROPPED.
                                      Free shown when residents.length > 0. Matches commit-3 manager shape. */}
                                  {s.residents.length < 2 && s.is_active && (
                                    <button onClick={() => { setCaTargetAssign(s); setCaAssignFormEmail(''); setCaSpacesError('') }}
                                      style={{ padding:'4px 8px', background:'#3b82f6', color:'white', border:'none', borderRadius:'5px', cursor:'pointer', fontSize:'10px', fontWeight:'bold', marginLeft:'4px' }}>
                                      {s.residents.length === 0 ? 'Assign' : '+ Add resident'}
                                    </button>
                                  )}
                                  {s.residents.length > 0 && s.is_active && (
                                    <button onClick={() => { setCaTargetFree(s); setCaFreeResidentEmail(null); setCaSpacesError('') }}
                                      style={{ padding:'4px 8px', background:'#1e2535', color:'#f59e0b', border:'1px solid #f59e0b', borderRadius:'5px', cursor:'pointer', fontSize:'10px', fontWeight:'bold', marginLeft:'4px' }}>Free</button>
                                  )}
                                  <button onClick={() => { setCaTargetEdit(s); setCaEditForm({ label:s.label, description:s.description ?? '', type:s.type, is_bundled:s.is_bundled }); setCaSpacesError('') }}
                                    style={{ padding:'4px 8px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'5px', cursor:'pointer', fontSize:'10px', fontWeight:'bold', marginLeft:'4px' }}>Edit</button>
                                  {s.status === 'available' && s.is_active && (
                                    <button onClick={() => { setCaTargetDecommission(s); setCaSpacesError('') }}
                                      style={{ padding:'4px 8px', background:'#1e2535', color:'#f44336', border:'1px solid #991b1b', borderRadius:'5px', cursor:'pointer', fontSize:'10px', fontWeight:'bold', marginLeft:'4px' }}>Decommission</button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {caSpacesListTotal > caSpacesPageSize && (
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:'12px', fontSize:'11px' }}>
                          <span style={{ color:'#888' }}>Page {caSpacesPage + 1} of {Math.max(1, Math.ceil(caSpacesListTotal / caSpacesPageSize))} · {caSpacesListTotal} total</span>
                          <div style={{ display:'flex', gap:'6px' }}>
                            <button onClick={() => setCaSpacesPage(Math.max(0, caSpacesPage - 1))} disabled={caSpacesPage === 0}
                              style={{ padding:'5px 10px', background:'#1e2535', color: caSpacesPage === 0 ? '#444' : '#aaa', border:'1px solid #3a4055', borderRadius:'5px', cursor: caSpacesPage === 0 ? 'not-allowed' : 'pointer', fontSize:'11px' }}>← Prev</button>
                            <button onClick={() => setCaSpacesPage(caSpacesPage + 1)} disabled={(caSpacesPage + 1) * caSpacesPageSize >= caSpacesListTotal}
                              style={{ padding:'5px 10px', background:'#1e2535', color: (caSpacesPage + 1) * caSpacesPageSize >= caSpacesListTotal ? '#444' : '#aaa', border:'1px solid #3a4055', borderRadius:'5px', cursor: (caSpacesPage + 1) * caSpacesPageSize >= caSpacesListTotal ? 'not-allowed' : 'pointer', fontSize:'11px' }}>Next →</button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* 6 modals — same shape as manager Spaces tab, ca-prefixed state */}
                {caTargetAdd && (
                  <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                    <div style={{ background:'#161b26', border:'1px solid #C9A227', borderRadius:'14px', padding:'22px', maxWidth:'400px', width:'100%' }}>
                      <p style={{ color:'#C9A227', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 12px', fontWeight:'bold' }}>Add new space</p>
                      <label style={lbl}>Type *</label>
                      <select value={caAddForm.type} onChange={e => setCaAddForm({ type: e.target.value as SpaceType })} style={inp}>
                        {SPACE_TYPES.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                      </select>
                      <p style={{ color:'#666', fontSize:'11px', margin:'0 0 14px', lineHeight:'1.4' }}>Label auto-generates. Rename via Edit after.</p>
                      {caSpacesError && <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}><p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{caSpacesError}</p></div>}
                      <div style={{ display:'flex', gap:'8px' }}>
                        <button onClick={() => { setCaTargetAdd(false); setCaSpacesError('') }} style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Cancel</button>
                        <button onClick={caSubmitAddSingleSpace} style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Add space</button>
                      </div>
                    </div>
                  </div>
                )}
                {/* ASSIGN modal — v1.1 multi-resident: SearchableResidentPicker
                    + chips for existing ties (cap=2 advisory, server enforces).
                    INVARIANT: assigning a resident only adds a tie; it does
                    NOT touch the resident's vehicles or authorization. */}
                {caTargetAssign && (
                  <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                    <div style={{ background:'#161b26', border:'1px solid #3b82f6', borderRadius:'14px', padding:'22px', maxWidth:'460px', width:'100%' }}>
                      <p style={{ color:'#3b82f6', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px', fontWeight:'bold' }}>{caTargetAssign.residents.length === 0 ? 'Assign space' : '+ Add resident to space'}</p>
                      <p style={{ color:'white', fontSize:'14px', margin:'0 0 12px' }}><strong style={{ fontFamily:'Courier New', color:'#C9A227' }}>{caTargetAssign.label}</strong> · {TYPE_LABELS[caTargetAssign.type] ?? caTargetAssign.type}</p>

                      {caTargetAssign.residents.length > 0 && (
                        <div style={{ marginBottom:'14px' }}>
                          <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.05em', margin:'0 0 6px' }}>Currently tied ({caTargetAssign.residents.length}/2)</p>
                          <div style={{ display:'flex', flexWrap:'wrap', gap:'6px' }}>
                            {caTargetAssign.residents.map(r => (
                              <span key={r.email} style={{ background:'#0a1e3a', color:'#3b82f6', padding:'4px 8px', borderRadius:'12px', fontSize:'11px', display:'inline-flex', alignItems:'center', gap:'5px' }}>
                                {r.name || r.email}{r.unit ? ` · ${r.unit}` : ''}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {caTargetAssign.residents.length >= 2 ? (
                        <p style={{ color:'#fbbf24', fontSize:'12px', margin:'0 0 14px', padding:'10px', background:'#1a1400', border:'1px solid #a16207', borderRadius:'6px' }}>
                          This space is at the 2-resident cap. Remove one resident before adding another (via the row&apos;s Free button → per-resident).
                        </p>
                      ) : (
                        <>
                          <label style={lbl}>{caTargetAssign.residents.length === 0 ? 'Resident *' : 'Add another resident *'}</label>
                          <SearchableResidentPicker
                            property={caTargetAssign.property}
                            excludeEmails={caTargetAssign.residents.map(r => r.email)}
                            onSelect={(r: SearchableResidentPickerResult) => setCaAssignFormEmail(r.email)}
                            placeholder="Search name, unit, or plate…"
                            autoFocus
                          />
                          {caAssignFormEmail && (
                            <p style={{ color:'#4caf50', fontSize:'11px', margin:'8px 0 0' }}>
                              Selected: <strong>{caAssignFormEmail}</strong>
                            </p>
                          )}
                        </>
                      )}

                      {caSpacesError && <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 10px', marginTop:'10px', marginBottom:'10px' }}><p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{caSpacesError}</p></div>}
                      <div style={{ display:'flex', gap:'8px', marginTop:'14px' }}>
                        <button onClick={() => { setCaTargetAssign(null); setCaAssignFormEmail(''); setCaSpacesError('') }} style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>{caTargetAssign.residents.length >= 2 ? 'Close' : 'Cancel'}</button>
                        {caTargetAssign.residents.length < 2 && (
                          <button onClick={caSubmitAssignSpace} disabled={!caAssignFormEmail} style={{ flex:1, padding:'10px', background: caAssignFormEmail ? '#3b82f6' : '#555', color:'white', border:'none', borderRadius:'6px', cursor: caAssignFormEmail ? 'pointer' : 'not-allowed', fontSize:'12px', fontWeight:'bold' }}>Add</button>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* REASSIGN modal — DROPPED (v1.1 multi-resident).
                    Manager UX = 2 explicit clicks (per-resident free + add). */}

                {/* FREE modal — v1.1 multi-resident: whole-space OR per-resident.
                    INVARIANT: removing a tie NEVER touches vehicles or the
                    resident's authorization. */}
                {caTargetFree && (
                  <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                    <div style={{ background:'#161b26', border:'1px solid #f59e0b', borderRadius:'14px', padding:'22px', maxWidth:'440px', width:'100%' }}>
                      <p style={{ color:'#f59e0b', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px', fontWeight:'bold' }}>Free space</p>
                      <p style={{ color:'white', fontSize:'14px', margin:'0 0 12px' }}><strong style={{ fontFamily:'Courier New', color:'#C9A227' }}>{caTargetFree.label}</strong></p>

                      {caTargetFree.residents.length === 0 ? (
                        <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 14px' }}>This space already has no residents tied.</p>
                      ) : caTargetFree.residents.length === 1 ? (
                        <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 14px' }}>
                          Free this space from <strong style={{ color:'white' }}>{caTargetFree.residents[0].name || caTargetFree.residents[0].email}</strong>?
                          Space returns to available. Resident&apos;s vehicles + authorization are untouched.
                        </p>
                      ) : (
                        <>
                          <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 10px' }}>This space has multiple residents tied. Pick one to remove, or free the whole space.</p>
                          <div style={{ marginBottom:'14px' }}>
                            {caTargetFree.residents.map(r => (
                              <label key={r.email} style={{ display:'flex', alignItems:'center', gap:'8px', padding:'7px 10px', background: caFreeResidentEmail === r.email ? '#1e3a5f' : '#0f1117', border: `1px solid ${caFreeResidentEmail === r.email ? '#3b82f6' : '#2a2f3d'}`, borderRadius:'6px', marginBottom:'4px', cursor:'pointer' }}>
                                <input type="radio" name="ca-free-resident" checked={caFreeResidentEmail === r.email} onChange={() => setCaFreeResidentEmail(r.email)} />
                                <span style={{ color:'white', fontSize:'13px' }}>{r.name || r.email}</span>
                                {r.unit && <span style={{ color:'#666', fontSize:'11px' }}>· Unit {r.unit}</span>}
                              </label>
                            ))}
                            <label style={{ display:'flex', alignItems:'center', gap:'8px', padding:'7px 10px', background: caFreeResidentEmail === null ? '#3a2a08' : '#0f1117', border: `1px solid ${caFreeResidentEmail === null ? '#f59e0b' : '#2a2f3d'}`, borderRadius:'6px', marginTop:'6px', cursor:'pointer' }}>
                              <input type="radio" name="ca-free-resident" checked={caFreeResidentEmail === null} onChange={() => setCaFreeResidentEmail(null)} />
                              <span style={{ color:'#fbbf24', fontSize:'13px', fontWeight:'bold' }}>Free entire space (remove all {caTargetFree.residents.length} residents)</span>
                            </label>
                          </div>
                        </>
                      )}

                      {caSpacesError && <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}><p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{caSpacesError}</p></div>}
                      <div style={{ display:'flex', gap:'8px' }}>
                        <button onClick={() => { setCaTargetFree(null); setCaFreeResidentEmail(null); setCaSpacesError('') }} style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Cancel</button>
                        {caTargetFree.residents.length > 0 && (
                          <button
                            onClick={() => {
                              // 1-resident state: auto-pick that resident for per-resident free
                              // (UX equivalent to "free outright" but writes the per-resident audit).
                              // N-resident state: respect the radio selection.
                              if (caTargetFree.residents.length === 1 && caFreeResidentEmail === null) {
                                setCaFreeResidentEmail(caTargetFree.residents[0].email)
                              }
                              caSubmitFreeSpace()
                            }}
                            style={{ flex:1, padding:'10px', background:'#f59e0b', color:'#0f1117', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>
                            {caFreeResidentEmail === null && caTargetFree.residents.length > 1 ? 'Free entire space' : 'Remove'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {caTargetDecommission && (
                  <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                    <div style={{ background:'#161b26', border:'1px solid #991b1b', borderRadius:'14px', padding:'22px', maxWidth:'400px', width:'100%' }}>
                      <p style={{ color:'#f44336', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px', fontWeight:'bold' }}>Decommission space</p>
                      <p style={{ color:'white', fontSize:'14px', margin:'0 0 4px' }}><strong style={{ fontFamily:'Courier New', color:'#C9A227' }}>{caTargetDecommission.label}</strong></p>
                      <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 14px' }}>Mark inactive (history-only). Row + audit trail remain.</p>
                      {caSpacesError && <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}><p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{caSpacesError}</p></div>}
                      <div style={{ display:'flex', gap:'8px' }}>
                        <button onClick={() => { setCaTargetDecommission(null); setCaSpacesError('') }} style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Cancel</button>
                        <button onClick={caSubmitDecommissionSpace} style={{ flex:1, padding:'10px', background:'#991b1b', color:'white', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Decommission</button>
                      </div>
                    </div>
                  </div>
                )}
                {caTargetEdit && (
                  <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
                    <div style={{ background:'#161b26', border:'1px solid #C9A227', borderRadius:'14px', padding:'22px', maxWidth:'440px', width:'100%' }}>
                      <p style={{ color:'#C9A227', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 12px', fontWeight:'bold' }}>Edit space metadata</p>
                      <label style={lbl}>Label *</label>
                      <input value={caEditForm.label} onChange={e => setCaEditForm({ ...caEditForm, label: e.target.value })} style={inp} />
                      <label style={lbl}>Type *</label>
                      <select value={caEditForm.type} onChange={e => setCaEditForm({ ...caEditForm, type: e.target.value as SpaceType })} style={inp}>
                        {SPACE_TYPES.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                      </select>
                      <label style={lbl}>Description (location + reference-only price)</label>
                      <textarea value={caEditForm.description} onChange={e => setCaEditForm({ ...caEditForm, description: e.target.value })}
                        style={{ ...inp, minHeight:'50px', resize:'vertical', fontFamily:'Arial' }} />
                      <label style={{ display:'flex', alignItems:'center', gap:'6px', cursor:'pointer', margin:'4px 0 12px' }}>
                        <input type='checkbox' checked={caEditForm.is_bundled} onChange={e => setCaEditForm({ ...caEditForm, is_bundled: e.target.checked })} />
                        <span style={{ color:'#aaa', fontSize:'12px' }}>Bundled / paid (reference flag)</span>
                      </label>
                      {caSpacesError && <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}><p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{caSpacesError}</p></div>}
                      <div style={{ display:'flex', gap:'8px' }}>
                        <button onClick={() => { setCaTargetEdit(null); setCaSpacesError('') }} style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Cancel</button>
                        <button onClick={caSubmitEditMetadata} style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Save</button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Spaces v1 commit 4 — per-type pool results modal (Promise.allSettled
            outcome from property create/edit form). Surfaces per-type success/
            skip/fail with retry-failed-only action. */}
        {spacePoolResults && (
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'14px', padding:'22px', maxWidth:'480px', width:'100%' }}>
              <p style={{ color:'#C9A227', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px', fontWeight:'bold' }}>Space pool results</p>
              <p style={{ color:'white', fontSize:'14px', margin:'0 0 14px' }}>Property: <strong>{spacePoolResults.property}</strong></p>
              <div style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'10px 14px', marginBottom:'14px' }}>
                {spacePoolResults.results.map((r) => (
                  <div key={r.type} style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', padding:'4px 0', borderBottom:'1px solid #1e2535' }}>
                    <span style={{ color:'#aaa', fontSize:'12px', minWidth:'80px' }}>{TYPE_LABELS[r.type]}</span>
                    {r.status === 'success' && <span style={{ color:'#4caf50', fontSize:'12px' }}>✓ {r.count} generated</span>}
                    {r.status === 'skipped' && <span style={{ color:'#666', fontSize:'12px' }}>— skipped (count was 0)</span>}
                    {r.status === 'failed' && <span style={{ color:'#f44336', fontSize:'11px', maxWidth:'280px', textAlign:'right' }}>✗ {r.error}</span>}
                  </div>
                ))}
              </div>
              <div style={{ display:'flex', gap:'8px' }}>
                <button onClick={() => setSpacePoolResults(null)}
                  style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Close</button>
                {spacePoolResults.results.some(r => r.status === 'failed') && (
                  <button onClick={async () => {
                      const failedTypes = spacePoolResults.results.filter(r => r.status === 'failed').map(r => r.type)
                      const propertyName = spacePoolResults.property
                      setSpacePoolResults(null)
                      await runSpacePoolGenerate(propertyName, failedTypes)
                    }}
                    style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }}>Retry failed</button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── QR CODES ── */}
        {activeTab === 'qrcodes' && (
          <div>
            <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Individual Property QR Codes</p>

            {properties.map((prop, i) => {
              const url = `${BASE_URL}/visitor?property=${encodeURIComponent(prop.name)}`
              const canvasId = `qr-prop-${i}`
              return (
                <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'20px', marginBottom:'12px', textAlign:'center' }}>
                  <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0 0 16px' }}>{prop.name}</p>
                  <div id={canvasId} style={{ display:'flex', justifyContent:'center', marginBottom:'12px' }}>
                    <QRCodeCanvas value={url} size={160} level="H" includeMargin={true} />
                  </div>
                  <p style={{ color:'#444', fontSize:'10px', margin:'0 0 14px', wordBreak:'break-all', fontFamily:'Courier New' }}>{url}</p>
                  <button onClick={() => printQRSign(canvasId, prop.name, prop.address || '')}
                    style={{ width:'100%', padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'7px', cursor:'pointer', fontFamily:'Arial' }}>
                    Print This Sign
                  </button>
                </div>
              )
            })}

            {properties.length === 0 && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center', marginBottom:'12px' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No properties assigned</p>
              </div>
            )}

            <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'20px 0 4px' }}>Multi-Property QR Code</p>
            <p style={{ color:'#888', fontSize:'12px', margin:'0 0 12px', lineHeight:'1.5' }}>Use this QR code when visitors need to choose which property they are visiting.</p>

            {(() => {
              const companyUrl = `${BASE_URL}/visitor-select?company=${encodeURIComponent(role?.company || '')}`
              return (
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'20px', marginBottom:'12px', textAlign:'center' }}>
                  <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0 0 4px' }}>Company Visitor Pass — Visitor Selects Property</p>
                  <p style={{ color:'#888', fontSize:'12px', margin:'0 0 16px', lineHeight:'1.5' }}>Visitors scan this once and then pick which property they are visiting.</p>
                  <div id="qr-company" style={{ display:'flex', justifyContent:'center', marginBottom:'12px' }}>
                    <QRCodeCanvas value={companyUrl} size={160} level="H" includeMargin={true} />
                  </div>
                  <p style={{ color:'#444', fontSize:'10px', margin:'0 0 14px', wordBreak:'break-all', fontFamily:'Courier New' }}>{companyUrl}</p>
                  <button onClick={() => printQRSign('qr-company', role?.company || '', 'Select your property after scanning')}
                    style={{ width:'100%', padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'7px', cursor:'pointer', fontFamily:'Arial' }}>
                    Print This Sign
                  </button>
                </div>
              )
            })()}

            {/* Registration QR Codes */}
            <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'20px 0 4px' }}>Resident Registration QR Codes</p>
            <p style={{ color:'#888', fontSize:'12px', margin:'0 0 12px', lineHeight:'1.5' }}>Share these with new residents so they can self-register. Their account requires manager approval before login.</p>

            {properties.map((prop, i) => {
              const regUrl = `${BASE_URL}/register?property=${encodeURIComponent(prop.name)}&company=${encodeURIComponent(role?.company || '')}`
              const canvasId = `qr-reg-${i}`
              return (
                <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'20px', marginBottom:'12px', textAlign:'center' }}>
                  <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0 0 4px' }}>{prop.name}</p>
                  <p style={{ color:'#555', fontSize:'11px', margin:'0 0 14px' }}>New Resident Registration</p>
                  <div id={canvasId} style={{ display:'flex', justifyContent:'center', marginBottom:'12px' }}>
                    <QRCodeCanvas value={regUrl} size={160} level="H" includeMargin={true} />
                  </div>
                  <p style={{ color:'#444', fontSize:'10px', margin:'0 0 14px', wordBreak:'break-all', fontFamily:'Courier New' }}>{regUrl}</p>
                  <button onClick={() => {
                    const canvas = document.querySelector(`#${canvasId} canvas`) as HTMLCanvasElement
                    if (!canvas) return
                    const tw = window.open('', '_blank')!
                    tw.document.write(`<html><head><title>Registration QR - ${prop.name}</title><style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#fff;font-family:Arial,sans-serif;padding:40px}img{width:220px;height:220px}h2{color:#1A1F2E;font-size:22px;margin:16px 0 8px}p{color:#555;font-size:13px;text-align:center;max-width:320px;margin:4px 0}a{color:#C9A227;font-size:11px;word-break:break-all}</style></head><body><img src="${canvas.toDataURL()}" /><h2>${prop.name}</h2><p>Scan to register as a new resident</p><p>Your account requires manager approval before login</p><a>${regUrl}</a><script>window.print();window.close();</script></body></html>`)
                    tw.document.close()
                  }} style={{ width:'100%', padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'7px', cursor:'pointer', fontFamily:'Arial' }}>
                    Print This Sign
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {/* ── MANAGE ── */}
        {activeTab === 'manage' && (
          <div>
            {/* Sub-tab bar */}
            <div style={{ display:'flex', gap:'3px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'14px' }}>
              {(['properties', 'users', 'drivers', 'storage', 'company', 'auditlog'] as const).map(s => (
                <button key={s}
                  onClick={async () => {
                    setManageSection(s)
                    if (s === 'auditlog') fetchCompanyAuditLogs()
                    // B120 Part 2 — load current TDLR on Company sub-tab open.
                    if (s === 'company' && !companyTdlrLoaded && role?.company) {
                      const { data: c } = await supabase
                        .from('companies')
                        .select('tdlr_license_number')
                        .ilike('name', role.company)
                        .maybeSingle()
                      setCompanyTdlrInput((c?.tdlr_license_number as string | null) || '')
                      setCompanyTdlrLoaded(true)
                    }
                  }}
                  style={{
                    flex:1, padding:'7px 4px', border:'none', borderRadius:'6px', cursor:'pointer',
                    fontWeight:'bold', fontSize:'10px', fontFamily:'Arial, sans-serif',
                    background: manageSection === s ? '#C9A227' : 'transparent',
                    color: manageSection === s ? '#0f1117' : '#888',
                  }}>
                  {s === 'properties' ? 'Properties' : s === 'users' ? 'Users' : s === 'drivers' ? 'Drivers' : s === 'storage' ? 'Storage' : s === 'company' ? 'Company' : 'Audit Log'}
                </button>
              ))}
            </div>

            {/* SECTION 1 — Properties */}
            {manageSection === 'properties' && (
              <div>
                {propMsg && msgBox(propMsg)}
                {(() => {
                  if (!isCA) return null
                  const ctx = getCompanyContext()
                  const activeCount = properties.filter(p => p.is_active).length
                  const limit = getLimit(FEATURE_FLAGS.MAX_PROPERTIES, ctx)
                  const atLimit = limit >= 0 && activeCount >= limit
                  if (!atLimit) {
                    return addBtn('+ Add Property', () => { setShowAddProperty(true); setPropMsg('') })
                  }
                  const upgrade = getUpgradePrompt(FEATURE_FLAGS.MAX_PROPERTIES, ctx.tier, ctx.tier_type)
                  return (
                    <div style={{ background:'#1a1f2e', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                      <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 6px' }}>
                        Property limit reached ({activeCount} / {limit})
                      </p>
                      <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 10px', lineHeight:'1.6' }}>
                        {upgrade ? upgrade.message : 'You are on the highest tier; contact support for a custom plan.'}
                      </p>
                      <a href="/#pricing" style={{ display:'inline-block', padding:'8px 14px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'12px', borderRadius:'8px', textDecoration:'none' }}>View pricing</a>
                      {!upgrade && (
                        <a href="mailto:support@shieldmylot.com?subject=Property%20limit%20expansion" style={{ display:'inline-block', padding:'8px 14px', marginLeft:'8px', background:'#1e2535', color:'#C9A227', fontSize:'12px', border:'1px solid #C9A227', borderRadius:'8px', textDecoration:'none' }}>Contact support</a>
                      )}
                    </div>
                  )
                })()}

                {showAddProperty && isCA && (
                  <div style={{ background:'#0d1520', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Property</p>
                    {[
                      { key:'name', label:'Property Name *', placeholder:'Sunset Apartments' },
                      { key:'address', label:'Address', placeholder:'123 Main St' },
                      { key:'city', label:'City', placeholder:'Houston' },
                      { key:'state', label:'State', placeholder:'TX' },
                      { key:'zip', label:'ZIP Code', placeholder:'77001' },
                      { key:'visitor_capacity', label:'Visitor Capacity', placeholder:'120' },
                      { key:'pm_name', label:'Property Manager Name', placeholder:'John Smith' },
                      { key:'pm_phone', label:'PM Phone', placeholder:'(713) 555-0123' },
                      { key:'pm_email', label:'PM Email', placeholder:'pm@example.com' },
                    ].map(f => (
                      <div key={f.key}>
                        <label style={lbl}>{f.label}</label>
                        <input value={(newProperty as any)[f.key]} onChange={e => setNewProperty({ ...newProperty, [f.key]: e.target.value })} placeholder={f.placeholder} style={inp} />
                      </div>
                    ))}
                    {/* B51a: Towing Authorization section.
                        PDF upload is deferred to the Edit form (after the property
                        exists with an id, since the storage path is {id}/{ts}.pdf).
                        Date + notes can be set at create time. */}
                    <div style={{ marginTop:'8px', padding:'10px 12px', background:'#0d1520', border:'1px solid #3a4055', borderRadius:'8px' }}>
                      <p style={{ color:'#C9A227', fontSize:'11px', fontWeight:'bold', textTransform:'uppercase', letterSpacing:'0.05em', margin:'0 0 6px' }}>Towing Authorization (optional)</p>
                      <p style={{ color:'#555', fontSize:'10px', margin:'0 0 8px', fontStyle:'italic' }}>Upload the signed authorization PDF after saving — the upload form appears in the Edit dialog once the property exists.</p>
                      <label style={lbl}>Expiration Date</label>
                      <input type="date" value={newProperty.authorization_expiration_date} onChange={e => setNewProperty({ ...newProperty, authorization_expiration_date: e.target.value })} style={inp} />
                      <label style={lbl}>Notes</label>
                      <textarea value={newProperty.authorization_notes} maxLength={1000} onChange={e => setNewProperty({ ...newProperty, authorization_notes: e.target.value })} placeholder="Renewal terms, contact info, special conditions, etc." style={{ ...inp, minHeight:'60px', resize:'vertical' }} />
                    </div>
                    {/* Spaces v1 commit 4 — per-type reserved space pool (optional).
                        Fires generate_spaces_from_pool RPC per non-zero count after
                        the property is saved. Add-only / additive — no decrement
                        path (per Jose lock #3); remove a space via the Spaces tab
                        Decommission action. Auto-generates labels e.g. CP-1..CP-50. */}
                    <div style={{ marginTop:'8px', padding:'10px 12px', background:'#0d1520', border:'1px solid #3a4055', borderRadius:'8px' }}>
                      <p style={{ color:'#C9A227', fontSize:'11px', fontWeight:'bold', textTransform:'uppercase', letterSpacing:'0.05em', margin:'0 0 4px' }}>Reserved space pool (optional)</p>
                      <p style={{ color:'#555', fontSize:'10px', margin:'0 0 8px', fontStyle:'italic' }}>Enter how many spaces of each type to generate. Labels auto-assign (CP-1, G-1, etc.). You can rename via the Spaces tab. <strong>Add-only</strong>: lowering a number does NOT remove existing spaces — use Decommission for that.</p>
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(120px, 1fr))', gap:'8px' }}>
                        {SPACE_TYPES.map(t => (
                          <div key={t}>
                            <label style={{ ...lbl, fontSize:'10px' }}>{TYPE_LABELS[t]}</label>
                            <input type="number" min="0" value={spacePoolCounts[t]}
                              onChange={e => setSpacePoolCounts({ ...spacePoolCounts, [t]: e.target.value })}
                              placeholder="0" style={inp} />
                          </div>
                        ))}
                      </div>
                    </div>
                    <div style={{ display:'flex', gap:'8px' }}>
                      <button onClick={saveProperty} disabled={spacePoolSubmitting}
                        style={{ flex:1, padding:'11px', background: spacePoolSubmitting ? '#555' : '#C9A227', color: spacePoolSubmitting ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor: spacePoolSubmitting ? 'not-allowed' : 'pointer', fontFamily:'Arial' }}>
                        {spacePoolSubmitting ? 'Generating spaces…' : 'Save Property'}
                      </button>
                      <button onClick={() => { setShowAddProperty(false); setPropMsg(''); setSpacePoolCounts({ regular: '', carport: '', garage: '', covered: '', handicap: '', employee: '' }) }} style={{ padding:'11px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                    </div>
                  </div>
                )}

                <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:'8px' }}>
                  <button onClick={() => setShowActiveProps(s => !s)} style={{ padding:'4px 10px', background: showActiveProps ? '#1a1f2e' : '#111', color: showActiveProps ? '#C9A227' : '#555', border:`1px solid ${showActiveProps ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial' }}>{showActiveProps ? '● Active Only' : '○ Show All'}</button>
                </div>
                {(showActiveProps ? properties.filter(p => p.is_active) : properties).map((prop, i) => (
                  <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px', opacity: !showActiveProps && !prop.is_active ? 0.5 : 1 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'4px' }}>
                      <div style={{ flex:1 }}>
                        <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0' }}>{prop.name}</p>
                        {prop.address && <p style={{ color:'#888', fontSize:'11px', margin:'2px 0 0' }}>{prop.address}{prop.city ? `, ${prop.city}` : ''}{prop.state ? ` ${prop.state}` : ''}{prop.zip ? ` ${prop.zip}` : ''}</p>}
                        {prop.pm_name && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>PM: {prop.pm_name}{prop.pm_phone ? ` · ${prop.pm_phone}` : ''}</p>}
                        {prop.visitor_capacity && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>{prop.visitor_capacity} visitor cap.</p>}
                        {/* B51a: authorization summary line. Click "View PDF" → server signs URL */}
                        {prop.authorization_pdf_path ? (
                          <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>
                            📄 Authorization on file · <button onClick={() => viewAuthPdf(prop.id)} style={{ background:'none', border:'none', color:'#C9A227', fontSize:'11px', textDecoration:'underline', cursor:'pointer', padding:0, fontFamily:'inherit' }}>View PDF</button>
                            {prop.authorization_expiration_date && ` · Expires ${prop.authorization_expiration_date}`}
                          </p>
                        ) : prop.authorization_expiration_date ? (
                          <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0', fontStyle:'italic' }}>📄 No PDF on file · Expires {prop.authorization_expiration_date}</p>
                        ) : (
                          <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0', fontStyle:'italic' }}>📄 No authorization document on file</p>
                        )}
                      </div>
                      <span style={{ background: prop.is_active ? '#1a3a1a' : '#2a1a1a', color: prop.is_active ? '#4caf50' : '#f44336', padding:'2px 8px', borderRadius:'10px', fontSize:'10px', fontWeight:'bold', flexShrink:0 }}>
                        {prop.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    {isCA && (
                      <div style={{ display:'flex', gap:'6px', marginTop:'10px' }}>
                        <button onClick={() => { setEditingProperty({ ...prop, visitor_capacity: prop.visitor_capacity ? String(prop.visitor_capacity) : '' }); setPropMsg('') }}
                          style={{ flex:1, padding:'7px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Edit</button>
                        <button onClick={() => togglePropertyActive(prop)}
                          style={{ flex:1, padding:'7px', background: prop.is_active ? '#3a1a1a' : '#1a3a1a', color: prop.is_active ? '#f44336' : '#4caf50', border:`1px solid ${prop.is_active ? '#b71c1c' : '#2e7d32'}`, borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                          {prop.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    )}
                    {editingProperty?.id === prop.id && isCA && (
                      <div style={{ marginTop:'12px', padding:'12px', background:'#0d1520', borderRadius:'8px', border:'1px solid #3a4055' }}>
                        {[
                          { key:'name', label:'Name *' }, { key:'address', label:'Address' },
                          { key:'city', label:'City' }, { key:'state', label:'State' },
                          { key:'zip', label:'ZIP' }, { key:'visitor_capacity', label:'Visitor Capacity' },
                          { key:'pm_name', label:'PM Name' }, { key:'pm_phone', label:'PM Phone' },
                          { key:'pm_email', label:'PM Email' },
                        ].map(f => (
                          <div key={f.key}>
                            <label style={lbl}>{f.label}</label>
                            <input value={(editingProperty as any)[f.key] || ''} onChange={e => setEditingProperty({ ...editingProperty, [f.key]: e.target.value })} style={inp} />
                          </div>
                        ))}
                        {/* B51a: Towing Authorization section in Edit form. PDF
                            upload + replace + remove operate immediately (each is
                            its own DB UPDATE + audit log). Expiration date + notes
                            are part of the Save Changes flow. */}
                        <div style={{ marginTop:'12px', padding:'12px', background:'#161b26', border:'1px solid #3a4055', borderRadius:'8px' }}>
                          <p style={{ color:'#C9A227', fontSize:'11px', fontWeight:'bold', textTransform:'uppercase', letterSpacing:'0.05em', margin:'0 0 8px' }}>Towing Authorization</p>
                          <label style={lbl}>Authorization PDF (10MB max, .pdf only)</label>
                          {editingProperty.authorization_pdf_path ? (
                            <div style={{ display:'flex', alignItems:'center', gap:'8px', flexWrap:'wrap', background:'#0d1520', border:'1px solid #2a2f3d', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}>
                              <span style={{ color:'#aaa', fontSize:'11px', flex:1, minWidth:0, wordBreak:'break-all' }}>📄 {editingProperty.authorization_pdf_path}</span>
                              <button onClick={() => viewAuthPdf(editingProperty.id)} style={{ padding:'4px 10px', background:'#1a1f2e', color:'#C9A227', fontSize:'11px', fontWeight:'bold', border:'1px solid #C9A227', borderRadius:'5px', cursor:'pointer', fontFamily:'Arial' }}>View</button>
                              <label style={{ padding:'4px 10px', background:'#1a1f2e', color:'#C9A227', fontSize:'11px', fontWeight:'bold', border:'1px solid #C9A227', borderRadius:'5px', cursor:'pointer', fontFamily:'Arial' }}>
                                Replace
                                <input type="file" accept="application/pdf" style={{ display:'none' }}
                                  onChange={async e => {
                                    const f = e.target.files?.[0]
                                    if (!f) return
                                    await uploadAuthPdf(editingProperty.id, f, editingProperty.authorization_pdf_path)
                                    e.target.value = ''
                                  }} />
                              </label>
                              <button onClick={() => removeAuthPdf(editingProperty.id, editingProperty.authorization_pdf_path)} style={{ padding:'4px 10px', background:'#3a1a1a', color:'#f44336', fontSize:'11px', border:'1px solid #b71c1c', borderRadius:'5px', cursor:'pointer', fontFamily:'Arial' }}>Remove</button>
                            </div>
                          ) : (
                            <input type="file" accept="application/pdf"
                              onChange={async e => {
                                const f = e.target.files?.[0]
                                if (!f) return
                                await uploadAuthPdf(editingProperty.id, f, null)
                                e.target.value = ''
                              }}
                              style={{ ...inp, color:'#aaa' }} />
                          )}
                          <label style={lbl}>Expiration Date</label>
                          <input type="date" value={editingProperty.authorization_expiration_date || ''} onChange={e => setEditingProperty({ ...editingProperty, authorization_expiration_date: e.target.value })} style={inp} />
                          <label style={lbl}>Notes</label>
                          <textarea value={editingProperty.authorization_notes || ''} maxLength={1000} onChange={e => setEditingProperty({ ...editingProperty, authorization_notes: e.target.value })} placeholder="Renewal terms, contact info, special conditions, etc." style={{ ...inp, minHeight:'60px', resize:'vertical' }} />
                          <p style={{ color:'#555', fontSize:'10px', margin:'-4px 0 0', fontStyle:'italic' }}>
                            PDF changes save instantly. Expiration date + notes save when you click Save Changes below.
                          </p>
                        </div>
                        {logoField(
                          editingProperty.logo_url || '',
                          url => setEditingProperty({ ...editingProperty, logo_url: url }),
                          `companies/${(editingProperty.company || 'company').toLowerCase().replace(/\s+/g,'-')}-logo`,
                          `prop_${editingProperty.id}`
                        )}
                        {/* Spaces v1 commit 4 — per-type reserved space pool (additive on EDIT).
                            Defaults to 0 / "add N more" per Jose lock #3. RPC skips
                            existing labels; lowered count silently no-ops. Decrement
                            path explicitly NOT supported — removal is per-space Decommission. */}
                        <div style={{ marginTop:'8px', padding:'10px 12px', background:'#161b26', border:'1px solid #3a4055', borderRadius:'8px' }}>
                          <p style={{ color:'#C9A227', fontSize:'11px', fontWeight:'bold', textTransform:'uppercase', letterSpacing:'0.05em', margin:'0 0 4px' }}>Reserved space pool — add more</p>
                          <p style={{ color:'#555', fontSize:'10px', margin:'0 0 8px', fontStyle:'italic' }}>Adds N more spaces of each type after Save. Labels auto-assign sequentially. <strong>Lowering a number does NOT remove existing spaces</strong> — use the Spaces tab&apos;s Decommission action.</p>
                          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(110px, 1fr))', gap:'8px' }}>
                            {SPACE_TYPES.map(t => (
                              <div key={t}>
                                <label style={{ ...lbl, fontSize:'10px' }}>{TYPE_LABELS[t]}</label>
                                <input type="number" min="0" value={spacePoolCounts[t]}
                                  onChange={e => setSpacePoolCounts({ ...spacePoolCounts, [t]: e.target.value })}
                                  placeholder="0" style={inp} />
                              </div>
                            ))}
                          </div>
                        </div>
                        <div style={{ display:'flex', gap:'6px' }}>
                          <button onClick={updateProperty} disabled={spacePoolSubmitting}
                            style={{ flex:1, padding:'9px', background: spacePoolSubmitting ? '#555' : '#C9A227', color: spacePoolSubmitting ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'12px', border:'none', borderRadius:'6px', cursor: spacePoolSubmitting ? 'not-allowed' : 'pointer', fontFamily:'Arial' }}>
                            {spacePoolSubmitting ? 'Generating spaces…' : 'Save Changes'}
                          </button>
                          <button onClick={() => { setEditingProperty(null); setSpacePoolCounts({ regular: '', carport: '', garage: '', covered: '', handicap: '', employee: '' }) }} style={{ padding:'9px 10px', background:'#1e2535', color:'#aaa', fontSize:'11px', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {properties.length === 0 && <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}><p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No properties found</p></div>}
              </div>
            )}

            {/* SECTION 2 — Users */}
            {manageSection === 'users' && (
              <div>
                {userMsg && msgBox(userMsg)}
                {isCA && addBtn('+ Add User', () => { setShowAddUser(true); setUserMsg('') })}

                {showAddUser && isCA && (
                  <div style={{ background:'#0d1520', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New User</p>
                    {/* D2: Full Name capture. Optional; on blank the residents/
                        drivers entity rows fall back to email (preserves the
                        pre-D2 behavior) and user_roles.name lands NULL. */}
                    <label style={lbl}>Full Name</label>
                    <input value={newUser.name} onChange={e => setNewUser({ ...newUser, name: e.target.value })} placeholder="Jane Doe" style={inp} />
                    <label style={lbl}>Email *</label>
                    <input type="email" value={newUser.email} onChange={e => setNewUser({ ...newUser, email: e.target.value })} placeholder="user@example.com" style={inp} />
                    {/* D1 Commit 2: password input removed. Non-resident roles
                        receive an invite email and set their own password via
                        /reset-password-required (the route handles that arc
                        server-side). Residents auto-generate a temp password
                        which the CA hands off manually — same flow as before. */}
                    <label style={lbl}>Role *</label>
                    <select value={newUser.role} onChange={e => setNewUser({ ...newUser, role: e.target.value })} style={inp}>
                      <option value="manager">Manager</option>
                      {/* Phase 2a: leasing_agent role is tier-gated (Growth+ / Professional+).
                          Admin always sees it. */}
                      {(role?.role === 'admin'
                        || hasFeature(FEATURE_FLAGS.LEASING_AGENT_ROLE, getCompanyContext()) === true) && (
                        <option value="leasing_agent">Leasing Agent</option>
                      )}
                      <option value="driver">Driver</option>
                      <option value="resident">Resident</option>
                    </select>
                    {newUser.role === 'resident' && (
                      <p style={{ color:'#fbbf24', fontSize:'11px', margin:'-6px 0 12px' }}>
                        A temp password will be auto-generated and shown once after submit.
                      </p>
                    )}
                    <label style={lbl}>Property</label>
                    <select value={newUser.property} onChange={e => setNewUser({ ...newUser, property: e.target.value })} style={inp}>
                      <option value="">No specific property</option>
                      {properties.map((p, i) => <option key={i} value={p.name}>{p.name}</option>)}
                    </select>
                    <div style={{ display:'flex', gap:'8px' }}>
                      <button onClick={createUser} style={{ flex:1, padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Create User</button>
                      <button onClick={() => { setShowAddUser(false); setUserMsg('') }} style={{ padding:'11px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                    </div>
                  </div>
                )}

                <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:'8px' }}>
                  <button onClick={() => setShowActiveCompanyUsers(s => !s)} style={{ padding:'4px 10px', background: showActiveCompanyUsers ? '#1a1f2e' : '#111', color: showActiveCompanyUsers ? '#C9A227' : '#555', border:`1px solid ${showActiveCompanyUsers ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial' }}>{showActiveCompanyUsers ? '● Active Only' : '○ Show All'}</button>
                </div>
                {([
                  ['manager', 'Property Managers'],
                  ['leasing_agent', 'Leasing Agents'],
                  ['driver', 'Drivers'],
                  ['resident', 'Residents'],
                ] as [string, string][]).map(([role, label]) => {
                  const baseList = showActiveCompanyUsers ? companyUsers.filter(u => u.is_active !== false) : companyUsers
                  const groupUsers = baseList.filter(u => u.role === role)
                  if (groupUsers.length === 0) return null
                  const collapsed = collapsedCAGroups.has(role)
                  return (
                    <div key={role} style={{ marginBottom:'8px' }}>
                      <div onClick={() => toggleCAGroup(role)} style={{ background:'#1a1f2e', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'10px 14px', marginBottom:'6px', cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
                          <span style={{ color:'#aaa', fontSize:'12px' }}>{collapsed ? '▶' : '▼'}</span>
                          <span style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px' }}>{label}</span>
                        </div>
                        <span style={{ background:'#C9A227', color:'#0f1117', borderRadius:'10px', fontSize:'10px', padding:'2px 8px', fontWeight:'bold' }}>{groupUsers.length}</span>
                      </div>
                      {!collapsed && groupUsers.map((u, i) => (
                        <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'12px 14px', marginBottom:'6px', opacity: !showActiveCompanyUsers && u.is_active === false ? 0.5 : 1 }}>
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'6px' }}>
                            <div>
                              {/* D2: prefer name when present, else email. Email
                                  always renders underneath when name is shown so
                                  CAs can still match against their invitee list. */}
                              <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:'0' }}>{u.name || u.email}</p>
                              {u.name && <p style={{ color:'#888', fontSize:'11px', margin:'1px 0 0' }}>{u.email}</p>}
                              {u.property && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>{u.property}</p>}
                            </div>
                            <div style={{ display:'flex', gap:'6px', alignItems:'center' }}>
                              {(u.role === 'manager' || u.role === 'leasing_agent') && (
                                <span style={{ background: u.is_active !== false ? '#1a3a1a' : '#3a1a1a', color: u.is_active !== false ? '#4caf50' : '#f44336', padding:'2px 6px', borderRadius:'8px', fontSize:'9px', fontWeight:'bold' }}>
                                  {u.is_active !== false ? 'Active' : 'Inactive'}
                                </span>
                              )}
                              {/* B144 (B66.5 c4.3): tri-state activation badge for driver/resident rows */}
                              {(u.role === 'driver' || u.role === 'resident') && (() => {
                                const status = inviteStatuses[String(u.email).toLowerCase()] ?? 'unknown'
                                const isInactive = u.is_active === false
                                const label = isInactive ? 'Inactive' : (status === 'invited' ? 'Invited' : 'Active')
                                const bg = isInactive ? '#3a1a1a' : (status === 'invited' ? '#3a2a08' : '#1a3a1a')
                                const color = isInactive ? '#f44336' : (status === 'invited' ? '#fbbf24' : '#4caf50')
                                return (
                                  <span style={{ background: bg, color, padding:'2px 6px', borderRadius:'8px', fontSize:'9px', fontWeight:'bold' }}>
                                    {label}
                                  </span>
                                )
                              })()}
                            </div>
                          </div>
                          <div style={{ display:'flex', gap:'6px', flexWrap:'wrap' as const }}>
                            <button onClick={() => { setResetPwTarget(resetPwTarget === u.email ? null : u.email); setResetPwForm({ newPw:'', confirmPw:'' }); setResetPwMsg('') }}
                              style={{ padding:'4px 10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                              {resetPwTarget === u.email ? 'Cancel' : 'Reset Password'}
                            </button>
                            {/* B144 (B66.5 c4.3): Resend Invite — only renders for driver/resident */}
                            {/*  with status='invited' AND is_active!=false. 60s client disable. */}
                            {/* B66.5.1: extended with Q4 defense-in-depth account_state check */}
                            {/*  (parity with Drivers tab Resend button). Hidden when suspended/cancelled. */}
                            {(u.role === 'driver' || u.role === 'resident')
                              && u.is_active !== false
                              && inviteStatuses[String(u.email).toLowerCase()] === 'invited'
                              && (companyAccountState === null
                                  || companyAccountState === 'active'
                                  || companyAccountState === 'past_due')
                              && (() => {
                                const lc = String(u.email).toLowerCase()
                                const disabledUntil = resendDisabledUntil[lc] ?? 0
                                const disabled = resendingEmail === lc || disabledUntil > Date.now()
                                return (
                                  <button onClick={() => resendInviteForUser(lc)} disabled={disabled}
                                    style={{ padding:'4px 10px', background: disabled ? '#1e2535' : '#1a1f2e', color: disabled ? '#555' : '#fbbf24', border:`1px solid ${disabled ? '#3a4055' : '#f59e0b'}`, borderRadius:'6px', cursor: disabled ? 'not-allowed' : 'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                                    {resendingEmail === lc ? 'Resending…' : (disabledUntil > Date.now() ? 'Sent ✓' : 'Resend Invite')}
                                  </button>
                                )
                              })()}
                            {(u.role === 'manager' || u.role === 'leasing_agent') && (
                              u.is_active !== false ? (
                                <button onClick={() => toggleUserActive(u.email, false)} disabled={togglingUser === u.email}
                                  style={{ padding:'4px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                                  {togglingUser === u.email ? '...' : 'Deactivate'}
                                </button>
                              ) : (
                                <button onClick={() => toggleUserActive(u.email, true)} disabled={togglingUser === u.email}
                                  style={{ padding:'4px 10px', background:'#1a3a1a', color:'#4caf50', border:'1px solid #2e7d32', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                                  {togglingUser === u.email ? '...' : 'Activate'}
                                </button>
                              )
                            )}
                          </div>
                          {resetPwTarget === u.email && (
                            <div style={{ marginTop:'10px', borderTop:'1px solid #2a2f3d', paddingTop:'10px' }}>
                              <input type="password" value={resetPwForm.newPw} onChange={e => setResetPwForm(f => ({...f, newPw: e.target.value}))}
                                placeholder="New password (min 8 chars)" style={{ ...inp, marginBottom:'8px' }} />
                              <input type="password" value={resetPwForm.confirmPw} onChange={e => setResetPwForm(f => ({...f, confirmPw: e.target.value}))}
                                placeholder="Confirm new password" style={{ ...inp, marginBottom:'8px' }} />
                              {resetPwMsg && (
                                <p style={{ color: resetPwMsg.includes('success') ? '#4caf50' : '#f44336', fontSize:'12px', margin:'0 0 8px' }}>{resetPwMsg}</p>
                              )}
                              <button onClick={resetUserPassword}
                                style={{ width:'100%', padding:'8px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'12px', border:'none', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>
                                Save New Password
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                })}
                {companyUsers.length === 0 && <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}><p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No users found</p></div>}
              </div>
            )}

            {/* SECTION 3 — Drivers */}
            {manageSection === 'drivers' && (
              <div>
                {driverMsg && msgBox(driverMsg)}
                {isCA && (() => {
                  // Phase 2a: tier-gate the Add Driver button.
                  // Admin always sees the button. CA hides it when at limit;
                  // race-guard in createDriver() backstops if button is clicked
                  // before companyDrivers state refreshes.
                  if (role?.role === 'admin') {
                    return addBtn('+ Add Driver', () => { setShowAddDriver(true); setDriverMsg('') })
                  }
                  const ctx = getCompanyContext()
                  const activeCount = companyDrivers.filter(d => d.is_active).length
                  const underLimit = isUnderLimit(FEATURE_FLAGS.MAX_DRIVERS, activeCount, ctx)
                  if (underLimit) {
                    return addBtn('+ Add Driver', () => { setShowAddDriver(true); setDriverMsg('') })
                  }
                  const limit = getLimit(FEATURE_FLAGS.MAX_DRIVERS, ctx)
                  const upgrade = getUpgradePrompt(FEATURE_FLAGS.MAX_DRIVERS, ctx.tier, ctx.tier_type)
                  return (
                    <div style={{ background:'#1a1200', border:'1px solid #C9A227', borderRadius:'8px', padding:'10px 12px', marginBottom:'12px' }}>
                      <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', margin:'0 0 4px' }}>
                        Driver limit reached ({activeCount} of {limit})
                      </p>
                      {upgrade && (
                        <p style={{ color:'#aaa', fontSize:'11px', margin:0 }}>{upgrade.message}</p>
                      )}
                    </div>
                  )
                })()}

                {showAddDriver && isCA && (
                  <div style={{ background:'#0d1520', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Driver</p>
                    <label style={lbl}>Full Name *</label>
                    <input value={newDriver.name} onChange={e => setNewDriver({ ...newDriver, name: e.target.value })} placeholder="Jane Doe" style={inp} />
                    <label style={lbl}>Email *</label>
                    <input type="email" value={newDriver.email} onChange={e => setNewDriver({ ...newDriver, email: e.target.value })} placeholder="driver@example.com" style={inp} />
                    <label style={lbl}>Phone</label>
                    <input value={newDriver.phone} onChange={e => setNewDriver({ ...newDriver, phone: e.target.value })} placeholder="(713) 555-0123" style={inp} />
                    <label style={lbl}>Operator License</label>
                    <input value={newDriver.operator_license} onChange={e => setNewDriver({ ...newDriver, operator_license: e.target.value })} placeholder="License number" style={inp} />
                    <label style={lbl}>Assigned Properties</label>
                    <div style={{ marginTop:'6px', marginBottom:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', padding:'8px 10px' }}>
                      <label style={{ display:'flex', alignItems:'center', gap:'8px', padding:'4px 0', cursor:'pointer', borderBottom:'1px solid #2a2f3d', marginBottom:'4px' }}>
                        <input type="checkbox"
                          checked={newDriver.assigned_properties.length === properties.length && properties.length > 0}
                          onChange={e => setNewDriver({ ...newDriver, assigned_properties: e.target.checked ? properties.map(p => p.name) : [] })}
                          style={{ accentColor:'#C9A227', cursor:'pointer' }}
                        />
                        <span style={{ color:'#C9A227', fontSize:'12px', fontWeight:'bold' }}>Select All</span>
                      </label>
                      {properties.map((p, i) => (
                        <label key={i} style={{ display:'flex', alignItems:'center', gap:'8px', padding:'4px 0', cursor:'pointer' }}>
                          <input type="checkbox"
                            checked={newDriver.assigned_properties.includes(p.name)}
                            onChange={e => {
                              if (e.target.checked) setNewDriver({ ...newDriver, assigned_properties: [...newDriver.assigned_properties, p.name] })
                              else setNewDriver({ ...newDriver, assigned_properties: newDriver.assigned_properties.filter(n => n !== p.name) })
                            }}
                            style={{ accentColor:'#C9A227', cursor:'pointer' }}
                          />
                          <span style={{ color:'#aaa', fontSize:'12px' }}>{p.name}</span>
                        </label>
                      ))}
                    </div>
                    <div style={{ display:'flex', gap:'8px' }}>
                      <button onClick={createDriver} style={{ flex:1, padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Create Driver</button>
                      <button onClick={() => { setShowAddDriver(false); setDriverMsg('') }} style={{ padding:'11px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                    </div>
                  </div>
                )}

                {editingDriver && (
                  <div style={{ background:'#0d1520', border:'2px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Edit Driver — {editingDriver.name}</p>
                    <label style={lbl}>Full Name</label>
                    <input value={editingDriver.name || ''} onChange={e => setEditingDriver({ ...editingDriver, name: e.target.value })} style={inp} />
                    <label style={lbl}>Phone</label>
                    <input value={editingDriver.phone || ''} onChange={e => setEditingDriver({ ...editingDriver, phone: e.target.value })} style={inp} />
                    <label style={lbl}>Operator License</label>
                    <input value={editingDriver.operator_license || ''} onChange={e => setEditingDriver({ ...editingDriver, operator_license: e.target.value })} style={inp} />
                    <label style={lbl}>Assigned Properties</label>
                    <div style={{ marginTop:'6px', marginBottom:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', padding:'8px 10px' }}>
                      <label style={{ display:'flex', alignItems:'center', gap:'8px', padding:'4px 0', cursor:'pointer', borderBottom:'1px solid #2a2f3d', marginBottom:'4px' }}>
                        <input type="checkbox"
                          checked={(editingDriver.assigned_properties || []).length === properties.length && properties.length > 0}
                          onChange={e => setEditingDriver({ ...editingDriver, assigned_properties: e.target.checked ? properties.map(p => p.name) : [] })}
                          style={{ accentColor:'#C9A227', cursor:'pointer' }}
                        />
                        <span style={{ color:'#C9A227', fontSize:'12px', fontWeight:'bold' }}>Select All</span>
                      </label>
                      {properties.map((p, i) => (
                        <label key={i} style={{ display:'flex', alignItems:'center', gap:'8px', padding:'4px 0', cursor:'pointer' }}>
                          <input type="checkbox"
                            checked={(editingDriver.assigned_properties || []).includes(p.name)}
                            onChange={e => {
                              const cur: string[] = editingDriver.assigned_properties || []
                              if (e.target.checked) setEditingDriver({ ...editingDriver, assigned_properties: [...cur, p.name] })
                              else setEditingDriver({ ...editingDriver, assigned_properties: cur.filter((n: string) => n !== p.name) })
                            }}
                            style={{ accentColor:'#C9A227', cursor:'pointer' }}
                          />
                          <span style={{ color:'#aaa', fontSize:'12px' }}>{p.name}</span>
                        </label>
                      ))}
                    </div>
                    <div style={{ display:'flex', gap:'8px' }}>
                      <button onClick={updateDriver} style={{ flex:1, padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Save Changes</button>
                      <button onClick={() => { setEditingDriver(null); setDriverMsg('') }} style={{ padding:'11px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                    </div>
                  </div>
                )}

                <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:'8px' }}>
                  <button onClick={() => setShowActiveCompanyDrivers(s => !s)} style={{ padding:'4px 10px', background: showActiveCompanyDrivers ? '#1a1f2e' : '#111', color: showActiveCompanyDrivers ? '#C9A227' : '#555', border:`1px solid ${showActiveCompanyDrivers ? '#C9A227' : '#333'}`, borderRadius:'20px', fontSize:'11px', cursor:'pointer', fontFamily:'Arial' }}>{showActiveCompanyDrivers ? '● Active Only' : '○ Show All'}</button>
                </div>
                {(showActiveCompanyDrivers ? companyDrivers.filter(d => d.is_active) : companyDrivers).map((d, i) => (
                  <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'12px 14px', marginBottom:'8px', opacity: !showActiveCompanyDrivers && !d.is_active ? 0.5 : 1 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                      <div>
                        <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:'0' }}>{d.name}</p>
                        <p style={{ color:'#888', fontSize:'11px', margin:'2px 0 0' }}>{d.email}</p>
                        {d.phone && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>{d.phone}</p>}
                        {d.operator_license && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>Lic: {d.operator_license}</p>}
                        {d.assigned_properties?.length > 0 && <p style={{ color:'#C9A227', fontSize:'11px', margin:'4px 0 0' }}>{Array.isArray(d.assigned_properties) ? d.assigned_properties.join(', ') : d.assigned_properties}</p>}
                      </div>
                      {/* B66.5.1 (Item 2): tri-state badge mirroring the
                          Users list pattern at line ~2669. Inactive (soft-
                          deleted via deactivate) wins over invite status —
                          inactive drivers never show as "Invited". */}
                      {(() => {
                        const status = inviteStatuses[String(d.email).toLowerCase()] ?? 'unknown'
                        const isInactive = d.is_active === false
                        const label = isInactive ? 'Inactive' : (status === 'invited' ? 'Invited' : 'Active')
                        const bg = isInactive ? '#2a1a1a' : (status === 'invited' ? '#3a2a08' : '#1a3a1a')
                        const color = isInactive ? '#f44336' : (status === 'invited' ? '#fbbf24' : '#4caf50')
                        return (
                          <span style={{ background: bg, color, padding:'2px 8px', borderRadius:'10px', fontSize:'10px', fontWeight:'bold' }}>
                            {label}
                          </span>
                        )
                      })()}
                    </div>
                    {isCA && (
                      <div style={{ display:'flex', gap:'6px', marginTop:'8px' }}>
                        <button onClick={() => { setEditingDriver({...d, assigned_properties: Array.isArray(d.assigned_properties) ? d.assigned_properties : []}); setShowAddDriver(false); setDriverMsg('') }}
                          style={{ flex:1, padding:'7px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                          Edit
                        </button>
                        <button onClick={() => toggleDriverActive(d)}
                          style={{ flex:1, padding:'7px', background: d.is_active ? '#3a1a1a' : '#1a3a1a', color: d.is_active ? '#f44336' : '#4caf50', border:`1px solid ${d.is_active ? '#b71c1c' : '#2e7d32'}`, borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                          {d.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                        {/* B66.5.1 (Item 2 + Q4): Resend Invite — only when
                            status='invited' AND is_active!=false AND
                            account_state allows (active OR past_due; suspended/
                            cancelled disable per Q4 defense-in-depth). */}
                        {d.is_active !== false
                          && inviteStatuses[String(d.email).toLowerCase()] === 'invited'
                          && (companyAccountState === null
                              || companyAccountState === 'active'
                              || companyAccountState === 'past_due')
                          && (() => {
                            const lc = String(d.email).toLowerCase()
                            const disabledUntil = resendDisabledUntil[lc] ?? 0
                            const disabled = resendingEmail === lc || disabledUntil > Date.now()
                            return (
                              <button onClick={() => resendInviteForUser(lc)} disabled={disabled}
                                style={{ flex:1, padding:'7px', background: disabled ? '#1e2535' : '#1a1f2e', color: disabled ? '#555' : '#fbbf24', border:`1px solid ${disabled ? '#3a4055' : '#f59e0b'}`, borderRadius:'6px', cursor: disabled ? 'not-allowed' : 'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                                {resendingEmail === lc ? 'Resending…' : (disabledUntil > Date.now() ? 'Sent ✓' : 'Resend Invite')}
                              </button>
                            )
                          })()}
                      </div>
                    )}
                  </div>
                ))}
                {companyDrivers.length === 0 && <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}><p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No drivers found</p></div>}
              </div>
            )}

            {/* SECTION 4 — Storage Facilities */}
            {manageSection === 'storage' && (
              <div>
                <div style={{ background:'#1a1e2e', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'10px 12px', marginBottom:'12px' }}>
                </div>
                {facilityMsg && msgBox(facilityMsg)}
                {isCA && addBtn('+ Add Storage Facility', () => { setShowAddFacility(true); setFacilityMsg('') })}

                {showAddFacility && isCA && (
                  <div style={{ background:'#0d1520', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Storage Facility</p>
                    <label style={lbl}>Facility Name *</label>
                    <input value={newFacility.name} onChange={e => setNewFacility({ ...newFacility, name: e.target.value })} placeholder="Houston Impound" style={inp} />
                    <label style={lbl}>Address *</label>
                    <input value={newFacility.address} onChange={e => setNewFacility({ ...newFacility, address: e.target.value })} placeholder="456 Storage Blvd, Houston TX" style={inp} />
                    <label style={lbl}>Phone</label>
                    <input value={newFacility.phone} onChange={e => setNewFacility({ ...newFacility, phone: e.target.value })} placeholder="(713) 555-0100" style={inp} />
                    <label style={lbl}>Email</label>
                    <input type="email" value={newFacility.email} onChange={e => setNewFacility({ ...newFacility, email: e.target.value })} placeholder="storage@example.com" style={inp} />
                    <label style={lbl}>VSF License Number (optional)</label>
                    <input value={newFacility.vsf_license_number} onChange={e => setNewFacility({ ...newFacility, vsf_license_number: e.target.value })} placeholder="Vehicle Storage Facility license #" style={inp} />
                    <div style={{ display:'flex', gap:'8px' }}>
                      <button onClick={createFacility} style={{ flex:1, padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Add Facility</button>
                      <button onClick={() => { setShowAddFacility(false); setFacilityMsg('') }} style={{ padding:'11px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                    </div>
                  </div>
                )}

                {allFacilities.map((f, i) => (
                  <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'12px 14px', marginBottom:'8px' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                      <div>
                        <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:'0' }}>{f.name}</p>
                        <p style={{ color:'#888', fontSize:'11px', margin:'2px 0 0' }}>{f.address}</p>
                        {f.phone && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>{f.phone}</p>}
                        {f.email && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>{f.email}</p>}
                        {f.vsf_license_number && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0 0' }}>VSF #: {f.vsf_license_number}</p>}
                      </div>
                      <span style={{ background: f.is_active ? '#1a3a1a' : '#2a1a1a', color: f.is_active ? '#4caf50' : '#f44336', padding:'2px 8px', borderRadius:'10px', fontSize:'10px', fontWeight:'bold' }}>
                        {f.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  </div>
                ))}
                {allFacilities.length === 0 && <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}><p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No storage facilities found</p></div>}
              </div>
            )}

            {/* SECTION 5 — Company (B120 Part 2: CA-side TDLR capture) */}
            {/* Surgical single-field write surface: TDLR is the only column
                this surface mutates. Backed by update_my_company_tdlr DEFINER
                RPC (role gate = company_admin; scope gate = own company by
                get_my_company; empty-string → NULL coerced server-side).
                Optional / nullable / no validation, mirroring the sibling
                VSF + operator_license patterns. */}
            {manageSection === 'company' && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'18px' }}>
                <p style={{ color:'#888', fontSize:'11px', margin:'0 0 14px', lineHeight:1.5 }}>
                  Your company&apos;s TDLR license number, when set, appears on tow tickets your team issues. Leave blank if not applicable.
                </p>
                {companyTdlrMsg && msgBox(companyTdlrMsg)}
                <label style={lbl}>TDLR License Number (optional)</label>
                <input
                  value={companyTdlrInput}
                  onChange={e => setCompanyTdlrInput(e.target.value)}
                  placeholder="Texas tow-company license #"
                  style={inp}
                />
                <button
                  onClick={async () => {
                    setCompanyTdlrSaving(true)
                    setCompanyTdlrMsg('')
                    const { data, error } = await supabase.rpc('update_my_company_tdlr', { p_tdlr: companyTdlrInput })
                    setCompanyTdlrSaving(false)
                    if (error) {
                      setCompanyTdlrMsg('Error: ' + error.message)
                      return
                    }
                    const result = data as { ok?: boolean; tdlr_license_number?: string | null; error?: string }
                    if (!result?.ok) {
                      setCompanyTdlrMsg('Error: ' + (result?.error || 'unknown'))
                      return
                    }
                    // Reflect canonical normalized value (e.g. trimmed / NULL'd)
                    // back into the field so what's shown matches what's stored.
                    setCompanyTdlrInput(result.tdlr_license_number || '')
                    setCompanyTdlrMsg('Saved.')
                  }}
                  disabled={companyTdlrSaving}
                  style={{
                    marginTop: 12, padding:'10px 16px', background: companyTdlrSaving ? '#2a2f3d' : '#C9A227',
                    color: companyTdlrSaving ? '#555' : '#0f1117', fontWeight:'bold', fontSize:'12px',
                    border:'none', borderRadius:'8px', cursor: companyTdlrSaving ? 'not-allowed' : 'pointer',
                    fontFamily:'Arial, sans-serif',
                  }}>
                  {companyTdlrSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}

            {/* SECTION 6 — Audit Log */}
            {manageSection === 'auditlog' && (() => {
              const today = new Date(); today.setHours(0,0,0,0)
              const week = new Date(); week.setDate(week.getDate()-7)
              const month = new Date(); month.setMonth(month.getMonth()-1)
              const filtered = companyAuditLogs.filter(log => {
                const d = new Date(log.created_at)
                const inPeriod = auditDateFilter === 'today' ? d >= today : auditDateFilter === 'week' ? d >= week : auditDateFilter === 'month' ? d >= month : true
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
                    {[{k:'today',l:'Today'},{k:'week',l:'This Week'},{k:'month',l:'Month'},{k:'all',l:'All'}].map(f => (
                      <button key={f.k} onClick={() => setAuditDateFilter(f.k)}
                        style={{ flex:1, padding:'7px', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'10px', fontWeight:'bold', background: auditDateFilter === f.k ? '#C9A227' : 'transparent', color: auditDateFilter === f.k ? '#0f1117' : '#888', fontFamily:'Arial' }}>
                        {f.l}
                      </button>
                    ))}
                  </div>
                  <input value={auditSearch} onChange={e => setAuditSearch(e.target.value)} placeholder="Search email, action..." style={{ ...inp, marginBottom:'10px' }} />
                  {!auditLoaded ? (
                    <p style={{ color:'#555', fontSize:'13px', textAlign:'center', margin:'32px 0' }}>Loading...</p>
                  ) : filtered.length === 0 ? (
                    <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                      <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No activity for this period</p>
                    </div>
                  ) : filtered.map((log, i) => {
                    const vals = log.new_values ? Object.entries(log.new_values as Record<string,unknown>).map(([k,v]) => `${k}: ${v}`).join(' · ') : ''
                    return (
                      <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', marginBottom:'8px' }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'6px' }}>
                          <span style={{ background:'#1e1800', color:'#C9A227', padding:'2px 8px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold', letterSpacing:'0.04em' }}>{log.action}</span>
                          <span style={{ color:'#888', fontSize:'10px' }}>{new Date(log.created_at).toLocaleString()}</span>
                        </div>
                        <p style={{ color:'#aaa', fontSize:'11px', margin:'0 0 2px' }}>{log.user_email}</p>
                        {vals && <p style={{ color:'#888', fontSize:'11px', margin:'0', fontFamily:'Courier New', wordBreak:'break-all' }}>{vals}</p>}
                      </div>
                    )
                  })}
                </div>
              )
            })()}
          </div>
        )}

        {/* ── ANALYTICS ── */}
        {activeTab === 'analytics' && (
          <div>
            {/* Date range filter */}
            <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'16px' }}>
              {[{k:'30d',l:'30d'},{k:'3mo',l:'3 mo'},{k:'6mo',l:'6 mo'},{k:'1yr',l:'1 yr'}].map(r => (
                <button key={r.k} onClick={() => setAnalyticsRange(r.k)}
                  style={{ flex:1, padding:'8px', border:'none', borderRadius:'6px', cursor:'pointer', fontWeight:'bold', fontSize:'12px', fontFamily:'Arial', background:analyticsRange === r.k ? '#C9A227' : 'transparent', color:analyticsRange === r.k ? '#0f1117' : '#888' }}>
                  {r.l}
                </button>
              ))}
            </div>

            {!analyticsLoaded ? (
              <p style={{ color:'#555', textAlign:'center', padding:'40px' }}>Loading analytics...</p>
            ) : !caAnalytics ? (
              <p style={{ color:'#555', textAlign:'center', padding:'40px' }}>No data available.</p>
            ) : (
              <>
                {/* Metric cards */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px', marginBottom:'14px' }}>
                  {[
                    { label:'Total Violations', val:caAnalytics.totalViolations, sub:'in period', subColor:'#555' },
                    { label:'Avg Tow Rate', val:`${caAnalytics.avgTowRate}%`, sub:'towed per violation', subColor:'#555', valColor: caAnalytics.avgTowRate > 30 ? '#E24B4A' : '#C9A227' },
                    { label:'Visitor Passes', val:caAnalytics.passCount, sub:'issued in period', subColor:'#555' },
                    { label:'Pending Disputes', val:caAnalytics.pendingDisputes, sub:'awaiting review', subColor:'#555', valColor: caAnalytics.pendingDisputes > 0 ? '#E24B4A' : '#1D9E75' },
                  ].map((c, i) => (
                    <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px' }}>
                      <p style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 4px' }}>{c.label}</p>
                      <p style={{ color:(c as any).valColor || 'white', fontSize:'26px', fontWeight:'bold', margin:'0', fontFamily:'Arial' }}>{c.val}</p>
                      <p style={{ color:c.subColor, fontSize:'11px', margin:'4px 0 0' }}>{c.sub}</p>
                    </div>
                  ))}
                </div>

                {/* Violations by property */}
                {caAnalytics.propertyChartData.length > 0 && (
                  <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 12px' }}>Violations by Property</p>
                    <ResponsiveContainer width="100%" height={Math.max(120, caAnalytics.propertyChartData.length * 44)}>
                      <BarChart data={caAnalytics.propertyChartData} layout="vertical" margin={{ top:0, right:8, left:0, bottom:0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" horizontal={false} />
                        <XAxis type="number" tick={{ fill:'#888', fontSize:10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                        <YAxis type="category" dataKey="name" tick={{ fill:'#aaa', fontSize:10 }} axisLine={false} tickLine={false} width={100} />
                        <Tooltip contentStyle={{ background:'#1e2535', border:'1px solid #2a2f3d', borderRadius:'8px', fontSize:'11px' }} labelStyle={{ color:'#aaa' }} />
                        <Bar dataKey="violations" name="Violations" fill="#C9A227" radius={[0,4,4,0]} />
                        <Bar dataKey="tows" name="Tows" fill="#B71C1C" radius={[0,4,4,0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Violations + passes trend */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                  <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 6px' }}>Violations &amp; Visitor Passes Trend</p>
                  <div style={{ display:'flex', gap:'16px', marginBottom:'10px' }}>
                    <span style={{ color:'#C9A227', fontSize:'10px' }}>— Violations</span>
                    <span style={{ color:'#1565C0', fontSize:'10px' }}>- - Visitor Passes</span>
                  </div>
                  <ResponsiveContainer width="100%" height={170}>
                    <LineChart data={caAnalytics.trendData} margin={{ top:4, right:4, left:-20, bottom:0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="month" tick={{ fill:'#888', fontSize:10 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill:'#888', fontSize:10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={{ background:'#1e2535', border:'1px solid #2a2f3d', borderRadius:'8px', fontSize:'11px' }} labelStyle={{ color:'#aaa' }} />
                      <Line type="monotone" dataKey="violations" stroke="#C9A227" strokeWidth={2} dot={{ fill:'#C9A227', strokeWidth:0, r:3 }} activeDot={{ r:5 }} name="Violations" />
                      <Line type="monotone" dataKey="passes" stroke="#1565C0" strokeWidth={2} strokeDasharray="5 3" dot={{ fill:'#1565C0', strokeWidth:0, r:3 }} activeDot={{ r:5 }} name="Visitor Passes" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Top violation types */}
                {caAnalytics.typeChartData.length > 0 && (
                  <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 12px' }}>Top Violation Types</p>
                    <ResponsiveContainer width="100%" height={Math.max(100, caAnalytics.typeChartData.length * 40)}>
                      <BarChart data={caAnalytics.typeChartData} layout="vertical" margin={{ top:0, right:8, left:0, bottom:0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" horizontal={false} />
                        <XAxis type="number" tick={{ fill:'#888', fontSize:10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                        <YAxis type="category" dataKey="name" tick={{ fill:'#aaa', fontSize:10 }} axisLine={false} tickLine={false} width={130} />
                        <Tooltip contentStyle={{ background:'#1e2535', border:'1px solid #2a2f3d', borderRadius:'8px', fontSize:'11px' }} labelStyle={{ color:'#aaa' }} itemStyle={{ color:'#C9A227' }} />
                        <Bar dataKey="count" name="Count" fill="#C9A227" radius={[0,4,4,0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Insights panel */}
                <div style={{ background:'#1a1f2e', border:'1px solid rgba(201,162,39,0.2)', borderRadius:'10px', padding:'14px' }}>
                  <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 10px' }}>Actionable Insights</p>
                  {caAnalytics.insights.map((insight: string, i: number) => (
                    <p key={i} style={{ color:'#aaa', fontSize:'13px', margin:'0 0 8px', lineHeight:'1.6', paddingBottom: i < caAnalytics.insights.length - 1 ? '8px' : '0', borderBottom: i < caAnalytics.insights.length - 1 ? '1px solid #2a2f3d' : 'none' }}>{insight}</p>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── PLAN (Phase 2a) ── */}
        {activeTab === 'plan' && (() => {
          // B140 Item 2 — empty-localStorage detection. getCompanyContext()
          // returns a 'legacy'/'enforcement' fallback when localStorage
          // keys are missing (deliberate — refactoring that fallback is
          // [[project-b77-tier-fallback-source-of-truth-refactor]] scope).
          // Without this check, the Plan tab would surface a misleading
          // "Current Plan: Legacy" for any customer whose bootstrap
          // hasn't fired. After B140 Item 1, this should only trigger
          // in genuine edge cases (browser localStorage cleared, race
          // condition, etc.) — the CTA gives the user a one-click
          // recovery path via /login re-bootstrap.
          const hasBootstrappedTier = typeof window !== 'undefined' && !!localStorage.getItem('company_tier')
          if (!hasBootstrappedTier) {
            return (
              <div>
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'24px', textAlign:'center' }}>
                  <p style={{ color:'#aaa', fontSize:'13px', margin:'0 0 14px' }}>Loading your plan info…</p>
                  <button onClick={() => { window.location.href = '/login' }}
                    style={{ padding:'10px 18px', background:'transparent', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'8px', fontSize:'12px', fontWeight:'bold' as const, cursor:'pointer' }}>
                    Refresh account info
                  </button>
                </div>
              </div>
            )
          }

          const ctx = getCompanyContext()
          // B140 Item 3 — use canonical TIER_DISPLAY_NAME mapping from
          // tier-config (closes the drift surface where the prior inline
          // map missed B89 Part 1's 'premium' tier addition).
          const tierTypeKey = ((ctx.tier_type as string) || 'enforcement') as TierType
          const tierLabel = TIER_DISPLAY_NAME[tierTypeKey]?.[String(ctx.tier)] || String(ctx.tier)
          const isEnf = ctx.tier_type === 'enforcement'
          const isPM = ctx.tier_type === 'property_management'

          const propLimit = getLimit(FEATURE_FLAGS.MAX_PROPERTIES, ctx)
          const propCount = properties.filter(p => p.is_active).length
          const drvLimit = getLimit(FEATURE_FLAGS.MAX_DRIVERS, ctx)
          const drvCount = companyDrivers.filter(d => d.is_active).length

          const fmtLimit = (n: number) => n < 0 ? 'unlimited' : String(n)
          const pct = (count: number, limit: number) => limit <= 0 ? 0 : Math.min(100, Math.round((count / limit) * 100))
          const barColor = (count: number, limit: number) => {
            if (limit < 0) return '#4caf50'
            const p = pct(count, limit)
            if (p >= 100) return '#f44336'
            if (p >= 80) return '#f59e0b'
            return '#4caf50'
          }

          const propUpgrade = getUpgradePrompt(FEATURE_FLAGS.MAX_PROPERTIES, ctx.tier, ctx.tier_type)
          const drvUpgrade = getUpgradePrompt(FEATURE_FLAGS.MAX_DRIVERS, ctx.tier, ctx.tier_type)

          // B57+B58: rows display only features that exist today. AI chatbot text/avatar,
          // live chat, white-glove onboarding, and driver performance reports were removed
          // because they aren't built. When real replacement features ship (AI-powered
          // docs search, video tutorial library, etc.), add their rows at that time —
          // never as forward-looking placeholders.
          const FEATURE_SUMMARY: { flag: string; label: string; tracks: string }[] = [
            { flag: FEATURE_FLAGS.LEASING_AGENT_ROLE, label: 'Leasing Agent role', tracks: 'both' },
            { flag: FEATURE_FLAGS.ADVANCED_ANALYTICS, label: 'Advanced Analytics tab', tracks: 'both' },
            { flag: FEATURE_FLAGS.TOWBOOK_CSV_EXPORT, label: 'Tow records CSV export', tracks: 'enf' },
            { flag: FEATURE_FLAGS.API_ACCESS_READ_ONLY, label: 'Read-only API access', tracks: 'enf' },
            { flag: FEATURE_FLAGS.PRIORITY_SUPPORT, label: 'Priority support', tracks: 'both' },
          ]
          const visibleFeatures = FEATURE_SUMMARY.filter(row =>
            row.tracks === 'both' || (row.tracks === 'enf' && isEnf) || (row.tracks === 'pm' && isPM)
          )

          const videoMaxSec = Number(getLimit(FEATURE_FLAGS.VIDEO_MAX_DURATION_SECONDS, ctx))
          const photoCap = Number(getLimit(FEATURE_FLAGS.MAX_PHOTOS_PER_VIOLATION, ctx))
          // B149: passMonthly + passDuration deliberately NOT read — the
          // tier-level visitor-pass limits they reference were display-
          // only (never enforced at pass-create sites). Plan tab no
          // longer advertises them.
          const hasOverride = ctx.proposal_code?.feature_overrides
            && Object.keys(ctx.proposal_code.feature_overrides).length > 0

          return (
            <div>
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'14px' }}>
                <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 4px' }}>Current Plan</p>
                <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'22px', margin:0 }}>{tierLabel}</p>
                <p style={{ color:'#aaa', fontSize:'12px', margin:'4px 0 0' }}>
                  {ctx.tier_type === 'property_management' ? 'Property Management track' : 'Enforcement track'}
                </p>
                {hasOverride && (
                  <p style={{ color:'#f59e0b', fontSize:'11px', margin:'8px 0 0' }}>
                    ⚙ Custom proposal-code overrides active. Some limits/features below reflect those overrides.
                  </p>
                )}
              </div>

              {/* Properties */}
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'10px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'8px' }}>
                  <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:0 }}>Properties</p>
                  <p style={{ color:'#aaa', fontSize:'12px', margin:0 }}>{propCount} of {fmtLimit(propLimit)}</p>
                </div>
                <div style={{ height:'6px', background:'#0f1117', borderRadius:'3px', overflow:'hidden' }}>
                  <div style={{ height:'100%', width: `${pct(propCount, propLimit)}%`, background: barColor(propCount, propLimit), transition:'width 0.3s' }} />
                </div>
                {propUpgrade && propLimit > 0 && propCount >= propLimit && (
                  <p style={{ color:'#f59e0b', fontSize:'11px', margin:'8px 0 0' }}>{propUpgrade.message}</p>
                )}
              </div>

              {/* Drivers — enforcement track only */}
              {isEnf && (
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'10px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'8px' }}>
                    <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:0 }}>Drivers</p>
                    <p style={{ color:'#aaa', fontSize:'12px', margin:0 }}>{drvCount} of {fmtLimit(drvLimit)}</p>
                  </div>
                  <div style={{ height:'6px', background:'#0f1117', borderRadius:'3px', overflow:'hidden' }}>
                    <div style={{ height:'100%', width: `${pct(drvCount, drvLimit)}%`, background: barColor(drvCount, drvLimit), transition:'width 0.3s' }} />
                  </div>
                  {planLoading && (
                    <p style={{ color:'#555', fontSize:'10px', margin:'6px 0 0', fontStyle:'italic' }}>Loading…</p>
                  )}
                  {drvUpgrade && drvLimit > 0 && drvCount >= drvLimit && (
                    <p style={{ color:'#f59e0b', fontSize:'11px', margin:'8px 0 0' }}>{drvUpgrade.message}</p>
                  )}
                </div>
              )}

              {/* Visitor pass usage per property — PM track only.
                  B149 honest-DOWN: the tier-level MAX_VISITOR_PASSES_PER_
                  PROPERTY_MONTH + MAX_VISITOR_PASS_DURATION_HOURS limits
                  shown here historically (Cap: X/mo · Max Yh/pass + %
                  progress bars) were DISPLAY-ONLY — never enforced at any
                  pass-create site. Removed to stop advertising a cap we
                  don't enforce. Per-property usage count is real and
                  preserved (sourced from visitorPassesThisMonth). Actual
                  enforcement happens via properties.visitor_pass_limit
                  (per-property per-plate annual cap, manager-set, gated
                  by enforce_visitor_pass_limit trigger) — different
                  concept, not advertised here. */}
              {isPM && (
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'10px' }}>
                  <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:'0 0 8px' }}>Visitor Passes</p>
                  {/* Calendar-month usage per property; resets 00:00 on the 1st */}
                  {properties.length === 0 ? (
                    <p style={{ color:'#555', fontSize:'11px', margin:'8px 0 0', fontStyle:'italic' }}>No properties to report on.</p>
                  ) : (
                    <div style={{ marginTop:'4px' }}>
                      {properties.map(prop => {
                        const used = visitorPassesThisMonth[prop.name] ?? 0
                        return (
                          <div key={prop.id || prop.name} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'6px' }}>
                            <span style={{ color:'#aaa', fontSize:'11px' }}>{prop.name}</span>
                            <span style={{ color:'#aaa', fontSize:'11px' }}>{used} this month</span>
                          </div>
                        )
                      })}
                      {planLoading && (
                        <p style={{ color:'#555', fontSize:'10px', margin:'4px 0 0', fontStyle:'italic' }}>Refreshing…</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Video duration (enforcement) */}
              {isEnf && (
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'10px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:0 }}>Video upload cap</p>
                    <p style={{ color:'#aaa', fontSize:'12px', margin:0 }}>{videoMaxSec > 0 ? `${videoMaxSec}s max` : 'disabled'}</p>
                  </div>
                </div>
              )}

              {/* B42: Photos per violation (enforcement) */}
              {isEnf && (
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'10px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:0 }}>Photos per violation</p>
                    <p style={{ color:'#aaa', fontSize:'12px', margin:0 }}>{photoCap < 0 ? 'unlimited' : `${photoCap} max`}</p>
                  </div>
                </div>
              )}

              {/* Feature flag summary */}
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px' }}>
                <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:'0 0 10px' }}>Included Features</p>
                {visibleFeatures.map(row => {
                  const on = hasFeature(row.flag as any, ctx) === true
                  return (
                    <div key={row.flag} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'6px 0', borderBottom:'1px solid #1e2535' }}>
                      <span style={{ color:'#aaa', fontSize:'12px' }}>{row.label}</span>
                      <span style={{ color: on ? '#4caf50' : '#555', fontSize:'12px', fontWeight: on ? 'bold' : 'normal' }}>
                        {on ? '✓ included' : '✗ upgrade required'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}

        {/* ── BILLING (B66.4) ── */}
        {activeTab === 'billing' && (
          <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: 12, padding: 24, marginTop: 16 }}>
            <h2 style={{ color: '#C9A227', fontSize: 18, fontWeight: 700, margin: '0 0 16px' }}>Billing</h2>

            {billingLoading && (
              <p style={{ color: '#888', fontSize: 13, margin: 0 }}>Loading…</p>
            )}

            {!billingLoading && billingData && !billingData.stripe_customer_id && (
              <div style={{ background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8, padding: 16 }}>
                <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 6px', lineHeight: 1.6 }}>
                  Your account is on a custom billing arrangement (no Stripe subscription).
                </p>
                <p style={{ color: '#64748b', fontSize: 12, margin: 0 }}>
                  Contact <a href="mailto:support@shieldmylot.com" style={{ color: '#C9A227', textDecoration: 'none' }}>support@shieldmylot.com</a> to update billing details.
                </p>
              </div>
            )}

            {!billingLoading && billingData && billingData.stripe_customer_id && (
              <>
                {/* Subscription summary */}
                <div style={{ background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8, padding: 16, marginBottom: 16 }}>
                  <p style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px', fontWeight: 700 }}>Subscription</p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 16, rowGap: 8, fontSize: 13 }}>
                    <span style={{ color: '#64748b' }}>Status:</span>
                    <span style={{ color: '#e2e8f0' }}>
                      {billingData.subscription_status
                        ? billingData.subscription_status.charAt(0).toUpperCase() + billingData.subscription_status.slice(1).replace('_', ' ')
                        : <span style={{ color: '#64748b' }}>(pending first sync)</span>}
                    </span>
                    <span style={{ color: '#64748b' }}>Next billing:</span>
                    <span style={{ color: '#e2e8f0' }}>
                      {billingData.current_period_end
                        ? new Date(billingData.current_period_end).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
                        : <span style={{ color: '#64748b' }}>—</span>}
                    </span>
                    <span style={{ color: '#64748b' }}>Cancel scheduled:</span>
                    <span style={{ color: billingData.cancel_at_period_end ? '#fbbf24' : '#e2e8f0' }}>
                      {billingData.cancel_at_period_end ? 'Yes — ends on next billing date' : 'No'}
                    </span>
                  </div>
                </div>

                {/* Manage Billing button */}
                <button onClick={openBillingPortal} disabled={portalLoading}
                  style={{
                    width: '100%', padding: '14px', fontWeight: 700, fontSize: 14,
                    background: portalLoading ? '#3a4055' : '#C9A227',
                    color: portalLoading ? '#888' : '#0f1117',
                    border: 'none', borderRadius: 10,
                    cursor: portalLoading ? 'not-allowed' : 'pointer',
                  }}>
                  {portalLoading ? 'Opening Stripe portal…' : 'Manage Billing'}
                </button>
                <p style={{ color: '#64748b', fontSize: 12, margin: '10px 0 0', lineHeight: 1.6 }}>
                  Update payment methods, view invoices, update billing address, cancel subscription. You&apos;ll be redirected to Stripe&apos;s secure portal and returned here when done.
                </p>
                {portalError && (
                  <div style={{ background: '#3a1a1a', border: '1px solid #b71c1c', borderRadius: 8, padding: '10px 14px', marginTop: 12 }}>
                    <p style={{ color: '#f44336', fontSize: 12, margin: 0 }}>{portalError}</p>
                  </div>
                )}

                {/* Billing address (read-only; edits via Portal) */}
                <div style={{ background: '#1e2535', border: '1px solid #3a4055', borderRadius: 8, padding: 16, marginTop: 16 }}>
                  <p style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px', fontWeight: 700 }}>Billing Address</p>
                  {(billingData.address || billingData.billing_city || billingData.billing_state) ? (
                    <div style={{ color: '#e2e8f0', fontSize: 13, lineHeight: 1.6 }}>
                      {billingData.address && <div>{billingData.address}</div>}
                      <div>
                        {[billingData.billing_city, billingData.billing_state, billingData.billing_postal_code].filter(Boolean).join(', ')}
                      </div>
                      {billingData.billing_country && <div>{billingData.billing_country}</div>}
                    </div>
                  ) : (
                    <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>
                      No billing address on file. Add one via Manage Billing.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        </>)}

        <div style={{ marginTop: 24 }}>
          <SupportContact role="company_admin" />
        </div>

        <div style={{ textAlign:'center', marginTop:'12px', paddingBottom:'20px' }}>
          <p style={{ color:'#2a2f3d', fontSize:'11px', margin:'0' }}>Powered by Alvarado Legacy Consulting LLC d/b/a ShieldMyLot™</p>
        </div>

      </div>

      {/* ── CAMERA MODAL ── */}
      {showCamera && (
        <div style={{ position:'fixed', inset:0, background:'#000', zIndex:9999, display:'flex', flexDirection:'column' }}>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

          <div style={{ position:'relative', flex:1, overflow:'hidden' }}>
            <video ref={videoRef} autoPlay playsInline muted
              style={{ width:'100%', height:'100%', objectFit:'cover' }} />

            <div style={{
              position:'absolute', top:'50%', left:'50%',
              transform:'translate(-50%, -50%)',
              width:'82%', maxWidth:'340px', height:'90px',
              border:'2px solid #C9A227', borderRadius:'8px',
              boxShadow:'0 0 0 9999px rgba(0,0,0,0.52)',
            }}>
              {[{top:'-2px',left:'-2px'},{top:'-2px',right:'-2px'},{bottom:'-2px',left:'-2px'},{bottom:'-2px',right:'-2px'}].map((pos,i) => (
                <div key={i} style={{ position:'absolute', width:'14px', height:'14px', border:'3px solid #C9A227', ...pos,
                  borderTop: pos.bottom !== undefined ? 'none' : '3px solid #C9A227',
                  borderBottom: pos.top !== undefined ? 'none' : '3px solid #C9A227',
                  borderLeft: pos.right !== undefined ? 'none' : '3px solid #C9A227',
                  borderRight: pos.left !== undefined ? 'none' : '3px solid #C9A227',
                }} />
              ))}
            </div>
          </div>

          <div style={{ padding:'20px 20px 32px', background:'#0f1117' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'10px', marginBottom:'6px', minHeight:'28px' }}>
              {scanning && (
                <div style={{ width:'18px', height:'18px', border:'2px solid #2a2f3d', borderTop:'2px solid #C9A227', borderRadius:'50%', animation:'spin 0.8s linear infinite', flexShrink:0 }} />
              )}
              <p style={{ color: scanning ? '#C9A227' : '#aaa', fontSize:'13px', margin:0, fontWeight: scanning ? 'bold' : 'normal' }}>
                {scanStatus}
              </p>
            </div>
            {!scanning && (
              <p style={{ color:'#444', fontSize:'11px', textAlign:'center', margin:'0 0 16px', lineHeight:'1.6' }}>
                For best results: good lighting, hold steady, plate fills the targeting box
              </p>
            )}
            {scanning && <div style={{ height:'28px' }} />}
            <div style={{ display:'flex', gap:'10px' }}>
              <button onClick={closeCamera} disabled={scanning}
                style={{ flex:1, padding:'14px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'10px', cursor: scanning ? 'not-allowed' : 'pointer', fontSize:'14px', fontFamily:'Arial' }}>
                Cancel
              </button>
              <button onClick={captureAndScan} disabled={scanning}
                style={{ flex:2, padding:'14px', background: scanning ? '#555' : '#C9A227', color: scanning ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'10px', cursor: scanning ? 'not-allowed' : 'pointer', fontFamily:'Arial' }}>
                {scanning ? 'Reading...' : '📷 Capture'}
              </button>
            </div>
          </div>
        </div>
      )}
      {credentials && (
        <CredentialsModal email={credentials.email} password={credentials.password} onClose={() => setCredentials(null)} />
      )}
      <PostConfirmationEditModal
        open={editMediaViolationId != null}
        violationId={editMediaViolationId}
        userRole="company_admin"
        userEmail={role?.email || user?.email || ''}
        onClose={() => {
          setEditMediaViolationId(null)
          // Refresh the violations list so a card whose only photo was just
          // removed re-renders with the updated v.photos / v.video_url state.
          if (selectedProperty) fetchViolations(selectedProperty.name)
        }}
      />

      {/* B71: decline-and-proceed interstitial — symmetric to driver portal. */}
      {declineModal && (
        <DeclineReasonModal
          plate={plate}
          authorizedAs={declineModal.authorizedAs}
          authorizedDetail={declineModal.detail}
          onCancel={() => setDeclineModal(null)}
          onConfirm={(reason, note) => {
            setPendingDecline({ reason, note })
            setDeclineModal(null)
            setViolation(v => ({ ...v, property: selectedProperty?.name || '' }))
            setShowViolation(true)
          }}
        />
      )}

      {/* B165 — forced-upgrade modal. Opens at cap-hit moments (4 sites:
          saveProperty + togglePropertyActive + createDriver + toggleDriverActive).
          onSuccess retries the original add action that hit the cap. */}
      {tierUpgradeCtx && (
        <TierUpgradeModal
          ctx={tierUpgradeCtx}
          onClose={() => {
            setTierUpgradeCtx(null)
            setPendingTierUpgradeRetry(null)
          }}
          onSuccess={() => {
            const retry = pendingTierUpgradeRetry
            setTierUpgradeCtx(null)
            setPendingTierUpgradeRetry(null)
            if (retry) retry()
          }}
        />
      )}
    </main>
  )
}

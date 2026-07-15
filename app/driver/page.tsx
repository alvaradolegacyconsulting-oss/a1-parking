'use client'
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../supabase'
import { logAudit } from '../lib/audit'
import SupportContact from '../components/SupportContact'
import { normalizePlate } from '../lib/plate'
import { TOW_REASONS, RESTRICTED_ON_OVERRIDE, displayTowReason, type TowReasonCode } from '../lib/tow-reasons'
import { uploadVideoResumable } from '../lib/video-upload'
import { useResolvedLogo, getCachedLogoUrl, getPlatformLogoUrl } from '../lib/logo'
import ViolationReviewScreen, { ReviewViolation } from '../components/ViolationReviewScreen'
import RegenerateTicketModal, { type RegenerateSuccessPayload } from '../components/RegenerateTicketModal'
import { getCompanyContext, getLimit } from '../lib/tier'
import { FEATURE_FLAGS } from '../lib/feature-flags'
// B71: decline-and-proceed interstitial for authorized-plate overrides.
import DeclineReasonModal, { DeclineReason, DECLINE_REASON_LABELS } from '../components/DeclineReasonModal'
// B66.5 commit 4.3: account-state gate (past_due banner + suspended/cancelled redirects).
import { evaluatePortalGate } from '../lib/portal-account-gate'
import PastDueBanner, { type PastDueBannerProps } from '../components/PastDueBanner'

export default function DriverPortal() {
  const [driver, setDriver] = useState<any>(null)
  // B120: tow company's TDLR # (fetched alongside driver; rendered conditionally
  // under TOW OPERATOR section on the live tow ticket). Stays null when the
  // company hasn't entered one yet — render code hides the row entirely.
  const [companyTdlr, setCompanyTdlr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // B66.5 commit 4.3: past_due banner state (null = no banner; populated = render).
  const [pastDueBanner, setPastDueBanner] = useState<PastDueBannerProps | null>(null)

  // Plate lookup
  const [plate, setPlate] = useState('')
  const [result, setResult] = useState<any>(null)
  const [searching, setSearching] = useState(false)
  const [selectedProperty, setSelectedProperty] = useState('')

  // Camera scan
  const [showCamera, setShowCamera] = useState(false)
  const [scanStatus, setScanStatus] = useState('Point camera at license plate')
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const [searchTimestamp, setSearchTimestamp] = useState<Date | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [showViolation, setShowViolation] = useState(false)
  // B18 Commit B: review-before-confirm. stage='form' while user fills
  // out the violation; flips to 'review' after upload + INSERT lands;
  // back to 'form' on Edit; back to closed on Confirm.
  const [violationStage, setViolationStage] = useState<'form' | 'review'>('form')
  const [reviewViolation, setReviewViolation] = useState<ReviewViolation | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  // Resume banner — unconfirmed violations by this driver within 24h
  const [unconfirmedDrafts, setUnconfirmedDrafts] = useState<ReviewViolation[]>([])
  const [violation, setViolation] = useState({ type: '', location: '', notes: '', property: '', vehicle_color: '', vehicle_make: '', vehicle_model: '', vehicle_year: '' })
  // B71: when the user clicks Issue Violation against an AUTHORIZED plate,
  // a modal collects a structured reason before the form opens. The chosen
  // reason + note are then locked in for the submission (persisted to
  // violations.decline_reason / decline_reason_note + was_authorized_at_time).
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

  // Tow ticket (shared)
  const [storageFacilities, setStorageFacilities] = useState<any[]>([])
  const [ticketTarget, setTicketTarget] = useState<any>(null)
  const [selectedStorage, setSelectedStorage] = useState('')
  const [towFee, setTowFee] = useState('')
  const [mileage, setMileage] = useState('')
  const [vin, setVin] = useState('')

  // Violations tab
  const [activeTab, setActiveTab] = useState<'lookup' | 'violations'>('lookup')
  const [violations, setViolations] = useState<any[]>([])
  const [violationFilter, setViolationFilter] = useState('today')
  const [searchQuery, setSearchQuery] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [expandedTicketId, setExpandedTicketId] = useState<string | null>(null)
  // Tow Ticket Regenerate Layer 2 — the live violation row being
  // regenerated (null = modal closed). Permission-gated visibility
  // of the entry-point button is enforced via the 3-flag conditional
  // (driver.can_regenerate_tow_ticket + tow_ticket_generated +
  // voided_at IS NULL) at the render site; the server-side gate in
  // regenerate_tow_ticket RPC is the real authority.
  const [regenerateTarget, setRegenerateTarget] = useState<any>(null)

  const resolvedLogo = useResolvedLogo(typeof window !== 'undefined' ? localStorage.getItem('company_logo') : null)

  useEffect(() => { loadDriver(); getPlatformLogoUrl() }, [])

  useEffect(() => {
    if (showCamera && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
      videoRef.current.play().catch(() => {})
    }
  }, [showCamera])

  async function loadDriver() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { window.location.href = '/login'; return }

    const { data: roleData } = await supabase
      .from('user_roles').select('*').ilike('email', user.email!).single()

    if (!roleData || (roleData.role !== 'driver' && roleData.role !== 'admin')) {
      setError('You do not have driver access.')
      setLoading(false)
      return
    }

    const { data: driverData } = await supabase
      .from('drivers').select('*').ilike('email', user.email!).single()

    // Driver-company-source fix (2026-06-10): the canonical company for
    // the driver session is user_roles.company — the same source RLS
    // uses via get_my_company(). drivers.company can drift (different
    // casing, trailing space, "Demo Towing" vs "Demo Towing LLC", etc.)
    // and the drivers row can be missing entirely. The prior fallback
    // hardcoded 'A1 Wrecker, LLC' which silently mis-attributed every
    // non-A1 driver: the storage-facility dropdown filter, the account-
    // state portal gate, AND the TDLR lookup all evaluated against A1
    // instead of the actual company. RLS still gated correctly (uses
    // user_roles.company), so the symptom was an empty dropdown + wrong
    // gate result rather than a leak. Single-source from roleData.
    // company so all three consumers stay aligned with RLS. Closes the
    // B27 "fragile name-string matcher" memory's predicted recurrence —
    // "revisit when A1 hires a 7th driver or onboards next customer."
    const d = {
      ...(driverData ?? {
        name: user.email, email: user.email,
        assigned_properties: ['All'], operator_license: 'N/A',
      }),
      company: roleData.company || '',
      // Tow Ticket Regenerate Layer 2 — surface the per-driver
      // can_regenerate_tow_ticket flag from user_roles onto the
      // driver state object. The driver object is primarily sourced
      // from the `drivers` table (which doesn't carry this column);
      // cherry-pick from roleData the same way `company` is. Without
      // this, the row-action gate at the violations-list render
      // (`driver?.can_regenerate_tow_ticket && ...`) always evaluates
      // false and the Regenerate button never appears — even when the
      // DB has the flag granted. Layer 2 added the gate + Layer 3
      // added the grant RPC but neither wired this through; this fix
      // closes the loop.
      //
      // `=== true` coercion guards against null/undefined from
      // pre-Layer-1 user_roles rows that might not have the column
      // populated (Layer 1's DEFAULT FALSE backfill should have
      // covered all rows, but the explicit boolean cast is defensive).
      can_regenerate_tow_ticket: roleData.can_regenerate_tow_ticket === true,
    }

    // B66.5 commit 4.3 + B66.5.1: account-state gate with userRole threaded
    // for role-aware CTA rendering in PastDueBanner. Driver role → banner
    // shows informational copy + CA mailto (not Update Payment button).
    const gateResult = await evaluatePortalGate(d.company, 'driver')
    if (gateResult.redirected) return
    if (gateResult.pastDueBanner) setPastDueBanner(gateResult.pastDueBanner)

    setDriver(d)
    // B120: fetch the driver's company TDLR # for the tow-ticket render.
    // Driver carries `company` as a string name; companies.name match
    // (case-insensitive) yields tdlr_license_number when populated.
    if (d.company) {
      const { data: companyRow } = await supabase
        .from('companies')
        .select('tdlr_license_number')
        .ilike('name', d.company)
        .maybeSingle()
      setCompanyTdlr(companyRow?.tdlr_license_number ?? null)
    }
    const assignableProps = (d.assigned_properties || []).filter((p: string) => p !== 'All')
    if (assignableProps.length === 1) setSelectedProperty(assignableProps[0])
    setLoading(false)
    fetchViolations(d.assigned_properties || ['All'])
    fetchStorageFacilities()
    // B18 Commit B: surface unfinished drafts from prior tab-closes
    if (d.name) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      // B78 Path A: SELECT widened with vehicle_* so drafts-resume-then-confirm
      // path carries the at-scene fields into ReviewViolation → ticketTarget.
      const { data } = await supabase.from('violations')
        .select('id, plate, violation_type, property, location, notes, driver_name, created_at, vehicle_color, vehicle_make, vehicle_model, vehicle_year, photo_rows:violation_photos(id, photo_url, removed_at), video_rows:violation_videos(id, video_url, removed_at)')
        .eq('is_confirmed', false)
        .eq('driver_name', d.name)
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
  }

  async function fetchStorageFacilities() {
    // B177 (2026-06-11) — the prior B154-era client-side
    // `.ilike('company', driver?.company ?? '')` filter was REMOVED.
    // Why: instrumentation under driver1@demotowing.com's real session
    // proved that the RLS-only query returns the correct facilities
    // (RLS uses `driver_read_own_facilities`: company ~~* get_my_
    // company()), but the client .ilike read `driver?.company` via a
    // STALE REACT CLOSURE. fetchStorageFacilities is called inline at
    // the end of loadDriver, right after setDriver(d) — but setDriver
    // is async; the closure captured the initial render's driver
    // state (= null). So .ilike resolved to .ilike('company', '')
    // which matches nothing, even though Option C had correctly
    // populated d.company → "Demo Towing LLC".
    //
    // The fix (per Jose's Part 2): trust RLS. Per role:
    //   • driver → driver_read_own_facilities (own-company scope)
    //   • CA     → company_admin_own_facilities (own-company scope)
    //   • admin  → admin_all_facilities (super-admin all)
    // All three RLS policies were proven to scope correctly (B177
    // capture). The client-side defensive filter was redundant AND
    // the failure surface — removing it makes the dropdown immune to
    // any client-state population race or fragility.
    //
    // Closes the B27 "fragile name-string matcher" memory's class at
    // the read-site layer (Option C closed the SOURCE; this closes the
    // CONSUMER).
    const { data } = await supabase
      .from('storage_facilities')
      .select('*')
      .eq('is_active', true)
      .order('name')
    setStorageFacilities(data || [])
  }

  async function fetchViolations(properties: string[]) {
    // Fetch 6 months so all filter presets have data
    const sixmo = new Date()
    sixmo.setMonth(sixmo.getMonth() - 6)
    // B13/B18 Commit A: photos source from violation_photos via the
    // embedded FK relationship (alias `photo_rows` to avoid colliding
    // with the legacy violations.photos array column, which still
    // exists during the transition window). Filter removed photos
    // client-side and overwrite v.photos with the flat string[] shape
    // every existing reader expects.
    let query = supabase.from('violations').select('*, photo_rows:violation_photos(id, photo_url, removed_at), video_rows:violation_videos(id, video_url, removed_at)')
      .eq('is_confirmed', true)
      .gte('created_at', sixmo.toISOString())
      .order('created_at', { ascending: false })
    if (!properties.includes('All')) {
      query = query.in('property', properties)
    }
    const { data } = await query
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
      console.log('Calling scan-plate API...')
      const res = await fetch('/api/scan-plate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 }),
      })
      console.log('Response status:', res.status)
      const result = await res.json()
      console.log('Result:', result)
      const json = result
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
    if (!selectedProperty) { setScanStatus('Please select a property before searching'); return }
    const val = plateVal ?? plate
    if (!val || searching) return
    setSearchTimestamp(new Date())
    setSearching(true)
    setScanMsg('')
    setResult(null)
    setShowViolation(false)
    setPendingDecline(null)
    setTicketTarget(null)
    const clean = val.toUpperCase().replace(/\s/g, '').trim()

    // Spaces v1.1 Q4 fix + Q5 narrow:
    // - vehicles cascade .select() narrowed from '*' to explicit safe-column
    //   list (drops unit + owner_email from the network payload). Keeps
    //   resident_email as the RPC join key for the spaces lookup below.
    //   guest_authorizations + visitor_passes .select('*') stay un-narrowed
    //   for this commit — full closure is B225 Pattern B (recorded).
    // - vehicles.space + space_number lookup REMOVED (broken — vehicles.space
    //   not auto-populated by assign_space; space_number renamed to label
    //   in commit-1 backfill so the join misses every v1.1-generated space).
    // - Replaced with derive_space_allowed_plates DEFINER RPC: server-side
    //   role-pinned-to-driver; projects ONLY safe-public columns
    //   (space_label, space_description, plates[]); ZERO resident PII over
    //   the wire by construction; returns [] when resident holds no spaces.
    //
    // 🔒 INVARIANT: authorization derives from the VEHICLE. An authorized
    // vehicle whose resident holds ZERO spaces still returns 'authorized'
    // with the space field rendering as '—'. The RPC returning [] is a
    // valid reference-data absence, NOT a deauthorization signal.
    const SAFE_VEHICLE_COLS = 'plate, is_active, status, year, color, make, model, property, space, resident_email'

    // Slice 4 — appended `id, status` so we can enrich under-review with
    // the pending plate change when the vehicle exists but is mid-change.
    // Runtime concat defeats the tuple-typed inference; local `any` cast
    // is fine since SAFE_VEHICLE_COLS already includes every field we
    // read below.
    const activeVehRes: any = await supabase
      .from('vehicles').select(SAFE_VEHICLE_COLS + ', id, status').ilike('plate', clean).ilike('property', selectedProperty).eq('is_active', true).single()
    const activeVeh: any = activeVehRes.data
    if (activeVeh) {
      const { data: assignedSpacesRaw } = await supabase.rpc('derive_space_allowed_plates', {
        p_property:       selectedProperty,
        p_resident_email: activeVeh.resident_email,
      })
      // RPC returns JSONB array; supabase-js types it as `unknown`.
      // Empty/null both render as no space (dash) per invariant.
      const assignedSpaces = Array.isArray(assignedSpacesRaw) ? assignedSpacesRaw : []
      // Slice 4 — under-review enrichment. When the found vehicle has a
      // pending plate change, attach it so the render shows a "plate
      // change under review" banner alongside AUTHORIZED. The old plate
      // (which is what the driver scanned) stays enforce-valid — do NOT
      // downgrade to a warning; still show green AUTHORIZED, just add a
      // context banner explaining a change is in flight.
      let underReviewChange: any = null
      if (activeVeh.status === 'under_review') {
        const { data: pc } = await supabase
          .from('vehicle_plate_changes')
          .select('id, old_plate, new_plate, submitted_at')
          .eq('vehicle_id', activeVeh.id)
          .eq('status', 'pending')
          .maybeSingle()
        if (pc) underReviewChange = pc
      }
      setSearching(false); setResult({ status: 'authorized', data: { ...activeVeh, _assigned_spaces: assignedSpaces, _pending_plate_change: underReviewChange } }); return
    }

    // Slice 5 — deactivated vehicles are NOT authorized. Exclude them from
    // the expired-branch query so they fall through to notfound (returns
    // "NO PERMIT FOUND" — the standing determination for unauthorized).
    // A deactivated permit that still resolves as any authorized-family
    // status would be an enforcement hole (same class as the slice-4
    // collision guard).
    const { data: expiredVeh } = await supabase
      .from('vehicles').select(SAFE_VEHICLE_COLS).ilike('plate', clean).ilike('property', selectedProperty).eq('is_active', false).neq('status', 'deactivated').single()
    if (expiredVeh) {
      // Expired/pending/declined: same RPC call (the resident's space ties
      // are reference data regardless of vehicle is_active state — the
      // resident is still tied to whatever they're tied to, until the
      // residents_deactivate_free_spaces trigger fires). Returning the
      // space list here keeps the historical context visible to the driver
      // (helps them understand "this car USED to park in C-12").
      const { data: assignedSpacesRaw } = await supabase.rpc('derive_space_allowed_plates', {
        p_property:       selectedProperty,
        p_resident_email: expiredVeh.resident_email,
      })
      const assignedSpaces = Array.isArray(assignedSpacesRaw) ? assignedSpacesRaw : []
      // B84: distinguish pending/declined from legacy-deactivated. Previously
      // all is_active=false rows rendered as "permit expired" regardless of
      // vehicles.status — confusing for newly-registered residents.
      const resultStatus = expiredVeh.status === 'pending' ? 'pending'
        : expiredVeh.status === 'declined' ? 'declined'
        : 'expired'
      setSearching(false); setResult({ status: resultStatus, data: { ...expiredVeh, _assigned_spaces: assignedSpaces } }); return
    }

    // Slice 4 — Do-Not-Tow safety branch (SAFETY-CRITICAL):
    // Driver scanned a plate that ISN'T on any current vehicle row. Before
    // treating as visitor/guest/unauthorized, check whether this plate is
    // the NEW plate of a pending vehicle_plate_changes row. If so, the
    // resident has requested this plate on their vehicle and it's awaiting
    // PM decision — the driver must NOT tow. Show a bright do-not-tow
    // signal with old→new + submitted date.
    //
    // Property-scoped by RLS (driver_read_plate_changes admits driver at
    // own-company properties); additional client-side .ilike('property',
    // selectedProperty) filter narrows to the property the driver picked.
    const { data: pendingPc } = await supabase
      .from('vehicle_plate_changes')
      .select('id, vehicle_id, old_plate, new_plate, submitted_at, property')
      .ilike('new_plate', clean)
      .ilike('property', selectedProperty)
      .eq('status', 'pending')
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (pendingPc) {
      setSearching(false); setResult({ status: 'plate_under_review', data: pendingPc }); return
    }

    // B214 — guest_authorizations stage 2.5 of the enforcement cascade.
    // Inserts BETWEEN vehicles (stages 1+2) and visitor_passes (stage 3) so
    // a vetted guest's plate is recognized BEFORE the visitor-pass check
    // (which would otherwise return notfound for a plate the manager
    // explicitly authorized). Date predicate matches the table's primary
    // index (is_active+status+start_date+end_date) for an index-only scan.
    //
    // .order(end_date desc).limit(1).maybeSingle() handles the overlap case
    // (Finding 2): if two authorizations are simultaneously active for the
    // same plate+property, surface the longer-running one. No hard unique
    // constraint exists by design (overlap can be legit) — this just keeps
    // the cascade deterministic when the soft-overlap-warning at create
    // time (commit 3) isn't honored.
    //
    // B225 (2026-06-26) — driver-needs-only column narrows for the two
    // remaining .select('*') calls. Closes 2/3 of B225 (vehicles narrow
    // was 1/3, shipped a4b425b). Consumer-completeness verified pre-build:
    //   - guest_auth renders use start_date / end_date / non_resident_reason
    //     (L1305, L1315-1322); decline-modal payload (L1324) reads
    //     non_resident_reason; submitViolation + logAudit + pendingDecline
    //     read ZERO result.data fields.
    //   - visitor_pass render uses expires_at (L1385); zero other consumers.
    //   - plate kept in both sets — used as filter + implicit search context.
    // Removes PII the render block was already stripping but the network
    // payload was carrying: guest_name, resident_email, visiting_unit,
    // approved_by_email (guest_auth) + visitor_name/phone, visiting_unit,
    // vehicle_*, notes (visitor_passes).
    const SAFE_GUEST_AUTH_COLS   = 'plate, start_date, end_date, non_resident_reason'
    const SAFE_VISITOR_PASS_COLS = 'plate, expires_at'

    const todayIso = new Date().toISOString().split('T')[0]
    const { data: guestAuth } = await supabase
      .from('guest_authorizations').select(SAFE_GUEST_AUTH_COLS)
      .ilike('plate', clean).ilike('property', selectedProperty)
      .eq('is_active', true).eq('status', 'active')
      .lte('start_date', todayIso).gte('end_date', todayIso)
      .order('end_date', { ascending: false })
      .limit(1).maybeSingle()
    if (guestAuth) {
      setSearching(false); setResult({ status: 'guest_authorized', data: guestAuth }); return
    }

    const { data: pass } = await supabase.from('visitor_passes').select(SAFE_VISITOR_PASS_COLS)
      .ilike('plate', clean).ilike('property', selectedProperty)
      .eq('is_active', true).gte('expires_at', new Date().toISOString())
      .single()
    setSearching(false)
    if (pass) setResult({ status: 'visitor', data: pass })
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
      plate: normalizedPlate,
      violation_type: violation.type,
      location: violation.location,
      notes: violation.notes,
      property: violation.property,
      driver_name: driver?.name,
      driver_license: driver?.operator_license,
      video_url: videoUrl,
      vehicle_color: violation.vehicle_color || null,
      vehicle_make: violation.vehicle_make || null,
      vehicle_model: violation.vehicle_model || null,
      // B78: optional year capture. Empty string + NaN coalesce to null;
      // SMALLINT range guards anything plausible a driver could type.
      vehicle_year: violation.vehicle_year ? (parseInt(violation.vehicle_year) || null) : null,
      is_confirmed: false,
      // B71: authorized-plate override fields. pendingDecline is set
      // when the user came through the decline-reason interstitial; null
      // for the standard unauthorized path.
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
        // The violation row is created; photos can be re-added later by a manager.
        // Surface but don't block the review flow.
        alert('Some photos failed to attach: ' + phErr.message + '\nYou can still confirm; a manager can add photos later.')
      } else {
        insertedPhotoIds = (photoData || []).map(p => p.id)
      }
    }
    // C1: write the video to violation_videos in parallel with the
    // legacy violations.video_url (kept as safety net per locked
    // decision — dropped in follow-up after ~1 week clean prod).
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
    await logAudit({ action: 'ADD_VIOLATION', table_name: 'violations', record_id: newV?.id, new_values: { plate: normalizedPlate, property: violation.property, violation_type: violation.type, driver_name: driver?.name } })
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
      // B78 Path A — carry at-scene vehicle fields through ReviewViolation
      // so the post-confirm setTicketTarget(reviewViolation) path renders
      // them in the tow ticket. newV is the INSERT result so it already
      // has these fields populated (or null if the form left them blank).
      vehicle_color: newV.vehicle_color,
      vehicle_make: newV.vehicle_make,
      vehicle_model: newV.vehicle_model,
      vehicle_year: newV.vehicle_year,
    })
    setViolationStage('review')
  }

  // C1: after a soft-delete on the review screen, re-query the
  // violation with photo_rows + video_rows embedded and rebuild the
  // ReviewViolation. RLS already filters out rows the caller can't
  // see; the active-only filter on removed_at IS NULL is enforced
  // client-side here (consistent with how reader sites flatten).
  async function refetchReviewViolation() {
    if (!reviewViolation) return
    // B78 Path A: SELECT widened with vehicle_color/make/model/year so the
    // refreshed ReviewViolation carries the at-scene fields downstream.
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
    await logAudit({
      action: 'VIOLATION_CONFIRMED',
      table_name: 'violations',
      record_id: String(reviewViolation.id),
      new_values: { plate: reviewViolation.plate, property: reviewViolation.property },
    })
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
    fetchViolations(driver?.assigned_properties || ['All'])
    // Existing flow: open the tow-ticket modal after confirm.
    setTicketTarget(confirmed); setSelectedStorage(''); setTowFee(''); setMileage('')
  }

  async function editFromReview() {
    // Per Commit B scope: discard the unconfirmed row entirely so the
    // user submits cleanly on the next round. CASCADE drops photo rows.
    // Storage objects orphan until a Phase 2 cleanup cron. Form state is
    // preserved so they don't have to re-type everything.
    if (!reviewViolation) return
    setReviewBusy(true)
    await supabase.from('violations').delete().eq('id', reviewViolation.id)
    setReviewBusy(false)
    setReviewViolation(null)
    setViolationStage('form')
  }

  // Resume banner: drafts created by this driver within 24h that
  // haven't been confirmed. driver_name is the cheap, RLS-narrowed
  // match (RLS already scopes the SELECT to the driver's company).
  async function loadUnconfirmedDrafts() {
    if (!driver?.name) { setUnconfirmedDrafts([]); return }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data } = await supabase.from('violations')
      .select('id, plate, violation_type, property, location, notes, driver_name, created_at, photo_rows:violation_photos(id, photo_url, removed_at), video_rows:violation_videos(id, video_url, removed_at)')
      .eq('is_confirmed', false)
      .eq('driver_name', driver.name)
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
    let list = violations.filter(v => {
      const d = new Date(v.created_at)
      if (violationFilter === 'custom') {
        const from = dateFrom ? new Date(dateFrom) : new Date(0)
        const to = dateTo ? new Date(dateTo + 'T23:59:59') : new Date()
        return d >= from && d <= to
      }
      if (violationFilter === 'today') return d >= today
      if (violationFilter === 'week') return d >= week
      return d >= sixmo
    })
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      const qPlate = normalizePlate(searchQuery)
      list = list.filter(v =>
        (qPlate && normalizePlate(v.plate).includes(qPlate)) ||
        v.property?.toLowerCase().includes(q) ||
        displayTowReason(v.violation_type).toLowerCase().includes(q) ||
        v.driver_name?.toLowerCase().includes(q)
      )
    }
    return list
  }

  function openTicketFor(v: any) {
    setTicketTarget(v)
    setExpandedTicketId(v.id)
    // Form is the FRESH-stamp surface only. Stamped rows route through
    // renderTicketReadOnlyView() (which sources from ticketTarget, not
    // form state) — so the prior Fix #3 pre-fill (cherry-picking
    // facility + fee from the row onto form state) was made redundant
    // and reverted 2026-06-29. Form opens blank either way; the row
    // JSX branches on stamped vs fresh to decide which surface to show.
    setSelectedStorage('')
    setTowFee('')
    setMileage('')
  }

  // Tow Ticket Regenerate Layer 2 — success handler. Reflects the
  // RPC's atomic void+new+stamp result in local state:
  //   - Old row (the original we regenerated from) → marked voided
  //   - New row (the regenerated, server-stamped one) → inserted
  //     into the list + auto-opened so the driver can immediately
  //     Print / Share via the existing Generate Tow Ticket flow.
  //
  // generateTicket() patched below sources storage + tow fee from
  // the ROW when ticketTarget.tow_ticket_generated === true, so the
  // auto-opened ticket prints with the regenerate's facility + fee
  // (NOT the empty form state).
  function handleRegenerateSuccess(payload: RegenerateSuccessPayload) {
    const newRow = payload.violation as any
    setViolations((prev: any[]) => {
      const withOldVoided = prev.map(v =>
        v.id === payload.original_id ? { ...v, voided_at: new Date().toISOString(), void_reason: 'regenerate' } : v
      )
      // De-dupe defensively (if the new id somehow already exists; shouldn't)
      const filtered = withOldVoided.filter(v => v.id !== payload.new_violation_id)
      return [newRow, ...filtered]
    })
    setRegenerateTarget(null)
    // Auto-open the new ticket — driver flows straight to Generate Tow
    // Ticket / Share without an extra navigation step.
    setTicketTarget(newRow)
    setExpandedTicketId(String(newRow.id))
    // selectedStorage + towFee deliberately NOT set — the patched
    // generateTicket() reads from row fields when already-stamped.
    setSelectedStorage('')
    setTowFee('')
    setMileage('')
  }

  async function generateTicket() {
    if (!ticketTarget) return
    // Tow Ticket Regenerate Layer 2 — row-sourcing patch.
    //
    // When the row is ALREADY STAMPED (re-print, or post-regenerate
    // case where regenerate_tow_ticket already wrote tow_storage_* +
    // tow_fee server-side), source storage + fee from the ROW. Form
    // state (selectedStorage / towFee) is empty for these cases —
    // openTicketFor() clears them on every open — so reading form
    // state would produce a blank/$0.00 print.
    //
    // For fresh stamps (first-time generate on a not-yet-stamped row),
    // source from form state as before.
    //
    // VSF# isn't denormalized onto the violation row (only name/
    // address/phone are). Recover by name-matching back to the
    // storageFacilities client state when re-printing; if the lookup
    // misses, the print falls back to the row's 3 stamped fields
    // without VSF# — graceful degradation, no broken render.
    const isAlreadyStamped = ticketTarget.tow_ticket_generated === true
    const storageFromState = storageFacilities.find(s => String(s.id) === selectedStorage)
    const storageFromRow = isAlreadyStamped
      ? (storageFacilities.find(s => s.name === ticketTarget.tow_storage_name) ?? {
          name:                ticketTarget.tow_storage_name,
          address:             ticketTarget.tow_storage_address,
          phone:               ticketTarget.tow_storage_phone,
          email:               null,
          vsf_license_number:  null,
        })
      : null
    const storage = isAlreadyStamped ? storageFromRow : storageFromState

    // Tow fee source: row when stamped, form state otherwise.
    // Mileage was never persisted (B191 backlog) — stays form state
    // for fresh stamps; defaults to 0 for re-prints of already-stamped
    // rows (matches pre-existing behavior; not Layer 2's job to fix).
    const effectiveTowFee  = isAlreadyStamped ? Number(ticketTarget.tow_fee || 0)         : parseFloat(towFee || '0')
    // Mileage row-sources from ticketTarget on stamped re-print (parallel
    // to tow_fee; both fields now persisted via migration 20260629).
    // Pre-migration rows have tow_mileage_fee = NULL → effectiveMileage = 0
    // → no mileage line on re-print (read-only view also omits the row).
    const effectiveMileage = isAlreadyStamped ? Number(ticketTarget.tow_mileage_fee || 0)  : parseFloat(mileage || '0')
    // VIN row-sources from ticketTarget on stamped re-print; from form
    // state on fresh stamp. NULL/blank → omitted from print HTML.
    const effectiveVin     = isAlreadyStamped ? (ticketTarget.vehicle_vin || '')           : vin.trim()

    const tw = window.open('', '_blank')
    if (!tw) return
    const v = ticketTarget
    const total = (effectiveTowFee + effectiveMileage).toFixed(2)
    // Capability-URL ticket view (90-day expiry). Populate view_token
    // on the violation row; recipient clicks the URL → /ticket/view/
    // <token> → sees rich hosted view with photos. Token RPC is
    // independent of the storage info stamped below — the public view
    // re-reads the violation row at request time, so the order doesn't
    // matter. Failure is non-fatal: the popup just omits the Share /
    // Copy buttons and the mailto body's "View online" line.
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
      `TOW TICKET — ${driver?.company || 'A1 Wrecker, LLC'}`,
      `Date/Time: ${new Date(v.created_at).toLocaleString()}`,
      `Ticket #: ${String(v.id).substring(0, 8).toUpperCase()}`,
      ``,
      `VEHICLE`,
      `Plate: ${v.plate}`,
      // B78: pull driver-entered scene values (Family 2). Order matches the
      // HTML render: Year first, then Make/Model/Color. Graceful omission of
      // null fields via filter(Boolean) — same pattern as the HTML template.
      `Vehicle: ${[v.vehicle_year, v.vehicle_make, v.vehicle_model, v.vehicle_color].filter(Boolean).join(' ') || '—'}`,
      // Migration 20260629 — VIN row-sources from ticketTarget when stamped.
      // Conditional: omit the line entirely when blank/null (parallels the
      // HTML render). Mailto + print HTML stay in sync.
      ...(effectiveVin ? [`VIN: ${effectiveVin}`] : []),
      ``,
      `VIOLATION`,
      `Type: ${displayTowReason(v.violation_type)}`,
      `Location: ${v.location || '—'}`,
      `Property: ${v.property || '—'}`,
      `Notes: ${v.notes || 'None'}`,
      ``,
      `STORAGE / IMPOUND`,
      `Facility: ${storage?.name || '—'}`,
      `Address: ${storage?.address || '—'}`,
      `Phone: ${storage?.phone || '—'}`,
      // B120: VSF # rendered only when populated on storage_facilities.
      ...(storage?.vsf_license_number ? [`VSF #: ${storage.vsf_license_number}`] : []),
      ``,
      `TOW OPERATOR`,
      `Name: ${driver?.name || '—'}`,
      `License #: ${driver?.operator_license || '—'}`,
      `Company: ${driver?.company || 'A1 Wrecker, LLC'}`,
      // B120: TDLR # rendered only when populated on companies.
      ...(companyTdlr ? [`TDLR #: ${companyTdlr}`] : []),
      ``,
      `FEES`,
      `Tow Fee: $${effectiveTowFee.toFixed(2)}`,
      `Mileage Fee: $${effectiveMileage.toFixed(2)}`,
      `Total Due: $${total}`,
      // Capability-URL link in the plain-text body (the same URL goes
      // into mailto's "to" / share-sheet / clipboard via the popup
      // buttons below). If the RPC failed, viewUrl is empty and these
      // lines are skipped.
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
      .sec{margin-bottom:18px}
      .sh{font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#777;margin-bottom:8px;padding-bottom:3px;border-bottom:1px solid #eee}
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
          <div style="font-size:20px;font-weight:bold">${driver?.company || 'A1 Wrecker, LLC'}</div>
          <div style="font-size:15px;font-weight:bold;color:#C9A227;margin-top:3px">TOW TICKET</div>
        </div>
        <div style="margin-left:auto;text-align:right">
          <div style="font-size:10px;color:#888">Date / Time</div>
          <div style="font-weight:bold">${new Date(v.created_at).toLocaleString()}</div>
          <div style="font-size:10px;color:#888;margin-top:4px">Ticket #</div>
          <div style="font-weight:bold">${String(v.id).substring(0, 8).toUpperCase()}</div>
        </div>
      </div>
      <div class="warn">⚠ This vehicle has been towed pursuant to Texas Transportation Code §683. Contact the storage facility below to recover your vehicle.</div>
      <div class="sec">
        <div class="sh">Vehicle Information</div>
        <div class="g2">
          <div class="f"><label>License Plate</label><span class="plate">${v.plate}</span></div>
          <div class="f"><label>State</label><span>${v.state || '—'}</span></div>
          ${v.vehicle_year ? `<div class="f"><label>Year</label><span>${v.vehicle_year}</span></div>` : ''}
          ${[v.vehicle_make, v.vehicle_model, v.vehicle_color].filter(Boolean).length ? `<div class="f"><label>Make / Model / Color</label><span>${[v.vehicle_make, v.vehicle_model, v.vehicle_color].filter(Boolean).join('  ·  ')}</span></div>` : ''}
          ${effectiveVin ? `<div class="f" style="grid-column:span 2"><label>VIN</label><span style="font-family:'Courier New',monospace">${effectiveVin}</span></div>` : ''}
        </div>
      </div>
      <div class="sec">
        <div class="sh">Violation</div>
        <div class="g2">
          <div class="f"><label>Type</label><span>${displayTowReason(v.violation_type)}</span></div>
          <div class="f"><label>Location / Space</label><span>${v.location || '—'}</span></div>
          <div class="f" style="grid-column:span 2"><label>Notes</label><span>${v.notes || 'No additional notes.'}</span></div>
        </div>
      </div>
      <div class="sec">
        <div class="sh">Property</div>
        <div class="g2">
          <div class="f"><label>Authorized By</label><span>${v.property || '—'}</span></div>
        </div>
      </div>
      <div class="sec">
        <div class="sh">Tow Operator</div>
        <div class="g2">
          <div class="f"><label>Operator Name</label><span>${driver?.name || '—'}</span></div>
          <div class="f"><label>License #</label><span>${driver?.operator_license || '—'}</span></div>
          <div class="f"><label>Company</label><span>${driver?.company || 'A1 Wrecker, LLC'}</span></div>
          ${companyTdlr ? `<div class="f"><label>TDLR #</label><span>${companyTdlr}</span></div>` : ''}
        </div>
      </div>
      <div class="sec">
        <div class="sh">Storage / Impound</div>
        <div class="g2">
          <div class="f"><label>Facility</label><span>${storage?.name || '—'}</span></div>
          <div class="f"><label>Phone</label><span>${storage?.phone || '—'}</span></div>
          <div class="f" style="grid-column:span 2"><label>Address</label><span>${storage?.address || '—'}</span></div>
          ${storage?.vsf_license_number ? `<div class="f"><label>VSF #</label><span>${storage.vsf_license_number}</span></div>` : ''}
        </div>
      </div>
      ${(effectiveTowFee > 0 || effectiveMileage > 0) ? `
      <div class="sec">
        <div class="sh">Fees</div>
        <div class="g2">
          ${effectiveTowFee  > 0 ? `<div class="f"><label>Tow Fee</label><span>$${effectiveTowFee.toFixed(2)}</span></div>` : ''}
          ${effectiveMileage > 0 ? `<div class="f"><label>Mileage Fee</label><span>$${effectiveMileage.toFixed(2)}</span></div>` : ''}
          <div class="f"><label>Total Due</label><span style="font-size:16px;font-weight:bold">$${total}</span></div>
        </div>
      </div>` : ''}
      ${photosHtml}
      <div class="sig-wrap">
        <div><div class="sig-line">Operator Signature</div></div>
        <div><div class="sig-line">Date</div></div>
      </div>
      <div class="ftr">${driver?.company || localStorage.getItem('company_name') || 'A1 Wrecker, LLC'} &middot; ${localStorage.getItem('company_support_website') || localStorage.getItem('company_support_phone') || ''}<br>Generated ${new Date().toLocaleString()}</div>
      <div class="no-print" style="margin-top:20px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button onclick="window.print()" style="padding:11px 22px;background:#C9A227;color:#0f1117;font-weight:bold;font-size:13px;border:none;border-radius:7px;cursor:pointer">Print Ticket</button>
        <a href="mailto:${storageEmail}?subject=${mailSubject}&body=${mailBody}" style="padding:11px 22px;background:#1e3a5f;color:#fff;font-weight:bold;font-size:13px;border-radius:7px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center">Email Ticket</a>
        ${viewUrl ? `<button onclick="if(navigator.share){navigator.share({title:'Tow Ticket',text:'Tow ticket for plate ${v.plate}',url:'${viewUrl}'}).catch(()=>{})}else{alert('Sharing not supported on this device. Use Email or Copy Link.')}" style="padding:11px 22px;background:#2e7d32;color:#fff;font-weight:bold;font-size:13px;border:none;border-radius:7px;cursor:pointer">Share</button>` : ''}
        ${viewUrl ? `<button onclick="navigator.clipboard.writeText('${viewUrl}').then(()=>{var b=event.target;var t=b.textContent;b.textContent='Copied!';setTimeout(function(){b.textContent=t},1500)})" style="padding:11px 22px;background:#555;color:#fff;font-weight:bold;font-size:13px;border:none;border-radius:7px;cursor:pointer">Copy Link</button>` : ''}
        <button onclick="window.close()" style="padding:11px 22px;background:#333;color:#fff;font-size:13px;border:none;border-radius:7px;cursor:pointer">Close</button>
      </div>
    </body></html>`)
    tw.document.close()
    // Tow Ticket Regenerate Layer 2 — defensive skip on stamp.
    // ALREADY STAMPED → don't re-call stamp_tow_ticket; it would trip
    // B182's already_stamped guard and log a noisy console error.
    // Re-prints + post-regenerate prints both fall into this branch:
    // the row is canonical and the regenerate RPC has already done
    // the server-side stamp via its own inline UPDATE.
    //
    // The `storage` resolution above also accounts for this — when
    // isAlreadyStamped, storage comes from the row, not form state.
    // So even though storageFromRow is a synthetic object (id may be
    // missing if name-lookup didn't recover the original facility
    // row), it's never passed to stamp_tow_ticket below.
    const isAlreadyStampedForStamp = ticketTarget.tow_ticket_generated === true
    if (ticketTarget?.id && storage && !isAlreadyStampedForStamp && 'id' in storage && (storage as { id: unknown }).id !== undefined) {
      // B178 — direct UPDATE of tow_* columns on a confirmed violation
      // is now denied by the tightened RLS (USING is_confirmed = false).
      // Route through stamp_tow_ticket SECURITY DEFINER RPC which
      // validates role + violation/facility scope server-side, derives
      // tow_storage_* from the facility row (canonical, not client-
      // passed), and returns the updated row.
      // Migration 20260629 — mileage + VIN now persist via stamp_tow_ticket.
      // Blank/zero → null so the COALESCE preserves any prior value
      // (defensive; fresh stamps start NULL so null = "no charge / no VIN").
      const mileageToSend = parseFloat(mileage || '0') > 0 ? parseFloat(mileage) : null
      const vinTrimmed    = vin.trim()
      const vinToSend     = vinTrimmed.length > 0 ? vinTrimmed : null
      const { data: stampResult, error: stampErr } = await supabase.rpc('stamp_tow_ticket', {
        p_violation_id:        ticketTarget.id,
        p_storage_facility_id: (storage as { id: number | string }).id,
        p_tow_fee:             effectiveTowFee || null,
        p_mileage_fee:         mileageToSend,
        p_vin:                 vinToSend,
      })
      if (stampErr) {
        console.error('[B178 stamp_tow_ticket] RPC error:', stampErr.message)
      } else {
        const result = stampResult as { ok?: boolean; violation?: Record<string, unknown>; error?: string }
        if (!result?.ok || !result.violation) {
          console.error('[B178 stamp_tow_ticket] refused:', result?.error)
        } else {
          // Server returns the canonical updated row; reflect in local
          // state. setViolations + setTicketTarget receive the same
          // shape as the prior client-side patch (subset spread fine).
          const updated = result.violation as Record<string, unknown>
          setViolations((prev: any[]) => prev.map((v: any) => v.id === ticketTarget.id ? { ...v, ...updated } : v))
          setTicketTarget((prev: any) => prev ? { ...prev, ...updated } : null)
        }
      }
    }
  }

  const tab = (t: string): React.CSSProperties => ({
    flex: 1, padding: '8px', border: 'none', borderRadius: '6px',
    cursor: 'pointer', fontWeight: 'bold', fontSize: '11px',
    background: activeTab === t ? '#C9A227' : '#1e2535',
    color: activeTab === t ? '#0f1117' : '#888',
    fontFamily: 'Arial, sans-serif'
  })

  const inp: React.CSSProperties = {
    display: 'block', width: '100%', marginTop: '6px', marginBottom: '10px',
    padding: '9px 10px', background: '#1e2535', border: '1px solid #3a4055',
    borderRadius: '6px', color: 'white', fontSize: '12px', boxSizing: 'border-box'
  }

  const lbl: React.CSSProperties = {
    color: '#aaa', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em'
  }

  // Read-only stamped-ticket view — replaces the editable form on
  // already-stamped rows. 100% row-sourced from ticketTarget; zero
  // form-state read. Closes the prior integrity hole where the form
  // exposed editable storage/fee/VIN/mileage inputs on stamped rows
  // — mileage edits silently surfaced in the print (real silent-
  // change vector); storage/fee edits were ignored by Gate 5 but
  // misled the driver visually. To change ANY stamped value, the
  // driver must go through Regenerate (audited, voids prior, creates
  // new). Print button routes through generateTicket() which Gate 5's
  // already-stamped path row-sources facility + fee from ticketTarget
  // and skips the re-stamp RPC call.
  //
  // Mileage line: intentionally OMITTED until B191 mileage persistence
  // ships (next migration arc). No apologetic caveat copy on a legal
  // document — the row simply doesn't render when there's nothing
  // persisted. Post-B191, the conditional `{ticketTarget.tow_mileage_fee
  // != null && ...}` will surface the persisted value.
  function renderTicketReadOnlyView() {
    if (!ticketTarget) return null
    const facilityName    = ticketTarget.tow_storage_name    || '—'
    const facilityAddress = ticketTarget.tow_storage_address || ''
    const facilityPhone   = ticketTarget.tow_storage_phone   || ''
    const towFeeNum       = Number(ticketTarget.tow_fee || 0)
    return (
      <div style={{ background: '#0a1a0a', border: '2px solid #2e7d32', borderRadius: '10px', padding: '16px', marginTop: '12px' }}>
        <p style={{ color: '#4caf50', fontWeight: 'bold', fontSize: '14px', margin: '0 0 14px' }}>
          ✓ Tow Ticket — <span style={{ fontFamily: 'Courier New' }}>{ticketTarget.plate}</span>
        </p>

        {/* Stamped values panel — display-only */}
        <div style={{ background: '#0d1520', border: '1px solid #2a2f3d', borderRadius: '8px', padding: '12px', marginBottom: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={lbl}>Storage Facility</label>
              <p style={{ color: 'white', fontSize: '13px', margin: '4px 0 0', fontWeight: 'bold' }}>{facilityName}</p>
              {facilityAddress && <p style={{ color: '#888', fontSize: '11px', margin: '2px 0 0' }}>{facilityAddress}</p>}
              {facilityPhone && <p style={{ color: '#888', fontSize: '11px', margin: '2px 0 0' }}>{facilityPhone}</p>}
            </div>
            <div>
              <label style={lbl}>Tow Fee</label>
              <p style={{ color: 'white', fontSize: '13px', margin: '4px 0 0', fontWeight: 'bold' }}>${towFeeNum.toFixed(2)}</p>
            </div>
          </div>
          {/* Mileage line — conditional on persisted column existing.
              Today (pre-B191 mileage persistence), tow_mileage_fee is
              undefined on every row; this block doesn't render. Once
              B191 ships, persisted mileage values surface here without
              any UI change. */}
          {ticketTarget.tow_mileage_fee != null && (
            <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #2a2f3d' }}>
              <label style={lbl}>Mileage Fee</label>
              <p style={{ color: 'white', fontSize: '13px', margin: '4px 0 0', fontWeight: 'bold' }}>${Number(ticketTarget.tow_mileage_fee).toFixed(2)}</p>
            </div>
          )}
          {/* VIN — same conditional pattern as mileage; omits entirely
              when NULL. Pre-migration rows + post-migration rows where
              the driver didn't enter a VIN both stay clean (no "—" or
              "Not recorded" copy). Courier font matches the print HTML
              for consistency across the surfaces. */}
          {ticketTarget.vehicle_vin && (
            <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #2a2f3d' }}>
              <label style={lbl}>VIN</label>
              <p style={{ color: 'white', fontSize: '13px', margin: '4px 0 0', fontWeight: 'bold', fontFamily: 'Courier New' }}>{ticketTarget.vehicle_vin}</p>
            </div>
          )}
        </div>

        {/* Affordance: any change → Regenerate */}
        <p style={{ color: '#888', fontSize: '11px', margin: '0 0 14px', lineHeight: '1.55', fontStyle: 'italic' }}>
          To change the facility or fee, use <strong style={{ color: '#f59e0b' }}>⟲ Regenerate</strong> (creates a new ticket and voids this one — audited). Re-print produces a byte-identical copy of the stamped ticket.
        </p>

        {/* Buttons — Cancel + Print only. No edit affordance. */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => { setTicketTarget(null); setExpandedTicketId(null) }}
            style={{ flex: 1, padding: '11px', background: '#1e2535', color: '#aaa', border: '1px solid #3a4055', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold', fontFamily: 'Arial' }}>
            Cancel
          </button>
          <button onClick={generateTicket}
            style={{ flex: 1, padding: '11px', background: '#C9A227', color: '#0f1117', fontWeight: 'bold', fontSize: '13px', border: 'none', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
            🖨 Print Ticket
          </button>
        </div>
      </div>
    )
  }

  // Inline tow ticket form — called as a function, not a component
  function renderTicketForm() {
    if (!ticketTarget) return null
    return (
      <div style={{ background: '#0d1520', border: '2px solid #C9A227', borderRadius: '10px', padding: '16px', marginTop: '12px' }}>
        <p style={{ color: '#C9A227', fontWeight: 'bold', fontSize: '14px', margin: '0 0 14px' }}>
          Generate Tow Ticket — <span style={{ fontFamily: 'Courier New' }}>{ticketTarget.plate}</span>
        </p>

        <label style={lbl}>Storage Facility *</label>
        <select value={selectedStorage} onChange={e => setSelectedStorage(e.target.value)} style={inp}>
          <option value=''>Select storage facility...</option>
          {storageFacilities.map((s, i) => (
            <option key={i} value={s.id}>{s.name} — {s.address}</option>
          ))}
        </select>

        <label style={lbl}>VIN</label>
        <input value={vin} onChange={e => setVin(e.target.value)} placeholder="17-character VIN" style={inp} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
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
          <p style={{ color: '#C9A227', fontSize: '12px', margin: '-6px 0 10px', textAlign: 'right', fontWeight: 'bold' }}>
            Total: ${(parseFloat(towFee || '0') + parseFloat(mileage || '0')).toFixed(2)}
          </p>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={generateTicket} disabled={!selectedStorage}
            style={{ flex: 1, padding: '11px', background: !selectedStorage ? '#2a2f3d' : '#C9A227', color: !selectedStorage ? '#555' : '#0f1117', fontWeight: 'bold', fontSize: '13px', border: 'none', borderRadius: '8px', cursor: !selectedStorage ? 'not-allowed' : 'pointer', fontFamily: 'Arial' }}>
            Print Tow Ticket
          </button>
          <button onClick={() => { setTicketTarget(null); setExpandedTicketId(null) }}
            style={{ padding: '11px 12px', background: '#1e2535', color: '#aaa', fontSize: '12px', border: '1px solid #3a4055', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
            Close
          </button>
        </div>
      </div>
    )
  }

  if (loading) return (
    <main style={{ minHeight: '100vh', background: '#0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Arial, sans-serif' }}>
      <p style={{ color: '#888' }}>Loading...</p>
    </main>
  )

  if (error) return (
    <main style={{ minHeight: '100vh', background: '#0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Arial, sans-serif', padding: '20px' }}>
      <div style={{ textAlign: 'center' }}>
        <p style={{ color: '#f44336', fontSize: '14px', marginBottom: '16px' }}>{error}</p>
        <a href="/login" style={{ color: '#C9A227', fontSize: '13px' }}>← Back to Login</a>
      </div>
    </main>
  )

  const fvs = filteredViolations()

  return (
    <main style={{ minHeight: '100vh', background: '#0f1117', fontFamily: 'Arial, sans-serif', padding: '20px' }}>
      <div style={{ maxWidth: '520px', margin: '0 auto' }}>

        {/* B66.5 commit 4.3: past_due banner (rendered when company in past_due state) */}
        {pastDueBanner && <PastDueBanner {...pastDueBanner} />}

        {/* Header */}
        <div style={{ marginBottom: '16px', textAlign: 'center' }}>
          <img src={resolvedLogo} alt={driver?.company || 'ShieldMyLot'}
            style={{ width: '60px', height: '60px', borderRadius: '10px', border: '2px solid #C9A227', display: 'block', margin: '0 auto 8px' }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
          <h1 style={{ color: '#C9A227', fontSize: '22px', fontWeight: 'bold', margin: '0' }}>{driver?.company || 'ShieldMyLot'}</h1>
          <p style={{ color: '#888', fontSize: '13px', margin: '4px 0 0' }}>Driver Portal</p>
        </div>

        {/* Driver bar */}
        <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '10px', padding: '12px 16px', marginBottom: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <p style={{ color: 'white', fontWeight: 'bold', fontSize: '13px', margin: '0' }}>{driver?.name}</p>
            <p style={{ color: '#aaa', fontSize: '11px', margin: '2px 0 0' }}>
              {driver?.company || 'A1 Wrecker, LLC'} · Lic: {driver?.operator_license || '—'}
            </p>
            <p style={{ color: '#555', fontSize: '11px', margin: '2px 0 0' }}>
              {(driver?.assigned_properties || ['All']).join(' · ')}
            </p>
          </div>
          <button onClick={async () => { await supabase.auth.signOut(); window.location.href = '/login' }}
            style={{ padding: '6px 12px', background: '#1e2535', color: '#aaa', border: '1px solid #3a4055', borderRadius: '6px', cursor: 'pointer', fontSize: '11px', fontFamily: 'Arial' }}>
            Sign Out
          </button>
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

        {/* B18 review screen — replaces lookup/violations tabs when active */}
        {violationStage === 'review' && reviewViolation && (
          <ViolationReviewScreen
            violation={reviewViolation}
            videoFileName={violationVideo?.name || null}
            videoDuration={videoDuration}
            busy={reviewBusy}
            onEdit={editFromReview}
            onConfirm={confirmReviewedViolation}
            onDiscard={discardFromReview}
            userRole="driver"
            userEmail={driver?.email || ''}
            onMediaRemoved={refetchReviewViolation}
          />
        )}

        {/* Tabs — hidden while in review mode so the review screen owns focus */}
        {violationStage !== 'review' && (<>
        <div style={{ display: 'flex', gap: '4px', background: '#1e2535', borderRadius: '8px', padding: '3px', marginBottom: '14px' }}>
          <button style={tab('lookup')} onClick={() => setActiveTab('lookup')}>Plate Lookup</button>
          <button style={tab('violations')} onClick={() => setActiveTab('violations')}>
            Violations {violations.length > 0 ? `(${violations.length})` : ''}
          </button>
        </div>

        {/* ── PLATE LOOKUP ── */}
        {activeTab === 'lookup' && (
          <div>
            {(() => {
              const props = (driver?.assigned_properties || []).filter((p: string) => p !== 'All')
              if (props.length === 0) return null
              return (
                <div style={{ background:'#161b26', border:`1px solid ${selectedProperty ? '#C9A227' : '#a16207'}`, borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                  <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Currently Working At</label>
                  {props.length === 1 ? (
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'14px', margin:'6px 0 0' }}>{selectedProperty}</p>
                  ) : (
                    <>
                      {!selectedProperty && <p style={{ color:'#fbbf24', fontSize:'11px', margin:'4px 0 6px' }}>⚠ Please select a property first</p>}
                      <select value={selectedProperty} onChange={e => setSelectedProperty(e.target.value)}
                        style={{ display:'block', width:'100%', marginTop:'6px', padding:'10px 12px', background:'#1e2535', border:`1px solid ${selectedProperty ? '#C9A227' : '#a16207'}`, borderRadius:'8px', color: selectedProperty ? 'white' : '#fbbf24', fontSize:'13px', boxSizing:'border-box' as const, outline:'none' }}>
                        <option value=''>-- Select Property --</option>
                        {props.map((p: string) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </>
                  )}
                </div>
              )
            })()}
            <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '12px', padding: '22px', marginBottom: '14px' }}>
              <label style={{ color: '#aaa', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.1em' }}>License Plate</label>
              <button onClick={openCamera} disabled={!selectedProperty}
                style={{ width: '100%', padding: '12px', background: '#1a1f2e', color: selectedProperty ? '#C9A227' : '#555', border: `1px solid ${selectedProperty ? '#C9A227' : '#3a4055'}`, borderRadius: '8px', cursor: selectedProperty ? 'pointer' : 'not-allowed', fontSize: '14px', fontWeight: 'bold', marginTop: '8px', marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontFamily: 'Arial' }}>
                📷 Scan License Plate
              </button>
              <input
                value={plate}
                onChange={e => { setPlate(normalizePlate(e.target.value)); setResult(null); setTicketTarget(null); setScanMsg(''); setSearchTimestamp(null) }}
                onKeyDown={e => e.key === 'Enter' && searchPlate()}
                placeholder="ABC1234"
                maxLength={10}
                style={{
                  display: 'block', width: '100%', padding: '16px',
                  fontSize: '28px', fontFamily: 'Courier New', fontWeight: 'bold', letterSpacing: '0.12em',
                  background: '#1e2535', border: '2px solid #3a4055', borderRadius: '10px',
                  color: 'white', textAlign: 'center', outline: 'none', boxSizing: 'border-box',
                  textTransform: 'uppercase'
                }}
              />
              {scanMsg && (
                <p style={{ color:'#C9A227', fontSize:'12px', margin:'4px 0 0', fontStyle:'italic' }}>{scanMsg}</p>
              )}
              <button onClick={() => searchPlate()} disabled={searching || !plate || !selectedProperty}
                style={{
                  marginTop: '12px', width: '100%', padding: '14px',
                  background: (!plate || !selectedProperty) ? '#2a2f3d' : '#C9A227',
                  color: (!plate || !selectedProperty) ? '#555' : '#0f1117',
                  fontWeight: 'bold', fontSize: '15px', border: 'none', borderRadius: '8px',
                  cursor: (!plate || !selectedProperty) ? 'not-allowed' : 'pointer', fontFamily: 'Arial'
                }}>
                {searching ? 'Searching...' : 'Search Plate'}
              </button>

              {result && searchTimestamp && (
                <div style={{ marginTop:'16px', background:'#0f1117', border:'1px solid #C9A227', borderRadius:'8px', padding:'10px 14px', marginBottom:'10px', fontFamily:'Courier New' }}>
                  <div style={{ color:'#C9A227', fontSize:'11px', fontWeight:'bold' }}>🕐 Search recorded: {new Intl.DateTimeFormat('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', second:'2-digit', hour12:true }).format(searchTimestamp)}</div>
                  <div style={{ color:'#aaa', fontSize:'11px' }}>Property: {selectedProperty} · Driver: {driver?.name || driver?.email}{driver?.company ? ` · ${driver.company}` : ''}</div>
                </div>
              )}

              {result && (
                <div style={{
                  marginTop: '0', padding: '16px', borderRadius: '10px',
                  // B214: guest_authorized = blue (distinct from green=resident,
                  // orange=visitor). LOUD distinction per Jose 2026-06-20 —
                  // guest_authorized is the newest status with no driver muscle
                  // memory; tow-by-default risk is highest here.
                  background: result.status === 'authorized' ? '#061406' : result.status === 'plate_under_review' ? '#241a08' : result.status === 'visitor' ? '#150f00' : result.status === 'guest_authorized' ? '#0a1628' : '#140404',
                  border: `1px solid ${result.status === 'authorized' ? '#2e7d32' : result.status === 'plate_under_review' ? '#a16207' : result.status === 'visitor' ? '#a16207' : result.status === 'guest_authorized' ? '#3b82f6' : '#991b1b'}`
                }}>
                  {result.status === 'authorized' && (
                    <>
                      {/* Spaces v1 PII sweep (Jose 2026-06-21): Unit REMOVED.
                          Space label + description KEPT per the locked privacy
                          line — space is not PII (it's a parking spot); unit
                          identifies a household. Modal detail string emptied
                          so the override banner reads "active resident"
                          without leaking the unit.
                          Spaces v1.1 commit 5 (2026-06-22): Space rendering
                          moved below this grid, now driven by _assigned_spaces
                          from derive_space_allowed_plates RPC (multi-resident-
                          aware). Allowed plates per space included by design
                          (driver's operational context). */}
                      <p style={{ color: '#4caf50', fontWeight: 'bold', fontSize: '16px', margin: '0 0 12px' }}>✓ AUTHORIZED</p>
                      {/* Slice 4 — plate change under review banner. Attached
                          to authorized-vehicle result when vehicles.status =
                          'under_review'. Old plate (what the driver scanned)
                          is STILL enforce-valid — the authorized status
                          stands. Banner just tells the driver a change is
                          in flight, so they see the same context the PM
                          sees. */}
                      {result.data._pending_plate_change && (
                        <div style={{ background: '#3a2e0a', border: '1px solid #a16207', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px' }}>
                          {/* Slice-4 close-out (Jose 2026-07-03) — imperative
                              headline anchored on the authorization fact:
                              current plate stays valid = the vehicle is
                              still authorized under it. */}
                          <p style={{ color: '#fbbf24', fontWeight: 'bold', fontSize: '12px', margin: '0 0 6px' }}>⚠ DO NOT TOW — plate change under review by PM. Current plate stays valid.</p>
                          <p style={{ color: '#fef3c7', fontSize: '12px', margin: '0', lineHeight: '1.5' }}>
                            <span style={{ fontFamily: 'Courier New' }}>{result.data._pending_plate_change.old_plate}</span>
                            {' → '}
                            <span style={{ fontFamily: 'Courier New', fontWeight: 'bold' }}>{result.data._pending_plate_change.new_plate}</span>
                            <span style={{ color: '#aaa', marginLeft: '8px' }}>· submitted {new Date(result.data._pending_plate_change.submitted_at).toLocaleDateString()}</span>
                          </p>
                        </div>
                      )}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '14px' }}>
                        <div><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Property</span><br /><span style={{ color: '#4caf50', fontSize: '13px' }}>{result.data.property}</span></div>
                        <div><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Vehicle</span><br /><span style={{ color: 'white', fontSize: '13px' }}>{[result.data.year, result.data.color, result.data.make, result.data.model].filter(Boolean).join(' ') || '—'}</span></div>
                      </div>
                      {/* Spaces v1.1: 0..N space labels via derive_space_allowed_plates RPC.
                          Empty array = '—' (dash) — INVARIANT: vehicle authorization is
                          INDEPENDENT of space tie. A plate authorized but with no space
                          still shows "AUTHORIZED" above; this block just renders space
                          reference data. Per-space allowed-plates list includes
                          roommate plates by design (unit pays for the space). */}
                      <div style={{ marginBottom: '14px', padding: '10px', background: '#0a1a0a', border: '1px solid #1e3a1e', borderRadius: '8px' }}>
                        <span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Space</span>
                        {(!result.data._assigned_spaces || result.data._assigned_spaces.length === 0) ? (
                          <div style={{ color: '#aaa', fontSize: '13px', marginTop: '3px' }}>—</div>
                        ) : (
                          result.data._assigned_spaces.map((s: { space_label: string; space_description: string | null; plates: string[] }) => (
                            <div key={s.space_label} style={{ marginTop: '6px' }}>
                              <div style={{ color: 'white', fontSize: '14px', fontWeight: 'bold', fontFamily: 'Courier New' }}>{s.space_label}</div>
                              {s.space_description && <p style={{ color: '#888', fontSize: '11px', fontStyle: 'italic', margin: '2px 0 0' }}>{s.space_description}</p>}
                              {s.plates && s.plates.length > 0 && (
                                <p style={{ color: '#888', fontSize: '11px', margin: '3px 0 0' }}>
                                  <span style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '9px' }}>Allowed plates:</span>{' '}
                                  <span style={{ fontFamily: 'Courier New', color: '#aaa' }}>{s.plates.join(' · ')}</span>
                                </p>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                      {/* B71: authorized vehicles can still be parked illegally
                          (fire lane, handicap, blocked access). Issue Violation
                          opens the decline-reason interstitial first. */}
                      <button onClick={() => setDeclineModal({ authorizedAs: 'resident', detail: '' })}
                        style={{ width: '100%', padding: '11px', background: '#1e2535', color: '#f59e0b', fontWeight: 'bold', fontSize: '13px', border: '1px solid #f59e0b', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
                        Issue Violation (location/manner override)
                      </button>
                    </>
                  )}

                  {/* Slice 4 SAFETY-CRITICAL — driver scanned the NEW plate
                      of a resident's pending plate change. The plate isn't
                      on vehicles yet (old plate is still there), so the
                      normal cascade would have returned notfound. This
                      branch surfaces DO NOT TOW instead, with old→new
                      context so the driver understands what they see. */}
                  {result.status === 'plate_under_review' && (
                    <>
                      {/* Slice-4 close-out (Jose 2026-07-03) — authorization-
                          anchored copy. Headline is the protective imperative;
                          body is the AUTHORIZATION determination (vehicle is
                          authorized under its current plate), not a bare
                          status. App voice = authorization; the human owns
                          the enforcement call. */}
                      <p style={{ color: '#fbbf24', fontWeight: 'bold', fontSize: '17px', margin: '0 0 8px' }}>⚠ DO NOT TOW — plate change under review</p>
                      <p style={{ color: '#fef3c7', fontSize: '13px', margin: '0 0 4px', lineHeight: '1.5' }}>
                        Vehicle is <b>authorized</b> under its current plate ({result.data.old_plate}).
                      </p>
                      <p style={{ color: '#aaa', fontSize: '12.5px', margin: '0 0 12px', lineHeight: '1.5' }}>
                        Scanned plate ({result.data.new_plate}) is a pending change awaiting PM approval.
                      </p>
                      <div style={{ background: '#0f1117', border: '1px solid #a16207', borderRadius: '8px', padding: '10px 12px', marginBottom: '14px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '12px' }}>
                          <div>
                            <span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Prior plate (still enforce-valid)</span><br />
                            <span style={{ color: '#aaa', fontFamily: 'Courier New', fontSize: '14px' }}>{result.data.old_plate}</span>
                          </div>
                          <div>
                            <span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Requested plate (scanned)</span><br />
                            <span style={{ color: '#fbbf24', fontFamily: 'Courier New', fontSize: '14px', fontWeight: 'bold' }}>{result.data.new_plate}</span>
                          </div>
                        </div>
                        <p style={{ color: '#888', fontSize: '11px', margin: '8px 0 0' }}>Submitted {new Date(result.data.submitted_at).toLocaleDateString()}</p>
                      </div>
                    </>
                  )}

                  {result.status === 'guest_authorized' && (
                    <>
                      {/* B214: vetted multi-week guest authorization (manager-
                          created via /api/.../create-guest-authorization RPC).
                          LOUD "DO NOT TOW" banner is load-bearing — this is
                          the newest status with no driver muscle memory; the
                          unambiguous-beats-subtle directive (Jose 2026-06-20)
                          is to prevent tow-by-default when a driver sees an
                          unfamiliar panel.

                          Issue Violation button is the gold-outline B71-parity
                          override (NOT the red tow button) — a vetted guest
                          can still violate location/manner (fire lane, etc.),
                          but it routes through the decline-reason modal first. */}
                      <p style={{ color: '#3b82f6', fontWeight: 'bold', fontSize: '17px', margin: '0 0 8px' }}>✓ AUTHORIZED GUEST</p>
                      <div style={{ background: '#1e3a5f', borderLeft: '4px solid #3b82f6', padding: '12px 14px', borderRadius: '6px', marginBottom: '14px' }}>
                        <p style={{ color: 'white', fontSize: '16px', fontWeight: 'bold', margin: '0 0 4px', letterSpacing: '0.02em' }}>DO NOT TOW</p>
                        <p style={{ color: '#bfdbfe', fontSize: '12px', margin: '0', lineHeight: '1.5' }}>Manager-authorized guest. Valid through <strong style={{ color: 'white' }}>{result.data.end_date}</strong>.</p>
                      </div>
                      {/* Spaces v1 PII sweep (Jose 2026-06-21, STRICT):
                          Guest name + Visiting Unit + Approved-by REMOVED
                          (all identity-leaking). non_resident_reason KEPT —
                          it's why-authorized context, not who (Jose lock:
                          "HVAC contractor" MAY stay, personal names off).
                          Dates kept (operational signal, not PII). Modal
                          detail string keeps only non_resident_reason. */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '14px' }}>
                        {result.data.non_resident_reason && (
                          <div style={{ gridColumn: 'span 2' }}>
                            <span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Type</span><br />
                            <span style={{ color: 'white', fontSize: '13px' }}>{result.data.non_resident_reason}</span>
                          </div>
                        )}
                        <div><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Authorized From</span><br /><span style={{ color: 'white', fontSize: '13px' }}>{result.data.start_date}</span></div>
                        <div><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Authorized Through</span><br /><span style={{ color: '#3b82f6', fontSize: '13px', fontWeight: 'bold' }}>{result.data.end_date}</span></div>
                      </div>
                      <button onClick={() => setDeclineModal({ authorizedAs: 'guest', detail: result.data.non_resident_reason ? `(${result.data.non_resident_reason})` : '' })}
                        style={{ width: '100%', padding: '11px', background: '#1e2535', color: '#f59e0b', fontWeight: 'bold', fontSize: '13px', border: '1px solid #f59e0b', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
                        Issue Violation (location/manner override)
                      </button>
                    </>
                  )}

                  {(result.status === 'pending' || result.status === 'declined' || result.status === 'expired') && (
                    <>
                      {/* Spaces v1.1 commit 5: Unit field REMOVED (closes B225's
                          deferred sub-line — Q5 narrow drops `unit` from the
                          vehicles payload, and the privacy invariant applies
                          consistently across all driver-scan statuses). Space
                          field updated to consume _assigned_spaces array.
                          Vehicle stays. */}
                      <p style={{ color: '#ff9800', fontWeight: 'bold', fontSize: '16px', margin: '0 0 12px' }}>
                        {result.status === 'pending' ? 'AWAITING MANAGER APPROVAL'
                          : result.status === 'declined' ? 'REGISTRATION DECLINED'
                          : '⚠ PERMIT EXPIRED'}
                      </p>
                      <div style={{ marginBottom: '14px' }}>
                        <span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Vehicle</span><br />
                        <span style={{ color: 'white', fontSize: '13px' }}>{[result.data.year, result.data.color, result.data.make, result.data.model].filter(Boolean).join(' ') || '—'}</span>
                      </div>
                      {/* Space reference data — same shape as authorized block.
                          For pending/declined/expired this is historical context
                          ("this car was tied to C-12"). Renders only if the
                          resident still has space ties (residents_deactivate_free_spaces
                          trigger clears ties on resident deactivation; here we just
                          render whatever the RPC returned). */}
                      <div style={{ marginBottom: '14px', padding: '10px', background: '#1a0a00', border: '1px solid #3a1e0a', borderRadius: '8px' }}>
                        <span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Space</span>
                        {(!result.data._assigned_spaces || result.data._assigned_spaces.length === 0) ? (
                          <div style={{ color: '#aaa', fontSize: '13px', marginTop: '3px' }}>—</div>
                        ) : (
                          result.data._assigned_spaces.map((s: { space_label: string; space_description: string | null; plates: string[] }) => (
                            <div key={s.space_label} style={{ marginTop: '6px' }}>
                              <div style={{ color: 'white', fontSize: '14px', fontWeight: 'bold', fontFamily: 'Courier New' }}>{s.space_label}</div>
                              {s.space_description && <p style={{ color: '#888', fontSize: '11px', fontStyle: 'italic', margin: '2px 0 0' }}>{s.space_description}</p>}
                            </div>
                          ))
                        )}
                      </div>
                      <button onClick={() => { setViolation(v => ({ ...v, property: selectedProperty })); setShowViolation(true) }}
                        style={{ width: '100%', padding: '11px', background: '#991b1b', color: 'white', fontWeight: 'bold', fontSize: '13px', border: 'none', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
                        Issue Violation
                      </button>
                    </>
                  )}

                  {result.status === 'visitor' && (
                    <>
                      {/* Spaces v1 PII sweep (Jose 2026-06-21): Visiting Unit
                          + Visitor Name REMOVED. Driver gets "authorized or
                          not" + expiry; identity stays off the driver scan.
                          Modal detail string emptied so the override banner
                          reads "active visitor pass" without leaking the
                          visiting unit. */}
                      <p style={{ color: '#f59e0b', fontWeight: 'bold', fontSize: '16px', margin: '0 0 12px' }}>✓ VISITOR PASS ACTIVE</p>
                      <div style={{ marginBottom: '14px' }}>
                        <span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Expires</span><br />
                        <span style={{ color: '#f59e0b', fontWeight: 'bold', fontSize: '13px' }}>{new Date(result.data.expires_at).toLocaleString()}</span>
                      </div>
                      <p style={{ color: '#f59e0b', fontSize: '11px', margin: '0 0 12px', fontWeight: 'bold' }}>Do not tow for unauthorized status — active visitor pass.</p>
                      {/* B71: visitor passes are an "authorized" state per spec;
                          location/manner violations (fire lane, etc.) still apply. */}
                      <button onClick={() => setDeclineModal({ authorizedAs: 'visitor', detail: '' })}
                        style={{ width: '100%', padding: '11px', background: '#1e2535', color: '#f59e0b', fontWeight: 'bold', fontSize: '13px', border: '1px solid #f59e0b', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
                        Issue Violation (location/manner override)
                      </button>
                    </>
                  )}

                  {/* (2026-06-26) — removed dead `result.status === 'notassigned'`
                      render branch. searchPlate() never emits that status; the
                      cascade only produces authorized / pending / declined /
                      expired / guest_authorized / visitor / notfound. Memory
                      tracked it as "B215 driver portal notassigned dead-code
                      render block" (logged 2026-06-20 during B214 audit). */}

                  {result.status === 'notfound' && (
                    <>
                      <p style={{ color: '#f44336', fontWeight: 'bold', fontSize: '16px', margin: '0 0 6px' }}>✗ NO PERMIT FOUND</p>
                      <p style={{ color: '#aaa', fontSize: '13px', margin: '0 0 12px' }}>Plate is not registered. Vehicle may be towed.</p>
                      <button onClick={() => { setViolation(v => ({ ...v, property: selectedProperty })); setShowViolation(true) }}
                        style={{ width: '100%', padding: '11px', background: '#991b1b', color: 'white', fontWeight: 'bold', fontSize: '13px', border: 'none', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
                        Issue Violation
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* Violation form */}
              {showViolation && (
                <div style={{ marginTop: '14px', background: '#0f0505', border: '1px solid #991b1b', borderRadius: '10px', padding: '16px' }}>
                  <p style={{ color: '#f44336', fontWeight: 'bold', fontSize: '14px', margin: '0 0 14px' }}>
                    Issue Violation — <span style={{ fontFamily: 'Courier New' }}>{plate}</span>
                  </p>

                  <label style={lbl}>Property</label>
                  <div style={{ ...inp, color: '#C9A227', fontWeight: 'bold', display: 'flex', alignItems: 'center' }}>{violation.property}</div>

                  {/* B71: locked decline-reason banner when the violation was
                      opened against an authorized plate. Reason was captured
                      in the modal; driver can't change it from here. */}
                  {pendingDecline && (
                    <div style={{ background: '#1e1800', border: '1px solid #C9A227', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px' }}>
                      <p style={{ color: '#C9A227', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 4px', fontWeight: 'bold' }}>Authorized-plate override</p>
                      <p style={{ color: '#fbbf24', fontSize: '12px', margin: '0', lineHeight: '1.5' }}>
                        {DECLINE_REASON_LABELS[pendingDecline.reason]}
                      </p>
                      {pendingDecline.note && (
                        <p style={{ color: '#aaa', fontSize: '11px', margin: '4px 0 0', lineHeight: '1.5' }}>“{pendingDecline.note}”</p>
                      )}
                    </div>
                  )}

                  <label style={lbl}>Violation Type *</label>
                  {/* Tow-reason standardization (2026-06-22): inline 8-option
                      list REMOVED; renders from app/lib/tow-reasons.ts (14
                      curated codes + RESTRICTED_ON_OVERRIDE set replacing
                      the old !pendingDecline conditional on the 3 codes
                      that contradict the authorized-plate premise). Option
                      `value` is the CODE; the form-state holds the code;
                      submit stores the code in violations.violation_type.
                      Old freetext rows render correctly via displayTowReason. */}
                  <select value={violation.type} onChange={e => setViolation({ ...violation, type: e.target.value })} style={inp}>
                    <option value=''>Select type...</option>
                    {TOW_REASONS
                      .filter(r => !(pendingDecline && RESTRICTED_ON_OVERRIDE.has(r.code as TowReasonCode)))
                      .map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
                  </select>

                  <label style={lbl}>Space / Location</label>
                  <input value={violation.location} onChange={e => setViolation({ ...violation, location: e.target.value })} placeholder="e.g. Space A-14, North lot" style={inp} />

                  <label style={lbl}>VIN (optional)</label>
                  <input value={vin} onChange={e => setVin(e.target.value)} placeholder="17-character VIN" style={inp} />

                  {(() => {
                    // B42: photo count cap from tier. -1 = unlimited.
                    //
                    // Fallback policy (asymmetric with VIDEO_MAX_DURATION_SECONDS):
                    // when localStorage company_tier isn't populated, default to
                    // Starter cap (3) rather than the tier-config default (legacy = -1 unlimited).
                    // Rationale: photo cap is a multiplier (many uploads per submission)
                    // while video duration is single-value (one upload, one time check).
                    // The asymmetric risk warrants an asymmetric default — most-restrictive
                    // for photos, legacy-permissive for video.
                    //
                    // Combined guards: empty-localStorage check (the stated failure mode)
                    // + isNaN guard (defensive against any future non-numeric return from
                    // getLimit). Either condition triggers the Starter fallback.
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
                            // Consistent with the existing 10MB batch-reject semantics.
                            if (photoCap >= 0 && photos.length + newFiles.length > photoCap) {
                              alert(`Photo limit: ${photoCap} max per violation. You have ${photos.length} attached; this batch of ${newFiles.length} would exceed the cap.`)
                              e.target.value = ''
                              return
                            }
                            setPhotos(prev => [...prev, ...newFiles])
                            e.target.value = ''
                          }}
                          style={{ ...inp, color: '#aaa' }} />
                      </>
                    )
                  })()}
                  {photos.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                      {photos.map((p, i) => (
                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: '#1e2535', border: '1px solid #3a4055', borderRadius: '5px', padding: '3px 8px', fontSize: '10px', color: '#aaa' }}>
                          📷 {p.name.length > 14 ? p.name.substring(0, 14) + '…' : p.name}
                          <button onClick={() => setPhotos(prev => prev.filter((_, idx) => idx !== i))}
                            aria-label={`Remove photo ${p.name}`}
                            style={{ background: 'none', border: 'none', color: '#f44336', cursor: 'pointer', fontSize: '12px', padding: '0 2px', lineHeight: '1' }}>
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {(() => {
                    // Phase 2a: video duration cap pulled from tier.
                    // Driver-video-gate (2026-06-10): a value of 0 means the
                    // tier explicitly excludes video (PM-track Essential /
                    // Professional / Enterprise per tier-config.ts). Hide
                    // the control entirely so a driver on a non-video tier
                    // never sees an input they can't use (the prior
                    // `|| 60` fallback collapsed 0 to 60 — show-then-fail).
                    // Defense-in-depth: PM tiers lack DRIVER_PORTAL today,
                    // so reaching here on PM context is rare, but the
                    // render-side gate is the correct discipline regardless.
                    const videoMaxSec = Number(getLimit(FEATURE_FLAGS.VIDEO_MAX_DURATION_SECONDS, getCompanyContext()))
                    if (videoMaxSec === 0) return null
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
                          style={{ ...inp, color: '#aaa' }} />
                      </>
                    )
                  })()}
                  {violationVideo && (
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'5px', padding:'6px 10px', marginBottom:'10px' }}>
                      <span style={{ color:'#aaa', fontSize:'11px' }}>🎥 {violationVideo.name.length > 22 ? violationVideo.name.substring(0, 22) + '…' : violationVideo.name}{videoDuration !== null ? ` (${videoDuration}s)` : ''}</span>
                      <button onClick={() => setViolationVideo(null)} style={{ background:'none', border:'none', color:'#f44336', cursor:'pointer', fontSize:'12px', padding:'0 2px' }}>✕</button>
                    </div>
                  )}

                  <label style={lbl}>Notes</label>
                  <textarea value={violation.notes} onChange={e => setViolation({ ...violation, notes: e.target.value })}
                    placeholder="Reason for violation, additional details..."
                    style={{ ...inp, minHeight: '64px', resize: 'vertical' as const }} />

                  <label style={lbl}>Vehicle Color (optional)</label>
                  <input value={violation.vehicle_color} onChange={e => setViolation({ ...violation, vehicle_color: e.target.value })} placeholder="e.g. White, Black, Red" style={inp} />

                  <label style={lbl}>Vehicle Make (optional)</label>
                  <input value={violation.vehicle_make} onChange={e => setViolation({ ...violation, vehicle_make: e.target.value })} placeholder="e.g. Toyota, Honda" style={inp} />

                  <label style={lbl}>Vehicle Model (optional)</label>
                  <input value={violation.vehicle_model} onChange={e => setViolation({ ...violation, vehicle_model: e.target.value })} placeholder="e.g. Camry, Civic" style={inp} />

                  <label style={lbl}>Vehicle Year (optional)</label>
                  <input type="number" min={1900} max={new Date().getFullYear() + 1} step={1} value={violation.vehicle_year} onChange={e => setViolation({ ...violation, vehicle_year: e.target.value })} placeholder="e.g. 2020" style={inp} />

                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={submitViolation} disabled={submitting}
                      style={{ flex: 1, padding: '11px', background: submitting ? '#555' : '#991b1b', color: 'white', fontWeight: 'bold', fontSize: '13px', border: 'none', borderRadius: '8px', cursor: submitting ? 'not-allowed' : 'pointer', fontFamily: 'Arial' }}>
                      {submitting ? (uploadingVideo ? `Uploading video... ${uploadProgress}%` : 'Submitting...') : 'Submit Violation'}
                    </button>
                    <button onClick={() => { setShowViolation(false); setPendingDecline(null) }}
                      style={{ padding: '11px 12px', background: '#1e2535', color: '#aaa', fontSize: '12px', border: '1px solid #3a4055', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Tow ticket appears here after violation submit */}
            {ticketTarget && activeTab === 'lookup' && renderTicketForm()}
          </div>
        )}

        {/* ── VIOLATIONS TAB ── */}
        {activeTab === 'violations' && (
          <div>
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search plate, property, violation type..."
              style={{ ...inp, fontSize: '13px', padding: '11px 12px', marginBottom: '10px' }}
            />

            <div style={{ display: 'flex', gap: '4px', background: '#1e2535', borderRadius: '8px', padding: '3px', marginBottom: violationFilter === 'custom' ? '10px' : '12px' }}>
              {[{k:'today',l:'Today'},{k:'week',l:'This Week'},{k:'sixmonths',l:'6 Months'},{k:'custom',l:'Date Range'}].map(f => (
                <button key={f.k} onClick={() => setViolationFilter(f.k)}
                  style={{ flex: 1, padding: '8px 3px', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '10px', fontWeight: 'bold', background: violationFilter === f.k ? '#C9A227' : 'transparent', color: violationFilter === f.k ? '#0f1117' : '#888', fontFamily: 'Arial' }}>
                  {f.l}
                </button>
              ))}
            </div>

            {violationFilter === 'custom' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
                <div>
                  <label style={{ ...lbl, display: 'block', marginBottom: '4px' }}>From</label>
                  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ ...inp, marginTop: 0 }} />
                </div>
                <div>
                  <label style={{ ...lbl, display: 'block', marginBottom: '4px' }}>To</label>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ ...inp, marginTop: 0 }} />
                </div>
              </div>
            )}

            <p style={{ color: '#444', fontSize: '11px', margin: '0 0 10px', textAlign: 'right' }}>
              {fvs.length} result{fvs.length !== 1 ? 's' : ''}
            </p>

            {fvs.length === 0 ? (
              <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '10px', padding: '40px', textAlign: 'center' }}>
                <p style={{ color: '#555', fontSize: '13px', margin: '0' }}>No violations found for this period</p>
              </div>
            ) : fvs.map((v, i) => (
              <div key={i} style={{ background: '#161b26', border: v.voided_at ? '1px solid #b71c1c' : '1px solid #2a2f3d', borderRadius: '10px', padding: '14px', marginBottom: '8px', opacity: v.voided_at ? 0.78 : 1 }}>
                {/* B175 — voided marker (driver sees same visible+marked as
                    manager/admin for forensic clarity). */}
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                  <div>
                    <p style={{ color: '#f44336', fontFamily: 'Courier New', fontSize: '20px', fontWeight: 'bold', margin: '0' }}>{v.plate}</p>
                    <p style={{ color: '#aaa', fontSize: '11px', margin: '3px 0 0' }}>{displayTowReason(v.violation_type)}</p>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ color: '#555', fontSize: '11px', margin: '0' }}>{new Date(v.created_at).toLocaleDateString()}</p>
                    <p style={{ color: '#444', fontSize: '10px', margin: '2px 0 0' }}>{new Date(v.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</p>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px', marginBottom: '10px' }}>
                  <div><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Property</span><br /><span style={{ color: '#aaa' }}>{v.property || '—'}</span></div>
                  <div><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Location</span><br /><span style={{ color: '#aaa' }}>{v.location || '—'}</span></div>
                  {v.driver_name && <div style={{ gridColumn: 'span 2' }}><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Driver</span><br /><span style={{ color: '#aaa' }}>{v.driver_name}</span></div>}
                  {v.notes && <div style={{ gridColumn: 'span 2' }}><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Notes</span><br /><span style={{ color: '#aaa' }}>{v.notes}</span></div>}
                </div>

                {v.photos && v.photos.length > 0 && (
                  <div style={{ marginBottom: '10px' }}>
                    <p style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase', margin: '0 0 6px' }}>Evidence Photos</p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '6px' }}>
                      {v.photos.map((url: string, pi: number) => (
                        <a key={pi} href={url} target="_blank" rel="noopener noreferrer">
                          <img src={url} alt={`Photo ${pi + 1}`} style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', borderRadius: '6px', border: '1px solid #2a2f3d' }} />
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {v.video_url && (
                  <button onClick={() => window.open(v.video_url, '_blank')}
                    style={{ width: '100%', padding: '7px', background: '#0f1620', color: '#C9A227', border: '1px solid #C9A227', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', fontFamily: 'Arial', marginBottom: '10px' }}>
                    ▶ Play Video
                  </button>
                )}

                {/* Tow Ticket Regenerate — 3-state row-action conditional
                    (Jose lock 2026-06-28). Replaces the prior 2-branch
                    fall-through where every non-(stamped+permitted) case
                    rendered "Generate Tow Ticket" — including already-
                    stamped rows for non-permitted drivers, AND voided
                    rows. That collapsed UX state lied to drivers about
                    stamping state and let voided rows be "re-generated"
                    (Layer 2's stamp-skip hid the silent already_stamped
                    refusal, so re-prints succeeded with no DB change —
                    looked normal, broke the one-live-ticket model).
                    Three explicit branches:
                      VOIDED   → muted disabled "Ticket Voided" pill;
                                 no action. Regenerate is off-limits on
                                 voided rows (RPC also refuses).
                      STAMPED  → "View / Re-print Ticket" (routes through
                                 Gate 5 row-sourced print; stamp-skip
                                 already prevents re-stamp). + Regenerate
                                 button when driver.can_regenerate_tow_ticket.
                      FRESH    → "Generate Tow Ticket" (existing fresh
                                 behavior preserved). */}
                {(() => {
                  const isVoided   = !!v.voided_at
                  const isStamped  = v.tow_ticket_generated && !isVoided
                  const canRegen   = driver?.can_regenerate_tow_ticket && isStamped
                  if (isVoided) {
                    return (
                      <div style={{ width: '100%', padding: '9px', background: '#1a0a0a', color: '#888', border: '1px dashed #5a2a2a', borderRadius: '7px', fontSize: '12px', fontWeight: 'bold', fontFamily: 'Arial', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.06em' }}
                           title="This tow ticket was voided. To issue a replacement, the driver who voided it (or company admin) used Regenerate to create a new ticket.">
                        🚫 Ticket Voided
                      </div>
                    )
                  }
                  if (isStamped) {
                    return (
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          onClick={() => expandedTicketId === v.id ? (setExpandedTicketId(null), setTicketTarget(null)) : openTicketFor(v)}
                          style={{ flex: 1, padding: '9px', background: expandedTicketId === v.id ? '#1a1200' : '#0a1a0a', color: '#4caf50', border: '1px solid #2e7d32', borderRadius: '7px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', fontFamily: 'Arial' }}>
                          {expandedTicketId === v.id ? '▲ Close Ticket' : '✓ View / Re-print Ticket'}
                        </button>
                        {canRegen && (
                          <button
                            onClick={() => setRegenerateTarget(v)}
                            title="Voids this ticket and creates a new one"
                            style={{ padding: '9px 12px', background: '#1a1400', color: '#f59e0b', border: '1px solid #f59e0b', borderRadius: '7px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', fontFamily: 'Arial', whiteSpace: 'nowrap' }}>
                            ⟲ Regenerate
                          </button>
                        )}
                      </div>
                    )
                  }
                  return (
                    <button
                      onClick={() => expandedTicketId === v.id ? (setExpandedTicketId(null), setTicketTarget(null)) : openTicketFor(v)}
                      style={{ width: '100%', padding: '9px', background: expandedTicketId === v.id ? '#1a1200' : '#0f1620', color: '#C9A227', border: '1px solid #C9A227', borderRadius: '7px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', fontFamily: 'Arial' }}>
                      {expandedTicketId === v.id ? '▲ Close Ticket' : 'Generate Tow Ticket'}
                    </button>
                  )
                })()}

                {/* Stamped + non-voided rows → read-only view (Jose 2026-06-29:
                    closes the editable-stamped-ticket integrity hole). Fresh +
                    voided rows → the fresh-stamp form (existing behavior; voided
                    rows can't reach this branch because the row-action above
                    renders the disabled "Ticket Voided" pill instead of an
                    Open/Close button). */}
                {expandedTicketId === v.id && (
                  v.tow_ticket_generated && !v.voided_at
                    ? renderTicketReadOnlyView()
                    : renderTicketForm()
                )}
              </div>
            ))}
          </div>
        )}
        </>)}

        {driver?.company && (
          <div style={{ marginTop: 24 }}>
            <SupportContact role="driver" company={driver.company} />
          </div>
        )}

        <div style={{ textAlign: 'center', marginTop: '20px', paddingBottom: '20px' }}>
          <p style={{ color: '#2a2f3d', fontSize: '11px', margin: '0' }}>Powered by ShieldMyLot</p>
        </div>

        {/* Tow Ticket Regenerate Layer 2 — modal mount. Always-mounted-
            conditionally-rendered. Self-contained: handles its own form
            state + RPC call + every error path; parent only handles
            cancel + success (local-state updates in handleRegenerateSuccess). */}
        {regenerateTarget && (
          <RegenerateTicketModal
            target={{
              id:                regenerateTarget.id,
              plate:             regenerateTarget.plate,
              tow_storage_name:  regenerateTarget.tow_storage_name,
              tow_fee:           regenerateTarget.tow_fee,
            }}
            storageFacilities={storageFacilities.map(s => ({ id: s.id, name: s.name, address: s.address }))}
            onCancel={() => setRegenerateTarget(null)}
            onSuccess={handleRegenerateSuccess}
          />
        )}

      </div>

      {/* ── CAMERA MODAL ── */}
      {showCamera && (
        <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 9999, display: 'flex', flexDirection: 'column' }}>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

          {/* Video feed */}
          <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
            <video ref={videoRef} autoPlay playsInline muted
              style={{ width: '100%', height: '100%', objectFit: 'cover' }} />

            {/* Targeting box — boxShadow creates vignette outside the frame */}
            <div style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '82%', maxWidth: '340px', height: '90px',
              border: '2px solid #C9A227', borderRadius: '8px',
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.52)',
            }}>
              {/* Corner accents */}
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

          {/* Controls */}
          <div style={{ padding: '20px 20px 32px', background: '#0f1117' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', marginBottom: '6px', minHeight: '28px' }}>
              {scanning && (
                <div style={{ width: '18px', height: '18px', border: '2px solid #2a2f3d', borderTop: '2px solid #C9A227', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
              )}
              <p style={{ color: scanning ? '#C9A227' : '#aaa', fontSize: '13px', margin: 0, fontWeight: scanning ? 'bold' : 'normal' }}>
                {scanStatus}
              </p>
            </div>
            {!scanning && (
              <p style={{ color: '#444', fontSize: '11px', textAlign: 'center', margin: '0 0 16px', lineHeight: '1.6' }}>
                For best results: good lighting, hold steady, plate fills the targeting box
              </p>
            )}
            {scanning && <div style={{ height: '28px' }} />}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={closeCamera} disabled={scanning}
                style={{ flex: 1, padding: '14px', background: '#1e2535', color: '#aaa', border: '1px solid #3a4055', borderRadius: '10px', cursor: scanning ? 'not-allowed' : 'pointer', fontSize: '14px', fontFamily: 'Arial' }}>
                Cancel
              </button>
              <button onClick={captureAndScan} disabled={scanning}
                style={{ flex: 2, padding: '14px', background: scanning ? '#555' : '#C9A227', color: scanning ? '#888' : '#0f1117', fontWeight: 'bold', fontSize: '15px', border: 'none', borderRadius: '10px', cursor: scanning ? 'not-allowed' : 'pointer', fontFamily: 'Arial' }}>
                {scanning ? 'Reading...' : '📷 Capture'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* B71: decline-and-proceed interstitial. Opens via "Issue Violation"
          on an authorized scan result; on confirm, locks the chosen reason
          + note into pendingDecline and opens the existing violation form. */}
      {declineModal && (
        <DeclineReasonModal
          plate={plate}
          authorizedAs={declineModal.authorizedAs}
          authorizedDetail={declineModal.detail}
          onCancel={() => setDeclineModal(null)}
          onConfirm={(reason, note) => {
            setPendingDecline({ reason, note })
            setDeclineModal(null)
            setViolation(v => ({ ...v, property: selectedProperty }))
            setShowViolation(true)
          }}
        />
      )}
    </main>
  )
}

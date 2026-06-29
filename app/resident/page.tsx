'use client'
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../supabase'
import { logAudit } from '../lib/audit'
// B213 — Turnstile widget on the change-password re-auth call.
// signInWithPassword is captcha-gated when the Supabase toggle is ON;
// updateUser is NOT gated (authenticated call), so only the re-auth
// step needs the widget. The re-auth itself is deliberate security
// (current-password-required-to-change) — kept, not eliminated.
import { TurnstileWidget, type TurnstileHandle } from '../components/TurnstileWidget'
import SupportContact from '../components/SupportContact'
import { normalizePlate } from '../lib/plate'
import { TOWED_CAR_LOOKUP_URL } from '../lib/towed-car-lookup'
import { displayTowReason } from '../lib/tow-reasons'
import { getPlateLimitStatus, isAtLimit, parseLimitTriggerError, PlateLimitStatus } from '../lib/visitor-pass-limit'
// B66.5 commit 4.3: account-state gate (past_due banner + suspended/cancelled redirects).
import { evaluatePortalGate } from '../lib/portal-account-gate'
import PastDueBanner, { type PastDueBannerProps } from '../components/PastDueBanner'

// B210 (2026-06-24): RESIDENT_DISPUTES_ENABLED const + all resident
// dispute affordances removed. The resident→PM dispute flow is retired;
// the only remaining dispute concept is the CA manual status='disputed'
// flag on violations (B219). dispute_requests table intentionally left
// intact (historical data preservation; future cleanup).

export default function ResidentPortal() {
  const [resident, setResident] = useState<any>(null)
  const [vehicles, setVehicles] = useState<any[]>([])
  const [passes, setPasses] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // B66.5 commit 4.3: past_due banner state.
  const [pastDueBanner, setPastDueBanner] = useState<PastDueBannerProps | null>(null)
  const [activeTab, setActiveTab] = useState('info')
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<any>({})
  const [showVisitorForm, setShowVisitorForm] = useState(false)
  const [visitorForm, setVisitorForm] = useState({ plate: '', name: '', vehicle_desc: '', duration: '4' })
  const [limitStatus, setLimitStatus] = useState<PlateLimitStatus | null>(null)
  const [editingVehicleId, setEditingVehicleId] = useState<string | null>(null)
  const [editingVehicle, setEditingVehicle] = useState<any>({})
  const [showRequestForm, setShowRequestForm] = useState(false)
  const [newVehicle, setNewVehicle] = useState({ plate:'', state:'TX', make:'', model:'', year:'', color:'', space:'' })
  const [requestMsg, setRequestMsg] = useState('')
  // Space Requests v1 — resident's most-recent request (any status) +
  // submit modal state. Surfaces mirror the vehicle-decline card pattern.
  const [spaceRequest, setSpaceRequest] = useState<any>(null)
  const [showSpaceRequestModal, setShowSpaceRequestModal] = useState(false)
  const [spaceRequestNote, setSpaceRequestNote] = useState<string>('')
  const [spaceRequestSubmitting, setSpaceRequestSubmitting] = useState(false)
  const [spaceRequestError, setSpaceRequestError] = useState<string>('')
  const [passError, setPassError] = useState('')
  const [supportPhone, setSupportPhone] = useState('')
  const [supportEmail, setSupportEmail] = useState('')
  const [supportWebsite, setSupportWebsite] = useState('')
  const [propertyManager, setPropertyManager] = useState<{ name: string | null; email: string | null }>({ name: null, email: null })
  const [companyName, setCompanyName] = useState<string>('')
  // B213 — captcha state for the change-password re-auth step.
  const [changePwCaptchaToken, setChangePwCaptchaToken] = useState<string | null>(null)
  const changePwTurnstileRef = useRef<TurnstileHandle>(null)
  const [changePwForm, setChangePwForm] = useState({ current: '', newPw: '', confirmPw: '' })
  const [changePwMsg, setChangePwMsg] = useState('')
  const [changePwLoading, setChangePwLoading] = useState(false)
  const [myViolations, setMyViolations] = useState<any[]>([])
  // B210 (2026-06-24): myDisputes / disputingId / disputeForm /
  // disputeEvidence / submittingDispute / disputeMsg state removed

  useEffect(() => { loadResident() }, [])
  useEffect(() => {
    if (activeTab === 'myviol' && resident) fetchMyViolations()
  }, [activeTab, resident])
  useEffect(() => {
    setSupportPhone(localStorage.getItem('company_support_phone') || '')
    setSupportEmail(localStorage.getItem('company_support_email') || '')
    setSupportWebsite(localStorage.getItem('company_support_website') || '')
  }, [])

  // B19: per-plate concurrent-active limit lookup on plate change (400ms
  // debounce). Drives the badge under the plate input + the submit button
  // disabled state.
  useEffect(() => {
    if (!visitorForm.plate || !resident?.property) { setLimitStatus(null); return }
    let cancelled = false
    const timer = setTimeout(async () => {
      const result = await getPlateLimitStatus(resident.property, visitorForm.plate)
      if (!cancelled) setLimitStatus(result)
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [visitorForm.plate, resident?.property])

  async function loadResident() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { window.location.href = '/login'; return }

    const { data, error } = await supabase
      .from('residents')
      .select('*')
      .ilike('email', user.email!)
      .single()

    if (error || !data) {
      setLoading(false)
      setError('Your resident account was not found. Please contact your property manager.')
    } else {
      // B66.5 commit 4.3: account-state gate. Resident gets same gating
      // as other portals per Q6 lock (past_due banner + suspended/
      // cancelled redirect). data.company sourced from residents row.
      if (data.company) {
        // B66.5.1: pass role for role-gated CTA rendering in PastDueBanner.
        const gateResult = await evaluatePortalGate(data.company, 'resident')
        if (gateResult.redirected) return
        if (gateResult.pastDueBanner) setPastDueBanner(gateResult.pastDueBanner)
      }
      setLoading(false)
      setResident(data)
      setEditForm(data)
      fetchVehicles(data.unit, data.property, data.email)
      fetchPasses(data.unit)
      fetchSpaceRequest(data.email)
      if (data.property) {
        const { data: prop } = await supabase
          .from('properties')
          .select('pm_name, pm_email')
          .ilike('name', data.property)
          .single()
        if (prop) setPropertyManager({ name: prop.pm_name || null, email: prop.pm_email || null })
      }
      setCompanyName(data.company || localStorage.getItem('company_name') || '')
    }
  }

  async function fetchVehicles(unit: string, property: string, email: string) {
    // B150 + B202: the original B150 filter `.eq('is_active', true)`
    // silently swept up declined vehicles too (declineVehicle in the
    // manager portal sets is_active=false alongside status='declined'),
    // so the resident never saw the manager-note card OR the Mark-as-Read
    // affordance for their own declined requests. B202 restores them
    // without re-opening B150's move-out leak.
    //
    // Server fetch: loose .or() with CONSTANT strings only — no email
    // interpolation. PostgREST .or() is a comma/paren/dot-tokenized
    // grammar; interpolating a value with dots (every email has them),
    // commas (rare but real), or parens (rare) can alter parse or break
    // the filter. ILIKE wildcards `_` and `%` also appear in real emails
    // (e.g. user_test@example.com) — interpolating would re-open the
    // A2-class wildcard surface inside the filter string. Avoid both.
    //
    // Client filter: lowercased exact equality on resident_email scopes
    // the declined-row branch to the CURRENT resident's ownership. A
    // prior tenant's declined vehicle at the same (property, unit) won't
    // match because its resident_email belongs to the prior tenant.
    // Preserves B150's intent end-to-end.
    const { data } = await supabase
      .from('vehicles')
      .select('*')
      .ilike('unit', unit)
      .ilike('property', property)
      .or('is_active.eq.true,status.eq.declined')
    const emailLower = email.toLowerCase()
    const vehs = (data || []).filter((v: any) =>
      v.is_active === true ||
      (v.status === 'declined' &&
       (v.resident_email ?? '').toLowerCase() === emailLower)
    )
    const spaceNumbers = vehs.map((v: any) => v.space).filter(Boolean)
    if (spaceNumbers.length > 0) {
      const { data: spaceData } = await supabase
        .from('spaces').select('space_number, location_notes')
        .ilike('property', property).in('space_number', spaceNumbers)
      const notesMap: Record<string, string> = {}
      ;(spaceData || []).forEach((s: any) => { if (s.location_notes) notesMap[s.space_number] = s.location_notes })
      setVehicles(vehs.map((v: any) => ({ ...v, _space_notes: notesMap[v.space] || null })))
    } else {
      setVehicles(vehs)
    }
  }

  async function fetchPasses(unit: string) {
    const now = new Date().toISOString()
    const { data } = await supabase
      .from('visitor_passes')
      .select('*')
      .ilike('visiting_unit', unit)
      .gte('expires_at', now)
      .order('created_at', { ascending: false })
    setPasses(data || [])
  }

  async function fetchMyViolations() {
    const plates = vehicles.map((v: any) => normalizePlate(v.plate)).filter(Boolean)
    if (plates.length === 0) { setMyViolations([]); return }
    // B175 — residents do NOT see voided violations. Nothing for them
    // to act on (no fee, no dispute, no portal interaction). Manager
    // / admin / driver lists keep voided rows visible+marked for
    // forensic clarity; resident view hides them entirely.
    const { data } = await supabase.from('violations')
      .select('*, photo_rows:violation_photos(id, photo_url, removed_at), video_rows:violation_videos(id, video_url, removed_at)')
      .eq('is_confirmed', true)
      .is('voided_at', null)
      .in('plate', plates)
      .order('created_at', { ascending: false })
    // B13/B18 Commit A: flatten photo_rows → v.photos string[] filtered
    // by removed_at IS NULL, matching the legacy column's shape readers expect.
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
    setMyViolations(flattened)
  }

  // B210 (2026-06-24): fetchMyDisputes + submitDispute removed (resident
  // dispute flow retired; only the CA-side status='disputed' flag remains
  // — disputes are handled legally off-system).

  async function changePassword() {
    setChangePwMsg('')
    if (changePwForm.newPw.length < 8) { setChangePwMsg('New password must be at least 8 characters.'); return }
    if (changePwForm.newPw !== changePwForm.confirmPw) { setChangePwMsg('Passwords do not match.'); return }
    // B213 — explicit captcha guard before re-auth (signInWithPassword
    // is captcha-gated when toggle ON). updateUser below is NOT gated
    // (authenticated call), so only the re-auth step needs the token.
    if (!changePwCaptchaToken) {
      setChangePwMsg('Please complete the CAPTCHA challenge below before saving.')
      return
    }
    setChangePwLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    // B213 — threading captchaToken into the re-auth call. Toggle OFF →
    // ignored; toggle ON → required.
    const { error: reAuthErr } = await supabase.auth.signInWithPassword({
      email: user?.email || '',
      password: changePwForm.current,
      options: { captchaToken: changePwCaptchaToken },
    })
    if (reAuthErr) {
      // B213 — single-use token; reset on any failure (wrong current pw
      // OR captcha rejection both surface as reAuthErr) so the user can
      // re-challenge without reloading.
      changePwTurnstileRef.current?.reset()
      setChangePwCaptchaToken(null)
      setChangePwMsg('Current password is incorrect.')
      setChangePwLoading(false)
      return
    }
    // updateUser stays bare — already-authenticated, NOT captcha-gated.
    const { error: updateErr } = await supabase.auth.updateUser({ password: changePwForm.newPw })
    setChangePwLoading(false)
    if (updateErr) { setChangePwMsg(updateErr.message); return }
    setChangePwMsg('Password changed successfully.')
    setChangePwForm({ current: '', newPw: '', confirmPw: '' })
    // B213 — clear the now-consumed captcha state on success. The widget
    // will re-render fresh if the user opens the change-password form
    // again.
    changePwTurnstileRef.current?.reset()
    setChangePwCaptchaToken(null)
  }

  async function saveResident() {
    const { error } = await supabase
      .from('residents')
      .update({
        name: editForm.name,
        phone: editForm.phone,
        email: editForm.email,
      })
      .eq('id', resident.id)
    if (error) {
      alert('Error saving: ' + error.message)
    } else {
      setResident(editForm)
      setEditing(false)
      alert('Profile updated!')
    }
  }

  async function saveVehicle() {
    // B90 v2 — DEFINER RPC replaces the direct .update() path. The
    // resident_update_vehicles RLS policy was DROPped; this RPC is the
    // only resident-write path on vehicles. Signature pins the 5
    // allowlist columns (state/make/model/year/color); any other
    // column is structurally unreachable from the resident lane.
    // Crafted REST PATCH attempts return permission denied (no UPDATE
    // policy for resident role).
    const yearAsInt = editingVehicle.year
      ? parseInt(String(editingVehicle.year), 10)
      : null
    const { error } = await supabase.rpc('update_my_vehicle_cosmetic', {
      p_id:    editingVehicle.id,
      p_state: editingVehicle.state,
      p_make:  editingVehicle.make,
      p_model: editingVehicle.model,
      p_year:  yearAsInt,
      p_color: editingVehicle.color,
    })
    if (error) { alert('Error: ' + error.message) }
    else {
      await logAudit({
        action: 'RESIDENT_EDIT_VEHICLE',
        table_name: 'vehicles',
        record_id: editingVehicle.id,
        new_values: {
          state: editingVehicle.state,
          color: editingVehicle.color,
          make: editingVehicle.make,
          model: editingVehicle.model,
          year: editingVehicle.year,
        },
      })
      setEditingVehicleId(null); fetchVehicles(resident.unit, resident.property, resident.email)
    }
  }

  async function requestVehicle() {
    if (!newVehicle.plate) { alert('Plate is required'); return }
    const normalizedPlate = normalizePlate(newVehicle.plate)
    // Deactivation arc — DEFINER RPC replaces the direct .insert() path.
    // The resident_insert_vehicles RLS policy was DROPped; this RPC is
    // the only resident write path for vehicle requests. Body guards:
    //   • caller is effectively active (helper checks the full chain:
    //     user_roles.is_active + companies.account_state +
    //     residents.is_active + properties.is_active)
    //   • caller is a resident
    //   • property + unit derived from residents row (not caller-supplied)
    // Mirrors B90 v2's update_my_vehicle_cosmetic + B197 manager Add
    // Resident pattern. Crafted REST PATCH attempts now return
    // permission-denied (no INSERT policy for resident role).
    const yearAsInt = newVehicle.year ? parseInt(String(newVehicle.year), 10) : null
    const { error } = await supabase.rpc('request_my_vehicle', {
      p_plate: normalizedPlate,
      p_state: newVehicle.state,
      p_make:  newVehicle.make.trim() || null,
      p_model: newVehicle.model.trim() || null,
      p_year:  yearAsInt,
      p_color: newVehicle.color.trim() || null,
    })
    if (error) {
      // Surface deactivation-class errors with the helper's HINT —
      // gives the resident the right escalation path ("contact PM").
      // Other errors (validation, network) get the raw message.
      const msg = error.message || 'Error'
      if (msg.includes('account_deactivated')) {
        alert('Your account is deactivated. Contact your property manager to be reactivated before submitting a vehicle.')
      } else {
        alert('Error: ' + msg)
      }
    } else {
      await logAudit({ action: 'REQUEST_VEHICLE', table_name: 'vehicles', new_values: { plate: normalizedPlate, make: newVehicle.make, model: newVehicle.model, unit: resident.unit, property: resident.property } })
      setRequestMsg('Vehicle submitted for Property Manager approval. You will see the status update here.')
      setShowRequestForm(false)
      setNewVehicle({ plate:'', state:'TX', make:'', model:'', year:'', color:'', space:'' })
      fetchVehicles(resident.unit, resident.property, resident.email)
    }
  }

  async function markDeclinedRead(id: string) {
    // B90 v2 — DEFINER RPC replaces the direct .update() path here too.
    // The resident_update_vehicles RLS policy was DROPped; this RPC is
    // the only path by which a resident can flip resident_read=TRUE on
    // a vehicle they own. Ownership guard mirrors update_my_vehicle_cosmetic.
    await supabase.rpc('mark_my_vehicle_declined_read', { p_id: id })
    fetchVehicles(resident.unit, resident.property, resident.email)
  }

  // Space Requests v1 — fetch resident's most-recent request (any
  // status). RLS scopes to lower(resident_email)=lower(JWT.email) so
  // we get only this resident's rows. ORDER BY requested_at DESC LIMIT 1
  // because the partial UNIQUE allows at most one pending; plus
  // historical approved/declined rows. We only need the latest to
  // drive the surface (pill / dismissible card / submit-button-hidden).
  async function fetchSpaceRequest(email: string) {
    const { data, error } = await supabase
      .from('space_requests')
      .select('*')
      .ilike('resident_email', email)
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!error) setSpaceRequest(data || null)
  }

  async function submitSpaceRequest() {
    if (!resident?.property || spaceRequestSubmitting) return
    setSpaceRequestSubmitting(true)
    setSpaceRequestError('')
    const trimmed = spaceRequestNote.trim()
    const noteToSend = trimmed.length > 0 ? trimmed : null
    const { data, error } = await supabase.rpc('submit_space_request', {
      p_property: resident.property,
      p_note:     noteToSend,
    })
    setSpaceRequestSubmitting(false)
    if (error) {
      // Partial UNIQUE collision surfaces as a 23505 from postgres OR
      // as a friendly 'pending_request_exists' from the RPC's pre-check
      // (RPC catches it first; this branch is the belt-and-suspenders).
      const isPendingDup = /pending_request_exists|duplicate key|unique/i.test(error.message)
      setSpaceRequestError(isPendingDup
        ? 'You already have a pending space request. Wait for a decision before submitting another.'
        : `Submit failed: ${error.message}`)
      return
    }
    const result = data as { ok?: boolean; error?: string; hint?: string }
    if (!result?.ok) {
      const isPendingDup = result?.error === 'pending_request_exists'
      setSpaceRequestError(isPendingDup
        ? (result?.hint || 'You already have a pending space request.')
        : `Submit failed: ${result?.error || 'unknown error'}`)
      return
    }
    // Success: close modal, clear form, reload
    setShowSpaceRequestModal(false)
    setSpaceRequestNote('')
    fetchSpaceRequest(resident.email)
  }

  async function markSpaceRequestRead(id: number) {
    await supabase.rpc('mark_my_space_request_decision_read', { p_request_id: id })
    if (resident?.email) fetchSpaceRequest(resident.email)
  }

  async function issueVisitorPass() {
    if (!visitorForm.plate || !resident) return
    setPassError('')
    const plate = normalizePlate(visitorForm.plate)
    // B19: per-plate-concurrent-active enforcement runs in the DB trigger
    // (enforce_visitor_pass_limit). The previous yearly client-side check
    // was using the same column with different semantics; removed so both
    // surfaces and the trigger agree on one policy. Submit-time errors
    // are caught below via parseLimitTriggerError.

    const expires = new Date()
    expires.setHours(expires.getHours() + parseInt(visitorForm.duration))
    const { error } = await supabase
      .from('visitor_passes')
      .insert([{
        plate,
        visitor_name: visitorForm.name,
        visiting_unit: resident.unit,
        property: resident.property,
        vehicle_desc: visitorForm.vehicle_desc,
        duration_hours: parseInt(visitorForm.duration),
        created_at: new Date().toISOString(),
        expires_at: expires.toISOString(),
        is_active: true
      }])
    if (error) {
      const friendly = parseLimitTriggerError(error)
      if (friendly) {
        setPassError(friendly)
      } else {
        alert('Error: ' + error.message)
      }
      return
    }
    await logAudit({ action: 'ISSUE_VISITOR_PASS', table_name: 'visitor_passes', new_values: { plate, visiting_unit: resident.unit, duration_hours: parseInt(visitorForm.duration) } })
    alert('Visitor pass issued!')
    setShowVisitorForm(false)
    setVisitorForm({ plate: '', name: '', vehicle_desc: '', duration: '4' })
    fetchPasses(resident.unit)
  }

  const tabStyle = (tab: string) => ({
    flex: 1, padding: '9px', border: 'none', borderRadius: '6px',
    cursor: 'pointer', fontWeight: 'bold' as const, fontSize: '12px',
    background: activeTab === tab ? '#C9A227' : '#1e2535',
    color: activeTab === tab ? '#0f1117' : '#888',
    fontFamily: 'Arial, sans-serif'
  })

  if (loading) return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif' }}>
      <p style={{ color:'#888' }}>Loading...</p>
    </main>
  )

  if (error || !resident) return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ textAlign:'center' }}>
        <p style={{ color:'#f44336', fontSize:'14px', marginBottom:'16px' }}>{error || 'Account not found.'}</p>
        <a href="/login" style={{ color:'#C9A227', fontSize:'13px', textDecoration:'none' }}>← Back to Login</a>
      </div>
    </main>
  )

  if (resident.status === 'pending') return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'420px', width:'100%' }}>
        <div style={{ background:'#1a1400', border:'1px solid #a16207', borderRadius:'16px', padding:'32px', textAlign:'center' }}>
          <div style={{ fontSize:'40px', marginBottom:'16px' }}>⏳</div>
          <p style={{ color:'#fbbf24', fontWeight:'bold', fontSize:'18px', margin:'0 0 12px' }}>Registration Pending</p>
          <p style={{ color:'#aaa', fontSize:'14px', lineHeight:'1.7', margin:'0 0 20px' }}>
            Your registration is pending approval from your property manager.
            You will be notified once your account is approved.
          </p>
          <div style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', textAlign:'left' }}>
            <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 8px' }}>Submitted Info</p>
            {[['Name', resident.name], ['Email', resident.email], ['Unit', resident.unit], ['Property', resident.property]].filter(([,v]) => v).map(([k,v]) => (
              <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', borderBottom:'1px solid #1e2535' }}>
                <span style={{ color:'#555', fontSize:'12px' }}>{k}</span>
                <span style={{ color:'#aaa', fontSize:'12px' }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
        <button onClick={async () => { await supabase.auth.signOut(); window.location.href = '/login' }}
          style={{ width:'100%', marginTop:'16px', padding:'12px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontSize:'13px', fontFamily:'Arial' }}>
          Sign Out
        </button>
      </div>
    </main>
  )

  if (resident.status === 'declined') return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'420px', width:'100%' }}>
        <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'16px', padding:'32px', textAlign:'center' }}>
          <div style={{ fontSize:'40px', marginBottom:'16px' }}>✕</div>
          <p style={{ color:'#f44336', fontWeight:'bold', fontSize:'18px', margin:'0 0 12px' }}>Registration Not Approved</p>
          <p style={{ color:'#aaa', fontSize:'14px', lineHeight:'1.7', margin:'0 0 12px' }}>
            Your registration was not approved. Please contact your property manager for more information.
          </p>
          {resident.manager_note && (
            <div style={{ background:'#0f1117', border:'1px solid #3a4055', borderRadius:'8px', padding:'12px', marginBottom:'12px', textAlign:'left' }}>
              <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', margin:'0 0 6px' }}>Manager Note</p>
              <p style={{ color:'#f44336', fontSize:'13px', margin:'0' }}>{resident.manager_note}</p>
            </div>
          )}
          {resident.property && <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>Property: {resident.property}</p>}
        </div>
        <button onClick={async () => { await supabase.auth.signOut(); window.location.href = '/login' }}
          style={{ width:'100%', marginTop:'16px', padding:'12px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontSize:'13px', fontFamily:'Arial' }}>
          Sign Out
        </button>
      </div>
    </main>
  )

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      {/* Desktop responsive Wave 2 (2026-06-26): swap inline
          maxWidth:500px+margin:auto for .reading-container (640px cap).
          Deliberate divergence from CA/manager which use .portal-container
          (1280px desktop): residents on desktop don't benefit from
          1280px of tiles — their UI is forms + cards + status surfaces
          that read better at a comfortable measure. The .reading-
          container caps at 640px even on a 4K monitor; the per-resident
          experience stays focused. */}
      <div className="reading-container">

        {/* B66.5 commit 4.3: past_due banner */}
        {pastDueBanner && <PastDueBanner {...pastDueBanner} />}

        <div style={{ marginBottom:'20px', textAlign:'center' }}>
          <h1 style={{ color:'#C9A227', fontSize:'22px', fontWeight:'bold', margin:'0' }}>{companyName || 'ShieldMyLot'}</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'4px 0 0' }}>Resident Portal</p>
        </div>

        {/* Space Request status surface — mirrors the vehicle-decline
            dismissible-card pattern. Three states:
              - pending: amber pill
              - approved + !resident_read: green dismissible card with assigned space
              - declined + !resident_read: red dismissible card with optional reason
            All other states (approved/declined + resident_read=true): no surface
            (the persistent state is the space-assignment itself or the
            absence of one; the card is a one-time decision acknowledgement). */}
        {spaceRequest && spaceRequest.status === 'pending' && (
          <div style={{ background:'#3a2e0a', border:'1px solid #a16207', borderRadius:'10px', padding:'10px 14px', marginBottom:'12px', display:'flex', alignItems:'center', gap:'10px' }}>
            <span style={{ color:'#fbbf24', fontSize:'14px' }}>⏳</span>
            <p style={{ color:'#fde68a', fontSize:'12px', margin:'0' }}>Space request pending review</p>
          </div>
        )}
        {spaceRequest && spaceRequest.status === 'approved' && !spaceRequest.resident_read && (
          <div style={{ background:'#0a2e0a', border:'1px solid #2e7d32', borderRadius:'10px', padding:'14px 16px', marginBottom:'12px' }}>
            <p style={{ color:'#a5d6a7', fontWeight:'bold', fontSize:'13px', margin:'0 0 6px' }}>✓ Space Request Approved</p>
            <p style={{ color:'#e8f5e9', fontSize:'12px', margin:'0 0 10px', lineHeight:'1.5' }}>
              Your assigned space: <span style={{ color:'#C9A227', fontWeight:'bold', fontFamily:'Courier New' }}>(updated — see Assigned Space below)</span>
            </p>
            <button onClick={() => markSpaceRequestRead(spaceRequest.id)}
              style={{ width:'100%', padding:'7px', background:'#0a1a0a', color:'#a5d6a7', border:'1px solid #2e7d32', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial' }}>
              Mark as Read
            </button>
          </div>
        )}
        {spaceRequest && spaceRequest.status === 'declined' && !spaceRequest.resident_read && (
          <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'10px', padding:'14px 16px', marginBottom:'12px' }}>
            <p style={{ color:'#f44336', fontWeight:'bold', fontSize:'13px', margin:'0 0 6px' }}>Space Request Declined</p>
            {spaceRequest.decline_reason && (
              <div style={{ background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}>
                <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 3px' }}>Manager Note</p>
                <p style={{ color:'#aaa', fontSize:'12px', margin:'0' }}>{spaceRequest.decline_reason}</p>
              </div>
            )}
            <button onClick={() => markSpaceRequestRead(spaceRequest.id)}
              style={{ width:'100%', padding:'7px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial' }}>
              Mark as Read
            </button>
          </div>
        )}

        {/* Welcome bar */}
        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px 16px', marginBottom:'16px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0' }}>{resident.name}</p>
            <p style={{ color:'#aaa', fontSize:'12px', margin:'4px 0 0' }}>{resident.unit} · {resident.property}</p>
          </div>
          <div style={{ textAlign:'right' }}>
            <p style={{ color:'#555', fontSize:'11px', margin:'0' }}>Assigned Space</p>
            <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'18px', margin:'2px 0 0', fontFamily:'Courier New' }}>{resident.space || '—'}</p>
            {/* Request a Space affordance — surfaces when no pending
                request exists. Hidden when pending pill is visible
                above (one action at a time; pending = wait for decision). */}
            {(!spaceRequest || spaceRequest.status !== 'pending') && (
              <button onClick={() => { setSpaceRequestNote(''); setSpaceRequestError(''); setShowSpaceRequestModal(true) }}
                style={{ marginTop:'8px', padding:'5px 10px', background:'transparent', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'10px', fontWeight:'bold', fontFamily:'Arial' }}>
                + Request a Space
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'16px' }}>
          <button style={tabStyle('info')} onClick={() => setActiveTab('info')}>My Info</button>
          <button style={tabStyle('vehicles')} onClick={() => setActiveTab('vehicles')}>
            Vehicles{(() => {
              const hasUnreadDeclined = vehicles.some(v => v.status === 'declined' && !v.resident_read)
              const hasPending = vehicles.some(v => v.status === 'pending')
              if (!hasUnreadDeclined && !hasPending) return null
              const count = hasUnreadDeclined
                ? vehicles.filter(v => v.status === 'declined' && !v.resident_read).length
                : vehicles.filter(v => v.status === 'pending').length
              return <span style={{ background: hasUnreadDeclined ? '#B71C1C' : '#a16207', color:'white', borderRadius:'10px', fontSize:'9px', padding:'1px 6px', marginLeft:'4px', fontWeight:'bold' }}>{count}</span>
            })()}
          </button>
          <button style={tabStyle('myviol')} onClick={() => setActiveTab('myviol')}>
            Violations{/* B210 (2026-06-24): pending-dispute count badge removed */}
          </button>
          <button style={tabStyle('visitors')} onClick={() => setActiveTab('visitors')}>Visitors</button>
        </div>

        {/* MY INFO TAB */}
        {activeTab === 'info' && (
          <>
          <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'14px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0' }}>Personal Information</p>
              <button
                onClick={() => setEditing(!editing)}
                style={{ padding:'5px 12px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontFamily:'Arial' }}
              >
                {editing ? 'Cancel' : 'Edit'}
              </button>
            </div>

            {editing ? (
              <>
                <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Full Name</label>
                <input value={editForm.name || ''} onChange={e => setEditForm({...editForm, name: e.target.value})}
                  style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'12px', padding:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px', boxSizing:'border-box' }} />
                <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Phone</label>
                <input value={editForm.phone || ''} onChange={e => setEditForm({...editForm, phone: e.target.value})}
                  style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'12px', padding:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px', boxSizing:'border-box' }} />
                <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Email</label>
                <input value={editForm.email || ''} onChange={e => setEditForm({...editForm, email: e.target.value})}
                  style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'14px', padding:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px', boxSizing:'border-box' }} />
                <button onClick={saveResident}
                  style={{ width:'100%', padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>
                  Save Changes
                </button>
              </>
            ) : (
              <>
                {[
                  { label: 'Full Name', value: resident.name },
                  { label: 'Email', value: resident.email },
                  { label: 'Phone', value: resident.phone || '—' },
                  { label: 'Unit', value: resident.unit },
                  { label: 'Property', value: resident.property },
                  { label: 'Assigned Space', value: resident.space || '—' },
                  { label: 'Lease End', value: resident.lease_end ? new Date(resident.lease_end).toLocaleDateString() : '—' },
                ].map((item, i) => (
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid #1e2535' }}>
                    <span style={{ color:'#555', fontSize:'12px' }}>{item.label}</span>
                    <span style={{ color:'#aaa', fontSize:'12px', fontWeight:'500' }}>{item.value}</span>
                  </div>
                ))}
              </>
            )}
          </div>

          <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginTop:'12px' }}>
            <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0 0 14px' }}>Change My Password</p>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Current Password</label>
            <input type="password" value={changePwForm.current} onChange={e => setChangePwForm(f => ({...f, current: e.target.value}))}
              placeholder="••••••••"
              style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'10px', padding:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px', boxSizing:'border-box' }} />
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>New Password (min 8 characters)</label>
            <input type="password" value={changePwForm.newPw} onChange={e => setChangePwForm(f => ({...f, newPw: e.target.value}))}
              placeholder="••••••••"
              style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'10px', padding:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px', boxSizing:'border-box' }} />
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Confirm New Password</label>
            <input type="password" value={changePwForm.confirmPw} onChange={e => setChangePwForm(f => ({...f, confirmPw: e.target.value}))}
              placeholder="••••••••"
              style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'12px', padding:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px', boxSizing:'border-box' }} />
            {changePwMsg && (
              <p style={{ color: changePwMsg.includes('success') ? '#4caf50' : '#f44336', fontSize:'12px', margin:'0 0 10px' }}>{changePwMsg}</p>
            )}
            {/* B213 — Turnstile widget for the re-auth captcha gate.
                Mounts inline above Update Password; user must complete
                the challenge before the button enables. Managed mode
                usually resolves invisibly. */}
            <div style={{ marginBottom: 10 }}>
              <TurnstileWidget ref={changePwTurnstileRef}
                               onVerify={setChangePwCaptchaToken}
                               onExpire={() => setChangePwCaptchaToken(null)}
                               onError={() => setChangePwCaptchaToken(null)} />
            </div>
            <button onClick={changePassword} disabled={changePwLoading || !changePwForm.current || !changePwForm.newPw || !changePwForm.confirmPw || !changePwCaptchaToken}
              style={{ width:'100%', padding:'11px', background:(!changePwForm.current || !changePwForm.newPw || !changePwForm.confirmPw || !changePwCaptchaToken) ? '#555' : '#C9A227', color:(!changePwForm.current || !changePwForm.newPw || !changePwForm.confirmPw || !changePwCaptchaToken) ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:(!changePwForm.current || !changePwForm.newPw || !changePwForm.confirmPw || !changePwCaptchaToken) ? 'not-allowed' : 'pointer' }}>
              {changePwLoading ? 'Saving...' : 'Update Password'}
            </button>
          </div>
          </>
        )}

        {/* VEHICLES TAB */}
        {activeTab === 'vehicles' && (
          <div>
            {(() => {
              const inp: React.CSSProperties = { display:'block', width:'100%', marginTop:'6px', marginBottom:'10px', padding:'9px 10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'12px', boxSizing:'border-box', outline:'none' }
              const lbl: React.CSSProperties = { color:'#aaa', fontSize:'10px', textTransform:'uppercase' as const, letterSpacing:'0.08em' }
              const states = ['TX','AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','UT','VT','VA','WA','WV','WI','WY']

              function statusBadge(v: any) {
                if (v.status === 'pending') return { bg:'#2a1e00', color:'#C9A227', border:'#C9A227', text:'Pending Approval' }
                if (v.status === 'declined') return { bg:'#3a1a1a', color:'#f44336', border:'#b71c1c', text:'Declined' }
                if (v.is_active === true) return { bg:'#1a3a1a', color:'#4caf50', border:'#2e7d32', text:'Active' }
                return { bg:'#1e2535', color:'#555', border:'#3a4055', text:'Inactive' }
              }

              return (
                <>
                  {/* B36 (2026-05-19): replaced the restrictive "at initial registration"
                      message with an enabling prompt. By the time the portal renders the
                      My Vehicles tab, registration is already complete (pending/declined
                      branches early-return upstream), so the old text was vestigial copy
                      from the /register flow that doesn't apply here. Residents post-
                      registration CAN add more vehicles via the "+ Request New Vehicle"
                      button below; the message now points them at it instead of misleading
                      them into thinking they can't add more. */}
                  {vehicles.filter(v => v.status === 'active' || v.status === 'pending').length >= 2 && (
                    <p style={{ color:'#888', fontSize:'12px', margin:'0 0 12px', lineHeight:'1.6' }}>
                      To add more vehicles, use the &quot;+ Request New Vehicle&quot; button below. Your property manager will review and approve.
                    </p>
                  )}
                  <button onClick={() => { setShowRequestForm(s => !s); setRequestMsg('') }}
                    style={{ width:'100%', padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', marginBottom:'12px' }}>
                    + Request New Vehicle
                  </button>

                  {showRequestForm && (
                    <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                      <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Vehicle Request</p>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                        <div style={{ gridColumn:'span 2' }}>
                          <label style={lbl}>Plate *</label>
                          <input value={newVehicle.plate} onChange={e => setNewVehicle({...newVehicle, plate: normalizePlate(e.target.value)})} placeholder="ABC1234" style={{ ...inp, fontFamily:'Courier New', fontSize:'16px', fontWeight:'bold', textAlign:'center' }} />
                        </div>
                        <div>
                          <label style={lbl}>State</label>
                          <select value={newVehicle.state} onChange={e => setNewVehicle({...newVehicle, state: e.target.value})} style={inp}>
                            {states.map(s => <option key={s}>{s}</option>)}
                          </select>
                        </div>
                        <div><label style={lbl}>Color</label><input value={newVehicle.color} onChange={e => setNewVehicle({...newVehicle, color: e.target.value})} placeholder="Black" style={inp} /></div>
                        <div><label style={lbl}>Make</label><input value={newVehicle.make} onChange={e => setNewVehicle({...newVehicle, make: e.target.value})} placeholder="Toyota" style={inp} /></div>
                        <div><label style={lbl}>Model</label><input value={newVehicle.model} onChange={e => setNewVehicle({...newVehicle, model: e.target.value})} placeholder="Camry" style={inp} /></div>
                        <div><label style={lbl}>Year</label><input value={newVehicle.year} onChange={e => setNewVehicle({...newVehicle, year: e.target.value})} placeholder="2022" style={inp} /></div>
                      </div>
                      <div style={{ display:'flex', gap:'8px' }}>
                        <button onClick={requestVehicle} style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>Submit Request</button>
                        <button onClick={() => setShowRequestForm(false)} style={{ padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                      </div>
                    </div>
                  )}

                  {requestMsg && (
                    <div style={{ background:'#1a2a1a', border:'1px solid #2e7d32', borderRadius:'8px', padding:'10px 12px', marginBottom:'12px' }}>
                      <p style={{ color:'#4caf50', fontSize:'12px', margin:'0', lineHeight:'1.5' }}>{requestMsg}</p>
                    </div>
                  )}

                  {vehicles.length === 0 && !requestMsg && (
                    <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                      <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No vehicles registered yet.</p>
                    </div>
                  )}

                  {vehicles.map((v) => {
                    const badge = statusBadge(v)
                    const isEditing = editingVehicleId === v.id
                    return (
                      <div key={v.id} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', marginBottom:'10px', overflow:'hidden' }}>
                        <div style={{ padding:'16px' }}>
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'10px' }}>
                            <p style={{ color:'white', fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                            <span style={{ background:badge.bg, color:badge.color, border:`1px solid ${badge.border}`, padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold' }}>{badge.text}</span>
                          </div>
                          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px', fontSize:'12px', marginBottom:'10px' }}>
                            <div><span style={{ color:'#555' }}>Vehicle</span><br/><span style={{ color:'#aaa' }}>{[v.color, v.make, v.model, v.year].filter(Boolean).join(' ') || '—'}</span></div>
                            <div><span style={{ color:'#555' }}>Space</span><br/><span style={{ color:'#aaa' }}>{v.space || '—'}</span>{v._space_notes && <span style={{ color:'#555', fontSize:'10px' }}> · {v._space_notes}</span>}</div>
                            <div><span style={{ color:'#555' }}>State</span><br/><span style={{ color:'#aaa' }}>{v.state || '—'}</span></div>
                            <div><span style={{ color:'#555' }}>Permit Expiry</span><br/><span style={{ color:'#aaa' }}>{v.permit_expiry ? new Date(v.permit_expiry).toLocaleDateString() : '—'}</span></div>
                          </div>
                          {(v.status === 'pending' || v.status === 'declined') && v.manager_note && (
                            <div style={{ background: v.status === 'declined' ? '#3a1a1a' : '#1e2535', border:`1px solid ${v.status === 'declined' ? '#b71c1c' : '#3a4055'}`, borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}>
                              <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 3px' }}>Manager Note</p>
                              <p style={{ color: v.status === 'declined' ? '#f44336' : '#aaa', fontSize:'12px', margin:'0' }}>{v.manager_note}</p>
                            </div>
                          )}
                          {v.status === 'declined' && !v.resident_read && (
                            <button onClick={() => markDeclinedRead(v.id)}
                              style={{ width:'100%', padding:'7px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial', marginBottom:'8px' }}>
                              Mark as Read
                            </button>
                          )}
                          {/* B90 — Edit is intentionally hidden on declined vehicles.
                              Editing cosmetic fields (color/make/model/year/state) on a
                              declined vehicle doesn't address the decline reason; the
                              resident's recourse is to request a new vehicle through
                              the "+ Request New Vehicle" flow with the corrected info,
                              which routes through manager approval cleanly. The server-
                              side write guard at the BEFORE UPDATE trigger
                              (enforce_resident_vehicle_cosmetic_only_trigger) prevents
                              a crafted REST PATCH from flipping status:'declined' →
                              'pending', which is the workflow-bypass half of B90. */}
                          {v.status !== 'declined' && (
                            <button onClick={() => { setEditingVehicleId(isEditing ? null : v.id); setEditingVehicle({...v}) }}
                              style={{ width:'100%', padding:'7px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial' }}>
                              {isEditing ? 'Cancel Edit' : 'Edit'}
                            </button>
                          )}
                        </div>

                        <div style={{ paddingBottom:'4px' }}>
                          <a href={TOWED_CAR_LOOKUP_URL} target="_blank" rel="noopener noreferrer"
                            style={{ color:'#C9A227', fontSize:'11px', textDecoration:'underline', padding:'4px 0', display:'inline-block' }}>
                            🔍 Search FindMyTowedCar.org
                          </a>
                        </div>

                        {isEditing && (() => {
                          // Plate / unit / space are display-only per B9 spec.
                          // To change plate: add a new vehicle (goes through
                          // manager approval). To change unit/space: contact
                          // your property manager.
                          const lockedInp: React.CSSProperties = { ...inp, background:'#0a0d14', color:'#666', cursor:'not-allowed' }
                          const helperTxt: React.CSSProperties = { color:'#555', fontSize:'10px', margin:'2px 0 8px', lineHeight:'1.4' }
                          return (
                            <div style={{ background:'#0f1117', borderTop:'1px solid #2a2f3d', padding:'16px' }}>
                              <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', margin:'0 0 12px' }}>Edit Vehicle</p>
                              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                                <div style={{ gridColumn:'span 2' }}>
                                  <label style={lbl}>Plate</label>
                                  <input value={editingVehicle.plate || ''} disabled readOnly style={{ ...lockedInp, fontFamily:'Courier New', fontSize:'16px', fontWeight:'bold', textAlign:'center' }} />
                                  <p style={helperTxt}>To change your plate, add a new vehicle (manager will review).</p>
                                </div>
                                <div>
                                  <label style={lbl}>State</label>
                                  <select value={editingVehicle.state || 'TX'} onChange={e => setEditingVehicle({...editingVehicle, state: e.target.value})} style={inp}>
                                    {states.map(s => <option key={s}>{s}</option>)}
                                  </select>
                                </div>
                                <div><label style={lbl}>Color</label><input value={editingVehicle.color || ''} onChange={e => setEditingVehicle({...editingVehicle, color: e.target.value})} style={inp} /></div>
                                <div><label style={lbl}>Make</label><input value={editingVehicle.make || ''} onChange={e => setEditingVehicle({...editingVehicle, make: e.target.value})} style={inp} /></div>
                                <div><label style={lbl}>Model</label><input value={editingVehicle.model || ''} onChange={e => setEditingVehicle({...editingVehicle, model: e.target.value})} style={inp} /></div>
                                <div><label style={lbl}>Year</label><input value={editingVehicle.year || ''} onChange={e => setEditingVehicle({...editingVehicle, year: e.target.value})} style={inp} /></div>
                                <div style={{ gridColumn:'span 2' }}>
                                  <label style={lbl}>Unit</label>
                                  <input value={editingVehicle.unit || ''} disabled readOnly style={lockedInp} />
                                  <p style={helperTxt}>Contact your property manager to change your unit.</p>
                                </div>
                                <div style={{ gridColumn:'span 2' }}>
                                  <label style={lbl}>Space</label>
                                  <input value={editingVehicle.space || ''} disabled readOnly style={lockedInp} />
                                  <p style={helperTxt}>Space is assigned by your property manager.</p>
                                </div>
                              </div>
                              <button onClick={saveVehicle} style={{ width:'100%', padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>Save Changes</button>
                            </div>
                          )
                        })()}
                      </div>
                    )
                  })}
                </>
              )
            })()}
          </div>
        )}

        {/* MY VIOLATIONS TAB */}
        {activeTab === 'myviol' && (
          <div>
            {/* B210 (2026-06-24): disputeMsg banner removed (resident
                dispute flow retired). */}
            {myViolations.length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No violations found for your registered vehicles</p>
              </div>
            ) : myViolations.map((v, i) => {
              return (
                <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'10px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'10px' }}>
                    <div>
                      <p style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                      <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{displayTowReason(v.violation_type)}</p>
                    </div>
                    <div style={{ textAlign:'right' }}>
                      <p style={{ color:'#555', fontSize:'11px', margin:'0' }}>{new Date(v.created_at).toLocaleDateString()}</p>
                      {v.tow_ticket_generated && (
                        <span style={{ display:'inline-block', marginTop:'4px', background:'#1a1500', border:'1px solid #C9A227', color:'#C9A227', fontSize:'9px', fontWeight:'bold', padding:'2px 6px', borderRadius:'4px', letterSpacing:'0.05em' }}>🎫 TOW TICKET ISSUED</span>
                      )}
                    </div>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px', fontSize:'12px', marginBottom:'10px' }}>
                    <div><span style={{ color:'#555' }}>Property</span><br/><span style={{ color:'#aaa' }}>{v.property || '—'}</span></div>
                    <div><span style={{ color:'#555' }}>Location</span><br/><span style={{ color:'#aaa' }}>{v.location || '—'}</span></div>
                  </div>
                  {(v.vehicle_color || v.vehicle_make || v.vehicle_model) && (
                    <p style={{ color:'#555', fontSize:'11px', margin:'0 0 10px' }}>🚗 {[v.vehicle_color, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')}</p>
                  )}
                  <a href={TOWED_CAR_LOOKUP_URL} target="_blank" rel="noopener noreferrer"
                    style={{ color:'#C9A227', fontSize:'11px', textDecoration:'underline', padding:'4px 0', display:'block', marginBottom:'8px' }}>
                    🔍 Search FindMyTowedCar.org
                  </a>
                  {v.photos && v.photos.length > 0 && (
                    <div style={{ display:'flex', gap:'6px', marginBottom:'10px' }}>
                      {/* B41 (2026-05-19): cap removed. Don't-hide-information principle —
                          residents may need every angle of evidence to decide whether to dispute. */}
                      {v.photos.map((url: string, pi: number) => (
                        <a key={pi} href={url} target="_blank" rel="noopener noreferrer">
                          <img src={url} alt="" style={{ width:'56px', height:'56px', objectFit:'cover', borderRadius:'5px', border:'1px solid #2a2f3d' }} />
                        </a>
                      ))}
                    </div>
                  )}
                  {v.video_url && (
                    <button onClick={() => window.open(v.video_url, '_blank')}
                      style={{ width:'100%', padding:'7px', background:'#0f1620', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial', marginBottom:'10px' }}>
                      ▶ Play Video
                    </button>
                  )}
                  {/* B210 (2026-06-24): all 5 dispute UI blocks removed
                      from this card (dispBadge / initiate button / window-
                      closed message / inline form / post-resolve panel).
                      Resident→PM dispute flow is retired. */}
                </div>
              )
            })}
          </div>
        )}

        {/* VISITORS TAB */}
        {activeTab === 'visitors' && (
          <div>
            <button
              onClick={() => setShowVisitorForm(!showVisitorForm)}
              style={{ width:'100%', padding:'12px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'14px', border:'none', borderRadius:'8px', cursor:'pointer', marginBottom:'14px' }}
            >
              + Issue Visitor Pass
            </button>

            {showVisitorForm && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'14px' }}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0 0 14px' }}>New Visitor Pass</p>
                
                <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Visitor's Plate *</label>
                <input
                  value={visitorForm.plate}
                  onChange={e => setVisitorForm({...visitorForm, plate: normalizePlate(e.target.value)})}
                  placeholder="ABC1234"
                  style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'6px', padding:'10px', fontFamily:'Courier New', fontSize:'16px', fontWeight:'bold', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', textAlign:'center', boxSizing:'border-box' }}
                />
                {limitStatus?.state === 'exempt' && (
                  <p style={{ color:'#4caf50', fontSize:'11px', margin:'0 0 12px' }}>✓ Exempt plate — no limit</p>
                )}
                {limitStatus?.state === 'within' && (
                  <p style={{ color:'#888', fontSize:'11px', margin:'0 0 12px' }}>{limitStatus.used} of {limitStatus.limit} active passes used.</p>
                )}
                {limitStatus?.state === 'at_limit' && (
                  <p style={{ color:'#f44336', fontSize:'11px', margin:'0 0 12px', lineHeight:'1.5' }}>Limit reached: {limitStatus.used} of {limitStatus.limit} active passes. Wait for existing passes to expire or contact your property manager.</p>
                )}
                {!limitStatus && <div style={{ marginBottom:'12px' }} />}
                <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Visitor Name</label>
                <input
                  value={visitorForm.name}
                  onChange={e => setVisitorForm({...visitorForm, name: e.target.value})}
                  placeholder="John Smith"
                  style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'12px', padding:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px', boxSizing:'border-box' }}
                />
                <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Vehicle Description</label>
                <input
                  value={visitorForm.vehicle_desc}
                  onChange={e => setVisitorForm({...visitorForm, vehicle_desc: e.target.value})}
                  placeholder="White Toyota RAV4"
                  style={{ display:'block', width:'100%', marginTop:'6px', padding:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px', boxSizing:'border-box' }}
                />
                <p style={{ color:'#555', fontSize:'11px', margin:'4px 0 12px' }}>Optional — helps property staff identify your car.</p>
                <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Duration</label>
                <select
                  value={visitorForm.duration}
                  onChange={e => setVisitorForm({...visitorForm, duration: e.target.value})}
                  style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'14px', padding:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px' }}
                >
                  <option value='2'>2 hours</option>
                  <option value='4'>4 hours</option>
                  <option value='8'>8 hours</option>
                  <option value='12'>12 hours</option>
                  <option value='24'>24 hours (maximum)</option>
                </select>
                {passError && (
                  <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 12px', marginBottom:'10px' }}>
                    <p style={{ color:'#f44336', fontSize:'12px', margin:'0', lineHeight:'1.5' }}>{passError}</p>
                  </div>
                )}
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={issueVisitorPass} disabled={isAtLimit(limitStatus)}
                    style={{ flex:1, padding:'11px', background: isAtLimit(limitStatus) ? '#555' : '#C9A227', color: isAtLimit(limitStatus) ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor: isAtLimit(limitStatus) ? 'not-allowed' : 'pointer' }}>
                    Issue Pass
                  </button>
                  <button onClick={() => { setShowVisitorForm(false); setPassError('') }}
                    style={{ padding:'11px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {passes.length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No active visitor passes</p>
              </div>
            ) : (
              passes.map((p, i) => (
                <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                    <p style={{ color:'white', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{p.plate}</p>
                    <span style={{ background:'#1a3a1a', color:'#4caf50', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold' }}>Active</span>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px', fontSize:'12px' }}>
                    <div><span style={{ color:'#555' }}>Visitor</span><br/><span style={{ color:'#aaa' }}>{p.visitor_name || '—'}</span></div>
                    <div><span style={{ color:'#555' }}>Duration</span><br/><span style={{ color:'#aaa' }}>{p.duration_hours} hours</span></div>
                    <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555' }}>Expires</span><br/><span style={{ color:'#f59e0b' }}>{new Date(p.expires_at).toLocaleString()}</span></div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

      {companyName && (
        <div style={{ marginTop: 24 }}>
          <SupportContact role="resident" company={companyName} managerName={propertyManager.name} managerEmail={propertyManager.email} />
        </div>
      )}
      {(supportPhone || supportEmail || supportWebsite) && (
        <p style={{ color:'#333', fontSize:'11px', textAlign:'center', marginTop:'12px' }}>
          {[supportPhone, supportEmail, supportWebsite].filter(Boolean).join(' · ')}
        </p>
      )}
      </div>

      {/* Space Request submit modal — invoked from the "+ Request a Space"
          button in the welcome bar. Optional note (500-char cap; counter
          shows remaining). Submit calls submit_space_request(p_property,
          p_note); errors surface inline (including the friendly "already
          pending" message when the partial UNIQUE catches a 2nd attempt). */}
      {showSpaceRequestModal && (
        <div onClick={() => setShowSpaceRequestModal(false)}
          style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:100, padding:'16px' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'20px', maxWidth:'480px', width:'100%', boxSizing:'border-box' }}>
            <p style={{ color:'white', fontWeight:'bold', fontSize:'15px', margin:'0 0 6px' }}>Request a Parking Space</p>
            <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 14px', lineHeight:'1.5' }}>
              Your property manager will review and approve or decline. You will see the decision here.
            </p>
            <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.05em', display:'block', marginBottom:'4px' }}>
              Note <span style={{ color:'#555', textTransform:'none', letterSpacing:0 }}>(optional)</span>
            </label>
            <textarea
              value={spaceRequestNote}
              onChange={e => setSpaceRequestNote(e.target.value.slice(0, 500))}
              disabled={spaceRequestSubmitting}
              placeholder="e.g. covered spot preferred, or I have a motorcycle"
              rows={4}
              style={{ width:'100%', padding:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px', boxSizing:'border-box', fontFamily:'inherit', resize:'vertical' }}
            />
            <p style={{ color:'#555', fontSize:'10px', textAlign:'right', margin:'4px 0 0' }}>{spaceRequestNote.length}/500</p>
            {spaceRequestError && (
              <p style={{ color:'#f44336', fontSize:'12px', margin:'10px 0 0', lineHeight:'1.5' }}>{spaceRequestError}</p>
            )}
            <div style={{ display:'flex', gap:'8px', marginTop:'16px' }}>
              <button onClick={() => setShowSpaceRequestModal(false)} disabled={spaceRequestSubmitting}
                style={{ flex:1, padding:'10px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'13px', fontFamily:'Arial' }}>
                Cancel
              </button>
              <button onClick={submitSpaceRequest} disabled={spaceRequestSubmitting}
                style={{ flex:2, padding:'10px', background:spaceRequestSubmitting?'#3a4055':'#C9A227', color:spaceRequestSubmitting?'#888':'#0a0e1a', border:'none', borderRadius:'6px', cursor:spaceRequestSubmitting?'not-allowed':'pointer', fontSize:'13px', fontWeight:'bold', fontFamily:'Arial' }}>
                {spaceRequestSubmitting ? 'Submitting…' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
'use client'
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { logAudit } from '../lib/audit'

export default function ResidentPortal() {
  const [resident, setResident] = useState<any>(null)
  const [vehicles, setVehicles] = useState<any[]>([])
  const [passes, setPasses] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('info')
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<any>({})
  const [showVisitorForm, setShowVisitorForm] = useState(false)
  const [visitorForm, setVisitorForm] = useState({ plate: '', name: '', vehicle_desc: '', duration: '4' })
  const [editingVehicleId, setEditingVehicleId] = useState<string | null>(null)
  const [editingVehicle, setEditingVehicle] = useState<any>({})
  const [showRequestForm, setShowRequestForm] = useState(false)
  const [newVehicle, setNewVehicle] = useState({ plate:'', state:'TX', make:'', model:'', year:'', color:'', space:'' })
  const [requestMsg, setRequestMsg] = useState('')
  const [passError, setPassError] = useState('')
  const [supportPhone, setSupportPhone] = useState('346-428-7864')
  const [supportEmail, setSupportEmail] = useState('a1wrecker2023@gmail.com')
  const [supportWebsite, setSupportWebsite] = useState('a1wreckerllc.net')
  const [changePwForm, setChangePwForm] = useState({ current: '', newPw: '', confirmPw: '' })
  const [changePwMsg, setChangePwMsg] = useState('')
  const [changePwLoading, setChangePwLoading] = useState(false)
  const [myViolations, setMyViolations] = useState<any[]>([])
  const [myDisputes, setMyDisputes] = useState<any[]>([])
  const [disputingId, setDisputingId] = useState<string | null>(null)
  const [disputeForm, setDisputeForm] = useState({ reason: '', details: '' })
  const [disputeEvidence, setDisputeEvidence] = useState<File | null>(null)
  const [submittingDispute, setSubmittingDispute] = useState(false)
  const [disputeMsg, setDisputeMsg] = useState('')

  useEffect(() => { loadResident() }, [])
  useEffect(() => {
    if (activeTab === 'myviol' && resident) { fetchMyViolations(); fetchMyDisputes() }
  }, [activeTab, resident])
  useEffect(() => {
    setSupportPhone(localStorage.getItem('company_support_phone') || '346-428-7864')
    setSupportEmail(localStorage.getItem('company_support_email') || 'a1wrecker2023@gmail.com')
    setSupportWebsite(localStorage.getItem('company_support_website') || 'a1wreckerllc.net')
  }, [])

  async function loadResident() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { window.location.href = '/login'; return }

    const { data, error } = await supabase
      .from('residents')
      .select('*')
      .ilike('email', user.email!)
      .single()

    setLoading(false)
    if (error || !data) {
      setError('Your resident account was not found. Please contact your property manager.')
    } else {
      setResident(data)
      setEditForm(data)
      fetchVehicles(data.unit, data.property)
      fetchPasses(data.unit)
    }
  }

  async function fetchVehicles(unit: string, property: string) {
    const { data } = await supabase
      .from('vehicles')
      .select('*')
      .ilike('unit', unit)
      .ilike('property', property)
    const vehs = data || []
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
    const plates = vehicles.map((v: any) => v.plate?.toUpperCase().trim()).filter(Boolean)
    if (plates.length === 0) { setMyViolations([]); return }
    const { data } = await supabase.from('violations').select('*').in('plate', plates).order('created_at', { ascending: false })
    setMyViolations(data || [])
  }

  async function fetchMyDisputes() {
    if (!resident) return
    const { data } = await supabase.from('dispute_requests').select('*').ilike('resident_email', resident.email)
    setMyDisputes(data || [])
  }

  async function submitDispute(violationId: string, property: string) {
    if (!disputeForm.reason) { alert('Please select a reason'); return }
    if (disputeForm.reason.startsWith('Other') && !disputeForm.details) { alert('Please describe the issue in the details field'); return }
    setSubmittingDispute(true)
    let evidenceUrl: string | null = null
    if (disputeEvidence) {
      const fileName = `dispute-${Date.now()}-${disputeEvidence.name}`
      const { error: upErr } = await supabase.storage.from('violation-photos').upload(fileName, disputeEvidence)
      if (!upErr) {
        const { data: urlData } = supabase.storage.from('violation-photos').getPublicUrl(fileName)
        evidenceUrl = urlData.publicUrl
      }
    }
    const { error } = await supabase.from('dispute_requests').insert([{
      violation_id: violationId, resident_email: resident.email,
      property, reason: disputeForm.reason, details: disputeForm.details || null,
      evidence_url: evidenceUrl, status: 'pending',
    }])
    setSubmittingDispute(false)
    if (error) { alert('Error: ' + error.message); return }
    await logAudit({ action: 'DISPUTE_SUBMITTED', table_name: 'dispute_requests', new_values: { violation_id: violationId, property, reason: disputeForm.reason } })
    setDisputingId(null)
    setDisputeForm({ reason: '', details: '' })
    setDisputeEvidence(null)
    setDisputeMsg('Dispute submitted. Your property manager will review and respond within 5 business days.')
    fetchMyDisputes()
  }

  async function changePassword() {
    setChangePwMsg('')
    if (changePwForm.newPw.length < 8) { setChangePwMsg('New password must be at least 8 characters.'); return }
    if (changePwForm.newPw !== changePwForm.confirmPw) { setChangePwMsg('Passwords do not match.'); return }
    setChangePwLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    const { error: reAuthErr } = await supabase.auth.signInWithPassword({ email: user?.email || '', password: changePwForm.current })
    if (reAuthErr) { setChangePwMsg('Current password is incorrect.'); setChangePwLoading(false); return }
    const { error: updateErr } = await supabase.auth.updateUser({ password: changePwForm.newPw })
    setChangePwLoading(false)
    if (updateErr) { setChangePwMsg(updateErr.message); return }
    setChangePwMsg('Password changed successfully.')
    setChangePwForm({ current: '', newPw: '', confirmPw: '' })
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
    const { error } = await supabase.from('vehicles').update({
      plate: editingVehicle.plate.toUpperCase().trim(),
      state: editingVehicle.state,
      make: editingVehicle.make,
      model: editingVehicle.model,
      year: editingVehicle.year,
      color: editingVehicle.color,
      space: editingVehicle.space,
    }).eq('id', editingVehicle.id)
    if (error) { alert('Error: ' + error.message) }
    else {
      await logAudit({ action: 'EDIT_VEHICLE', table_name: 'vehicles', record_id: editingVehicle.id, new_values: { plate: editingVehicle.plate.toUpperCase().trim(), make: editingVehicle.make, model: editingVehicle.model, color: editingVehicle.color, year: editingVehicle.year } })
      setEditingVehicleId(null); fetchVehicles(resident.unit, resident.property)
    }
  }

  async function requestVehicle() {
    if (!newVehicle.plate) { alert('Plate is required'); return }
    const { data: existingVehicles } = await supabase
      .from('vehicles').select('id')
      .eq('unit', resident.unit).ilike('property', resident.property)
      .in('status', ['active', 'pending'])
    if (existingVehicles && existingVehicles.length >= 2) {
      setRequestMsg('Maximum of 2 vehicles allowed per resident at initial registration. To add an additional vehicle beyond this limit, please contact your Property Manager directly.')
      return
    }
    const { error } = await supabase.from('vehicles').insert([{
      plate: newVehicle.plate.toUpperCase().trim(),
      state: newVehicle.state,
      make: newVehicle.make,
      model: newVehicle.model,
      year: parseInt(newVehicle.year) || null,
      color: newVehicle.color,
      space: newVehicle.space,
      unit: resident.unit,
      property: resident.property,
      is_active: false,
      status: 'pending',
    }])
    if (error) { alert('Error: ' + error.message) }
    else {
      await logAudit({ action: 'REQUEST_VEHICLE', table_name: 'vehicles', new_values: { plate: newVehicle.plate.toUpperCase().trim(), make: newVehicle.make, model: newVehicle.model, unit: resident.unit, property: resident.property } })
      setRequestMsg('Vehicle submitted for Property Manager approval. You will see the status update here.')
      setShowRequestForm(false)
      setNewVehicle({ plate:'', state:'TX', make:'', model:'', year:'', color:'', space:'' })
      fetchVehicles(resident.unit, resident.property)
    }
  }

  async function markDeclinedRead(id: string) {
    await supabase.from('vehicles').update({ resident_read: true }).eq('id', id)
    fetchVehicles(resident.unit, resident.property)
  }

  async function issueVisitorPass() {
    if (!visitorForm.plate || !resident) return
    setPassError('')
    const plate = visitorForm.plate.toUpperCase().trim()

    if (resident.property) {
      const { data: propData } = await supabase
        .from('properties')
        .select('visitor_pass_limit, exempt_plates')
        .ilike('name', resident.property)
        .single()

      if (propData && propData.visitor_pass_limit && propData.visitor_pass_limit > 0) {
        const exemptPlates: string[] = propData.exempt_plates || []
        const isExempt = exemptPlates.some((ep: string) => ep.toUpperCase() === plate)
        if (!isExempt) {
          const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString()
          const { count } = await supabase
            .from('visitor_passes')
            .select('id', { count: 'exact', head: true })
            .ilike('plate', plate)
            .ilike('property', resident.property)
            .gte('created_at', yearStart)
          if ((count ?? 0) >= propData.visitor_pass_limit) {
            setPassError('This vehicle has reached the maximum number of visitor passes allowed per year for this property.')
            return
          }
        }
      }
    }

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
      alert('Error: ' + error.message)
    } else {
      await logAudit({ action: 'ISSUE_VISITOR_PASS', table_name: 'visitor_passes', new_values: { plate, visiting_unit: resident.unit, duration_hours: parseInt(visitorForm.duration) } })
      alert('Visitor pass issued!')
      setShowVisitorForm(false)
      setVisitorForm({ plate: '', name: '', vehicle_desc: '', duration: '4' })
      fetchPasses(resident.unit)
    }
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
      <div style={{ maxWidth:'500px', margin:'0 auto' }}>

        <div style={{ marginBottom:'20px', textAlign:'center' }}>
          <h1 style={{ color:'#C9A227', fontSize:'22px', fontWeight:'bold', margin:'0' }}>A1 Wrecker, LLC</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'4px 0 0' }}>Resident Portal</p>
        </div>

        {/* Welcome bar */}
        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px 16px', marginBottom:'16px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <p style={{ color:'white', fontWeight:'bold', fontSize:'14px', margin:'0' }}>{resident.name}</p>
            <p style={{ color:'#aaa', fontSize:'12px', margin:'4px 0 0' }}>{resident.unit} · {resident.property}</p>
          </div>
          <div style={{ textAlign:'right' }}>
            <p style={{ color:'#555', fontSize:'11px', margin:'0' }}>Assigned Space</p>
            <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'18px', margin:'2px 0 0', fontFamily:'Courier New' }}>{resident.space || '—'}</p>
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
            Violations{myDisputes.some(d => d.status === 'pending') && <span style={{ background:'#a16207', color:'white', borderRadius:'10px', fontSize:'9px', padding:'1px 6px', marginLeft:'4px', fontWeight:'bold' }}>{myDisputes.filter(d => d.status === 'pending').length}</span>}
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
            <button onClick={changePassword} disabled={changePwLoading || !changePwForm.current || !changePwForm.newPw || !changePwForm.confirmPw}
              style={{ width:'100%', padding:'11px', background:(!changePwForm.current || !changePwForm.newPw || !changePwForm.confirmPw) ? '#555' : '#C9A227', color:(!changePwForm.current || !changePwForm.newPw || !changePwForm.confirmPw) ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:(!changePwForm.current || !changePwForm.newPw || !changePwForm.confirmPw) ? 'not-allowed' : 'pointer' }}>
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
                  {vehicles.filter(v => v.status === 'active' || v.status === 'pending').length >= 2 ? (
                    <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'12px' }}>
                      <p style={{ color:'#888', fontSize:'12px', margin:'0', lineHeight:'1.6' }}>You have reached the maximum vehicles allowed at initial registration. Please contact your Property Manager to request additional vehicles.</p>
                    </div>
                  ) : (
                    <>
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
                              <input value={newVehicle.plate} onChange={e => setNewVehicle({...newVehicle, plate: e.target.value.replace(/\s+/g, '').toUpperCase()})} placeholder="ABC1234" style={{ ...inp, fontFamily:'Courier New', fontSize:'16px', fontWeight:'bold', textAlign:'center' }} />
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
                    </>
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
                          {!v.status && (
                            <button onClick={() => { setEditingVehicleId(isEditing ? null : v.id); setEditingVehicle({...v}) }}
                              style={{ width:'100%', padding:'7px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial' }}>
                              {isEditing ? 'Cancel Edit' : 'Edit'}
                            </button>
                          )}
                        </div>

                        <div style={{ paddingBottom:'4px' }}>
                          <button onClick={() => window.open(`https://www.findmytowedcar.org/advancesearch?plate=${v.plate}`, '_blank')}
                            style={{ color:'#C9A227', fontSize:'11px', background:'transparent', border:'none', cursor:'pointer', textDecoration:'underline', padding:'4px 0' }}>
                            🔍 Find My Towed Vehicle (Houston & Harris County)
                          </button>
                        </div>

                        {isEditing && (
                          <div style={{ background:'#0f1117', borderTop:'1px solid #2a2f3d', padding:'16px' }}>
                            <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', margin:'0 0 12px' }}>Edit Vehicle</p>
                            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                              <div style={{ gridColumn:'span 2' }}>
                                <label style={lbl}>Plate</label>
                                <input value={editingVehicle.plate || ''} onChange={e => setEditingVehicle({...editingVehicle, plate: e.target.value.replace(/\s+/g, '').toUpperCase()})} style={{ ...inp, fontFamily:'Courier New', fontSize:'16px', fontWeight:'bold', textAlign:'center' }} />
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
                              <div><label style={lbl}>Space</label><input value={editingVehicle.space || ''} onChange={e => setEditingVehicle({...editingVehicle, space: e.target.value})} style={inp} /></div>
                            </div>
                            <button onClick={saveVehicle} style={{ width:'100%', padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>Save Changes</button>
                          </div>
                        )}
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
            {disputeMsg && (
              <div style={{ background:'#1a3a1a', border:'1px solid #2e7d32', borderRadius:'8px', padding:'12px 14px', marginBottom:'14px' }}>
                <p style={{ color:'#4caf50', fontSize:'12px', margin:'0', lineHeight:'1.5' }}>{disputeMsg}</p>
              </div>
            )}
            {myViolations.length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No violations found for your registered vehicles</p>
              </div>
            ) : myViolations.map((v, i) => {
              const dispute = myDisputes.find(d => d.violation_id === v.id)
              const daysSince = (Date.now() - new Date(v.created_at).getTime()) / (1000 * 60 * 60 * 24)
              const canDispute = daysSince <= 30
              const dispBadge = !dispute
                ? { text:'No Dispute Filed', bg:'#1e2535', color:'#555' }
                : dispute.status === 'pending'
                  ? { text:'Dispute Pending', bg:'#1a1200', color:'#f59e0b' }
                  : dispute.status === 'upheld'
                    ? { text:'Tow Upheld', bg:'#3a1a1a', color:'#f44336' }
                    : { text:'Resolved in Your Favor', bg:'#1a3a1a', color:'#4caf50' }
              return (
                <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'10px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'10px' }}>
                    <div>
                      <p style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                      <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{v.violation_type || '—'}</p>
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
                  <button onClick={() => window.open(`https://www.findmytowedcar.org/advancesearch?plate=${v.plate}`, '_blank')}
                    style={{ color:'#C9A227', fontSize:'11px', background:'transparent', border:'none', cursor:'pointer', textDecoration:'underline', padding:'4px 0', display:'block', marginBottom:'8px' }}>
                    🔍 Search FindMyTowedCar.org — Houston & Harris County area
                  </button>
                  {v.photos && v.photos.length > 0 && (
                    <div style={{ display:'flex', gap:'6px', marginBottom:'10px' }}>
                      {v.photos.slice(0,3).map((url: string, pi: number) => (
                        <a key={pi} href={url} target="_blank" rel="noopener noreferrer">
                          <img src={url} alt="" style={{ width:'56px', height:'56px', objectFit:'cover', borderRadius:'5px', border:'1px solid #2a2f3d' }} />
                        </a>
                      ))}
                    </div>
                  )}
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: (!dispute && canDispute) ? '10px' : '0' }}>
                    <span style={{ background:dispBadge.bg, color:dispBadge.color, padding:'3px 8px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold', border:`1px solid ${dispBadge.color}33` }}>{dispBadge.text}</span>
                    {dispute?.resolved_at && <span style={{ color:'#555', fontSize:'10px' }}>Resolved {new Date(dispute.resolved_at).toLocaleDateString()}</span>}
                  </div>

                  {!dispute && canDispute && disputingId !== v.id && (
                    <button onClick={() => { setDisputingId(v.id); setDisputeForm({ reason:'', details:'' }); setDisputeEvidence(null) }}
                      style={{ width:'100%', padding:'9px', background:'#1a1200', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'7px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial', marginTop:'10px' }}>
                      ⚖ Dispute This Tow
                    </button>
                  )}
                  {!dispute && !canDispute && (
                    <p style={{ color:'#555', fontSize:'11px', margin:'10px 0 0', fontStyle:'italic' }}>Dispute window closed (30 days from violation date)</p>
                  )}

                  {disputingId === v.id && (
                    <div style={{ marginTop:'12px', borderTop:'1px solid #2a2f3d', paddingTop:'12px' }}>
                      <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', margin:'0 0 10px' }}>⚖ File a Dispute</p>
                      <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.07em', display:'block', marginBottom:'4px' }}>Reason *</label>
                      <select value={disputeForm.reason} onChange={e => setDisputeForm({...disputeForm, reason: e.target.value})}
                        style={{ display:'block', width:'100%', padding:'9px 10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px', marginBottom:'10px', boxSizing:'border-box' as const }}>
                        <option value=''>Select a reason…</option>
                        <option>Vehicle was already moved before tow</option>
                        <option>Valid permit not recognized by system</option>
                        <option>Incorrect vehicle towed</option>
                        <option>Signage was unclear or missing</option>
                        <option>Guest had valid visitor pass</option>
                        <option>Other — explain below</option>
                      </select>
                      <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.07em', display:'block', marginBottom:'4px' }}>Details {disputeForm.reason.startsWith('Other') ? '*' : '(optional)'}</label>
                      <textarea value={disputeForm.details} onChange={e => setDisputeForm({...disputeForm, details: e.target.value})}
                        placeholder="Provide any additional context or explanation..."
                        style={{ display:'block', width:'100%', padding:'9px 10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'12px', marginBottom:'10px', minHeight:'72px', resize:'vertical' as const, boxSizing:'border-box' as const }} />
                      <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.07em', display:'block', marginBottom:'4px' }}>Evidence Photo (optional)</label>
                      <input type="file" accept="image/*" onChange={e => setDisputeEvidence(e.target.files?.[0] || null)}
                        style={{ display:'block', width:'100%', color:'#aaa', fontSize:'12px', marginBottom:'10px' }} />
                      <div style={{ background:'#111827', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'10px 12px', marginBottom:'12px' }}>
                        <p style={{ color:'#666', fontSize:'11px', margin:'0', lineHeight:'1.6' }}>
                          ⚖ Official Dispute Record: This dispute will be permanently recorded in the system and reviewed by your property manager. Please provide accurate and professional information. False or misleading disputes may result in account review. All submissions are logged with your name, email, and timestamp for audit purposes.
                        </p>
                      </div>
                      <div style={{ display:'flex', gap:'8px' }}>
                        <button onClick={() => submitDispute(v.id, v.property)} disabled={submittingDispute}
                          style={{ flex:1, padding:'10px', background: submittingDispute ? '#555' : '#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'7px', cursor: submittingDispute ? 'not-allowed' : 'pointer', fontFamily:'Arial' }}>
                          {submittingDispute ? 'Submitting…' : 'Submit Dispute'}
                        </button>
                        <button onClick={() => setDisputingId(null)}
                          style={{ padding:'10px 12px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'7px', cursor:'pointer', fontSize:'12px', fontFamily:'Arial' }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {dispute && (
                    <div style={{ marginTop:'10px', borderTop:'1px solid #2a2f3d', paddingTop:'10px' }}>
                      <p style={{ color:'#555', fontSize:'11px', margin:'0 0 2px' }}>Reason: <span style={{ color:'#aaa' }}>{dispute.reason}</span></p>
                      {dispute.details && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0' }}>Details: <span style={{ color:'#aaa' }}>{dispute.details}</span></p>}
                      {dispute.pm_note && <p style={{ color:'#555', fontSize:'11px', margin:'2px 0' }}>Manager note: <span style={{ color:'#aaa' }}>{dispute.pm_note}</span></p>}
                    </div>
                  )}
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
                  onChange={e => setVisitorForm({...visitorForm, plate: e.target.value.replace(/\s+/g, '').toUpperCase()})}
                  placeholder="ABC1234"
                  style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'12px', padding:'10px', fontFamily:'Courier New', fontSize:'16px', fontWeight:'bold', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', textAlign:'center', boxSizing:'border-box' }}
                />
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
                  style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'12px', padding:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'13px', boxSizing:'border-box' }}
                />
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
                  <button onClick={issueVisitorPass}
                    style={{ flex:1, padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>
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

      <p style={{ color:'#333', fontSize:'11px', textAlign:'center', marginTop:'24px' }}>
        {supportPhone} · {supportEmail} · {supportWebsite}
      </p>
      </div>
    </main>
  )
}
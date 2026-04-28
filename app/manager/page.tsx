'use client'
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

export default function ManagerPortal() {
  const [email, setEmail] = useState('')
  const [manager, setManager] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('overview')
  const [vehicles, setVehicles] = useState<any[]>([])
  const [violations, setViolations] = useState<any[]>([])
  const [passes, setPasses] = useState<any[]>([])
  const [stats, setStats] = useState({ total_vehicles: 0, active_passes: 0, violations_today: 0, violations_week: 0 })
  const [showAddVehicle, setShowAddVehicle] = useState(false)
  const [newVehicle, setNewVehicle] = useState({ plate: '', state: 'TX', make: '', model: '', year: '', color: '', unit: '', space: '', permit_expiry: '' })
  const [violationFilter, setViolationFilter] = useState('today')
  const [residents, setResidents] = useState<any[]>([])
  const [showAddResident, setShowAddResident] = useState(false)
  const [newResident, setNewResident] = useState({ name: '', email: '', phone: '', unit: '', space: '', lease_end: '' })
  const [editingResident, setEditingResident] = useState<any>(null)

  async function findManager() {
    if (!email) return
    setLoading(true)
    setError('')
    const { data, error } = await supabase
      .from('properties')
      .select('*')
      .ilike('pm_email', email.trim())
      .single()
    setLoading(false)
    console.log('data:', data, 'error:', error)
    if (error || !data) {
      setError('No property manager account found with that email. Error: ' + (error?.message || 'No record found'))
    } else {
      setManager(data)
      fetchAll(data.name)
    }
  }

  async function fetchAll(property: string) {
    fetchVehicles(property)
    fetchViolations(property)
    fetchPasses(property)
    fetchResidents(property)
  }

  async function fetchVehicles(property: string) {
    const { data } = await supabase
      .from('vehicles')
      .select('*')
      .ilike('property', property)
      .order('unit', { ascending: true })
    setVehicles(data || [])
    setStats(s => ({ ...s, total_vehicles: data?.length || 0 }))
  }

  async function fetchViolations(property: string) {
    const week = new Date()
    week.setDate(week.getDate() - 7)
    const { data } = await supabase
      .from('violations')
      .select('*')
      .ilike('property', property)
      .gte('created_at', week.toISOString())
      .order('created_at', { ascending: false })
    setViolations(data || [])
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayCount = (data || []).filter(v => new Date(v.created_at) >= today).length
    setStats(s => ({ ...s, violations_today: todayCount, violations_week: data?.length || 0 }))
  }

  async function fetchPasses(property: string) {
    const now = new Date().toISOString()
    const { data } = await supabase
      .from('visitor_passes')
      .select('*')
      .gte('expires_at', now)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
    setPasses(data || [])
    setStats(s => ({ ...s, active_passes: data?.length || 0 }))
  }

  async function addVehicle() {
    if (!newVehicle.plate || !newVehicle.unit) {
      alert('Plate and unit are required')
      return
    }
    const { error } = await supabase
      .from('vehicles')
      .insert([{
        ...newVehicle,
        plate: newVehicle.plate.toUpperCase().trim(),
        property: manager.name,
        is_active: true,
        year: parseInt(newVehicle.year) || null
      }])
    if (error) {
      alert('Error: ' + error.message)
    } else {
      alert('Vehicle added!')
      setShowAddVehicle(false)
      setNewVehicle({ plate: '', state: 'TX', make: '', model: '', year: '', color: '', unit: '', space: '', permit_expiry: '' })
      fetchVehicles(manager.name)
    }
  }
async function fetchResidents(property: string) {
    const { data } = await supabase
      .from('residents')
      .select('*')
      .ilike('property', property)
      .order('unit', { ascending: true })
    setResidents(data || [])
  }

  async function addResident() {
    if (!newResident.name || !newResident.unit || !newResident.email) {
      alert('Name, email and unit are required')
      return
    }
    const { error } = await supabase
      .from('residents')
      .insert([{
        ...newResident,
        property: manager.name,
        is_active: true
      }])
    if (error) {
      alert('Error: ' + error.message)
    } else {
      alert('Resident added!')
      setShowAddResident(false)
      setNewResident({ name: '', email: '', phone: '', unit: '', space: '', lease_end: '' })
      fetchResidents(manager.name)
    }
  }

  async function saveResident() {
    const { error } = await supabase
      .from('residents')
      .update({
        name: editingResident.name,
        email: editingResident.email,
        phone: editingResident.phone,
        unit: editingResident.unit,
        space: editingResident.space,
        lease_end: editingResident.lease_end,
      })
      .eq('id', editingResident.id)
    if (error) {
      alert('Error: ' + error.message)
    } else {
      alert('Resident updated!')
      setEditingResident(null)
      fetchResidents(manager.name)
    }
  }

  async function deactivateResident(id: string) {
    if (!confirm('Deactivate this resident?')) return
    await supabase.from('residents').update({ is_active: false }).eq('id', id)
    fetchResidents(manager.name)
  }
  async function removeVehicle(id: string) {
    if (!confirm('Remove this vehicle?')) return
    await supabase.from('vehicles').update({ is_active: false }).eq('id', id)
    fetchVehicles(manager.name)
  }

  const tabStyle = (tab: string) => ({
    flex: 1, padding: '9px', border: 'none', borderRadius: '6px',
    cursor: 'pointer', fontWeight: 'bold' as const, fontSize: '11px',
    background: activeTab === tab ? '#C9A227' : '#1e2535',
    color: activeTab === tab ? '#0f1117' : '#888',
    fontFamily: 'Arial, sans-serif'
  })

  const inputStyle = { display:'block', width:'100%', marginTop:'6px', marginBottom:'10px', padding:'9px 10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'6px', color:'white', fontSize:'12px', boxSizing:'border-box' as const }

  function filteredViolations() {
    const now = new Date()
    const today = new Date(); today.setHours(0,0,0,0)
    const week = new Date(); week.setDate(now.getDate()-7)
    const sixmo = new Date(); sixmo.setMonth(now.getMonth()-6)
    return violations.filter(v => {
      const d = new Date(v.created_at)
      if (violationFilter === 'today') return d >= today
      if (violationFilter === 'week') return d >= week
      return d >= sixmo
    })
  }

  if (!manager) {
    return (
      <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
        <div style={{ maxWidth:'380px', width:'100%' }}>
          <div style={{ marginBottom:'28px', textAlign:'center' }}>
            <h1 style={{ color:'#C9A227', fontSize:'24px', fontWeight:'bold', margin:'0' }}>A1 Wrecker, LLC</h1>
            <p style={{ color:'#888', fontSize:'13px', margin:'6px 0 0' }}>Property Manager Portal</p>
          </div>
          <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'28px' }}>
            <p style={{ color:'#aaa', fontSize:'13px', margin:'0 0 16px', lineHeight:'1.6' }}>Enter your property manager email to access your dashboard.</p>
            {error && (
              <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'8px', padding:'10px', marginBottom:'14px' }}>
                <p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{error}</p>
              </div>
            )}
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Email Address</label>
            <input
              type="email" value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && findManager()}
              placeholder="manager@property.com"
              style={{ ...inputStyle, marginTop:'8px' }}
            />
            <button onClick={findManager} disabled={loading || !email}
              style={{ width:'100%', padding:'12px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'14px', border:'none', borderRadius:'8px', cursor:'pointer', marginTop:'4px' }}>
              {loading ? 'Looking up...' : 'Access Dashboard'}
            </button>
          </div>
          <div style={{ textAlign:'center', marginTop:'16px' }}>
            <a href="/" style={{ color:'#C9A227', fontSize:'12px', textDecoration:'none' }}>← Back to Plate Lookup</a>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'600px', margin:'0 auto' }}>

        <div style={{ marginBottom:'16px', textAlign:'center' }}>
          <h1 style={{ color:'#C9A227', fontSize:'22px', fontWeight:'bold', margin:'0' }}>A1 Wrecker, LLC</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'4px 0 0' }}>Property Manager Portal</p>
        </div>

        {/* Property Header */}
        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px 16px', marginBottom:'14px' }}>
          <p style={{ color:'white', fontWeight:'bold', fontSize:'15px', margin:'0' }}>{manager.name}</p>
          <p style={{ color:'#aaa', fontSize:'12px', margin:'4px 0 0' }}>{manager.address || 'Property Manager'} · {manager.pm_name}</p>
        </div>

        {/* Stats */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'8px', marginBottom:'14px' }}>
          {[
            { label:'Vehicles', value: stats.total_vehicles, color:'#C9A227' },
            { label:'Violations Today', value: stats.violations_today, color:'#f44336' },
            { label:'This Week', value: stats.violations_week, color:'#ff9800' },
            { label:'Active Passes', value: stats.active_passes, color:'#4caf50' },
          ].map((s,i) => (
            <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', textAlign:'center' }}>
              <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0' }}>{s.label}</p>
              <p style={{ color:s.color, fontSize:'24px', fontWeight:'bold', margin:'4px 0 0', fontFamily:'Courier New' }}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'14px' }}>
          <button style={tabStyle('overview')} onClick={() => setActiveTab('overview')}>Overview</button>
          <button style={tabStyle('vehicles')} onClick={() => setActiveTab('vehicles')}>Vehicles</button>
          <button style={tabStyle('residents')} onClick={() => setActiveTab('residents')}>Residents</button>
          <button style={tabStyle('violations')} onClick={() => setActiveTab('violations')}>Violations</button>
          <button style={tabStyle('visitors')} onClick={() => setActiveTab('visitors')}>Visitors</button>
        </div>

        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (
          <div>
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Recent Violations</p>
              {violations.slice(0,3).length === 0 ? (
                <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No recent violations</p>
              ) : violations.slice(0,3).map((v,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid #1e2535' }}>
                  <span style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'13px', fontWeight:'bold' }}>{v.plate}</span>
                  <span style={{ color:'#aaa', fontSize:'12px' }}>{v.violation_type}</span>
                  <span style={{ color:'#555', fontSize:'11px' }}>{new Date(v.created_at).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px' }}>
              <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Active Visitor Passes</p>
              {passes.length === 0 ? (
                <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No active visitor passes</p>
              ) : passes.map((p,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid #1e2535' }}>
                  <span style={{ color:'#f59e0b', fontFamily:'Courier New', fontSize:'13px', fontWeight:'bold' }}>{p.plate}</span>
                  <span style={{ color:'#aaa', fontSize:'12px' }}>{p.visiting_unit}</span>
                  <span style={{ color:'#4caf50', fontSize:'11px' }}>Expires {new Date(p.expires_at).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* VEHICLES TAB */}
        {activeTab === 'vehicles' && (
          <div>
            <button onClick={() => setShowAddVehicle(!showAddVehicle)}
              style={{ width:'100%', padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', marginBottom:'12px' }}>
              + Add Vehicle
            </button>

            {showAddVehicle && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Add New Vehicle</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Plate *</label>
                    <input value={newVehicle.plate} onChange={e => setNewVehicle({...newVehicle, plate: e.target.value.toUpperCase()})}
                      placeholder="ABC1234" style={{ ...inputStyle, fontFamily:'Courier New', fontSize:'14px', fontWeight:'bold' }} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>State</label>
                    <select value={newVehicle.state} onChange={e => setNewVehicle({...newVehicle, state: e.target.value})}
                      style={inputStyle}>
                      {['TX','CA','FL','NY','GA','OH','IL','PA','NC','AZ'].map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Make</label>
                    <input value={newVehicle.make} onChange={e => setNewVehicle({...newVehicle, make: e.target.value})}
                      placeholder="Toyota" style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Model</label>
                    <input value={newVehicle.model} onChange={e => setNewVehicle({...newVehicle, model: e.target.value})}
                      placeholder="Camry" style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Year</label>
                    <input value={newVehicle.year} onChange={e => setNewVehicle({...newVehicle, year: e.target.value})}
                      placeholder="2022" style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Color</label>
                    <input value={newVehicle.color} onChange={e => setNewVehicle({...newVehicle, color: e.target.value})}
                      placeholder="Black" style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Unit *</label>
                    <input value={newVehicle.unit} onChange={e => setNewVehicle({...newVehicle, unit: e.target.value})}
                      placeholder="Apt 214" style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Space</label>
                    <input value={newVehicle.space} onChange={e => setNewVehicle({...newVehicle, space: e.target.value})}
                      placeholder="A-12" style={inputStyle} />
                  </div>
                  <div style={{ gridColumn:'span 2' }}>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Permit Expiry</label>
                    <input type="date" value={newVehicle.permit_expiry} onChange={e => setNewVehicle({...newVehicle, permit_expiry: e.target.value})}
                      style={inputStyle} />
                  </div>
                </div>
                <div style={{ display:'flex', gap:'8px', marginTop:'4px' }}>
                  <button onClick={addVehicle}
                    style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>
                    Add Vehicle
                  </button>
                  <button onClick={() => setShowAddVehicle(false)}
                    style={{ padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {vehicles.map((v,i) => (
              <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                  <div>
                    <p style={{ color:'white', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                    <p style={{ color:'#aaa', fontSize:'12px', margin:'3px 0 0' }}>{v.color} {v.make} {v.model} {v.year}</p>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <span style={{ background: v.is_active ? '#1a3a1a' : '#3a1a1a', color: v.is_active ? '#4caf50' : '#f44336', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold', display:'block', marginBottom:'6px' }}>
                      {v.is_active ? 'Active' : 'Inactive'}
                    </span>
                    <button onClick={() => removeVehicle(v.id)}
                      style={{ padding:'4px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                      Remove
                    </button>
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
{/* RESIDENTS TAB */}
        {activeTab === 'residents' && (
          <div>
            <button onClick={() => setShowAddResident(!showAddResident)}
              style={{ width:'100%', padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', marginBottom:'12px' }}>
              + Add Resident
            </button>

            {showAddResident && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Add New Resident</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div style={{ gridColumn:'span 2' }}>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Full Name *</label>
                    <input value={newResident.name} onChange={e => setNewResident({...newResident, name: e.target.value})}
                      placeholder="John Smith" style={inputStyle} />
                  </div>
                  <div style={{ gridColumn:'span 2' }}>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Email *</label>
                    <input value={newResident.email} onChange={e => setNewResident({...newResident, email: e.target.value})}
                      placeholder="john@email.com" style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Phone</label>
                    <input value={newResident.phone} onChange={e => setNewResident({...newResident, phone: e.target.value})}
                      placeholder="713-555-0100" style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Unit *</label>
                    <input value={newResident.unit} onChange={e => setNewResident({...newResident, unit: e.target.value})}
                      placeholder="Apt 214" style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Space</label>
                    <input value={newResident.space} onChange={e => setNewResident({...newResident, space: e.target.value})}
                      placeholder="A-12" style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Lease End</label>
                    <input type="date" value={newResident.lease_end} onChange={e => setNewResident({...newResident, lease_end: e.target.value})}
                      style={inputStyle} />
                  </div>
                </div>
                <div style={{ display:'flex', gap:'8px', marginTop:'4px' }}>
                  <button onClick={addResident}
                    style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>
                    Add Resident
                  </button>
                  <button onClick={() => setShowAddResident(false)}
                    style={{ padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {editingResident && (
              <div style={{ background:'#161b26', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Editing — {editingResident.unit}</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div style={{ gridColumn:'span 2' }}>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Full Name</label>
                    <input value={editingResident.name || ''} onChange={e => setEditingResident({...editingResident, name: e.target.value})}
                      style={inputStyle} />
                  </div>
                  <div style={{ gridColumn:'span 2' }}>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Email</label>
                    <input value={editingResident.email || ''} onChange={e => setEditingResident({...editingResident, email: e.target.value})}
                      style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Phone</label>
                    <input value={editingResident.phone || ''} onChange={e => setEditingResident({...editingResident, phone: e.target.value})}
                      style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Unit</label>
                    <input value={editingResident.unit || ''} onChange={e => setEditingResident({...editingResident, unit: e.target.value})}
                      style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Space</label>
                    <input value={editingResident.space || ''} onChange={e => setEditingResident({...editingResident, space: e.target.value})}
                      style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Lease End</label>
                    <input type="date" value={editingResident.lease_end || ''} onChange={e => setEditingResident({...editingResident, lease_end: e.target.value})}
                      style={inputStyle} />
                  </div>
                </div>
                <div style={{ display:'flex', gap:'8px', marginTop:'4px' }}>
                  <button onClick={saveResident}
                    style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>
                    Save Changes
                  </button>
                  <button onClick={() => setEditingResident(null)}
                    style={{ padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>
                    Cancel
                  </button>
                </div>

                {/* Vehicles for this resident */}
                <div style={{ marginTop:'16px', borderTop:'1px solid #2a2f3d', paddingTop:'16px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'10px' }}>
                    <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0' }}>
                      Vehicles — {editingResident.unit}
                    </p>
                    <button
                      onClick={() => setShowAddVehicle(true)}
                      style={{ padding:'5px 10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'11px', border:'none', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>
                      + Add Vehicle
                    </button>
                  </div>

                  {showAddVehicle && (
                    <div style={{ background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', padding:'12px', marginBottom:'10px' }}>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                        <div>
                          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Plate *</label>
                          <input value={newVehicle.plate} onChange={e => setNewVehicle({...newVehicle, plate: e.target.value.toUpperCase()})}
                            placeholder="ABC1234" style={{ ...inputStyle, fontFamily:'Courier New', fontSize:'14px', fontWeight:'bold' }} />
                        </div>
                        <div>
                          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>State</label>
                          <select value={newVehicle.state} onChange={e => setNewVehicle({...newVehicle, state: e.target.value})} style={inputStyle}>
                            {['TX','CA','FL','NY','GA','OH','IL','PA','NC','AZ'].map(s => <option key={s}>{s}</option>)}
                          </select>
                        </div>
                        <div>
                          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Make</label>
                          <input value={newVehicle.make} onChange={e => setNewVehicle({...newVehicle, make: e.target.value})}
                            placeholder="Toyota" style={inputStyle} />
                        </div>
                        <div>
                          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Model</label>
                          <input value={newVehicle.model} onChange={e => setNewVehicle({...newVehicle, model: e.target.value})}
                            placeholder="Camry" style={inputStyle} />
                        </div>
                        <div>
                          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Year</label>
                          <input value={newVehicle.year} onChange={e => setNewVehicle({...newVehicle, year: e.target.value})}
                            placeholder="2022" style={inputStyle} />
                        </div>
                        <div>
                          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Color</label>
                          <input value={newVehicle.color} onChange={e => setNewVehicle({...newVehicle, color: e.target.value})}
                            placeholder="Black" style={inputStyle} />
                        </div>
                        <div>
                          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Space 1</label>
                          <input value={newVehicle.space} onChange={e => setNewVehicle({...newVehicle, space: e.target.value})}
                            placeholder="A-12" style={inputStyle} />
                        </div>
                        <div>
                          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Permit Expiry</label>
                          <input type="date" value={newVehicle.permit_expiry} onChange={e => setNewVehicle({...newVehicle, permit_expiry: e.target.value})}
                            style={inputStyle} />
                        </div>
                      </div>
                      <div style={{ display:'flex', gap:'8px', marginTop:'4px' }}>
                        <button
                          onClick={async () => {
                            if (!newVehicle.plate) { alert('Plate is required'); return }
                            const { error } = await supabase.from('vehicles').insert([{
                              ...newVehicle,
                              plate: newVehicle.plate.toUpperCase().trim(),
                              unit: editingResident.unit,
                              property: manager.name,
                              is_active: true,
                              year: parseInt(newVehicle.year) || null
                            }])
                            if (error) { alert('Error: ' + error.message) } 
                            else {
                              alert('Vehicle added!')
                              setShowAddVehicle(false)
                              setNewVehicle({ plate:'', state:'TX', make:'', model:'', year:'', color:'', unit:'', space:'', permit_expiry:'' })
                              fetchVehicles(manager.name)
                            }
                          }}
                          style={{ flex:1, padding:'9px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'12px', border:'none', borderRadius:'6px', cursor:'pointer' }}>
                          Add Vehicle
                        </button>
                        <button onClick={() => setShowAddVehicle(false)}
                          style={{ padding:'9px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {vehicles
                    .filter(v => v.unit?.toLowerCase() === editingResident.unit?.toLowerCase())
                    .length === 0 ? (
                      <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>No vehicles registered for this unit</p>
                    ) : vehicles
                      .filter(v => v.unit?.toLowerCase() === editingResident.unit?.toLowerCase())
                      .map((v, i) => (
                        <div key={i} style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'12px', marginBottom:'8px' }}>
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'6px' }}>
                            <div>
                              <p style={{ color:'white', fontFamily:'Courier New', fontSize:'16px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                              <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{v.color} {v.make} {v.model} {v.year}</p>
                            </div>
                            <div style={{ display:'flex', gap:'6px' }}>
                              <span style={{ background: v.is_active ? '#1a3a1a' : '#3a1a1a', color: v.is_active ? '#4caf50' : '#f44336', padding:'2px 7px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold' }}>
                                {v.is_active ? 'Active' : 'Inactive'}
                              </span>
                            </div>
                          </div>
                          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'6px', fontSize:'11px', marginBottom:'8px' }}>
                            <div><span style={{ color:'#555' }}>Space</span><br/><span style={{ color:'#aaa' }}>{v.space || '—'}</span></div>
                            <div><span style={{ color:'#555' }}>State</span><br/><span style={{ color:'#aaa' }}>{v.state}</span></div>
                            <div><span style={{ color:'#555' }}>Permit Expiry</span><br/><span style={{ color:'#aaa' }}>{v.permit_expiry ? new Date(v.permit_expiry).toLocaleDateString() : '—'}</span></div>
                          </div>
                          <div style={{ display:'flex', gap:'6px' }}>
                            <button
                              onClick={async () => {
                                const space = prompt('Update space assignment:', v.space || '')
                                if (space === null) return
                                await supabase.from('vehicles').update({ space }).eq('id', v.id)
                                fetchVehicles(manager.name)
                              }}
                              style={{ flex:1, padding:'6px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial', fontWeight:'bold' }}>
                              Edit Space
                            </button>
                            <button
                              onClick={async () => {
                                const plate = prompt('Update plate:', v.plate)
                                if (plate === null) return
                                await supabase.from('vehicles').update({ plate: plate.toUpperCase().trim() }).eq('id', v.id)
                                fetchVehicles(manager.name)
                              }}
                              style={{ flex:1, padding:'6px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                              Edit Plate
                            </button>
                            <button
                              onClick={() => removeVehicle(v.id)}
                              style={{ padding:'6px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                              Remove
                            </button>
                          </div>
                        </div>
                      ))
                  }
                </div>
              </div>
            )}

            {residents.length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No residents found for this property</p>
              </div>
            ) : residents.map((r,i) => (
              <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                  <div>
                    <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'0' }}>{r.name}</p>
                    <p style={{ color:'#aaa', fontSize:'12px', margin:'3px 0 0' }}>{r.unit} · {r.email}</p>
                  </div>
                  <div style={{ display:'flex', gap:'6px', alignItems:'center' }}>
                    <span style={{ background: r.is_active ? '#1a3a1a' : '#3a1a1a', color: r.is_active ? '#4caf50' : '#f44336', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold' }}>
                      {r.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'6px', fontSize:'11px', marginBottom:'10px' }}>
                  <div><span style={{ color:'#555' }}>Phone</span><br/><span style={{ color:'#aaa' }}>{r.phone || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Space</span><br/><span style={{ color:'#aaa' }}>{r.space || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Lease End</span><br/><span style={{ color:'#aaa' }}>{r.lease_end ? new Date(r.lease_end).toLocaleDateString() : '—'}</span></div>
                </div>
                <div style={{ display:'flex', gap:'6px' }}>
                  <button onClick={() => setEditingResident(r)}
                    style={{ flex:1, padding:'7px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial', fontWeight:'bold' }}>
                    Edit
                  </button>
                  {r.is_active && (
                    <button onClick={() => deactivateResident(r.id)}
                      style={{ padding:'7px 12px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
                      Deactivate
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {/* VIOLATIONS TAB */}
        {activeTab === 'violations' && (
          <div>
            <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'12px' }}>
              {[{k:'today',l:'Today'},{k:'week',l:'This Week'},{k:'sixmonths',l:'6 Months'}].map(f => (
                <button key={f.k} onClick={() => setViolationFilter(f.k)}
                  style={{ flex:1, padding:'8px', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold',
                    background: violationFilter === f.k ? '#C9A227' : 'transparent',
                    color: violationFilter === f.k ? '#0f1117' : '#888',
                    fontFamily:'Arial' }}>
                  {f.l}
                </button>
              ))}
            </div>
            {filteredViolations().length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No violations for this period</p>
              </div>
            ) : filteredViolations().map((v,i) => (
              <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'8px' }}>
                  <p style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'18px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                  <p style={{ color:'#555', fontSize:'11px', margin:'0' }}>{new Date(v.created_at).toLocaleDateString()}</p>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px', fontSize:'12px' }}>
                  <div><span style={{ color:'#555' }}>Type</span><br/><span style={{ color:'#aaa' }}>{v.violation_type || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Location</span><br/><span style={{ color:'#aaa' }}>{v.location || '—'}</span></div>
                  {v.notes && <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555' }}>Notes</span><br/><span style={{ color:'#aaa' }}>{v.notes}</span></div>}
                </div>
                {v.photos && v.photos.length > 0 && (
                  <div style={{ marginTop:'8px' }}>
                    <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 6px' }}>Photos</p>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'6px' }}>
                      {v.photos.map((url: string, pi: number) => (
                        <a key={pi} href={url} target="_blank" rel="noopener noreferrer">
                          <img src={url} alt={`Photo ${pi+1}`} style={{ width:'100%', aspectRatio:'4/3', objectFit:'cover', borderRadius:'6px', border:'1px solid #2a2f3d' }} />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* VISITORS TAB */}
        {activeTab === 'visitors' && (
          <div>
            {passes.length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No active visitor passes</p>
              </div>
            ) : passes.map((p,i) => (
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
            ))}
          </div>
        )}

        <div style={{ textAlign:'center', marginTop:'20px' }}>
          <a href="/" style={{ color:'#C9A227', fontSize:'12px', textDecoration:'none' }}>← Back to Plate Lookup</a>
        </div>

      </div>
    </main>
  )
}
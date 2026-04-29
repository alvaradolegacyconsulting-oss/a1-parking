'use client'
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

export default function ManagerPortal() {
  const [manager, setManager] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('overview')
  const [vehicles, setVehicles] = useState<any[]>([])
  const [violations, setViolations] = useState<any[]>([])
  const [passes, setPasses] = useState<any[]>([])
  const [residents, setResidents] = useState<any[]>([])
  const [stats, setStats] = useState({ total_vehicles: 0, active_passes: 0, violations_today: 0, violations_week: 0 })
  const [showAddVehicle, setShowAddVehicle] = useState(false)
  const [newVehicle, setNewVehicle] = useState({ plate: '', state: 'TX', make: '', model: '', year: '', color: '', unit: '', space: '', permit_expiry: '' })
  const [violationFilter, setViolationFilter] = useState('today')
  const [showAddResident, setShowAddResident] = useState(false)
  const [newResident, setNewResident] = useState({ name: '', email: '', phone: '', unit: '', space: '', lease_end: '' })
  const [editingResident, setEditingResident] = useState<any>(null)
  const [allProperties, setAllProperties] = useState<any[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [spaces, setSpaces] = useState<any[]>([])
  const [editingSpace, setEditingSpace] = useState<any>(null)
  const [spaceError, setSpaceError] = useState('')
  const [hoveredSpaceId, setHoveredSpaceId] = useState<string | null>(null)
  const [vehicleSearch, setVehicleSearch] = useState('')
  const [residentSearch, setResidentSearch] = useState('')
  const [violationSearch, setViolationSearch] = useState('')

  useEffect(() => { loadManager() }, [])

  async function loadManager() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { window.location.href = '/login'; return }

    const { data: roleData } = await supabase
      .from('user_roles')
      .select('*')
      .ilike('email', user.email!)
      .single()

    if (!roleData) {
      setError('No role assigned. Contact A1 Wrecker.')
      setLoading(false)
      return
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
    } else if (roleData.role === 'manager') {
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
    fetchSpaces(property)
  }

  async function fetchSpaces(property: string) {
    const { data } = await supabase.from('spaces').select('*').ilike('property', property).order('space_number')
    setSpaces(data || [])
  }

  async function saveSpace() {
    if (!editingSpace) return
    setSpaceError('')

    const isOccupied = editingSpace.status === 'occupied'
    const isReleasing = editingSpace.status === 'available'

    if (isOccupied && editingSpace.assigned_to_plate) {
      const conflict = spaces.find(s =>
        s.id !== editingSpace.id &&
        s.status === 'occupied' &&
        s.assigned_to_plate?.toLowerCase() === editingSpace.assigned_to_plate?.toLowerCase()
      )
      if (conflict) {
        setSpaceError(`Space ${conflict.space_number} is already assigned to ${conflict.assigned_to_unit || '—'} - ${conflict.assigned_to_plate}`)
        return
      }
    }

    const updates: any = {
      status: editingSpace.status,
      notes: editingSpace.notes ?? '',
      assigned_to_unit: isReleasing ? null : editingSpace.assigned_to_unit,
      assigned_to_plate: isReleasing ? null : editingSpace.assigned_to_plate,
    }

    const { error } = await supabase.from('spaces').update(updates).eq('id', editingSpace.id)
    if (error) { alert('Error: ' + error.message) }
    else { setEditingSpace(null); fetchSpaces(manager.name) }
  }

  async function fetchVehicles(property: string) {
    const { data } = await supabase.from('vehicles').select('*').ilike('property', property).order('unit')
    setVehicles(data || [])
    setStats(s => ({ ...s, total_vehicles: data?.length || 0 }))
  }

  async function fetchViolations(property: string) {
    const week = new Date(); week.setDate(week.getDate() - 7)
    const { data } = await supabase.from('violations').select('*').ilike('property', property).gte('created_at', week.toISOString()).order('created_at', { ascending: false })
    setViolations(data || [])
    const today = new Date(); today.setHours(0,0,0,0)
    const todayCount = (data || []).filter(v => new Date(v.created_at) >= today).length
    setStats(s => ({ ...s, violations_today: todayCount, violations_week: data?.length || 0 }))
  }

  async function fetchPasses(property: string) {
    const now = new Date().toISOString()

    // visitor_passes has no property column — resolve units for this property first
    const { data: propResidents } = await supabase
      .from('residents')
      .select('unit')
      .ilike('property', property)

    const units = [...new Set((propResidents || []).map((r: any) => r.unit).filter(Boolean))]

    if (units.length === 0) {
      setPasses([])
      setStats(s => ({ ...s, active_passes: 0 }))
      return
    }

    const { data } = await supabase
      .from('visitor_passes')
      .select('*')
      .gte('expires_at', now)
      .eq('is_active', true)
      .in('visiting_unit', units)
      .order('created_at', { ascending: false })

    setPasses(data || [])
    setStats(s => ({ ...s, active_passes: data?.length || 0 }))
  }

  async function fetchResidents(property: string) {
    const { data } = await supabase.from('residents').select('*').ilike('property', property).order('unit')
    setResidents(data || [])
  }

  async function addVehicle(unit?: string) {
    if (!newVehicle.plate) { alert('Plate is required'); return }
    const { error } = await supabase.from('vehicles').insert([{
      ...newVehicle,
      plate: newVehicle.plate.toUpperCase().trim(),
      unit: unit || newVehicle.unit,
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
  }

  async function removeVehicle(id: string) {
    if (!confirm('Remove this vehicle?')) return
    await supabase.from('vehicles').update({ is_active: false }).eq('id', id)
    fetchVehicles(manager.name)
  }

  async function addResident() {
    if (!newResident.name || !newResident.unit || !newResident.email) { alert('Name, email and unit are required'); return }
    const { error } = await supabase.from('residents').insert([{ ...newResident, property: manager.name, is_active: true }])
    if (error) { alert('Error: ' + error.message) }
    else {
      alert('Resident added!')
      setShowAddResident(false)
      setNewResident({ name:'', email:'', phone:'', unit:'', space:'', lease_end:'' })
      fetchResidents(manager.name)
    }
  }

  async function saveResident() {
    const { error } = await supabase.from('residents').update({
      name: editingResident.name,
      email: editingResident.email,
      phone: editingResident.phone,
      unit: editingResident.unit,
      space: editingResident.space,
      lease_end: editingResident.lease_end,
    }).eq('id', editingResident.id)
    if (error) { alert('Error: ' + error.message) }
    else { alert('Resident updated!'); setEditingResident(null); fetchResidents(manager.name) }
  }

  async function deactivateResident(id: string) {
    if (!confirm('Deactivate this resident?')) return
    await supabase.from('residents').update({ is_active: false }).eq('id', id)
    fetchResidents(manager.name)
  }

  function filteredVehicles() {
    if (!vehicleSearch) return vehicles
    const q = vehicleSearch.toLowerCase()
    return vehicles.filter(v =>
      v.plate?.toLowerCase().includes(q) ||
      v.unit?.toLowerCase().includes(q) ||
      v.make?.toLowerCase().includes(q) ||
      v.model?.toLowerCase().includes(q) ||
      v.color?.toLowerCase().includes(q)
    )
  }

  function filteredResidents() {
    if (!residentSearch) return residents
    const q = residentSearch.toLowerCase()
    return residents.filter(r =>
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
      return v.plate?.toLowerCase().includes(q) || v.violation_type?.toLowerCase().includes(q) || v.location?.toLowerCase().includes(q)
    })
  }

  const tabStyle = (tab: string) => ({
    flex:1, padding:'8px', border:'none', borderRadius:'6px',
    cursor:'pointer', fontWeight:'bold' as const, fontSize:'11px',
    background: activeTab === tab ? '#C9A227' : '#1e2535',
    color: activeTab === tab ? '#0f1117' : '#888',
    fontFamily:'Arial, sans-serif'
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
      <div style={{ maxWidth:'600px', margin:'0 auto' }}>

        <div style={{ marginBottom:'16px', textAlign:'center' }}>
          <h1 style={{ color:'#C9A227', fontSize:'22px', fontWeight:'bold', margin:'0' }}>A1 Wrecker, LLC</h1>
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
            </div>
            <button onClick={async () => { await supabase.auth.signOut(); window.location.href = '/login' }}
              style={{ padding:'6px 12px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>
              Sign Out
            </button>
          </div>
        </div>

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

        <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'14px' }}>
          <button style={tabStyle('overview')} onClick={() => setActiveTab('overview')}>Overview</button>
          <button style={tabStyle('vehicles')} onClick={() => setActiveTab('vehicles')}>Vehicles</button>
          <button style={tabStyle('spaces')} onClick={() => setActiveTab('spaces')}>Spaces</button>
          <button style={tabStyle('residents')} onClick={() => setActiveTab('residents')}>Residents</button>
          <button style={tabStyle('violations')} onClick={() => setActiveTab('violations')}>Violations</button>
          <button style={tabStyle('visitors')} onClick={() => setActiveTab('visitors')}>Visitors</button>
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
                  <span style={{ color:'#aaa', fontSize:'12px' }}>{v.violation_type}</span>
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
            <input value={vehicleSearch} onChange={e => setVehicleSearch(e.target.value)} placeholder="Search plate, unit, make, model, color..." style={{ ...inputStyle, marginBottom:'12px' }} />
            <button onClick={() => setShowAddVehicle(!showAddVehicle)}
              style={{ width:'100%', padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', marginBottom:'12px' }}>
              + Add Vehicle
            </button>
            {showAddVehicle && (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Add New Vehicle</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Plate *</label><input value={newVehicle.plate} onChange={e => setNewVehicle({...newVehicle, plate: e.target.value.toUpperCase()})} placeholder="ABC1234" style={{ ...inputStyle, fontFamily:'Courier New', fontSize:'14px', fontWeight:'bold' }} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>State</label><select value={newVehicle.state} onChange={e => setNewVehicle({...newVehicle, state: e.target.value})} style={inputStyle}>{['TX','CA','FL','NY','GA','OH','IL','PA','NC','AZ'].map(s => <option key={s}>{s}</option>)}</select></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Make</label><input value={newVehicle.make} onChange={e => setNewVehicle({...newVehicle, make: e.target.value})} placeholder="Toyota" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Model</label><input value={newVehicle.model} onChange={e => setNewVehicle({...newVehicle, model: e.target.value})} placeholder="Camry" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Year</label><input value={newVehicle.year} onChange={e => setNewVehicle({...newVehicle, year: e.target.value})} placeholder="2022" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Color</label><input value={newVehicle.color} onChange={e => setNewVehicle({...newVehicle, color: e.target.value})} placeholder="Black" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Unit *</label><input value={newVehicle.unit} onChange={e => setNewVehicle({...newVehicle, unit: e.target.value})} placeholder="Apt 214" style={inputStyle} /></div>
                  <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Space</label><input value={newVehicle.space} onChange={e => setNewVehicle({...newVehicle, space: e.target.value})} placeholder="A-12" style={inputStyle} /></div>
                  <div style={{ gridColumn:'span 2' }}><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Permit Expiry</label><input type="date" value={newVehicle.permit_expiry} onChange={e => setNewVehicle({...newVehicle, permit_expiry: e.target.value})} style={inputStyle} /></div>
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
                    <button onClick={() => removeVehicle(v.id)} style={{ padding:'4px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Remove</button>
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
        {activeTab === 'spaces' && (
          <div>
            {spaces.length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No spaces found for this property</p>
              </div>
            ) : (
              <>
                {/* Visual grid */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'14px' }}>
                  <div style={{ display:'flex', gap:'12px', marginBottom:'10px', flexWrap:'wrap' }}>
                    {[{color:'#4caf50', bg:'#1a3a1a', label:'Available'},{color:'#f44336', bg:'#3a1a1a', label:'Occupied'},{color:'#C9A227', bg:'#2a1e00', label:'Reserved'}].map(l => (
                      <div key={l.label} style={{ display:'flex', alignItems:'center', gap:'5px' }}>
                        <div style={{ width:'12px', height:'12px', borderRadius:'3px', background:l.bg, border:`1px solid ${l.color}` }} />
                        <span style={{ color:'#aaa', fontSize:'11px' }}>{l.label}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(52px, 1fr))', gap:'6px' }}>
                    {spaces.map((s) => {
                      const isOccupied = s.status === 'occupied'
                      const isReserved = s.status === 'reserved'
                      const borderColor = isOccupied ? '#f44336' : isReserved ? '#C9A227' : '#4caf50'
                      const bgColor = isOccupied ? '#3a1a1a' : isReserved ? '#2a1e00' : '#1a3a1a'
                      const isHovered = hoveredSpaceId === s.id
                      return (
                        <div key={s.id}
                          onClick={() => setHoveredSpaceId(isHovered ? null : s.id)}
                          style={{ background:bgColor, border:`2px solid ${borderColor}`, borderRadius:'6px', padding:'6px 4px', textAlign:'center', cursor:'pointer', position:'relative', userSelect:'none' }}>
                          <span style={{ color:'white', fontSize:'10px', fontWeight:'bold', display:'block', lineHeight:'1.2' }}>{s.space_number}</span>
                          {isHovered && (isOccupied || isReserved) && (
                            <div style={{ position:'absolute', top:'calc(100% + 4px)', left:'50%', transform:'translateX(-50%)', background:'#0f1117', border:'1px solid #3a4055', borderRadius:'6px', padding:'6px 8px', zIndex:20, minWidth:'110px', pointerEvents:'none' }}>
                              <p style={{ color:'#aaa', fontSize:'10px', margin:'0', whiteSpace:'nowrap' }}>
                                {isOccupied ? `${s.assigned_to_unit || '—'} · ${s.assigned_to_plate || '—'}` : (s.notes || 'Reserved')}
                              </p>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Space list */}
                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', overflow:'hidden' }}>
                  {/* Header row */}
                  <div style={{ display:'grid', gridTemplateColumns:'80px 80px 1fr 1fr 28px', gap:'8px', padding:'8px 12px', borderBottom:'1px solid #2a2f3d', background:'#1e2535' }}>
                    {['Space','Status','Unit','Plate',''].map((h,i) => (
                      <span key={i} style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.06em' }}>{h}</span>
                    ))}
                  </div>

                  {spaces.map((s) => (
                    <div key={s.id}>
                      <div style={{ display:'grid', gridTemplateColumns:'80px 80px 1fr 1fr 28px', gap:'8px', padding:'10px 12px', borderBottom:'1px solid #1e2535', alignItems:'center' }}>
                        <span style={{ color:'white', fontWeight:'bold', fontSize:'12px', fontFamily:'Courier New' }}>{s.space_number}</span>
                        <span style={{
                          fontSize:'10px', fontWeight:'bold', padding:'2px 7px', borderRadius:'8px', textAlign:'center',
                          background: s.status === 'occupied' ? '#3a1a1a' : s.status === 'reserved' ? '#2a1e00' : '#1a3a1a',
                          color: s.status === 'occupied' ? '#f44336' : s.status === 'reserved' ? '#C9A227' : '#4caf50',
                        }}>{s.status}</span>
                        <span style={{ color:'#aaa', fontSize:'12px' }}>{s.assigned_to_unit || '—'}</span>
                        <span style={{ color:'#aaa', fontSize:'12px', fontFamily: s.assigned_to_plate ? 'Courier New' : undefined }}>{s.assigned_to_plate || '—'}</span>
                        <button
                          onClick={() => { setEditingSpace({ ...s }); setSpaceError('') }}
                          style={{ padding:'3px 7px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'5px', cursor:'pointer', fontSize:'10px', fontWeight:'bold', fontFamily:'Arial' }}>
                          Edit
                        </button>
                      </div>

                      {/* Inline edit form */}
                      {editingSpace?.id === s.id && (
                        <div style={{ background:'#0f1117', borderBottom:'1px solid #2a2f3d', padding:'14px 12px' }}>
                          <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', margin:'0 0 12px' }}>Editing Space {s.space_number}</p>

                          {spaceError && (
                            <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}>
                              <p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{spaceError}</p>
                            </div>
                          )}

                          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Status</label>
                          <select
                            value={editingSpace.status}
                            onChange={e => setEditingSpace({ ...editingSpace, status: e.target.value })}
                            style={inputStyle}>
                            <option value='available'>Available</option>
                            <option value='occupied'>Occupied</option>
                            <option value='reserved'>Reserved</option>
                          </select>

                          {editingSpace.status !== 'available' && (
                            <>
                              <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Assigned Unit</label>
                              <input
                                value={editingSpace.assigned_to_unit || ''}
                                onChange={e => setEditingSpace({ ...editingSpace, assigned_to_unit: e.target.value })}
                                placeholder="Apt 214"
                                style={inputStyle} />

                              <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Assigned Plate</label>
                              <select
                                value={editingSpace.assigned_to_plate || ''}
                                onChange={e => setEditingSpace({ ...editingSpace, assigned_to_plate: e.target.value })}
                                style={inputStyle}>
                                <option value=''>Select plate...</option>
                                {vehicles.filter(v => v.is_active).map((v, i) => (
                                  <option key={i} value={v.plate}>{v.plate} — {v.unit} ({v.color} {v.make})</option>
                                ))}
                              </select>
                            </>
                          )}

                          <label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Notes</label>
                          <input
                            value={editingSpace.notes || ''}
                            onChange={e => setEditingSpace({ ...editingSpace, notes: e.target.value })}
                            placeholder="Optional notes"
                            style={inputStyle} />

                          <div style={{ display:'flex', gap:'8px', marginTop:'4px' }}>
                            <button onClick={saveSpace} style={{ flex:1, padding:'9px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'12px', border:'none', borderRadius:'7px', cursor:'pointer' }}>Save</button>
                            <button onClick={() => { setEditingSpace(null); setSpaceError('') }} style={{ padding:'9px 12px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'7px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
                          </div>
                        </div>
                      )}

                      {/* Notes row if no edit open */}
                      {editingSpace?.id !== s.id && s.notes && (
                        <div style={{ padding:'4px 12px 8px', borderBottom:'1px solid #1e2535' }}>
                          <span style={{ color:'#555', fontSize:'10px' }}>{s.notes}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* RESIDENTS */}
        {activeTab === 'residents' && (
          <div>
            <input value={residentSearch} onChange={e => setResidentSearch(e.target.value)} placeholder="Search name, email, unit, phone..." style={{ ...inputStyle, marginBottom:'12px' }} />
            <button onClick={() => setShowAddResident(!showAddResident)}
              style={{ width:'100%', padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', marginBottom:'12px' }}>
              + Add Resident
            </button>
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
                </div>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={addResident} style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>Add Resident</button>
                  <button onClick={() => setShowAddResident(false)} style={{ padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }}>Cancel</button>
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
                    <button onClick={() => setShowAddVehicle(true)} style={{ padding:'5px 10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'11px', border:'none', borderRadius:'6px', cursor:'pointer', fontFamily:'Arial' }}>+ Add Vehicle</button>
                  </div>
                  {showAddVehicle && (
                    <div style={{ background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', padding:'12px', marginBottom:'10px' }}>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Plate *</label><input value={newVehicle.plate} onChange={e => setNewVehicle({...newVehicle, plate: e.target.value.toUpperCase()})} placeholder="ABC1234" style={{ ...inputStyle, fontFamily:'Courier New', fontSize:'14px', fontWeight:'bold' }} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>State</label><select value={newVehicle.state} onChange={e => setNewVehicle({...newVehicle, state: e.target.value})} style={inputStyle}>{['TX','CA','FL','NY','GA','OH','IL','PA','NC','AZ'].map(s => <option key={s}>{s}</option>)}</select></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Make</label><input value={newVehicle.make} onChange={e => setNewVehicle({...newVehicle, make: e.target.value})} placeholder="Toyota" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Model</label><input value={newVehicle.model} onChange={e => setNewVehicle({...newVehicle, model: e.target.value})} placeholder="Camry" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Year</label><input value={newVehicle.year} onChange={e => setNewVehicle({...newVehicle, year: e.target.value})} placeholder="2022" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Color</label><input value={newVehicle.color} onChange={e => setNewVehicle({...newVehicle, color: e.target.value})} placeholder="Black" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Space</label><input value={newVehicle.space} onChange={e => setNewVehicle({...newVehicle, space: e.target.value})} placeholder="A-12" style={inputStyle} /></div>
                        <div><label style={{ color:'#aaa', fontSize:'10px', textTransform:'uppercase' }}>Permit Expiry</label><input type="date" value={newVehicle.permit_expiry} onChange={e => setNewVehicle({...newVehicle, permit_expiry: e.target.value})} style={inputStyle} /></div>
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
                          <button onClick={async () => { const plate = prompt('Update plate:', v.plate); if (plate === null) return; await supabase.from('vehicles').update({ plate: plate.toUpperCase().trim() }).eq('id', v.id); fetchVehicles(manager.name) }}
                            style={{ flex:1, padding:'6px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Edit Plate</button>
                          <button onClick={() => removeVehicle(v.id)}
                            style={{ padding:'6px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Remove</button>
                        </div>
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
                <div style={{ display:'flex', gap:'6px' }}>
                  <button onClick={() => { setEditingResident(r); setShowAddVehicle(false) }}
                    style={{ flex:1, padding:'7px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial', fontWeight:'bold' }}>Edit</button>
                  {r.is_active && <button onClick={() => deactivateResident(r.id)}
                    style={{ padding:'7px 12px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }}>Deactivate</button>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* VIOLATIONS */}
        {activeTab === 'violations' && (
          <div>
            <div style={{ background:'#1a2a1a', border:'1px solid #2e7d32', borderRadius:'8px', padding:'12px 14px', marginBottom:'12px' }}>
              <p style={{ color:'#4caf50', fontWeight:'bold', fontSize:'12px', margin:'0 0 2px' }}>View Only</p>
              <p style={{ color:'#aaa', fontSize:'12px', margin:'0', lineHeight:'1.5' }}>Violations are filed by A1 Wrecker drivers. Contact A1 Wrecker to report an issue.</p>
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
                </div>
              ))
            }
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


      </div>
    </main>
  )
}
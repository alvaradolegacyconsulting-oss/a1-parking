'use client'
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

export default function AdminPortal() {
  const [adminEmail, setAdminEmail] = useState('')
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('companies')

  const [companies, setCompanies] = useState<any[]>([])
  const [companySearch, setCompanySearch] = useState('')
  const [showAddCompany, setShowAddCompany] = useState(false)
  const [editingCompany, setEditingCompany] = useState<any>(null)
  const [newCompany, setNewCompany] = useState({ name:'', address:'', phone:'', email:'', is_active:true })

  const [properties, setProperties] = useState<any[]>([])
  const [propertySearch, setPropertySearch] = useState('')
  const [showAddProperty, setShowAddProperty] = useState(false)
  const [editingProperty, setEditingProperty] = useState<any>(null)
  const [newProperty, setNewProperty] = useState({ name:'', company:'', address:'', city:'', state:'TX', zip:'', total_spaces:'', pm_name:'', pm_phone:'', pm_email:'', is_active:true })

  const [users, setUsers] = useState<any[]>([])
  const [userSearch, setUserSearch] = useState('')
  const [showAddUser, setShowAddUser] = useState(false)
  const [newUser, setNewUser] = useState({ email:'', password:'', role:'manager', company:'', property:'' })
  const [userMsg, setUserMsg] = useState('')

  const [drivers, setDrivers] = useState<any[]>([])
  const [driverSearch, setDriverSearch] = useState('')
  const [showAddDriver, setShowAddDriver] = useState(false)
  const [editingDriver, setEditingDriver] = useState<any>(null)
  const [newDriver, setNewDriver] = useState({ name:'', email:'', phone:'', company:'', operator_license:'', assigned_properties:'', is_active:true })
  const [driverMsg, setDriverMsg] = useState('')

  const [facilities, setFacilities] = useState<any[]>([])
  const [facilitySearch, setFacilitySearch] = useState('')
  const [showAddFacility, setShowAddFacility] = useState(false)
  const [editingFacility, setEditingFacility] = useState<any>(null)
  const [newFacility, setNewFacility] = useState({ name:'', address:'', phone:'', email:'', is_active:true })

  const [allAuditLogs, setAllAuditLogs] = useState<any[]>([])
  const [auditDateFilter, setAuditDateFilter] = useState('week')
  const [auditSearch, setAuditSearch] = useState('')
  const [auditLoaded, setAuditLoaded] = useState(false)

  useEffect(() => { loadAdmin() }, [])
  useEffect(() => { if (activeTab === 'auditlog') fetchAuditLogs() }, [activeTab])

  async function loadAdmin() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { window.location.href = '/login'; return }

    const { data: roleData } = await supabase.from('user_roles').select('role').ilike('email', user.email!).single()
    if (!roleData || roleData.role !== 'admin') { window.location.href = '/login'; return }

    setAdminEmail(user.email!)
    await Promise.all([fetchCompanies(), fetchProperties(), fetchUsers(), fetchDrivers(), fetchFacilities()])
    setLoading(false)
  }

  async function auditLog(email: string, action: string, table_name: string, record_id: any, new_values: any) {
    await supabase.from('audit_logs').insert([{
      user_email: email,
      action,
      table_name,
      record_id: String(record_id),
      new_values,
      created_at: new Date().toISOString()
    }])
  }

  async function fetchAuditLogs() {
    setAuditLoaded(false)
    const { data } = await supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
    setAllAuditLogs(data || [])
    setAuditLoaded(true)
  }

  async function fetchCompanies() {
    const { data } = await supabase.from('companies').select('*').order('name')
    setCompanies(data || [])
  }

  async function addCompany() {
    if (!newCompany.name) { alert('Name is required'); return }
    const { data, error } = await supabase.from('companies').insert([newCompany]).select().single()
    if (error) { alert('Error: ' + error.message); return }
    await auditLog(adminEmail, 'ADD_COMPANY', 'companies', data.id, newCompany)
    setShowAddCompany(false)
    setNewCompany({ name:'', address:'', phone:'', email:'', is_active:true })
    fetchCompanies()
  }

  async function saveCompany() {
    const { error } = await supabase.from('companies').update({
      name: editingCompany.name, address: editingCompany.address,
      phone: editingCompany.phone, email: editingCompany.email, is_active: editingCompany.is_active
    }).eq('id', editingCompany.id)
    if (error) { alert('Error: ' + error.message); return }
    await auditLog(adminEmail, 'EDIT_COMPANY', 'companies', editingCompany.id, editingCompany)
    setEditingCompany(null)
    fetchCompanies()
  }

  async function toggleCompany(c: any, active: boolean) {
    await supabase.from('companies').update({ is_active: active }).eq('id', c.id)
    await auditLog(adminEmail, active ? 'ACTIVATE_COMPANY' : 'DEACTIVATE_COMPANY', 'companies', c.id, { is_active: active })
    fetchCompanies()
  }

  async function fetchProperties() {
    const { data } = await supabase.from('properties').select('*').order('name')
    setProperties(data || [])
  }

  async function addProperty() {
    if (!newProperty.name) { alert('Name is required'); return }
    const payload = { ...newProperty, total_spaces: parseInt(newProperty.total_spaces) || null }
    const { data, error } = await supabase.from('properties').insert([payload]).select().single()
    if (error) { alert('Error: ' + error.message); return }
    await auditLog(adminEmail, 'ADD_PROPERTY', 'properties', data.id, payload)
    setShowAddProperty(false)
    setNewProperty({ name:'', company:'', address:'', city:'', state:'TX', zip:'', total_spaces:'', pm_name:'', pm_phone:'', pm_email:'', is_active:true })
    fetchProperties()
  }

  async function saveProperty() {
    const payload = { ...editingProperty, total_spaces: parseInt(editingProperty.total_spaces) || null }
    const { error } = await supabase.from('properties').update(payload).eq('id', editingProperty.id)
    if (error) { alert('Error: ' + error.message); return }
    await auditLog(adminEmail, 'EDIT_PROPERTY', 'properties', editingProperty.id, payload)
    setEditingProperty(null)
    fetchProperties()
  }

  async function fetchUsers() {
    const { data } = await supabase.from('user_roles').select('*').order('email')
    setUsers(data || [])
  }

  async function addUser() {
    if (!newUser.email || !newUser.password) { setUserMsg('Email and password are required'); return }
    setUserMsg('Creating account...')
    const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL
    console.log('Functions URL env:', fnBase)
    const { data: { session } } = await supabase.auth.getSession()
    const url = (fnBase ?? '') + '/swift-handler'
    const reqBody = JSON.stringify({ action: 'create_user', email: newUser.email, password: newUser.password })
    console.log('Edge function URL:', url)
    console.log('Request body:', reqBody)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: reqBody
      })
      console.log('Response status:', res.status)
      const text = await res.text()
      console.log('Response text:', text)
      const err = (() => { try { return JSON.parse(text) } catch { return {} } })()
      if (!res.ok) { setUserMsg('Auth error: ' + (err.error || err.message || res.statusText)); return }
    } catch (e: any) { console.log('Fetch threw:', e); setUserMsg('Error: ' + e.message); return }
    const propertyArray = newUser.property
      ? newUser.property.split('|').map(p => p.trim()).filter(Boolean)
      : []
    console.log('propertyArray type:', typeof propertyArray, 'value:', JSON.stringify(propertyArray), 'isArray:', Array.isArray(propertyArray))
    const { error: roleError } = await supabase
      .from('user_roles')
      .insert([{
        email: newUser.email.trim(),
        role: newUser.role,
        company: newUser.company.trim() || null,
        property: propertyArray.length > 0 ? propertyArray : null
      }])
    if (roleError) { setUserMsg('Auth created but role insert failed: ' + roleError.message); return }
    await auditLog(adminEmail, 'ADD_USER', 'user_roles', newUser.email, { email: newUser.email, role: newUser.role })
    setUserMsg('User created successfully!')
    setNewUser({ email:'', password:'', role:'manager', company:'', property:'' })
    fetchUsers()
  }

  async function fetchDrivers() {
    const { data } = await supabase.from('drivers').select('*').order('name')
    setDrivers(data || [])
  }

  async function addDriver() {
    if (!newDriver.name || !newDriver.email) { setDriverMsg('Name and email are required'); return }
    setDriverMsg('Creating driver...')
    const fnBase = process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL
    const { data: { session } } = await supabase.auth.getSession()
    const tempPass = Math.random().toString(36).slice(-8) + 'A1!'
    try {
      const res = await fetch(fnBase + '/swift-handler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'create_user', email: newDriver.email, password: tempPass })
      })
      const err = await res.json().catch(() => ({}))
      if (!res.ok) { setDriverMsg('Auth error: ' + (err.error || err.message || res.statusText)); return }
    } catch (e: any) { setDriverMsg('Error: ' + e.message); return }
    const assignedPropsArray = typeof newDriver.assigned_properties === 'string'
      ? newDriver.assigned_properties.split('|').map(p => p.trim()).filter(Boolean)
      : newDriver.assigned_properties || []
    const { data, error } = await supabase.from('drivers').insert([{ ...newDriver, assigned_properties: assignedPropsArray }]).select().single()
    if (error) { setDriverMsg('Error: ' + error.message); return }
    await supabase.from('user_roles').insert([{ email: newDriver.email, role: 'driver', company: newDriver.company || null }])
    await auditLog(adminEmail, 'ADD_DRIVER', 'drivers', data.id, newDriver)
    setDriverMsg(`Driver created! Temp password: ${tempPass}`)
    setNewDriver({ name:'', email:'', phone:'', company:'', operator_license:'', assigned_properties:'', is_active:true })
    setShowAddDriver(false)
    fetchDrivers()
  }

  async function saveDriver() {
    const { error } = await supabase.from('drivers').update({
      name: editingDriver.name, phone: editingDriver.phone, company: editingDriver.company,
      operator_license: editingDriver.operator_license,
      assigned_properties: typeof editingDriver.assigned_properties === 'string'
        ? editingDriver.assigned_properties.split('|').map((p: string) => p.trim()).filter(Boolean)
        : editingDriver.assigned_properties || [],
      is_active: editingDriver.is_active
    }).eq('id', editingDriver.id)
    if (error) { alert('Error: ' + error.message); return }
    await auditLog(adminEmail, 'EDIT_DRIVER', 'drivers', editingDriver.id, editingDriver)
    setEditingDriver(null)
    fetchDrivers()
  }

  async function toggleDriver(d: any, active: boolean) {
    await supabase.from('drivers').update({ is_active: active }).eq('id', d.id)
    await auditLog(adminEmail, active ? 'ACTIVATE_DRIVER' : 'DEACTIVATE_DRIVER', 'drivers', d.id, { is_active: active })
    fetchDrivers()
  }

  async function fetchFacilities() {
    const { data } = await supabase.from('storage_facilities').select('*').order('name')
    setFacilities(data || [])
  }

  async function addFacility() {
    if (!newFacility.name) { alert('Name is required'); return }
    const { data, error } = await supabase.from('storage_facilities').insert([newFacility]).select().single()
    if (error) { alert('Error: ' + error.message); return }
    await auditLog(adminEmail, 'ADD_FACILITY', 'storage_facilities', data.id, newFacility)
    setShowAddFacility(false)
    setNewFacility({ name:'', address:'', phone:'', email:'', is_active:true })
    fetchFacilities()
  }

  async function saveFacility() {
    const { error } = await supabase.from('storage_facilities').update({
      name: editingFacility.name, address: editingFacility.address,
      phone: editingFacility.phone, email: editingFacility.email, is_active: editingFacility.is_active
    }).eq('id', editingFacility.id)
    if (error) { alert('Error: ' + error.message); return }
    await auditLog(adminEmail, 'EDIT_FACILITY', 'storage_facilities', editingFacility.id, editingFacility)
    setEditingFacility(null)
    fetchFacilities()
  }

  async function toggleFacility(f: any, active: boolean) {
    await supabase.from('storage_facilities').update({ is_active: active }).eq('id', f.id)
    await auditLog(adminEmail, active ? 'ACTIVATE_FACILITY' : 'DEACTIVATE_FACILITY', 'storage_facilities', f.id, { is_active: active })
    fetchFacilities()
  }

  const fC = () => { const q = companySearch.toLowerCase(); return companySearch ? companies.filter(c => c.name?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q)) : companies }
  const fP = () => { const q = propertySearch.toLowerCase(); return propertySearch ? properties.filter(p => p.name?.toLowerCase().includes(q) || p.company?.toLowerCase().includes(q) || p.city?.toLowerCase().includes(q)) : properties }
  const fU = () => { const q = userSearch.toLowerCase(); return userSearch ? users.filter(u => u.email?.toLowerCase().includes(q) || u.role?.toLowerCase().includes(q) || u.company?.toLowerCase().includes(q)) : users }
  const fD = () => { const q = driverSearch.toLowerCase(); return driverSearch ? drivers.filter(d => d.name?.toLowerCase().includes(q) || d.email?.toLowerCase().includes(q) || d.company?.toLowerCase().includes(q)) : drivers }
  const fF = () => { const q = facilitySearch.toLowerCase(); return facilitySearch ? facilities.filter(f => f.name?.toLowerCase().includes(q) || f.address?.toLowerCase().includes(q)) : facilities }

  const tabSt = (t: string): React.CSSProperties => ({
    flex:1, padding:'8px 2px', border:'none', borderRadius:'6px',
    cursor:'pointer', fontWeight:'bold', fontSize:'10px',
    background: activeTab === t ? '#C9A227' : '#1e2535',
    color: activeTab === t ? '#0f1117' : '#888', fontFamily:'Arial'
  })
  const inp: React.CSSProperties = {
    display:'block', width:'100%', marginTop:'6px', marginBottom:'10px',
    padding:'9px 10px', background:'#1e2535', border:'1px solid #3a4055',
    borderRadius:'6px', color:'white', fontSize:'12px', boxSizing:'border-box', outline:'none'
  }
  const bGold: React.CSSProperties = { padding:'10px 14px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }
  const bGray: React.CSSProperties = { padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'13px', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontFamily:'Arial' }
  const bRed: React.CSSProperties = { padding:'6px 10px', background:'#3a1a1a', color:'#f44336', border:'1px solid #b71c1c', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }
  const bGrn: React.CSSProperties = { padding:'6px 10px', background:'#1a3a1a', color:'#4caf50', border:'1px solid #2e7d32', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontFamily:'Arial' }
  const lbl: React.CSSProperties = { color:'#aaa', fontSize:'10px', textTransform:'uppercase' as const }
  const badge = (active: boolean) => ({ background: active ? '#1a3a1a' : '#3a1a1a', color: active ? '#4caf50' : '#f44336', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold' as const })
  const editBtn: React.CSSProperties = { flex:1, padding:'6px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'bold', fontFamily:'Arial' }
  const card: React.CSSProperties = { background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'8px' }
  const addCard: React.CSSProperties = { background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'12px' }
  const editCard: React.CSSProperties = { background:'#161b26', border:'1px solid #C9A227', borderRadius:'10px', padding:'16px', marginBottom:'12px' }

  if (loading) return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial' }}>
      <p style={{ color:'#888' }}>Loading...</p>
    </main>
  )

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'700px', margin:'0 auto' }}>

        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'20px' }}>
          <div>
            <h1 style={{ color:'#C9A227', fontSize:'22px', fontWeight:'bold', margin:'0' }}>A1 Wrecker, LLC</h1>
            <p style={{ color:'#888', fontSize:'12px', margin:'4px 0 0' }}>Super Admin · {adminEmail}</p>
          </div>
          <button onClick={async () => { await supabase.auth.signOut(); window.location.href = '/login' }}
            style={{ padding:'6px 12px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'11px' }}>
            Sign Out
          </button>
        </div>

        <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'16px' }}>
          {[['companies','Companies'],['properties','Properties'],['users','Users & Roles'],['drivers','Drivers'],['facilities','Facilities'],['auditlog','Audit Log']].map(([k,l]) => (
            <button key={k} style={tabSt(k)} onClick={() => setActiveTab(k)}>{l}</button>
          ))}
        </div>

        {/* ── COMPANIES ── */}
        {activeTab === 'companies' && (
          <div>
            <input value={companySearch} onChange={e => setCompanySearch(e.target.value)} placeholder="Search companies..." style={{ ...inp, marginBottom:'12px' }} />
            <button onClick={() => { setShowAddCompany(!showAddCompany); setEditingCompany(null) }} style={{ ...bGold, width:'100%', marginBottom:'12px' }}>+ Add Company</button>

            {showAddCompany && !editingCompany && (
              <div style={addCard}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Company</p>
                <label style={lbl}>Name *</label><input value={newCompany.name} onChange={e => setNewCompany({...newCompany, name: e.target.value})} style={inp} />
                <label style={lbl}>Address</label><input value={newCompany.address} onChange={e => setNewCompany({...newCompany, address: e.target.value})} style={inp} />
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div><label style={lbl}>Phone</label><input value={newCompany.phone} onChange={e => setNewCompany({...newCompany, phone: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Email</label><input value={newCompany.email} onChange={e => setNewCompany({...newCompany, email: e.target.value})} style={inp} /></div>
                </div>
                <label style={lbl}>Active</label>
                <select value={newCompany.is_active ? 'true' : 'false'} onChange={e => setNewCompany({...newCompany, is_active: e.target.value === 'true'})} style={inp}>
                  <option value="true">Yes</option><option value="false">No</option>
                </select>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={addCompany} style={{ ...bGold, flex:1 }}>Add Company</button>
                  <button onClick={() => setShowAddCompany(false)} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {editingCompany && (
              <div style={editCard}>
                <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Editing — {editingCompany.name}</p>
                <label style={lbl}>Name *</label><input value={editingCompany.name} onChange={e => setEditingCompany({...editingCompany, name: e.target.value})} style={inp} />
                <label style={lbl}>Address</label><input value={editingCompany.address || ''} onChange={e => setEditingCompany({...editingCompany, address: e.target.value})} style={inp} />
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div><label style={lbl}>Phone</label><input value={editingCompany.phone || ''} onChange={e => setEditingCompany({...editingCompany, phone: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Email</label><input value={editingCompany.email || ''} onChange={e => setEditingCompany({...editingCompany, email: e.target.value})} style={inp} /></div>
                </div>
                <label style={lbl}>Active</label>
                <select value={editingCompany.is_active ? 'true' : 'false'} onChange={e => setEditingCompany({...editingCompany, is_active: e.target.value === 'true'})} style={inp}>
                  <option value="true">Yes</option><option value="false">No</option>
                </select>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={saveCompany} style={{ ...bGold, flex:1 }}>Save Changes</button>
                  <button onClick={() => setEditingCompany(null)} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {fC().map((c, i) => (
              <div key={i} style={card}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                  <div>
                    <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'0' }}>{c.name}</p>
                    <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{[c.email, c.phone].filter(Boolean).join(' · ') || '—'}</p>
                  </div>
                  <span style={badge(c.is_active)}>{c.is_active ? 'Active' : 'Inactive'}</span>
                </div>
                {c.address && <p style={{ color:'#555', fontSize:'11px', margin:'0 0 10px' }}>{c.address}</p>}
                <div style={{ display:'flex', gap:'6px' }}>
                  <button onClick={() => { setEditingCompany({...c}); setShowAddCompany(false) }} style={editBtn}>Edit</button>
                  {c.is_active ? <button onClick={() => toggleCompany(c, false)} style={bRed}>Deactivate</button>
                               : <button onClick={() => toggleCompany(c, true)} style={bGrn}>Activate</button>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── PROPERTIES ── */}
        {activeTab === 'properties' && (
          <div>
            <input value={propertySearch} onChange={e => setPropertySearch(e.target.value)} placeholder="Search properties..." style={{ ...inp, marginBottom:'12px' }} />
            <button onClick={() => { setShowAddProperty(!showAddProperty); setEditingProperty(null) }} style={{ ...bGold, width:'100%', marginBottom:'12px' }}>+ Add Property</button>

            {showAddProperty && !editingProperty && (
              <div style={addCard}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Property</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Property Name *</label><input value={newProperty.name} onChange={e => setNewProperty({...newProperty, name: e.target.value})} style={inp} /></div>
                  <div style={{ gridColumn:'span 2' }}>
                    <label style={lbl}>Company</label>
                    <select value={newProperty.company} onChange={e => setNewProperty({...newProperty, company: e.target.value})} style={inp}>
                      <option value=''>None</option>
                      {companies.map((c,i) => <option key={i} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Address</label><input value={newProperty.address} onChange={e => setNewProperty({...newProperty, address: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>City</label><input value={newProperty.city} onChange={e => setNewProperty({...newProperty, city: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>State</label><input value={newProperty.state} onChange={e => setNewProperty({...newProperty, state: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Zip</label><input value={newProperty.zip} onChange={e => setNewProperty({...newProperty, zip: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Total Spaces</label><input type="number" value={newProperty.total_spaces} onChange={e => setNewProperty({...newProperty, total_spaces: e.target.value})} style={inp} /></div>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>PM Name</label><input value={newProperty.pm_name} onChange={e => setNewProperty({...newProperty, pm_name: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>PM Phone</label><input value={newProperty.pm_phone} onChange={e => setNewProperty({...newProperty, pm_phone: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>PM Email</label><input value={newProperty.pm_email} onChange={e => setNewProperty({...newProperty, pm_email: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Active</label><select value={newProperty.is_active ? 'true' : 'false'} onChange={e => setNewProperty({...newProperty, is_active: e.target.value === 'true'})} style={inp}><option value="true">Yes</option><option value="false">No</option></select></div>
                </div>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={addProperty} style={{ ...bGold, flex:1 }}>Add Property</button>
                  <button onClick={() => setShowAddProperty(false)} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {editingProperty && (
              <div style={editCard}>
                <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Editing — {editingProperty.name}</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Property Name *</label><input value={editingProperty.name || ''} onChange={e => setEditingProperty({...editingProperty, name: e.target.value})} style={inp} /></div>
                  <div style={{ gridColumn:'span 2' }}>
                    <label style={lbl}>Company</label>
                    <select value={editingProperty.company || ''} onChange={e => setEditingProperty({...editingProperty, company: e.target.value})} style={inp}>
                      <option value=''>None</option>
                      {companies.map((c,i) => <option key={i} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Address</label><input value={editingProperty.address || ''} onChange={e => setEditingProperty({...editingProperty, address: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>City</label><input value={editingProperty.city || ''} onChange={e => setEditingProperty({...editingProperty, city: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>State</label><input value={editingProperty.state || ''} onChange={e => setEditingProperty({...editingProperty, state: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Zip</label><input value={editingProperty.zip || ''} onChange={e => setEditingProperty({...editingProperty, zip: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Total Spaces</label><input type="number" value={editingProperty.total_spaces || ''} onChange={e => setEditingProperty({...editingProperty, total_spaces: e.target.value})} style={inp} /></div>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>PM Name</label><input value={editingProperty.pm_name || ''} onChange={e => setEditingProperty({...editingProperty, pm_name: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>PM Phone</label><input value={editingProperty.pm_phone || ''} onChange={e => setEditingProperty({...editingProperty, pm_phone: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>PM Email</label><input value={editingProperty.pm_email || ''} onChange={e => setEditingProperty({...editingProperty, pm_email: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Active</label><select value={editingProperty.is_active ? 'true' : 'false'} onChange={e => setEditingProperty({...editingProperty, is_active: e.target.value === 'true'})} style={inp}><option value="true">Yes</option><option value="false">No</option></select></div>
                </div>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={saveProperty} style={{ ...bGold, flex:1 }}>Save Changes</button>
                  <button onClick={() => setEditingProperty(null)} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {fP().map((p, i) => (
              <div key={i} style={card}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'6px' }}>
                  <div>
                    <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'0' }}>{p.name}</p>
                    <p style={{ color:'#C9A227', fontSize:'11px', margin:'3px 0 0' }}>{p.company || 'No company'}</p>
                  </div>
                  <span style={badge(p.is_active)}>{p.is_active ? 'Active' : 'Inactive'}</span>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'6px', fontSize:'11px', marginBottom:'10px' }}>
                  <div><span style={{ color:'#555' }}>Address</span><br/><span style={{ color:'#aaa' }}>{[p.address, p.city, p.state].filter(Boolean).join(', ') || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>Spaces</span><br/><span style={{ color:'#aaa' }}>{p.total_spaces || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>PM</span><br/><span style={{ color:'#aaa' }}>{p.pm_name || '—'}</span></div>
                </div>
                <button onClick={() => { setEditingProperty({...p}); setShowAddProperty(false) }} style={{ ...editBtn, width:'100%' }}>Edit</button>
              </div>
            ))}
          </div>
        )}

        {/* ── USERS & ROLES ── */}
        {activeTab === 'users' && (
          <div>
            <input value={userSearch} onChange={e => setUserSearch(e.target.value)} placeholder="Search email, role, company..." style={{ ...inp, marginBottom:'12px' }} />
            <button onClick={() => { setShowAddUser(!showAddUser); setUserMsg('') }} style={{ ...bGold, width:'100%', marginBottom:'12px' }}>+ Add User</button>

            {showAddUser && (
              <div style={addCard}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New User Account</p>
                <label style={lbl}>Email *</label>
                <input type="email" value={newUser.email} onChange={e => setNewUser({...newUser, email: e.target.value})} placeholder="user@example.com" style={inp} />
                <label style={lbl}>Password *</label>
                <input type="password" value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} placeholder="Min 8 characters" style={inp} />
                <label style={lbl}>Role</label>
                <select value={newUser.role} onChange={e => setNewUser({...newUser, role: e.target.value})} style={inp}>
                  {['admin','company_admin','manager','driver','resident'].map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <label style={lbl}>Company</label>
                <select value={newUser.company} onChange={e => setNewUser({...newUser, company: e.target.value})} style={inp}>
                  <option value=''>None</option>
                  {companies.map((c,i) => <option key={i} value={c.name}>{c.name}</option>)}
                </select>
                <label style={lbl}>Property (pipe-separated for multiple)</label>
                <input value={newUser.property} onChange={e => setNewUser({...newUser, property: e.target.value})} placeholder="Property A|Property B" style={inp} />
                {userMsg && (
                  <div style={{ background: userMsg.includes('success') ? '#1a3a1a' : '#3a1a1a', border:`1px solid ${userMsg.includes('success') ? '#2e7d32' : '#b71c1c'}`, borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}>
                    <p style={{ color: userMsg.includes('success') ? '#4caf50' : '#f44336', fontSize:'12px', margin:'0' }}>{userMsg}</p>
                  </div>
                )}
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={addUser} style={{ ...bGold, flex:1 }}>Create User</button>
                  <button onClick={() => { setShowAddUser(false); setUserMsg('') }} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {fU().map((u, i) => (
              <div key={i} style={card}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                  <div>
                    <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:'0' }}>{u.email}</p>
                    <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{u.company || 'No company'}</p>
                  </div>
                  <span style={{ background:'#1e2535', color:'#C9A227', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold', border:'1px solid #C9A227' }}>{u.role}</span>
                </div>
                {u.property && <p style={{ color:'#555', fontSize:'11px', margin:'6px 0 0' }}>Properties: {u.property}</p>}
              </div>
            ))}
          </div>
        )}

        {/* ── DRIVERS ── */}
        {activeTab === 'drivers' && (
          <div>
            <input value={driverSearch} onChange={e => setDriverSearch(e.target.value)} placeholder="Search name, email, company..." style={{ ...inp, marginBottom:'12px' }} />
            <button onClick={() => { setShowAddDriver(!showAddDriver); setEditingDriver(null); setDriverMsg('') }} style={{ ...bGold, width:'100%', marginBottom:'12px' }}>+ Add Driver</button>

            {showAddDriver && !editingDriver && (
              <div style={addCard}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Driver</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Full Name *</label><input value={newDriver.name} onChange={e => setNewDriver({...newDriver, name: e.target.value})} style={inp} /></div>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Email *</label><input value={newDriver.email} onChange={e => setNewDriver({...newDriver, email: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Phone</label><input value={newDriver.phone} onChange={e => setNewDriver({...newDriver, phone: e.target.value})} style={inp} /></div>
                  <div>
                    <label style={lbl}>Company</label>
                    <select value={newDriver.company} onChange={e => setNewDriver({...newDriver, company: e.target.value})} style={inp}>
                      <option value=''>None</option>
                      {companies.map((c,i) => <option key={i} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                  <div><label style={lbl}>Operator License</label><input value={newDriver.operator_license} onChange={e => setNewDriver({...newDriver, operator_license: e.target.value})} style={inp} /></div>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Assigned Properties (pipe-separated)</label><input value={newDriver.assigned_properties} onChange={e => setNewDriver({...newDriver, assigned_properties: e.target.value})} placeholder="Property A|Property B" style={inp} /></div>
                </div>
                {driverMsg && (
                  <div style={{ background: driverMsg.includes('created') ? '#1a3a1a' : '#3a1a1a', border:`1px solid ${driverMsg.includes('created') ? '#2e7d32' : '#b71c1c'}`, borderRadius:'6px', padding:'8px 10px', marginBottom:'10px' }}>
                    <p style={{ color: driverMsg.includes('created') ? '#4caf50' : '#f44336', fontSize:'12px', margin:'0', wordBreak:'break-all' }}>{driverMsg}</p>
                  </div>
                )}
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={addDriver} style={{ ...bGold, flex:1 }}>Add Driver</button>
                  <button onClick={() => { setShowAddDriver(false); setDriverMsg('') }} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {editingDriver && (
              <div style={editCard}>
                <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Editing — {editingDriver.name}</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Full Name</label><input value={editingDriver.name || ''} onChange={e => setEditingDriver({...editingDriver, name: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Phone</label><input value={editingDriver.phone || ''} onChange={e => setEditingDriver({...editingDriver, phone: e.target.value})} style={inp} /></div>
                  <div>
                    <label style={lbl}>Company</label>
                    <select value={editingDriver.company || ''} onChange={e => setEditingDriver({...editingDriver, company: e.target.value})} style={inp}>
                      <option value=''>None</option>
                      {companies.map((c,i) => <option key={i} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                  <div><label style={lbl}>Operator License</label><input value={editingDriver.operator_license || ''} onChange={e => setEditingDriver({...editingDriver, operator_license: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Active</label><select value={editingDriver.is_active ? 'true' : 'false'} onChange={e => setEditingDriver({...editingDriver, is_active: e.target.value === 'true'})} style={inp}><option value="true">Yes</option><option value="false">No</option></select></div>
                  <div style={{ gridColumn:'span 2' }}><label style={lbl}>Assigned Properties (pipe-separated)</label><input value={editingDriver.assigned_properties || ''} onChange={e => setEditingDriver({...editingDriver, assigned_properties: e.target.value})} placeholder="Property A|Property B" style={inp} /></div>
                </div>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={saveDriver} style={{ ...bGold, flex:1 }}>Save Changes</button>
                  <button onClick={() => setEditingDriver(null)} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {fD().map((d, i) => (
              <div key={i} style={card}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                  <div>
                    <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'0' }}>{d.name}</p>
                    <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{d.email}</p>
                  </div>
                  <span style={badge(d.is_active)}>{d.is_active ? 'Active' : 'Inactive'}</span>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:'6px', fontSize:'11px', marginBottom:'10px' }}>
                  <div><span style={{ color:'#555' }}>Company</span><br/><span style={{ color:'#aaa' }}>{d.company || '—'}</span></div>
                  <div><span style={{ color:'#555' }}>License</span><br/><span style={{ color:'#aaa' }}>{d.operator_license || '—'}</span></div>
                  {d.assigned_properties && <div style={{ gridColumn:'span 2' }}><span style={{ color:'#555' }}>Properties</span><br/><span style={{ color:'#aaa' }}>{d.assigned_properties}</span></div>}
                </div>
                <div style={{ display:'flex', gap:'6px' }}>
                  <button onClick={() => { setEditingDriver({...d}); setShowAddDriver(false) }} style={editBtn}>Edit</button>
                  {d.is_active ? <button onClick={() => toggleDriver(d, false)} style={bRed}>Deactivate</button>
                               : <button onClick={() => toggleDriver(d, true)} style={bGrn}>Activate</button>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── STORAGE FACILITIES ── */}
        {activeTab === 'facilities' && (
          <div>
            <input value={facilitySearch} onChange={e => setFacilitySearch(e.target.value)} placeholder="Search facilities..." style={{ ...inp, marginBottom:'12px' }} />
            <button onClick={() => { setShowAddFacility(!showAddFacility); setEditingFacility(null) }} style={{ ...bGold, width:'100%', marginBottom:'12px' }}>+ Add Storage Facility</button>

            {showAddFacility && !editingFacility && (
              <div style={addCard}>
                <p style={{ color:'white', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>New Storage Facility</p>
                <label style={lbl}>Name *</label><input value={newFacility.name} onChange={e => setNewFacility({...newFacility, name: e.target.value})} style={inp} />
                <label style={lbl}>Address</label><input value={newFacility.address} onChange={e => setNewFacility({...newFacility, address: e.target.value})} style={inp} />
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div><label style={lbl}>Phone</label><input value={newFacility.phone} onChange={e => setNewFacility({...newFacility, phone: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Email</label><input value={newFacility.email} onChange={e => setNewFacility({...newFacility, email: e.target.value})} style={inp} /></div>
                </div>
                <label style={lbl}>Active</label>
                <select value={newFacility.is_active ? 'true' : 'false'} onChange={e => setNewFacility({...newFacility, is_active: e.target.value === 'true'})} style={inp}>
                  <option value="true">Yes</option><option value="false">No</option>
                </select>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={addFacility} style={{ ...bGold, flex:1 }}>Add Facility</button>
                  <button onClick={() => setShowAddFacility(false)} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {editingFacility && (
              <div style={editCard}>
                <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 12px' }}>Editing — {editingFacility.name}</p>
                <label style={lbl}>Name *</label><input value={editingFacility.name || ''} onChange={e => setEditingFacility({...editingFacility, name: e.target.value})} style={inp} />
                <label style={lbl}>Address</label><input value={editingFacility.address || ''} onChange={e => setEditingFacility({...editingFacility, address: e.target.value})} style={inp} />
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                  <div><label style={lbl}>Phone</label><input value={editingFacility.phone || ''} onChange={e => setEditingFacility({...editingFacility, phone: e.target.value})} style={inp} /></div>
                  <div><label style={lbl}>Email</label><input value={editingFacility.email || ''} onChange={e => setEditingFacility({...editingFacility, email: e.target.value})} style={inp} /></div>
                </div>
                <label style={lbl}>Active</label>
                <select value={editingFacility.is_active ? 'true' : 'false'} onChange={e => setEditingFacility({...editingFacility, is_active: e.target.value === 'true'})} style={inp}>
                  <option value="true">Yes</option><option value="false">No</option>
                </select>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={saveFacility} style={{ ...bGold, flex:1 }}>Save Changes</button>
                  <button onClick={() => setEditingFacility(null)} style={bGray}>Cancel</button>
                </div>
              </div>
            )}

            {fF().map((f, i) => (
              <div key={i} style={card}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px' }}>
                  <div>
                    <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'0' }}>{f.name}</p>
                    <p style={{ color:'#aaa', fontSize:'11px', margin:'3px 0 0' }}>{[f.phone, f.email].filter(Boolean).join(' · ') || '—'}</p>
                  </div>
                  <span style={badge(f.is_active)}>{f.is_active ? 'Active' : 'Inactive'}</span>
                </div>
                {f.address && <p style={{ color:'#555', fontSize:'11px', margin:'0 0 10px' }}>{f.address}</p>}
                <div style={{ display:'flex', gap:'6px' }}>
                  <button onClick={() => { setEditingFacility({...f}); setShowAddFacility(false) }} style={editBtn}>Edit</button>
                  {f.is_active ? <button onClick={() => toggleFacility(f, false)} style={bRed}>Deactivate</button>
                               : <button onClick={() => toggleFacility(f, true)} style={bGrn}>Activate</button>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── AUDIT LOG ── */}
        {activeTab === 'auditlog' && (() => {
          const actionColor: Record<string, { bg: string; color: string }> = {
            ADD_COMPANY:        { bg:'#1a2a3a', color:'#2196f3' },
            EDIT_COMPANY:       { bg:'#1e2535', color:'#aaa' },
            ACTIVATE_COMPANY:   { bg:'#1a3a1a', color:'#4caf50' },
            DEACTIVATE_COMPANY: { bg:'#3a1a1a', color:'#f44336' },
            ADD_PROPERTY:       { bg:'#1a2a3a', color:'#2196f3' },
            EDIT_PROPERTY:      { bg:'#1e2535', color:'#aaa' },
            ADD_USER:           { bg:'#1a2a3a', color:'#2196f3' },
            ADD_DRIVER:         { bg:'#1a2a3a', color:'#2196f3' },
            EDIT_DRIVER:        { bg:'#1e2535', color:'#aaa' },
            ACTIVATE_DRIVER:    { bg:'#1a3a1a', color:'#4caf50' },
            DEACTIVATE_DRIVER:  { bg:'#3a1a1a', color:'#f44336' },
            ADD_FACILITY:       { bg:'#1a2a3a', color:'#2196f3' },
            EDIT_FACILITY:      { bg:'#1e2535', color:'#aaa' },
            ADD_VIOLATION:      { bg:'#3a1a1a', color:'#f44336' },
            ADD_VEHICLE:        { bg:'#1a3a1a', color:'#4caf50' },
            REMOVE_VEHICLE:     { bg:'#3a1a1a', color:'#f44336' },
            ADD_RESIDENT:       { bg:'#1a3a1a', color:'#4caf50' },
            ISSUE_VISITOR_PASS: { bg:'#1e1800', color:'#C9A227' },
          }
          const today = new Date(); today.setHours(0,0,0,0)
          const week = new Date(); week.setDate(week.getDate()-7)
          const month = new Date(); month.setMonth(month.getMonth()-1)
          const filtered = allAuditLogs.filter(log => {
            const d = new Date(log.created_at)
            const inPeriod = auditDateFilter === 'today' ? d >= today : auditDateFilter === 'week' ? d >= week : auditDateFilter === 'month' ? d >= month : true
            if (!inPeriod) return false
            if (!auditSearch) return true
            const q = auditSearch.toLowerCase()
            return (log.user_email || '').toLowerCase().includes(q) ||
              (log.action || '').toLowerCase().includes(q) ||
              (log.table_name || '').toLowerCase().includes(q) ||
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
              <input value={auditSearch} onChange={e => setAuditSearch(e.target.value)} placeholder="Search email, action, table, values..." style={{ ...inp, marginBottom:'10px' }} />
              {!auditLoaded ? (
                <p style={{ color:'#555', fontSize:'13px', textAlign:'center', margin:'32px 0' }}>Loading...</p>
              ) : filtered.length === 0 ? (
                <div style={card}><p style={{ color:'#555', fontSize:'13px', margin:'0', textAlign:'center' }}>No audit entries for this period</p></div>
              ) : filtered.map((log, i) => {
                const badge2 = actionColor[log.action] || { bg:'#1e2535', color:'#aaa' }
                const vals = log.new_values ? Object.entries(log.new_values as Record<string,unknown>).map(([k,v]) => `${k}: ${v}`).join(' · ') : ''
                return (
                  <div key={i} style={card}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'6px' }}>
                      <span style={{ background:badge2.bg, color:badge2.color, padding:'2px 8px', borderRadius:'8px', fontSize:'10px', fontWeight:'bold', letterSpacing:'0.04em' }}>{log.action}</span>
                      <span style={{ color:'#555', fontSize:'10px' }}>{new Date(log.created_at).toLocaleString()}</span>
                    </div>
                    <p style={{ color:'#aaa', fontSize:'11px', margin:'0 0 2px' }}>{log.user_email} <span style={{ color:'#555' }}>· {log.table_name}</span></p>
                    {log.record_id && <p style={{ color:'#555', fontSize:'10px', margin:'0 0 2px', fontFamily:'Courier New' }}>id: {log.record_id}</p>}
                    {vals && <p style={{ color:'#555', fontSize:'11px', margin:'0', fontFamily:'Courier New', wordBreak:'break-all' }}>{vals}</p>}
                  </div>
                )
              })}
            </div>
          )
        })()}

      </div>
    </main>
  )
}

'use client'
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

export default function ResidentPortal() {
  const [email, setEmail] = useState('')
  const [resident, setResident] = useState<any>(null)
  const [vehicles, setVehicles] = useState<any[]>([])
  const [passes, setPasses] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('info')
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<any>({})
  const [showVisitorForm, setShowVisitorForm] = useState(false)
  const [visitorForm, setVisitorForm] = useState({ plate: '', name: '', vehicle_desc: '', duration: '4' })

  async function findResident() {
    if (!email) return
    setLoading(true)
    setError('')
    const { data, error } = await supabase
      .from('residents')
      .select('*')
      .ilike('email', email.trim())
      .single()
    setLoading(false)
    if (error || !data) {
      setError('No resident found with that email address.')
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
    setVehicles(data || [])
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

  async function issueVisitorPass() {
    if (!visitorForm.plate || !resident) return
    const expires = new Date()
    expires.setHours(expires.getHours() + parseInt(visitorForm.duration))
    const { error } = await supabase
      .from('visitor_passes')
      .insert([{
        plate: visitorForm.plate.toUpperCase().trim(),
        visitor_name: visitorForm.name,
        visiting_unit: resident.unit,
        vehicle_desc: visitorForm.vehicle_desc,
        duration_hours: parseInt(visitorForm.duration),
        created_at: new Date().toISOString(),
        expires_at: expires.toISOString(),
        is_active: true
      }])
    if (error) {
      alert('Error: ' + error.message)
    } else {
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

  if (!resident) {
    return (
      <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
        <div style={{ maxWidth:'380px', width:'100%' }}>
          <div style={{ marginBottom:'32px', textAlign:'center' }}>
            <h1 style={{ color:'#C9A227', fontSize:'24px', fontWeight:'bold', margin:'0' }}>A1 Wrecker, LLC</h1>
            <p style={{ color:'#888', fontSize:'13px', margin:'6px 0 0' }}>Resident Portal</p>
          </div>
          <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'28px' }}>
            <p style={{ color:'#aaa', fontSize:'13px', margin:'0 0 16px', lineHeight:'1.6' }}>Enter your email address to access your resident account.</p>
            
            {error && (
              <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'8px', padding:'10px', marginBottom:'14px' }}>
                <p style={{ color:'#f44336', fontSize:'12px', margin:'0' }}>{error}</p>
              </div>
            )}

            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Email Address</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && findResident()}
              placeholder="you@example.com"
              style={{ display:'block', width:'100%', marginTop:'6px', marginBottom:'14px', padding:'10px 12px', fontSize:'13px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', outline:'none', boxSizing:'border-box' }}
            />
            <button
              onClick={findResident}
              disabled={loading || !email}
              style={{ width:'100%', padding:'12px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'14px', border:'none', borderRadius:'8px', cursor:'pointer' }}
            >
              {loading ? 'Looking up...' : 'Access My Account'}
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
          <button style={tabStyle('vehicles')} onClick={() => setActiveTab('vehicles')}>Vehicles</button>
          <button style={tabStyle('visitors')} onClick={() => setActiveTab('visitors')}>Visitors</button>
        </div>

        {/* MY INFO TAB */}
        {activeTab === 'info' && (
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
        )}

        {/* VEHICLES TAB */}
        {activeTab === 'vehicles' && (
          <div>
            {vehicles.length === 0 ? (
              <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'32px', textAlign:'center' }}>
                <p style={{ color:'#555', fontSize:'13px', margin:'0' }}>No vehicles registered yet.</p>
                <p style={{ color:'#555', fontSize:'12px', margin:'8px 0 0' }}>Contact your property manager to register a vehicle.</p>
              </div>
            ) : (
              vehicles.map((v, i) => (
                <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'10px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'10px' }}>
                    <p style={{ color:'white', fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                    <span style={{ background: v.is_active ? '#1a3a1a' : '#3a1a1a', color: v.is_active ? '#4caf50' : '#f44336', padding:'3px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'bold' }}>
                      {v.is_active ? 'Active' : 'Expired'}
                    </span>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px', fontSize:'12px' }}>
                    <div><span style={{ color:'#555' }}>Vehicle</span><br/><span style={{ color:'#aaa' }}>{v.color} {v.make} {v.model} {v.year}</span></div>
                    <div><span style={{ color:'#555' }}>Space</span><br/><span style={{ color:'#aaa' }}>{v.space || '—'}</span></div>
                    <div><span style={{ color:'#555' }}>State</span><br/><span style={{ color:'#aaa' }}>{v.state}</span></div>
                    <div><span style={{ color:'#555' }}>Permit Expiry</span><br/><span style={{ color:'#aaa' }}>{v.permit_expiry ? new Date(v.permit_expiry).toLocaleDateString() : '—'}</span></div>
                  </div>
                </div>
              ))
            )}
            <div style={{ background:'#161b26', border:'1px dashed #2a2f3d', borderRadius:'10px', padding:'14px', textAlign:'center', marginTop:'8px' }}>
              <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>Need to add or update a vehicle? Contact your property manager.</p>
            </div>
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
                  onChange={e => setVisitorForm({...visitorForm, plate: e.target.value.toUpperCase()})}
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
                <div style={{ display:'flex', gap:'8px' }}>
                  <button onClick={issueVisitorPass}
                    style={{ flex:1, padding:'11px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>
                    Issue Pass
                  </button>
                  <button onClick={() => setShowVisitorForm(false)}
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

        <div style={{ textAlign:'center', marginTop:'20px' }}>
          <a href="/" style={{ color:'#C9A227', fontSize:'12px', textDecoration:'none' }}>← Back to Plate Lookup</a>
        </div>

      </div>
    </main>
  )
}
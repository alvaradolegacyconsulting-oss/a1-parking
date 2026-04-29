'use client'
import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '../supabase'

export default function Visitor() {
  const searchParams = useSearchParams()
  const propertyName = searchParams.get('property') || 'A1 Wrecker Managed Property'
  const [step, setStep] = useState<'form' | 'success'>('form')
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({
    plate: '',
    name: '',
    unit: '',
    duration: '4',
    vehicle_desc: ''
  })

  async function submitPass() {
    if (!form.plate || !form.unit) {
      alert('Please enter your license plate and the unit you are visiting')
      return
    }
    setLoading(true)

    const now = new Date()
    const expires = new Date()
    expires.setHours(expires.getHours() + parseInt(form.duration))

    const { error } = await supabase
      .from('visitor_passes')
      .insert([{
        plate: form.plate.toUpperCase().trim(),
        visitor_name: form.name,
        visiting_unit: form.unit,
        vehicle_desc: form.vehicle_desc,
        duration_hours: parseInt(form.duration),
        created_at: now.toISOString(),
        expires_at: expires.toISOString(),
        is_active: true
      }])

    setLoading(false)
    if (error) {
      alert('Error: ' + error.message)
    } else {
      setStep('success')
    }
  }

  function formatExpiry(hours: string) {
    const d = new Date()
    d.setHours(d.getHours() + parseInt(hours))
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) + 
           ' · ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  if (step === 'success') {
    return (
      <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
        <div style={{ maxWidth:'420px', width:'100%', textAlign:'center' }}>
          
          <div style={{ background:'linear-gradient(135deg, #1a1200, #2a1d00)', border:'2px solid #C9A227', borderRadius:'16px', padding:'28px', marginBottom:'16px' }}>
            <p style={{ color:'#C9A227', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.15em', margin:'0 0 6px' }}>A1 Wrecker, LLC · Visitor Pass</p>
            <p style={{ color:'white', fontFamily:'Courier New', fontSize:'32px', fontWeight:'bold', letterSpacing:'0.12em', margin:'0 0 4px' }}>{form.plate.toUpperCase()}</p>
            {form.vehicle_desc && <p style={{ color:'#C9A227', fontSize:'12px', margin:'0 0 16px' }}>{form.vehicle_desc}</p>}
            
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'12px', marginBottom:'16px', textAlign:'left' }}>
              <div>
                <p style={{ color:'rgba(201,162,39,0.7)', fontSize:'11px', margin:'0' }}>Visiting</p>
                <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:'4px 0 0' }}>{form.unit}</p>
              </div>
              <div>
                <p style={{ color:'rgba(201,162,39,0.7)', fontSize:'11px', margin:'0' }}>Duration</p>
                <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:'4px 0 0' }}>{form.duration} hours</p>
              </div>
              <div style={{ gridColumn:'span 2' }}>
                <p style={{ color:'rgba(201,162,39,0.7)', fontSize:'11px', margin:'0' }}>Expires</p>
                <p style={{ color:'white', fontSize:'13px', fontWeight:'bold', margin:'4px 0 0' }}>{formatExpiry(form.duration)}</p>
              </div>
            </div>

            <div style={{ height:'4px', background:'rgba(255,255,255,0.1)', borderRadius:'2px' }}>
              <div style={{ width:'100%', height:'100%', background:'#C9A227', borderRadius:'2px' }}></div>
            </div>
          </div>

          <div style={{ background:'#1a3a1a', border:'1px solid #2e7d32', borderRadius:'10px', padding:'14px', marginBottom:'16px' }}>
            <p style={{ color:'#4caf50', fontWeight:'bold', fontSize:'14px', margin:'0 0 4px' }}>✓ Pass Activated</p>
            <p style={{ color:'#aaa', fontSize:'12px', margin:'0', lineHeight:'1.6' }}>Your vehicle is authorized to park. A1 Wrecker and the property manager have been notified. Do not remain after your pass expires.</p>
          </div>

          <button
            onClick={() => { setStep('form'); setForm({ plate:'', name:'', unit:'', duration:'4', vehicle_desc:'' }) }}
            style={{ width:'100%', padding:'12px', background:'#161b26', color:'#aaa', fontSize:'13px', border:'1px solid #2a2f3d', borderRadius:'8px', cursor:'pointer' }}
          >
            Register Another Vehicle
          </button>
        </div>
      </main>
    )
  }

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'420px', width:'100%' }}>

        <div style={{ marginBottom:'24px', textAlign:'center' }}>
          <h1 style={{ color:'#C9A227', fontSize:'24px', fontWeight:'bold', margin:'0' }}>A1 Wrecker, LLC</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'6px 0 0' }}>Visitor Parking Pass · {propertyName}</p>
          <p style={{ color:'#555', fontSize:'11px', margin:'4px 0 0' }}>Valid up to 24 hours · No app download required</p>
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'24px' }}>
          
          <div style={{ marginBottom:'14px' }}>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>License Plate *</label>
            <input
              value={form.plate}
              onChange={e => setForm({...form, plate: e.target.value.toUpperCase()})}
              placeholder="ABC1234"
              style={{ display:'block', width:'100%', marginTop:'6px', padding:'12px', fontSize:'20px', fontFamily:'Courier New', fontWeight:'bold', letterSpacing:'0.1em', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', textAlign:'center', outline:'none', boxSizing:'border-box' }}
            />
          </div>

          <div style={{ marginBottom:'14px' }}>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Unit You Are Visiting *</label>
            <input
              value={form.unit}
              onChange={e => setForm({...form, unit: e.target.value})}
              placeholder="e.g. Apt 214"
              style={{ display:'block', width:'100%', marginTop:'6px', padding:'10px 12px', fontSize:'13px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', outline:'none', boxSizing:'border-box' }}
            />
          </div>

          <div style={{ marginBottom:'14px' }}>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Your Name (optional)</label>
            <input
              value={form.name}
              onChange={e => setForm({...form, name: e.target.value})}
              placeholder="John Smith"
              style={{ display:'block', width:'100%', marginTop:'6px', padding:'10px 12px', fontSize:'13px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', outline:'none', boxSizing:'border-box' }}
            />
          </div>

          <div style={{ marginBottom:'14px' }}>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Vehicle Description (optional)</label>
            <input
              value={form.vehicle_desc}
              onChange={e => setForm({...form, vehicle_desc: e.target.value})}
              placeholder="e.g. White Toyota RAV4"
              style={{ display:'block', width:'100%', marginTop:'6px', padding:'10px 12px', fontSize:'13px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', outline:'none', boxSizing:'border-box' }}
            />
          </div>

          <div style={{ marginBottom:'20px' }}>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>How Long Will You Be Here?</label>
            <select
              value={form.duration}
              onChange={e => setForm({...form, duration: e.target.value})}
              style={{ display:'block', width:'100%', marginTop:'6px', padding:'10px 12px', fontSize:'13px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', outline:'none' }}
            >
              <option value='2'>2 hours</option>
              <option value='4'>4 hours</option>
              <option value='8'>8 hours</option>
              <option value='12'>12 hours</option>
              <option value='24'>24 hours (maximum)</option>
            </select>
          </div>

          <button
            onClick={submitPass}
            disabled={loading || !form.plate || !form.unit}
            style={{ width:'100%', padding:'14px', background: (!form.plate || !form.unit) ? '#555' : '#C9A227', color: (!form.plate || !form.unit) ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'8px', cursor: (!form.plate || !form.unit) ? 'not-allowed' : 'pointer' }}
          >
            {loading ? 'Activating Pass...' : 'Get Visitor Pass'}
          </button>

          <p style={{ color:'#444', fontSize:'11px', textAlign:'center', marginTop:'12px', lineHeight:'1.6' }}>
            By submitting you agree that A1 Wrecker, LLC and the property manager will be notified of your visit.
          </p>
        </div>

        <p style={{ color:'#333', fontSize:'11px', textAlign:'center', marginTop:'16px' }}>A1 Wrecker, LLC · Houston's #1 Towing & Recovery · a1wreckerllc.net</p>
      </div>
    </main>
  )
}
'use client'
import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '../supabase'

function VisitorForm() {
  const searchParams = useSearchParams()
  const propertyName = searchParams.get('property') || 'A1 Wrecker Managed Property'
  const [step, setStep] = useState<'form' | 'success'>('form')
  const [supportPhone, setSupportPhone] = useState('346-428-7864')
  const [supportEmail, setSupportEmail] = useState('a1wrecker2023@gmail.com')
  const [supportWebsite, setSupportWebsite] = useState('a1wreckerllc.net')
  const [companyName, setCompanyName] = useState('A1 Wrecker LLC')

  useEffect(() => {
    setSupportPhone(localStorage.getItem('company_support_phone') || '346-428-7864')
    setSupportEmail(localStorage.getItem('company_support_email') || 'a1wrecker2023@gmail.com')
    setSupportWebsite(localStorage.getItem('company_support_website') || 'a1wreckerllc.net')
    setCompanyName(localStorage.getItem('company_name') || 'A1 Wrecker LLC')
  }, [])
  const [loading, setLoading] = useState(false)
  const [plateError, setPlateError] = useState('')
  const [tosChecked, setTosChecked] = useState(false)
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
    setPlateError('')

    const plate = form.plate.toUpperCase().trim()

    if (propertyName !== 'A1 Wrecker Managed Property') {
      const { data: existing } = await supabase
        .from('vehicles')
        .select('id')
        .ilike('plate', plate)
        .ilike('property', propertyName)
        .eq('is_active', true)
        .limit(1)

      if (existing && existing.length > 0) {
        setLoading(false)
        setPlateError('This plate is already registered to a resident at this property and does not need a visitor pass.')
        return
      }

      const { data: propData } = await supabase
        .from('properties')
        .select('visitor_pass_limit, exempt_plates')
        .ilike('name', propertyName)
        .single()

      if (propData && propData.visitor_pass_limit && propData.visitor_pass_limit > 0) {
        const exemptPlates: string[] = propData.exempt_plates || []
        const isExempt = exemptPlates.some(ep => ep.toUpperCase() === plate)

        if (!isExempt) {
          const { data: units } = await supabase
            .from('residents')
            .select('unit')
            .ilike('property', propertyName)

          const unitList = (units || []).map((r: { unit: string }) => r.unit)

          if (unitList.length > 0) {
            const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString()
            const { count } = await supabase
              .from('visitor_passes')
              .select('id', { count: 'exact', head: true })
              .ilike('plate', plate)
              .in('visiting_unit', unitList)
              .gte('created_at', yearStart)

            if ((count ?? 0) >= propData.visitor_pass_limit) {
              setLoading(false)
              setPlateError('This vehicle has reached the maximum number of visitor passes allowed per year for this property.')
              return
            }
          }
        }
      }
    }

    const now = new Date()
    const expires = new Date()
    expires.setHours(expires.getHours() + parseInt(form.duration))

    const { error } = await supabase
      .from('visitor_passes')
      .insert([{
        plate,
        visitor_name: form.name,
        visiting_unit: form.unit,
        property: propertyName,
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
      await supabase.from('audit_logs').insert([{ action: 'VISITOR_TOS_ACCEPTED', table_name: 'visitor_passes', new_values: { plate, property: propertyName } }])
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
        <div style={{ maxWidth:'420px', width:'100%' }}>

          {/* Pass card */}
          <div style={{ background:'linear-gradient(135deg, #1a1200, #2a1d00)', border:'2px solid #C9A227', borderRadius:'16px', padding:'24px', marginBottom:'12px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'16px' }}>
              <div>
                <p style={{ color:'#C9A227', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.15em', margin:'0 0 2px' }}>Visitor Pass · Active</p>
                <p style={{ color:'rgba(201,162,39,0.6)', fontSize:'10px', margin:'0' }}>{companyName}</p>
              </div>
              <span style={{ background:'#1a3a1a', color:'#4caf50', border:'1px solid #2e7d32', borderRadius:'20px', padding:'3px 10px', fontSize:'11px', fontWeight:'bold' }}>✓ Active</span>
            </div>

            <p style={{ color:'white', fontFamily:'Courier New', fontSize:'36px', fontWeight:'bold', letterSpacing:'0.14em', margin:'0 0 4px', textAlign:'center' }}>{form.plate.toUpperCase()}</p>
            {form.vehicle_desc && <p style={{ color:'#C9A227', fontSize:'12px', margin:'0 0 16px', textAlign:'center' }}>{form.vehicle_desc}</p>}
            {!form.vehicle_desc && <div style={{ marginBottom:'16px' }} />}

            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px', fontSize:'12px' }}>
              <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:'8px', padding:'10px' }}>
                <p style={{ color:'rgba(201,162,39,0.6)', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 3px' }}>Property</p>
                <p style={{ color:'white', fontWeight:'bold', margin:'0', lineHeight:'1.4' }}>{propertyName}</p>
              </div>
              <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:'8px', padding:'10px' }}>
                <p style={{ color:'rgba(201,162,39,0.6)', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 3px' }}>Visiting Unit</p>
                <p style={{ color:'white', fontWeight:'bold', margin:'0' }}>{form.unit}</p>
              </div>
              <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:'8px', padding:'10px' }}>
                <p style={{ color:'rgba(201,162,39,0.6)', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 3px' }}>Duration</p>
                <p style={{ color:'white', fontWeight:'bold', margin:'0' }}>{form.duration} hours</p>
              </div>
              <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:'8px', padding:'10px' }}>
                <p style={{ color:'rgba(201,162,39,0.6)', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 3px' }}>Valid Until</p>
                <p style={{ color:'white', fontWeight:'bold', margin:'0', fontSize:'11px' }}>{formatExpiry(form.duration)}</p>
              </div>
            </div>

            <div style={{ height:'3px', background:'rgba(255,255,255,0.08)', borderRadius:'2px', marginTop:'16px' }}>
              <div style={{ width:'100%', height:'100%', background:'#C9A227', borderRadius:'2px' }} />
            </div>
          </div>

          {/* Warning */}
          <div style={{ background:'#1a1200', border:'1px solid #a16207', borderRadius:'10px', padding:'14px', marginBottom:'12px' }}>
            <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'13px', margin:'0 0 6px' }}>⚠ Verify Your Information</p>
            <p style={{ color:'#d97706', fontSize:'12px', margin:'0', lineHeight:'1.7' }}>
              Please verify your information is correct. If any details are wrong, your vehicle may be subject to towing. Contact your host or the property manager to make corrections.
            </p>
          </div>

          {/* Support */}
          <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'12px', marginBottom:'12px', textAlign:'center' }}>
            <p style={{ color:'#555', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 6px' }}>Questions or corrections?</p>
            <p style={{ color:'#aaa', fontSize:'12px', margin:'0', lineHeight:'1.8' }}>
              {supportPhone && <><a href={`tel:${supportPhone}`} style={{ color:'#C9A227', textDecoration:'none' }}>{supportPhone}</a><br /></>}
              {supportWebsite && <a href={`https://${supportWebsite}`} target="_blank" rel="noreferrer" style={{ color:'#C9A227', textDecoration:'none' }}>{supportWebsite}</a>}
            </p>
          </div>

          <div style={{ textAlign:'center', padding:'12px 0' }}>
            <p style={{ color:'#555', fontSize:'11px', margin:'0 0 6px' }}>If your vehicle has been towed, search for it at <a href="https://www.findmytowedcar.org" target="_blank" rel="noopener noreferrer" style={{ color:'#C9A227', textDecoration:'underline' }}>FindMyTowedCar.org</a> — available for Houston & Harris County area.</p>
          </div>

          <button
            onClick={() => { setStep('form'); setForm({ plate:'', name:'', unit:'', duration:'4', vehicle_desc:'' }); setTosChecked(false) }}
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

          {plateError && (
            <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'8px', padding:'10px 12px', marginBottom:'14px' }}>
              <p style={{ color:'#f44336', fontSize:'12px', margin:'0', lineHeight:'1.5' }}>{plateError}</p>
            </div>
          )}

          <label style={{ display:'flex', alignItems:'flex-start', gap:'10px', marginBottom:'16px', cursor:'pointer' }}>
            <input type="checkbox" checked={tosChecked} onChange={e => setTosChecked(e.target.checked)}
              style={{ marginTop:'3px', accentColor:'#C9A227', cursor:'pointer' }} />
            <span style={{ color:'#aaa', fontSize:'12px', lineHeight:'1.6' }}>
              I agree to the{' '}
              <a href="/terms" target="_blank" style={{ color:'#C9A227', textDecoration:'none' }}>Terms of Service</a>
              {' '}and acknowledge that my vehicle information will be shared with the property manager.
            </span>
          </label>

          <button
            onClick={submitPass}
            disabled={loading || !form.plate || !form.unit || !tosChecked}
            style={{ width:'100%', padding:'14px', background: (!form.plate || !form.unit || !tosChecked) ? '#555' : '#C9A227', color: (!form.plate || !form.unit || !tosChecked) ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'8px', cursor: (!form.plate || !form.unit || !tosChecked) ? 'not-allowed' : 'pointer' }}
          >
            {loading ? 'Activating Pass...' : 'Get Visitor Pass'}
          </button>
        </div>

        <p style={{ color:'#333', fontSize:'11px', textAlign:'center', marginTop:'16px' }}>
          {supportPhone} · {supportEmail} · {supportWebsite}
        </p>
      </div>
    </main>
  )
}

export default function Visitor() {
  return (
    <Suspense fallback={
      <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif' }}>
        <p style={{ color:'#888' }}>Loading...</p>
      </main>
    }>
      <VisitorForm />
    </Suspense>
  )
}
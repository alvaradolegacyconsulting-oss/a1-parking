'use client'
import { useState, useEffect, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '../supabase'
import { normalizePlate } from '../lib/plate'
import { TOWED_CAR_LOOKUP_URL } from '../lib/towed-car-lookup'
import { getPlateLimitStatus, isAtLimit, parseLimitTriggerError, PlateLimitStatus } from '../lib/visitor-pass-limit'
import { TurnstileWidget, type TurnstileHandle } from '../components/TurnstileWidget'

function VisitorForm() {
  const searchParams = useSearchParams()
  const propertyName = searchParams.get('property') || 'Managed Property'
  const [step, setStep] = useState<'form' | 'success'>('form')
  const [supportPhone, setSupportPhone] = useState('')
  const [supportEmail, setSupportEmail] = useState('')
  const [supportWebsite, setSupportWebsite] = useState('')
  const [companyName, setCompanyName] = useState('')

  useEffect(() => {
    async function loadSupportInfo() {
      if (propertyName && propertyName !== 'Managed Property') {
        // B155.3 — anon RPCs replace direct table SELECTs. Same data
        // shape; safe columns only; no anon over-read.
        const { data: propRows } = await supabase.rpc('get_property_for_visitor', { p_name: propertyName })
        const prop = propRows?.[0] as { company: string } | undefined
        if (prop?.company) {
          const { data: coRows } = await supabase.rpc('get_company_branding', { p_name: prop.company })
          const co = coRows?.[0] as { support_phone: string | null; support_email: string | null; support_website: string | null; display_name: string | null } | undefined
          if (co) {
            setSupportPhone(co.support_phone || '')
            setSupportEmail(co.support_email || '')
            setSupportWebsite(co.support_website || '')
            setCompanyName(co.display_name || prop.company)
            return
          }
        }
      }
      const { data: psRows } = await supabase.rpc('get_platform_defaults')
      const ps = psRows?.[0] as { default_support_phone: string | null; default_support_email: string | null; default_support_website: string | null } | undefined
      if (ps) {
        setSupportPhone(ps.default_support_phone || '')
        setSupportEmail(ps.default_support_email || '')
        setSupportWebsite(ps.default_support_website || '')
      }
    }
    loadSupportInfo()
  }, [propertyName])
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
  const [limitStatus, setLimitStatus] = useState<PlateLimitStatus | null>(null)

  // CAPTCHA — /visitor is anon (no auth session). Token sent to the new
  // /api/visitor/create-pass wrapper which verifies via Cloudflare /siteverify
  // server-side, then calls create_visitor_pass RPC. RPC body unchanged.
  // Token is single-use; reset on failure so the user can re-challenge.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileHandle>(null)

  // B19: query per-plate active-pass count on plate change so the user
  // sees the limit before submit. Debounced 400ms.
  useEffect(() => {
    if (!form.plate || !propertyName || propertyName === 'Managed Property') {
      setLimitStatus(null); return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const result = await getPlateLimitStatus(propertyName, form.plate)
      if (!cancelled) setLimitStatus(result)
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [form.plate, propertyName])

  async function submitPass() {
    if (!form.plate || !form.unit) {
      alert('Please enter your license plate and the unit you are visiting')
      return
    }
    if (!captchaToken) {
      setPlateError('Please complete the CAPTCHA challenge below before submitting.')
      return
    }
    setLoading(true)
    setPlateError('')

    const plate = normalizePlate(form.plate)

    // B74: anon precheck swapped from direct vehicles SELECT to the
    // SECURITY DEFINER check_resident_plate RPC. The vehicles table
    // now has RLS enabled with no anon policy — direct .from() would
    // return zero rows. The RPC returns a minimum-leak boolean (no row
    // visibility, no count enumeration).
    if (propertyName !== 'Managed Property') {
      const { data: isResident } = await supabase
        .rpc('check_resident_plate', { p_plate: plate, p_property: propertyName })

      if (isResident === true) {
        setLoading(false)
        setPlateError('This plate is already registered to a resident at this property and does not need a visitor pass.')
        return
      }
    }
    // B19: per-plate-concurrent-active enforcement runs in the DB trigger
    // (enforce_visitor_pass_limit) — fires inside create_visitor_pass.
    // Submit-time errors are caught below via parseLimitTriggerError.

    // CAPTCHA — anon flow uses /api/visitor/create-pass wrapper instead
    // of direct RPC (B74 set up the RPC; this wraps it with /siteverify).
    // Wrapper verifies the Turnstile token server-side, then calls the
    // RPC via service-role. RPC body (visitor_pass_limit trigger,
    // VISITOR_TOS_ACCEPTED audit row) is unchanged.
    let error: { message: string } | null = null
    try {
      const res = await fetch('/api/visitor/create-pass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          captchaToken,
          plate,
          visitor_name: form.name,
          visiting_unit: form.unit,
          property: propertyName,
          vehicle_desc: form.vehicle_desc,
          duration_hours: parseInt(form.duration),
        }),
      })
      const body = await res.json().catch(() => ({} as { error?: string; error_class?: string }))
      if (!res.ok) {
        // CAPTCHA failure → reset widget so user can re-challenge.
        // Token is single-use; cannot replay. network_error included because
        // a Cloudflare /siteverify timeout leaves the user holding a stale
        // single-use token — without reset, the retry would fail 'rejected'
        // on the next attempt (Cloudflare may have actually consumed the
        // token during the timeout window), forcing an extra confusing
        // failure cycle before the widget refreshes.
        if (
          body?.error_class === 'rejected' ||
          body?.error_class === 'missing_token' ||
          body?.error_class === 'network_error'
        ) {
          turnstileRef.current?.reset()
          setCaptchaToken(null)
        }
        error = { message: body?.error || 'Could not create visitor pass. Please try again.' }
      }
    } catch (fetchErr) {
      error = { message: (fetchErr as Error).message || 'Network error. Please try again.' }
    }

    setLoading(false)
    if (error) {
      const friendly = parseLimitTriggerError(error)
      if (friendly) {
        setPlateError(friendly)
      } else {
        alert('Error: ' + error.message)
      }
      return
    }
    setStep('success')
  }

  function formatTimestamp(d: Date) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    }).format(d)
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

            <p style={{ color:'white', fontFamily:'Courier New', fontSize:'36px', fontWeight:'bold', letterSpacing:'0.14em', margin:'0 0 4px', textAlign:'center' }}>{normalizePlate(form.plate)}</p>
            {form.vehicle_desc && <p style={{ color:'#C9A227', fontSize:'12px', margin:'0 0 16px', textAlign:'center' }}>{form.vehicle_desc}</p>}
            {!form.vehicle_desc && <div style={{ marginBottom:'16px' }} />}

            {(() => {
              const issuedAt = new Date()
              const expiresAt = new Date(issuedAt.getTime() + parseInt(form.duration) * 3600000)
              const tile = (label: string, value: React.ReactNode, span?: boolean) => (
                <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:'8px', padding:'10px', ...(span ? { gridColumn:'span 2' } : {}) }}>
                  <p style={{ color:'rgba(201,162,39,0.6)', fontSize:'10px', textTransform:'uppercase' as const, letterSpacing:'0.08em', margin:'0 0 3px' }}>{label}</p>
                  <p style={{ color:'white', fontWeight:'bold', margin:'0', fontSize:'11px', lineHeight:'1.4' }}>{value}</p>
                </div>
              )
              return (
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px', fontSize:'12px' }}>
                  {tile('Property', propertyName)}
                  {tile('Visiting Unit', form.unit)}
                  {tile('Duration', `${form.duration} hours`)}
                  {tile('Issued', formatTimestamp(issuedAt))}
                  {tile('Valid Until', formatTimestamp(expiresAt), true)}
                </div>
              )
            })()}

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

          {/* Screenshot tip */}
          <div style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'10px 12px', color:'#666', fontSize:'11px', textAlign:'center', fontStyle:'italic', marginTop:'8px', marginBottom:'12px' }}>
            📸 Tip: Take a screenshot of this pass for your records. Show it to your host or property management if needed.
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
            <p style={{ color:'#555', fontSize:'11px', margin:'0 0 6px' }}>If your vehicle has been towed, you can search at <a href={TOWED_CAR_LOOKUP_URL} target="_blank" rel="noopener noreferrer" style={{ color:'#C9A227', textDecoration:'underline' }}>FindMyTowedCar.org</a>.</p>
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
          <h1 style={{ color:'#C9A227', fontSize:'24px', fontWeight:'bold', margin:'0' }}>{companyName || 'Visitor Parking Pass'}</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'6px 0 0' }}>Visitor Parking Pass · {propertyName}</p>
          <p style={{ color:'#555', fontSize:'11px', margin:'4px 0 0' }}>Valid up to 24 hours · No app download required</p>
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'24px' }}>
          
          <div style={{ marginBottom:'14px' }}>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>License Plate *</label>
            <input
              value={form.plate}
              onChange={e => setForm({...form, plate: normalizePlate(e.target.value)})}
              placeholder="ABC1234"
              style={{ display:'block', width:'100%', marginTop:'6px', padding:'12px', fontSize:'20px', fontFamily:'Courier New', fontWeight:'bold', letterSpacing:'0.1em', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', textAlign:'center', outline:'none', boxSizing:'border-box' }}
            />
            {limitStatus?.state === 'exempt' && (
              <p style={{ color:'#4caf50', fontSize:'11px', margin:'6px 0 0' }}>✓ Exempt plate — no limit</p>
            )}
            {limitStatus?.state === 'within' && (
              <p style={{ color:'#888', fontSize:'11px', margin:'6px 0 0' }}>{limitStatus.used} of {limitStatus.limit} active passes used.</p>
            )}
            {limitStatus?.state === 'at_limit' && (
              <p style={{ color:'#f44336', fontSize:'11px', margin:'6px 0 0', lineHeight:'1.5' }}>Limit reached: {limitStatus.used} of {limitStatus.limit} active passes. Wait for existing passes to expire or contact the property manager.</p>
            )}
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
            <p style={{ color:'#555', fontSize:'11px', margin:'4px 0 0' }}>Optional — helps property staff identify your car.</p>
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

          {/* CAPTCHA — Cloudflare Turnstile (Managed). /visitor is anon, so the
              token is sent to /api/visitor/create-pass which verifies via
              /siteverify server-side before calling create_visitor_pass. */}
          <div style={{ marginBottom:'16px' }}>
            <p style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 8px' }}>Confirm you&apos;re human</p>
            <TurnstileWidget
              ref={turnstileRef}
              onVerify={setCaptchaToken}
              onExpire={() => setCaptchaToken(null)}
              onError={() => setCaptchaToken(null)}
              action="visitor"
            />
          </div>

          <button
            onClick={submitPass}
            disabled={loading || !form.plate || !form.unit || !tosChecked || isAtLimit(limitStatus) || !captchaToken}
            style={{ width:'100%', padding:'14px', background: (!form.plate || !form.unit || !tosChecked || isAtLimit(limitStatus) || !captchaToken) ? '#555' : '#C9A227', color: (!form.plate || !form.unit || !tosChecked || isAtLimit(limitStatus) || !captchaToken) ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'8px', cursor: (!form.plate || !form.unit || !tosChecked || isAtLimit(limitStatus) || !captchaToken) ? 'not-allowed' : 'pointer' }}
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
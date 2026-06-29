'use client'
import { useState, useEffect, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '../supabase'
import { useResolvedLogo } from '../lib/logo'
import { normalizePlate } from '../lib/plate'
import { TurnstileWidget, type TurnstileHandle } from '../components/TurnstileWidget'

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']

const inp: React.CSSProperties = { display:'block', width:'100%', marginTop:'5px', marginBottom:'12px', padding:'10px 12px', fontSize:'13px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', outline:'none', boxSizing:'border-box', fontFamily:'Arial' }
const lbl: React.CSSProperties = { color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }

function RegisterForm() {
  const searchParams = useSearchParams()
  const property = searchParams.get('property') || ''
  const company = searchParams.get('company') || ''

  const [step, setStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  // B209 — tow-stakes gap copy surfaced after registration if any
  // vehicle insert failed in the server-side companion-vehicle route.
  // Renders prominently in the success screen (not a footnote) because
  // the downstream consequence is the resident's car getting TOWED.
  const [vehicleGapMessage, setVehicleGapMessage] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [companyLogo, setCompanyLogo] = useState<string | null>(null)
  const [companyName, setCompanyName] = useState<string | null>(null)
  const [logoFailed, setLogoFailed] = useState(false)
  const resolvedLogo = useResolvedLogo(companyLogo)

  const [tosChecked, setTosChecked] = useState(false)
  const [account, setAccount] = useState({ email: '', password: '', confirm: '', name: '', phone: '', unit: '' })
  const [vehicles, setVehicles] = useState<any[]>([])

  // CAPTCHA — gated server-side via /api/register/captcha-verify (called FIRST
  // in submit, BEFORE the swift-handler user-create). Distinct from native
  // /signup which passes captchaToken to supabase.auth.signUp options;
  // /register uses swift-handler (Edge Function for admin user-create) which
  // is not native-CAPTCHA-capable, hence the wrapper-route gate.
  // Token is single-use; reset on failure so the user can re-challenge.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const turnstileRef = useRef<TurnstileHandle>(null)

  useEffect(() => {
    setCompanyLogo(localStorage.getItem('company_logo'))
    setCompanyName(localStorage.getItem('company_name'))
  }, [])

  function validateStep1(): string {
    if (!account.email || !account.password || !account.name || !account.unit) return 'Email, password, full name, and unit are required.'
    if (!account.email.includes('@')) return 'Please enter a valid email address.'
    if (account.password.length < 8) return 'Password must be at least 8 characters.'
    if (account.password !== account.confirm) return 'Passwords do not match.'
    return ''
  }

  function addVehicle() {
    if (vehicles.length >= 2) return
    setVehicles([...vehicles, { plate: '', state: 'TX', make: '', model: '', year: '', color: '' }])
  }

  function updateVehicle(i: number, field: string, val: string) {
    const updated = [...vehicles]
    updated[i] = { ...updated[i], [field]: val }
    setVehicles(updated)
  }

  async function submit() {
    setSubmitting(true)
    setError('')
    try {
      if (!captchaToken) {
        setError('Please complete the CAPTCHA challenge below before submitting.')
        setSubmitting(false)
        return
      }

      const { data: existing } = await supabase
        .from('residents')
        .select('id')
        .ilike('email', account.email.trim())
        .single()
      if (existing) {
        setError('An account with this email already exists. Please log in instead.')
        setSubmitting(false)
        return
      }

      // C′′ 2026-06-29 — single-solve registration. The new
      // /api/register/create-user route does its own siteverify
      // (consuming token #1 server-side — bot rejection is the security
      // boundary, must live server-side not in a client-orchestrated
      // upstream call), admin-creates the auth.users row, and returns
      // a magic-link token_hash for ungated session acquisition via
      // verifyOtp. Replaces the previous (/api/register/captcha-verify
      // → swift-handler → signInWithPassword with a second captcha
      // token) chain. swift-handler stays in use for admin / company_admin
      // / manager call sites — only /register switches.
      const res = await fetch('/api/register/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          captchaToken,
          email: account.email.trim(),
          password: account.password,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        // Token is single-use — reset widget on any failure so the
        // user can re-challenge without a page reload. Error message
        // surfaces verbatim (server route preserves "email already
        // registered" wording).
        turnstileRef.current?.reset()
        setCaptchaToken(null)
        setError(json.error || json.message || 'Failed to create account. The email may already be registered.')
        setSubmitting(false)
        return
      }

      // Sign in via verifyOtp using the magic-link token_hash returned
      // by the new route. verifyOtp is UNGATED (confirmed by 2026-06-29
      // prod probe) — no second captcha solve needed. Same downstream
      // result as the prior signInWithPassword path: an authenticated
      // session whose JWT email matches residents.email, so the
      // residents_self_insert RLS policy passes for the INSERT below.
      const { error: signInErr } = await supabase.auth.verifyOtp({
        email: account.email.trim().toLowerCase(),
        token_hash: json.token_hash as string,
        type: 'magiclink',
      })
      if (signInErr) {
        // Reset widget for any subsequent retry. The auth.users row
        // exists (route succeeded above) so the user can log in via
        // /login with the password they entered, but this session-
        // setup leg failed — message verbatim.
        turnstileRef.current?.reset()
        setCaptchaToken(null)
        setError('Account created but session setup failed: ' + signInErr.message)
        setSubmitting(false)
        return
      }

      const texasConfirmedAt = new Date().toISOString()
      const { error: rErr } = await supabase.from('residents').insert([{
        email: account.email.trim().toLowerCase(),
        name: account.name.trim(),
        phone: account.phone.trim() || null,
        unit: account.unit.trim(),
        property: property || null,
        company: company || null,
        is_active: false,
        status: 'pending',
        texas_confirmed: true,
        texas_confirmed_at: texasConfirmedAt,
      }])
      if (rErr) {
        setError('Account created but resident record failed: ' + rErr.message)
        setSubmitting(false)
        return
      }

      const rpcResult = await supabase.rpc('insert_user_role', {
        p_email: account.email.trim().toLowerCase(),
        p_role: 'resident',
        p_company: company || null,
        p_property: property ? [property] : [],
      })
      if (rpcResult.error) {
        console.error('insert_user_role failed:', rpcResult.error)
        await supabase.from('user_roles').insert([{
          email: account.email.trim().toLowerCase(),
          role: 'resident',
          company: company || null,
          property: property ? [property] : [],
        }])
      }

      // B209 — server-side companion-vehicle route. The previous
      // client-side direct .from('vehicles').insert() relied on the
      // resident_insert_vehicles RLS policy, which was DROPped by the
      // cascading-deactivation arc (7da03d2, 2026-06-17) — every public
      // self-register with a vehicle was silently permission-denied
      // because the old call site had no error capture.
      //
      // The route uses an admin (service-role) client that bypasses
      // RLS, with scope (unit, property, resident_email) derived
      // server-side from the just-inserted residents row — the body
      // carries ONLY the cosmetic fields (plate/state/make/model/year/
      // color), no caller-supplied scope.
      //
      // Soft-fail discipline (B167 pattern): per-vehicle insert failure
      // does NOT roll back the registration. The route returns 200 with
      // a soft-fail aggregate; we surface vehicleGapMessage on the
      // success screen — tow-stakes copy, NOT a generic save-failure
      // footnote (the resident's car is otherwise tow-eligible until
      // they add it via the portal).
      const submittableVehicles = vehicles
        .filter((v: any) => typeof v.plate === 'string' && v.plate.trim().length > 0)
        .map((v: any) => ({
          plate: v.plate,
          state: v.state,
          make: v.make,
          model: v.model,
          year: v.year ? parseInt(v.year, 10) : null,
          color: v.color,
        }))
      if (submittableVehicles.length > 0) {
        try {
          const res = await fetch('/api/register/companion-vehicle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vehicles: submittableVehicles }),
          })
          if (!res.ok) {
            // Route-level failure (401, 500, network). Treat ALL submitted
            // plates as not-registered for the gap message — the route
            // either rejected the call or never got far enough to insert.
            const failedPlates = submittableVehicles.map(v => normalizePlate(v.plate))
            console.error('[B209-route-error]', { status: res.status })
            setVehicleGapMessage(
              `⚠ Your vehicle${failedPlates.length === 1 ? '' : 's'} (${failedPlates.join(', ')}) ${failedPlates.length === 1 ? 'is' : 'are'} NOT yet registered and could be towed if parked at your property. Sign in to your resident portal now and submit ${failedPlates.length === 1 ? 'it' : 'each'} through "Request a Vehicle" — it only takes a minute and you'll see status updates as your manager approves.`
            )
          } else {
            const body = await res.json().catch(() => ({}))
            if (body?.gap_message) setVehicleGapMessage(body.gap_message)
          }
        } catch (fetchErr) {
          // Network-class failure. Same soft-fail treatment.
          const failedPlates = submittableVehicles.map(v => normalizePlate(v.plate))
          console.error('[B209-route-fetch-failed]', { error: (fetchErr as Error).message })
          setVehicleGapMessage(
            `⚠ Your vehicle${failedPlates.length === 1 ? '' : 's'} (${failedPlates.join(', ')}) ${failedPlates.length === 1 ? 'is' : 'are'} NOT yet registered and could be towed if parked at your property. Sign in to your resident portal now and submit ${failedPlates.length === 1 ? 'it' : 'each'} through "Request a Vehicle" — it only takes a minute and you'll see status updates as your manager approves.`
          )
        }
      }

      // B155.2 F4 — consent capture is legal-evidence (proof of ToS/
      // Privacy acceptance at signup). Stamp user_email explicitly so
      // the audit_logs self-attribution WITH CHECK admits the row.
      // signInWithPassword above (line 90-93) created the session, so
      // auth.jwt()->>'email' matches account.email. Surface insert
      // failures via console.error (not alert) so a legitimate audit
      // miss is loud in monitoring without blocking registration —
      // consent capture must not fail the signup.
      const { error: auditErr } = await supabase.from('audit_logs').insert([
        {
          user_email: account.email.trim().toLowerCase(),
          action: 'REGISTRATION_TOS_ACCEPTED',
          table_name: 'residents',
          new_values: { email: account.email.trim(), property: property || null },
        },
      ])
      if (auditErr) console.error('[B155.2 F4] REGISTRATION_TOS_ACCEPTED audit insert failed:', auditErr.message)
      // Sign out — registration complete, account is in pending state.
      // Leaving the session active would auto-redirect to /resident on
      // the next nav and surface a "pending" landing page; signing out
      // keeps the success page anonymous and "Back to Login" clean.
      await supabase.auth.signOut()
      setDone(true)
    } catch (e: any) {
      setError(e.message || 'An unexpected error occurred. Please try again.')
    }
    setSubmitting(false)
  }

  const displayName = companyName || 'ShieldMyLot'

  if (done) {
    return (
      <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
        <div style={{ maxWidth:'460px', width:'100%', textAlign:'center' }}>
          <div style={{ background:'#0d1f0d', border:'1px solid #2e7d32', borderRadius:'16px', padding:'40px 32px' }}>
            <div style={{ fontSize:'48px', marginBottom:'16px' }}>✓</div>
            <p style={{ color:'#4caf50', fontWeight:'bold', fontSize:'20px', margin:'0 0 12px' }}>Registration Submitted!</p>
            <p style={{ color:'#aaa', fontSize:'14px', lineHeight:'1.7', margin:'0 0 24px' }}>
              Your property manager will review and approve your account.
              You will be able to log in once approved.
            </p>
            {property && <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>Property: {property}</p>}
          </div>
          {/* B209 — unmissable tow-stakes warning. Rendered as a high-
              contrast warning band immediately below the success card,
              ABOVE the back-to-login link, so the resident can't dismiss
              the success screen without seeing it. Copy lives in the
              gap_message field (server-built for single/multiple plate
              cases, network-failure fallback built client-side). */}
          {vehicleGapMessage && (
            <div role="alert" style={{ background:'#3a1a08', border:'2px solid #f59e0b', borderRadius:'14px', padding:'18px 22px', marginTop:'20px', textAlign:'left' }}>
              <p style={{ color:'#fbbf24', fontWeight:'bold', fontSize:'13px', textTransform:'uppercase', letterSpacing:'0.06em', margin:'0 0 10px' }}>Action required — tow risk</p>
              <p style={{ color:'#fef3c7', fontSize:'14px', lineHeight:'1.65', margin:'0 0 14px' }}>{vehicleGapMessage}</p>
              <a href="/login" style={{ display:'inline-block', background:'#f59e0b', color:'#0f1117', fontWeight:'bold', fontSize:'13px', padding:'9px 18px', borderRadius:'8px', textDecoration:'none' }}>Sign in and register your vehicle →</a>
            </div>
          )}
          <a href="/login" style={{ display:'block', marginTop:'20px', color:'#C9A227', fontSize:'13px', textDecoration:'none' }}>← Back to Login</a>
        </div>
      </main>
    )
  }

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'440px', width:'100%' }}>

        {/* Header */}
        <div style={{ marginBottom:'24px', textAlign:'center' }}>
          {logoFailed
            ? <div style={{ width:'70px', height:'70px', borderRadius:'10px', border:'2px solid #C9A227', marginBottom:'10px', background:'#1e2535', color:'#C9A227', fontSize:'24px', fontWeight:'bold', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 10px' }}>A1</div>
            : <img src={resolvedLogo} alt={displayName} style={{ width:'70px', height:'70px', borderRadius:'10px', border:'2px solid #C9A227', marginBottom:'10px', display:'block', margin:'0 auto 10px' }} onError={() => setLogoFailed(true)} />
          }
          <h1 style={{ color:'#C9A227', fontSize:'22px', fontWeight:'bold', margin:'0 0 4px' }}>{displayName}</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'0 0 4px' }}>Resident Registration</p>
          {property && <p style={{ color:'#555', fontSize:'11px', margin:'0' }}>{property}</p>}
        </div>

        {/* Step indicator */}
        <div style={{ display:'flex', gap:'6px', marginBottom:'20px' }}>
          {[1,2,3].map(s => (
            <div key={s} style={{ flex:1, height:'4px', borderRadius:'2px', background: s <= step ? '#C9A227' : '#2a2f3d' }} />
          ))}
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'24px' }}>

          {error && (
            <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'8px', padding:'10px 14px', marginBottom:'16px' }}>
              <p style={{ color:'#f44336', fontSize:'13px', margin:'0' }}>{error}</p>
            </div>
          )}

          {/* ── STEP 1: Account Info ── */}
          {step === 1 && (
            <div>
              <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'14px', margin:'0 0 16px' }}>Step 1 of 3 — Account Info</p>

              <label style={lbl}>Email *</label>
              <input type="email" value={account.email} onChange={e => setAccount({...account, email: e.target.value})}
                placeholder="you@email.com" style={inp} />

              <label style={lbl}>Password * (min 8 characters)</label>
              <input type="password" value={account.password} onChange={e => setAccount({...account, password: e.target.value})}
                placeholder="••••••••" style={inp} />

              <label style={lbl}>Confirm Password *</label>
              <input type="password" value={account.confirm} onChange={e => setAccount({...account, confirm: e.target.value})}
                placeholder="••••••••" style={inp} />

              <label style={lbl}>Full Name *</label>
              <input value={account.name} onChange={e => setAccount({...account, name: e.target.value})}
                placeholder="John Smith" style={inp} />

              <label style={lbl}>Phone</label>
              <input type="tel" value={account.phone} onChange={e => setAccount({...account, phone: e.target.value})}
                placeholder="713-555-0100" style={inp} />

              <label style={lbl}>Unit Number *</label>
              <input value={account.unit} onChange={e => setAccount({...account, unit: e.target.value})}
                placeholder="e.g. Apt 214 or Unit 5" style={inp} />

              <button onClick={() => {
                const err = validateStep1()
                if (err) { setError(err); return }
                setError('')
                setStep(2)
              }} style={{ width:'100%', padding:'13px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'8px', cursor:'pointer' }}>
                Next →
              </button>
            </div>
          )}

          {/* ── STEP 2: Vehicles ── */}
          {step === 2 && (
            <div>
              <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'14px', margin:'0 0 4px' }}>Step 2 of 3 — Add Vehicles</p>
              <p style={{ color:'#555', fontSize:'12px', margin:'0 0 16px' }}>Optional. Add up to 2 vehicles to register with your unit.</p>

              {vehicles.map((v, i) => (
                <div key={i} style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'12px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'10px' }}>
                    <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'12px', margin:'0' }}>Vehicle {i+1}</p>
                    <button onClick={() => setVehicles(vehicles.filter((_,idx) => idx !== i))}
                      style={{ background:'none', border:'none', color:'#f44336', cursor:'pointer', fontSize:'13px', padding:'2px 6px' }}>✕</button>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                    <div style={{ gridColumn:'span 2' }}>
                      <label style={lbl}>License Plate *</label>
                      <input value={v.plate} onChange={e => updateVehicle(i, 'plate', normalizePlate(e.target.value))}
                        placeholder="ABC1234" style={{ ...inp, fontFamily:'Courier New', fontSize:'16px', fontWeight:'bold', textAlign:'center', letterSpacing:'0.1em' }} />
                    </div>
                    <div>
                      <label style={lbl}>State</label>
                      <select value={v.state} onChange={e => updateVehicle(i, 'state', e.target.value)} style={inp}>
                        {US_STATES.map(s => <option key={s}>{s}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={lbl}>Color</label>
                      <input value={v.color} onChange={e => updateVehicle(i, 'color', e.target.value)} placeholder="Black" style={inp} />
                    </div>
                    <div>
                      <label style={lbl}>Make</label>
                      <input value={v.make} onChange={e => updateVehicle(i, 'make', e.target.value)} placeholder="Toyota" style={inp} />
                    </div>
                    <div>
                      <label style={lbl}>Model</label>
                      <input value={v.model} onChange={e => updateVehicle(i, 'model', e.target.value)} placeholder="Camry" style={inp} />
                    </div>
                    <div style={{ gridColumn:'span 2' }}>
                      <label style={lbl}>Year</label>
                      <input value={v.year} onChange={e => updateVehicle(i, 'year', e.target.value)} placeholder="2022" style={inp} />
                    </div>
                  </div>
                </div>
              ))}

              {vehicles.length < 2 && (
                <button onClick={addVehicle}
                  style={{ width:'100%', padding:'11px', background:'#1e2535', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'8px', cursor:'pointer', fontSize:'13px', fontWeight:'bold', marginBottom:'12px' }}>
                  + Add Vehicle
                </button>
              )}

              <div style={{ display:'flex', gap:'8px' }}>
                <button onClick={() => { setError(''); setStep(1) }}
                  style={{ flex:1, padding:'12px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontSize:'13px', fontFamily:'Arial' }}>
                  ← Back
                </button>
                <button onClick={() => { setError(''); setStep(3) }}
                  style={{ flex:2, padding:'12px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor:'pointer' }}>
                  {vehicles.length === 0 ? 'No vehicles yet →' : 'Next →'}
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 3: Review & Submit ── */}
          {step === 3 && (
            <div>
              <p style={{ color:'#C9A227', fontWeight:'bold', fontSize:'14px', margin:'0 0 16px' }}>Step 3 of 3 — Review & Submit</p>

              <div style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 10px' }}>Account Info</p>
                <div style={{ display:'grid', gap:'6px', fontSize:'13px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between' }}><span style={{ color:'#555' }}>Name</span><span style={{ color:'white' }}>{account.name}</span></div>
                  <div style={{ display:'flex', justifyContent:'space-between' }}><span style={{ color:'#555' }}>Email</span><span style={{ color:'white' }}>{account.email}</span></div>
                  {account.phone && <div style={{ display:'flex', justifyContent:'space-between' }}><span style={{ color:'#555' }}>Phone</span><span style={{ color:'white' }}>{account.phone}</span></div>}
                  <div style={{ display:'flex', justifyContent:'space-between' }}><span style={{ color:'#555' }}>Unit</span><span style={{ color:'white' }}>{account.unit}</span></div>
                  {property && <div style={{ display:'flex', justifyContent:'space-between' }}><span style={{ color:'#555' }}>Property</span><span style={{ color:'white' }}>{property}</span></div>}
                </div>
              </div>

              {vehicles.filter(v => v.plate.trim()).length > 0 && (
                <div style={{ background:'#0f1117', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px', marginBottom:'14px' }}>
                  <p style={{ color:'#888', fontSize:'10px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 10px' }}>Vehicles ({vehicles.filter(v => v.plate.trim()).length})</p>
                  {vehicles.filter(v => v.plate.trim()).map((v, i) => (
                    <div key={i} style={{ marginBottom:'6px', padding:'8px 10px', background:'#161b26', borderRadius:'8px' }}>
                      <p style={{ color:'white', fontFamily:'Courier New', fontSize:'15px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
                      <p style={{ color:'#888', fontSize:'11px', margin:'2px 0 0' }}>{[v.color, v.make, v.model, v.year, v.state].filter(Boolean).join(' ')}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Texas-only informational notice (no checkbox) */}
              <div style={{ background:'#1a1f2e', border:'1px solid #C9A227', borderRadius:'8px', padding:'10px 12px', marginBottom:'12px' }}>
                <p style={{ color:'#C9A227', fontSize:'13px', textAlign:'center', margin:'0' }}>🤠 ShieldMyLot currently operates in Texas only.</p>
              </div>

              <label style={{ display:'flex', alignItems:'flex-start', gap:'10px', marginBottom:'14px', cursor:'pointer' }}>
                <input type="checkbox" checked={tosChecked} onChange={e => setTosChecked(e.target.checked)}
                  style={{ marginTop:'3px', accentColor:'#C9A227', cursor:'pointer' }} />
                <span style={{ color:'#aaa', fontSize:'12px', lineHeight:'1.6' }}>
                  I agree to the{' '}
                  <a href="/terms" target="_blank" style={{ color:'#C9A227', textDecoration:'none' }}>Terms of Service</a>
                  {' '}and{' '}
                  <a href="/privacy" target="_blank" style={{ color:'#C9A227', textDecoration:'none' }}>Privacy Policy</a>
                </span>
              </label>

              {/* CAPTCHA — Cloudflare Turnstile (Managed). Gates submit; the
                  /api/register/captcha-verify wrapper validates the token
                  server-side BEFORE the swift-handler user-create. */}
              <div style={{ marginTop:'16px', marginBottom:'16px' }}>
                <p style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em', margin:'0 0 8px' }}>Confirm you&apos;re human</p>
                <TurnstileWidget
                  ref={turnstileRef}
                  onVerify={setCaptchaToken}
                  onExpire={() => setCaptchaToken(null)}
                  onError={() => setCaptchaToken(null)}
                  action="register"
                />
              </div>

              {(() => {
                const allChecked = tosChecked
                const disabled = submitting || !allChecked || !captchaToken
                return (
                  <div style={{ display:'flex', gap:'8px' }}>
                    <button onClick={() => { setError(''); setStep(2) }}
                      style={{ flex:1, padding:'12px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'8px', cursor:'pointer', fontSize:'13px', fontFamily:'Arial' }}>
                      ← Back
                    </button>
                    <button onClick={submit} disabled={disabled}
                      style={{ flex:2, padding:'12px', background: disabled ? '#555' : '#C9A227', color: disabled ? '#888' : '#0f1117', fontWeight:'bold', fontSize:'13px', border:'none', borderRadius:'8px', cursor: disabled ? 'not-allowed' : 'pointer' }}>
                      {submitting ? 'Submitting...' : 'Submit Registration'}
                    </button>
                  </div>
                )
              })()}
            </div>
          )}
        </div>

        <p style={{ color:'#333', fontSize:'11px', textAlign:'center', marginTop:'16px' }}>Already registered? <a href="/login" style={{ color:'#C9A227' }}>Sign in here</a></p>
      </div>
    </main>
  )
}

export default function Register() {
  return (
    <Suspense fallback={<div style={{ minHeight:'100vh', background:'#0f1117' }} />}>
      <RegisterForm />
    </Suspense>
  )
}

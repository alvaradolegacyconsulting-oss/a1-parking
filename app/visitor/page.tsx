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
  // 2026-07-27 — phantom-pass guard. If a scanner arrives with a
  // ?property= value that doesn't resolve in the DB, previous behaviour
  // rendered a plausible-looking form that submitted with the raw URL
  // string as the property — writing a visitor_passes row invisible to
  // enforcement (driver plate-lookup scopes by the DB-resolved property
  // name). Root cause was /qr's hardcoded PROPERTIES array drifting
  // from the properties table after a data wipe. This state tracks the
  // resolution result so the form only renders when the property is
  // actually resolvable.
  //   null   → resolution in flight (or 'Managed Property' fallback)
  //   true   → resolved; render form
  //   false  → unresolved; render invalid-link message, no form
  const [propertyResolved, setPropertyResolved] = useState<boolean | null>(null)
  // 2026-07-28 — canonical name for write paths. get_property_for_visitor
  // is alias-aware (property_name_aliases table); when the URL param uses
  // an alias (e.g. "Green Acers" post-rename), the RPC returns the
  // canonical name ("Green Acres"). We use the canonical value in the
  // POST body so the visitor_passes row is keyed to the property row
  // enforcement actually queries. Falls back to the raw URL param until
  // the RPC resolves — the guard render below prevents form submit
  // while propertyResolved is false, so a fallback is never sent as
  // a write.
  const [resolvedPropertyName, setResolvedPropertyName] = useState<string>(propertyName)

  useEffect(() => {
    async function loadSupportInfo() {
      if (propertyName && propertyName !== 'Managed Property') {
        // B155.3 — anon RPCs replace direct table SELECTs. Same data
        // shape; safe columns only; no anon over-read.
        const { data: propRows } = await supabase.rpc('get_property_for_visitor', { p_name: propertyName })
        const prop = propRows?.[0] as { name: string; company: string } | undefined
        if (prop?.company) {
          setPropertyResolved(true)
          setResolvedPropertyName(prop.name)
          const { data: coRows } = await supabase.rpc('get_company_branding', { p_name: prop.company })
          const co = coRows?.[0] as { support_phone: string | null; support_email: string | null; support_website: string | null; display_name: string | null } | undefined
          if (co) {
            setSupportPhone(co.support_phone || '')
            setSupportEmail(co.support_email || '')
            setSupportWebsite(co.support_website || '')
            setCompanyName(co.display_name || prop.company)
            return
          }
        } else {
          // Property URL param doesn't match any row. Log and flip the
          // guard so the render path shows the invalid-link message
          // rather than a submittable form. Anon page — no audit_logs
          // write available; console.error is the visibility path for
          // future mismatches (source/DB drift, mistyped links, stale
          // signage).
          console.error('[visitor-property-unresolved]', { propertyName })
          setPropertyResolved(false)
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
  // Option C (2026-08-03 Mateo review) — refresh only when the token
  // is actually stale, not before every submit. useRef (not useState)
  // because it's read in the same tick it may have been written from
  // the onVerify callback; React batching would give a stale value.
  // Third instance of this class rule this weekend (after 7fdbcf9's
  // fetchResidentsToken and Finding 3's warnAcknowledged bug).
  //
  // 3.5 min TTL sits inside /siteverify's ~5 min effective window
  // with a safety margin — a submit issued just under 3.5min after
  // token issue still has ~1.5min to reach /siteverify.
  //
  // Refresh call is the failing path on Safari (iframe recreated →
  // postMessage handshake blocked). Age-gating removes the vast
  // majority of refreshes without dropping Bug 1 Option B's dwell
  // protection: a genuine 4+ min dwell still triggers refresh.
  const tokenIssuedAt = useRef<number>(0)
  const TOKEN_MAX_AGE_MS = 3.5 * 60 * 1000
  // Copy fix bundled — retry-interim message renders amber ABOVE the
  // red plateError block instead of hijacking the error slot.
  // "Still working" reading as "failed" was Mateo's flag.
  const [interimMsg, setInterimMsg] = useState<string | null>(null)
  // Finding 3 (2026-08-04): two-step warn when the plate matches an
  // on-record inactive vehicle (pending/declined/expired). First
  // submit runs the precheck; on match, sets warnPending=true and
  // stops. The rendered warn block offers "Continue and issue pass"
  // (sets warnAcknowledged=true; re-submit) or Cancel.
  //
  // warnAcknowledged is checked in submitPass to skip the warn branch
  // on the second call. Reset to false on plate/unit edit — a fresh
  // plate needs its own acknowledgement.
  const [warnPending, setWarnPending] = useState(false)
  const [warnAcknowledged, setWarnAcknowledged] = useState(false)

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

  // bypassOnRecordWarn arg (Finding 3): the "Continue and issue pass"
  // button calls submitPass(true) directly rather than relying on
  // warnAcknowledged state — React 18 batches state updates in event
  // handlers, so setWarnAcknowledged(true) + submitPass() would read
  // stale (false) from closure. Explicit arg sidesteps the batching
  // window entirely. warnAcknowledged state kept for the reset-on-
  // plate-edit path.
  async function submitPass(bypassOnRecordWarn: boolean = false) {
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
    setInterimMsg(null)

    // Bug 1 Option B (2026-07-14) — refresh CAPTCHA token when it's
    // actually stale. Original unconditional pre-submit refresh
    // protected the 6+ min dwell case (invalid-input-response at
    // /siteverify), but destroyed and recreated the iframe on every
    // submit — which Safari blocks on the postMessage handshake
    // (Mateo diagnostic 2026-08-03).
    //
    // Option C (2026-08-03) — age-gated refresh. Skip when the token
    // is fresh (< TOKEN_MAX_AGE_MS = 3.5 min); refresh only for
    // genuine dwellers. Precheck RPCs (check_resident_plate,
    // check_plate_on_record_inactive_at_property) do NOT consume the
    // token — only /siteverify does — so on the Continue re-submit
    // the token from the first attempt is genuinely still valid and
    // can be reused. Reset-on-consumption paths (:reset() calls in
    // catch blocks below) stay unchanged.
    let freshToken: string
    if (Date.now() - tokenIssuedAt.current > TOKEN_MAX_AGE_MS) {
      try {
        const t = await turnstileRef.current?.refresh()
        if (!t) throw new Error('refresh returned no token')
        freshToken = t
      } catch (refreshErr) {
        setLoading(false)
        setCaptchaToken(null)
        setInterimMsg(null)
        turnstileRef.current?.reset()
        setPlateError(
          `CAPTCHA challenge failed to refresh (${(refreshErr as Error).message}). ` +
          `Please solve the CAPTCHA below and try again.`,
        )
        return
      }
    } else {
      // Token still fresh — reuse as-is. captchaToken is guaranteed
      // non-null (button disabled otherwise; explicit check above).
      freshToken = captchaToken
    }

    const plate = normalizePlate(form.plate)

    // B74: anon precheck swapped from direct vehicles SELECT to the
    // SECURITY DEFINER check_resident_plate RPC. The vehicles table
    // now has RLS enabled with no anon policy — direct .from() would
    // return zero rows. The RPC returns a minimum-leak boolean (no row
    // visibility, no count enumeration).
    if (propertyName !== 'Managed Property') {
      // Finding 3 (2026-08-04): parallel precheck. check_resident_plate
      // (existing) blocks for is_active=true residents. New
      // check_plate_on_record_inactive_at_property returns TRUE for
      // any plate matching an is_active=false vehicle in status
      // (pending, declined, expired). Parallel keeps latency = max
      // rather than sum + no timing-attack signal (either both fire
      // or neither).
      //
      // Deactivated vehicles deliberately EXCLUDED from the second
      // check — moved-out residents can be genuine visitors.
      const [residentRes, onRecordRes] = await Promise.all([
        supabase.rpc('check_resident_plate', { p_plate: plate, p_property: propertyName }),
        supabase.rpc('check_plate_on_record_inactive_at_property', { p_plate: plate, p_property: propertyName }),
      ])

      if (residentRes.data === true) {
        // Existing behavior preserved (Mateo lock 2026-08-04): active-
        // resident is a hard block — a pass for an already-authorized
        // vehicle is a no-op. Copy unchanged.
        setLoading(false)
        setPlateError('This plate is already registered to a resident at this property and does not need a visitor pass.')
        return
      }
      if (onRecordRes.data === true && !bypassOnRecordWarn) {
        // Two-step warn: on first submit, show the warn block and
        // stop. User clicks "Continue and issue pass" → sets
        // warnAcknowledged → re-submit skips this branch.
        // Uniform copy across pending/declined/expired — the RPC
        // returns boolean only, no distinguishing state string
        // reaches the client. Anti-enumeration between the three
        // inactive states.
        setLoading(false)
        setWarnPending(true)
        return
      }
      // Fall-through cases:
      //  • onRecordRes.data === true && warnAcknowledged → proceed
      //  • both false                                    → proceed (unknown / genuine visitor)
      //  • onRecordRes has error                         → proceed (silent-read: don't block on transient RPC failure; the create-pass step still enforces per-plate limit)
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
          // Bug 1 Option B — freshToken (from refresh() above), not the
          // React-state captchaToken (which reflects an older solve and
          // may be stale by the time /siteverify sees it).
          captchaToken: freshToken,
          plate,
          visitor_name: form.name,
          visiting_unit: form.unit,
          // 2026-07-28 — canonical name from get_property_for_visitor
          // (alias-aware) instead of raw URL param. Ensures the pass row
          // keys to the property row enforcement actually queries after
          // a rename with an alias in circulation.
          property: resolvedPropertyName,
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
    // TODO: custom format — visitor pass expiry short display (HH:MM · Aug 5); needs formatTime + formatDate variants with month:short opt
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) +
           ' · ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  // 2026-07-27 — phantom-pass guard render. If the ?property= URL param
  // was present but didn't resolve in the DB, refuse to render the form.
  // Prevents writing visitor_passes rows against a property string that
  // no enforcement query can match. Loading state (null) falls through
  // to the form (existing behaviour) so a slow RPC doesn't visibly
  // block; the guard only bites on a confirmed non-match.
  if (propertyName !== 'Managed Property' && propertyResolved === false) {
    return (
      <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
        <div style={{ maxWidth:'420px', width:'100%' }}>
          <div style={{ marginBottom:'24px', textAlign:'center' }}>
            <h1 style={{ color:'#C9A227', fontSize:'22px', fontWeight:'bold', margin:'0' }}>ShieldMyLot&trade;</h1>
          </div>
          <div style={{ background:'#161b26', border:'1px solid #b71c1c', borderRadius:'12px', padding:'24px', textAlign:'center' }}>
            <div style={{ width:'56px', height:'56px', borderRadius:'50%', background:'#1e1a0a', border:'2px solid #f44336', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 16px', fontSize:'24px' }}>⚠</div>
            <h2 style={{ color:'#f44336', fontSize:'17px', fontWeight:'bold', margin:'0 0 12px' }}>This parking-pass link isn&apos;t valid</h2>
            <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.6', margin:'0 0 8px' }}>
              We couldn&apos;t find a property matching this link. The link may be outdated or contain a typo.
            </p>
            <p style={{ color:'#666', fontSize:'12px', lineHeight:'1.6', margin:'0' }}>
              Please contact the property directly for a valid visitor-pass link.
            </p>
          </div>
        </div>
      </main>
    )
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
                  {tile('Property', resolvedPropertyName)}
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
          <p style={{ color:'#888', fontSize:'13px', margin:'6px 0 0' }}>Visitor Parking Pass · {resolvedPropertyName}</p>
          <p style={{ color:'#555', fontSize:'11px', margin:'4px 0 0' }}>Valid up to 24 hours · No app download required</p>
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'24px' }}>
          
          <div style={{ marginBottom:'14px' }}>
            <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>License Plate *</label>
            <input
              value={form.plate}
              onChange={e => {
                setForm({...form, plate: normalizePlate(e.target.value)})
                // Reset warn state on plate edit — a fresh plate needs
                // its own acknowledgement; old one no longer relevant.
                if (warnPending || warnAcknowledged) { setWarnPending(false); setWarnAcknowledged(false) }
              }}
              placeholder="ABC1234"
              style={{ display:'block', width:'100%', marginTop:'6px', padding:'12px', fontSize:'20px', fontFamily:'Courier New', fontWeight:'bold', letterSpacing:'0.1em', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', textAlign:'center', outline:'none', boxSizing:'border-box' }}
            />
            {limitStatus?.state === 'exempt' && (
              <p style={{ color:'#4caf50', fontSize:'11px', margin:'6px 0 0' }}>✓ Exempt plate — no limit</p>
            )}
            {limitStatus?.state === 'within' && (
              // 2026-07-29: anon RPC omits used/limit — rolling-30
              // would leak visit history if rendered here. Show only
              // that the plate is within the limit.
              <p style={{ color:'#888', fontSize:'11px', margin:'6px 0 0' }}>This vehicle is within the visitor pass limit at this property.</p>
            )}
            {limitStatus?.state === 'at_limit' && (
              // 2026-07-29: rolling-30 window; the count isn't shown
              // to anon (visit-history leak). Copy no longer says "wait
              // for passes to expire" — waiting doesn't help under
              // rolling-30, the count is issue-based.
              <p style={{ color:'#f44336', fontSize:'11px', margin:'6px 0 0', lineHeight:'1.5' }}>This vehicle has reached the visitor pass limit at this property. Contact the property manager if you need access.</p>
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

          {/* Interim (amber) — progress messages that AREN'T failures.
              Renders ABOVE the red plateError block so a "still
              working" message doesn't sit in the error slot reading
              as a failure (Mateo lock 2026-08-03). Currently used by
              Turnstile's onRetry callback ("Taking longer than usual
              — retrying…"). Cleared on the next state transition
              (submit success, hard error, or fresh onVerify). */}
          {interimMsg && !plateError && (
            <div style={{ background:'#2a1e00', border:'1px solid #a16207', borderRadius:'8px', padding:'10px 12px', marginBottom:'14px' }}>
              <p style={{ color:'#fbbf24', fontSize:'12px', margin:'0', lineHeight:'1.5' }}>{interimMsg}</p>
            </div>
          )}

          {plateError && (
            <div style={{ background:'#3a1a1a', border:'1px solid #b71c1c', borderRadius:'8px', padding:'10px 12px', marginBottom:'14px' }}>
              <p style={{ color:'#f44336', fontSize:'12px', margin:'0', lineHeight:'1.5' }}>{plateError}</p>
            </div>
          )}

          {/* Finding 3 warn — plate matches an is_active=false vehicle
              in status (pending/declined/expired). UNIFORM copy across
              the three states — no distinguishing text reaches the
              client (RPC returns boolean only). Two-step: user must
              click "Continue and issue pass" to proceed. warnPending
              controls visibility; warnAcknowledged controls the second-
              submit path in submitPass. Manager_note NEVER reaches
              this surface — it's authenticated-only. */}
          {warnPending && (
            <div style={{ background:'#2a1e00', border:'1px solid #a16207', borderRadius:'8px', padding:'12px 14px', marginBottom:'14px' }}>
              <p style={{ color:'#fbbf24', fontSize:'13px', fontWeight:'bold', margin:'0 0 8px', lineHeight:'1.5' }}>
                This plate is already on record at this property.
              </p>
              <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 6px', lineHeight:'1.6' }}>
                If it&apos;s your vehicle, check your resident portal or contact your property manager — a visitor pass doesn&apos;t change how your vehicle is registered.
              </p>
              {/* Non-permissive framing: state what a pass IS, don't
                  grant permission to park. Platform describes; property
                  rules decide. See
                  feedback_platform_states_facts_not_permissions.md. */}
              <p style={{ color:'#aaa', fontSize:'12px', margin:'0 0 12px', lineHeight:'1.6' }}>
                A pass can still be issued. It does not exempt any vehicle from this property&apos;s parking rules.
              </p>
              <div style={{ display:'flex', gap:'8px' }}>
                <button
                  onClick={() => { setWarnAcknowledged(true); setWarnPending(false); submitPass(true) }}
                  disabled={loading}
                  style={{ flex:1, padding:'10px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'12px', border:'none', borderRadius:'6px', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}
                >
                  Continue and issue pass
                </button>
                <button
                  onClick={() => { setWarnPending(false) }}
                  style={{ padding:'10px 14px', background:'#1e2535', color:'#aaa', fontSize:'12px', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer' }}
                >
                  Cancel
                </button>
              </div>
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
              onVerify={(token) => {
                // Option C — record issuance time so submitPass can
                // decide whether to refresh (age-based). Fires on
                // both initial mount AND post-refresh callbacks.
                setCaptchaToken(token)
                tokenIssuedAt.current = Date.now()
                // Clear any lingering interim message on successful
                // verify — the retry completed.
                setInterimMsg(null)
              }}
              onExpire={() => setCaptchaToken(null)}
              onError={() => setCaptchaToken(null)}
              // Copy fix — amber interim, NOT red error slot.
              onRetry={() => setInterimMsg('Taking longer than usual — retrying…')}
              action="visitor"
            />
          </div>

          <button
            onClick={() => submitPass()}
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
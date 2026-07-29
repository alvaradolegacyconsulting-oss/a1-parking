'use client'
import { useState, useEffect, useMemo } from 'react'
import { QRCodeCanvas as QRCode } from 'qrcode.react'
import { supabase } from '../supabase'

// 2026-07-29: rebuilt to derive from the properties table.
//
// Previously a hardcoded PROPERTIES array (11 entries, from 2026-04-29
// pre-wipe) that had drifted from the DB — the "Green Acers vs Green
// Acres" mismatch that surfaced on A1's go-live day originated here.
// Hardcoded reference data survives data wipes; deriving from the
// table is what stops it recurring the next time a property is added,
// renamed, or deactivated.
//
// Role gate (added this pass): admin or company_admin only. Previously
// no client-side auth check; middleware only required *some* session,
// so a resident or driver could load /qr. Tightening — not a
// restriction of anything in use.
//
// Managers deliberately excluded. They generate /visitor links from
// their own portal (manager/page.tsx:4211) scoped to their assigned
// property. If a manager needs a printable sign, that's a follow-up
// that scopes to their assigned properties, not something to fold in
// here.
//
// Branding is derived from the SELECTED PROPERTY'S company (via
// get_company_branding RPC), not the viewer's — under super-admin
// scope a sign for Demo Company must carry Demo's branding, not A1's.

type Property = {
  id: number
  name: string
  company: string
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
}

type CompanyBranding = {
  display_name: string | null
  support_phone: string | null
  support_website: string | null
}

type AuthState =
  | { status: 'loading' }
  | { status: 'unauthorized' }
  | { status: 'ready'; role: 'admin' | 'company_admin' }

export default function QRPage() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  const [properties, setProperties] = useState<Property[] | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [branding, setBranding] = useState<CompanyBranding | null>(null)

  // ── Role gate ──────────────────────────────────────────────────────
  useEffect(() => {
    async function checkAuth() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user?.email) { setAuth({ status: 'unauthorized' }); return }
      const { data: roleRow } = await supabase
        .from('user_roles')
        .select('role')
        .ilike('email', user.email)
        .maybeSingle()
      const role = roleRow?.role
      if (role === 'admin' || role === 'company_admin') {
        setAuth({ status: 'ready', role })
      } else {
        setAuth({ status: 'unauthorized' })
      }
    }
    checkAuth()
  }, [])

  // ── Fetch properties. RLS scopes: admin sees all (admin_all_
  // properties FOR ALL), company_admin sees own (company_admin_
  // select_properties USING company match). Filter is_active=true —
  // a deactivated property should not be offered a printable sign.
  useEffect(() => {
    if (auth.status !== 'ready') return
    async function loadProperties() {
      const { data } = await supabase
        .from('properties')
        .select('id, name, company, address, city, state, zip')
        .eq('is_active', true)
        .order('company')
        .order('name')
      if (data && data.length > 0) {
        setProperties(data as Property[])
        setSelectedId(data[0].id)
      } else {
        setProperties([])
      }
    }
    loadProperties()
  }, [auth])

  const selected = useMemo(
    () => properties?.find(p => p.id === selectedId) ?? null,
    [properties, selectedId],
  )

  // ── Fetch branding for the selected property's company. Not the
  // viewer's — super-admin can pick a property from any company, and
  // the sign must carry that company's branding.
  useEffect(() => {
    if (!selected) { setBranding(null); return }
    async function loadBranding() {
      if (!selected) return
      const { data } = await supabase.rpc('get_company_branding', { p_name: selected.company })
      const row = (data as CompanyBranding[] | null)?.[0]
      setBranding(row ?? { display_name: null, support_phone: null, support_website: null })
    }
    loadBranding()
  }, [selected])

  // Compose address from parts, handling nulls — a property with no
  // address should render its name alone, not "null, null, TX null".
  const addressLine = useMemo(() => {
    if (!selected) return ''
    const parts: string[] = []
    if (selected.address) parts.push(selected.address)
    const cityStateZip = [selected.city, selected.state].filter(Boolean).join(', ')
    const tail = [cityStateZip, selected.zip].filter(Boolean).join(' ')
    if (tail) parts.push(tail)
    return parts.join(', ')
  }, [selected])

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://shieldmylot.com'
  const visitorUrl = selected ? `${baseUrl}/visitor?property=${encodeURIComponent(selected.name)}` : ''

  // ── Render gates ───────────────────────────────────────────────────
  if (auth.status === 'loading') {
    return (
      <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'20px' }}>
        <div style={{ maxWidth:'500px', margin:'40px auto', textAlign:'center' }}>
          <p style={{ color:'#888', fontSize:'13px' }}>Loading…</p>
        </div>
      </main>
    )
  }

  if (auth.status === 'unauthorized') {
    return (
      <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'20px' }}>
        <div style={{ maxWidth:'500px', margin:'40px auto', textAlign:'center' }}>
          <div style={{ background:'#161b26', border:'1px solid #b71c1c', borderRadius:'12px', padding:'24px' }}>
            <div style={{ width:'56px', height:'56px', borderRadius:'50%', background:'#1e1a0a', border:'2px solid #f44336', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 16px', fontSize:'24px' }}>⚠</div>
            <h2 style={{ color:'#f44336', fontSize:'17px', fontWeight:'bold', margin:'0 0 12px' }}>Not authorized</h2>
            <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.6', margin:'0' }}>
              The QR generator is available to super-admins and company administrators.
            </p>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'500px', margin:'0 auto' }}>

        <div style={{ marginBottom:'24px', textAlign:'center' }}>
          <h1 style={{ color:'#C9A227', fontSize:'24px', fontWeight:'bold', margin:'0' }}>ShieldMyLot</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'6px 0 0' }}>QR Code Generator · Visitor Pass Signs</p>
        </div>

        <a href="/" style={{ display:'inline-block', marginBottom:'20px', color:'#C9A227', fontSize:'13px', textDecoration:'none' }}>
          ← Back to Plate Lookup
        </a>

        {properties === null && (
          <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'20px', marginBottom:'16px', textAlign:'center' }}>
            <p style={{ color:'#888', fontSize:'13px', margin:'0' }}>Loading properties…</p>
          </div>
        )}

        {properties !== null && properties.length === 0 && (
          <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'20px', marginBottom:'16px', textAlign:'center' }}>
            <p style={{ color:'#aaa', fontSize:'13px', margin:'0' }}>No properties available — add one first.</p>
          </div>
        )}

        {properties !== null && properties.length > 0 && (
          <>
            {/* Property Selector */}
            <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'20px', marginBottom:'16px' }}>
              <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Select Property</label>
              <select
                value={selectedId ?? ''}
                onChange={e => setSelectedId(parseInt(e.target.value))}
                style={{ display:'block', width:'100%', marginTop:'8px', padding:'10px 12px', fontSize:'13px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', outline:'none' }}
              >
                {/* For super-admin viewing multiple companies, label each option
                    with its company so the selector is navigable at 10+ entries. */}
                {properties.map(p => (
                  <option key={p.id} value={p.id}>
                    {auth.status === 'ready' && auth.role === 'admin' ? `${p.company} · ${p.name}` : p.name}
                  </option>
                ))}
              </select>
            </div>

            {/* QR Sign Preview */}
            {selected && (
              <>
                <div style={{ background:'white', borderRadius:'12px', padding:'32px', textAlign:'center', marginBottom:'16px' }}>

                  <div style={{ background:'#0f1117', borderRadius:'8px', padding:'12px', marginBottom:'20px' }}>
                    <p style={{ color:'#C9A227', fontSize:'11px', fontWeight:'bold', textTransform:'uppercase', letterSpacing:'0.1em', margin:'0' }}>
                      {branding?.display_name || selected.company}
                    </p>
                    {branding?.support_website && (
                      <p style={{ color:'white', fontSize:'10px', margin:'2px 0 0' }}>{branding.support_website}</p>
                    )}
                  </div>

                  <p style={{ color:'#111', fontSize:'20px', fontWeight:'bold', margin:'0 0 4px' }}>Visitor Parking</p>
                  <p style={{ color:'#333', fontSize:'14px', margin:'0 0 20px' }}>Scan to get your parking pass</p>

                  <div style={{ display:'flex', justifyContent:'center', marginBottom:'20px' }}>
                    <QRCode
                      value={visitorUrl}
                      size={180}
                      level="H"
                      includeMargin={true}
                    />
                  </div>

                  <p style={{ color:'#333', fontSize:'12px', margin:'0 0 4px', fontWeight:'bold' }}>{selected.name}</p>
                  {addressLine && (
                    <p style={{ color:'#555', fontSize:'11px', margin:'0 0 16px' }}>{addressLine}</p>
                  )}
                  {!addressLine && <div style={{ marginBottom:'16px' }} />}

                  <div style={{ background:'#fff3cd', border:'1px solid #ffc107', borderRadius:'6px', padding:'10px', marginBottom:'16px' }}>
                    <p style={{ color:'#856404', fontSize:'12px', fontWeight:'bold', margin:'0 0 2px' }}>Required before parking</p>
                    <p style={{ color:'#856404', fontSize:'11px', margin:'0' }}>Valid up to 24 hours · No app download needed</p>
                  </div>

                  <div style={{ background:'#f8d7da', border:'1px solid #f5c6cb', borderRadius:'6px', padding:'10px' }}>
                    <p style={{ color:'#721c24', fontSize:'12px', fontWeight:'bold', margin:'0 0 2px' }}>⚠ Unregistered vehicles will be towed</p>
                    <p style={{ color:'#721c24', fontSize:'11px', margin:'0' }}>without notice at owner&apos;s expense</p>
                  </div>

                  {(branding?.support_phone || branding?.support_website) && (
                    <p style={{ color:'#888', fontSize:'10px', margin:'16px 0 0' }}>
                      Questions? {branding?.support_phone && <>Call {branding.support_phone}</>}
                      {branding?.support_phone && branding?.support_website && ' · '}
                      {branding?.support_website && branding.support_website}
                    </p>
                  )}
                </div>

                {/* Buttons */}
                <button
                  onClick={() => window.print()}
                  style={{ width:'100%', padding:'14px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'8px', cursor:'pointer', marginBottom:'10px' }}
                >
                  🖨 Print This Sign
                </button>

                <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'14px' }}>
                  <p style={{ color:'#aaa', fontSize:'11px', margin:'0 0 6px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Direct link for this property</p>
                  <p style={{ color:'#C9A227', fontSize:'11px', wordBreak:'break-all', margin:'0', fontFamily:'Courier New' }}>{visitorUrl}</p>
                </div>
              </>
            )}
          </>
        )}

      </div>
    </main>
  )
}

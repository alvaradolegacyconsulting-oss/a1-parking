'use client'
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

export default function Terms() {
  const [logoUrl, setLogoUrl] = useState<string>('/logo.jpeg')
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await supabase.from('platform_settings').select('default_logo_url').eq('id', 1).single()
      if (!cancelled && data?.default_logo_url) setLogoUrl(data.default_logo_url)
    })()
    return () => { cancelled = true }
  }, [])
  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'40px 20px' }}>
      <div style={{ maxWidth:'680px', margin:'0 auto' }}>

        <div style={{ textAlign:'center', marginBottom:'40px' }}>
          <img src={logoUrl} alt="ShieldMyLot"
            style={{ width:'64px', height:'64px', borderRadius:'10px', border:'2px solid #C9A227', display:'block', margin:'0 auto 16px' }} />
          <h1 style={{ color:'#C9A227', fontSize:'28px', fontWeight:'bold', margin:'0 0 8px' }}>ShieldMyLot™ — Terms of Service</h1>
          <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>Draft — Pending Legal Review · Last updated: 2026</p>
        </div>

        <div style={{ background:'#1a1f2e', border:'1px solid #C9A227', borderRadius:'8px', padding:'16px', marginBottom:'24px' }}>
          <p style={{ color:'#C9A227', fontSize:'14px', fontWeight:'bold', margin:'0 0 8px' }}>📍 Geographic Restriction — Texas Only</p>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0 0 10px' }}>
            ShieldMyLot is currently licensed and operated for use in the State of Texas only. Use of the platform outside Texas is not authorized and may not comply with applicable local, state, or federal laws governing parking enforcement in other jurisdictions.
          </p>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0 0 10px' }}>
            By using ShieldMyLot you confirm your business operations are based in Texas and subject to Texas law.
          </p>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0' }}>
            ShieldMyLot makes no representation that its platform, terms, or operations comply with the laws of any state other than Texas.
          </p>
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'8px', padding:'16px', marginBottom:'16px' }}>
          <p style={{ color:'#C9A227', fontSize:'14px', fontWeight:'bold', margin:'0 0 8px' }}>🏢 Enterprise & Institutional Use</p>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0 0 10px' }}>
            ShieldMyLot is designed for commercial towing companies and residential or commercial property management firms. Use by hospitals, universities, municipalities, government entities, or other institutional operators with high-volume enforcement needs requires a separate Enterprise Agreement.
          </p>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0 0 10px' }}>
            Institutional users who have registered under a standard subscription plan will be contacted to discuss appropriate Enterprise pricing and terms.
          </p>
          <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0' }}>
            To inquire about Enterprise agreements contact:{' '}
            <a href="mailto:support@shieldmylot.com" style={{ color:'#C9A227', textDecoration:'none' }}>support@shieldmylot.com</a>
          </p>
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'32px' }}>
          {[
            { title:'1. Platform Use', body:'ShieldMyLot is a parking management platform provided by Alvarado Legacy Consulting LLC for authorized users only. Use of this platform constitutes acceptance of these terms. Unauthorized access or use is strictly prohibited.' },
            { title:'2. User Responsibilities', body:'Users are responsible for the accuracy of all data entered into this platform. Vehicle registrations, violation reports, and visitor passes submitted by users may be relied upon by towing operators and property managers. Towing decisions are made exclusively by licensed operators, not by this platform.' },
            { title:'3. Data Collection', body:'We collect email, vehicle, and activity data necessary to provide the service. All data is stored securely and used solely for parking management purposes. Please review our Privacy Policy for full details on data handling.' },
            { title:'4. Limitation of Liability', body:'Alvarado Legacy Consulting LLC is not liable for towing decisions, wrongful tow claims, or errors resulting from inaccurate data entry by platform users. The platform is provided as a management aid only. Users and subscriber companies assume full responsibility for the accuracy of submitted data and for compliance with applicable towing law.' },
            { title:'5. Governing Law', body:'These terms are governed by the laws of the State of Texas. Any disputes arising from the use of this platform shall be resolved in a court of competent jurisdiction in Texas.' },
            { title:'6. Contact', body:'Questions about these Terms of Service? Contact ShieldMyLot support at support@shieldmylot.com.' },
          ].map((s, i, arr) => (
            <div key={i} style={{ marginBottom: i < arr.length - 1 ? '28px' : '0' }}>
              <h2 style={{ color:'#C9A227', fontSize:'15px', fontWeight:'bold', margin:'0 0 8px' }}>{s.title}</h2>
              <p style={{ color:'#aaa', fontSize:'13px', lineHeight:'1.8', margin:'0' }}>{s.body}</p>
            </div>
          ))}
        </div>

        <p style={{ color:'#333', fontSize:'11px', textAlign:'center', marginTop:'24px' }}>ShieldMyLot · A product of Alvarado Legacy Consulting LLC</p>
      </div>
    </main>
  )
}

'use client'
import { useResolvedLogo } from '../lib/logo'
import { SAAS_DISPLAY_DATE } from '../lib/legal-versions'
import SaasAgreementBody from '../components/SaasAgreementBody'

// B118 Layer 2 Commit 3 — /saas static route.
//
// Renders the SaaS Subscription Agreement placeholder text for public
// viewing (mirrors /terms + /privacy structure). Same body component
// the <LegalReadthroughGate> uses so text stays in one place — a
// version bump swap becomes a one-liner (edit SaasAgreementBody +
// bump SAAS_VERSION in legal-versions.ts).

export default function Saas() {
  const logoUrl = useResolvedLogo()
  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'40px 20px' }}>
      <div style={{ maxWidth:'720px', margin:'0 auto' }}>

        <div style={{ textAlign:'center', marginBottom:'32px' }}>
          <img src={logoUrl} alt="ShieldMyLot"
            style={{ width:'64px', height:'64px', borderRadius:'10px', border:'2px solid #C9A227', display:'block', margin:'0 auto 16px' }} />
          <h1 style={{ color:'#C9A227', fontSize:'26px', fontWeight:'bold', margin:'0 0 8px' }}>ShieldMyLot™ — SaaS Subscription Agreement</h1>
          <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>Last updated: {SAAS_DISPLAY_DATE}</p>
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'24px' }}>
          <SaasAgreementBody />
        </div>

      </div>
    </main>
  )
}

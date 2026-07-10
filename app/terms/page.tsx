'use client'
import { useResolvedLogo } from '../lib/logo'
import { TOS_DISPLAY_DATE } from '../lib/legal-versions'
import TermsBody from '../components/TermsBody'

// Thin wrapper — attorney finals body extracted to
// app/components/TermsBody.tsx so the same source of truth renders both
// at /terms and inside the <LegalReadthroughGate> scroll pane.
// Behavior-neutral: this page still renders exactly the same visual
// output as before the extraction.

export default function Terms() {
  const logoUrl = useResolvedLogo()
  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'40px 20px' }}>
      <div style={{ maxWidth:'720px', margin:'0 auto' }}>

        <div style={{ textAlign:'center', marginBottom:'40px' }}>
          <img src={logoUrl} alt="ShieldMyLot"
            style={{ width:'64px', height:'64px', borderRadius:'10px', border:'2px solid #C9A227', display:'block', margin:'0 auto 16px' }} />
          <h1 style={{ color:'#C9A227', fontSize:'28px', fontWeight:'bold', margin:'0 0 8px' }}>ShieldMyLot Terms of Use</h1>
          <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>Last Updated: {TOS_DISPLAY_DATE}</p>
        </div>

        <TermsBody />

        <p style={{ color:'#333', fontSize:'11px', textAlign:'center', marginTop:'24px' }}>Alvarado Legacy Consulting LLC d/b/a ShieldMyLot</p>
      </div>
    </main>
  )
}

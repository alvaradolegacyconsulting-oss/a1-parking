'use client'

export default function Privacy() {
  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'40px 20px' }}>
      <div style={{ maxWidth:'680px', margin:'0 auto' }}>

        <div style={{ textAlign:'center', marginBottom:'40px' }}>
          <img src="/logo.jpeg" alt="ShieldMyLot"
            style={{ width:'64px', height:'64px', borderRadius:'10px', border:'2px solid #C9A227', display:'block', margin:'0 auto 16px' }} />
          <h1 style={{ color:'#C9A227', fontSize:'28px', fontWeight:'bold', margin:'0 0 8px' }}>ShieldMyLot™ — Privacy Policy</h1>
          <p style={{ color:'#555', fontSize:'12px', margin:'0' }}>Draft — Pending Legal Review · Last updated: 2026</p>
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'32px' }}>
          {[
            { title:'1. Data We Collect', body:'We collect the following information: email addresses, full names, phone numbers, license plate numbers, vehicle information (make, model, year, color, state), violation photos, and audit logs of user activity within the platform.' },
            { title:'2. How We Use It', body:'All collected data is used exclusively to provide parking management services to authorized property managers, residents, and visitors. We do not sell or share your data with third parties for marketing purposes.' },
            { title:'3. Who Can See It', body:'Data is accessible only to authorized users according to their assigned role. Administrators and company administrators see data relevant to their properties. Residents see only their own records. Visitors see only their own pass status.' },
            { title:'4. Data Retention', body:'Records are retained for a minimum of two years in accordance with standard property management practices. Violation records and tow logs may be retained longer as required by applicable Texas law.' },
            { title:'5. Your Rights', body:'You have the right to request access to, correction of, or deletion of your personal data. To submit a data request, contact us at the information below. We will respond within 30 days.' },
            { title:'6. Contact', body:'Alvarado Legacy Consulting LLC · ShieldMyLot · support@shieldmylot.com' },
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

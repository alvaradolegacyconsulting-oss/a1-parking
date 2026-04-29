'use client'
import { useState } from 'react'
import { QRCodeCanvas as QRCode } from 'qrcode.react'

const PROPERTIES = [
  { name: 'Miramar', address: '13150 Bissonnet St, Houston, TX 77099' },
  { name: 'Villa Barcelona Apartments', address: '7222 Bellerive Dr, Houston, TX 77036' },
  { name: 'Alden Park Kingsland', address: '18021 Kingsland Blvd, Houston, TX' },
  { name: 'Charleston at Fannin Station Apartments', address: '9779 Fannin Rail Wy, Houston, TX' },
  { name: 'Crossing at Cherry', address: '1100 S Cherry St, Tomball, TX' },
  { name: 'Green Acres', address: '13501 Hopper Rd, Houston, TX' },
  { name: 'Nantucket at Fannin Station', address: '10000 Fannin St, Houston, TX' },
  { name: 'Oak Bend Place', address: '915 Baker Dr, Tomball, TX' },
  { name: 'SouthFork Lake', address: '3333 Southfork Pkwy, Manvel, TX' },
  { name: 'Sugarberry Place', address: '9850 Boudreaux Rd, Tomball, TX' },
  { name: 'Summerset Landing Condominiums', address: '6161 Reims Rd, Houston, TX' },
]

export default function QRPage() {
  const [selected, setSelected] = useState(PROPERTIES[0])
  const [printed, setPrinted] = useState(false)

  const visitorUrl = `https://a1-parking.vercel.app/visitor?property=${encodeURIComponent(selected.name)}`

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'500px', margin:'0 auto' }}>

        <div style={{ marginBottom:'24px', textAlign:'center' }}>
          <h1 style={{ color:'#C9A227', fontSize:'24px', fontWeight:'bold', margin:'0' }}>A1 Wrecker, LLC</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'6px 0 0' }}>QR Code Generator · Visitor Pass Signs</p>
        </div>

        <a href="/" style={{ display:'inline-block', marginBottom:'20px', color:'#C9A227', fontSize:'13px', textDecoration:'none' }}>
          ← Back to Plate Lookup
        </a>

        {/* Property Selector */}
        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'20px', marginBottom:'16px' }}>
          <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Select Property</label>
          <select
            onChange={e => setSelected(PROPERTIES[parseInt(e.target.value)])}
            style={{ display:'block', width:'100%', marginTop:'8px', padding:'10px 12px', fontSize:'13px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', outline:'none' }}
          >
            {PROPERTIES.map((p, i) => (
              <option key={i} value={i}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* QR Sign Preview */}
        <div style={{ background:'white', borderRadius:'12px', padding:'32px', textAlign:'center', marginBottom:'16px' }}>
          
          <div style={{ background:'#0f1117', borderRadius:'8px', padding:'12px', marginBottom:'20px' }}>
            <p style={{ color:'#C9A227', fontSize:'11px', fontWeight:'bold', textTransform:'uppercase', letterSpacing:'0.1em', margin:'0' }}>A1 WRECKER, LLC</p>
            <p style={{ color:'white', fontSize:'10px', margin:'2px 0 0' }}>Houston's #1 Towing & Recovery</p>
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
          <p style={{ color:'#555', fontSize:'11px', margin:'0 0 16px' }}>{selected.address}</p>

          <div style={{ background:'#fff3cd', border:'1px solid #ffc107', borderRadius:'6px', padding:'10px', marginBottom:'16px' }}>
            <p style={{ color:'#856404', fontSize:'12px', fontWeight:'bold', margin:'0 0 2px' }}>Required before parking</p>
            <p style={{ color:'#856404', fontSize:'11px', margin:'0' }}>Valid up to 24 hours · No app download needed</p>
          </div>

          <div style={{ background:'#f8d7da', border:'1px solid #f5c6cb', borderRadius:'6px', padding:'10px' }}>
            <p style={{ color:'#721c24', fontSize:'12px', fontWeight:'bold', margin:'0 0 2px' }}>⚠ Unregistered vehicles will be towed</p>
            <p style={{ color:'#721c24', fontSize:'11px', margin:'0' }}>without notice at owner's expense</p>
          </div>

          <p style={{ color:'#888', fontSize:'10px', margin:'16px 0 0' }}>
            Questions? Call A1 Wrecker · a1wreckerllc.net
          </p>
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

      </div>
    </main>
  )
}
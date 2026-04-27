'use client'
import { useState } from 'react'
import { supabase } from './supabase'

export default function Home() {
  const [plate, setPlate] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)

  async function searchPlate() {
    setLoading(true)
    setResult(null)
   const clean = plate.toUpperCase().trim()
   const { data, error } = await supabase
      .from('vehicles')
      .select('*')
      .ilike('plate', clean)
      .single()

    setLoading(false)
    if (error || !data) {
      setResult({ status: 'notfound' })
    } else if (!data.is_active) {
      setResult({ status: 'expired', data })
    } else {
      setResult({ status: 'authorized', data })
    }
  }

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      
      <div style={{ marginBottom:'32px', textAlign:'center' }}>
        <h1 style={{ color:'#C9A227', fontSize:'28px', fontWeight:'bold', margin:'0' }}>A1 Wrecker, LLC</h1>
        <p style={{ color:'#888', fontSize:'13px', margin:'6px 0 0' }}>Houston's #1 Towing & Recovery · Plate Lookup</p>
      </div>

      <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'32px', width:'100%', maxWidth:'420px' }}>
        <label style={{ color:'#aaa', fontSize:'12px', textTransform:'uppercase', letterSpacing:'0.1em' }}>License Plate</label>
        <input
          value={plate}
          onChange={e => setPlate(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && searchPlate()}
          placeholder="ABC1234"
          style={{ display:'block', width:'100%', marginTop:'8px', padding:'14px', fontSize:'22px', fontFamily:'Courier New', fontWeight:'bold', letterSpacing:'0.1em', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', textAlign:'center', outline:'none', boxSizing:'border-box' }}
        />
        <button
          onClick={searchPlate}
          disabled={loading || !plate}
          style={{ marginTop:'12px', width:'100%', padding:'14px', background:'#C9A227', color:'#0f1117', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'8px', cursor:'pointer' }}
        >
          {loading ? 'Searching...' : 'Search Plate'}
        </button>

        {result && (
          <div style={{ marginTop:'20px', padding:'16px', borderRadius:'8px',
            background: result.status === 'authorized' ? '#1a3a1a' : result.status === 'expired' ? '#3a2a00' : '#3a1a1a',
            border: `1px solid ${result.status === 'authorized' ? '#2e7d32' : result.status === 'expired' ? '#e65100' : '#b71c1c'}`
          }}>
            {result.status === 'authorized' && (
              <>
                <p style={{ color:'#4caf50', fontWeight:'bold', fontSize:'16px', margin:'0 0 10px' }}>✓ AUTHORIZED</p>
                <p style={{ color:'#aaa', fontSize:'13px', margin:'4px 0' }}>Unit: <span style={{color:'white'}}>{result.data.unit}</span></p>
                <p style={{ color:'#aaa', fontSize:'13px', margin:'4px 0' }}>Vehicle: <span style={{color:'white'}}>{result.data.color} {result.data.make} {result.data.model} {result.data.year}</span></p>
                <p style={{ color:'#aaa', fontSize:'13px', margin:'4px 0' }}>Space: <span style={{color:'white'}}>{result.data.space}</span></p>
                <p style={{ color:'#aaa', fontSize:'13px', margin:'4px 0' }}>Property: <span style={{color:'white'}}>{result.data.property}</span></p>
              </>
            )}
            {result.status === 'expired' && (
              <>
                <p style={{ color:'#ff9800', fontWeight:'bold', fontSize:'16px', margin:'0 0 10px' }}>⚠ PERMIT EXPIRED</p>
                <p style={{ color:'#aaa', fontSize:'13px', margin:'4px 0' }}>Unit: <span style={{color:'white'}}>{result.data.unit}</span></p>
                <p style={{ color:'#aaa', fontSize:'13px', margin:'4px 0' }}>Vehicle: <span style={{color:'white'}}>{result.data.color} {result.data.make} {result.data.model}</span></p>
              </>
            )}
            {result.status === 'notfound' && (
              <>
                <p style={{ color:'#f44336', fontWeight:'bold', fontSize:'16px', margin:'0 0 6px' }}>✗ NOT FOUND</p>
                <p style={{ color:'#aaa', fontSize:'13px', margin:'0' }}>This plate is not registered. May be subject to towing.</p>
              </>
            )}
          </div>
        )}
      </div>

      <p style={{ color:'#444', fontSize:'11px', marginTop:'24px' }}>A1 Wrecker, LLC · a1wreckerllc.net</p>
    </main>
  )
}
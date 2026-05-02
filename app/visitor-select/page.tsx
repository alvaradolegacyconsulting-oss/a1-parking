'use client'
import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '../supabase'

function VisitorSelectForm() {
  const searchParams = useSearchParams()
  const company = searchParams.get('company') || ''
  const [properties, setProperties] = useState<any[]>([])
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      let query = supabase.from('properties').select('name').eq('is_active', true).order('name')
      if (company) query = query.ilike('company', company)
      const { data } = await query
      setProperties(data || [])
      if (data && data.length > 0) setSelected(data[0].name)
      setLoading(false)
    }
    load()
  }, [company])

  if (loading) return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif' }}>
      <p style={{ color:'#888' }}>Loading...</p>
    </main>
  )

  if (properties.length === 0) return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ textAlign:'center' }}>
        <p style={{ color:'#f44336', fontSize:'14px', marginBottom:'12px' }}>No properties found. Please contact the property manager for a direct visitor pass link.</p>
        <a href="/visitor" style={{ color:'#C9A227', fontSize:'13px' }}>← Go to Visitor Pass</a>
      </div>
    </main>
  )

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      <div style={{ maxWidth:'420px', width:'100%' }}>

        <div style={{ marginBottom:'24px', textAlign:'center' }}>
          <img src="/logo.jpeg" alt="A1 Wrecker"
            style={{ width:'70px', height:'70px', borderRadius:'10px', border:'2px solid #C9A227', display:'block', margin:'0 auto 12px' }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
          <h1 style={{ color:'#C9A227', fontSize:'24px', fontWeight:'bold', margin:'0' }}>A1 Wrecker, LLC</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'6px 0 0' }}>Visitor Parking Pass{company ? ` · ${company}` : ''}</p>
          <p style={{ color:'#555', fontSize:'11px', margin:'4px 0 0' }}>No app download required</p>
        </div>

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'12px', padding:'24px' }}>
          <p style={{ color:'white', fontWeight:'bold', fontSize:'15px', margin:'0 0 6px' }}>Which property are you visiting?</p>
          <p style={{ color:'#888', fontSize:'12px', margin:'0 0 20px', lineHeight:'1.6' }}>
            Select the property you are visiting to get your visitor parking pass.
          </p>

          <label style={{ color:'#aaa', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.08em' }}>Select Property</label>
          <select
            value={selected}
            onChange={e => setSelected(e.target.value)}
            style={{ display:'block', width:'100%', marginTop:'8px', marginBottom:'20px', padding:'12px', fontSize:'14px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', outline:'none' }}
          >
            {properties.map((p, i) => (
              <option key={i} value={p.name}>{p.name}</option>
            ))}
          </select>

          <button
            onClick={() => { if (selected) window.location.href = `/visitor?property=${encodeURIComponent(selected)}` }}
            disabled={!selected}
            style={{ width:'100%', padding:'14px', background: selected ? '#C9A227' : '#555', color: selected ? '#0f1117' : '#888', fontWeight:'bold', fontSize:'15px', border:'none', borderRadius:'8px', cursor: selected ? 'pointer' : 'not-allowed' }}
          >
            Continue →
          </button>
        </div>

        <p style={{ color:'#333', fontSize:'11px', textAlign:'center', marginTop:'16px' }}>
          A1 Wrecker, LLC · Houston's #1 Towing & Recovery · a1wreckerllc.net
        </p>
      </div>
    </main>
  )
}

export default function VisitorSelect() {
  return (
    <Suspense fallback={
      <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif' }}>
        <p style={{ color:'#888' }}>Loading...</p>
      </main>
    }>
      <VisitorSelectForm />
    </Suspense>
  )
}

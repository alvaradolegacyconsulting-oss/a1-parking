'use client'
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

export default function History() {
  const [violations, setViolations] = useState<any[]>([])
  const [filter, setFilter] = useState('today')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchViolations()
  }, [filter])

  async function fetchViolations() {
    setLoading(true)
    const now = new Date()
    let startDate = new Date()

    if (filter === 'today') {
      startDate.setHours(0, 0, 0, 0)
    } else if (filter === 'week') {
      startDate.setDate(now.getDate() - 7)
    } else if (filter === 'sixmonths') {
      startDate.setMonth(now.getMonth() - 6)
    }

    const { data, error } = await supabase
      .from('violations')
      .select('*')
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false })

    setLoading(false)
    if (!error) setViolations(data || [])
  }

  function formatDate(dateStr: string) {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-US', { 
      month: 'short', day: 'numeric', 
      hour: '2-digit', minute: '2-digit' 
    })
  }

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', fontFamily:'Arial, sans-serif', padding:'20px' }}>
      
      <div style={{ maxWidth:'600px', margin:'0 auto' }}>
        
        <div style={{ marginBottom:'24px', textAlign:'center' }}>
          <h1 style={{ color:'#C9A227', fontSize:'24px', fontWeight:'bold', margin:'0' }}>A1 Wrecker, LLC</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'6px 0 0' }}>Violation History</p>
        </div>

        <a href="/" style={{ display:'inline-block', marginBottom:'20px', color:'#C9A227', fontSize:'13px', textDecoration:'none' }}>
          ← Back to Plate Lookup
        </a>

        {/* Filter Tabs */}
        <div style={{ display:'flex', gap:'8px', marginBottom:'20px' }}>
          {[
            { key:'today', label:'Today' },
            { key:'week', label:'Past Week' },
            { key:'sixmonths', label:'Past 6 Months' }
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{ 
                flex:1, padding:'10px', border:'none', borderRadius:'8px', 
                cursor:'pointer', fontWeight:'bold', fontSize:'13px',
                background: filter === f.key ? '#C9A227' : '#161b26',
                color: filter === f.key ? '#0f1117' : '#888',
                border: filter === f.key ? 'none' : '1px solid #2a2f3d'
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Stats Bar */}
        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'16px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <p style={{ color:'#aaa', fontSize:'11px', margin:'0', textTransform:'uppercase', letterSpacing:'0.08em' }}>Total Violations</p>
            <p style={{ color:'#C9A227', fontSize:'32px', fontWeight:'bold', margin:'4px 0 0' }}>{violations.length}</p>
          </div>
          <div style={{ textAlign:'right' }}>
            <p style={{ color:'#aaa', fontSize:'11px', margin:'0', textTransform:'uppercase', letterSpacing:'0.08em' }}>Period</p>
            <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'4px 0 0' }}>
              {filter === 'today' ? 'Today' : filter === 'week' ? 'Last 7 Days' : 'Last 6 Months'}
            </p>
          </div>
        </div>

        {/* Violation List */}
        {loading && (
          <p style={{ color:'#888', textAlign:'center', padding:'40px' }}>Loading...</p>
        )}

        {!loading && violations.length === 0 && (
          <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}>
            <p style={{ color:'#888', fontSize:'14px', margin:'0' }}>No violations found for this period</p>
          </div>
        )}

        {!loading && violations.map((v, i) => (
          <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'10px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'10px' }}>
              <p style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
              <p style={{ color:'#555', fontSize:'11px', margin:'0' }}>{formatDate(v.created_at)}</p>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
              <div>
                <p style={{ color:'#555', fontSize:'11px', margin:'0', textTransform:'uppercase', letterSpacing:'0.06em' }}>Violation</p>
                <p style={{ color:'#aaa', fontSize:'13px', margin:'4px 0 0' }}>{v.violation_type || '—'}</p>
              </div>
              <div>
                <p style={{ color:'#555', fontSize:'11px', margin:'0', textTransform:'uppercase', letterSpacing:'0.06em' }}>Property</p>
                <p style={{ color:'#aaa', fontSize:'13px', margin:'4px 0 0' }}>{v.property || '—'}</p>
              </div>
              <div>
                <p style={{ color:'#555', fontSize:'11px', margin:'0', textTransform:'uppercase', letterSpacing:'0.06em' }}>Location</p>
                <p style={{ color:'#aaa', fontSize:'13px', margin:'4px 0 0' }}>{v.location || '—'}</p>
              </div>
              {v.notes && (
                <div>
                  <p style={{ color:'#555', fontSize:'11px', margin:'0', textTransform:'uppercase', letterSpacing:'0.06em' }}>Notes</p>
                  <p style={{ color:'#aaa', fontSize:'13px', margin:'4px 0 0' }}>{v.notes}</p>
                </div>
              )}
            </div>
          </div>
        ))}

      </div>
    </main>
  )
}
'use client'
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

export default function History() {
  const [violations, setViolations] = useState<any[]>([])
  const [filter, setFilter] = useState('today')
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [exportMsg, setExportMsg] = useState('')

  function filteredViolations() {
    if (!search) return violations
    const q = search.toLowerCase()
    return violations.filter(v =>
      v.plate?.toLowerCase().includes(q) ||
      v.property?.toLowerCase().includes(q) ||
      v.violation_type?.toLowerCase().includes(q) ||
      v.location?.toLowerCase().includes(q)
    )
  }

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
      .select('*, photo_rows:violation_photos(id, photo_url, removed_at), video_rows:violation_videos(id, video_url, removed_at)')
      .eq('is_confirmed', true)
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false })

    setLoading(false)
    if (error) return
    // B13/B18 Commit A: flatten photo_rows → v.photos filtered active.
    // C1: same flatten for video_rows → v.video_url filtered active.
    const flattened = (data || []).map(v => {
      const activeVideos = ((v.video_rows as { id: number; video_url: string; removed_at: string | null }[] | null) || [])
        .filter(vid => !vid.removed_at)
      return {
        ...v,
        photos: ((v.photo_rows as { id: number; photo_url: string; removed_at: string | null }[] | null) || [])
          .filter(p => !p.removed_at)
          .map(p => p.photo_url),
        video_url: activeVideos[0]?.video_url ?? null,
      }
    })
    setViolations(flattened)
  }

  function escapeCsv(val: any): string {
    const s = (val == null ? '' : String(val)).replace(/"/g, '""')
    return `"${s}"`
  }

  function exportTowbook() {
    const towRecords = filteredViolations().filter(v => v.tow_ticket_generated)
    if (towRecords.length === 0) {
      setExportMsg('No tow ticket records found in current filter. Apply a date filter and try again.')
      return
    }
    setExportMsg(`Exporting ${towRecords.length} tow record${towRecords.length !== 1 ? 's' : ''}...`)
    setTimeout(() => setExportMsg(''), 4000)
    const headers = ['Date','Time','Plate','State','Color','Make','Model','Violation Type','Location','Property','Storage Facility','Storage Address','Storage Phone','Tow Fee','Driver Name','Driver License','Notes']
    const rows = towRecords.map(v => {
      const d = new Date(v.created_at)
      const date = d.toLocaleDateString('en-US', { month:'2-digit', day:'2-digit', year:'numeric' })
      const time = d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12: true })
      return [
        date, time, v.plate, v.state || '', v.vehicle_color || '', v.vehicle_make || '', v.vehicle_model || '',
        v.violation_type || '', v.location || '', v.property || '',
        v.tow_storage_name || '', v.tow_storage_address || '', v.tow_storage_phone || '',
        v.tow_fee || '', v.driver_name || '', v.driver_license || '', v.notes || '',
      ].map(escapeCsv).join(',')
    })
    const csv = [headers.map(escapeCsv).join(','), ...rows].join('\n')
    const today = new Date().toISOString().slice(0, 10)
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `towbook_export_${today}.csv`
    a.click()
    URL.revokeObjectURL(url)
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
          <h1 style={{ color:'#C9A227', fontSize:'24px', fontWeight:'bold', margin:'0' }}>ShieldMyLot</h1>
          <p style={{ color:'#888', fontSize:'13px', margin:'6px 0 0' }}>Violation History</p>
        </div>

        <a href="/" style={{ display:'inline-block', marginBottom:'20px', color:'#C9A227', fontSize:'13px', textDecoration:'none' }}>
          ← Back to Plate Lookup
        </a>

        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search plate, property, violation type, location..."
          style={{ display:'block', width:'100%', padding:'10px 12px', marginBottom:'10px', background:'#1e2535', border:'1px solid #3a4055', borderRadius:'8px', color:'white', fontSize:'13px', boxSizing:'border-box', outline:'none' }}
        />

        <div style={{ display:'flex', gap:'4px', background:'#1e2535', borderRadius:'8px', padding:'3px', marginBottom:'10px' }}>
          {[
            { key:'today', label:'Today' },
            { key:'week', label:'Past Week' },
            { key:'sixmonths', label:'Past 6 Months' }
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                flex:1, padding:'10px', borderRadius:'6px',
                cursor:'pointer', fontWeight:'bold', fontSize:'13px',
                background: filter === f.key ? '#C9A227' : 'transparent',
                color: filter === f.key ? '#0f1117' : '#888',
                border: filter === f.key ? 'none' : '1px solid transparent',
                outline: 'none',
                fontFamily:'Arial'
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:'16px' }}>
          <button onClick={exportTowbook} style={{ background:'#1a1f2e', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'8px', padding:'8px 14px', fontSize:'12px', cursor:'pointer', fontFamily:'Arial' }}>
            ↓ Export for Towbook
          </button>
        </div>
        {exportMsg && (
          <p style={{ color: exportMsg.startsWith('No') ? '#f44336' : '#C9A227', fontSize:'12px', textAlign:'right', margin:'-10px 0 12px' }}>{exportMsg}</p>
        )}

        <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'16px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <p style={{ color:'#aaa', fontSize:'11px', margin:'0', textTransform:'uppercase', letterSpacing:'0.08em' }}>Total Violations</p>
            <p style={{ color:'#C9A227', fontSize:'32px', fontWeight:'bold', margin:'4px 0 0' }}>{filteredViolations().length}</p>
          </div>
          <div style={{ textAlign:'right' }}>
            <p style={{ color:'#aaa', fontSize:'11px', margin:'0', textTransform:'uppercase', letterSpacing:'0.08em' }}>Period</p>
            <p style={{ color:'white', fontSize:'14px', fontWeight:'bold', margin:'4px 0 0' }}>
              {filter === 'today' ? 'Today' : filter === 'week' ? 'Last 7 Days' : 'Last 6 Months'}
            </p>
          </div>
        </div>

        {loading && (
          <p style={{ color:'#888', textAlign:'center', padding:'40px' }}>Loading...</p>
        )}

        {!loading && filteredViolations().length === 0 && (
          <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'40px', textAlign:'center' }}>
            <p style={{ color:'#888', fontSize:'14px', margin:'0' }}>No violations found for this period</p>
          </div>
        )}

        {!loading && filteredViolations().map((v, i) => (
          <div key={i} style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'16px', marginBottom:'10px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'10px' }}>
              <p style={{ color:'#f44336', fontFamily:'Courier New', fontSize:'20px', fontWeight:'bold', margin:'0' }}>{v.plate}</p>
              <div style={{ textAlign:'right' }}>
                <p style={{ color:'#555', fontSize:'11px', margin:'0' }}>{formatDate(v.created_at)}</p>
                {v.tow_ticket_generated && (
                  <span style={{ display:'inline-block', marginTop:'4px', background:'#1a1500', border:'1px solid #C9A227', color:'#C9A227', fontSize:'9px', fontWeight:'bold', padding:'2px 6px', borderRadius:'4px', letterSpacing:'0.05em' }}>🎫 TOW TICKET ISSUED</span>
                )}
              </div>
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
              {(v.vehicle_color || v.vehicle_make || v.vehicle_model) && (
                <div style={{ gridColumn:'span 2' }}>
                  <p style={{ color:'#555', fontSize:'11px', margin:'0' }}>🚗 {[v.vehicle_color, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')}</p>
                </div>
              )}
              {v.photos && v.photos.length > 0 && (
                <div style={{ gridColumn:'span 2', marginTop:'8px' }}>
                  <p style={{ color:'#555', fontSize:'11px', margin:'0 0 6px', textTransform:'uppercase', letterSpacing:'0.06em' }}>Photos ({v.photos.length})</p>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'6px' }}>
                    {v.photos.map((url: string, pi: number) => (
                      <a key={pi} href={url} target="_blank" rel="noopener noreferrer">
                        <img
                          src={url}
                          alt={`Violation photo ${pi+1}`}
                          style={{ width:'100%', aspectRatio:'4/3', objectFit:'cover', borderRadius:'6px', border:'1px solid #2a2f3d', cursor:'pointer' }}
                        />
                      </a>
                    ))}
                  </div>
                </div>
              )}
              {v.video_url && (
                <div style={{ gridColumn:'span 2', marginTop:'8px' }}>
                  <button onClick={() => window.open(v.video_url, '_blank')}
                    style={{ width:'100%', padding:'7px', background:'#0f1620', color:'#C9A227', border:'1px solid #C9A227', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
                    ▶ Play Video
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

      </div>
    </main>
  )
}
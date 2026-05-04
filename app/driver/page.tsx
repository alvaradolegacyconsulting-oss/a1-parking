'use client'
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../supabase'
import { logAudit } from '../lib/audit'

export default function DriverPortal() {
  const [driver, setDriver] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Plate lookup
  const [plate, setPlate] = useState('')
  const [result, setResult] = useState<any>(null)
  const [searching, setSearching] = useState(false)

  // Camera scan
  const [showCamera, setShowCamera] = useState(false)
  const [scanStatus, setScanStatus] = useState('Point camera at license plate')
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [showViolation, setShowViolation] = useState(false)
  const [violation, setViolation] = useState({ type: '', location: '', notes: '', property: '' })
  const [photos, setPhotos] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)

  // Tow ticket (shared)
  const [storageFacilities, setStorageFacilities] = useState<any[]>([])
  const [ticketTarget, setTicketTarget] = useState<any>(null)
  const [selectedStorage, setSelectedStorage] = useState('')
  const [towFee, setTowFee] = useState('')
  const [mileage, setMileage] = useState('')
  const [vin, setVin] = useState('')

  // Violations tab
  const [activeTab, setActiveTab] = useState<'lookup' | 'violations'>('lookup')
  const [violations, setViolations] = useState<any[]>([])
  const [violationFilter, setViolationFilter] = useState('today')
  const [searchQuery, setSearchQuery] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [expandedTicketId, setExpandedTicketId] = useState<string | null>(null)

  useEffect(() => { loadDriver() }, [])

  useEffect(() => {
    if (showCamera && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
      videoRef.current.play().catch(() => {})
    }
  }, [showCamera])

  async function loadDriver() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { window.location.href = '/login'; return }

    const { data: roleData } = await supabase
      .from('user_roles').select('*').ilike('email', user.email!).single()

    if (!roleData || (roleData.role !== 'driver' && roleData.role !== 'admin')) {
      setError('You do not have driver access.')
      setLoading(false)
      return
    }

    const { data: driverData } = await supabase
      .from('drivers').select('*').ilike('email', user.email!).single()

    const d = driverData ?? {
      name: user.email, email: user.email,
      assigned_properties: ['All'], operator_license: 'N/A', company: 'A1 Wrecker, LLC'
    }
    setDriver(d)
    setLoading(false)
    fetchViolations(d.assigned_properties || ['All'])
    fetchStorageFacilities()
  }

  async function fetchStorageFacilities() {
    const { data } = await supabase.from('storage_facilities').select('*').eq('is_active', true).order('name')
    setStorageFacilities(data || [])
  }

  async function fetchViolations(properties: string[]) {
    // Fetch 6 months so all filter presets have data
    const sixmo = new Date()
    sixmo.setMonth(sixmo.getMonth() - 6)
    let query = supabase.from('violations').select('*')
      .gte('created_at', sixmo.toISOString())
      .order('created_at', { ascending: false })
    if (!properties.includes('All')) {
      query = query.in('property', properties)
    }
    const { data } = await query
    setViolations(data || [])
  }

  async function openCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      streamRef.current = stream
      setScanStatus('Point camera at license plate')
      setScanning(false)
      setShowCamera(true)
    } catch (e: any) {
      const msg = e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
        ? 'Camera access denied. Please type the plate manually.'
        : 'Camera not available. Please type the plate manually.'
      alert(msg)
    }
  }

  function closeCamera() {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setShowCamera(false)
    setScanning(false)
    setScanStatus('Point camera at license plate')
  }

  async function captureAndScan() {
    if (!videoRef.current || scanning) return
    setScanning(true)
    setScanStatus('Reading plate...')
    const video = videoRef.current

    // Crop to center targeting region (60% wide, 40% tall) at 2x scale
    const srcX = Math.floor(video.videoWidth * 0.20)
    const srcY = Math.floor(video.videoHeight * 0.30)
    const srcW = Math.floor(video.videoWidth * 0.60)
    const srcH = Math.floor(video.videoHeight * 0.40)
    const canvas = document.createElement('canvas')
    canvas.width = srcW * 2
    canvas.height = srcH * 2
    const ctx = canvas.getContext('2d')
    if (!ctx) { setScanStatus('Could not read plate. Please type manually.'); setScanning(false); return }
    ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height)

    const base64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1]

    try {
      console.log('Calling scan-plate API...')
      const res = await fetch('/api/scan-plate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 }),
      })
      console.log('Response status:', res.status)
      const result = await res.json()
      console.log('Result:', result)
      const json = result
      if (!res.ok || json.error) {
        setScanStatus(json.error === 'Plate scanning not configured' ? 'Plate scanning not configured. Please type manually.' : 'Could not read plate. Please type manually.')
        setScanning(false)
        return
      }
      const cleaned = (json.plate || '').replace(/[^A-Z0-9]/g, '').toUpperCase().slice(0, 8)
      if (cleaned.length >= 4) {
        setPlate(cleaned)
        setScanMsg('📋 Plate scanned — please verify before searching.')
        closeCamera()
        setTimeout(() => searchPlate(cleaned), 50)
      } else {
        setScanStatus('Could not read plate clearly. Please try again or type manually.')
        setScanning(false)
      }
    } catch {
      setScanStatus('Could not read plate. Please type manually.')
      setScanning(false)
    }
  }

  async function searchPlate(plateVal?: string) {
    const val = plateVal ?? plate
    if (!val || searching) return
    setSearching(true)
    setScanMsg('')
    setResult(null)
    setShowViolation(false)
    setTicketTarget(null)
    const clean = val.toUpperCase().trim()

    const { data: activeVeh } = await supabase
      .from('vehicles').select('*').ilike('plate', clean).eq('is_active', true).single()
    if (activeVeh) {
      const props = driver?.assigned_properties || []
      if (!props.includes('All') && !props.includes(activeVeh.property)) {
        setSearching(false); setResult({ status: 'notassigned' }); return
      }
      setSearching(false); setResult({ status: 'authorized', data: activeVeh }); return
    }

    const { data: expiredVeh } = await supabase
      .from('vehicles').select('*').ilike('plate', clean).eq('is_active', false).single()
    if (expiredVeh) { setSearching(false); setResult({ status: 'expired', data: expiredVeh }); return }

    const { data: pass } = await supabase
      .from('visitor_passes').select('*')
      .ilike('plate', clean).eq('is_active', true).gte('expires_at', new Date().toISOString()).single()
    setSearching(false)
    if (pass) setResult({ status: 'visitor', data: pass })
    else setResult({ status: 'notfound' })
  }

  async function submitViolation() {
    if (!violation.type || !violation.property) { alert('Violation type and property are required'); return }
    setSubmitting(true)
    const photoUrls: string[] = []
    for (const photo of photos) {
      const fileName = `${Date.now()}-${photo.name}`
      const { error: upErr } = await supabase.storage.from('violation-photos').upload(fileName, photo)
      if (!upErr) {
        const { data: urlData } = supabase.storage.from('violation-photos').getPublicUrl(fileName)
        photoUrls.push(urlData.publicUrl)
      }
    }
    const { data: newV, error: insErr } = await supabase.from('violations').insert([{
      plate: plate.toUpperCase().trim(),
      violation_type: violation.type,
      location: violation.location,
      notes: violation.notes,
      property: violation.property,
      driver_name: driver?.name,
      driver_license: driver?.operator_license,
      photos: photoUrls,
    }]).select().single()
    setSubmitting(false)
    if (insErr) { alert('Error: ' + insErr.message); return }
    await logAudit({ action: 'ADD_VIOLATION', table_name: 'violations', record_id: newV?.id, new_values: { plate: plate.toUpperCase().trim(), property: violation.property, violation_type: violation.type, driver_name: driver?.name } })
    setShowViolation(false)
    setViolation({ type: '', location: '', notes: '', property: '' })
    setPhotos([])
    fetchViolations(driver?.assigned_properties || ['All'])
    if (newV) { setTicketTarget(newV); setSelectedStorage(''); setTowFee(''); setMileage('') }
  }

  function filteredViolations() {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const week = new Date(); week.setDate(week.getDate() - 7)
    const sixmo = new Date(); sixmo.setMonth(sixmo.getMonth() - 6)
    let list = violations.filter(v => {
      const d = new Date(v.created_at)
      if (violationFilter === 'custom') {
        const from = dateFrom ? new Date(dateFrom) : new Date(0)
        const to = dateTo ? new Date(dateTo + 'T23:59:59') : new Date()
        return d >= from && d <= to
      }
      if (violationFilter === 'today') return d >= today
      if (violationFilter === 'week') return d >= week
      return d >= sixmo
    })
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      list = list.filter(v =>
        v.plate?.toLowerCase().includes(q) ||
        v.property?.toLowerCase().includes(q) ||
        v.violation_type?.toLowerCase().includes(q) ||
        v.driver_name?.toLowerCase().includes(q)
      )
    }
    return list
  }

  function openTicketFor(v: any) {
    setTicketTarget(v)
    setExpandedTicketId(v.id)
    setSelectedStorage('')
    setTowFee('')
    setMileage('')
  }

  function generateTicket() {
    if (!ticketTarget) return
    const storage = storageFacilities.find(s => String(s.id) === selectedStorage)
    const tw = window.open('', '_blank')
    if (!tw) return
    const v = ticketTarget
    const total = (parseFloat(towFee || '0') + parseFloat(mileage || '0')).toFixed(2)
    const mailSubject = encodeURIComponent(`Tow Ticket - ${v.plate}`)
    const mailBody = encodeURIComponent([
      `TOW TICKET — A1 Wrecker, LLC`,
      `Date/Time: ${new Date(v.created_at).toLocaleString()}`,
      `Ticket #: ${String(v.id).substring(0, 8).toUpperCase()}`,
      ``,
      `VEHICLE`,
      `Plate: ${v.plate}`,
      `Vehicle: ${[v.year, v.color, v.make, v.model].filter(Boolean).join(' ') || '—'}`,
      `VIN: ${vin || v.vin || '—'}`,
      ``,
      `VIOLATION`,
      `Type: ${v.violation_type || '—'}`,
      `Location: ${v.location || '—'}`,
      `Property: ${v.property || '—'}`,
      `Notes: ${v.notes || 'None'}`,
      ``,
      `STORAGE / IMPOUND`,
      `Facility: ${storage?.name || '—'}`,
      `Address: ${storage?.address || '—'}`,
      `Phone: ${storage?.phone || '—'}`,
      ``,
      `TOW OPERATOR`,
      `Name: ${driver?.name || '—'}`,
      `License #: ${driver?.operator_license || '—'}`,
      `Company: ${driver?.company || 'A1 Wrecker, LLC'}`,
      ``,
      `FEES`,
      `Tow Fee: $${parseFloat(towFee || '0').toFixed(2)}`,
      `Mileage Fee: $${parseFloat(mileage || '0').toFixed(2)}`,
      `Total Due: $${total}`,
    ].join('\n'))
    const photosHtml = v.photos?.length
      ? `<div style="margin-top:20px"><p style="font-weight:bold;margin-bottom:8px">EVIDENCE PHOTOS</p><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${v.photos.map((u: string) => `<img src="${u}" style="width:100%;border-radius:4px;border:1px solid #ddd" onerror="this.style.display='none'">`).join('')}</div></div>`
      : ''
    tw.document.write(`<!DOCTYPE html><html><head><title>Tow Ticket — ${v.plate}</title><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;padding:28px;max-width:680px;margin:0 auto;color:#111;font-size:13px}
      .hdr{display:flex;align-items:center;gap:14px;margin-bottom:22px;padding-bottom:14px;border-bottom:3px solid #C9A227}
      .logo{width:64px;height:64px;border-radius:8px;border:2px solid #C9A227;object-fit:contain}
      .sec{margin-bottom:18px}
      .sh{font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#777;margin-bottom:8px;padding-bottom:3px;border-bottom:1px solid #eee}
      .g2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .f label{font-size:10px;font-weight:bold;color:#555;text-transform:uppercase;letter-spacing:.05em;display:block}
      .f span{font-size:13px;color:#111;display:block;margin-top:1px}
      .plate{font-family:"Courier New",monospace;font-size:22px;font-weight:bold}
      .warn{background:#fff3cd;border:1px solid #e6b800;border-radius:5px;padding:9px 12px;font-size:11px;margin-bottom:16px}
      .sig-wrap{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:28px}
      .sig-line{border-top:1px solid #555;padding-top:5px;font-size:10px;color:#666;margin-top:36px}
      .ftr{margin-top:20px;padding-top:10px;border-top:2px solid #C9A227;font-size:10px;color:#888;text-align:center}
      @media print{.no-print{display:none}body{padding:18px}}
    </style></head><body>
      <div class="hdr">
        <img src="${window.location.origin}/logo.jpeg" class="logo" alt="" onerror="this.style.display='none'">
        <div>
          <div style="font-size:20px;font-weight:bold">A1 Wrecker, LLC</div>
          <div style="font-size:11px;color:#888;margin-top:2px">Houston's #1 Towing &amp; Recovery</div>
          <div style="font-size:15px;font-weight:bold;color:#C9A227;margin-top:3px">OFFICIAL TOW TICKET</div>
        </div>
        <div style="margin-left:auto;text-align:right">
          <div style="font-size:10px;color:#888">Date / Time</div>
          <div style="font-weight:bold">${new Date(v.created_at).toLocaleString()}</div>
          <div style="font-size:10px;color:#888;margin-top:4px">Ticket #</div>
          <div style="font-weight:bold">${String(v.id).substring(0, 8).toUpperCase()}</div>
        </div>
      </div>
      <div class="warn">⚠ This vehicle has been towed pursuant to Texas Transportation Code §683. Contact the storage facility below to recover your vehicle.</div>
      <div class="sec">
        <div class="sh">Vehicle Information</div>
        <div class="g2">
          <div class="f"><label>License Plate</label><span class="plate">${v.plate}</span></div>
          <div class="f"><label>State</label><span>${v.state || '—'}</span></div>
          <div class="f"><label>Year / Make / Model</label><span>${[v.year, v.make, v.model].filter(Boolean).join(' ') || '—'}</span></div>
          <div class="f"><label>Color</label><span>${v.color || '—'}</span></div>
          <div class="f"><label>VIN</label><span>${vin || v.vin || '—'}</span></div>
        </div>
      </div>
      <div class="sec">
        <div class="sh">Violation</div>
        <div class="g2">
          <div class="f"><label>Type</label><span>${v.violation_type || '—'}</span></div>
          <div class="f"><label>Location / Space</label><span>${v.location || '—'}</span></div>
          <div class="f" style="grid-column:span 2"><label>Notes</label><span>${v.notes || 'No additional notes.'}</span></div>
        </div>
      </div>
      <div class="sec">
        <div class="sh">Property</div>
        <div class="g2">
          <div class="f"><label>Authorized By</label><span>${v.property || '—'}</span></div>
        </div>
      </div>
      <div class="sec">
        <div class="sh">Tow Operator</div>
        <div class="g2">
          <div class="f"><label>Operator Name</label><span>${driver?.name || '—'}</span></div>
          <div class="f"><label>License #</label><span>${driver?.operator_license || '—'}</span></div>
          <div class="f"><label>Company</label><span>${driver?.company || 'A1 Wrecker, LLC'}</span></div>
        </div>
      </div>
      <div class="sec">
        <div class="sh">Storage / Impound</div>
        <div class="g2">
          <div class="f"><label>Facility</label><span>${storage?.name || '—'}</span></div>
          <div class="f"><label>Phone</label><span>${storage?.phone || '—'}</span></div>
          <div class="f" style="grid-column:span 2"><label>Address</label><span>${storage?.address || '—'}</span></div>
        </div>
      </div>
      ${(parseFloat(towFee || '0') > 0 || parseFloat(mileage || '0') > 0) ? `
      <div class="sec">
        <div class="sh">Fees</div>
        <div class="g2">
          ${parseFloat(towFee || '0') > 0 ? `<div class="f"><label>Tow Fee</label><span>$${parseFloat(towFee).toFixed(2)}</span></div>` : ''}
          ${parseFloat(mileage || '0') > 0 ? `<div class="f"><label>Mileage Fee</label><span>$${parseFloat(mileage).toFixed(2)}</span></div>` : ''}
          <div class="f"><label>Total Due</label><span style="font-size:16px;font-weight:bold">$${total}</span></div>
        </div>
      </div>` : ''}
      ${photosHtml}
      <div class="sig-wrap">
        <div><div class="sig-line">Operator Signature</div></div>
        <div><div class="sig-line">Date</div></div>
      </div>
      <div class="ftr">A1 Wrecker, LLC &middot; Houston's #1 Towing &amp; Recovery &middot; a1wreckerllc.net<br>Generated ${new Date().toLocaleString()}</div>
      <div class="no-print" style="margin-top:20px;display:flex;gap:10px;justify-content:center">
        <button onclick="window.print()" style="padding:11px 22px;background:#C9A227;color:#0f1117;font-weight:bold;font-size:13px;border:none;border-radius:7px;cursor:pointer">Print Ticket</button>
        <a href="mailto:?subject=${mailSubject}&body=${mailBody}" style="padding:11px 22px;background:#1e3a5f;color:#fff;font-weight:bold;font-size:13px;border-radius:7px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center">Email Ticket</a>
        <button onclick="window.close()" style="padding:11px 22px;background:#333;color:#fff;font-size:13px;border:none;border-radius:7px;cursor:pointer">Close</button>
      </div>
    </body></html>`)
    tw.document.close()
  }

  const tab = (t: string): React.CSSProperties => ({
    flex: 1, padding: '8px', border: 'none', borderRadius: '6px',
    cursor: 'pointer', fontWeight: 'bold', fontSize: '11px',
    background: activeTab === t ? '#C9A227' : '#1e2535',
    color: activeTab === t ? '#0f1117' : '#888',
    fontFamily: 'Arial, sans-serif'
  })

  const inp: React.CSSProperties = {
    display: 'block', width: '100%', marginTop: '6px', marginBottom: '10px',
    padding: '9px 10px', background: '#1e2535', border: '1px solid #3a4055',
    borderRadius: '6px', color: 'white', fontSize: '12px', boxSizing: 'border-box'
  }

  const lbl: React.CSSProperties = {
    color: '#aaa', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em'
  }

  // Inline tow ticket form — called as a function, not a component
  function renderTicketForm() {
    if (!ticketTarget) return null
    return (
      <div style={{ background: '#0d1520', border: '2px solid #C9A227', borderRadius: '10px', padding: '16px', marginTop: '12px' }}>
        <p style={{ color: '#C9A227', fontWeight: 'bold', fontSize: '14px', margin: '0 0 14px' }}>
          Generate Tow Ticket — <span style={{ fontFamily: 'Courier New' }}>{ticketTarget.plate}</span>
        </p>

        <label style={lbl}>Storage Facility *</label>
        <select value={selectedStorage} onChange={e => setSelectedStorage(e.target.value)} style={inp}>
          <option value=''>Select storage facility...</option>
          {storageFacilities.map((s, i) => (
            <option key={i} value={s.id}>{s.name} — {s.address}</option>
          ))}
        </select>

        <label style={lbl}>VIN</label>
        <input value={vin} onChange={e => setVin(e.target.value)} placeholder="17-character VIN" style={inp} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <div>
            <label style={lbl}>Tow Fee ($)</label>
            <input type="number" value={towFee} onChange={e => setTowFee(e.target.value)} placeholder="0.00" style={inp} />
          </div>
          <div>
            <label style={lbl}>Mileage Fee ($)</label>
            <input type="number" value={mileage} onChange={e => setMileage(e.target.value)} placeholder="0.00" style={inp} />
          </div>
        </div>

        {(towFee || mileage) && (
          <p style={{ color: '#C9A227', fontSize: '12px', margin: '-6px 0 10px', textAlign: 'right', fontWeight: 'bold' }}>
            Total: ${(parseFloat(towFee || '0') + parseFloat(mileage || '0')).toFixed(2)}
          </p>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={generateTicket} disabled={!selectedStorage}
            style={{ flex: 1, padding: '11px', background: !selectedStorage ? '#2a2f3d' : '#C9A227', color: !selectedStorage ? '#555' : '#0f1117', fontWeight: 'bold', fontSize: '13px', border: 'none', borderRadius: '8px', cursor: !selectedStorage ? 'not-allowed' : 'pointer', fontFamily: 'Arial' }}>
            Print Tow Ticket
          </button>
          <button onClick={() => { setTicketTarget(null); setExpandedTicketId(null) }}
            style={{ padding: '11px 12px', background: '#1e2535', color: '#aaa', fontSize: '12px', border: '1px solid #3a4055', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
            Close
          </button>
        </div>
      </div>
    )
  }

  if (loading) return (
    <main style={{ minHeight: '100vh', background: '#0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Arial, sans-serif' }}>
      <p style={{ color: '#888' }}>Loading...</p>
    </main>
  )

  if (error) return (
    <main style={{ minHeight: '100vh', background: '#0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Arial, sans-serif', padding: '20px' }}>
      <div style={{ textAlign: 'center' }}>
        <p style={{ color: '#f44336', fontSize: '14px', marginBottom: '16px' }}>{error}</p>
        <a href="/login" style={{ color: '#C9A227', fontSize: '13px' }}>← Back to Login</a>
      </div>
    </main>
  )

  const fvs = filteredViolations()

  return (
    <main style={{ minHeight: '100vh', background: '#0f1117', fontFamily: 'Arial, sans-serif', padding: '20px' }}>
      <div style={{ maxWidth: '520px', margin: '0 auto' }}>

        {/* Header */}
        <div style={{ marginBottom: '16px', textAlign: 'center' }}>
          <img src="/logo.jpeg" alt="A1 Wrecker"
            style={{ width: '60px', height: '60px', borderRadius: '10px', border: '2px solid #C9A227', display: 'block', margin: '0 auto 8px' }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
          <h1 style={{ color: '#C9A227', fontSize: '22px', fontWeight: 'bold', margin: '0' }}>A1 Wrecker, LLC</h1>
          <p style={{ color: '#888', fontSize: '13px', margin: '4px 0 0' }}>Driver Portal</p>
        </div>

        {/* Driver bar */}
        <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '10px', padding: '12px 16px', marginBottom: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <p style={{ color: 'white', fontWeight: 'bold', fontSize: '13px', margin: '0' }}>{driver?.name}</p>
            <p style={{ color: '#aaa', fontSize: '11px', margin: '2px 0 0' }}>
              {driver?.company || 'A1 Wrecker, LLC'} · Lic: {driver?.operator_license || '—'}
            </p>
            <p style={{ color: '#555', fontSize: '11px', margin: '2px 0 0' }}>
              {(driver?.assigned_properties || ['All']).join(' · ')}
            </p>
          </div>
          <button onClick={async () => { await supabase.auth.signOut(); window.location.href = '/login' }}
            style={{ padding: '6px 12px', background: '#1e2535', color: '#aaa', border: '1px solid #3a4055', borderRadius: '6px', cursor: 'pointer', fontSize: '11px', fontFamily: 'Arial' }}>
            Sign Out
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '4px', background: '#1e2535', borderRadius: '8px', padding: '3px', marginBottom: '14px' }}>
          <button style={tab('lookup')} onClick={() => setActiveTab('lookup')}>Plate Lookup</button>
          <button style={tab('violations')} onClick={() => setActiveTab('violations')}>
            Violations {violations.length > 0 ? `(${violations.length})` : ''}
          </button>
        </div>

        {/* ── PLATE LOOKUP ── */}
        {activeTab === 'lookup' && (
          <div>
            <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '12px', padding: '22px', marginBottom: '14px' }}>
              <label style={{ color: '#aaa', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.1em' }}>License Plate</label>
              <button onClick={openCamera}
                style={{ width: '100%', padding: '12px', background: '#1a1f2e', color: '#C9A227', border: '1px solid #C9A227', borderRadius: '8px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold', marginTop: '8px', marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontFamily: 'Arial' }}>
                📷 Scan License Plate
              </button>
              <input
                value={plate}
                onChange={e => { setPlate(e.target.value.toUpperCase()); setResult(null); setTicketTarget(null); setScanMsg('') }}
                onKeyDown={e => e.key === 'Enter' && searchPlate()}
                placeholder="ABC1234"
                maxLength={10}
                style={{
                  display: 'block', width: '100%', padding: '16px',
                  fontSize: '28px', fontFamily: 'Courier New', fontWeight: 'bold', letterSpacing: '0.12em',
                  background: '#1e2535', border: '2px solid #3a4055', borderRadius: '10px',
                  color: 'white', textAlign: 'center', outline: 'none', boxSizing: 'border-box',
                  textTransform: 'uppercase'
                }}
              />
              {scanMsg && (
                <p style={{ color:'#C9A227', fontSize:'12px', margin:'4px 0 0', fontStyle:'italic' }}>{scanMsg}</p>
              )}
              <button onClick={() => searchPlate()} disabled={searching || !plate}
                style={{
                  marginTop: '12px', width: '100%', padding: '14px',
                  background: !plate ? '#2a2f3d' : '#C9A227',
                  color: !plate ? '#555' : '#0f1117',
                  fontWeight: 'bold', fontSize: '15px', border: 'none', borderRadius: '8px',
                  cursor: !plate ? 'not-allowed' : 'pointer', fontFamily: 'Arial'
                }}>
                {searching ? 'Searching...' : 'Search Plate'}
              </button>

              {result && (
                <div style={{
                  marginTop: '16px', padding: '16px', borderRadius: '10px',
                  background: result.status === 'authorized' ? '#061406' : result.status === 'visitor' ? '#150f00' : '#140404',
                  border: `1px solid ${result.status === 'authorized' ? '#2e7d32' : result.status === 'visitor' ? '#a16207' : '#991b1b'}`
                }}>
                  {result.status === 'authorized' && (
                    <>
                      <p style={{ color: '#4caf50', fontWeight: 'bold', fontSize: '16px', margin: '0 0 12px' }}>✓ AUTHORIZED</p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Unit</span><br /><span style={{ color: 'white', fontSize: '13px' }}>{result.data.unit}</span></div>
                        <div><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Space</span><br /><span style={{ color: 'white', fontSize: '13px' }}>{result.data.space || '—'}</span></div>
                        <div style={{ gridColumn: 'span 2' }}><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Vehicle</span><br /><span style={{ color: 'white', fontSize: '13px' }}>{[result.data.year, result.data.color, result.data.make, result.data.model].filter(Boolean).join(' ') || '—'}</span></div>
                        <div style={{ gridColumn: 'span 2' }}><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Property</span><br /><span style={{ color: '#4caf50', fontSize: '13px' }}>{result.data.property}</span></div>
                      </div>
                    </>
                  )}

                  {result.status === 'expired' && (
                    <>
                      <p style={{ color: '#ff9800', fontWeight: 'bold', fontSize: '16px', margin: '0 0 12px' }}>⚠ PERMIT EXPIRED</p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '14px' }}>
                        <div><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Unit</span><br /><span style={{ color: 'white', fontSize: '13px' }}>{result.data.unit}</span></div>
                        <div><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Space</span><br /><span style={{ color: 'white', fontSize: '13px' }}>{result.data.space || '—'}</span></div>
                        <div style={{ gridColumn: 'span 2' }}><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Vehicle</span><br /><span style={{ color: 'white', fontSize: '13px' }}>{[result.data.year, result.data.color, result.data.make, result.data.model].filter(Boolean).join(' ') || '—'}</span></div>
                      </div>
                      <button onClick={() => setShowViolation(true)}
                        style={{ width: '100%', padding: '11px', background: '#991b1b', color: 'white', fontWeight: 'bold', fontSize: '13px', border: 'none', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
                        Issue Violation
                      </button>
                    </>
                  )}

                  {result.status === 'visitor' && (
                    <>
                      <p style={{ color: '#f59e0b', fontWeight: 'bold', fontSize: '16px', margin: '0 0 12px' }}>✓ VISITOR PASS ACTIVE</p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Visiting Unit</span><br /><span style={{ color: 'white', fontSize: '13px' }}>{result.data.visiting_unit}</span></div>
                        <div><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Visitor Name</span><br /><span style={{ color: 'white', fontSize: '13px' }}>{result.data.visitor_name || '—'}</span></div>
                        <div style={{ gridColumn: 'span 2' }}><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Expires</span><br /><span style={{ color: '#f59e0b', fontWeight: 'bold', fontSize: '13px' }}>{new Date(result.data.expires_at).toLocaleString()}</span></div>
                      </div>
                      <p style={{ color: '#f59e0b', fontSize: '11px', margin: '10px 0 0', fontWeight: 'bold' }}>Do not tow — active visitor pass</p>
                    </>
                  )}

                  {result.status === 'notassigned' && (
                    <>
                      <p style={{ color: '#f44336', fontWeight: 'bold', fontSize: '16px', margin: '0 0 6px' }}>✗ NOT YOUR PROPERTY</p>
                      <p style={{ color: '#aaa', fontSize: '13px', margin: '0' }}>This plate is registered to a property not assigned to you.</p>
                    </>
                  )}

                  {result.status === 'notfound' && (
                    <>
                      <p style={{ color: '#f44336', fontWeight: 'bold', fontSize: '16px', margin: '0 0 6px' }}>✗ NO PERMIT FOUND</p>
                      <p style={{ color: '#aaa', fontSize: '13px', margin: '0 0 12px' }}>Plate is not registered. Vehicle may be towed.</p>
                      <button onClick={() => setShowViolation(true)}
                        style={{ width: '100%', padding: '11px', background: '#991b1b', color: 'white', fontWeight: 'bold', fontSize: '13px', border: 'none', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
                        Issue Violation
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* Violation form */}
              {showViolation && (
                <div style={{ marginTop: '14px', background: '#0f0505', border: '1px solid #991b1b', borderRadius: '10px', padding: '16px' }}>
                  <p style={{ color: '#f44336', fontWeight: 'bold', fontSize: '14px', margin: '0 0 14px' }}>
                    Issue Violation — <span style={{ fontFamily: 'Courier New' }}>{plate}</span>
                  </p>

                  <label style={lbl}>Property *</label>
                  <select value={violation.property} onChange={e => setViolation({ ...violation, property: e.target.value })} style={inp}>
                    <option value=''>Select property...</option>
                    {(driver?.assigned_properties || []).filter((p: string) => p !== 'All').map((p: string, i: number) => (
                      <option key={i} value={p}>{p}</option>
                    ))}
                  </select>

                  <label style={lbl}>Violation Type *</label>
                  <select value={violation.type} onChange={e => setViolation({ ...violation, type: e.target.value })} style={inp}>
                    <option value=''>Select type...</option>
                    <option>No Parking Permit</option>
                    <option>Expired Visitor Pass</option>
                    <option>Wrong Space / Unauthorized Space</option>
                    <option>Fire Lane</option>
                    <option>Handicap Zone</option>
                    <option>Blocking Driveway</option>
                    <option>Double Parked</option>
                    <option>Abandoned Vehicle</option>
                  </select>

                  <label style={lbl}>Space / Location</label>
                  <input value={violation.location} onChange={e => setViolation({ ...violation, location: e.target.value })} placeholder="e.g. Space A-14, North lot" style={inp} />

                  <label style={lbl}>VIN (optional)</label>
                  <input value={vin} onChange={e => setVin(e.target.value)} placeholder="17-character VIN" style={inp} />

                  <label style={lbl}>Photos</label>
                  <input type="file" accept="image/*" multiple
                    onChange={e => setPhotos(Array.from(e.target.files || []))}
                    style={{ ...inp, color: '#aaa' }} />
                  {photos.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                      {photos.map((p, i) => (
                        <span key={i} style={{ background: '#1e2535', border: '1px solid #3a4055', borderRadius: '5px', padding: '3px 8px', fontSize: '10px', color: '#aaa' }}>
                          📷 {p.name.length > 14 ? p.name.substring(0, 14) + '…' : p.name}
                        </span>
                      ))}
                    </div>
                  )}

                  <label style={lbl}>Notes</label>
                  <textarea value={violation.notes} onChange={e => setViolation({ ...violation, notes: e.target.value })}
                    placeholder="Reason for violation, additional details..."
                    style={{ ...inp, minHeight: '64px', resize: 'vertical' as const }} />

                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={submitViolation} disabled={submitting}
                      style={{ flex: 1, padding: '11px', background: submitting ? '#555' : '#991b1b', color: 'white', fontWeight: 'bold', fontSize: '13px', border: 'none', borderRadius: '8px', cursor: submitting ? 'not-allowed' : 'pointer', fontFamily: 'Arial' }}>
                      {submitting ? 'Submitting...' : 'Submit Violation'}
                    </button>
                    <button onClick={() => setShowViolation(false)}
                      style={{ padding: '11px 12px', background: '#1e2535', color: '#aaa', fontSize: '12px', border: '1px solid #3a4055', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Tow ticket appears here after violation submit */}
            {ticketTarget && activeTab === 'lookup' && renderTicketForm()}
          </div>
        )}

        {/* ── VIOLATIONS TAB ── */}
        {activeTab === 'violations' && (
          <div>
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search plate, property, violation type..."
              style={{ ...inp, fontSize: '13px', padding: '11px 12px', marginBottom: '10px' }}
            />

            <div style={{ display: 'flex', gap: '4px', background: '#1e2535', borderRadius: '8px', padding: '3px', marginBottom: violationFilter === 'custom' ? '10px' : '12px' }}>
              {[{k:'today',l:'Today'},{k:'week',l:'This Week'},{k:'sixmonths',l:'6 Months'},{k:'custom',l:'Date Range'}].map(f => (
                <button key={f.k} onClick={() => setViolationFilter(f.k)}
                  style={{ flex: 1, padding: '8px 3px', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '10px', fontWeight: 'bold', background: violationFilter === f.k ? '#C9A227' : 'transparent', color: violationFilter === f.k ? '#0f1117' : '#888', fontFamily: 'Arial' }}>
                  {f.l}
                </button>
              ))}
            </div>

            {violationFilter === 'custom' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
                <div>
                  <label style={{ ...lbl, display: 'block', marginBottom: '4px' }}>From</label>
                  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ ...inp, marginTop: 0 }} />
                </div>
                <div>
                  <label style={{ ...lbl, display: 'block', marginBottom: '4px' }}>To</label>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ ...inp, marginTop: 0 }} />
                </div>
              </div>
            )}

            <p style={{ color: '#444', fontSize: '11px', margin: '0 0 10px', textAlign: 'right' }}>
              {fvs.length} result{fvs.length !== 1 ? 's' : ''}
            </p>

            {fvs.length === 0 ? (
              <div style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '10px', padding: '40px', textAlign: 'center' }}>
                <p style={{ color: '#555', fontSize: '13px', margin: '0' }}>No violations found for this period</p>
              </div>
            ) : fvs.map((v, i) => (
              <div key={i} style={{ background: '#161b26', border: '1px solid #2a2f3d', borderRadius: '10px', padding: '14px', marginBottom: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                  <div>
                    <p style={{ color: '#f44336', fontFamily: 'Courier New', fontSize: '20px', fontWeight: 'bold', margin: '0' }}>{v.plate}</p>
                    <p style={{ color: '#aaa', fontSize: '11px', margin: '3px 0 0' }}>{v.violation_type || '—'}</p>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ color: '#555', fontSize: '11px', margin: '0' }}>{new Date(v.created_at).toLocaleDateString()}</p>
                    <p style={{ color: '#444', fontSize: '10px', margin: '2px 0 0' }}>{new Date(v.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</p>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px', marginBottom: '10px' }}>
                  <div><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Property</span><br /><span style={{ color: '#aaa' }}>{v.property || '—'}</span></div>
                  <div><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Location</span><br /><span style={{ color: '#aaa' }}>{v.location || '—'}</span></div>
                  {v.driver_name && <div style={{ gridColumn: 'span 2' }}><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Driver</span><br /><span style={{ color: '#aaa' }}>{v.driver_name}</span></div>}
                  {v.notes && <div style={{ gridColumn: 'span 2' }}><span style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase' }}>Notes</span><br /><span style={{ color: '#aaa' }}>{v.notes}</span></div>}
                </div>

                {v.photos && v.photos.length > 0 && (
                  <div style={{ marginBottom: '10px' }}>
                    <p style={{ color: '#555', fontSize: '10px', textTransform: 'uppercase', margin: '0 0 6px' }}>Evidence Photos</p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '6px' }}>
                      {v.photos.map((url: string, pi: number) => (
                        <a key={pi} href={url} target="_blank" rel="noopener noreferrer">
                          <img src={url} alt={`Photo ${pi + 1}`} style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', borderRadius: '6px', border: '1px solid #2a2f3d' }} />
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                <button
                  onClick={() => expandedTicketId === v.id ? (setExpandedTicketId(null), setTicketTarget(null)) : openTicketFor(v)}
                  style={{ width: '100%', padding: '9px', background: expandedTicketId === v.id ? '#1a1200' : '#0f1620', color: '#C9A227', border: '1px solid #C9A227', borderRadius: '7px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', fontFamily: 'Arial' }}>
                  {expandedTicketId === v.id ? '▲ Close Ticket' : 'Generate Tow Ticket'}
                </button>

                {expandedTicketId === v.id && renderTicketForm()}
              </div>
            ))}
          </div>
        )}

        <div style={{ textAlign: 'center', marginTop: '24px', paddingBottom: '20px' }}>
          <p style={{ color: '#2a2f3d', fontSize: '11px', margin: '0' }}>A1 Wrecker, LLC · Houston's #1 Towing & Recovery</p>
        </div>

      </div>

      {/* ── CAMERA MODAL ── */}
      {showCamera && (
        <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 9999, display: 'flex', flexDirection: 'column' }}>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

          {/* Video feed */}
          <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
            <video ref={videoRef} autoPlay playsInline muted
              style={{ width: '100%', height: '100%', objectFit: 'cover' }} />

            {/* Targeting box — boxShadow creates vignette outside the frame */}
            <div style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '82%', maxWidth: '340px', height: '90px',
              border: '2px solid #C9A227', borderRadius: '8px',
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.52)',
            }}>
              {/* Corner accents */}
              {[{top:'-2px',left:'-2px'},{top:'-2px',right:'-2px'},{bottom:'-2px',left:'-2px'},{bottom:'-2px',right:'-2px'}].map((pos,i) => (
                <div key={i} style={{ position:'absolute', width:'14px', height:'14px', border:'3px solid #C9A227', ...pos,
                  borderTop: pos.bottom !== undefined ? 'none' : '3px solid #C9A227',
                  borderBottom: pos.top !== undefined ? 'none' : '3px solid #C9A227',
                  borderLeft: pos.right !== undefined ? 'none' : '3px solid #C9A227',
                  borderRight: pos.left !== undefined ? 'none' : '3px solid #C9A227',
                }} />
              ))}
            </div>
          </div>

          {/* Controls */}
          <div style={{ padding: '20px 20px 32px', background: '#0f1117' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', marginBottom: '6px', minHeight: '28px' }}>
              {scanning && (
                <div style={{ width: '18px', height: '18px', border: '2px solid #2a2f3d', borderTop: '2px solid #C9A227', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
              )}
              <p style={{ color: scanning ? '#C9A227' : '#aaa', fontSize: '13px', margin: 0, fontWeight: scanning ? 'bold' : 'normal' }}>
                {scanStatus}
              </p>
            </div>
            {!scanning && (
              <p style={{ color: '#444', fontSize: '11px', textAlign: 'center', margin: '0 0 16px', lineHeight: '1.6' }}>
                For best results: good lighting, hold steady, plate fills the targeting box
              </p>
            )}
            {scanning && <div style={{ height: '28px' }} />}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={closeCamera} disabled={scanning}
                style={{ flex: 1, padding: '14px', background: '#1e2535', color: '#aaa', border: '1px solid #3a4055', borderRadius: '10px', cursor: scanning ? 'not-allowed' : 'pointer', fontSize: '14px', fontFamily: 'Arial' }}>
                Cancel
              </button>
              <button onClick={captureAndScan} disabled={scanning}
                style={{ flex: 2, padding: '14px', background: scanning ? '#555' : '#C9A227', color: scanning ? '#888' : '#0f1117', fontWeight: 'bold', fontSize: '15px', border: 'none', borderRadius: '10px', cursor: scanning ? 'not-allowed' : 'pointer', fontFamily: 'Arial' }}>
                {scanning ? 'Reading...' : '📷 Capture'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
